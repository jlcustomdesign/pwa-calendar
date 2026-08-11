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
  frecventa:     string;
  sedinte_total: number;
  achitat?:      boolean;
  drive_link?:   string;
  notite?:       string;
}): Promise<string> { // returnează ID-ul pacientului creat
  const nameTrimmed = input.name.trim();
  const parts   = nameTrimmed.split(/\s+/);
  const prenume = parts[0] ?? '';
  const nume    = parts.slice(1).join(' ') || prenume; // fallback dacă e un singur cuvânt

  // Verificare nume duplicat
  const { data: existing } = await supabase
    .from('pacienti_view')
    .select('id, name')
    .ilike('name', nameTrimmed);

  if (existing && existing.length > 0) {
    throw new Error(`Există deja un pacient cu numele "${nameTrimmed}". Te rugăm să adaugi o deosebire (ex. o inițială sau locația) pentru a salva corect!`);
  }

  const payload: PacientInsert = {
    prenume,
    nume,
    telefon:       input.telefon,
    locatie:       input.locatie,
    plan:          normalizePlan(input.plan),
    cost:          input.cost,
    frecventa:     input.frecventa,
    sedinte_total: input.sedinte_total,
    achitat:       input.achitat ?? false,
    drive_link:    input.drive_link ?? null,
    notite:        input.notite ?? null,
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
    updates.nume      = parts.slice(1).join(' ') || parts[0];
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

  if (error) throw new Error('Eroare la actualizarea plății: ' + error.message);
}

// ── Adăugare plată custom (PaymentSheet) ──────────────────────
export async function addPayment(id: string, amount: number, markAchitat: boolean) {
  // 1. Salvare plată direct în Supabase
  try {
    const { error } = await (supabase as any).from('plati').insert({
      pacient_id: id,
      suma: amount,
      data_platii: new Date().toISOString().split('T')[0]
    });
    if (error) console.warn('Supabase plati warning:', error.message);
  } catch (err) {
    console.warn('Network or schema warning for Supabase plati:', err);
  }

  // 2. Obținem suma totală achitată și costul pacientului din Supabase
  const totalPaid = await getPatientPayments(id);
  const patient = await getPatient(id);
  const cost = patient?.cost || 0;

  // 3. Dacă s-a atins costul total sau s-a cerut marcarea ca achitat, actualizăm statusul în Supabase
  if (markAchitat || (cost > 0 && totalPaid >= cost)) {
    await (supabase as any).from('pacienti').update({ achitat: true }).eq('id', id);
  } else {
    await (supabase as any).from('pacienti').update({ achitat: false }).eq('id', id);
  }
}

// ── Obținere plăți pacient din Supabase ────────────────────────
export async function getPatientPayments(id: string): Promise<number> {
  try {
    const { data, error } = await (supabase as any).from('plati').select('suma').eq('pacient_id', id);
    if (!error && data) {
      return data.reduce((total: number, plata: any) => total + (plata.suma || 0), 0);
    }
  } catch (e) {
    console.error('Eroare citire plăți Supabase:', e);
  }
  return 0;
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
  rows.push(['Nume Complet', 'Telefon', 'Locatie', 'Plan', 'Frecventa', 'Cost (RON)', 'Sedinte Total', 'Sedinte Folosite', 'Sedinte Ramase', 'Achitat', 'Status Abonament']);
  
  patients.forEach(p => {
    rows.push([
      p.name,
      p.telefon || '-',
      p.locatie || '-',
      p.plan || '-',
      p.frecventa || '-',
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
