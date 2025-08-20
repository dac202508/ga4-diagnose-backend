'use client';

import { useEffect, useRef, useState } from 'react';

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
  // 予防的に動的キーも許可
  [k: string]: string | number | undefined;
};
type DiagnoseJson = { pages?: PageRow[] };

/* ---------- Component ---------- */
export default function ViewerPage() {
  const [apiKey, setApiKey] = useState<string>('');
  const [propertyId, setPropertyId] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [rows, setRows] = useState<PageRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

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
      const base =
        typeof window !== 'undefined' ? window.location.origin : '';
      const res = await fetch(`${base}/api/diagnose`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          propertyId,
          startDate,
          endDate,
          limit: 200,
        }),
      });
      const json = (await res.json()) as DiagnoseJson;
      if (!res.ok) {
        throw new Error(JSON.stringify(json));
      }
      setRows(Array.isArray(json.pages) ? json.pages : []);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
      alert('取得に失敗しました。コンソールを確認してください。');
    } finally {
      setLoading(false);
    }
  }

  async function downloadCsv() {
    if (!apiKey || !propertyId) return;
    const base = typeof window !== 'undefined' ? window.location.origin : '';
    const u = new URL(`${base}/api/diagnose`);
    u.searchParams.set('format', 'csv');
    const res = await fetch(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
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
          <button
            onClick={() => {
              const r = rangeFromPreset('last7');
              setStartDate(r.start);
              setEndDate(r.end);
            }}
          >
            直近7日
          </button>
          <button
            onClick={() => {
              const r = rangeFromPreset('lastmonth');
              setStartDate(r.start);
              setEndDate(r.end);
            }}
          >
            先月
          </button>
          <button
            onClick={() => {
              const r = rangeFromPreset('yesterday');
              setStartDate(r.start);
              setEndDate(r.end);
            }}
          >
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
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#f3f4f6' }}>
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
    </main>
  );
}
