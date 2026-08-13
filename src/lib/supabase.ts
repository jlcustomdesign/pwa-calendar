/**
 * supabase.ts — Browser client singleton (SSR-safe import)
 * Folosit în componentele client-side (.astro <script>, service files imported client-side).
 */
import { createBrowserClient } from '@supabase/ssr';
import type { Database } from './database.types';
import { captureFetchError } from './errorLogger';

// Polyfill WebSocket pentru Node.js < 22 (Astro dev server / SSR).
// @supabase/realtime-js are nevoie de WebSocket global; în Node 20 lipsește.
if (typeof globalThis !== 'undefined' && typeof (globalThis as any).WebSocket === 'undefined' && typeof window === 'undefined') {
  try {
    const wsModule = await import('ws');
    const WS = (wsModule as any).default || (wsModule as any).WebSocket || wsModule;
    (globalThis as any).WebSocket = WS;
  } catch {
    // ignore — vor fi erori doar dacă se încearcă realtime pe server
  }
}

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
const supabaseKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('❌ Lipsesc variabilele de mediu Supabase. Verifică fișierul .env');
}

export const supabase = createBrowserClient<Database>(supabaseUrl, supabaseKey);

// ── Global fetch interceptor: log Supabase errors for the logs page ──
// Nu mai facem redirect automat aici — redirectul pe logout este gestionat
// prin supabase.auth.onAuthStateChange în DashboardLayout. Interceptorul doar
// capturează erorile 401/406 fără a deconecta utilizatorul.
if (typeof window !== 'undefined') {
  const originalFetch = window.fetch;

  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;

    if (url.includes(supabaseUrl) && (response.status === 401 || response.status === 406)) {
      try {
        const responseClone = response.clone();
        const responseText = await responseClone.text();
        captureFetchError(url, response.status, responseText.slice(0, 1000));
      } catch {
        captureFetchError(url, response.status);
      }
    }

    // If the server redirects a dashboard page to /login, follow it immediately
    // so the user is not left on a broken page after the session expires.
    if (!url.includes(supabaseUrl) && response.status === 302) {
      const location = response.headers.get('location');
      if (location && (location === '/login' || location.startsWith('/login'))) {
        window.location.href = '/login';
      }
    }

    return response;
  };
}
