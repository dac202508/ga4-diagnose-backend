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
export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/* ===== utils ===== */
type ClientsMap = Record<string, string[]>;
const parseClients = (): ClientsMap => {
  const raw = process.env.CLIENTS_JSON ?? '';
  if (!raw) return {};
  try { return JSON.parse(raw) as ClientsMap; } catch { return {}; }
};
const normalizePK = (raw?: string): string =>
  !raw ? '' : raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw.replace(/\r/g, '');
const median = (nums: number[]): number => {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/* ===== GET: debug（/api/diagnose で env を確認） ===== */
export function GET(req: NextRequest) {
  return json({
    ok: true,
    apiKeyHeader: req.headers.get('x-api-key') ?? '',
    clients: parseClients(),
  });
}

/* ===== POST: 本処理 ===== */
const DIM_CANDIDATES = ['pagePath', 'pageLocation', 'pageTitle', 'screenName'] as const;
const VIEW_METRICS   = ['views', 'screenPageViews', 'eventCount', 'sessions'] as const;
const EXTRA_METRICS  = ['bounceRate', 'engagementRate', 'averageSessionDuration', 'totalUsers', 'sessions'] as const;

type BodyIn = { propertyId?: string; startDate?: string; endDate?: string; limit?: number };

export async function POST(req: NextRequest) {
  try {
    // 認証・認可（CLIENTS_JSON を優先、なければ API_KEY）
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

    // 入力（constで固定）
    const format = (req.nextUrl.searchParams.get('format') ?? '').toLowerCase(); // 'csv' でCSV返却
    const bodyUnknown = await req.json().catch(() => ({}));
    const body = bodyUnknown as BodyIn;

    const propertyId = isStr(body.propertyId) ? body.propertyId : '';
    if (!propertyId) return json({ error: 'propertyId is required' }, 400);

    const startDate = isStr(body.startDate) ? body.startDate : '28daysAgo';
    const endDate   = isStr(body.endDate)   ? body.endDate   : 'yesterday';
    const limit     = isNum(body.limit)     ? body.limit     : 1000;

    if (allowed && !allowed.includes(propertyId)) {
      return json({ error: 'Forbidden propertyId for this key', allowed }, 403);
    }

    // GA4 クライアント
    const clientEmail = process.env.GA4_CLIENT_EMAIL ?? '';
    const privateKey  = normalizePK(process.env.GA4_PRIVATE_KEY);
    if (!clientEmail || !privateKey) return json({ error: 'Missing GA4 service account envs' }, 500);

    const ga = new BetaAnalyticsDataClient({ credentials: { client_email: clientEmail, private_key: privateKey } });
    const propertyName = `properties/${propertyId}`;

    // メタデータ
    const [meta] = await ga.getMetadata({ name: `${propertyName}/metadata` });
    const dims = new Set((meta.dimensions ?? []).map((d) => d.apiName));
    const mets = new Set((meta.metrics ?? []).map((m) => m.apiName));
    const chosenDim  = DIM_CANDIDATES.find((n) => dims.has(n));
    const chosenView = VIEW_METRICS.find((n) => mets.has(n));
    const chosenExtra = EXTRA_METRICS.filter((n) => mets.has(n));
    if (!chosenDim || !chosenView) return json({ error: 'Required dimensions/metrics not available' }, 400);

    const metrics = [chosenView, ...chosenExtra].map((name) => ({ name }));

    // レポート
    const [res] = await ga.runReport({
      property: propertyName,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: chosenDim }],
      metrics,
      limit,
      orderBys: [{ metric: { metricName: chosenView }, desc: true }],
    });

    // 整形
    type Row = Record<string, string | number>;
    const chosenDimName: string = chosenDim;
    const chosenViewName: string = chosenView;

    const rows: Row[] = (res.rows ?? []).map((r) => {
      const rec: Row = { [chosenDimName]: r.dimensionValues?.[0]?.value ?? '' };
      metrics.forEach((m, i) => {
        const name = m.name;
        const rawVal = Number(r.metricValues?.[i]?.value ?? '0');
        const val = name === 'bounceRate' || name === 'engagementRate' ? rawVal * 100 : rawVal;
        rec[name] = val;
      });
      return rec;
    });

    if (rows.length === 0) {
      return json({
        meta: { chosenDim, chosenView, chosenExtra, propertyId, startDate, endDate },
        medians: {}, pages: [], note: 'No rows',
      });
    }

    // 中央値
    const medians: Record<string, number> = {};
    const metricNames: string[] = [chosenViewName, ...chosenExtra];
    for (const name of metricNames) {
      const vals = rows.map((r) => Number(r[name] ?? 0)).filter(Number.isFinite);
      if (vals.length) medians[name] = median(vals);
    }

    // 診断
    const pages = rows.map((r) => {
      const notes: string[] = [];
      const br = Number(r['bounceRate'] ?? NaN);
      const er = Number(r['engagementRate'] ?? NaN);
      const view = Number(r[chosenViewName] ?? NaN);

      if (Number.isFinite(medians['bounceRate']) && Number.isFinite(br)) {
        if (br >= (medians['bounceRate'] as number) + 15) notes.push('直帰率が高め（要改善）');
        if (br <= Math.max(40, (medians['bounceRate'] as number) - 10)) notes.push('直帰率が低め（良好）');
      }
      if (Number.isFinite(medians['engagementRate']) && Number.isFinite(er)) {
        if (er >= (medians['engagementRate'] as number) + 10) notes.push('エンゲージメント良好');
      }
      if (Number.isFinite(medians[chosenViewName]) && Number.isFinite(view) && view < (medians[chosenViewName] as number) * 0.5) {
        notes.push('閲覧数が少ない（露出不足）');
      }
      if (notes.length === 0) notes.push('標準的');
      return { ...r, diagnosis: notes.join(' / ') };
    });

    // CSV
    if (format === 'csv') {
      const headers = [
        chosenDimName,
        'views','screenPageViews','eventCount','sessions',
        'bounceRate(%)','engagementRate(%)','averageSessionDuration','totalUsers','diagnosis',
      ];
      const toCell = (v: unknown): string => {
        const s = String(v ?? '');
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = pages.map((r) => [
        r[chosenDimName] ?? '',
        r['views'] ?? '', r['screenPageViews'] ?? '', r['eventCount'] ?? '', r['sessions'] ?? '',
        r['bounceRate'] ?? '', r['engagementRate'] ?? '', r['averageSessionDuration'] ?? '', r['totalUsers'] ?? '',
        r['diagnosis'] ?? '',
      ].map(toCell).join(','));
      const csv = [headers.join(','), ...lines].join('\n');
      return new NextResponse(csv, {
        status: 200,
        headers: {
          ...CORS,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="ga4-diagnose-${propertyId}-${startDate}_${endDate}.csv"`,
        },
      });
    }

    // JSON
    return json({ meta: { chosenDim, chosenView, chosenExtra, propertyId, startDate, endDate }, medians, pages });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
}
