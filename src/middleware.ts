import { defineMiddleware } from 'astro:middleware';
import { createSupabaseServerClient } from './lib/supabaseServer';
import { rateLimit } from './utils/rateLimit';

const PUBLIC_ROUTES = ['/login', '/signup', '/api/auth'];

export const onRequest = defineMiddleware(async (context, next) => {
  const { url, cookies, redirect, request } = context;

  // Rate limit sensitive surfaces: API routes and the login page (login posts go
  // to Supabase GoTrue, which has its own per-IP limits; this covers our surface).
  if (url.pathname.startsWith('/api/') || url.pathname === '/login') {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
    const isApi = url.pathname.startsWith('/api/');
    const { allowed, retryAfterSec } = rateLimit(
      `${isApi ? 'api' : 'login'}:${ip}`,
      isApi ? 60 : 10,
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
