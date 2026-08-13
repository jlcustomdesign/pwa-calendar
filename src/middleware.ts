import { defineMiddleware } from 'astro:middleware';

const PUBLIC_ROUTES = ['/login', '/signup', '/api/auth'];
const DASHBOARD_ROUTES = ['/dashboard'];

function hasSupabaseAuthCookie(cookies: any): boolean {
  // @supabase/ssr stores session cookies with names like sb-<ref>-auth-token.
  // Be permissive: any cookie that looks like it came from Supabase auth.
  const allCookies = cookies.headers?.get?.('cookie') || '';
  return /sb-[^=]+-auth-token/.test(allCookies) || allCookies.includes('sb-access-token') || allCookies.includes('sb-refresh-token');
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { url, cookies, redirect, request } = context;

  // Allow public routes and static assets
  if (
    PUBLIC_ROUTES.some(route => url.pathname.startsWith(route)) ||
    url.pathname.startsWith('/_astro/') ||
    url.pathname.startsWith('/favicon') ||
    url.pathname.match(/\.(ico|png|jpg|jpeg|svg|css|js|woff2?)$/)
  ) {
    return next();
  }

  // For dashboard pages, do a fast cookie check only. The real session
  // validation happens client-side in DashboardLayout. This keeps prerendered
  // pages fast while still blocking users with no session cookie.
  const isDashboard = DASHBOARD_ROUTES.some(route => url.pathname.startsWith(route));
  if (isDashboard) {
    if (!hasSupabaseAuthCookie(cookies)) {
      return redirect('/login');
    }
    return next();
  }

  // For non-dashboard protected routes, keep full server-side validation
  const { createSupabaseServerClient } = await import('./lib/supabaseServer');
  const supabase = createSupabaseServerClient(cookies, request.headers);
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return redirect('/login');
  }

  return next();
});
