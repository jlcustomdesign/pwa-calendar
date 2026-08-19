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
  const targetDate = date ?? todayStr;

  const { data: programariData, error: programariError } = await supabase
    .from('programari')
    .select('status, ora, data, pacient_id, pacienti(cost, achitat, sedinte_total)')
    .eq('data', targetDate);

  if (programariError) throw new Error('Eroare la citirea programărilor zilnice: ' + programariError.message);

  const { data: platiData } = await supabase
    .from('plati')
    .select('suma, pacient_id')
    .eq('data_platii', targetDate);

  const progList = (programariData || []) as any[];
  const platiList = (platiData || []) as any[];

  const sedinte_total = progList.length;

  // Ședința e finalizată DOAR dacă statusul ei este 'finalizat' sau 'finalizata'
  const finalizate = progList.filter(p => p.status === 'finalizat' || p.status === 'finalizata').length;
  const absente = progList.filter(p => p.status === 'absent').length;

  // 1. Încasări reale din plăți înregistrate azi
  let venit_azi = platiList.reduce((sum, p) => sum + Number(p.suma || 0), 0);

  // 2. Dacă nu sunt plăți înregistrate explicit azi, dar avem ședințe finalizate
  // ale pacienților deja achitați integral (achitat = true), calculăm valoarea ședințelor finalizate azi
  if (venit_azi === 0 && finalizate > 0) {
    venit_azi = progList
      .filter(p => (p.status === 'finalizat' || p.status === 'finalizata') && p.pacienti?.achitat === true)
      .reduce((sum, p) => {
        const costTotal = Number(p.pacienti?.cost || 0);
        const sedinteTotal = Number(p.pacienti?.sedinte_total || 1);
        return sum + (sedinteTotal > 0 ? costTotal / sedinteTotal : costTotal);
      }, 0);
  }

  return { sedinte_total, finalizate, absente, venit_azi: Math.round(venit_azi), data: targetDate };
}

// ── Statistici SĂPTĂMÂNALE (Luni - Duminică) ─────────────────────
export async function getWeekStats(baseDate?: string) {
  const realNow = new Date();
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
    .select('data, ora, status, pacient_id, pacienti(cost, sedinte_total, achitat)')
    .gte('data', startStr)
    .lte('data', endStr);

  if (programariError) throw new Error('Eroare la citirea programărilor săptămânale: ' + programariError.message);

  const { data: platiData } = await supabase
    .from('plati')
    .select('data_platii, suma, pacient_id')
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
    const isDone = p.status === 'finalizat' || p.status === 'finalizata';

    if (isDone) {
      byDay[p.data].finalizate++;
      // Dacă pacientul este deja achitat integral și nu avem plată separată
      if (p.pacienti?.achitat === true) {
        const costTotal = Number(p.pacienti?.cost || 0);
        const sedinteTotal = Number(p.pacienti?.sedinte_total || 1);
        const costPerSedinta = sedinteTotal > 0 ? costTotal / sedinteTotal : costTotal;
        byDay[p.data].venit += costPerSedinta;
      }
    }
    if (p.status === 'absent') {
      byDay[p.data].absente++;
    }
  });

  // Plățile reale din tabela `plati` pe zile
  const platiByDay: Record<string, number> = {};
  platiList.forEach((p: any) => {
    if (p.data_platii) {
      const dStr = p.data_platii.split('T')[0];
      platiByDay[dStr] = (platiByDay[dStr] || 0) + Number(p.suma || 0);
    }
  });

  Object.keys(byDay).forEach(dStr => {
    if (platiByDay[dStr] !== undefined && platiByDay[dStr] > 0) {
      byDay[dStr].venit = platiByDay[dStr];
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
    return { label: lbl, val: Math.round(byDay[dateStr]?.venit || 0), dateStr };
  });

  return { total, finalizate, absente, venit: Math.round(venit), prezenta, chartData, startStr, endStr };
}

// ── Statistici LUNARE ─────────────────────────────────────────
export async function getMonthStats(baseDate?: string) {
  const realNow = new Date();
  const refDate = baseDate ? new Date(baseDate) : realNow;

  const startStr = toLocalISOString(new Date(refDate.getFullYear(), refDate.getMonth(), 1));
  const endStr = toLocalISOString(new Date(refDate.getFullYear(), refDate.getMonth() + 1, 0));

  const { data: programariData, error: programariError } = await supabase
    .from('programari')
    .select('data, ora, status, pacienti(cost, sedinte_total, achitat)')
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
  const finalizate = progList.filter(p => p.status === 'finalizat' || p.status === 'finalizata').length;
  const absente = progList.filter(p => p.status === 'absent').length;

  let venitPlati = platiList.reduce((sum, p) => sum + Number(p.suma || 0), 0);
  let venitSedinte = progList
    .filter(p => (p.status === 'finalizat' || p.status === 'finalizata') && p.pacienti?.achitat === true)
    .reduce((sum, p) => {
      const costTotal = Number(p.pacienti?.cost || 0);
      const sedinteTotal = Number(p.pacienti?.sedinte_total || 1);
      const costPerSedinta = sedinteTotal > 0 ? costTotal / sedinteTotal : costTotal;
      return sum + costPerSedinta;
    }, 0);

  let venit = venitPlati > 0 ? venitPlati : venitSedinte;

  const byPeriod = [0, 0, 0, 0];
  const itemsToDistribute = platiList.length > 0 
    ? platiList 
    : progList.filter(p => (p.status === 'finalizat' || p.status === 'finalizata') && p.pacienti?.achitat === true);

  itemsToDistribute.forEach((item: any) => {
    const dateField = item.data_platii || item.data;
    if (!dateField) return;
    const parts = dateField.split('T')[0].split('-');
    const d = parseInt(parts[2], 10);
    const sedinteTotal = Number(item.pacienti?.sedinte_total || 1);
    const costTotal = Number(item.pacienti?.cost || 0);
    const amount = Number(item.suma || (sedinteTotal > 0 ? costTotal / sedinteTotal : costTotal));
    if (!isNaN(d)) {
      let idx = Math.floor((d - 1) / 8);
      if (idx > 3) idx = 3;
      byPeriod[idx] += amount;
    }
  });

  const chartData = byPeriod.map((val, i) => {
    const d = new Date(refDate.getFullYear(), refDate.getMonth(), i * 8 + 1);
    return { label: `S${i+1}`, val: Math.round(val), dateStr: toLocalISOString(d) };
  });

  return { total, finalizate, absente, venit: Math.round(venit), chartData, startStr, endStr };
}

// ── Statistici TRIMESTRIALE ───────────────────────────────────
export async function getQuarterStats(baseDate?: string) {
  const realNow = new Date();
  const refDate = baseDate ? new Date(baseDate) : realNow;
  const currentQuarter = Math.floor(refDate.getMonth() / 3);
  const startStr = toLocalISOString(new Date(refDate.getFullYear(), currentQuarter * 3, 1));
  const endStr = toLocalISOString(new Date(refDate.getFullYear(), currentQuarter * 3 + 3, 0));

  const { data: programariData, error: programariError } = await supabase
    .from('programari')
    .select('data, ora, status, pacienti(cost, sedinte_total, achitat)')
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
  const finalizate = progList.filter(p => p.status === 'finalizat' || p.status === 'finalizata').length;
  const absente = progList.filter(p => p.status === 'absent').length;

  let venitPlati = platiList.reduce((sum, p) => sum + Number(p.suma || 0), 0);
  let venitSedinte = progList
    .filter(p => (p.status === 'finalizat' || p.status === 'finalizata') && p.pacienti?.achitat === true)
    .reduce((sum, p) => {
      const costTotal = Number(p.pacienti?.cost || 0);
      const sedinteTotal = Number(p.pacienti?.sedinte_total || 1);
      return sum + (sedinteTotal > 0 ? costTotal / sedinteTotal : costTotal);
    }, 0);

  let venit = venitPlati > 0 ? venitPlati : venitSedinte;

  const byMonth = [0, 0, 0];
  const itemsToDistribute = platiList.length > 0 
    ? platiList 
    : progList.filter(p => (p.status === 'finalizat' || p.status === 'finalizata') && p.pacienti?.achitat === true);

  itemsToDistribute.forEach((item: any) => {
    const dateField = item.data_platii || item.data;
    if (!dateField) return;
    const parts = dateField.split('T')[0].split('-');
    const m = (parseInt(parts[1], 10) - 1) % 3;
    const sedinteTotal = Number(item.pacienti?.sedinte_total || 1);
    const costTotal = Number(item.pacienti?.cost || 0);
    const amount = Number(item.suma || (sedinteTotal > 0 ? costTotal / sedinteTotal : costTotal));
    if (!isNaN(m) && m >= 0 && m < 3) {
      byMonth[m] += amount;
    }
  });

  const monthNames = ['Ian', 'Feb', 'Mar', 'Apr', 'Mai', 'Iun', 'Iul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const chartData = byMonth.map((val, i) => {
    const mIdx = currentQuarter * 3 + i;
    const d = new Date(refDate.getFullYear(), mIdx, 1);
    return { label: monthNames[mIdx], val: Math.round(val), dateStr: toLocalISOString(d) };
  });

  return { total, finalizate, absente, venit: Math.round(venit), chartData, startStr, endStr };
}

// ── Statistici ANUALE ─────────────────────────────────────────
export async function getYearStats(baseDate?: string) {
  const realNow = new Date();
  const refDate = baseDate ? new Date(baseDate) : realNow;
  const startStr = toLocalISOString(new Date(refDate.getFullYear(), 0, 1));
  const endStr = toLocalISOString(new Date(refDate.getFullYear(), 12, 0));

  const { data: programariData, error: programariError } = await supabase
    .from('programari')
    .select('data, ora, status, pacienti(cost, sedinte_total, achitat)')
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
  const finalizate = progList.filter(p => p.status === 'finalizat' || p.status === 'finalizata').length;
  const absente = progList.filter(p => p.status === 'absent').length;

  let venitPlati = platiList.reduce((sum, p) => sum + Number(p.suma || 0), 0);
  let venitSedinte = progList
    .filter(p => (p.status === 'finalizat' || p.status === 'finalizata') && p.pacienti?.achitat === true)
    .reduce((sum, p) => {
      const costTotal = Number(p.pacienti?.cost || 0);
      const sedinteTotal = Number(p.pacienti?.sedinte_total || 1);
      return sum + (sedinteTotal > 0 ? costTotal / sedinteTotal : costTotal);
    }, 0);

  let venit = venitPlati > 0 ? venitPlati : venitSedinte;

  const byMonth = Array(12).fill(0);
  const itemsToDistribute = platiList.length > 0 
    ? platiList 
    : progList.filter(p => (p.status === 'finalizat' || p.status === 'finalizata') && p.pacienti?.achitat === true);

  itemsToDistribute.forEach((item: any) => {
    const dateField = item.data_platii || item.data;
    if (!dateField) return;
    const parts = dateField.split('T')[0].split('-');
    const m = parseInt(parts[1], 10) - 1;
    const sedinteTotal = Number(item.pacienti?.sedinte_total || 1);
    const costTotal = Number(item.pacienti?.cost || 0);
    const amount = Number(item.suma || (sedinteTotal > 0 ? costTotal / sedinteTotal : costTotal));
    if (!isNaN(m) && m >= 0 && m < 12) {
      byMonth[m] += amount;
    }
  });

  const initialLetters = ['I', 'F', 'M', 'A', 'M', 'I', 'I', 'A', 'S', 'O', 'N', 'D'];
  const chartData = byMonth.map((val, i) => {
    const d = new Date(refDate.getFullYear(), i, 1);
    return { label: initialLetters[i], val: Math.round(val), dateStr: toLocalISOString(d) };
  });

  return { total, finalizate, absente, venit: Math.round(venit), chartData, startStr, endStr };
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
  const { error } = await (supabase as any).rpc('arhiveaza_saptamana', {
    saptamana_start: startDate ?? null
  } as any);

  if (error) throw new Error('Eroare la arhivarea săptămânii: ' + error.message);
}