export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
export function GET() { return NextResponse.json({ ok: true, route: '/api/hello' }); }
export async function POST() { return NextResponse.json({ ok: true, method: 'POST' }); }
