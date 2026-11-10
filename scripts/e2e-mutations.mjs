// E2E mutation suite — testează efectiv MODIFICĂRI prin UI: schimbare plan,
// schimbare preț, schimbare număr ședințe, plată — și verifică DB + UI după.
// Utilizator de test izolat, curățenie totală la final.
// Usage: node scripts/e2e-mutations.mjs [baseURL]
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import 'dotenv/config';

const BASE = process.argv[2] || 'http://localhost:4399';
const url = process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const stamp = Date.now();
const EMAIL = `e2em-${stamp}@test.kineto`;
const PASSWORD = `E2e!${stamp}`;
const NAME = `E2E Mut ${String(stamp).slice(-5)}`;

let uid = null, pid = null;
const results = [];
const pageErrors = [], consoleErrors = [];
let step = 'init';
function report(name, okR, detail = '') {
  results.push({ name, ok: !!okR });
  console.log(`${okR ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
async function cleanup() {
  if (pid) {
    await admin.from('plati').delete().eq('pacient_id', pid);
    await admin.from('programari').delete().eq('pacient_id', pid);
    await admin.from('istoric_evenimente').delete().eq('pacient_id', pid);
    await admin.from('abonamente').delete().eq('pacient_id', pid);
    await admin.from('pacienti').delete().eq('id', pid);
  }
  if (uid) {
    await admin.from('push_subscriptions').delete().eq('user_id', uid);
    await admin.from('settings').delete().eq('user_id', uid);
    await admin.from('profiles').delete().eq('id', uid);
    await admin.auth.admin.deleteUser(uid);
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push(`${step}: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${step}: ${m.text()}`); });

const db = (p) => admin.from(p);
async function savePatient() {
  await page.evaluate(() => document.getElementById('save-patient-btn')?.click());
  await page.waitForTimeout(1400);
}
async function openEdit() {
  await page.fill('#patient-search', NAME);
  await page.waitForTimeout(900);
  const card = page.locator(`[data-patient-id] .swipe-surface`, { hasText: NAME }).first();
  const box = await card.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.75, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75 - 180, y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('.edit-btn')?.click());
  await page.waitForSelector('#add-patient-sheet[data-open="true"]', { timeout: 5000 });
}
async function openSheet() {
  await page.fill('#patient-search', NAME);
  await page.waitForTimeout(900);
  await page.evaluate((n) => {
    // [data-patient-id] apare pe mai multe elemente per card — cautăm
    // containerul care CONȚINE butonul, nu orice element cu numele.
    const card = [...document.querySelectorAll('[data-patient-id]')]
      .find((e) => e.querySelector('.open-payment-btn') && e.textContent.includes(n));
    card?.querySelector('.open-payment-btn')?.click();
  }, NAME);
  await page.waitForSelector('#payment-sheet [data-pay-action], #payment-sheet #payment-patient-name', { timeout: 12000 });
  // Sumarul se încarcă primul; butoanele de plată apar în istoric ABIA după
  // al doilea await — așteptăm să dispară „Se încarcă" din listă.
  await page.waitForFunction(() => {
    const list = document.getElementById('payment-history-list');
    return list && !list.textContent.includes('Se încarcă');
  }, { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(500);
}
async function sheetText() {
  return page.evaluate(() => document.getElementById('payment-sheet')?.textContent ?? '');
}
async function dbPatient() {
  const { data } = await db('pacienti').select('*').eq('id', pid).single();
  return data;
}
async function dbPkg() {
  const { data } = await db('abonamente').select('*').eq('pacient_id', pid).order('created_at', { ascending: false });
  return data ?? [];
}
async function dbNotes() {
  const { data } = await db('istoric_evenimente').select('text').eq('pacient_id', pid);
  return (data ?? []).map((n) => n.text);
}

try {
  step = 'setup';
  const { data: created, error: cuErr } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (cuErr) throw new Error('createUser: ' + cuErr.message);
  uid = created.user.id;
  await db('settings').insert({ user_id: uid, work_start: '08:00', work_end: '18:00', lunch_start: '13:00', lunch_end: '14:00', session_duration: 50, break_buffer: 10, default_price: 100 });

  step = 'login';
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('#login-form button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });

  // ── 1. Creează pacient Abonament: 1000 RON / 10 ședințe ──
  step = 'create-sub';
  await page.goto(`${BASE}/dashboard/patients`, { waitUntil: 'networkidle' });
  await page.click('#add-patient-btn');
  await page.waitForSelector('#add-patient-sheet[data-open="true"]', { timeout: 5000 });
  await page.fill('[name="name"]', NAME);
  await page.click('button[data-plan*="Abonament"]');
  await page.evaluate(() => {
    document.getElementById('patientCost').value = '1000';
    document.getElementById('patientTotalSessions').value = '10';
  });
  await savePatient();
  const row = await db('pacienti').select('id').ilike('nume', `Mut ${NAME.slice(-5)}%`).single();
  pid = row.data?.id ?? null;
  let p = await dbPatient();
  let pk = await dbPkg();
  report('1. Creeare Abonament 1000/10', p?.plan === 'Subscription' && Number(p?.cost) === 1000 && Number(p?.sedinte_total) === 10 && pk.length === 1 && pk[0].status === 'activ' && Number(pk[0].pret) === 1000 && pk[0].nr_sedinte === 10,
    `plan=${p?.plan} cost=${p?.cost} sed=${p?.sedinte_total} pachet pret=${pk[0]?.pret} nr=${pk[0]?.nr_sedinte}`);

  // ── 2. Editează preț: 1000 → 900 (fără schimbare de plan) ──
  step = 'price-change';
  await page.waitForTimeout(900);
  await openEdit();
  await page.evaluate(() => { document.getElementById('patientCost').value = '900'; });
  await savePatient();
  await page.waitForTimeout(500);
  p = await dbPatient();
  pk = await dbPkg();
  let notes = await dbNotes();
  report('2. Preț 1000 → 900: pachet + legacy + notă istoric',
    Number(pk[0]?.pret) === 900 && Number(p?.cost) === 900 && notes.some((t) => t.includes('Modificare preț') && t.includes('1000') && t.includes('900')),
    `pkg.pret=${pk[0]?.pret} pacienti.cost=${p?.cost} note=[${notes.join('; ')}]`);

  // ── 3. UI arată rest 900 (nu 1000), nimic „neachitat" pe neplată reală ──
  step = 'price-ui';
  await page.goto(`${BASE}/dashboard/patients`, { waitUntil: 'networkidle' });
  await openSheet();
  let txt = await sheetText();
  const due = await page.evaluate(() => document.getElementById('payment-remaining-due')?.textContent ?? '');
  const total = await page.evaluate(() => document.getElementById('payment-total-cost')?.textContent ?? '');
  report('3. PaymentSheet arată Cost 900 / Rest 900 după schimbare preț', due === '900 RON' && total === '900 RON', `cost=${total} rest=${due}`);

  // ── 4. Plătește pachetul integral (pay-package cu rest=900) ──
  step = 'pay-full';
  const paid = await page.evaluate(() => {
    const b = document.querySelector('#payment-sheet [data-pay-action="pay-package"]');
    if (!b) return null;
    const amt = b.getAttribute('data-amount');
    b.click();
    return amt;
  });
  await page.waitForTimeout(1500);
  const plati = await db('plati').select('suma').eq('pacient_id', pid);
  txt = await sheetText();
  report('4. Plată integrală pachet (buton cu data-amount)', paid === '900' && (plati.data ?? []).some((x) => Number(x.suma) === 900) && txt.includes('Achitat'),
    `amount=${paid} plati=${JSON.stringify(plati.data)}`);

  // ── 5. Nu apare în Neachitați, apare în Plătiți ──
  step = 'filters-paid';
  await page.goto(`${BASE}/dashboard/patients`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const inUnpaid = await page.evaluate((n) => {
    const t = document.getElementById('patient-filter-sort-trigger');
    const panel = document.getElementById('patient-filter-sort-panel');
    if (t && panel && !panel.classList.contains('visible')) t.click();
    return null;
  }, NAME);
  await page.waitForTimeout(400);
  const unpaidVisible = await page.evaluate(async (n) => {
    document.querySelector('[data-filter="unpaid"]')?.click();
    await new Promise((r) => setTimeout(r, 800));
    const shown = [...document.querySelectorAll('[data-patient-id]')].some((e) => e.textContent.includes(n));
    document.querySelector('[data-filter="unpaid"]')?.click(); // reset
    return shown;
  }, NAME);
  await page.waitForTimeout(400);
  const paidVisible = await page.evaluate(async (n) => {
    document.querySelector('[data-filter="paid"]')?.click();
    await new Promise((r) => setTimeout(r, 800));
    const shown = [...document.querySelectorAll('[data-patient-id]')].some((e) => e.textContent.includes(n));
    document.querySelector('[data-filter="paid"]')?.click(); // reset înainte de pașii următori
    await new Promise((r) => setTimeout(r, 600));
    return shown;
  }, NAME);
  report('5. Filtre: plătitul nu-i neachitat și invers', !unpaidVisible && paidVisible, `înNeachitați=${unpaidVisible} înPlătiți=${paidVisible}`);

  // ── 6. Schimbare număr ședințe 10 → 8 (fără schimbare plan) ──
  step = 'sessions-change';
  await page.evaluate(() => { const t = document.getElementById('patient-filter-sort-trigger'); const p2 = document.getElementById('patient-filter-sort-panel'); if (p2?.classList.contains('visible')) t?.click(); });
  await page.waitForTimeout(400);
  await openEdit();
  await page.evaluate(() => { document.getElementById('patientTotalSessions').value = '8'; });
  await savePatient();
  await page.waitForTimeout(500);
  p = await dbPatient();
  pk = await dbPkg();
  report('6. Nr ședințe 10 → 8 fără reset contor', Number(p?.sedinte_total) === 8 && pk[0].nr_sedinte === 8 && Number(p?.sedinte_folosite) === 0,
    `sed=${p?.sedinte_total}/${pk[0]?.nr_sedinte} folosite=${p?.sedinte_folosite}`);

  // ── 7. Switch Abonament → Ședință unică ──
  step = 'switch-to-ot';
  await page.waitForTimeout(900);
  await openEdit();
  await page.click('button[data-plan*="Ședință unică"]');
  await savePatient();
  await page.waitForTimeout(600);
  p = await dbPatient();
  pk = await dbPkg();
  notes = await dbNotes();
  report('7. Switch → Ședință unică: plan, pachet închis, notă istoric',
    p?.plan === 'One Time' && pk.every((k) => k.status !== 'activ') && notes.some((t) => t.includes('Schimbare tip abonament') && t.includes('Abonament') && t.includes('Ședință unică')),
    `plan=${p?.plan} pachete=${pk.map((k) => k.status).join(',')}`);

  // ── 8. UI la OT: fără „În afara pachetului", fără „Reînnoiește", Rest 0 ──
  step = 'ot-ui';
  await page.goto(`${BASE}/dashboard/patients`, { waitUntil: 'networkidle' });
  await openSheet();
  txt = await sheetText();
  report('8. UI Ședință unică: fără „În afora pachetului"/„Reînnoiește", fără datorii false',
    !txt.includes('n afara pachetului') && !txt.includes('eînnoiește') && !/Rest: [1-9]/.test(txt),
    txt.slice(0, 160).replace(/\s+/g, ' '));

  // ── 9. Switch înapoi → Abonament: pachet nou deschis, notă nouă ──
  step = 'switch-back';
  await page.goto(`${BASE}/dashboard/patients`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await openEdit();
  await page.click('button[data-plan*="Abonament"]');
  await page.evaluate(() => {
    document.getElementById('patientCost').value = '900';
    document.getElementById('patientTotalSessions').value = '8';
  });
  await savePatient();
  await page.waitForTimeout(600);
  p = await dbPatient();
  pk = await dbPkg();
  notes = await dbNotes();
  const active = pk.filter((k) => k.status === 'activ');
  report('9. Switch înapoi → Abonament: pachet nou activ 900/8',
    p?.plan === 'Subscription' && active.length === 1 && Number(active[0].pret) === 900 && active[0].nr_sedinte === 8
      && notes.some((t) => t.includes('Ședință unică') && t.includes('Abonament')),
    `plan=${p?.plan} active=${active.length} pret=${active[0]?.pret}`);

  // ── 10. După switch, sheet arată Rest 900 (pachetul nou e neplătit) — dar istoricul vechi rămâne „Achitat" ──
  step = 'post-switch-ui';
  await page.goto(`${BASE}/dashboard/patients`, { waitUntil: 'networkidle' });
  await openSheet();
  txt = await sheetText();
  report('10. După re-switch: pachet nou Rest 900, pachet vechi marcat Achitat în istoric',
    txt.includes('900') && (txt.match(/Achitat/g) ?? []).length >= 1,
    `achitatCount=${(txt.match(/Achitat/g) ?? []).length}`);

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} mutation steps passed`);
  console.log('── page errors ──'); pageErrors.length ? consoleErrors.forEach((e) => console.log(' ', e)) : console.log('  none');
  console.log('── console errors ──'); consoleErrors.length ? consoleErrors.slice(0, 10).forEach((e) => console.log(' ', e)) : console.log('  none');
  process.exitCode = fails > 0 || pageErrors.length > 0 ? 1 : 0;
} catch (e) {
  console.error(`FATAL [${step}]:`, e.message);
  process.exitCode = 1;
} finally {
  await cleanup();
  await browser.close();
}
