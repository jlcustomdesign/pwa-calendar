/**
 * appointmentService.ts — CRUD programări Supabase
 * Folosit în: AddSessionSheet.astro, SessionWrapUpSheet.astro, calendar.astro
 */
import { supabase } from '../supabase';
import type { Programare, ProgramareInsert } from '../database.types';

// ── Programări pentru o zi specifică (calendar zilnic) ────────
export async function getAppointmentsByDate(date: string): Promise<Programare[]> {
  const { data, error } = await supabase
    .from('programari')
    .select(`
      *,
      pacienti ( prenume, nume, telefon, locatie, sedinte_ramase, status_abonament )
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

  const { data, error } = await supabase
    .from('programari')
    .insert(payload)
    .select('id')
    .single();

  // Eroarea din trigger conține mesajul descriptiv în română
  if (error) throw new Error(error.message);
  return data.id;
}

// ── Finalizare sesiune (SessionWrapUpSheet → Save & Close) ────
// Triggerul `incrementeaza_sedinte_folosite` rulează automat
export async function completeSession(id: string, note?: string) {
  const { error } = await supabase
    .from('programari')
    .update({ status: 'finalizat', note: note ?? null })
    .eq('id', id);

  if (error) throw new Error('Eroare la finalizarea sesiunii: ' + error.message);
}

// ── Marcare absent ────────────────────────────────────────────
export async function markAbsent(id: string, motiv?: string) {
  const { error } = await supabase
    .from('programari')
    .update({ status: 'absent', motiv: motiv ?? null })
    .eq('id', id);

  if (error) throw new Error('Eroare la marcarea absenței: ' + error.message);
}

// ── Anulare programare ────────────────────────────────────────
export async function cancelAppointment(id: string, motiv?: string) {
  const { error } = await supabase
    .from('programari')
    .update({ status: 'anulat', motiv: motiv ?? null })
    .eq('id', id);

  if (error) throw new Error('Eroare la anularea programării: ' + error.message);
}

// ── Reprogramare (rebook next week din WrapUp) ────────────────
export async function rebookNextWeek(originalId: string): Promise<string> {
  const { data: orig, error: fetchErr } = await supabase
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
