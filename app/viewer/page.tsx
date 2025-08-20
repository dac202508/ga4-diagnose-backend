'use client';
import { useEffect, useMemo, useState } from 'react';

function calcRange(preset: string) {
  const pad = (n:number)=>String(n).padStart(2,'0');
  const fmt = (d:Date)=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const today = new Date();
  const yest = new Date(today); yest.setDate(yest.getDate()-1);
  if (preset==='last7') {
    const s = new Date(yest); s.setDate(s.getDate()-6);
    return { start: fmt(s), end: fmt(yest) };
  }
  if (preset==='lastmonth') {
    const firstThis = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastPrev = new Date(firstThis.getTime() - 86400000);
    const firstPrev = new Date(lastPrev.getFullYear(), lastPrev.getMonth(), 1);
    return { start: fmt(firstPrev), end: fmt(lastPrev) };
  }
  return { start: fmt(yest), end: fmt(yest) };
}

type Row = {
  pagePath?: string; pageTitle?: string;
  screenPageViews?: number; views?: number; eventCount?: number; sessions?: number;
  bounceRate?: number; engagementRate?: number; averageSessionDuration?: number; totalUsers?: number;
  diagnosis?: string;
}

export default function Viewer() {
  const qs = typeof window !== 'undefined' ? new URLSearchParams(location.search) : null;
  const [key, setKey] = useState(qs?.get('key') || '');
  const [propertyId, setPropertyId] = useState(qs?.get('propertyId') || '');
  const init = useMemo(()=>calcRange(qs?.get('range') || 'last7'),[]);
  const [startDate, setStart] = useState(init.start);
  const [endDate, setEnd] = useState(init.end);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const base = typeof window !== 'undefined' ? location.origin : '';

  const run = async () => {
    if (!key || !propertyId) { alert('key と propertyId を入れてください'); return; }
    setLoading(true);
    try {
      const r = await fetch(`${base}/api/diagnose`, {
        method:'POST',
        headers: { 'Content-Type':'application/json', 'x-api-key': key },
        body: JSON.stringify({ propertyId, startDate, endDate, limit:200 })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(j));
      setRows(j.pages || []);
    } catch (e:any) {
      alert(e.message || 'error');
    } finally { setLoading(false); }
  };

  const dlCsv = async () => {
    const u = new URL(`${base}/api/diagnose`);
    u.searchParams.set('format','csv');
    const r = await fetch(u, {
      method:'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key': key },
      body: JSON.stringify({ propertyId, startDate, endDate, limit:200 })
    });
    const b = await r.blob();
    const url = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = url; a.download = `ga4-${propertyId}-${startDate}_${endDate}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(()=>{ if (key && propertyId) run(); },[]);

  return (
    <main style={{padding:16, maxWidth:960, margin:'0 auto'}}>
      <h1 style={{fontSize:20, fontWeight:700, marginBottom:12}}>GA4 診断ビューア</h1>

      <div style={{display:'flex', gap:8, flexWrap:'wrap', alignItems:'end', marginBottom:12}}>
        <label>API Key<br/><input value={key} onChange={e=>setKey(e.target.value)} style={{border:'1px solid #ccc', padding:6, borderRadius:6}}/></label>
        <label>Property ID<br/><input value={propertyId} onChange={e=>setPropertyId(e.target.value)} style={{border:'1px solid #ccc', padding:6, borderRadius:6}}/></label>
        <label>Start<br/><input type="date" value={startDate} onChange={e=>setStart(e.target.value)} style={{border:'1px solid #ccc', padding:6, borderRadius:6}}/></label>
        <label>End<br/><input type="date" value={endDate} onChange={e=>setEnd(e.target.value)} style={{border:'1px solid #ccc', padding:6, borderRadius:6}}/></label>
        <div style={{display:'flex', gap:6}}>
          <button onClick={()=>{const r=calcRange('last7'); setStart(r.start); setEnd(r.end);}}>直近7日</button>
          <button onClick={()=>{const r=calcRange('lastmonth'); setStart(r.start); setEnd(r.end);}}>先月</button>
          <button onClick={()=>{const r=calcRange('yesterday'); setStart(r.start); setEnd(r.end);}}>昨日</button>
        </div>
        <button onClick={run} disabled={loading} style={{padding:'8px 12px', background:'#111', color:'#fff', borderRadius:6}}>{loading?'Loading…':'診断'}</button>
        <button onClick={dlCsv} style={{padding:'8px 12px', border:'1px solid #111', borderRadius:6}}>CSV</button>
      </div>

      <table style={{width:'100%', borderCollapse:'collapse', fontSize:13}}>
        <thead>
          <tr style={{background:'#f3f4f6'}}>
            <th style={{border:'1px solid #e5e7eb', padding:8, textAlign:'left'}}>Page</th>
            <th style={{border:'1px solid #e5e7eb', padding:8}}>PV</th>
            <th style={{border:'1px solid #e5e7eb', padding:8}}>直帰率</th>
            <th style={{border:'1px solid #e5e7eb', padding:8}}>ER</th>
            <th style={{border:'1px solid #e5e7eb', padding:8}}>平均秒</th>
            <th style={{border:'1px solid #e5e7eb', padding:8}}>診断</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r,i)=>(
            <tr key={i}>
              <td style={{border:'1px solid #e5e7eb', padding:8}}>{(r as any).pageTitle || (r as any).pagePath}</td>
              <td style={{border:'1px solid #e5e7eb', padding:8, textAlign:'right'}}>
                {((r as any).screenPageViews ?? (r as any).views ?? '').toLocaleString?.() ?? (r as any).screenPageViews ?? (r as any).views}
              </td>
              <td style={{border:'1px solid #e5e7eb', padding:8, textAlign:'right'}}>{((r as any).bounceRate ?? '').toFixed?.(1) ?? (r as any).bounceRate}%</td>
              <td style={{border:'1px solid #e5e7eb', padding:8, textAlign:'right'}}>{((r as any).engagementRate ?? '').toFixed?.(1) ?? (r as any).engagementRate}%</td>
              <td style={{border:'1px solid #e5e7eb', padding:8, textAlign:'right'}}>{Math.round((r as any).averageSessionDuration ?? 0)}</td>
              <td style={{border:'1px solid #e5e7eb', padding:8}}>{(r as any).diagnosis}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
