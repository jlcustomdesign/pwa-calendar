/**
 * reportsService.ts — Date pentru ReportsView (statistici + rapoarte)
 * Folosit în: ReportsView.astro
 */
import { supabase } from '../supabase';
import type { IstericSaptamanal } from '../database.types';
import { toLocalISOString } from '../../utils/date';

// ── Statistici pentru AZI ─────────────────────────────────────
export async function getTodayStats(date?: string) {
  const now = new Date();
  const todayStr = toLocalISOString(now);
  const nowStr = now.toTimeString().slice(0, 5); // "HH:MM"
  const targetDate = date ?? todayStr;

  const { data: programariData, error: programariError } = await supabase
    .from('programari')
    .select('status, ora, data, pacient_id, pacienti(cost)')
    .eq('data', targetDate);

  if (programariError) throw new Error('Eroare la citirea programărilor zilnice: ' + programariError.message);

  const { data: platiData } = await supabase
    .from('plati')
    .select('suma')
    .eq('data_platii', targetDate);

  const progList = (programariData || []) as any[];
  const platiList = (platiData || []) as any[];

  const sedinte_total = progList.length;

  // Ședința e finalizată dacă e marcată explicit SAU dacă timpul ei a trecut deja
  const finalizate = progList.filter(p => {
    if (p.status === 'finalizat') return true;
    if (p.status === 'absent') return false;
    if (targetDate < todayStr) return true;
    if (targetDate === todayStr) {
      const pOra = (p.ora || '').slice(0, 5);
      return pOra <= nowStr;
    }
    return false;
  }).length;

  const absente = progList.filter(p => p.status === 'absent').length;

  // Venitul de azi se calculează exclusiv din plățile efectuate azi
  let venit_azi = platiList.reduce((sum, p) => sum + (p.suma || 0), 0);

  return { sedinte_total, finalizate, absente, venit_azi, data: targetDate };
}

// ── Statistici SĂPTĂMÂNALE (Luni - Vineri) ─────────────────────
export async function getWeekStats(baseDate?: string) {
  const realNow = new Date();
  const todayStr = toLocalISOString(realNow);
  const nowStr = realNow.toTimeString().slice(0, 5);
  
  const refDate = baseDate ? new Date(baseDate) : realNow;

  const day = refDate.getDay(); // 0 = Duminică, 1 = Luni...
  const distanceToMonday = (day === 0 ? -6 : 1) - day;

  const monday = new Date(refDate);
  monday.setDate(refDate.getDate() + distanceToMonday);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const startStr = toLocalISOString(monday);
  const endStr = toLocalISOString(sunday);

  const { data: programariData, error: programariError } = await supabase
    .from('programari')
    .select('data, ora, status, pacienti(cost)')
    .gte('data', startStr)
    .lte('data', endStr);

  if (programariError) throw new Error('Eroare la citirea programărilor săptămânale: ' + programariError.message);

  const { data: platiData } = await supabase
    .from('plati')
    .select('data_platii, suma')
    .gte('data_platii', startStr)
    .lte('data_platii', endStr);

  const progList = (programariData || []) as any[];
  const platiList = (platiData || []) as any[];

  const byDay: Record<string, { finalizate: number; absente: number; venit: number }> = {};

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dateStr = toLocalISOString(d);
    byDay[dateStr] = { finalizate: 0, absente: 0, venit: 0 };
  }

  progList.forEach((p: any) => {
    if (!byDay[p.data]) byDay[p.data] = { finalizate: 0, absente: 0, venit: 0 };

    const isPastSession = p.data < todayStr || (p.data === todayStr && (p.ora || '').slice(0, 5) <= nowStr);
    const isDone = p.status === 'finalizat' || (p.status !== 'absent' && isPastSession);

    if (isDone) {
      byDay[p.data].finalizate++;
    }
    if (p.status === 'absent') {
      byDay[p.data].absente++;
    }
  });

  // Dacă există plăți dedicate în tabela `plati`, le adăugăm la venit
  platiList.forEach((p: any) => {
    if (byDay[p.data_platii]) {
      byDay[p.data_platii].venit += (p.suma || 0);
    }
  });

  const total = progList.length;
  const finalizate = Object.values(byDay).reduce((sum, d) => sum + d.finalizate, 0);
  const absente = Object.values(byDay).reduce((sum, d) => sum + d.absente, 0);
  const venit = Object.values(byDay).reduce((sum, d) => sum + d.venit, 0);
  const prezenta = total > 0 ? Math.round((finalizate / total) * 100) : 0;

  const labels = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
  const chartData = labels.map((lbl, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dateStr = toLocalISOString(d);
    return { label: lbl, val: byDay[dateStr]?.venit || 0, dateStr };
  });

  return { total, finalizate, absente, venit, prezenta, chartData, startStr, endStr };
}

// ── Statistici LUNARE ─────────────────────────────────────────
export async function getMonthStats(baseDate?: string) {
  const realNow = new Date();
  const todayStr = toLocalISOString(realNow);
  const nowStr = realNow.toTimeString().slice(0, 5);

  const refDate = baseDate ? new Date(baseDate) : realNow;

  const startStr = toLocalISOString(new Date(refDate.getFullYear(), refDate.getMonth(), 1));
  const endStr = toLocalISOString(new Date(refDate.getFullYear(), refDate.getMonth() + 1, 0));

  const { data: programariData, error: programariError } = await supabase
    .from('programari')
    .select('data, ora, status, pacienti(cost)')
    .gte('data', startStr)
    .lte('data', endStr);

  if (programariError) throw new Error('Eroare la citirea programărilor lunare: ' + programariError.message);

  const { data: platiData } = await supabase
    .from('plati')
    .select('suma, data_platii')
    .gte('data_platii', startStr)
    .lte('data_platii', endStr);

  const progList = (programariData || []) as any[];
  const platiList = (platiData || []) as any[];

  const total = progList.length;
  const finalizate = progList.filter(p => {
    if (p.status === 'finalizat') return true;
    if (p.status === 'absent') return false;
    if (p.data < todayStr) return true;
    if (p.data === todayStr) return (p.ora || '').slice(0, 5) <= nowStr;
    return false;
  }).length;
  const absente = progList.filter(p => p.status === 'absent').length;

  let venit = platiList.reduce((sum, p) => sum + (p.suma || 0), 0);

  const byPeriod = [0, 0, 0, 0];
  platiList.forEach((p: any) => {
    if (!p.data_platii) return;
    const parts = p.data_platii.split('T')[0].split('-');
    const d = parseInt(parts[2], 10);
    if (!isNaN(d)) {
      let idx = Math.floor((d - 1) / 8); 
      if (idx > 3) idx = 3; 
      byPeriod[idx] += (p.suma || 0);
    }
  });
  
  const chartData = byPeriod.map((val, i) => {
    const d = new Date(refDate.getFullYear(), refDate.getMonth(), i * 8 + 1);
    return { label: `S${i+1}`, val, dateStr: toLocalISOString(d) };
  });

  return { total, finalizate, absente, venit, chartData, startStr, endStr };
}

// ── Statistici TRIMESTRIALE ───────────────────────────────────
export async function getQuarterStats(baseDate?: string) {
  const realNow = new Date();
  const todayStr = toLocalISOString(realNow);
  const nowStr = realNow.toTimeString().slice(0, 5);

  const refDate = baseDate ? new Date(baseDate) : realNow;
  const currentQuarter = Math.floor(refDate.getMonth() / 3);
  const startStr = toLocalISOString(new Date(refDate.getFullYear(), currentQuarter * 3, 1));
  const endStr = toLocalISOString(new Date(refDate.getFullYear(), currentQuarter * 3 + 3, 0));

  const { data: programariData, error: programariError } = await supabase
    .from('programari')
    .select('data, ora, status, pacienti(cost)')
    .gte('data', startStr)
    .lte('data', endStr);

  if (programariError) throw new Error('Eroare la citirea programărilor trimestriale: ' + programariError.message);

  const { data: platiData } = await supabase
    .from('plati')
    .select('suma, data_platii')
    .gte('data_platii', startStr)
    .lte('data_platii', endStr);

  const progList = (programariData || []) as any[];
  const platiList = (platiData || []) as any[];

  const total = progList.length;
  const finalizate = progList.filter(p => {
    if (p.status === 'finalizat') return true;
    if (p.status === 'absent') return false;
    if (p.data < todayStr) return true;
    if (p.data === todayStr) return (p.ora || '').slice(0, 5) <= nowStr;
    return false;
  }).length;
  const absente = progList.filter(p => p.status === 'absent').length;

  let venit = platiList.reduce((sum, p) => sum + (p.suma || 0), 0);

  const byMonth = [0, 0, 0];
  platiList.forEach((p: any) => {
    if (!p.data_platii) return;
    const parts = p.data_platii.split('T')[0].split('-');
    const m = (parseInt(parts[1], 10) - 1) % 3;
    if (!isNaN(m) && m >= 0 && m < 3) {
      byMonth[m] += (p.suma || 0);
    }
  });
  
  const monthNames = ['Ian', 'Feb', 'Mar', 'Apr', 'Mai', 'Iun', 'Iul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const chartData = byMonth.map((val, i) => {
    const mIdx = currentQuarter * 3 + i;
    const d = new Date(refDate.getFullYear(), mIdx, 1);
    return { label: monthNames[mIdx], val, dateStr: toLocalISOString(d) };
  });

  return { total, finalizate, absente, venit, chartData, startStr, endStr };
}

// ── Statistici ANUALE ─────────────────────────────────────────
export async function getYearStats(baseDate?: string) {
  const realNow = new Date();
  const todayStr = toLocalISOString(realNow);
  const nowStr = realNow.toTimeString().slice(0, 5);

  const refDate = baseDate ? new Date(baseDate) : realNow;
  const startStr = toLocalISOString(new Date(refDate.getFullYear(), 0, 1));
  const endStr = toLocalISOString(new Date(refDate.getFullYear(), 12, 0));

  const { data: programariData, error: programariError } = await supabase
    .from('programari')
    .select('data, ora, status, pacienti(cost)')
    .gte('data', startStr)
    .lte('data', endStr);

  if (programariError) throw new Error('Eroare la citirea programărilor anuale: ' + programariError.message);

  const { data: platiData } = await supabase
    .from('plati')
    .select('suma, data_platii')
    .gte('data_platii', startStr)
    .lte('data_platii', endStr);

  const progList = (programariData || []) as any[];
  const platiList = (platiData || []) as any[];

  const total = progList.length;
  const finalizate = progList.filter(p => {
    if (p.status === 'finalizat') return true;
    if (p.status === 'absent') return false;
    if (p.data < todayStr) return true;
    if (p.data === todayStr) return (p.ora || '').slice(0, 5) <= nowStr;
    return false;
  }).length;
  const absente = progList.filter(p => p.status === 'absent').length;

  let venit = platiList.reduce((sum, p) => sum + (p.suma || 0), 0);

  const byMonth = Array(12).fill(0);
  platiList.forEach((p: any) => {
    if (!p.data_platii) return;
    const parts = p.data_platii.split('T')[0].split('-');
    const m = parseInt(parts[1], 10) - 1;
    if (!isNaN(m) && m >= 0 && m < 12) {
      byMonth[m] += (p.suma || 0);
    }
  });
  
  const initialLetters = ['I', 'F', 'M', 'A', 'M', 'I', 'I', 'A', 'S', 'O', 'N', 'D'];
  const chartData = byMonth.map((val, i) => {
    const d = new Date(refDate.getFullYear(), i, 1);
    return { label: initialLetters[i], val, dateStr: toLocalISOString(d) };
  });

  return { total, finalizate, absente, venit, chartData, startStr, endStr };
}

// ── Pacienți neachitați ───────────────────────────────────────
export async function getUnpaidPatients() {
  const { data: rawPatients, error: pErr } = await supabase
    .from('pacienti')
    .select('id, prenume, nume, cost, achitat');

  if (pErr) throw new Error('Eroare la citirea pacienților neachitați: ' + pErr.message);

  const { data: rawPlati } = await supabase
    .from('plati')
    .select('pacient_id, suma');

  const patientsList = (rawPatients || []) as any[];
  const platiList = (rawPlati || []) as any[];

  // Calculăm plățile totale făcute de fiecare pacient
  const paymentsByPatient: Record<string, number> = {};
  platiList.forEach(p => {
    if (p.pacient_id) {
      paymentsByPatient[p.pacient_id] = (paymentsByPatient[p.pacient_id] || 0) + Number(p.suma || 0);
    }
  });

  const unpaidPatients: any[] = [];
  let totalDatorat = 0;

  patientsList.forEach(p => {
    const cost = Number(p.cost || 0);
    const paid = paymentsByPatient[p.id] || 0;
    const isFullyPaid = p.achitat === true || (cost > 0 && paid >= cost);

    if (!isFullyPaid) {
      const rest = Math.max(0, cost - paid);
      unpaidPatients.push({
        ...p,
        suma_restanta: rest > 0 ? rest : cost
      });
      totalDatorat += rest > 0 ? rest : cost;
    }
  });

  return { count: unpaidPatients.length, totalRON: totalDatorat, patients: unpaidPatients };
}

// ── Istoricul săptămânal ──────────────────────────────────────
export async function getWeeklyHistory(limit = 8): Promise<IstericSaptamanal[]> {
  const { data, error } = await supabase
    .from('istoric_saptamanal')
    .select('*')
    .order('saptamana_start', { ascending: false })
    .limit(limit);

  if (error) throw new Error('Eroare la citirea istoricului: ' + error.message);
  return data ?? [];
}

// ── Arhivare manuală ──────────────────────────────────────────
export async function recalculateWeek(startDate?: string) {
  const { error } = await supabase.rpc('arhiveaza_saptamana', {
    saptamana_start: startDate ?? null
  } as any);

  if (error) throw new Error('Eroare la arhivarea săptămânii: ' + error.message);
}
