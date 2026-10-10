/**
 * patientService.ts — CRUD pacienti Supabase
 * Folosit în: PatientList.astro, AddPatientSheet.astro, PaymentSheet.astro
 */
import { supabase, getCurrentUser } from '../supabase';
import type { PacientInsert, PacientUpdate, PacientView } from '../database.types';
import { toLocalISOString } from '../../utils/date';
import { EVENTS, emit } from '../events';

// ── Listare pacienți (cu filtru opțional și verificare inactivitate 30 zile) ─────────────────────
// Sweep-ul de inactivare rulează o singură dată pe sesiune de pagină — nu la fiecare
// citire. Interogarea principală de mai jos (pacienti_view) rulează de fiecare dată.
let inactivitySweepDone = false;

export async function getPatients(filter?: {
  locatie?: 'Belaqva' | 'Ghimbav';
  achitat?: boolean;
  search?: string;
  inactivi?: boolean;
}): Promise<PacientView[]> {
  // 1. Verificăm și marcăm pacienții neprogramați de peste 30 de zile ca inactivi
  if (!inactivitySweepDone) {
    inactivitySweepDone = true;
    const date30DaysAgo = new Date();
    date30DaysAgo.setDate(date30DaysAgo.getDate() - 30);
    const iso30DaysAgo = toLocalISOString(date30DaysAgo);
    const today = toLocalISOString(new Date());

    try {
      const currentUser = await getCurrentUser();

      // Preluăm toate programările recente (trecute + de azi; o programare
      // viitoare NU contează ca activitate recentă)
      const { data: recentAppts } = await (supabase as any)
        .from('programari')
        .select('pacient_id, data')
        .eq('user_id', currentUser.id)
        .gte('data', iso30DaysAgo)
        .lte('data', today);

      const activePatientIds = new Set((recentAppts || []).map((a: any) => a.pacient_id));

      // Preluăm pacienții existenți
      const { data: allPatients } = await (supabase as any)
        .from('pacienti')
        .select('id, created_at, status_abonament')
        .eq('user_id', currentUser.id);
      if (allPatients) {
        for (const p of allPatients as any[]) {
          const isRecentCreated = new Date(p.created_at) >= date30DaysAgo;
          // Dacă nu are ședințe în ultimele 30 zile și nu a fost creat în ultimele 30 zile -> inactivați
          if (!activePatientIds.has(p.id) && !isRecentCreated && p.status_abonament !== 'inactiv') {
            await (supabase as any).from('pacienti').update({ status_abonament: 'inactiv' }).eq('id', p.id).eq('user_id', currentUser.id);
          }
        }
      }
    } catch (e) {
      console.error('Eroare verificare inactivitate pacienti:', e);
    }
  }

  const user = await getCurrentUser();
  let query = supabase
    .from('pacienti_view')
    .select('*')
    .eq('user_id', user.id)
    .order('prenume', { ascending: true });

  if (filter?.locatie)              query = query.eq('locatie', filter.locatie);
  if (filter?.achitat !== undefined) query = query.eq('achitat', filter.achitat);
  if (filter?.search) {
    // Caută în prenume sau nume (case-insensitive)
    query = query.ilike('name', `%${filter.search}%`);
  }

  // Filtrăm după starea de activitate dacă e specificat (implicit exclude inactivii)
  if (filter?.inactivi === true) {
    query = query.eq('status_abonament', 'inactiv');
  } else if (filter?.inactivi === false) {
    query = query.neq('status_abonament', 'inactiv');
  }

  const { data, error } = await query;
  if (error) throw new Error('Eroare la citirea pacienților: ' + error.message);
  const rows = (data ?? []).filter((p: any) => !p.sters_la); // arhivați = ascunși
  return await applyPackageTruth(rows);
}

// ── Adevărul pachetului peste rândurile pacient ───────────────
// Suprascrie câmpurile legacy (sedinte_total/folosite/cost/achitat) cu valorile
// pachetului deschis + plățile lui. Toate citirile trec prin aici, deci
// coloanele vechi rămân doar oglindă internă (nu mai sunt sursă de adevăr).
async function applyPackageTruth(rows: any[]): Promise<any[]> {
  if (!rows || rows.length === 0) return rows;
  const ids = rows.map(r => r.id).filter(Boolean);
  if (ids.length === 0) return rows;
  const user = await getCurrentUser();

  const { data: pkgs } = await (supabase as any)
    .from('pachet_curent')
    .select('pacient_id, id, nr_sedinte, pret, sedinte_folosite')
    .in('pacient_id', ids)
    .eq('user_id', user.id);
  const pkgByPatient = new Map<string, any>();
  const pkgIds: string[] = [];
  for (const p of (pkgs ?? []) as any[]) {
    pkgByPatient.set(p.pacient_id, p);
    pkgIds.push(p.id);
  }
  if (pkgIds.length === 0) return rows;

  const { data: plati } = await (supabase as any)
    .from('plati')
    .select('abonament_id, suma')
    .in('abonament_id', pkgIds);
  const paidByPkg = new Map<string, number>();
  for (const pl of (plati ?? []) as any[]) {
    paidByPkg.set(pl.abonament_id, (paidByPkg.get(pl.abonament_id) || 0) + (Number(pl.suma) || 0));
  }

  // pkg.tip lipseste din selectul de mai sus; il citim separat doar daca e nevoie
  const { data: tipRows } = await (supabase as any)
    .from('pachet_curent')
    .select('pacient_id, tip')
    .in('pacient_id', ids)
    .eq('user_id', user.id);
  const tipByPatient = new Map<string, string>();
  for (const t of (tipRows ?? []) as any[]) tipByPatient.set(t.pacient_id, t.tip || 'sedinte');

  for (const row of rows) {
    const pkg = pkgByPatient.get(row.id);
    if (!pkg) continue;
    row.sedinte_total = Number(pkg.nr_sedinte) || 0;
    row.sedinte_folosite = Math.min(Number(pkg.sedinte_folosite) || 0, row.sedinte_total);
    row.cost = Number(pkg.pret) || 0;
    const paid = paidByPkg.get(pkg.id) || 0;
    row.suma_incasata = paid;
    row.achitat = row.cost > 0 && paid >= row.cost;
    (row as any).lunar = tipByPatient.get(row.id) === 'lunar';
  }
  return rows;
}

// ── Citire pacient unic ───────────────────────────────────────
export async function getPatient(id: string): Promise<PacientView> {
  const user = await getCurrentUser();
  const { data, error } = await supabase
    .from('pacienti_view')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (error) throw new Error('Pacientul nu a fost găsit: ' + error.message);
  const [withTruth] = await applyPackageTruth([data]);
  return withTruth;
}

function normalizePlan(plan: string | undefined | null): 'Subscription' | 'One Time' | 'Abonament lunar' {
  if (!plan) return 'Subscription';
  const clean = plan.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  if (clean.includes('sedinta') || clean.includes('unica') || clean.includes('one')) {
    return 'One Time';
  }
  if (clean.includes('lunar')) {
    return 'Abonament lunar';
  }
  return 'Subscription';
}

// ── Adăugare pacient nou ──────────────────────────────────────
// UI trimite `name` ca string unic ("Maria Popescu")
// Funcția împarte în prenume + nume pentru DB
export async function addPatient(input: {
  name:          string;
  telefon:       string;
  locatie:       'Belaqva' | 'Ghimbav';
  plan:          any;
  cost:          number;
  sedinte_total: number;
  achitat?:      boolean;
  drive_link?:   string;
  notite?:       string;
}): Promise<string> { // returnează ID-ul pacientului creat
  const nameTrimmed = input.name.trim();
  const nameReversed = nameTrimmed.split(/\s+/).reverse().join(' ');
  const parts   = nameTrimmed.split(/\s+/);
  const prenume = parts[0] ?? '';
  const nume    = parts.slice(1).join(' '); // Rămâne gol dacă este un singur cuvânt, NU se duplică prenumele

  // Verificare nume duplicat (inclusiv inversat, ex. "Popa Diana" vs "Diana Popa")
  const { data: existing } = await (supabase as any)
    .from('pacienti_view')
    .select('id, name')
    .or(`name.ilike.${nameTrimmed},name.ilike.${nameReversed}`);

  if (existing && existing.length > 0) {
    const existingName = existing[0].name;
    throw new Error(`Există deja un pacient cu numele "${existingName}". Te rugăm să adaugi o deosebire (ex. o inițială sau locația) pentru a-l salva distinct!`);
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Trebuie să fii autentificat pentru a adăuga un pacient.');

  const payload: PacientInsert = {
    prenume,
    nume,
    telefon:       input.telefon,
    locatie:       input.locatie,
    plan:          normalizePlan(input.plan),
    cost:          input.cost,
    sedinte_total: input.sedinte_total,
    achitat:       input.achitat ?? false,
    drive_link:    input.drive_link ?? null,
    notite:        input.notite ?? null,
    user_id:       user.id,
  };

  const { data, error } = await (supabase as any)
    .from('pacienti')
    .insert(payload)
    .select('id')
    .single();

  if (error) throw new Error('Eroare la adăugarea pacientului: ' + error.message);
  return data.id;
}

// ── Actualizare pacient (editare) ─────────────────────────────
export async function updatePatient(id: string, updates: PacientUpdate & { name?: string }) {
  if (updates.plan) {
    updates.plan = normalizePlan(updates.plan);
  }

  // Dacă se trimite `name`, îl splitim în prenume + nume
  if (updates.name) {
    const nameTrimmed = updates.name.trim();
    const nameReversed = nameTrimmed.split(/\s+/).reverse().join(' ');
    
    // Check duplicate name on edit (excluding current patient id, but checking both normal and reversed)
    const { data: existing } = await (supabase as any)
      .from('pacienti_view')
      .select('id, name')
      .neq('id', id)
      .or(`name.ilike.${nameTrimmed},name.ilike.${nameReversed}`);

    if (existing && existing.length > 0) {
      const existingName = existing[0].name;
      throw new Error(`Există deja un alt pacient cu numele "${existingName}". Te rugăm să adaugi o deosebire pentru a-l distinge!`);
    }

    const parts       = nameTrimmed.split(/\s+/);
    updates.prenume   = parts[0] ?? '';
    updates.nume      = parts.slice(1).join(' '); // Rămâne gol dacă este un singur cuvânt, NU se duplică prenumele
    delete updates.name;
  }

  const { error } = await (supabase as any)
    .from('pacienti')
    .update(updates)
    .eq('id', id);

  if (error) throw new Error('Eroare la actualizarea pacientului: ' + error.message);
}

// ── Marcare achitat / neachitat (PaymentSheet) ────────────────
export async function setPaymentStatus(id: string, achitat: boolean) {
  const { error } = await (supabase as any)
    .from('pacienti')
    .update({ achitat })
    .eq('id', id);

  if (error) {
    console.error('setPaymentStatus error:', error, { id, achitat });
    throw new Error('Eroare la actualizarea plății: ' + error.message);
  }
}

// ── Adăugare plată custom (PaymentSheet) ──────────────────────
// RPC atomic: inserează plata și recalculează `achitat` DOAR pentru pachetul
// curent (plățile de la abonament_start; plățile pachetelor vechi nu contează).
// RPC atomic: inserează plata (legată de pachetul deschis sau de ședința
// indicată) și recalculează `achitat` ca SUM(plati pe pachet) >= pret —
// fără ferestre de date.
export async function addPayment(id: string, amount: number, markAchitat: boolean, programareId?: string) {
  const { error } = await supabase.rpc('record_payment', {
    p_pacient_id: id,
    p_suma: amount,
    p_mark_achitat: markAchitat,
    p_programare_id: programareId ?? null,
  });

  if (error) {
    console.error('[addPayment] record_payment error:', error);
    throw new Error('Eroare la salvarea plății: ' + error.message);
  }
}

// ── Reînnoire / pachet nou pacient (renew_subscription RPC) ──
// Reînnoirea atomica deschide un pachet nou, poartă ședințele neacoperite din
// pachetul anterior și PĂSTREAZĂ istoricul plăților (nu se șterge nimic din `plati`).
export async function resetPatientSubscription(
  id: string,
  newTotalSessions?: number,
  newCostTotal: number = 0,
  paymentOption: { status: 'Neachitat' | 'Parțial' | 'Achitat'; paidAmount?: number } | boolean = false
): Promise<void> {
  const current = await getPatient(id);
  // ✅ costul noului abonament ÎNLOCUIEȘTE costul vechi, nu se acumulează
  const nextTotal = newTotalSessions ?? (current.sedinte_total || 10);
  const nextCost = newCostTotal > 0 ? newCostTotal : (current.cost || 0);

  let pStatus: 'Neachitat' | 'Parțial' | 'Achitat' = 'Neachitat';
  let amountToAdd = 0;

  if (typeof paymentOption === 'boolean') {
    if (paymentOption) {
      amountToAdd = nextCost;
      pStatus = 'Achitat';
    }
  } else if (paymentOption) {
    if (paymentOption.status === 'Achitat') {
      amountToAdd = nextCost;
      pStatus = 'Achitat';
    } else if (paymentOption.status === 'Parțial') {
      amountToAdd = paymentOption.paidAmount || 0;
      pStatus = 'Parțial';
    }
  }

  // Totul (pachet nou + plata inițială) se face într-o singură tranzacție în DB:
  // renew_package închide rândul vechi din `abonamente` și deschide unul nou
  // (cu datoria de over-delivery), iar plata se leagă de noul pachet.
  const { error } = await (supabase as any).rpc('renew_package', {
    p_pacient_id: id,
    p_total: nextTotal,
    p_cost: nextCost,
    p_paid: amountToAdd,
    p_status: pStatus,
  });

  if (error) throw new Error(error.message || 'Eroare la reînnoirea abonamentului');

  clearRenewalDismissal(id);
}

const DISMISSED_RENEWALS_KEY = 'kineto_dismissed_renewals';

export function isRenewalDismissed(patientId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const dismissed = JSON.parse(localStorage.getItem(DISMISSED_RENEWALS_KEY) || '[]');
    return Array.isArray(dismissed) && dismissed.includes(patientId);
  } catch {
    return false;
  }
}

export function dismissRenewalNotification(patientId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const dismissed = JSON.parse(localStorage.getItem(DISMISSED_RENEWALS_KEY) || '[]');
    if (!Array.isArray(dismissed)) return;
    if (!dismissed.includes(patientId)) {
      dismissed.push(patientId);
      localStorage.setItem(DISMISSED_RENEWALS_KEY, JSON.stringify(dismissed));
    }
  } catch {}
}

export function clearRenewalDismissal(patientId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const dismissed = JSON.parse(localStorage.getItem(DISMISSED_RENEWALS_KEY) || '[]');
    if (Array.isArray(dismissed)) {
      const filtered = dismissed.filter(id => id !== patientId);
      localStorage.setItem(DISMISSED_RENEWALS_KEY, JSON.stringify(filtered));
    }
  } catch {}
}

export async function renewWithPrompt(patientId: string, currentTotal: number, patientName?: string): Promise<void> {
  emit(EVENTS.openRenewalSheet, {
    patientId,
    currentTotal: currentTotal || 10,
    patientName
  });
}

// ── Istoric ședințe individuale (pacienți Ședință unică, fără pachete) ──
// Fiecare ședință apare cu plata ei (plati.programare_id), nu ca abonament.
export interface SedintaUnicaIstoric {
  programare_id: string;
  data: string;
  ora: string;
  status: string;
  platit: number; // suma plătită pe această ședință (0 = neplătită)
}

export async function getSingleSessionsHistory(patientId: string): Promise<SedintaUnicaIstoric[]> {
  const user = await getCurrentUser();
  const [{ data: appts }, { data: plati }] = await Promise.all([
    (supabase as any).from('programari')
      .select('id, data, ora, status')
      .eq('pacient_id', patientId).eq('user_id', user.id)
      .order('data', { ascending: true }),
    (supabase as any).from('plati')
      .select('programare_id, suma')
      .eq('pacient_id', patientId).eq('user_id', user.id)
      .not('programare_id', 'is', null),
  ]);
  const paidBySession = new Map<string, number>();
  for (const pl of (plati ?? []) as any[]) {
    paidBySession.set(pl.programare_id, (paidBySession.get(pl.programare_id) || 0) + (Number(pl.suma) || 0));
  }
  return ((appts ?? []) as any[])
    .filter((a: any) => a.status !== 'anulat')
    .map((a: any) => ({
      programare_id: a.id,
      data: a.data,
      ora: a.ora,
      status: a.status || 'programat',
      platit: paidBySession.get(a.id) || 0,
    }));
}

// ── Istoric pachete reale (PaymentSheet) ──────────────────────
// Fiecare pachet e un rând `abonamente` real, cu ședințele și plățile
// legate prin FK — nu o reconstrucție aritmetică din sume.
export interface PachetIstoric {
  id: string;
  nr_sedinte: number;
  pret: number;
  sedinte_folosite: number;
  datorie_initiala: number;
  status: string;
  created_at: string;
  closed_at: string | null;
  plati: { suma: number; data_platii: string }[];
  sedinte: { data: string; ora: string }[];
}

export async function getPatientPackages(patientId: string): Promise<PachetIstoric[]> {
  const user = await getCurrentUser();

  const [{ data: pkgs, error: errP }, { data: plati }, { data: sedinte }] = await Promise.all([
    (supabase as any).from('abonamente').select('id, nr_sedinte, pret, sedinte_folosite, datorie_initiala, status, created_at, closed_at')
      .eq('pacient_id', patientId).eq('user_id', user.id).order('created_at', { ascending: true }),
    (supabase as any).from('plati').select('abonament_id, suma, data_platii')
      .eq('pacient_id', patientId).eq('user_id', user.id),
    (supabase as any).from('programari').select('abonament_id, data, ora')
      .eq('pacient_id', patientId).eq('user_id', user.id).eq('status', 'finalizat').not('abonament_id', 'is', null),
  ]);
  if (errP) throw new Error('Eroare la citirea pachetelor: ' + errP.message);

  const platiByPkg = new Map<string, { suma: number; data_platii: string }[]>();
  for (const pl of (plati ?? []) as any[]) {
    if (!pl.abonament_id) continue;
    if (!platiByPkg.has(pl.abonament_id)) platiByPkg.set(pl.abonament_id, []);
    platiByPkg.get(pl.abonament_id)!.push({ suma: Number(pl.suma) || 0, data_platii: pl.data_platii });
  }
  const sedinteByPkg = new Map<string, { data: string; ora: string }[]>();
  for (const s of (sedinte ?? []) as any[]) {
    if (!sedinteByPkg.has(s.abonament_id)) sedinteByPkg.set(s.abonament_id, []);
    sedinteByPkg.get(s.abonament_id)!.push({ data: s.data, ora: s.ora });
  }

  return ((pkgs ?? []) as any[]).map((p: any) => ({
    id: p.id,
    nr_sedinte: Number(p.nr_sedinte) || 0,
    pret: Number(p.pret) || 0,
    sedinte_folosite: Number(p.sedinte_folosite) || 0,
    datorie_initiala: Number(p.datorie_initiala) || 0,
    status: p.status,
    created_at: p.created_at,
    closed_at: p.closed_at,
    plati: (platiByPkg.get(p.id) ?? []).sort((a, b) => (a.data_platii || '').localeCompare(b.data_platii || '')),
    sedinte: (sedinteByPkg.get(p.id) ?? []).sort((a, b) => `${a.data}T${a.ora}`.localeCompare(`${b.data}T${b.ora}`)),
  }));
}

// ── Obținere plăți pacient (Local + Supabase Hybrid) ───────────
// `fromDate` (YYYY-MM-DD) limitează suma la plățile făcute de la data respectivă
// (folosit la reînnoire: restanța pachetului curent, fără plățile pachetelor vechi).
export async function getPatientPayments(id: string, fromDate?: string): Promise<number> {
  // Sursa unică de adevăr este tabela `plati` din Supabase.
  let dbTotal = 0;
  let hasDbPayments = false;
  try {
    const currentUser = await getCurrentUser();
    let query = (supabase as any).from('plati').select('suma').eq('pacient_id', id).eq('user_id', currentUser.id);
    if (fromDate) query = query.gte('data_platii', fromDate);
    const { data, error } = await query;
    if (!error && data && data.length > 0) {
      dbTotal = data.reduce((total: number, plata: any) => total + (plata.suma || 0), 0);
      hasDbPayments = true;
    }
  } catch (e) {
    console.error('Eroare citire plăți Supabase:', e);
  }

  if (hasDbPayments) {
    return dbTotal;
  }

  // Cu filtru de dată, lipsa rândurilor înseamnă 0 lei plătiți în perioadă
  // (fallback-urile de mai jos ar include plăți din afara perioadei).
  if (fromDate) {
    return 0;
  }

  // Fallback localStorage doar pentru dispozitive care nu au încă sincronizate plățile.
  if (typeof window !== 'undefined') {
    try {
      const key = `kineto_plati_${id}`;
      const existingStr = localStorage.getItem(key);
      if (existingStr) {
        const arr = JSON.parse(existingStr);
        return arr.reduce((total: number, item: any) => total + (item.suma || 0), 0);
      }
    } catch (e) {
      console.warn('Eroare citire plăți local:', e);
    }
  }

  // Dacă pacientul este marcat ca achitat integral (ex: setat la creare), suma achitată este costul total
  try {
    const patient = await getPatient(id);
    if (patient?.achitat === true || (patient as any)?.status_plata === 'Achitat' || (patient as any)?.status_plata === 'Achitat integral') {
      return Number(patient.cost || 0);
    }
  } catch (e) {}

  return 0;
}

export interface PaymentHistoryItem {
  id?: string;
  suma: number;
  data_platii: string;
  descriere?: string;
}

export async function getPatientPaymentHistoryDetails(id: string): Promise<PaymentHistoryItem[]> {
  const history: PaymentHistoryItem[] = [];

  try {
    const currentUser = await getCurrentUser();
    const { data, error } = await (supabase as any)
      .from('plati')
      .select('id, suma, data_platii, created_at')
      .eq('pacient_id', id)
      .eq('user_id', currentUser.id)
      .order('data_platii', { ascending: false });

    if (!error && data && data.length > 0) {
      data.forEach((p: any) => {
        const dStr = p.data_platii || (p.created_at ? toLocalISOString(new Date(p.created_at)) : toLocalISOString(new Date()));
        history.push({
          id: p.id,
          suma: Number(p.suma || 0),
          data_platii: dStr,
          descriere: 'Plată parțială'
        });
      });
    }
  } catch (e) {
    console.warn('Eroare citire istoric plăți Supabase:', e);
  }

  // Fallback localStorage doar dacă nu există încă plăți în DB.
  if (history.length === 0 && typeof window !== 'undefined') {
    try {
      const key = `kineto_plati_${id}`;
      const existingStr = localStorage.getItem(key);
      if (existingStr) {
        const arr = JSON.parse(existingStr);
        arr.forEach((item: any) => {
          const itemDate = item.timestamp ? toLocalISOString(new Date(item.timestamp)) : toLocalISOString(new Date());
          history.push({
            suma: Number(item.suma || 0),
            data_platii: itemDate,
            descriere: 'Plată parțială'
          });
        });
      }
    } catch (e) {
      console.warn('Eroare citire plăți local:', e);
    }
  }

  if (history.length === 0) {
    try {
      const patient = await getPatient(id);
      const totalPaid = await getPatientPayments(id);
      if (totalPaid > 0 || patient.achitat) {
        const paidVal = totalPaid > 0 ? totalPaid : Number(patient.cost || 0);
        const pDate = patient.created_at ? toLocalISOString(new Date(patient.created_at)) : toLocalISOString(new Date());
        history.push({
          suma: paidVal,
          data_platii: pDate,
          descriere: patient.achitat ? 'Achitat integral' : 'Plată parțială'
        });
      }
    } catch (e) {}
  }

  return history;
}


// ── Resetează/Șterge toate plățile pacientului ─────────────────
export async function resetPayments(id: string) {
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(`kineto_plati_${id}`);
    } catch (e) {
      console.warn('Eroare ștergere plăți local:', e);
    }
  }

  try {
    const currentUser = await getCurrentUser();
    // Se șterg DOAR plățile pachetului deschis — istoricul pachetelor
    // vechi (închise) rămâne intact. "Neachitat" nu mai distruge istoricul.
    const { data: pkgs } = await (supabase as any)
      .from('pachet_curent')
      .select('id')
      .eq('pacient_id', id)
      .eq('user_id', currentUser.id);
    const openIds = ((pkgs ?? []) as any[]).map((p: any) => p.id);
    if (openIds.length > 0) {
      await (supabase as any).from('plati').delete().eq('pacient_id', id).eq('user_id', currentUser.id).in('abonament_id', openIds);
    }
    await (supabase as any).from('pacienti').update({ achitat: false }).eq('id', id).eq('user_id', currentUser.id);
  } catch (err) {
    console.warn('Eroare ștergere plăți Supabase:', err);
  }
}

// ── Ștergere pacient ──────────────────────────────────────────
// Soft delete: pacientul se arhivează (sters_la), nu se pierde istoricul.
// Ștergerea reală e blocată în DB pentru pacienții cu plăți/ședințe.
export async function deletePatient(id: string) {
  const user = await getCurrentUser();
  const { error } = await (supabase as any)
    .from('pacienti')
    .update({ sters_la: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) throw new Error('Eroare la arhivarea pacientului: ' + error.message);
}

// ── Export CSV complet — pacienți + agendă programări ─────────────
export async function exportPatientsCSV(): Promise<string> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Trebuie să fii autentificat pentru export.');

  // 1. Preluăm pacienții direct din tabela `pacienti` (asigură citirea tuturor câmpurilor inclusiv telefon)
  let patients: any[] = [];
  try {
    // Citim TOȚI pacienții utilizatorului (fara filtru pe inactiv) ca sa nu pierdem date
    const { data: rawPatients, error: pErr } = await (supabase as any)
      .from('pacienti')
      .select('id, prenume, nume, telefon, locatie, plan, cost, sedinte_total, sedinte_folosite, achitat, status_abonament, user_id')
      .eq('user_id', user.id)
      .order('prenume', { ascending: true });

    if (pErr) {
      console.error('[EXPORT] Eroare citire pacienti:', pErr);
    }

    if (!pErr && rawPatients) {
      patients = rawPatients.map((p: any) => ({
        ...p,
        name: (!p.nume || p.prenume === p.nume) ? (p.prenume || 'Pacient') : `${p.prenume} ${p.nume}`.trim(),
        // Luam telefonul ca atare — fara fallback la '' ca sa vedem valoarea reala
        telefon: p.telefon
      }));
      // Contoarele din export = adevărul pachetului, nu oglinda legacy.
      patients = await applyPackageTruth(patients);
    }
  } catch (e) {
    console.warn('Eroare citire directă pacienți:', e);
  }

  // Fallback prin getPatients dacă tabela directă nu a returnat
  if (patients.length === 0) {
    const fallbackPatients = await getPatients({ inactivi: false });
    patients = fallbackPatients.map((p: any) => ({
      ...p,
      telefon: p.telefon
    }));
  }

  // Creăm o hartă ID -> Pacient pentru căutare rapidă și corelare la programări
  const patientMap = new Map<string, any>(patients.map(p => [p.id, p]));

  // 2. Preluăm programările utilizatorului curent
  let programari: any[] = [];
  try {
    const { data: rawAppts, error: apptErr } = await (supabase as any)
      .from('programari')
      .select('data, ora, locatie, status, note, motiv, pacient_id')
      .eq('user_id', user.id)
      .order('data', { ascending: false })
      .order('ora', { ascending: true });

    if (!apptErr && rawAppts) {
      programari = rawAppts;
    }
  } catch (e) {
    console.warn('Eroare citire programări pentru export:', e);
  }

  const formatPhone = (tel: string | undefined | null) => {
    if (!tel || !tel.trim()) return '-';
    const clean = tel.trim();
    // Previne interpretarea prefixului '+' ca formulă greșită în Excel
    if (clean.startsWith('+')) {
      return `'${clean}`;
    }
    return clean;
  };

  const rows: string[][] = [];

  // Secțiunea 1: PACIENȚI
  rows.push(['=== LISTA PACIENȚI ===']);
  rows.push(['Nume Complet', 'Telefon', 'Locatie', 'Plan', 'Cost (RON)', 'Sedinte Total', 'Sedinte Folosite', 'Sedinte Ramase', 'Achitat', 'Status Abonament']);

  patients.forEach(p => {
    const costVal = Number(p.cost || 0);
    const totalSess = Number(p.sedinte_total || 0);
    const usedSess = Number(p.sedinte_folosite || 0);
    const remSess = Math.max(0, totalSess - usedSess);
    const isPaid = p.achitat === true;

    rows.push([
      p.name || 'Pacient',
      formatPhone(p.telefon),
      p.locatie || '-',
      p.plan || '-',
      costVal.toString(),
      totalSess.toString(),
      usedSess.toString(),
      remSess.toString(),
      isPaid ? 'Da' : 'Nu',
      p.status_abonament || '-'
    ]);
  });

  rows.push([]); // Rând gol de separare

  // Secțiunea 2: AGENDA PROGRAMĂRI
  rows.push(['=== AGENDA ȘEDINȚE / PROGRAMĂRI ===']);
  rows.push(['Data', 'Ora', 'Pacient', 'Telefon', 'Locatie', 'Status Ședință', 'Note / Observații', 'Motiv Anulare/Absență']);

  programari.forEach((pr: any) => {
    const p = patientMap.get(pr.pacient_id);
    // Dacă pacientul nu mai există în lista activă, sărim
    if (!p) return;

    const pacientName = p.name || `${p.prenume || ''} ${p.nume || ''}`.trim() || 'Pacient';
    const telefon = formatPhone(p.telefon);

    rows.push([
      pr.data || '-',
      pr.ora ? pr.ora.substring(0, 5) : '-',
      pacientName,
      telefon,
      pr.locatie || p.locatie || '-',
      pr.status || '-',
      pr.note || '-',
      pr.motiv || '-'
    ]);
  });

  return '\uFEFF' + rows
    .map(row => row.map(f => `"${(f || '').replace(/"/g, '""')}"`).join(';'))
    .join('\n');
}
