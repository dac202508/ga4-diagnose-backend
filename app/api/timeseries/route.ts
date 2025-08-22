export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { BetaAnalyticsDataClient, protos } from '@google-analytics/data';

/* ===== CORS ===== */
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
};
const j = (data: unknown, status = 200) =>
  new NextResponse(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/* ===== 共通ユーティリティ ===== */
type ClientsMap = Record<string, string[]>;
const parseClients = (): ClientsMap => {
  const raw = process.env.CLIENTS_JSON ?? '';
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ClientsMap;
  } catch {
    return {};
  }
};
const normalizePK = (raw?: string): string =>
  !raw ? '' : raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw.replace(/\r/g, '');

/* ===== デバッグ用 GET ===== */
export function GET(req: NextRequest) {
  return j({
    ok: true,
    apiKeyHeader: req.headers.get('x-api-key') ?? '',
    clients: Object.keys(parseClients()),
  });
}

/* ===== 本体 POST（日別トレンド） ===== */
type BodyIn = {
  propertyId?: string;
  startDate?: string; // 'YYYY-MM-DD' | '28daysAgo'
  endDate?: string;   // 'YYYY-MM-DD' | 'yesterday'
  pagePathContains?: string;
  limit?: number;     // 最大想定 366
};

type RowOut = {
  date: string;
  sessions: number;
  pageViews: number;
  users: number;
  avgSessionSec: number;
  erPercent: number;
  brPercent: number;
};

export async function POST(req: NextRequest) {
  try {
    /* --- 認証（CLIENTS_JSON 優先、無ければ API_KEY） --- */
    const headerKey = (req.headers.get('x-api-key') ?? '').trim();
    const clients = parseClients();
    const legacyKey = (process.env.API_KEY ?? '').trim();
    let allowed: string[] | null = null;

    if (Object.keys(clients).length > 0) {
      allowed = clients[headerKey] ?? null;
      if (!headerKey || !allowed?.length) return j({ error: 'Unauthorized' }, 401);
    } else if (legacyKey) {
      if (headerKey !== legacyKey) return j({ error: 'Unauthorized' }, 401);
    }

    /* --- 入力 --- */
    const b = (await req.json().catch(() => ({}))) as BodyIn;
    const propertyId = typeof b.propertyId === 'string' ? b.propertyId : '';
    if (!propertyId) return j({ error: 'propertyId is required' }, 400);
    if (allowed && !allowed.includes(propertyId)) {
      return j({ error: 'Forbidden propertyId for this key', allowed }, 403);
    }

    const startDate = typeof b.startDate === 'string' && b.startDate ? b.startDate : '28daysAgo';
    const endDate   = typeof b.endDate   === 'string' && b.endDate   ? b.endDate   : 'yesterday';
    const limit     = typeof b.limit     === 'number' ? b.limit : 366;
    const pagePathContains = typeof b.pagePathContains === 'string' ? b.pagePathContains.trim() : '';

    /* --- GA4 クライアント --- */
    const clientEmail = process.env.GA4_CLIENT_EMAIL ?? '';
    const privateKey  = normalizePK(process.env.GA4_PRIVATE_KEY);
    if (!clientEmail || !privateKey) return j({ error: 'Missing GA4 service account envs' }, 500);

    const ga = new BetaAnalyticsDataClient({
      credentials: { client_email: clientEmail, private_key: privateKey },
    });
    const propertyName = `properties/${propertyId}`;

    /* --- リクエスト（protos の正式型で記述） --- */
    const metrics: protos.google.analytics.data.v1beta.IMetric[] = [
      { name: 'sessions' },
      { name: 'screenPageViews' },
      { name: 'totalUsers' },
      { name: 'averageSessionDuration' },
      { name: 'engagementRate' },
      { name: 'bounceRate' },
    ];
    const dimensions: protos.google.analytics.data.v1beta.IDimension[] = [{ name: 'date' }];

    const dimensionFilter:
      | protos.google.analytics.data.v1beta.IFilterExpression
      | undefined = pagePathContains
      ? {
          filter: {
            fieldName: 'pagePath',
            stringFilter: {
              matchType:
                protos.google.analytics.data.v1beta.Filter.StringFilter.MatchType.CONTAINS,
              value: pagePathContains,
              caseSensitive: false,
            },
          },
        }
      : undefined;

    const reqObj: protos.google.analytics.data.v1beta.IRunReportRequest = {
      property: propertyName,
      dateRanges: [{ startDate, endDate }],
      dimensions,
      metrics,
      limit,
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      ...(dimensionFilter ? { dimensionFilter } : {}),
    };

    /* --- 実行（await → 0番要素を取得） --- */
    const runResp = await ga.runReport(reqObj);
    const res = runResp[0]; // IRunReportResponse

    /* --- 整形 --- */
    const rows: RowOut[] = (res.rows ?? []).map((r) => {
      const d = r.dimensionValues?.[0]?.value ?? '';
      const date =
        d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : String(d);

      const mv = (i: number) => Number(r.metricValues?.[i]?.value ?? '0');

      return {
        date,
        sessions: mv(0),
        pageViews: mv(1),
        users: mv(2),
        avgSessionSec: mv(3),
        erPercent: mv(4) * 100,
        brPercent: mv(5) * 100,
      };
    });

    return j({ meta: { propertyId, startDate, endDate, pagePathContains }, rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return j({ error: msg }, 500);
  }
}
