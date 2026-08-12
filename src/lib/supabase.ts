/**
 * supabase.ts — Client singleton Supabase
 * Importă din orice componentă sau serviciu:
 *   import { supabase } from '../lib/supabase';
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

const supabaseUrl  = import.meta.env.PUBLIC_SUPABASE_URL;
const supabaseKey  = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('❌ Lipsesc variabilele de mediu Supabase. Verifică fișierul .env');
}

export const supabase = createClient<Database>(supabaseUrl, supabaseKey);

// ── Global fetch interceptor: redirect to login on auth failures ──
if (typeof window !== 'undefined') {
  const originalFetch = window.fetch;
  let redirecting = false;

  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;

    if (
      !redirecting &&
      url.includes(supabaseUrl) &&
      (response.status === 401 || response.status === 406)
    ) {
      redirecting = true;
      try {
        await supabase.auth.signOut();
      } catch {
        // ignore signOut errors
      }
      window.location.href = '/login';
    }

    return response;
  };
}
