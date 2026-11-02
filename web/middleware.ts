import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE, safeEqual, sessionToken } from '@/lib/auth';

export async function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  const cookie = req.cookies.get(COOKIE)?.value;
  const ok = !!password && !!cookie && safeEqual(cookie, await sessionToken(password));
  if (ok) return NextResponse.next();

  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!login|api/login|_next/static|_next/image|favicon.ico).*)'],
};
