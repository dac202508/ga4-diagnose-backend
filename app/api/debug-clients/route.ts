import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ClientsMap = Record<string, string[]>;

export function GET() {
  const raw = process.env.CLIENTS_JSON ?? '';

  let parsed: ClientsMap = {};
  try {
    parsed = raw ? (JSON.parse(raw) as unknown as ClientsMap) : {};
  } catch (err) {
    const message = err instanceof Error ? err.message : 'JSON parse error';
    return NextResponse.json({ ok: false, error: message, raw }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    rawLength: raw.length,
    clients: parsed,
  });
}
