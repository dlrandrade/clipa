import { NextResponse } from 'next/server';
import { COOKIE, safeEqual, sessionToken } from '@/lib/auth';

export async function POST(req: Request) {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    return NextResponse.json({ error: 'APP_PASSWORD não está definido no servidor.' }, { status: 500 });
  }
  const body = await req.json().catch(() => ({}));
  const given = typeof body.password === 'string' ? body.password : '';
  const [a, b] = await Promise.all([sessionToken(given), sessionToken(password)]);
  if (!safeEqual(a, b)) {
    await new Promise((r) => setTimeout(r, 600)); // freia tentativa em massa
    return NextResponse.json({ error: 'Senha incorreta.' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, b, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE);
  return res;
}
