/**
 * appointmentService.ts — CRUD programări Supabase
 * Folosit în: AddSessionSheet.astro, SessionWrapUpSheet.astro, calendar.astro
 */
import { supabase } from '../supabase';
import type { Programare, ProgramareInsert } from '../database.types';

// ── Citire programare unică (editare) ─────────────────────────
export async function getAppointment(id: string): Promise<Programare & { pacienti: { prenume: string; nume: string } }> {
  const { data, error } = await supabase
    .from('programari')
    .select(`
      *,
      pacienti ( prenume, nume )
    `)
    .eq('id', id)
    .single();

  if (error) throw new Error('Eroare la citirea programării: ' + error.message);
  return data as any;
}

// ── Ștergere programare ───────────────────────────────────────
export async function deleteAppointment(id: string) {
  const { error } = await supabase
    .from('programari')
    .delete()
    .eq('id', id);

  if (error) throw new Error('Eroare la ștergerea programării: ' + error.message);
}

// ── Actualizare programare existentă ──────────────────────────
export async function updateAppointment(id: string, updates: {
  pacient_id?: string;
  data?: string;
  ora?: string;
  locatie?: 'Belaqva' | 'Ghimbav';
}) {
  const { error } = await (supabase as any)
    .from('programari')
    .update(updates)
    .eq('id', id);

  if (error) {
    console.error('updateAppointment error:', error, { id, updates });
    throw new Error('Eroare la actualizarea programării: ' + (error.message || JSON.stringify(error)));
  }
}

// ── Schimbă pacienții între două programări (swap) ─────────────
export async function swapAppointmentPatients(idA: string, idB: string) {
  const [{ data: a, error: errA }, { data: b, error: errB }] = await Promise.all([
    (supabase as any).from('programari').select('pacient_id').eq('id', idA).single(),
    (supabase as any).from('programari').select('pacient_id').eq('id', idB).single(),
  ]);

  if (errA || errB || !a || !b) {
    throw new Error('Eroare la citirea programărilor pentru schimb.');
  }

  const pacientA = a.pacient_id;
  const pacientB = b.pacient_id;

  try {
    const { error: updA } = await (supabase as any)
      .from('programari')
      .update({ pacient_id: pacientB })
      .eq('id', idA);
    if (updA) throw updA;

    const { error: updB } = await (supabase as any)
      .from('programari')
      .update({ pacient_id: pacientA })
      .eq('id', idB);
    if (updB) {
      // Rollback best-effort
      await (supabase as any).from('programari').update({ pacient_id: pacientA }).eq('id', idA);
      throw updB;
    }
  } catch (err: any) {
    console.error('swapAppointmentPatients error:', err, { idA, idB });
    throw new Error('Eroare la schimbul pacienților: ' + (err.message || JSON.stringify(err)));
  }
}

// ── Programări pentru o zi specifică (calendar zilnic) ────────
export async function getAppointmentsByDate(date: string): Promise<Programare[]> {
  const { data, error } = await supabase
    .from('programari')
    .select(`
      *,
      pacienti ( prenume, nume, telefon, locatie, status_abonament, sedinte_folosite, sedinte_total, achitat, cost )
    `)
    .eq('data', date)
    .order('ora', { ascending: true });

  if (error) throw new Error('Eroare la citirea programărilor: ' + error.message);
  return data ?? [];
}

// ── Programări pentru un interval de date (calendar săptămânal) 
export async function getAppointmentsByRange(startDate: string, endDate: string): Promise<Programare[]> {
  const { data, error } = await supabase
    .from('programari')
    .select(`
      *,
      pacienti ( prenume, nume, telefon, locatie )
    `)
    .gte('data', startDate)
    .lte('data', endDate)
    .order('data', { ascending: true })
    .order('ora',  { ascending: true });

  if (error) throw new Error('Eroare la citirea programărilor: ' + error.message);
  return data ?? [];
}

// ── Toate programările unui pacient ───────────────────────────
export async function getAppointmentsByPatient(patientId: string): Promise<Programare[]> {
  const { data, error } = await supabase
    .from('programari')
    .select('*')
    .eq('pacient_id', patientId)
    .order('data', { ascending: false });

  if (error) throw new Error('Eroare la citirea programărilor pacientului: ' + error.message);
  return data ?? [];
}

// ── Creare programare nouă (AddSessionSheet) ──────────────────
// Triggerul `valideaza_programare` rulează automat în DB
export async function createAppointment(input: {
  pacient_id: string;
  data:       string;   // "YYYY-MM-DD"
  ora:        string;   // "HH:MM"
  locatie?:   'Belaqva' | 'Ghimbav';
}): Promise<string> { // returnează ID-ul programării
  const payload: ProgramareInsert = {
    pacient_id: input.pacient_id,
    data:       input.data,
    ora:        input.ora,
    locatie:    input.locatie ?? 'Belaqva',
    status:     'programat',
  };

  const { data, error } = await (supabase as any)
    .from('programari')
    .insert(payload)
    .select('id')
    .single();

  // Eroarea din trigger conține mesajul descriptiv în română
  if (error) throw new Error(error.message);

  // Dacă pacientul are ședință unică și a consumat deja pachetul, resetăm contorul
  // pentru noua ședință. Istoricul programărilor rămâne în DB, deci statisticile nu se pierd.
  try {
    const { data: p } = await (supabase as any)
      .from('pacienti')
      .select('plan, sedinte_folosite, sedinte_total')
      .eq('id', input.pacient_id)
      .single();
    if (p && p.plan === 'One Time' && p.sedinte_folosite > 0 && p.sedinte_folosite >= (p.sedinte_total || 1)) {
      await (supabase as any)
        .from('pacienti')
        .update({ sedinte_folosite: 0 })
        .eq('id', input.pacient_id);
    }
  } catch (e) {
    console.warn('createAppointment reset counter warning:', e);
  }

  return data.id;
}

export async function completeSession(id: string, note?: string) {
  // 1. Obținem programarea pentru pacient_id
  let patientId: string | null = null;
  try {
    const { data: appt } = await (supabase as any).from('programari').select('pacient_id').eq('id', id).single();
    if (appt) patientId = appt.pacient_id;
  } catch (e) {
    console.warn('completeSession fetch appt error:', e);
  }

  // 2. Marcăm ședința ca finalizată
  const { error } = await (supabase as any)
    .from('programari')
    .update({ status: 'finalizat', note: note ?? null })
    .eq('id', id);

  if (error) {
    console.error('completeSession error:', error, { id });
    throw new Error('Eroare la finalizarea sesiunii: ' + (error.message || JSON.stringify(error)));
  }

  // 3. Incrementăm direct sedinte_folosite pe pacient în DB (garanție 100% că se umple bara pacientului)
  if (patientId) {
    try {
      const { data: p } = await (supabase as any).from('pacienti').select('sedinte_folosite, sedinte_total').eq('id', patientId).single();
      if (p) {
        const currentUsed = p.sedinte_folosite ?? 0;
        const total = p.sedinte_total || 10;
        const nextUsed = Math.min(total, currentUsed + 1);
        await (supabase as any).from('pacienti').update({ sedinte_folosite: nextUsed }).eq('id', patientId);
      }
    } catch (e) {
      console.warn('Direct sedinte_folosite update error:', e);
    }
  }
}

// ── Marcare absent ────────────────────────────────────────────
export async function markAbsent(id: string, motiv?: string) {
  const { error } = await (supabase as any)
    .from('programari')
    .update({ status: 'absent', motiv: motiv ?? null })
    .eq('id', id);

  if (error) {
    console.error('markAbsent error:', error, { id });
    throw new Error('Eroare la marcarea absenței: ' + (error.message || JSON.stringify(error)));
  }
}

// ── Anulare programare ────────────────────────────────────────
export async function cancelAppointment(id: string, motiv?: string) {
  const { error } = await (supabase as any)
    .from('programari')
    .update({ status: 'anulat', motiv: motiv ?? null })
    .eq('id', id);

  if (error) {
    console.error('cancelAppointment error:', error, { id });
    throw new Error('Eroare la anularea programării: ' + (error.message || JSON.stringify(error)));
  }
}

// ── Reprogramare (rebook next week din WrapUp) ────────────────
export async function rebookNextWeek(originalId: string): Promise<string> {
  const { data: orig, error: fetchErr } = await (supabase as any)
    .from('programari')
    .select('pacient_id, data, ora, locatie')
    .eq('id', originalId)
    .single();

  if (fetchErr || !orig) throw new Error('Programarea originală nu a fost găsită.');

  // Calculăm data săptămânii viitoare
  const nextDate = new Date(orig.data);
  nextDate.setDate(nextDate.getDate() + 7);
  const nextDateStr = nextDate.toISOString().split('T')[0];

  return createAppointment({
    pacient_id: orig.pacient_id,
    data:       nextDateStr,
    ora:        orig.ora,
    locatie:    orig.locatie as 'Belaqva' | 'Ghimbav',
  });
}

// ── Wrap-up: sesiuni trecute încă nerezolvate ─────────────────
// (status 'programat', data trecută sau azi dar ora + 1h a trecut)
export interface PendingWrapUp {
  id: string;
  pacient_id: string;
  data: string;
  ora: string;
  pacienti: { prenume: string; nume: string } | null;
}

export async function getPendingWrapUps(): Promise<PendingWrapUp[]> {
  const now = new Date();
  const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const cutoffTime = new Date(now.getTime() - 60 * 60 * 1000);
  const cutoffStr = String(cutoffTime.getHours()).padStart(2, '0') + ':' + String(cutoffTime.getMinutes()).padStart(2, '0');

  const { data, error } = await (supabase as any)
    .from('programari')
    .select(`
      id, pacient_id, data, ora,
      pacienti ( prenume, nume )
    `)
    .eq('status', 'programat')
    .lte('data', todayStr)
    .order('data', { ascending: true })
    .order('ora',  { ascending: true });

  if (error) throw new Error('Eroare la citirea sesiunilor de confirmat: ' + error.message);

  return (data ?? []).filter((a: PendingWrapUp) =>
    a.data < todayStr || (a.ora || '00:00') <= cutoffStr
  );
}

// ── Câte programări are pacientul în săptămâna datei (L–D) ────
export async function countPatientWeekAppointments(patientId: string, dateStr: string): Promise<number> {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay(); // 0 = Duminică
  const monday = new Date(d);
  monday.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const fmt = (x: Date) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');

  const { count, error } = await (supabase as any)
    .from('programari')
    .select('id', { count: 'exact', head: true })
    .eq('pacient_id', patientId)
    .gte('data', fmt(monday))
    .lte('data', fmt(sunday))
    .not('status', 'in', '("anulat","absent")');

  if (error) throw new Error('Eroare la numărarea programărilor săptămânale: ' + error.message);
  return count ?? 0;
}
