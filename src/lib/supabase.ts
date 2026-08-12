/**
 * supabase.ts — Browser client singleton (SSR-safe import)
 * Folosit în componentele client-side (.astro <script>, service files imported client-side).
 */
import { createBrowserClient } from '@supabase/ssr';
import type { Database } from './database.types';
import { captureFetchError } from './errorLogger';

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

    return response;
  };
}
