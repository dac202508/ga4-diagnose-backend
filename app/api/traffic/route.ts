export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { BetaAnalyticsDataClient } from '@google-analytics/data';

/* CORS */
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
};
const json = (data: unknown, status = 200) =>
  new NextResponse(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

/* 共通ユーティリティ */
type ClientsMap = Record<string, string[]>;
const parseClients = (): ClientsMap => {
  const raw = process.env.CLIENTS_JSON ?? '';
  if (!raw) return {};
  try { return JSON.parse(raw) as ClientsMap; } catch { return {}; }
};
const normalizePK = (raw?: string): string =>
  !raw ? '' : raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw.replace(/\r/g, '');

/* デバッグ用 GET（ブラウザで /api/traffic を開くとENV確認）*/
export function GET(req: NextRequest) {
  return json({
    ok: true,
    apiKeyHeader: req.headers.get('x-api-key') ?? '',
    clients: parseClients(),
  });
}

/* 本体 POST */
type BodyIn = {
  propertyId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  dim?: 'sourcemedium' | 'channel' | 'source' | 'medium' | 'referrer';
};

export async function POST(req: NextRequest) {
  try {
    // 認証（CLIENTS_JSON優先、無ければAPI_KEY）
    const headerKey = (req.headers.get('x-api-key') ?? '').trim();
    const clients = parseClients();
    const legacyKey = (process.env.API_KEY ?? '').trim();

    let allowed: string[] | null = null;
    if (Object.keys(clients).length > 0) {
      allowed = clients[headerKey] ?? null;
      if (!headerKey || !allowed?.length) return json({ error: 'Unauthorized' }, 401);
    } else if (legacyKey) {
      if (headerKey !== legacyKey) return json({ error: 'Unauthorized' }, 401);
    }

    // 入力
    const b = (await req.json().catch(() => ({}))) as BodyIn;
    const propertyId = typeof b.propertyId === 'string' ? b.propertyId : '';
    if (!propertyId) return json({ error: 'propertyId is required' }, 400);
    if (allowed && !allowed.includes(propertyId)) {
      return json({ error: 'Forbidden propertyId for this key', allowed }, 403);
    }
    const startDate = typeof b.startDate === 'string' && b.startDate ? b.startDate : '28daysAgo';
    const endDate   = typeof b.endDate   === 'string' && b.endDate   ? b.endDate   : 'yesterday';
    const limit     = typeof b.limit     === 'number' ? b.limit : 50;
    const dimKey    = b.dim ?? 'sourcemedium';

    // GA4クライアント
    const clientEmail = process.env.GA4_CLIENT_EMAIL ?? '';
    const privateKey  = normalizePK(process.env.GA4_PRIVATE_KEY);
    if (!clientEmail || !privateKey) return json({ error: 'Missing GA4 service account envs' }, 500);
    const ga = new BetaAnalyticsDataClient({ credentials: { client_email: clientEmail, private_key: privateKey } });
    const propertyName = `properties/${propertyId}`;

    // 次元マップとフォールバック
    const dimMap: Record<NonNullable<BodyIn['dim']>, string> = {
      sourcemedium: 'sessionSourceMedium',
      channel:      'sessionDefaultChannelGroup',
      source:       'sessionSource',
      medium:       'sessionMedium',
      referrer:     'fullReferrer',
    };
    const requested = dimMap[dimKey];

    const [meta] = await ga.getMetadata({ name: `${propertyName}/metadata` });
    const dims = new Set((meta.dimensions ?? []).map(d => d.apiName));
    let chosenDim = requested;
    if (!dims.has(chosenDim)) {
      for (const d of ['sessionSourceMedium','sessionDefaultChannelGroup','sessionSource','sessionMedium','fullReferrer']) {
        if (dims.has(d)) { chosenDim = d; break; }
      }
      if (!dims.has(chosenDim)) return json({ error: 'No suitable traffic dimension available' }, 400);
    }

    // 指標（セッション軸）
    const metrics = [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'engagementRate' },
      { name: 'bounceRate' },
      { name: 'averageSessionDuration' },
    ];

    // レポート
    const [res] = await ga.runReport({
      property: propertyName,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: chosenDim }],
      metrics,
      limit,
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    });

    // 整形（%は×100）
    type Row = {
      label: string;
      sessions: number;
      totalUsers: number;
      engagementRate: number;
      bounceRate: number;
      averageSessionDuration: number;
    };
    const rows: Row[] = (res.rows ?? []).map(r => {
      const getM = (i: number) => Number(r.metricValues?.[i]?.value ?? '0');
      const label = r.dimensionValues?.[0]?.value ?? '(not set)';
      return {
        label,
        sessions: getM(0),
        totalUsers: getM(1),
        engagementRate: getM(2) * 100,
        bounceRate: getM(3) * 100,
        averageSessionDuration: getM(4),
      };
    });

    return json({ meta: { propertyId, startDate, endDate, dim: chosenDim }, rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
}
