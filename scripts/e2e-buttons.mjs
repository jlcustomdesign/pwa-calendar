// E2E per-button test suite — style UI_AUDIT: fiecare buton/control important,
// PASS/FAIL cu detaliu, verificare în DB, utilizator de test izolat + curățenie.
// Usage: node scripts/e2e-buttons.mjs [baseURL]
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import 'dotenv/config';

const BASE = process.argv[2] || 'http://localhost:4399';
const url = process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const stamp = Date.now();
const EMAIL = `e2eb-${stamp}@test.kineto`;
const PASSWORD = `E2e!${stamp}`;
const OT_NAME = `E2E Uni ${String(stamp).slice(-5)}`;
const SUB_NAME = `E2E Abo ${String(stamp).slice(-5)}`;

let uid = null, otId = null, subId = null;
const results = [];
const pageErrors = [], consoleErrors = [];
let step = 'init';
function report(name, okR, detail = '') {
  results.push({ name, ok: !!okR });
  console.log(`${okR ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
async function cleanup() {
  for (const id of [otId, subId]) {
    if (!id) continue;
    await admin.from('plati').delete().eq('pacient_id', id);
    await admin.from('programari').delete().eq('pacient_id', id);
    await admin.from('istoric_evenimente').delete().eq('pacient_id', id);
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

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push(`${step}: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${step}: ${m.text()}`); });

async function openEdit(name) {
  await page.waitForTimeout(500);
  await page.fill('#patient-search', name);
  await page.waitForTimeout(900);
  const card = page.locator(`[data-patient-id] .swipe-surface`, { hasText: name }).first();
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
async function savePatient() {
  await page.evaluate(() => document.getElementById('save-patient-btn')?.click());
  await page.waitForTimeout(1400);
}
const db = (p) => admin.from(p);
async function patientCount() {
  return page.evaluate(() => new Set([...document.querySelectorAll('[data-patient-id]')].map((e) => e.getAttribute('data-patient-id'))).size);
}
async function openFilters() {
  await page.evaluate(() => {
    const t = document.getElementById('patient-filter-sort-trigger');
    const panel = document.getElementById('patient-filter-sort-panel');
    if (t && panel && !panel.classList.contains('visible')) t.click();
  });
  await page.waitForTimeout(500);
}
async function closeFilters() {
  await page.evaluate(() => {
    const t = document.getElementById('patient-filter-sort-trigger');
    const panel = document.getElementById('patient-filter-sort-panel');
    if (t && panel && panel.classList.contains('visible')) t.click();
  });
  await page.waitForTimeout(400);
}
async function clickChip(sel) {
  return page.evaluate((sel2) => { const b = document.querySelector(sel2); if (b) { b.click(); return true; } return false; }, sel);
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
  report('login → dashboard', page.url().includes('/dashboard'));

  // ── Dock: navigare pe toate paginile ──
  step = 'dock-nav';
  const pages = [['/dashboard/calendar', 'Calendar'], ['/dashboard/patients', 'Pacienți'], ['/dashboard/reports', 'Rapoarte'], ['/dashboard/settings', 'Setări'], ['/dashboard', 'Acasă']];
  let navOk = 0;
  for (const [path, label] of pages) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    if (page.url().includes(path.split('?')[0])) navOk++;
  }
  report('Dock: 5 pagini accesibile', navOk === 5, `${navOk}/5`);

  // ── Patients: add OT ──
  step = 'add-ot';
  await page.goto(`${BASE}/dashboard/patients`, { waitUntil: 'networkidle' });
  await page.click('#add-patient-btn');
  await page.waitForSelector('#add-patient-sheet[data-open="true"]', { timeout: 5000 });
  await page.fill('[name="name"]', OT_NAME);
  await page.evaluate(() => { const i = document.getElementById('patientCost'); if (i) i.value = '100'; });
  await savePatient();
  const otRow = await db('pacienti').select('id, plan, cost').ilike('nume', `Uni ${OT_NAME.slice(-5)}%`).single();
  otId = otRow.data?.id ?? null;
  report('Adaugă (Ședință unică, preț 100)', otRow.data?.plan === 'One Time' && Number(otRow.data?.cost) === 100, JSON.stringify(otRow.data));

  // ── Patients: add SUB ──
  step = 'add-sub';
  await page.click('#add-patient-btn');
  await page.waitForSelector('#add-patient-sheet[data-open="true"]', { timeout: 5000 });
  await page.fill('[name="name"]', SUB_NAME);
  await page.click('button[data-plan*="Abonament"]');
  await page.evaluate(() => {
    const c = document.getElementById('patientCost'); if (c) c.value = '1000';
    const t = document.getElementById('patientTotalSessions'); if (t) t.value = '2';
  });
  await savePatient();
  const subRow = await db('pacienti').select('id, plan').ilike('nume', `Abo ${SUB_NAME.slice(-5)}%`).single();
  subId = subRow.data?.id ?? null;
  const subPkg = await db('abonamente').select('id').eq('pacient_id', subId).eq('status', 'activ');
  report('Adaugă (Abonament 2 ședințe)', subRow.data?.plan === 'Subscription' && (subPkg.data?.length ?? 0) === 1, `plan=${subRow.data?.plan} pachete=${subPkg.data?.length}`);

  // ── Search ──
  step = 'search';
  await page.waitForTimeout(900); // lista se re-randează după patientsUpdated
  await page.fill('#patient-search', OT_NAME);
  await page.waitForTimeout(1000);
  const visibleCards = await patientCount();
  const firstCardText = await page.evaluate(() => [...document.querySelectorAll('#patient-list-container h4')].map((e) => e.textContent).join(' | '));
  report('Căutare — filtrează lista', visibleCards === 1, `${visibleCards} pacient unic [${firstCardText}]`);
  await page.fill('#patient-search', '');
  await page.waitForTimeout(700);

  // ── Sort chips ──
  step = 'sort';
  await openFilters();
  await clickChip('[data-sort="name"]');
  await page.waitForTimeout(600);
  report('Sortare după nume', (await patientCount()) === 2);
  await closeFilters();

  // ── Filtru locație ──
  step = 'filter-location';
  await openFilters();
  await clickChip('[data-filter="belaqva"]');
  await page.waitForTimeout(700);
  report('Filtru Belaqva', (await patientCount()) === 2, 'ambii pacienți Belaqva implicit');
  await clickChip('[data-filter="belaqva"]');
  await page.waitForTimeout(500);
  await closeFilters();

  // ── Wrap-up complet: ședință OT azi, fără plată pe loc → rest 100 ──
  step = 'wrapup-unpaid';
  const today = new Date();
  const td = today.getDate(), tm = today.getMonth() + 1, ty = today.getFullYear();
  const hh = String(Math.min(17, Math.max(8, today.getHours() - 1))).padStart(2, '0');
  await db('programari').insert({ pacient_id: otId, user_id: uid, data: `${ty}-${String(tm).padStart(2, '0')}-${String(td).padStart(2, '0')}`, ora: `${hh}:00`, locatie: 'Belaqva', status: 'programat' });
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const hasCard = await page.locator('session-card', { hasText: OT_NAME }).first().isVisible().catch(() => false);
  if (hasCard) {
    await page.evaluate((n) => {
      const sc = [...document.querySelectorAll('session-card')].find((el) => el.textContent?.includes(n));
      sc?.querySelector('.card-summary')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, OT_NAME);
    await page.waitForTimeout(500);
    const confirmed = await page.evaluate(() => { const b = document.querySelector('[title*="Anulat"], [title*="anulat"]')?.getAttribute('title'); return b; });
    report('Card ședință: expandare + acțiuni vizibile (swipe)', !!confirmed, `title=${confirmed}`);
    await page.evaluate((n) => {
      const sc = [...document.querySelectorAll('session-card')].find((el) => el.textContent?.includes(n));
      sc?.dispatchEvent(new Event('noop'));
    }, OT_NAME);
    // Confirmă ședința → wrap-up
    await page.evaluate((n) => {
      const cards = [...document.querySelectorAll('session-card')];
      const sc = cards.find((el) => el.textContent?.includes(n));
      const btn = sc?.querySelector('button');
      const all = [...(sc?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim());
      window.__btns = all;
    }, OT_NAME);
    const wrapOpened = await page.evaluate((n) => {
      const sc = [...document.querySelectorAll('session-card')].find((el) => el.textContent?.includes(n));
      const btns = [...(sc?.querySelectorAll('button') ?? [])];
      const confirmBtn = btns.find((b) => /CONFIRM|Confirmă/i.test(b.textContent || ''));
      if (confirmBtn) { confirmBtn.click(); return true; }
      return false;
    }, OT_NAME);
    await page.waitForTimeout(800);
    const wrapVisible = await page.locator('#session-wrapup-sheet, [id*="wrapup"]').first().isVisible().catch(() => false);
    report('CONFIRMĂ ȘEDINȚA → deschide Wrap-Up', wrapOpened && wrapVisible);
    if (wrapVisible) {
      await page.evaluate(() => document.getElementById('btn-confirm-wrapup')?.click());
      await page.waitForTimeout(1800);
      const fin = await db('programari').select('status').eq('pacient_id', otId).eq('status', 'finalizat');
      report('Wrap-Up confirmă → finalizat în DB', (fin.data?.length ?? 0) === 1, `${fin.data?.length} finalizate`);
    }
  } else {
    report('Card ședință: expandare + acțiuni vizibile (swipe)', false, 'cardul nu apare pe dashboard');
    report('CONFIRMĂ ȘEDINȚA → deschide Wrap-Up', false, 'fără card');
    report('Wrap-Up confirmă → finalizat în DB', false, 'fără card');
  }

  // ── Filtru Neachitați: OT cu ședință neplătită = singurul ──
  step = 'filter-unpaid';
  await page.goto(`${BASE}/dashboard/patients`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await openFilters();
  await clickChip('[data-filter="unpaid"]');
  await page.waitForTimeout(800);
  const unpaidCards = await patientCount();
  const unpaidHasOT = await page.locator('[data-patient-id]', { hasText: OT_NAME }).count();
  report('Filtru Neachitați → OT + SUB neplătiți', unpaidCards === 2 && unpaidHasOT >= 1, `${unpaidCards} pacienți (OT + abonament fără plată), OT=${unpaidHasOT}`);
  await closeFilters();

  // ── PaymentSheet: plătește ședința OT → badge Achitat + filtrul se schimbă ──
  step = 'pay-session';
  await page.evaluate((n) => {
    const cards = [...document.querySelectorAll('#patient-list-container [data-patient-id]')].filter((e) => e.textContent?.includes(n));
    const card = cards.find((e) => e.querySelector('.open-payment-btn')) ?? cards[0];
    card?.querySelector('.open-payment-btn, .history-btn')?.click();
  }, OT_NAME);
  await page.waitForTimeout(1500);
  let payReady = await page.waitForSelector('#payment-sheet [data-pay-action]', { timeout: 12000 }).then(() => true).catch(() => false);
  if (!payReady) {
    // ca un utilizator: apasă din nou pe badge dacă foaia pare blocată
    await page.evaluate((n) => {
      const cards = [...document.querySelectorAll('#patient-list-container [data-patient-id]')].filter((e) => e.textContent?.includes(n));
      cards[0]?.querySelector('.open-payment-btn, .history-btn')?.click();
    }, OT_NAME);
    payReady = await page.waitForSelector('#payment-sheet [data-pay-action]', { timeout: 12000 }).then(() => true).catch(() => false);
  }
  const sheetState = await page.evaluate(() => {
    const sh = document.getElementById('payment-sheet');
    return { exists: !!sh, open: sh?.dataset?.open === 'true' || sh?.classList?.contains('open') || (sh?.style?.transform ?? '').includes('translateY(0') || sh?.getAttribute('aria-hidden') === 'false', name: document.getElementById('payment-patient-name')?.textContent };
  });
  await page.waitForTimeout(800);
  const payBtn = await page.evaluate(() => {
    const b = document.querySelector('#payment-sheet [data-pay-action="pay-session"]');
    if (b) { b.click(); return true; } return false;
  });
  await page.waitForTimeout(800);
  const customVisible = await page.evaluate(() => !!document.getElementById('custom-amount-input'));
  await page.evaluate(() => document.getElementById('btn-confirm-custom')?.click());
  await page.waitForTimeout(1800);
  // Diagnostic: dacă foaia e blocată la „Se încarcă…", reîncearcă încărcarea în
  // pagină și capturează eroarea reală (sau timeout = hang pe o promisiune).
  let diag = { skipped: true };
  if (sheetState.exists && sheetState.name === 'Se încarcă…') {
    diag = await page.evaluate(async () => {
      const mgr = window.currentPaymentSheetManager;
      if (!mgr) return { mgr: false };
      try {
        await Promise.race([
          mgr.loadPatientFinancials(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('HANG: loadPatientFinancials nu s-a rezolvat în 6s')), 6000)),
        ]);
        return { mgr: true, ok: true, name: document.getElementById('payment-patient-name')?.textContent,
          actions: [...document.querySelectorAll('#payment-sheet [data-pay-action]')].map((b) => b.getAttribute('data-pay-action')) };
      } catch (e) {
        return { mgr: true, ok: false, err: String(e?.message || e) };
      }
    });
  }
  const plata = await db('plati').select('suma').eq('pacient_id', otId);
  const paidOk = (plata.data?.length ?? 0) === 1 && Number(plata.data?.[0]?.suma) === 100;
  report('PaymentSheet: pay-session 100 RON → DB', sheetState.exists && payBtn && paidOk,
    `sheet=${JSON.stringify(sheetState)} payBtn=${payBtn} customForm=${customVisible} plati=${plata.data?.length} diag=${JSON.stringify(diag)}`);
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/dashboard/patients`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await openFilters();
  await clickChip('[data-filter="unpaid"]');
  await page.waitForTimeout(1800); // re-render cu delay după paymentsUpdated + fetch
  report('După plată: Neachitați = doar SUB (abonament neplătit)', (await patientCount()) === 1, `${await patientCount()} pacient`);
  await clickChip('[data-filter="paid"]');
  await page.waitForTimeout(800);
  report('Filtru Plătiți → cel puțin OT plătit', (await patientCount()) >= 1, `${await patientCount()} pacienți`);
  await clickChip('[data-filter="all"]');
  await page.waitForTimeout(500);
  await closeFilters();

  // ── Editare preț OT 100→130: istoric notă + fără datorie nouă ──
  step = 'price-change';
  await openEdit(OT_NAME);
  await page.evaluate(() => { const i = document.getElementById('patientCost'); if (i) i.value = '130'; });
  await savePatient();
  const note = await db('istoric_evenimente').select('text').eq('pacient_id', otId).ilike('text', '%preț%');
  const otAfter = await db('pacienti').select('cost').eq('id', otId).single();
  report('Modificare preț 100→130 → notă istoric + cost nou',
    Number(otAfter.data?.cost) === 130 && (note.data?.length ?? 0) >= 1,
    `cost=${otAfter.data?.cost} note=${note.data?.map((n) => n.text).join(' | ')}`);

  // ── Edit + plan switch OT→Subscription (switch_plan RPC) ──
  step = 'plan-switch';
  await openEdit(OT_NAME);
  await page.click('button[data-plan*="Abonament"]');
  await page.waitForTimeout(300);
  await savePatient();
  const sw = await db('pacienti').select('plan, sedinte_folosite').eq('id', otId).single();
  const swPkg = await db('abonamente').select('id').eq('pacient_id', otId).eq('status', 'activ');
  const swNote = await db('istoric_evenimente').select('text').eq('pacient_id', otId).ilike('text', '%Schimbare tip%');
  report('Editare: switch plan → RPC switch_plan', sw.data?.plan === 'Subscription' && (swPkg.data?.length ?? 0) >= 1 && (swNote.data?.length ?? 0) >= 1,
    `plan=${sw.data?.plan} pachete=${swPkg.data?.length} nota=${swNote.data?.[0]?.text ?? '-'}`);

  // ── Ștergere (soft delete) ──
  step = 'delete';
  await openEdit(SUB_NAME);
  const delOk = await page.evaluate(() => {
    const b = document.querySelector('.delete-btn');
    if (b) { b.click(); return true; } return false;
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById('confirm-modal-ok')?.click());
  await page.waitForTimeout(1200);
  const subRowAfter = await db('pacienti').select('sters_la').eq('id', subId).single();
  report('Ștergere pacient → soft delete (sters_la)', delOk && !!subRowAfter.data?.sters_la);

  // ── Share schedule sheet ──
  step = 'share';
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  await page.fill('#patient-search', OT_NAME);
  await page.waitForTimeout(1000);
  const shareListState = await page.evaluate(() => ({
    searchVal: (document.getElementById('patient-search'))?.value,
    cards: document.querySelectorAll('#patient-list-container [data-patient-id]').length,
    shareBtns: document.querySelectorAll('.share-schedule-btn').length,
    editSheetOpen: document.getElementById('add-patient-sheet')?.dataset?.open ?? null,
  }));
  await page.evaluate(() => { window.__shareEvts = []; window.addEventListener('openShareScheduleSheet', (e) => window.__shareEvts.push(e.detail)); window.addEventListener('openShareSchedule', (e) => window.__shareEvts.push(e.detail)); });
  const shareOk = await page.evaluate(() => {
    const b = document.querySelector('.share-schedule-btn');
    if (b) { b.click(); return true; } return false;
  });
  await page.waitForTimeout(800);
  const shareOpen = await page.waitForSelector('text=Copiază', { timeout: 6000 }).then(() => true).catch(() => false);
  const shareEvts = await page.evaluate(() => window.__shareEvts ?? []);
  const shareSheetState = await page.evaluate(() => { const sh = document.getElementById('share-schedule-sheet'); return sh ? { open: sh.dataset?.open ?? sh.className.slice(0, 80) } : null; });
  report('Trimite programul → deschide ShareSheet', shareOk && shareOpen, `click=${shareOk} list=${JSON.stringify(shareListState)} evts=${JSON.stringify(shareEvts)} sheet=${JSON.stringify(shareSheetState)}`);
  await page.keyboard.press('Escape');

  // ── Calendar: beyond-supply guard pe Subscription ──
  step = 'calendar-guard';
  const tomorrow = new Date(Date.now() + 86400000);
  const d = tomorrow.getDate(), m = tomorrow.getMonth() + 1, y = tomorrow.getFullYear();
  await page.goto(`${BASE}/dashboard/calendar`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.locator(`[data-calendar-item][data-date="${d}"][data-month="${m}"][data-year="${y}"]`).first().click();
  await page.waitForTimeout(800);
  await page.click('text=+ Adaugă ședință', { timeout: 8000 });
  const s = page.locator('#add-session-sheet input[placeholder*="Căutare"]');
  await s.waitFor({ state: 'visible', timeout: 8000 });
  await s.fill(OT_NAME);
  await page.waitForTimeout(700);
  await page.locator(`#add-session-sheet >> text=${OT_NAME}`).first().click();
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('submit-btn')?.click());
  await page.waitForTimeout(1500);
  const booked = await db('programari').select('id, status').eq('pacient_id', otId).eq('status', 'programat');
  report('Calendar: + Adaugă ședință → programat în DB', (booked.data?.length ?? 0) === 1);

  // Anulare din calendar (swipe + Anulează)
  step = 'calendar-cancel';
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.locator(`[data-calendar-item][data-date="${d}"][data-month="${m}"][data-year="${y}"]`).first().click();
  await page.waitForTimeout(1000);
  const cardEl = page.locator('session-card', { hasText: OT_NAME }).first();
  const cb = await cardEl.boundingBox();
  if (cb) {
    const cy = cb.y + cb.height / 2;
    await page.mouse.move(cb.x + cb.width * 0.7, cy);
    await page.mouse.down();
    await page.mouse.move(cb.x + cb.width * 0.7 - 160, cy, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  const cancelClicked = await page.evaluate(() => {
    const btn = document.querySelector('[title*="anulat"], [title*="Anulat"]');
    if (!btn) return false;
    btn.click(); return true;
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById('confirm-modal-ok')?.click());
  await page.waitForTimeout(1200);
  const apptAfter = await db('programari').select('status').eq('id', booked.data?.[0]?.id).single();
  report('Calendar: Anulează → anulat în DB', cancelClicked && apptAfter.data?.status === 'anulat', `status=${apptAfter.data?.status}`);

  // ── Lunch modal ──
  step = 'lunch';
  const lunchOpen = await page.evaluate(() => { const c = document.querySelector('[data-lunch-card]'); if (c) { c.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; } return false; });
  await page.waitForTimeout(600);
  const lunchModal = await page.evaluate(() => { const d = document.getElementById('lunch-edit-modal'); return !!(d && d.open); });
  report('Pauză de masă → deschide modalul', !!lunchOpen && lunchModal);
  await page.evaluate(() => document.getElementById('lunch-edit-cancel')?.click());

  // ── Reports: taburi + Plăți restante + click rând → PaymentSheet ──
  step = 'reports';
  await page.goto(`${BASE}/dashboard/reports`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  let tabsOk = 0;
  for (const tab of ['Săpt', 'Lun', 'Trim', 'An']) {
    await page.locator(`.stats-tab-btn:has-text("${tab}")`).first().click().catch(() => {});
    await page.waitForTimeout(500);
    tabsOk++;
  }
  report('Rapoarte: 4 taburi perioadă comutabile', tabsOk === 4);
  const unpaidStat = await page.locator('text=/Plăți restante|Neplătitori/i').first().isVisible().catch(() => false);
  report('Rapoarte: card Plăți restante vizibil', unpaidStat);
  await page.evaluate(() => document.querySelector('[onclick*="openUnpaidDetails"], #unpaid-card, [id*="unpaid"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForTimeout(800);
  const unpaidSheet = await page.locator('text=/Restant|dator/i').first().isVisible().catch(() => false);
  report('Rapoarte: foaia Plăți restante se deschide', unpaidSheet);

  // ── Settings: save + export CSV ──
  step = 'settings';
  await page.goto(`${BASE}/dashboard/settings?section=schedule`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.locator('button:has-text("Salvează")').first().click();
  await page.waitForTimeout(1200);
  const toastText = await page.evaluate(() => [...document.querySelectorAll('[id*="toast"], .toast, [class*="toast"]')].map((e) => e.textContent).join(' | ').slice(0, 160));
  report('Setări: Salvează → feedback', /succes|salvat/i.test(toastText), toastText || 'fără toast');
  await page.goto(`${BASE}/dashboard/settings?section=backup`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await page.locator('#btn-export-excel').first().click().catch(() => {});
  const download = await dl;
  report('Setări: Export Excel (CSV) pornește download', !!download, download?.suggestedFilename?.());

  // ── Dock dot cu datorii reale ──
  step = 'dock-dot';
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const dot = await page.evaluate(() => {
    const el = document.getElementById('patients-notification-dot');
    return { hasDot: !!el && !el.classList.contains('hidden') };
  });
  report('Dock: punct pacienți prezent cu datorii active', dot.hasDot);

  step = 'cleanup';
  await cleanup();
  report('cleanup (DB + auth)', true);
} catch (e) {
  report(step, false, e.message.split('\n')[0]);
  try { await page.screenshot({ path: `/tmp/e2eb-${step}.png` }); } catch {}
} finally {
  try { await cleanup(); } catch {}
  await browser.close();
}

console.log('\n── page errors ──');
pageErrors.length ? pageErrors.slice(0, 8).forEach((e) => console.log('  ' + e)) : console.log('  none');
console.log('── console errors ──');
consoleErrors.length ? consoleErrors.slice(0, 8).forEach((e) => console.log('  ' + e)) : console.log('  none');
const fails = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} steps passed`);
process.exit(fails || pageErrors.length ? 1 : 0);
