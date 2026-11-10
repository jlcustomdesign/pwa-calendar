// Verificare „adevăr vs filtre" pe baza de date REALĂ (doar citire).
// Pentru fiecare pacient al terapeutului, rulează codul REAL din finance.ts
// (bundled cu esbuild) cu aceeași logică de dispatch ca applyPackageTruth
// (pachetul deschis câștigă), apoi:
//   1. listează TOȚI pacienții din fiecare filtru (Neachitați / Plătiți /
//      Expirați / alerte Dock) — ca să fie verificat vizual;
//   2. recompută INDependent restanțele pe pachete direct în SQL și compară;
//   3. verifică invariantele pipeline-ului (badge paid ⇒ rest 0, fără NaN etc).
// Usage: node scripts/finance-truth-check.mjs [user_id]
import { createClient } from '@supabase/supabase-js';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'dotenv/config';

const USER_ID = process.argv[2] || 'dd3ea248-e54f-4df1-8101-8b14f782da33';
const url = process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const sb = createClient(url, key, { auth: { persistSession: false } });

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, '..', 'node_modules', '.cache', 'finance-truth.mjs');
await build({ entryPoints: [path.join(here, '..', 'src', 'lib', 'finance.ts')], outfile, bundle: true, format: 'esm', logLevel: 'silent' });
const { computeFinancialState, parseazaPreturiDinNote, isOneTimePlan, badgeText } = await import(outfile);

let failures = 0;
const fail = (msg) => { failures++; console.log('FAIL  ' + msg); };
const ok = (msg) => console.log('PASS  ' + msg);

const [{ data: pacs }, { data: pkgs }, { data: plati }, { data: appts }, { data: notes }] = await Promise.all([
  sb.from('pacienti').select('id, prenume, nume, plan, cost, achitat, sedinte_total, sedinte_folosite, status_abonament, sters_la').eq('user_id', USER_ID),
  sb.from('abonamente').select('id, pacient_id, nr_sedinte, pret, sedinte_folosite, status'),
  sb.from('plati').select('id, pacient_id, programare_id, suma, abonament_id'),
  sb.from('programari').select('id, pacient_id, data, ora, status'),
  sb.from('istoric_evenimente').select('pacient_id, text, created_at'),
]);
const patients = (pacs ?? []).filter((p) => !p.sters_la);
const openPkgBy = new Map((pkgs ?? []).filter((p) => p.status === 'activ').map((p) => [p.pacient_id, p]));
const by = (list, k) => {
  const m = new Map();
  for (const x of list ?? []) { if (!m.has(x[k])) m.set(x[k], []); m.get(x[k]).push(x); }
  return m;
};
const apptsBy = by(appts, 'pacient_id');
const platiBy = by(plati, 'pacient_id');
const notesBy = by(notes, 'pacient_id');

const rows = [];
for (const p of patients) {
  const open = openPkgBy.get(p.id);
  const myPlati = platiBy.get(p.id) ?? [];
  const st = computeFinancialState({
    plan: p.plan,
    openPackagePret: open ? Number(open.pret) : null,
    openPackagePaid: open ? (myPlati.filter((pl) => pl.abonament_id === open.id).reduce((t, x) => t + Number(x.suma || 0), 0)) : undefined,
    pacientCost: Number(p.cost) || 0,
    explicitAchitat: p.achitat === true,
    sesiuni: (apptsBy.get(p.id) ?? []).map((a) => ({ id: a.id, data: a.data, ora: a.ora, status: a.status })),
    plati: myPlati.map((x) => ({ id: x.id, programare_id: x.programare_id, suma: Number(x.suma) || 0 })),
    preturiIstoric: parseazaPreturiDinNote(notesBy.get(p.id) ?? []),
  });
  // Aceeași etichetare ca applyPackageTruth → filtre/Dock.
  const ot = isOneTimePlan(p.plan) && !open;
  const are_datorii = ot ? st.rest > 0 : st.badge.kind !== 'paid';
  const otDone = ot ? st.done : 0;
  const badge = badgeText(st);
  rows.push({ p, st, open, ot, are_datorii, otDone, badge });
}

// ── 1) Listele filtrelor — fiecare nume, verificabil vizual ──
const fmt = (r) => `${r.p.prenume} ${r.p.nume}`;
console.log('\n== Neachitați (filtru pacienți + punct Dock) — ' + rows.filter((r) => r.are_datorii).length + ' ==');
for (const r of rows.filter((r) => r.are_datorii)) {
  console.log(`  ${fmt(r)}  [${r.ot ? 'OT' : 'pachet'}] badge=${r.badge.label} rest=${r.st.rest}`);
}
console.log('\n== Plătiți (filtru) — ' + rows.filter((r) => !r.are_datorii && (r.open || r.p.achitat === true || r.otDone > 0)).length + ' ==');
for (const r of rows.filter((r) => !r.are_datorii && (r.open || r.p.achitat === true || r.otDone > 0))) {
  console.log(`  ${fmt(r)}  [${r.ot ? 'OT' : 'pachet'}] badge=${r.badge.label}`);
}
console.log('\n== Expirați (folosite >= total) — ' + rows.filter((r) => !r.ot && (r.open ? r.open.sedinte_folosite >= r.open.nr_sedinte : false)).length + ' ==');
for (const r of rows.filter((r) => !r.ot && (r.open ? r.open.sedinte_folosite >= r.open.nr_sedinte : false))) {
  console.log(`  ${fmt(r)}  ${r.open.sedinte_folosite}/${r.open.nr_sedinte}`);
}
console.log('\n== Alerte Dock (abonament terminat/ultima, nedismissat) — ' + rows.filter((r) => ['terminat', 'ultima_sedinta'].includes(r.p.status_abonament)).length + ' ==');
for (const r of rows.filter((r) => ['terminat', 'ultima_sedinta'].includes(r.p.status_abonament))) {
  console.log(`  ${fmt(r)}  status=${r.p.status_abonament}`);
}

// ── 2) Cross-check SQL independent pentru pachete: pret - SUM(plati) ──
let pkgChecked = 0;
for (const r of rows.filter((x) => x.open)) {
  const paid = (platiBy.get(r.p.id) ?? []).filter((pl) => pl.abonament_id === r.open.id).reduce((t, x) => t + Number(x.suma || 0), 0);
  const sqlRest = Math.max(0, Number(r.open.pret) - paid);
  if (r.st.badge.kind === 'paid') {
    if (r.p.achitat !== true && sqlRest > 0) fail(`${fmt(r)}: badge=Achitat dar SQL rest=${sqlRest}`);
  } else if (Math.abs(r.st.rest - sqlRest) > 0.01) {
    fail(`${fmt(r)}: pipeline rest=${r.st.rest} ≠ SQL rest=${sqlRest}`);
  }
  pkgChecked++;
}
ok(`${pkgChecked} pachete verificate contra SQL (pret − Σ plăți)`);

// Cross-check OT: sesiunile finalizate cu plată LEGATĂ trebuie să rămână acoperite
let otChecked = 0;
for (const r of rows.filter((x) => x.ot)) {
  const linkedOk = r.st.sessions.filter((s) => s.status === 'finalizat' && s.plati_ids.length > 0 && s.platit <= 0);
  if (linkedOk.length > 0) fail(`${fmt(r)}: ${linkedOk.length} sesiuni cu plată legată apar neacoperite`);
  otChecked++;
}
ok(`${otChecked} pacienți Ședință unică verificați (plățile legate nu se pierd)`);

// ── 3) Invariante pipeline ──
for (const r of rows) {
  const n = r.st;
  if (Number.isNaN(n.rest) || Number.isNaN(n.paid) || Number.isNaN(n.cost)) fail(`${fmt(r)}: NaN în stare`);
  if (n.rest < 0) fail(`${fmt(r)}: rest negativ ${n.rest}`);
  if (n.badge.kind === 'paid' && n.rest !== 0) fail(`${fmt(r)}: badge Achitat cu rest ${n.rest}`);
  if (r.ot && n.rest > 0 && n.badge.kind !== 'rest') fail(`${fmt(r)}: OT cu rest dar badge ${n.badge.kind}`);
}
ok('invariante: fără NaN, rest ≥ 0, Achitat ⇒ rest 0, OT cu rest ⇒ badge rest');

// Contradicții pe același pacient (regula Roxanei: nicio informație contradictorie)
const contrad = rows.filter((r) => r.badge.label === 'Achitat' && r.are_datorii);
contrad.length ? fail(`contradicții badge/funcție: ${contrad.map(fmt).join(', ')}`) : ok('zero contradicții badge vs filtru pe aceeași persoană');

console.log(failures === 0 ? '\nTRUTH CHECK: ALL GREEN' : `\nTRUTH CHECK: ${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
