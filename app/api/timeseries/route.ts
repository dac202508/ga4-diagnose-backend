export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { BetaAnalyticsDataClient } from '@google-analytics/data';

/* ===== CORS ===== */
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

/* ===== 共通ユーティリティ ===== */
type ClientsMap = Record<string, string[]>;
const parseClients = (): ClientsMap => {
  const raw = process.env.CLIENTS_JSON ?? '';
  if (!raw) return {};
  try { return JSON.parse(raw) as ClientsMap; } catch { return {}; }
};
const normalizePK = (raw?: string): string =>
  !raw ? '' : raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw.replace(/\r/g, '');

/* デバッグ用 GET（任意）*/
export function GET(req: NextRequest) {
  return json({ ok: true, apiKeyHeader: req.headers.get('x-api-key') ?? '', clients: parseClients() });
}

/* ===== 本体 POST ===== */
type BodyIn = {
  propertyId?: string;
  startDate?: string; // 'YYYY-MM-DD' or '28daysAgo'
  endDate?: string;   // 'YYYY-MM-DD' or 'yesterday'
  pagePathContains?: string;
  limit?: number;
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
    const limit     = typeof b.limit     === 'number' ? b.limit : 366;
    const pagePathContains = typeof b.pagePathContains === 'string' ? b.pagePathContains.trim() : '';

    // GA4クライアント
    const clientEmail = process.env.GA4_CLIENT_EMAIL ?? '';
    const privateKey  = normalizePK(process.env.GA4_PRIVATE_KEY);
    if (!clientEmail || !privateKey) return json({ error: 'Missing GA4 service account envs' }, 500);

    const ga = new BetaAnalyticsDataClient({ credentials: { client_email: clientEmail, private_key: privateKey } });
    const propertyName = `properties/${propertyId}`;

    // 次元: date（日別）
    const dimensions = [{ name: 'date' }];
    const dimensionFilter = pagePathContains
      ? { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'PARTIAL', value: pagePathContains } } }
      : undefined;

    // 指標
    const metrics = [
      { name: 'sessions' },
      { name: 'screenPageViews' },
      { name: 'totalUsers' },
      { name: 'averageSessionDuration' },
      { name: 'engagementRate' },
      { name: 'bounceRate' },
    ];

    const [res] = await ga.runReport({
      property: propertyName,
      dateRanges: [{ startDate, endDate }],
      dimensions,
      metrics,
      limit,
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      dimensionFilter,
    });

    // 整形
    type Row = {
      date: string;
      sessions: number;
      pageViews: number;
      users: number;
      avgSessionSec: number;
      erPercent: number;
      brPercent: number;
    };
    const rows: Row[] = (res.rows ?? []).map(r => {
      const d = r.dimensionValues?.[0]?.value ?? '';
      const date = d.length === 8 ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}` : d;
      const getM = (i: number) => Number(r.metricValues?.[i]?.value ?? '0');
      return {
        date,
        sessions: getM(0),
        pageViews: getM(1),
        users: getM(2),
        avgSessionSec: getM(3),
        erPercent: getM(4) * 100,
        brPercent: getM(5) * 100,
      };
    });

    return json({ meta: { propertyId, startDate, endDate, pagePathContains }, rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
}
