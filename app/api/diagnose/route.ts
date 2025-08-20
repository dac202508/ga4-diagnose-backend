/* eslint-disable @typescript-eslint/no-explicit-any */
export const runtime = 'nodejs';        // gRPC/FS を使うため Edge ではなく Node 実行
export const dynamic = 'force-dynamic'; // 事前ビルドを避けて常に動的実行

import { NextRequest } from 'next/server';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import fs from 'fs';
import path from 'path';

/* ----------------------------- CORS ヘッダ ------------------------------ */
const CORS_HEADERS: HeadersInit = {
  'Access-Control-Allow-Origin': '*',                 // 必要に応じて自分のWebのOriginに絞る
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
};
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
// JSONレスポンス用ヘルパー（常にCORSを付ける）
const json = (data: any, init: number | ResponseInit = 200) =>
  Response.json(
    data,
    typeof init === 'number'
      ? { status: init, headers: CORS_HEADERS }
      : { ...init, headers: { ...CORS_HEADERS, ...(init.headers ?? {}) } }
  );

/* -------------------------- 指標/次元の候補 --------------------------- */
const DIM_CANDIDATES = [
  'pagePath',
  'pageLocation',
  'unifiedPagePathScreen',
  'unifiedScreenName',
  'screenName',
] as const;

const VIEW_METRICS = ['views', 'screenPageViews', 'eventCount', 'sessions'] as const;

const EXTRA_METRICS = [
  'bounceRate',
  'engagementRate',
  'averageSessionDuration',
  'totalUsers',
  'sessions',
] as const;

/* ------------------------------- ユーティリティ ------------------------------- */
function median(nums: number[]) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function normalizePrivateKey(raw?: string) {
  if (!raw) return '';
  // \n 形式でも実改行でもOKにする
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw.replace(/\r/g, '');
}

// ga4-key.json（直置き）があればそれを優先。無ければ .env の値を使う。
function createClient(): BetaAnalyticsDataClient {
  const keyPath = path.join(process.cwd(), 'ga4-key.json');
  if (fs.existsSync(keyPath)) {
    const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    return new BetaAnalyticsDataClient({
      credentials: { client_email: sa.client_email, private_key: sa.private_key },
    });
  }
  const email = process.env.GA4_CLIENT_EMAIL || '';
  const pk = normalizePrivateKey(process.env.GA4_PRIVATE_KEY);
  if (!email || !pk) throw new Error('Missing GA4_CLIENT_EMAIL or GA4_PRIVATE_KEY');
  return new BetaAnalyticsDataClient({
    credentials: { client_email: email, private_key: pk },
  });
}

/* --------------------------------- 本体 --------------------------------- */
export async function POST(req: NextRequest) {
  try {
    // 簡易APIキー認証（ある場合のみ）
    const k = (req.headers.get('x-api-key') || '').trim();
    const serverKey = (process.env.API_KEY || '').trim();
    if (serverKey && k !== serverKey) return json({ error: 'Unauthorized' }, 401);

    const { propertyId, startDate = '28daysAgo', endDate = 'yesterday', limit = 1000 } =
      (await req.json()) as { propertyId?: string; startDate?: string; endDate?: string; limit?: number };

    if (!propertyId) return json({ error: 'propertyId is required' }, 400);

    const client = createClient();
    const propertyName = `properties/${propertyId}`;

    // 1) このプロパティで使える次元/指標を自動選択
    const [meta] = await client.getMetadata({ name: `${propertyName}/metadata` });
    const dims = new Set((meta.dimensions ?? []).map((d) => d.apiName));
    const mets = new Set((meta.metrics ?? []).map((m) => m.apiName));
    const chosenDim = DIM_CANDIDATES.find((n) => dims.has(n));
    const chosenView = VIEW_METRICS.find((n) => mets.has(n));
    const chosenExtra = EXTRA_METRICS.filter((n) => mets.has(n));
    if (!chosenDim || !chosenView)
      return json({ error: 'Required dimensions/metrics not available in this property.' }, 400);

    const metrics = [chosenView, ...chosenExtra].map((name) => ({ name }));

    // 2) データ取得
    const [res] = await client.runReport({
      property: propertyName,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: chosenDim }],
      metrics,
      limit,
      orderBys: [{ metric: { metricName: chosenView }, desc: true }],
    });

    // 3) 整形（率は % に変換）
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

    if (!rows.length)
      return json({
        meta: { chosenDim, chosenView, chosenExtra, startDate, endDate },
        medians: {},
        pages: [],
        note: 'No rows. Check date range or data availability.',
      });

    // 4) 中央値
    const medians: Record<string, number> = {};
    [chosenView, ...chosenExtra].forEach((name) => {
      const vals = rows.map((r) => Number(r[name] || 0)).filter(Number.isFinite);
      if (vals.length) medians[name] = median(vals);
    });

    // 5) 簡易診断（%前提のしきい値）
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

    return json({ meta: { chosenDim, chosenView, chosenExtra, startDate, endDate }, medians, pages });
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500);
  }
}
