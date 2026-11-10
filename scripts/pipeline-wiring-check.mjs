// Garda pipeline-ului financiar — nimic „necontrolat".
// Eșuează (exit 1) dacă:
//   1. demo-ul finance.ts nu trece (logica de bani);
//   2. coloana moartă `status_plata` reapare în src/ (în afara comentariilor);
//   3. un consumator care AFIȘEAZĂ bani nu mai importă din lib/finance
//      (cineva a rupt firul pipeline-ului);
//   4. o pagină .astro reintroduce derivare locală de bani (costTotal − suma).
// Usage: node scripts/pipeline-wiring-check.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
let failures = 0;
const fail = (m) => { failures++; console.log('FAIL  ' + m); };
const ok = (m) => console.log('PASS  ' + m);

// ── 1) Logica de bani ──
const outfile = path.join(root, 'node_modules', '.cache', 'finance-wiring.mjs');
await build({ entryPoints: [path.join(root, 'src', 'lib', 'finance.ts')], outfile, bundle: true, format: 'esm', logLevel: 'silent' });
const { demo } = await import(outfile);
try { ok('finance.ts demo — ' + demo()); } catch (e) { fail(e.message); }

// ── scanare src/ ──
const srcRoot = path.join(root, 'src');
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|astro)$/.test(f)) files.push(p);
  }
})(srcRoot);
const read = (p) => fs.readFileSync(p, 'utf-8');
const rel = (p) => path.relative(root, p);
const codeOnly = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

// ── 2) status_plata interzis în cod (nu și în comentarii) ──
let spHits = 0;
for (const f of files) {
  if (codeOnly(read(f)).includes('status_plata')) { fail(`status_plata reapare în cod: ${rel(f)}`); spHits++; }
}
if (!spHits) ok('status_plata: zero apariții în cod (doar istorie în comentarii)');

// ── 3) consumatorii obligatorii — firul pipeline-ului ──
// Registrul conexiunilor: fiecare suprafață care arată bani TREBUIE să fie
// legată de finance.ts. Adaugă aici orice ecran nou care afișează bani.
const CONSUMERS = [
  { file: 'src/lib/services/patientService.ts', needs: ["from '../finance'"], what: 'sursa: applyPackageTruth + getSingleSessionsHistory + getOneTimeBatch' },
  { file: 'src/lib/services/reportsService.ts', needs: ["from '../finance'"], what: 'Plăți restante / statistici neplătitori' },
  { file: 'src/components/features/patients/PaymentSheet.astro', needs: ['lib/finance'], what: 'badge + rest + istoric (pachet)' },
  { file: 'src/components/features/patients/PatientList.astro', needs: ['are_datorii'], what: 'filtre Neachitați/Plătiți + badge' },
  { file: 'src/components/layout/Dock.astro', needs: ['are_datorii'], what: 'punct roșu pacienți' },
  { file: 'src/components/features/dashboard/AgendaBlock.astro', needs: ['lib/finance'], what: 'badge plată pe cardurile de azi' },
  { file: 'src/pages/dashboard/calendar.astro', needs: ['lib/finance'], what: 'badge plată pe cardurile din calendar' },
  { file: 'src/lib/render/sessionCard.ts', needs: ['financeBadge'], what: 'randare badge (primește starea de la caller)' },
];
for (const c of CONSUMERS) {
  const p = path.join(root, c.file);
  if (!fs.existsSync(p)) { fail(`consumator lipsă: ${c.file}`); continue; }
  const src = read(p);
  const missing = c.needs.filter((n) => !src.includes(n));
  missing.length
    ? fail(`${c.file} nu mai e legat de pipeline (lipsește: ${missing.join(', ')})`)
    : ok(`${c.file} — ${c.what}`);
}

// ── 4) interzis: derivare locală de bani în pagini ──
const BANNED = [
  { re: /costTotal\s*-\s*sumaIncasata/, desc: 'costTotal − sumaIncasata (derivare locală de rest)' },
  { re: /restDePlata\s*=\s*Math\.max\(0,\s*costTotal/, desc: 'restDePlata din costTotal (derivare locală)' },
  { re: /sumaIncasata\s*>=\s*costTotal/, desc: 'sumaIncasata >= costTotal (decizie locală de plată)' },
];
for (const f of files) {
  if (!f.endsWith('.astro')) continue; // sessionCard.ts păstrează fallback intenționat pentru cache vechi
  const src = codeOnly(read(f));
  for (const b of BANNED) {
    if (b.re.test(src)) fail(`${rel(f)}: ${b.desc}`);
  }
}
ok('pagini .astro fără derivare locală de bani');

console.log('\n== Registrul conexiunilor pipeline (cine cere ce) ==');
for (const c of CONSUMERS) console.log(`  ${c.file}\n      └─ ${c.what}`);
console.log('  src/lib/finance.ts\n      └─ UNICA derivare: computeOneTime / computePackage / computeFinancialState / badgeText');

console.log(failures === 0 ? '\nWIRING: ALL GREEN' : `\nWIRING: ${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
