/* eslint-disable @typescript-eslint/consistent-type-assertions */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { BetaAnalyticsDataClient } from '@google-analytics/data';

/* ========== CORS ========== */
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
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

/* ========== 小ユーティリティ ========== */
type ClientsMap = Record<string, string[]>;
const parseClients = (): ClientsMap => {
  const raw = process.env.CLIENTS_JSON ?? '';
  if (!raw) return {};
  try { return JSON.parse(raw) as ClientsMap; } catch { return {}; }
};
const normalizePK = (raw?: string): string => {
  if (!raw) return '';
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw.replace(/\r/g, '');
};
const median = (nums: number[]): number => {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/* ========== デバッグ用 GET（/api/diagnose をブラウザで開く） ========== */
export function GET(req: NextRequest) {
  let parsed: ClientsMap = {};
  try { parsed = parseClients(); } catch { parsed = {}; }
  return j({
    ok: true,
    apiKeyHeader: req.headers.get('x-api-key') ?? '',
    clients: parsed,
  });
}

/* ========== 本体 POST ========== */
const DIM_CANDIDATES = ['pagePath', 'pageLocation', 'pageTitle', 'screenName'] as const;
const VIEW_METRICS   = ['views', 'screenPageViews', 'eventCount', 'sessions'] as const;
const EXTRA_METRICS  = ['bounceRate', 'engagementRate', 'averageSessionDuration', 'totalUsers', 'sessions'] as const;

type BodyIn = { propertyId?: string; startDate?: string; endDate?: string; limit?: number };

export async function POST(req: NextRequest) {
  try {
    /* --- 認証・認可（CLIENTS_JSONを優先、無ければAPI_KEY） --- */
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
    const qs = req.nextUrl.searchParams;
    const format = (qs.get('format') ?? '').toLowerCase(); // 'csv' でCSV返す
    const body = (await req.json().catch(() => ({}))) as unknown as BodyIn;

    let { propertyId, startDate, endDate, limit } = body;
    if (!isStr(propertyId) || propertyId.length === 0) return j({ error: 'propertyId is required' }, 400);
    if (!isStr(startDate) || !startDate) startDate = '28daysAgo';
    if (!isStr(endDate) || !endDate) endDate = 'yesterday';
    if (!isNum(limit)) limit = 1000;

    // 許可propertyIdのチェック
    if (allowed && !allowed.includes(propertyId)) {
      return j({ error: 'Forbidden propertyId for this key', allowed }, 403);
    }

    /* --- GA4 クライアント --- */
    const clientEmail = process.env.GA4_CLIENT_EMAIL ?? '';
    const privateKey = normalizePK(process.env.GA4_PRIVATE_KEY);
    if (!clientEmail || !privateKey) return j({ error: 'Missing GA4 service account envs' }, 500);

    const ga = new BetaAnalyticsDataClient({ credentials: { client_email: clientEmail, private_key: privateKey } });
    const propertyName = `properties/${propertyId}`;

    /* --- メタデータ --- */
    const [meta] = await ga.getMetadata({ name: `${propertyName}/metadata` });
    const dims = new Set((meta.dimensions ?? []).map((d) => d.apiName));
    const mets = new Set((meta.metrics ?? []).map((m) => m.apiName));
    const chosenDim  = DIM_CANDIDATES.find((n) => dims.has(n));
    const chosenView = VIEW_METRICS.find((n) => mets.has(n));
    const chosenExtra = EXTRA_METRICS.filter((n) => mets.has(n));
    if (!chosenDim || !chosenView) return j({ error: 'Required dimensions/metrics not available' }, 400);

    const metrics = [chosenView, ...chosenExtra].map((name) => ({ name }));

    /* --- レポート --- */
    const [res] = await ga.runReport({
      property: propertyName,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: chosenDim }],
      metrics,
      limit,
      orderBys: [{ metric: { metricName: chosenView }, desc: true }],
    });

    /* --- 整形 --- */
    type Row = Record<string, unknown>;
    const rows: Row[] = (res.rows ?? []).map((r) => {
      const rec: Row = { [chosenDim]: r.dimensionValues?.[0]?.value ?? '' };
      metrics.forEach((m, i) => {
        const name = m.name;
        const rawVal = Number(r.metricValues?.[i]?.value ?? '0');
        const val = name === 'bounceRate' || name === 'engagementRate' ? rawVal * 100 : rawVal;
        rec[name] = val;
      });
      return rec;
    });

    if (!rows.length) {
      return j({ meta: { chosenDim, chosenView, chosenExtra, propertyId, startDate, endDate }, medians: {}, pages: [], note: 'No rows' });
    }

    /* --- 中央値 --- */
    const medians: Record<string, number> = {};
    [chosenView, ...chosenExtra].forEach((name) => {
      const vals = rows.map((r) => Number(r[name] ?? 0)).filter(Number.isFinite);
      if (vals.length) medians[name] = median(vals);
    });

    /* --- 診断 --- */
    type PageOut = Row & { diagnosis: string };
    const pages: PageOut[] = rows.map((r) => {
      const notes: string[] = [];
      const br = Number(r['bounceRate'] ?? NaN);
      const er = Number(r['engagementRate'] ?? NaN);
      const view = Number(r[chosenView] ?? NaN);

      if (isNum(medians['bounceRate']) && Number.isFinite(br)) {
        if (br >= medians['bounceRate'] + 15) notes.push('直帰率が高め（要改善）');
        if (br <= Math.max(40, medians['bounceRate'] - 10)) notes.push('直帰率が低め（良好）');
      }
      if (isNum(medians['engagementRate']) && Number.isFinite(er)) {
        if (er >= medians['engagementRate'] + 10) notes.push('エンゲージメント良好');
      }
      if (isNum(medians[chosenView]) && Number.isFinite(view) && view < medians[chosenView] * 0.5) {
        notes.push('閲覧数が少ない（露出不足）');
      }
      if (!notes.length) notes.push('標準的');
      return { ...r, diagnosis: notes.join(' / ') } as PageOut;
    });

    /* --- CSV 返却（?format=csv） --- */
    if (format === 'csv') {
      const headers = [
        chosenDim,
        'views','screenPageViews','eventCount','sessions',
        'bounceRate(%)','engagementRate(%)','averageSessionDuration','totalUsers','diagnosis',
      ];
      const toCell = (v: unknown): string => {
        const s = String(v ?? '');
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = pages.map((r) => [
        r[chosenDim] ?? '',
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

    /* --- JSON 返却 --- */
    return j({ meta: { chosenDim, chosenView, chosenExtra, propertyId, startDate, endDate }, medians, pages });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return j({ error: msg }, 500);
  }
}
