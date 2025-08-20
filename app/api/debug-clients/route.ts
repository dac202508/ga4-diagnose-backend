import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  try {
    const raw = process.env.CLIENTS_JSON || '';
    const parsed = raw ? JSON.parse(raw) : {};
    const summary = Object.fromEntries(
      Object.entries(parsed as Record<string, string[]>).map(([k, arr]) => [
        k, (arr || []).map(v => ({ value: String(v), type: typeof v }))
      ])
    );
    return NextResponse.json({ ok: true, rawLength: raw.length, clients: summary });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message, raw: process.env.CLIENTS_JSON }, { status: 500 });
  }
}
