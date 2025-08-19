// app/api/diagnose/route.ts
export const runtime = 'nodejs'; // gRPC を使うので Edge ではなく Node 実行

import { NextRequest, NextResponse } from 'next/server';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import fs from 'fs';
import path from 'path';

// 使える候補（プロパティによって有無が違うため、自動選択）
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

function median(nums: number[]) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// env の鍵が \n / 実改行どちらでも動くよう正規化
function normalizePrivateKey(raw: string | undefined) {
  if (!raw) return '';
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw.replace(/\r/g, '');
}

// サービスアカウントクライアントを生成（ga4-key.json 優先 → env フォールバック）
function createClient(): BetaAnalyticsDataClient {
  const keyPath = path.join(process.cwd(), 'ga4-key.json');
  if (fs.existsSync(keyPath)) {
    const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    return new BetaAnalyticsDataClient({
      credentials: {
        client_email: sa.client_email,
        private_key: sa.private_key, // 複数行のままでOK
      },
    });
  }
  const email = process.env.GA4_CLIENT_EMAIL || '';
  const pk = normalizePrivateKey(process.env.GA4_PRIVATE_KEY);
  if (!email || !pk) throw new Error('Missing GA4_CLIENT_EMAIL or GA4_PRIVATE_KEY');
  return new BetaAnalyticsDataClient({
    credentials: { client_email: email, private_key: pk },
  });
}

export async function POST(req: NextRequest) {
  try {
    // （任意）APIキー認証
    if (process.env.API_KEY) {
      const k = (req.headers.get('x-api-key') || '').trim();
      const serverKey = (process.env.API_KEY || '').trim();
      if (serverKey && k !== serverKey) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const {
      propertyId,
      startDate = '28daysAgo',
      endDate = 'yesterday',
      limit = 1000,
    } = (await req.json()) as {
      propertyId?: string;
      startDate?: string;
      endDate?: string;
      limit?: number;
    };

    if (!propertyId) {
      return NextResponse.json({ error: 'propertyId is required' }, { status: 400 });
    }

    const client = createClient();
    const propertyName = `properties/${propertyId}`;

    // 1) メタデータから使える次元・指標を自動選択
    const [meta] = await client.getMetadata({ name: `${propertyName}/metadata` });
    const dims = new Set((meta.dimensions ?? []).map((d) => d.apiName));
    const mets = new Set((meta.metrics ?? []).map((m) => m.apiName));

    const chosenDim = DIM_CANDIDATES.find((n) => dims.has(n));
    const chosenView = VIEW_METRICS.find((n) => mets.has(n));
    const chosenExtra = EXTRA_METRICS.filter((n) => mets.has(n));
    if (!chosenDim || !chosenView) {
      return NextResponse.json(
        { error: 'Required dimensions/metrics not available in this property.' },
        { status: 400 },
      );
    }

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

    // 3) 整形（bounceRate / engagementRate は 0〜1 → 0〜100 の % に変換）
    const rows = (res.rows ?? []).map((r) => {
      const rec: Record<string, any> = {
        [chosenDim]: r.dimensionValues?.[0]?.value || '',
      };
      metrics.forEach((m, i) => {
        const name = m.name;
        let num = Number(r.metricValues?.[i]?.value ?? '0');
        if (name === 'bounceRate' || name === 'engagementRate') {
          num = num * 100; // % へ変換
        }
        rec[name] = num;
      });
      return rec;
    });

    if (!rows.length) {
      return NextResponse.json(
        {
          meta: { chosenDim, chosenView, chosenExtra, startDate, endDate },
          medians: {},
          pages: [],
          note: 'No rows. Check date range or data availability.',
        },
        { status: 200 },
      );
    }

    // 4) 中央値（%変換後の値で計算）
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

    return NextResponse.json({
      meta: { chosenDim, chosenView, chosenExtra, startDate, endDate },
      medians,
      pages,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
