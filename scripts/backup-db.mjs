// Full DB backup: dumps every business table to backups/db-<date>/ as JSON.
// Uses the app's own env loading; prints only table names and row counts.
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';

const url = process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Missing Supabase env vars'); process.exit(1); }

const supabase = createClient(url, key, { auth: { persistSession: false } });
const dir = `backups/db-${new Date().toISOString().slice(0, 10)}`;
mkdirSync(dir, { recursive: true });

const TABLES = ['pacienti', 'programari', 'abonamente', 'plati', 'notificari',
  'push_subscriptions', 'settings', 'profiles', 'error_logs'];

for (const t of TABLES) {
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await supabase.from(t).select('*').range(from, from + 999);
    if (error) { console.error(`FAIL ${t}: ${error.message}`); all = null; break; }
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  if (all == null) continue;
  writeFileSync(`${dir}/${t}.json`, JSON.stringify(all, null, 1));
  console.log(`OK ${t}: ${all.length} rows`);
}

console.log('done ->', dir);
