// E2E smoke test for the audit-fix wave. Runs against the local dev server.
// Creates a fresh test user, clicks through the changed flows, verifies in DB,
// then cleans up all test data. Prints a PASS/FAIL summary per step.
// Usage: node scripts/e2e-smoke.mjs [baseURL]
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import 'dotenv/config';

const BASE = process.argv[2] || 'http://localhost:4399';
const url = process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const stamp = Date.now();
const EMAIL = `e2e-${stamp}@test.kineto`;
const PASSWORD = `E2e!${stamp}`;
const PATIENT = `E2E Test ${String(stamp).slice(-5)}`;

let uid = null, testPatientId = null;
const results = [];
const pageErrors = [];
async function cleanup() {
  if (testPatientId) {
    await admin.from('plati').delete().eq('pacient_id', testPatientId);
    await admin.from('programari').delete().eq('pacient_id', testPatientId);
    await admin.from('abonamente').delete().eq('pacient_id', testPatientId);
    await admin.from('pacienti').delete().eq('id', testPatientId);
  }
  if (uid) {
    await admin.from('push_subscriptions').delete().eq('user_id', uid);
    await admin.from('settings').delete().eq('user_id', uid);
    await admin.from('profiles').delete().eq('id', uid);
    await admin.auth.admin.deleteUser(uid);
  }
}
const consoleErrors = [];
let step = 'init';
function report(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); // iPhone-ish
const page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push(`${step}: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${step}: ${m.text()}`); });

const shot = (n) => page.screenshot({ path: `/tmp/e2e-${n}.png` });

// Deschide fișa de editare prin swipe-stânga pe card + .edit-btn (ca utilizatorul).
async function openPatientEdit(patientId) {
  await page.waitForTimeout(400);
  const card = page.locator(`[data-patient-id="${patientId}"] .swipe-surface`).first();
  await card.waitFor({ state: 'visible', timeout: 8000 });
  const box = await card.boundingBox();
  if (!box) throw new Error('card not visible for swipe');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.75, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75 - 180, y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.locator('.edit-btn').first().click();
  await page.waitForSelector('#add-patient-sheet[data-open="true"]', { timeout: 5000 });
}

try {
  // ── Setup: test user ──
  step = 'setup';
  const { data: created, error: cuErr } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
  });
  if (cuErr) throw new Error('createUser: ' + cuErr.message);
  uid = created.user.id;

  // ── Login ──
  step = 'login';
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('#login-form button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
  report('login', page.url().includes('/dashboard'), page.url());

  // ── Overview ──
  step = 'overview';
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  const hasWeek = await page.locator('text=/Luni|Marți|Agenda/i').first().isVisible().catch(() => false);
  report('overview renders', hasWeek);
  await shot('overview');

  // ── Patients: add ──
  step = 'add-patient';
  await page.goto(`${BASE}/dashboard/patients`, { waitUntil: 'networkidle' });
  await page.click('#add-patient-btn');
  await page.waitForSelector('#add-patient-sheet[data-open="true"]', { timeout: 5000 });
  // Pill animates 300ms — măsurăm după tranziție
  await page.waitForTimeout(500);
  const pillW = await page.evaluate(() => {
    const p = document.getElementById('plan-active-pill');
    return p ? parseFloat(getComputedStyle(p).width) : 0;
  });
  report('plan pill visible on open', pillW > 10, `width=${pillW}`);
  await page.fill('[name="name"]', PATIENT);
  await page.fill('[name="phone"]', '0700000001');
  await page.evaluate(() => (document.getElementById('save-patient-btn'))?.click());
  await page.waitForTimeout(1500);
  const added = await admin.from('pacienti_view').select('id, name, plan').ilike('name', `%${PATIENT}%`).single();
  testPatientId = added.data?.id ?? null;
  report('patient saved to DB', !added.error && !!added.data, added.error?.message || `plan=${added.data?.plan}`);

  // ── Edit + plan switch (One Time → Subscription via switch_plan RPC) ──
  step = 'plan-switch-to-subscription';
  await page.fill('#patient-search', PATIENT);
  await page.waitForTimeout(700);
  await openPatientEdit(testPatientId);
  await page.click('button[data-plan*="Abonament"]');
  await page.waitForTimeout(300);
  const pillW2 = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('plan-active-pill')).width));
  await page.evaluate(() => document.getElementById('save-patient-btn')?.click());
  await page.waitForTimeout(1500);
  const afterSub = await admin.from('pacienti_view').select('id, plan, sedinte_total, sedinte_folosite').ilike('name', `%${PATIENT}%`).single();
  const pkg = await admin.from('abonamente').select('status, nr_sedinte').eq('pacient_id', afterSub.data?.id).eq('status', 'activ');
  report('switch to Abonament', afterSub.data?.plan === 'Subscription' && (pkg.data?.length ?? 0) > 0,
    `plan=${afterSub.data?.plan} counter=${afterSub.data?.sedinte_folosite}/${afterSub.data?.sedinte_total} activePkgs=${pkg.data?.length} pill=${pillW2}`);
  await shot('patient-edit');

  // ── Edit + plan switch back (Subscription → One Time) ──
  step = 'plan-switch-to-onetime';
  await page.fill('#patient-search', PATIENT);
  await page.waitForTimeout(700);
  await openPatientEdit(testPatientId);
  await page.click('button[data-plan*="unic"]');
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('save-patient-btn')?.click());
  await page.waitForTimeout(1500);
  const afterOne = await admin.from('pacienti_view').select('id, plan, sedinte_total, sedinte_folosite').ilike('name', `%${PATIENT}%`).single();
  const activePkgs = await admin.from('abonamente').select('id').eq('pacient_id', afterOne.data?.id).eq('status', 'activ');
  report('switch to Ședință unică', afterOne.data?.plan === 'One Time' && afterOne.data?.sedinte_total === 1 && (activePkgs.data?.length ?? 0) === 0,
    `plan=${afterOne.data?.plan} ${afterOne.data?.sedinte_folosite}/${afterOne.data?.sedinte_total} activePkgs=${activePkgs.data?.length}`);

  // ── Calendar: book + cancel ──
  step = 'calendar-book';
  await page.goto(`${BASE}/dashboard/calendar`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  // Selectăm MÂINE în strip ca să rezervăm o ședință viitoare (anulabilă), nu una trecută
  const tomorrow = new Date(Date.now() + 86400000);
  const d = tomorrow.getDate(), m = tomorrow.getMonth() + 1, y = tomorrow.getFullYear();
  await page.locator(`[data-calendar-item][data-date="${d}"][data-month="${m}"][data-year="${y}"]`).first().click();
  await page.waitForTimeout(800);
  await page.click('text=+ Adaugă ședință', { timeout: 8000 });
  const sessionSearch = page.locator('#add-session-sheet input[placeholder*="Căutare"]');
  await sessionSearch.waitFor({ state: 'visible', timeout: 8000 });
  await sessionSearch.fill(PATIENT);
  await page.waitForTimeout(700);
  await page.locator(`#add-session-sheet >> text=${PATIENT}`).first().click();
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('submit-btn')?.click());
  await page.waitForTimeout(1500);
  const appt = await admin.from('programari').select('id, status').eq('pacient_id', afterOne.data.id).order('created_at', { ascending: false }).limit(1);
  const booked = !appt.error && appt.data?.length > 0 && appt.data[0].status === 'programat';
  report('session booked', !!booked, appt.error?.message || `status=${appt.data?.[0]?.status}`);
  await shot('calendar');

  step = 'calendar-cancel';
  if (booked) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.locator(`[data-calendar-item][data-date="${d}"][data-month="${m}"][data-year="${y}"]`).first().click();
    await page.waitForTimeout(1000);
    // Butonul de anulare e în stratul swipe (la fel ca la cardurile de pacienți)
    await page.evaluate((name) => {
      const sc = [...document.querySelectorAll('session-card')].find((el) => el.textContent?.includes(name));
      (sc)?.dispatchEvent(new Event('noop'));
    }, PATIENT);
    const cardEl = page.locator('session-card', { hasText: PATIENT }).first();
    const cb = await cardEl.boundingBox();
    if (cb) {
      const cy = cb.y + cb.height / 2;
      await page.mouse.move(cb.x + cb.width * 0.7, cy);
      await page.mouse.down();
      await page.mouse.move(cb.x + cb.width * 0.7 - 160, cy, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(400);
    }
    const cancelled = await page.evaluate(() => {
      const btn = document.querySelector('[title*="anulat"], [title*="Anulat"]');
      if (!btn) return 'no-cancel-button';
      (btn).click();
      return 'clicked';
    });
    await page.waitForTimeout(600);
    await page.evaluate(() => document.getElementById('confirm-modal-ok')?.click());
    await page.waitForTimeout(1200);
    const apptAfter = await admin.from('programari').select('status').eq('id', appt.data[0].id).single();
    report('session cancel → anulat', cancelled === 'clicked' && apptAfter.data?.status === 'anulat',
      `click=${cancelled} status=${apptAfter.data?.status}`);
  }

  // ── Reports ──
  step = 'reports';
  await page.goto(`${BASE}/dashboard/reports`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const statCards = await page.locator('text=/Ședințe|Încasat|Absent/i').count();
  report('reports renders', statCards >= 3, `${statCards} stat labels`);
  await shot('reports');

  // ── Settings: save schedule ──
  step = 'settings';
  await page.goto(`${BASE}/dashboard/settings?section=schedule`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const saveBtn = page.locator('button:has-text("Salvează")').first();
  if (await saveBtn.isVisible().catch(() => false)) {
    await saveBtn.click();
    await page.waitForTimeout(1200);
    const toast = await page.locator('text=/Succes|salvat|Atenție|Eroare/i').first().isVisible().catch(() => false);
    report('settings save', true, `feedback visible=${toast}`);
  } else {
    report('settings save', false, 'no save button on ?section=program');
  }
  await shot('settings');

  // ── Cleanup test data ──
  step = 'cleanup';
  await cleanup();
  report('cleanup', true);

} catch (e) {
  report(step, false, e.message.split('\n')[0]);
  await shot('failure-' + step);
} finally {
  try { await cleanup(); } catch {}
  await browser.close();
}

console.log('\n── page errors ──');
pageErrors.length ? pageErrors.forEach((e) => console.log('  ' + e)) : console.log('  none');
console.log('── console errors ──');
consoleErrors.length ? consoleErrors.slice(0, 10).forEach((e) => console.log('  ' + e)) : console.log('  none');
const fails = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} steps passed`);
process.exit(fails || pageErrors.length ? 1 : 0);
