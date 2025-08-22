'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ZAxis,
} from 'recharts';

/* ---------- helpers ---------- */
function rangeFromPreset(preset: string | null) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const today = new Date();
  const yest = new Date(today);
  yest.setDate(yest.getDate() - 1);

  if (preset === 'last7') {
    const s = new Date(yest);
    s.setDate(s.getDate() - 6);
    return { start: fmt(s), end: fmt(yest) };
  }
  if (preset === 'lastmonth') {
    const firstThis = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastPrev = new Date(firstThis.getTime() - 86400000);
    const firstPrev = new Date(lastPrev.getFullYear(), lastPrev.getMonth(), 1);
    return { start: fmt(firstPrev), end: fmt(lastPrev) };
  }
  // default: yesterday
  return { start: fmt(yest), end: fmt(yest) };
}

function fmtInt(n?: number): string {
  return typeof n === 'number' ? n.toLocaleString() : '';
}
function fmtPct(n?: number): string {
  return typeof n === 'number' ? `${n.toFixed(1)}%` : '';
}
function fmtSec(n?: number): string {
  return typeof n === 'number' ? String(Math.round(n)) : '';
}

/* ---------- API types ---------- */
type PageRow = {
  pagePath?: string;
  pageTitle?: string;
  views?: number;
  screenPageViews?: number;
  eventCount?: number;
  sessions?: number;
  bounceRate?: number;
  engagementRate?: number;
  averageSessionDuration?: number;
  totalUsers?: number;
  diagnosis?: string;
  [k: string]: string | number | undefined;
};
type DiagnoseJson = { pages?: PageRow[] };

/* 参照元（流入） */
type TrafficDim = 'sourcemedium' | 'channel' | 'referrer';
type TrafficRow = {
  label: string;
  sessions: number;
  totalUsers: number;
  engagementRate: number;     // %
  bounceRate: number;         // %
  averageSessionDuration: number;
};
type TrafficJson = { rows?: TrafficRow[] };

/* 日別トレンド */
type SeriesRow = {
  date: string;
  sessions: number;
  pageViews: number;
  users: number;
  avgSessionSec: number;
  erPercent: number;
  brPercent: number;
};
type TimeseriesJson = { rows?: SeriesRow[] };

/* ---------- Component ---------- */
export default function ViewerPage() {
  const [apiKey, setApiKey] = useState<string>('');
  const [propertyId, setPropertyId] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [rows, setRows] = useState<PageRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  // 参照元（流入）
  const [traffic, setTraffic] = useState<TrafficRow[]>([]);
  const [trafficDim, setTrafficDim] = useState<TrafficDim>('sourcemedium');
  const [tLoading, setTLoading] = useState<boolean>(false);

  // 日別トレンド
  const [series, setSeries] = useState<SeriesRow[]>([]);
  const [seriesLoading, setSeriesLoading] = useState<boolean>(false);
  const [focusPath, setFocusPath] = useState<string>(''); // 部分一致でページ絞り込み

  // 初回：URLパラメータを読み込む
  useEffect(() => {
    const usp = new URLSearchParams(window.location.search);
    const keyQ = usp.get('key');
    const propQ = usp.get('propertyId');
    const rangeQ = usp.get('range'); // last7 | lastmonth | yesterday
    if (keyQ) setApiKey(keyQ);
    if (propQ) setPropertyId(propQ);
    const r = rangeFromPreset(rangeQ);
    setStartDate(r.start);
    setEndDate(r.end);
  }, []);

  // 初回自動実行（依存は正しく列挙）
  const firstRun = useRef<boolean>(false);
  useEffect(() => {
    if (firstRun.current) return;
    if (apiKey && propertyId && startDate && endDate) {
      firstRun.current = true;
      void run(); // fire & forget
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, propertyId, startDate, endDate]);

  async function run() {
    if (!apiKey || !propertyId) {
      alert('API Key と Property ID を入力してください');
      return;
    }
    setLoading(true);
    try {
      const base = window.location.origin;
      const res = await fetch(`${base}/api/diagnose`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ propertyId, startDate, endDate, limit: 200 }),
      });
      const json = (await res.json()) as DiagnoseJson;
      if (!res.ok) throw new Error(JSON.stringify(json));
      setRows(Array.isArray(json.pages) ? json.pages : []);
    } catch (e) {
      console.error(e);
      alert('取得に失敗しました。コンソールを確認してください。');
    } finally {
      setLoading(false);
    }
  }

  async function downloadCsv() {
    if (!apiKey || !propertyId) return;
    const base = window.location.origin;
    const u = new URL(`${base}/api/diagnose`);
    u.searchParams.set('format', 'csv');
    const res = await fetch(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ propertyId, startDate, endDate, limit: 200 }),
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ga4-${propertyId}-${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function fetchTraffic(dim: TrafficDim) {
    if (!apiKey || !propertyId) {
      alert('API Key と Property ID を入力してください');
      return;
    }
    setTLoading(true);
    try {
      const base = window.location.origin;
      const res = await fetch(`${base}/api/traffic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ propertyId, startDate, endDate, limit: 50, dim }),
      });
      const json = (await res.json()) as TrafficJson;
      if (!res.ok) throw new Error(JSON.stringify(json));
      setTraffic(Array.isArray(json.rows) ? json.rows : []);
      setTrafficDim(dim);
    } catch (e) {
      console.error(e);
      alert('参照元の取得に失敗しました');
    } finally {
      setTLoading(false);
    }
  }

  async function fetchSeries() {
    if (!apiKey || !propertyId) {
      alert('API Key と Property ID を入力してください');
      return;
    }
    setSeriesLoading(true);
    try {
      const base = window.location.origin;
      const body: Record<string, unknown> = { propertyId, startDate, endDate };
      if (focusPath.trim()) body.pagePathContains = focusPath.trim();
      const res = await fetch(`${base}/api/timeseries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as TimeseriesJson;
      if (!res.ok) throw new Error(JSON.stringify(json));
      setSeries(Array.isArray(json.rows) ? json.rows : []);
    } catch (e) {
      console.error(e);
      alert('日別トレンドの取得に失敗しました');
    } finally {
      setSeriesLoading(false);
    }
  }

  /* ---------- UI ---------- */
  return (
    <main style={{ padding: 16, maxWidth: 960, margin: '0 auto' }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>
        GA4 診断ビューア
      </h1>

      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'end',
          marginBottom: 12,
        }}
      >
        <label>
          API Key
          <br />
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={{ border: '1px solid #ccc', padding: 6, borderRadius: 6 }}
          />
        </label>

        <label>
          Property ID
          <br />
          <input
            value={propertyId}
            onChange={(e) => setPropertyId(e.target.value)}
            style={{ border: '1px solid #ccc', padding: 6, borderRadius: 6 }}
          />
        </label>

        <label>
          Start
          <br />
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{ border: '1px solid #ccc', padding: 6, borderRadius: 6 }}
          />
        </label>

        <label>
          End
          <br />
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={{ border: '1px solid #ccc', padding: 6, borderRadius: 6 }}
          />
        </label>

        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => { const r = rangeFromPreset('last7'); setStartDate(r.start); setEndDate(r.end); }}>
            直近7日
          </button>
          <button onClick={() => { const r = rangeFromPreset('lastmonth'); setStartDate(r.start); setEndDate(r.end); }}>
            先月
          </button>
          <button onClick={() => { const r = rangeFromPreset('yesterday'); setStartDate(r.start); setEndDate(r.end); }}>
            昨日
          </button>
        </div>

        <button
          onClick={run}
          disabled={loading}
          style={{ padding: '8px 12px', background: '#111', color: '#fff', borderRadius: 6 }}
        >
          {loading ? 'Loading…' : '診断'}
        </button>
        <button
          onClick={downloadCsv}
          style={{ padding: '8px 12px', border: '1px solid #111', borderRadius: 6 }}
        >
          CSV
        </button>

        {/* 日別トレンド取得 */}
        <input
          placeholder="特定ページの部分一致（例: /contact/）"
          value={focusPath}
          onChange={(e) => setFocusPath(e.target.value)}
          style={{ border: '1px solid #ccc', padding: 6, borderRadius: 6, minWidth: 240 }}
        />
        <button
          onClick={fetchSeries}
          disabled={seriesLoading}
          style={{ padding: '8px 12px' }}
        >
          {seriesLoading ? 'Loading…' : '日別トレンド'}
        </button>
      </div>

      {/* ページ別の診断表 */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#f3f4f6', color: '#111' }}>
            <th style={{ border: '1px solid #e5e7eb', padding: 8, textAlign: 'left' }}>Page</th>
            <th style={{ border: '1px solid #e5e7eb', padding: 8 }}>PV</th>
            <th style={{ border: '1px solid #e5e7eb', padding: 8 }}>直帰率</th>
            <th style={{ border: '1px solid #e5e7eb', padding: 8 }}>ER</th>
            <th style={{ border: '1px solid #e5e7eb', padding: 8 }}>平均秒</th>
            <th style={{ border: '1px solid #e5e7eb', padding: 8 }}>診断</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const pv = typeof r.screenPageViews === 'number' ? r.screenPageViews : r.views;
            return (
              <tr key={`${r.pagePath ?? r.pageTitle ?? 'row'}-${i}`}>
                <td style={{ border: '1px solid #e5e7eb', padding: 8 }}>
                  {r.pageTitle ?? r.pagePath ?? ''}
                </td>
                <td style={{ border: '1px solid #e5e7eb', padding: 8, textAlign: 'right' }}>
                  {fmtInt(pv)}
                </td>
                <td style={{ border: '1px solid #e5e7eb', padding: 8, textAlign: 'right' }}>
                  {fmtPct(r.bounceRate)}
                </td>
                <td style={{ border: '1px solid #e5e7eb', padding: 8, textAlign: 'right' }}>
                  {fmtPct(r.engagementRate)}
                </td>
                <td style={{ border: '1px solid #e5e7eb', padding: 8, textAlign: 'right' }}>
                  {fmtSec(r.averageSessionDuration)}
                </td>
                <td style={{ border: '1px solid #e5e7eb', padding: 8 }}>{r.diagnosis ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* 参照元（流入）セクション */}
      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>参照元（流入）</h2>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button onClick={() => fetchTraffic('sourcemedium')} disabled={tLoading}>
            Source / Medium
          </button>
          <button onClick={() => fetchTraffic('channel')} disabled={tLoading}>
            チャネル（デフォルト）
          </button>
          <button onClick={() => fetchTraffic('referrer')} disabled={tLoading}>
            参照元URL
          </button>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f3f4f6', color: '#111' }}>
              <th style={{ border: '1px solid #e5e7eb', padding: 8, textAlign: 'left' }}>
                {trafficDim === 'channel' ? 'Channel'
                  : trafficDim === 'referrer' ? 'Referrer'
                  : 'Source / Medium'}
              </th>
              <th style={{ border: '1px solid #e5e7eb', padding: 8 }}>Sessions</th>
              <th style={{ border: '1px solid #e5e7eb', padding: 8 }}>Users</th>
              <th style={{ border: '1px solid #e5e7eb', padding: 8 }}>ER</th>
              <th style={{ border: '1px solid #e5e7eb', padding: 8 }}>直帰率</th>
              <th style={{ border: '1px solid #e5e7eb', padding: 8 }}>平均秒</th>
            </tr>
          </thead>
          <tbody>
            {traffic.map((r, i) => (
              <tr key={`${r.label}-${i}`}>
                <td style={{ border: '1px solid #e5e7eb', padding: 8 }}>{r.label || '(not set)'}</td>
                <td style={{ border: '1px solid #e5e7eb', padding: 8, textAlign: 'right' }}>{fmtInt(r.sessions)}</td>
                <td style={{ border: '1px solid #e5e7eb', padding: 8, textAlign: 'right' }}>{fmtInt(r.totalUsers)}</td>
                <td style={{ border: '1px solid #e5e7eb', padding: 8, textAlign: 'right' }}>{fmtPct(r.engagementRate)}</td>
                <td style={{ border: '1px solid #e5e7eb', padding: 8, textAlign: 'right' }}>{fmtPct(r.bounceRate)}</td>
                <td style={{ border: '1px solid #e5e7eb', padding: 8, textAlign: 'right' }}>{fmtSec(r.averageSessionDuration)}</td>
              </tr>
            ))}
            {traffic.length === 0 && (
              <tr>
                <td colSpan={6} style={{ border: '1px solid #e5e7eb', padding: 8, color: '#6b7280' }}>
                  上のボタンを押すと参照元一覧を取得します
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {/* ===== グラフ：上位ページPV（Bar） ===== */}
      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>上位ページ PV（Top10）</h2>
        <div style={{ width: '100%', height: 320 }}>
          <ResponsiveContainer>
            <BarChart
              data={rows.slice(0, 10).map(r => ({
                name: String((r.pageTitle ?? r.pagePath ?? '')).slice(0, 20),
                pv: typeof r.screenPageViews === 'number' ? r.screenPageViews : (r.views ?? 0),
              }))}
              margin={{ top: 10, right: 20, left: 0, bottom: 40 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" angle={-30} textAnchor="end" interval={0} height={60}/>
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar dataKey="pv" name="PV" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* ===== グラフ：日別セッション/ページビュー（Line） ===== */}
      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
          日別トレンド（Sessions / PageViews{focusPath ? `｜filter: ${focusPath}` : ''}）
        </h2>
        <div style={{ width: '100%', height: 320 }}>
          <ResponsiveContainer>
            <LineChart data={series} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis yAxisId="left" />
              <YAxis yAxisId="right" orientation="right" />
              <Tooltip />
              <Legend />
              <Line yAxisId="left" type="monotone" dataKey="sessions" name="Sessions" dot={false}/>
              <Line yAxisId="right" type="monotone" dataKey="pageViews" name="PageViews" strokeDasharray="5 3" dot={false}/>
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* ===== グラフ：直帰率×ER の散布図（サイズ=PV） ===== */}
      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>直帰率 × ER（サイズ=PV）</h2>
        <div style={{ width: '100%', height: 360 }}>
          <ResponsiveContainer>
            <ScatterChart margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid />
              <XAxis type="number" dataKey="br" name="直帰率(%)" unit="%" />
              <YAxis type="number" dataKey="er" name="ER(%)" unit="%" />
              <ZAxis type="number" dataKey="pv" range={[60, 400]} />
              <Tooltip cursor={{ strokeDasharray: '3 3' }} />
              <Legend />
              <Scatter
                name="Pages"
                data={rows.slice(0, 50).map(r => {
                  const pv = typeof r.screenPageViews === 'number' ? r.screenPageViews : (r.views ?? 0);
                  const br = typeof r.bounceRate === 'number' ? r.bounceRate : 0;
                  const er = typeof r.engagementRate === 'number' ? r.engagementRate : 0;
                  return { name: String((r.pageTitle ?? r.pagePath ?? '')).slice(0, 30), pv, br, er };
                })}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        <p style={{ color:'#6b7280', fontSize:12, marginTop:4 }}>
          ※ 右上（ER高・直帰低）が理想。左下は要改善傾向。
        </p>
      </section>
    </main>
  );
}
