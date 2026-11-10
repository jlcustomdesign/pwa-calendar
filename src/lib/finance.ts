// ── Derivarea financiară unică (READ PIPELINE) ─────────────────
// Singurul loc din aplicație unde se decide „cât se datorează" și „e plătit?".
// Ecranele doar redau starea returnată aici; nu calculează bani local.
// Scrieri → RPC → eveniment {patientId} → recompută DOAR pacientul afectat.

export interface RawPlata {
  id: string;
  programare_id: string | null;
  suma: number;
}

export interface RawSesiune {
  id: string;
  data: string;
  ora?: string;
  status: string;
}

export interface FinanceSesiune {
  programare_id: string;
  data: string;
  ora: string;
  status: string;
  platit: number;
  plati_ids: string[];
  poolPaid: boolean;
}

export type FinanceBadgeKind = 'paid' | 'rest' | 'none' | 'package-partial' | 'package-unpaid';

export interface FinanceState {
  isOneTime: boolean;
  cost: number;        // prețul curent (pachet deschis.pret sau pacienti.cost); 0 = nesetat
  paid: number;        // Σ plăți relevante (pachet deschis / toate timpul pentru Ședință unică)
  done: number;        // ședințe finalizate (doar Ședință unică; 0 pentru pachete)
  paidCnt: number;     // ședințe finalizate acoperite de bani (doar Ședință unică)
  rest: number;        // cât se datorează ACUM; 0 pentru cine e plătit
  badge: {
    kind: FinanceBadgeKind;
    rest: number;      // pentru kind 'rest'
    partialPaid: number; // pentru kind 'package-partial'
  };
  sessions: FinanceSesiune[]; // istoric sesiuni (doar Ședință unică)
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Acoperirea cu bani, cel mai vechi primul. Banii nelegați de o ședință
// (legacy / pachet vechi / plătit înainte de finalizare) se alocă display-only
// primelor ședințe finalizate neacoperite, câte min(preț, pool) fiecare.
// NU scrie în DB — alocarea e doar pentru afișaj.
// Linie temporală de preț: reconstruită din notele "Modificare preț ședință"
// din istoric_evenimente (scrie doar RPC-ul update_package_price, format stabil).
// Fără ea, toate sesiunile se alocă la prețul curent.
export interface PretIstoric {
  data: string; // created_at (YYYY-MM-DD e suficient pentru comparație lexicografică)
  pret: number; // prețul DIN notă (valoarea "către")
}

export function pretLaData(dataSesiune: string, preturi: PretIstoric[], fallback: number): number {
  let p = fallback;
  for (const ch of preturi) {
    if (ch.data <= dataSesiune) p = ch.pret;
    else break;
  }
  return p;
}

// Parsează notele scrise de RPC-ul update_package_price
// ("Modificare preț ședință: X → Y RON") în linie temporală de preț.
export function parseazaPreturiDinNote(notes: { text: string; created_at: string }[]): PretIstoric[] {
  const out: PretIstoric[] = [];
  for (const n of notes ?? []) {
    const m = /Modificare pre[țt] (?:ședință|sedinta):\s*([\d.,]+)\s*→\s*([\d.,]+)/.exec(n.text || '');
    if (!m) continue;
    const pret = parseFloat(m[2].replace(',', '.'));
    if (!isNaN(pret)) out.push({ data: String(n.created_at).slice(0, 10), pret });
  }
  return out.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
}

export function acoperaSesiuni(
  sesiuni: RawSesiune[],
  plati: RawPlata[],
  cost: number,
  preturi: PretIstoric[] = []
): FinanceSesiune[] {
  const linked = new Map<string, { total: number; ids: string[] }>();
  let totalPlati = 0;
  for (const pl of plati) {
    totalPlati += Number(pl.suma) || 0;
    if (pl.programare_id) {
      const cur = linked.get(pl.programare_id) || { total: 0, ids: [] };
      cur.total += Number(pl.suma) || 0;
      cur.ids.push(pl.id);
      linked.set(pl.programare_id, cur);
    }
  }
  const rows: FinanceSesiune[] = sesiuni
    .filter((a) => a.status !== 'anulat')
    .map((a) => ({
      programare_id: a.id,
      data: a.data,
      ora: a.ora || '',
      status: a.status || 'programat',
      platit: linked.get(a.id)?.total || 0,
      plati_ids: linked.get(a.id)?.ids || [],
      poolPaid: false,
    }))
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));

  let pool = totalPlati - rows.reduce((t, r) => t + r.platit, 0);
  for (const r of rows) {
    if (r.status !== 'finalizat' || r.platit > 0 || pool <= 0) continue;
    // Acoperire la prețul valabil la data ședinței — istoricul plătit nu se
    // reprețuiește niciodată la schimbarea prețului curent.
    const pret = preturi.length > 0 ? pretLaData(r.data, preturi, cost) : cost;
    if (pret <= 0) continue;
    const use = Math.min(pret, pool);
    r.platit = use;
    r.poolPaid = true;
    pool -= use;
  }
  return rows;
}

// Starea financiară pentru Ședință unică: sesiunile plătite rămân blocate la
// suma lor pentru totdeauna; schimbarea prețului atinge DOAR sesiunile
// neplătite (rest = neacoperite × prețul curent).
export function computeOneTime(
  sesiuni: RawSesiune[],
  plati: RawPlata[],
  cost: number,
  preturi: PretIstoric[] = []
): FinanceState {
  const sessions = acoperaSesiuni(sesiuni, plati, cost, preturi);
  const done = sessions.filter((s) => s.status === 'finalizat').length;
  const paidCnt = sessions.filter((s) => s.status === 'finalizat' && s.platit > 0).length;
  const rest = cost > 0 ? (done - paidCnt) * cost : 0;
  return {
    isOneTime: true,
    cost,
    paid: round2(plati.reduce((t, p) => t + (Number(p.suma) || 0), 0)),
    done,
    paidCnt,
    rest: round2(rest),
    badge:
      done === 0
        ? { kind: 'none', rest: 0, partialPaid: 0 }
        : rest <= 0
          ? { kind: 'paid', rest: 0, partialPaid: 0 }
          : { kind: 'rest', rest: round2(rest), partialPaid: 0 },
    sessions,
  };
}

// Starea financiară pentru pachet (abonament): rest = max(0, pret − Σ plăți
// ale pachetului deschis). Flag-ul explicit „achitat" rămâne valabil chiar dacă
// plățile nu acoperă încă prețul (decizie veche, păstrată).
export function computePackage(
  pret: number,
  paid: number,
  explicitAchitat: boolean
): FinanceState {
  const rest = Math.max(0, (Number(pret) || 0) - (Number(paid) || 0));
  const isPaid = explicitAchitat === true || (pret > 0 && paid >= pret);
  return {
    isOneTime: false,
    cost: Number(pret) || 0,
    paid: round2(paid),
    done: 0,
    paidCnt: 0,
    rest: isPaid ? 0 : round2(rest),
    badge: isPaid
      ? { kind: 'paid', rest: 0, partialPaid: 0 }
      : paid > 0
        ? { kind: 'package-partial', rest: round2(rest), partialPaid: round2(paid) }
        : { kind: 'package-unpaid', rest: round2(rest), partialPaid: 0 },
    sessions: [],
  };
}

// Eticheta canonică de badge — aceeași pe card, listă, dock și statistici.
export function badgeText(st: FinanceState): { label: string; badgeClass: string } {
  const AMBER = 'bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-200/60 font-black shadow-sm';
  switch (st.badge.kind) {
    case 'paid':
      return { label: 'Achitat', badgeClass: 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-transparent font-extrabold shadow-sm' };
    case 'rest':
      return { label: `Rest: ${st.badge.rest} RON`, badgeClass: AMBER };
    case 'package-partial':
      return { label: `${st.badge.partialPaid}/${st.cost} RON`, badgeClass: AMBER };
    case 'none':
      return { label: 'Fără ședințe', badgeClass: 'bg-slate-100 text-slate-600 border border-slate-200 font-bold shadow-sm' };
    default:
      return { label: 'Neachitat', badgeClass: 'bg-rose-50 hover:bg-rose-100 text-rose-700 border border-transparent font-extrabold shadow-sm' };
  }
}

// Dispatcher: decide planul după pachet deschis + plan normalizat.
export function computeFinancialState(input: {
  plan: string;
  openPackagePret?: number | null;
  pacientCost?: number | null;
  explicitAchitat?: boolean;
  sesiuni?: RawSesiune[];
  plati?: RawPlata[]; // pentru One Time: TOATE plățile pacientului
  preturiIstoric?: PretIstoric[]; // pentru One Time: linie temporală de preț din istoric_evenimente
  openPackagePaid?: number; // pentru pachet: Σ plăți legate de pachetul deschis
}): FinanceState {
  const plan = String(input.plan || '');
  const isOneTime = /sedinta|unica|one/i.test(plan.normalize('NFD').replace(/[\u0300-\u036f]/g, '')) || !input.openPackagePret;
  if (isOneTime) {
    return computeOneTime(
      input.sesiuni ?? [],
      input.plati ?? [],
      Number(input.openPackagePret ?? input.pacientCost) || 0,
      input.preturiIstoric ?? []
    );
  }
  return computePackage(Number(input.openPackagePret) || 0, Number(input.openPackagePaid) || 0, input.explicitAchitat === true);
}

// ── Auto-verificare (scripts/finance-check.mjs) ───────────────
// Cazul Matthias ca reper: 7 finalizate, 700 RON plătiți, preț 100 → 110.
// Indiferent de preț, tot ce e acoperit de bani rămâne plătit; rest doar pe
// sesiunile fără bani, la prețul curent.
export function demo(): string {
  const mk = (id: string, data: string, status = 'finalizat'): RawSesiune => ({ id, data, status });
  const sesiuni = [
    mk('s1', '2026-09-01'), mk('s2', '2026-09-08'), mk('s3', '2026-09-15'),
    mk('s4', '2026-09-22'), mk('s5', '2026-09-29'), mk('s6', '2026-10-06'),
    mk('s7', '2026-10-13'),
  ];
  const plati: RawPlata[] = [{ id: 'p1', programare_id: null, suma: 700 }];
  // Istoricul de preț așa cum îl scrie RPC-ul: 100 până pe 2026-10-31, apoi 110.
  const preturi = [
    { data: '2026-09-01', pret: 100 },
    { data: '2026-11-01', pret: 110 },
  ];
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error('FINANCE DEMO FAILED: ' + msg);
  };

  // Preț 100: 700 acoperă toate cele 7 → rest 0.
  let st = computeOneTime(sesiuni, plati, 100);
  assert(st.rest === 0 && st.badge.kind === 'paid', `preț 100: rest ${st.rest}, badge ${st.badge.kind}`);

  // Cu istoric: sesiunile din sept–oct se acoperă la 100 (prețul lor), 700 ajunge.
  st = computeOneTime(sesiuni, plati, 110, preturi);
  assert(st.rest === 0 && st.badge.kind === 'paid' && st.paidCnt === 7, `preț 110 cu istoric: rest ${st.rest}, paidCnt ${st.paidCnt}`);

  // Schimbare de preț NU reprețuiește istoricul plătit: curent 130, sesiunile
  // vechi la 100 → rest 0, nu 7 × diferență.
  st = computeOneTime(sesiuni, plati, 130, preturi);
  assert(st.rest === 0 && st.badge.kind === 'paid', `preț 130 istoric plătit: rest ${st.rest}`);

  // 8 sesiuni finalizate, tot 700 bani → a 8-a neacoperită → rest = 1 × 130.
  st = computeOneTime([...sesiuni, mk('s8', '2026-11-10')], plati, 130, preturi);
  assert(st.rest === 130 && st.paidCnt === 7, `a 8-a: rest ${st.rest}, paidCnt ${st.paidCnt}`);

  // Pachet: pret 1000, plătit 600 → rest 400 parțial; la 1000 plătit → paid.
  let pk = computePackage(1000, 600, false);
  assert(pk.badge.kind === 'package-partial' && pk.rest === 400, `pachet parțial: ${pk.badge.kind} rest ${pk.rest}`);
  pk = computePackage(1000, 1000, false);
  assert(pk.badge.kind === 'paid' && pk.rest === 0, `pachet plătit: ${pk.badge.kind}`);
  // Flag explicit achitat rămâne valabil.
  pk = computePackage(1000, 600, true);
  assert(pk.badge.kind === 'paid', `flag explicit: ${pk.badge.kind}`);

  return 'finance demo OK';
}
