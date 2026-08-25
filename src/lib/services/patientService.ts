/**
 * patientService.ts — CRUD pacienti Supabase
 * Folosit în: PatientList.astro, AddPatientSheet.astro, PaymentSheet.astro
 */
import { supabase } from '../supabase';
import type { PacientInsert, PacientUpdate, PacientView } from '../database.types';

// ── Listare pacienți (cu filtru opțional și verificare inactivitate 30 zile) ─────────────────────
export async function getPatients(filter?: {
  locatie?: 'Belaqva' | 'Ghimbav';
  achitat?: boolean;
  search?: string;
  inactivi?: boolean;
}): Promise<PacientView[]> {
  // 1. Verificăm și marcăm pacienții neprogramați de peste 30 de zile ca inactivi
  const date30DaysAgo = new Date();
  date30DaysAgo.setDate(date30DaysAgo.getDate() - 30);
  const iso30DaysAgo = date30DaysAgo.toISOString().split('T')[0];

  try {
    // Preluăm toate programările recente
    const { data: recentAppts } = await (supabase as any)
      .from('programari')
      .select('pacient_id, data')
      .gte('data', iso30DaysAgo);

    const activePatientIds = new Set((recentAppts || []).map((a: any) => a.pacient_id));

    // Preluăm pacienții existenți
    const { data: allPatients } = await (supabase as any).from('pacienti').select('id, created_at, status_abonament');
    if (allPatients) {
      for (const p of allPatients as any[]) {
        const isRecentCreated = new Date(p.created_at) >= date30DaysAgo;
        // Dacă nu are ședințe în ultimele 30 zile și nu a fost creat în ultimele 30 zile -> inactivați
        if (!activePatientIds.has(p.id) && !isRecentCreated && p.status_abonament !== 'inactiv') {
          await (supabase as any).from('pacienti').update({ status_abonament: 'inactiv' }).eq('id', p.id);
        }
      }
    }
  } catch (e) {
    console.error('Eroare verificare inactivitate pacienti:', e);
  }

  let query = supabase
    .from('pacienti_view')
    .select('*')
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
  return data ?? [];
}

// ── Citire pacient unic ───────────────────────────────────────
export async function getPatient(id: string): Promise<PacientView> {
  const { data, error } = await supabase
    .from('pacienti_view')
    .select('*')
    .eq('id', id)
    .single();

  if (error) throw new Error('Pacientul nu a fost găsit: ' + error.message);
  return data;
}

function normalizePlan(plan: string | undefined | null): 'Subscription' | 'One Time' {
  if (!plan) return 'Subscription';
  const clean = plan.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  if (clean.includes('sedinta') || clean.includes('unica') || clean.includes('one')) {
    return 'One Time';
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
  const parts   = nameTrimmed.split(/\s+/);
  const prenume = parts[0] ?? '';
  const nume    = parts.slice(1).join(' '); // Rămâne gol dacă este un singur cuvânt, NU se duplică prenumele

  // Verificare nume duplicat
  const { data: existing } = await supabase
    .from('pacienti_view')
    .select('id, name')
    .ilike('name', nameTrimmed);

  if (existing && existing.length > 0) {
    throw new Error(`Există deja un pacient cu numele "${nameTrimmed}". Te rugăm să adaugi o deosebire (ex. o inițială sau locația) pentru a salva corect!`);
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
    
    // Check duplicate name on edit (excluding current patient id)
    const { data: existing } = await supabase
      .from('pacienti_view')
      .select('id, name')
      .ilike('name', nameTrimmed)
      .neq('id', id);

    if (existing && existing.length > 0) {
      throw new Error(`Există deja un alt pacient cu numele "${nameTrimmed}". Te rugăm să adaugi o deosebire pentru a-l distinge!`);
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
export async function addPayment(id: string, amount: number, markAchitat: boolean) {
  // 1. Salvare instantanee în localStorage ca fallback
  if (typeof window !== 'undefined') {
    try {
      const key = `kineto_plati_${id}`;
      const existingStr = localStorage.getItem(key);
      const existingArr = existingStr ? JSON.parse(existingStr) : [];
      existingArr.push({ suma: amount, timestamp: Date.now() });
      localStorage.setItem(key, JSON.stringify(existingArr));
    } catch (e) {
      console.warn('Eroare salvare plată local:', e);
    }
  }

  // 2. Salvare plată direct în Supabase
  try {
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await (supabase as any).from('plati').insert({
      pacient_id: id,
      suma: amount,
      data_platii: new Date().toISOString().split('T')[0],
      user_id: user?.id
    });
    if (error) console.warn('Supabase plati warning:', error.message);
  } catch (err) {
    console.warn('Network or schema warning for Supabase plati:', err);
  }

  // 3. Obținem suma totală achitată și costul pacientului
  const totalPaid = await getPatientPayments(id);
  const patient = await getPatient(id);
  const cost = patient?.cost || 0;

  // 4. Actualizăm statusul în Supabase
  const shouldMarkAchitat = markAchitat || (cost > 0 && totalPaid >= cost);
  console.log('[addPayment] updating achitat:', { id, amount, markAchitat, totalPaid, cost, shouldMarkAchitat });
  const { error: updateErr } = await (supabase as any)
    .from('pacienti')
    .update({ achitat: shouldMarkAchitat })
    .eq('id', id);

  if (updateErr) {
    console.error('[addPayment] achitat update error:', updateErr);
    throw new Error('Eroare la actualizarea statusului de plată: ' + updateErr.message);
  }
}

// ── Reînnoire / Resetare pachet pacient (reia ședințele de la 0) ──
export async function resetPatientSubscription(
  id: string, 
  newTotalSessions?: number, 
  newCostTotal: number = 0, 
  paymentOption: { status: 'Neachitat' | 'Parțial' | 'Achitat'; paidAmount?: number } | boolean = false
): Promise<void> {
  const current = await getPatient(id);
  const nextTotal = newTotalSessions ?? (current.sedinte_total || 10);
  const nextCost = (current.cost || 0) + newCostTotal;

  let isAchitat = false;
  let amountToAdd = 0;

  if (typeof paymentOption === 'boolean') {
    if (paymentOption) {
      amountToAdd = newCostTotal;
      isAchitat = true;
    }
  } else if (paymentOption) {
    if (paymentOption.status === 'Achitat') {
      amountToAdd = newCostTotal;
      isAchitat = true;
    } else if (paymentOption.status === 'Parțial') {
      amountToAdd = paymentOption.paidAmount || 0;
      isAchitat = false;
    }
  }

  // Reînnoirea înseamnă un pachet nou: resetăm contorul de ședințe folosite la 0
  // și setăm noul total. Istoricul programărilor rămâne în DB.
  const { error } = await (supabase as any)
    .from('pacienti')
    .update({
      sedinte_total: nextTotal,
      sedinte_folosite: 0,
      cost: nextCost,
      status_abonament: 'activ',
      achitat: isAchitat
    })
    .eq('id', id);

  if (error) throw new Error('Eroare la reînnoirea abonamentului: ' + error.message);
  
  if (amountToAdd > 0) {
    await addPayment(id, amountToAdd, isAchitat);
  }
  
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
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('openRenewalSheet', {
      detail: {
        patientId,
        currentTotal: currentTotal || 10,
        patientName
      }
    }));
  }
}

// ── Obținere plăți pacient (Local + Supabase Hybrid) ───────────
export async function getPatientPayments(id: string): Promise<number> {
  let localTotal = 0;
  if (typeof window !== 'undefined') {
    try {
      const key = `kineto_plati_${id}`;
      const existingStr = localStorage.getItem(key);
      if (existingStr) {
        const arr = JSON.parse(existingStr);
        localTotal = arr.reduce((total: number, item: any) => total + (item.suma || 0), 0);
      }
    } catch (e) {
      console.warn('Eroare citire plăți local:', e);
    }
  }

  let dbTotal = 0;
  let hasDbPayments = false;
  try {
    const { data, error } = await (supabase as any).from('plati').select('suma').eq('pacient_id', id);
    if (!error && data && data.length > 0) {
      dbTotal = data.reduce((total: number, plata: any) => total + (plata.suma || 0), 0);
      hasDbPayments = true;
    }
  } catch (e) {
    console.error('Eroare citire plăți Supabase:', e);
  }

  const recordedTotal = Math.max(localTotal, dbTotal);
  if (recordedTotal > 0 || hasDbPayments) {
    return recordedTotal;
  }

  // Dacă pacientul este marcat ca achitat integral (ex: setat la creare), suma achitată este costul total
  try {
    const patient = await getPatient(id);
    if (patient?.achitat === true || (patient as any)?.status_plata === 'Achitat' || (patient as any)?.status_plata === 'Achitat integral') {
      return Number(patient.cost || 0);
    }
  } catch (e) {}

  return recordedTotal;
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
    const { data, error } = await (supabase as any)
      .from('plati')
      .select('id, suma, data_platii, created_at')
      .eq('pacient_id', id)
      .order('data_platii', { ascending: false });

    if (!error && data && data.length > 0) {
      data.forEach((p: any) => {
        const dStr = p.data_platii || (p.created_at ? p.created_at.split('T')[0] : new Date().toISOString().split('T')[0]);
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

  if (typeof window !== 'undefined') {
    try {
      const key = `kineto_plati_${id}`;
      const existingStr = localStorage.getItem(key);
      if (existingStr) {
        const arr = JSON.parse(existingStr);
        arr.forEach((item: any) => {
          const itemDate = item.timestamp ? new Date(item.timestamp).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
          const exists = history.some(h => h.suma === Number(item.suma) && h.data_platii === itemDate);
          if (!exists) {
            history.push({
              suma: Number(item.suma || 0),
              data_platii: itemDate,
              descriere: 'Plată parțială'
            });
          }
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
        const pDate = patient.created_at ? patient.created_at.split('T')[0] : new Date().toISOString().split('T')[0];
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
    await (supabase as any).from('plati').delete().eq('pacient_id', id);
  } catch (err) {
    console.warn('Eroare ștergere plăți Supabase:', err);
  }

  await (supabase as any).from('pacienti').update({ achitat: false }).eq('id', id);
}

// ── Ștergere pacient ──────────────────────────────────────────
export async function deletePatient(id: string) {
  const { error } = await supabase
    .from('pacienti')
    .delete()
    .eq('id', id);

  if (error) throw new Error('Eroare la ștergerea pacientului: ' + error.message);
}

// ── Export CSV complet — pacienți + agendă programări ─────────────
export async function exportPatientsCSV(): Promise<string> {
  // 1. Preluăm pacienții reali din Supabase
  const patients = await getPatients();
  
  // 2. Preluăm toate programările reale din Supabase
  const { data: programari } = await supabase
    .from('programari')
    .select(`
      data, ora, locatie, status, note, motiv,
      pacienti ( prenume, nume, telefon )
    `)
    .order('data', { ascending: false })
    .order('ora', { ascending: true });

  const rows: string[][] = [];

  // Secțiunea 1: PACIENȚI
  rows.push(['=== LISTA PACIENȚI ===']);
  rows.push(['Nume Complet', 'Telefon', 'Locatie', 'Plan', 'Cost (RON)', 'Sedinte Total', 'Sedinte Folosite', 'Sedinte Ramase', 'Achitat', 'Status Abonament']);

  patients.forEach(p => {
    rows.push([
      p.name,
      p.telefon || '-',
      p.locatie || '-',
      p.plan || '-',
      (p.cost || 0).toString(),
      (p.sedinte_total || 0).toString(),
      (p.sedinte_folosite || 0).toString(),
      (p.sedinte_ramase || 0).toString(),
      p.achitat ? 'Da' : 'Nu',
      p.status_abonament || '-'
    ]);
  });

  rows.push([]); // Rând gol de separare

  // Secțiunea 2: AGENDA PROGRAMĂRI
  rows.push(['=== AGENDA ȘEDINȚE / PROGRAMĂRI ===']);
  rows.push(['Data', 'Ora', 'Pacient', 'Telefon', 'Locatie', 'Status Ședință', 'Note / Observații', 'Motiv Anulare/Absență']);

  (programari || []).forEach((pr: any) => {
    const pacientName = pr.pacienti ? `${pr.pacienti.prenume} ${pr.pacienti.nume}` : 'Pacient Necunoscut';
    const telefon = pr.pacienti?.telefon || '-';
    rows.push([
      pr.data,
      pr.ora,
      pacientName,
      telefon,
      pr.locatie || '-',
      pr.status || '-',
      pr.note || '-',
      pr.motiv || '-'
    ]);
  });

  return '\uFEFF' + rows
    .map(row => row.map(f => `"${(f || '').replace(/"/g, '""')}"`).join(';'))
    .join('\n');
}
