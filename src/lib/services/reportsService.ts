/**
 * reportsService.ts — Date pentru ReportsView (statistici + rapoarte)
 * Folosit în: ReportsView.astro
 */
import { supabase } from '../supabase';
import type { IstericSaptamanal } from '../database.types';

// ── Statistici pentru AZI ─────────────────────────────────────
export async function getTodayStats(date?: string) {
  const today = date ?? new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('programari')
    .select(`
      status,
      pacienti ( cost )
    `)
    .eq('data', today);

  if (error) throw new Error('Eroare la citirea statisticilor zilnice: ' + error.message);

  const sedinte_total   = data?.length ?? 0;
  const finalizate      = data?.filter(p => p.status === 'finalizat').length ?? 0;
  const absente         = data?.filter(p => p.status === 'absent').length ?? 0;
  const venit_azi       = data
    ?.filter(p => p.status === 'finalizat')
    // @ts-ignore — join Supabase
    .reduce((sum, p) => sum + (p.pacienti?.cost ?? 0), 0) ?? 0;

  return { sedinte_total, finalizate, absente, venit_azi, data: today };
}

// ── Statistici SĂPTĂMÂNALE (ultimele 5 zile lucrătoare) ───────
export async function getWeekStats() {
  // Calculăm startul săptămânii curente (Luni)
  const now  = new Date();
  const day  = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);

  const startStr = monday.toISOString().split('T')[0];
  const endStr   = friday.toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('programari')
    .select(`
      data, status,
      pacienti ( cost )
    `)
    .gte('data', startStr)
    .lte('data', endStr);

  if (error) throw new Error('Eroare la citirea statisticilor săptămânale: ' + error.message);

  // Grupare pe zi (L M M J V)
  const byDay: Record<string, { finalizate: number; absente: number; venit: number }> = {};
  data?.forEach(p => {
    if (!byDay[p.data]) byDay[p.data] = { finalizate: 0, absente: 0, venit: 0 };
    if (p.status === 'finalizat') {
      byDay[p.data].finalizate++;
      // @ts-ignore
      byDay[p.data].venit += p.pacienti?.cost ?? 0;
    }
    if (p.status === 'absent') byDay[p.data].absente++;
  });

  const total     = data?.length ?? 0;
  const finalizate = data?.filter(p => p.status === 'finalizat').length ?? 0;
  const absente   = data?.filter(p => p.status === 'absent').length ?? 0;
  const venit     = data
    ?.filter(p => p.status === 'finalizat')
    // @ts-ignore
    .reduce((sum, p) => sum + (p.pacienti?.cost ?? 0), 0) ?? 0;

  const prezenta = total > 0 ? Math.round((finalizate / total) * 100) : 0;

  return { total, finalizate, absente, venit, prezenta, byDay, startStr, endStr };
}

// ── Statistici LUNARE ─────────────────────────────────────────
export async function getMonthStats() {
  const now       = new Date();
  const startStr  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const endStr    = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('programari')
    .select(`
      status,
      pacienti ( cost )
    `)
    .gte('data', startStr)
    .lte('data', endStr);

  if (error) throw new Error('Eroare la citirea statisticilor lunare: ' + error.message);

  const finalizate = data?.filter(p => p.status === 'finalizat').length ?? 0;
  const venit      = data
    ?.filter(p => p.status === 'finalizat')
    // @ts-ignore
    .reduce((sum, p) => sum + (p.pacienti?.cost ?? 0), 0) ?? 0;

  return { finalizate, venit };
}

// ── Pacienți neachitați ───────────────────────────────────────
export async function getUnpaidPatients() {
  const { data, error } = await supabase
    .from('pacienti')
    .select('id, prenume, nume, cost, sedinte_ramase')
    .eq('achitat', false);

  if (error) throw new Error('Eroare la citirea pacienților neachitați: ' + error.message);

  const count  = data?.length ?? 0;
  const totalRON = data?.reduce((sum, p) => sum + (p.cost ?? 0), 0) ?? 0;

  return { count, totalRON, patients: data ?? [] };
}

// ── Istoricul săptămânal (grafic din arhivă) ──────────────────
export async function getWeeklyHistory(limit = 8): Promise<IstericSaptamanal[]> {
  const { data, error } = await supabase
    .from('istoric_saptamanal')
    .select('*')
    .order('saptamana_start', { ascending: false })
    .limit(limit);

  if (error) throw new Error('Eroare la citirea istoricului: ' + error.message);
  return data ?? [];
}

// ── Arhivare manuală (buton "recalculează" din UI) ────────────
export async function recalculateWeek(startDate?: string) {
  const { error } = await supabase.rpc('arhiveaza_saptamana', {
    saptamana_start: startDate ?? null
  });

  if (error) throw new Error('Eroare la arhivarea săptămânii: ' + error.message);
}
