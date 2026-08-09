/**
 * patientService.ts — CRUD pacienti Supabase
 * Folosit în: PatientList.astro, AddPatientSheet.astro, PaymentSheet.astro
 */
import { supabase } from '../supabase';
import type { PacientInsert, PacientUpdate, PacientView } from '../database.types';

// ── Listare pacienți (cu filtru opțional) ─────────────────────
export async function getPatients(filter?: {
  locatie?: 'Belaqva' | 'Ghimbav';
  achitat?: boolean;
  search?: string;
}): Promise<PacientView[]> {
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

// ── Adăugare pacient nou ──────────────────────────────────────
// UI trimite `name` ca string unic ("Maria Popescu")
// Funcția împarte în prenume + nume pentru DB
export async function addPatient(input: {
  name:          string;
  telefon:       string;
  locatie:       'Belaqva' | 'Ghimbav';
  plan:          'Subscription' | 'One Time';
  cost:          number;
  frecventa:     string;
  sedinte_total: number;
  achitat?:      boolean;
  drive_link?:   string;
  notite?:       string;
}): Promise<string> { // returnează ID-ul pacientului creat
  const parts   = input.name.trim().split(/\s+/);
  const prenume = parts[0] ?? '';
  const nume    = parts.slice(1).join(' ') || prenume; // fallback dacă e un singur cuvânt

  const payload: PacientInsert = {
    prenume,
    nume,
    telefon:       input.telefon,
    locatie:       input.locatie,
    plan:          input.plan,
    cost:          input.cost,
    frecventa:     input.frecventa,
    sedinte_total: input.sedinte_total,
    achitat:       input.achitat ?? false,
    drive_link:    input.drive_link ?? null,
    notite:        input.notite ?? null,
  };

  const { data, error } = await supabase
    .from('pacienti')
    .insert(payload)
    .select('id')
    .single();

  if (error) throw new Error('Eroare la adăugarea pacientului: ' + error.message);
  return data.id;
}

// ── Actualizare pacient (editare) ─────────────────────────────
export async function updatePatient(id: string, updates: PacientUpdate & { name?: string }) {
  // Dacă se trimite `name`, îl splitim în prenume + nume
  if (updates.name) {
    const parts       = updates.name.trim().split(/\s+/);
    updates.prenume   = parts[0];
    updates.nume      = parts.slice(1).join(' ') || parts[0];
    delete updates.name;
  }

  const { error } = await supabase
    .from('pacienti')
    .update(updates)
    .eq('id', id);

  if (error) throw new Error('Eroare la actualizarea pacientului: ' + error.message);
}

// ── Marcare achitat / neachitat (PaymentSheet) ────────────────
export async function setPaymentStatus(id: string, achitat: boolean) {
  const { error } = await supabase
    .from('pacienti')
    .update({ achitat })
    .eq('id', id);

  if (error) throw new Error('Eroare la actualizarea plății: ' + error.message);
}

// ── Ștergere pacient ──────────────────────────────────────────
export async function deletePatient(id: string) {
  const { error } = await supabase
    .from('pacienti')
    .delete()
    .eq('id', id);

  if (error) throw new Error('Eroare la ștergerea pacientului: ' + error.message);
}

// ── Export CSV — pacienți + date financiare ───────────────────
export async function exportPatientsCSV(): Promise<string> {
  const patients = await getPatients();

  const headers = ['Nume', 'Telefon', 'Locatie', 'Plan', 'Frecventa',
                   'Cost (RON)', 'Sedinte Total', 'Sedinte Ramase', 'Achitat', 'Status'];
  const rows = patients.map(p => [
    p.name,
    p.telefon,
    p.locatie,
    p.plan,
    p.frecventa,
    p.cost.toString(),
    p.sedinte_total.toString(),
    p.sedinte_ramase.toString(),
    p.achitat ? 'Da' : 'Nu',
    p.status_abonament,
  ]);

  return '\uFEFF' + [headers, ...rows]
    .map(row => row.map(f => `"${f}"`).join(';'))
    .join('\n');
}
