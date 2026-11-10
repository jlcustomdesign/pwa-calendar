import { defineMiddleware } from 'astro:middleware';
import { createSupabaseServerClient } from './lib/supabaseServer';
import { rateLimit } from './utils/rateLimit';

const PUBLIC_ROUTES = ['/login', '/signup', '/api/auth'];

export const onRequest = defineMiddleware(async (context, next) => {
  const { url, cookies, redirect, request } = context;

  // Rate limit sensitive surfaces: API routes and the login page (login posts go
  // to Supabase GoTrue, which has its own per-IP limits; this covers our surface).
  // The login-page limit only covers static HTML loads, so it stays generous
  // enough for refreshes / PWA restarts; the strict brute-force limit lives at GoTrue.
  if (url.pathname.startsWith('/api/') || url.pathname === '/login') {
    // Prefer the platform-set header; x-forwarded-for's FIRST entry is
    // client-spoofable — the LAST entry is the one appended by our own proxy.
    const ip =
      request.headers.get('x-vercel-forwarded-for')?.trim() ??
      request.headers.get('x-forwarded-for')?.split(',').pop()?.trim() ??
      'unknown';
    const isApi = url.pathname.startsWith('/api/');
    const { allowed, retryAfterSec } = rateLimit(
      `${isApi ? 'api' : 'login'}:${ip}`,
      isApi ? 60 : 30,
      60_000
    );
    if (!allowed) {
      return new Response('Too Many Requests', {
        status: 429,
        headers: { 'Retry-After': String(retryAfterSec) },
      });
    }
  }

  // Allow public routes and static assets
  if (
    PUBLIC_ROUTES.some(route => url.pathname.startsWith(route)) ||
    url.pathname.startsWith('/_astro/') ||
    url.pathname.startsWith('/favicon') ||
    url.pathname.match(/\.(ico|png|jpg|jpeg|svg|css|js|woff2?)$/)
  ) {
    // An authenticated user has nothing to do on the auth pages — send them in.
    // Failure here (env missing / Supabase down) must not brick the public page.
    if (url.pathname === '/login' || url.pathname === '/signup') {
      try {
        const supabase = createSupabaseServerClient(cookies, request.headers);
        const { data: { user } } = await supabase.auth.getUser();
        if (user) return redirect('/dashboard');
      } catch {
        // degraded mode: render the auth page; the login attempt itself will
        // surface the real error.
      }
    }
    return next();
  }

  // Check session server-side
  const supabase = createSupabaseServerClient(cookies, request.headers);
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return redirect('/login');
  }

  return next();
});
