// Group UI check: test user + 3 patients, one group session today (past hour),
// screenshots the calendar group card. Usage: node scripts/group-ui-check.mjs [baseURL]
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import 'dotenv/config';

const BASE = process.argv[2] || 'http://localhost:4399';
const url = process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const admin = createClient(url, key, { auth: { persistSession: false } });

const stamp = Date.now();
const EMAIL = `e2e-grp-${stamp}@test.kineto`;
const PASSWORD = `E2e!${stamp}`;

let uid = null;
const patientIds = [];
const apptIds = [];
async function cleanup() {
  for (const id of apptIds) await admin.from('programari').delete().eq('id', id);
  for (const id of patientIds) {
    await admin.from('plati').delete().eq('pacient_id', id);
    await admin.from('abonamente').delete().eq('pacient_id', id);
    await admin.from('pacienti').delete().eq('id', id);
  }
  if (uid) {
    await admin.from('push_subscriptions').delete().eq('user_id', uid);
    await admin.from('settings').delete().eq('user_id', uid);
    await admin.from('profiles').delete().eq('id', uid);
    await admin.auth.admin.deleteUser(uid);
  }
}

const { data: u, error: ue } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
if (ue) { console.error(ue.message); process.exit(1); }
uid = u.user.id;
await admin.from('settings').insert({ user_id: uid, session_duration: 50, lunch_start: '12:00', lunch_end: '12:30' });

const names = ['Andrei Popescu', 'Maria Ionescu', 'Vlad Enache'];
for (const n of names) {
  const [prenume, nume] = n.split(' ');
  const { data: p } = await admin.from('pacienti').insert({ user_id: uid, prenume, nume, telefon: '0700000000', plan: 'Abonament', sedinte_total: 10, sedinte_folosite: 3, cost: 400 }).select().single();
  patientIds.push(p.id);
}

const today = new Date();
const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
// ora în trecut (ședință terminată, dar neconfirmată) — ex. acum 2h
const h = new Date(Date.now() - 2 * 3600e3);
const ora = `${String(h.getHours()).padStart(2, '0')}:${String(Math.floor(h.getMinutes() / 5) * 5).padStart(2, '0')}:00`;
const groupId = crypto.randomUUID();
for (const pid of patientIds) {
  const { data: a } = await admin.from('programari').insert({ user_id: uid, pacient_id: pid, data: todayStr, ora, group_id: groupId, status: 'programat' }).select().single();
  apptIds.push(a.id);
}
console.log('seeded group of', patientIds.length, 'at', todayStr, ora);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`);
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard/, { timeout: 20000 });
await page.goto(`${BASE}/dashboard/calendar`);
await page.waitForTimeout(4000);
await page.screenshot({ path: '/tmp/group-card-collapsed.png' });

// apasă pe cardul de grup (expandare)
const card = page.locator('text=Grup').first();
if (await card.count()) {
  await card.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/group-card-expanded.png' });
}
await browser.close();
console.log('screenshots: /tmp/group-card-collapsed.png, /tmp/group-card-expanded.png');
await cleanup();
console.log('cleanup done');
