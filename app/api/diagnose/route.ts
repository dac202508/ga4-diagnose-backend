/* eslint-disable @typescript-eslint/no-explicit-any */
export const runtime = 'nodejs';        // 必ず Node で
export const dynamic = 'force-dynamic'; // 毎回動的実行

import { NextRequest, NextResponse } from 'next/server';
import { BetaAnalyticsDataClient } from '@google-analytics/data';

/* ============================== CORS ============================== */
const CORS_HEADERS: HeadersInit = {
  'Access-Control-Allow-Origin': '*', // 必要に応じて自社フロントのOriginに限定
  'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
};
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
const json = (data: any, init: number | ResponseInit = 200) =>
  Response.json(
    data,
    typeof init === 'number'
      ? { status: init, headers: CORS_HEADERS }
      : { ...init, headers: { ...CORS_HEADERS, ...(init.headers ?? {}) } }
  );

/* =========================== ユーティリティ =========================== */
function normalizePrivateKey(raw?: string) {
  if (!raw) return '';
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw.replace(/\r/g, '');
}
function median(nums: number[]) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
type ClientsMap = Record<string, string[]>;
function parseClients(): ClientsMap {
  const raw = process.env.CLIENTS_JSON || '';
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
function makeClient() {
  const client_email = process.env.GA4_CLIENT_EMAIL || '';
  const private_key = normalizePrivateKey(process.env.GA4_PRIVATE_KEY);
  if (!client_email || !private_key) throw new Error('Missing GA4_CLIENT_EMAIL or GA4_PRIVATE_KEY');
  return new BetaAnalyticsDataClient({ credentials: { client_email, private_key } });
}

/* ====================== デバッグ用 GET（臨時） ====================== */
/** ブラウザで /api/diagnose を開くと、CLIENTS_JSON の読み取り結果を確認できる */
export async function GET(req: NextRequest) {
  try {
    const raw = process.env.CLIENTS_JSON || '';
    const parsed = raw ? JSON.parse(raw) : {};
    return NextResponse.json({
      ok: true,
      rawLength: raw.length,
      apiKeyHeader: req.headers.get('x-api-key') || '',
      clients: parsed,
    }, { headers: CORS_HEADERS });
  } catch (e: any) {
    return NextResponse.json({
      ok: false,
      error: e?.message || String(e),
      raw: process.env.CLIENTS_JSON,
    }, { status: 500, headers: CORS_HEADERS });
  }
}

/* ================================ 本体 ================================ */
const DIM_CANDIDATES = ['pagePath', 'pageLocation', 'pageTitle', 'screenName'] as const;
const VIEW_METRICS   = ['views', 'screenPageViews', 'eventCount', 'sessions'] as const;
const EXTRA_METRICS  = ['bounceRate', 'engagementRate', 'averageSessionDuration', 'totalUsers', 'sessions'] as const;

export async function POST(req: NextRequest) {
  try {
    /* ---- 認証・認可 ---- */
    const headerKey = (req.headers.get('x-api-key') || '').trim();
    const clients = parseClients();
    const legacyKey = (process.env.API_KEY || '').trim();

    let allowed: string[] | null = null;
    if (Object.keys(clients).length > 0) {
      allowed = clients[headerKey] || null;
      if (!headerKey || !allowed?.length) return json({ error: 'Unauthorized' }, 401);
    } else if (legacyKey) {
      if (headerKey !== legacyKey) return json({ error: 'Unauthorized' }, 401);
    } // else: 無認証運用（推奨しない）

    /* ---- 入力 ---- */
    const url = req.nextUrl;
    const format = (url.searchParams.get('format') || '').toLowerCase(); // 'csv' でCSV返す
    const body = await req.json().catch(() => ({}));
    let { propertyId, startDate = '28daysAgo', endDate = 'yesterday', limit = 1000 } = body as {
      propertyId?: string; startDate?: string; endDate?: string; limit?: number;
    };
    if (!propertyId) return json({ error: 'propertyId is required' }, 400);

    if (allowed) {
      // 許可 propertyId の強制（安全のため 403 を返す仕様）
      if (!allowed.includes(propertyId)) {
        return json({ error: 'Forbidden propertyId for this key', allowed }, 403);
      }
    }

    /* ---- GA4 メタデータ ---- */
    const client = makeClient();
    const propertyName = `properties/${propertyId}`;
    const [meta] = await client.getMetadata({ name: `${propertyName}/metadata` });
    const dims = new Set((meta.dimensions ?? []).map((d) => d.apiName));
    const mets = new Set((meta.metrics ?? []).map((m) => m.apiName));
    const chosenDim  = DIM_CANDIDATES.find((n) => dims.has(n));
    const chosenView = VIEW_METRICS.find((n) => mets.has(n));
    const chosenExtra = EXTRA_METRICS.filter((n) => mets.has(n));
    if (!chosenDim || !chosenView) {
      return json({ error: 'Required dimensions/metrics not available in this property.' }, 400);
    }

    const metrics = [chosenView, ...chosenExtra].map((name) => ({ name }));

    /* ---- レポート ---- */
    const [res] = await client.runReport({
      property: propertyName,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: chosenDim }],
      metrics,
      limit,
      orderBys: [{ metric: { metricName: chosenView }, desc: true }],
    });

    /* ---- 整形（％変換） ---- */
    const rows = (res.rows ?? []).map((r) => {
      const rec: Record<string, any> = { [chosenDim]: r.dimensionValues?.[0]?.value || '' };
      metrics.forEach((m, i) => {
        const name = m.name;
        let num = Number(r.metricValues?.[i]?.value ?? '0');
        if (name === 'bounceRate' || name === 'engagementRate') num = num * 100; // 0-1 → %
        rec[name] = num;
      });
      return rec;
    });
    if (!rows.length) {
      return json({
        meta: { chosenDim, chosenView, chosenExtra, propertyId, startDate, endDate },
        medians: {},
        pages: [],
        note: 'No rows. Check date range or data availability.',
      });
    }

    /* ---- 中央値計算 ---- */
    const medians: Record<string, number> = {};
    [chosenView, ...chosenExtra].forEach((name) => {
      const vals = rows.map((r) => Number(r[name] || 0)).filter(Number.isFinite);
      if (vals.length) medians[name] = median(vals);
    });

    /* ---- 簡易診断 ---- */
    const pages = rows.map((r) => {
      const notes: string[] = [];
      if (Number.isFinite(medians.bounceRate) && Number.isFinite(r.bounceRate)) {
        if (r.bounceRate >= (medians.bounceRate as number) + 15) notes.push('直帰率が高め（要改善）');
        if (r.bounceRate <= Math.max(40, (medians.bounceRate as number) - 10)) notes.push('直帰率が低め（良好）');
      }
      if (Number.isFinite(medians.engagementRate) && Number.isFinite(r.engagementRate)) {
        if (r.engagementRate >= (medians.engagementRate as number) + 10) notes.push('エンゲージメント良好');
      }
      if (Number.isFinite(medians[chosenView]) && r[chosenView] < (medians[chosenView] as number) * 0.5) {
        notes.push('閲覧数が少ない（露出不足）');
      }
      if (!notes.length) notes.push('標準的');
      return { ...r, diagnosis: notes.join(' / ') };
    });

    /* ---- CSV で返す（?format=csv） ---- */
    if (format === 'csv') {
      const headers = [
        chosenDim,
        'views',
        'screenPageViews',
        'eventCount',
        'sessions',
        'bounceRate(%)',
        'engagementRate(%)',
        'averageSessionDuration',
        'totalUsers',
        'diagnosis',
      ];
      const toCell = (v: any) =>
        typeof v === 'string' ? `"${v.replace(/"/g, '""')}"` : (v ?? '').toString();
      const lines = pages.map((r) => [
        r[chosenDim],
        r.views ?? '',
        r.screenPageViews ?? '',
        r.eventCount ?? '',
        r.sessions ?? '',
        r.bounceRate ?? '',
        r.engagementRate ?? '',
        r.averageSessionDuration ?? '',
        r.totalUsers ?? '',
        r.diagnosis ?? '',
      ].map(toCell).join(','));
      const csv = [headers.join(','), ...lines].join('\n');
      return new Response(csv, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="ga4-diagnose-${propertyId}-${startDate}_${endDate}.csv"`,
        },
      });
    }

    /* ---- JSON で返す ---- */
    return json({
      meta: { chosenDim, chosenView, chosenExtra, propertyId, startDate, endDate },
      medians,
      pages,
    });
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500);
  }
}
