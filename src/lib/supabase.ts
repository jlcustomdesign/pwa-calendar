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
