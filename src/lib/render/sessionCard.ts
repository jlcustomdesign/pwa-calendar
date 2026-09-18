/**
 * sessionCard.ts — randare unică pentru cardurile de ședință.
 *
 * Logica de card era furată între calendar.astro și AgendaBlock.astro și
 * divergase deja (progres abonament epuizat, padding-ul orei, ordinea
 * condițiilor pentru badge-ul de plată, marcajul „În afara pachetului").
 * Aici există o singură implementare, consumată de ambele pagini.
 *
 * Rulează DOAR în browser (este importat din <script>-urile paginilor).
 * Păstrează arhitectura cu onclick inline + handleri window.* din DashboardLayout.
 */

import { supabase, getCurrentUser } from '../supabase';
import { EVENTS } from '../events';
import { escapeHtml, escapeJsString } from '../../utils/html';

export interface SessionCardContext {
  /** Ziua afișată (YYYY-MM-DD) — currentCalendarDate / currentAgendaDate. */
  currentDate: string;
  /** Durata unei ședințe în minute (settings.session_duration). */
  sessionDuration: number;
  /**
   * 'timeline' = calendar.astro (fără watermark, cu data-session-time/date pentru drag&drop),
   * 'agenda'   = AgendaBlock.astro (watermark cu ora, margini, member cards swipe-able).
   */
  variant?: 'timeline' | 'agenda';
}

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Același localStorage key ca în patientService (kineto_dismissed_renewals) —
// reimplementat aici ca modulul să nu depindă de servicii.
function isRenewalDismissed(patientId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const dismissed = JSON.parse(localStorage.getItem('kineto_dismissed_renewals') || '[]');
    return Array.isArray(dismissed) && dismissed.includes(patientId);
  } catch {
    return false;
  }
}

// ── Plăți: o singură interogare pentru toți pacienții zilei ─────
// Înlocuiește getPatientPayments() apelat câte o dată pe programare (N+1).
// Replică aceeași ierarhie de surse: rânduri DB > fallback localStorage.
export async function fetchPaymentsForPatients(patientIds: string[]): Promise<Map<string, number>> {
  const uniqueIds = [...new Set((patientIds || []).filter(Boolean))] as string[];
  const totals = new Map<string, number>();
  if (uniqueIds.length === 0) return totals;

  const readLocalFallback = (id: string): number => {
    try {
      const raw = localStorage.getItem(`kineto_plati_${id}`);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.reduce((t: number, p: any) => t + (p.suma || 0), 0);
      }
    } catch {
      // ignore — fallbackul local e best-effort
    }
    return 0;
  };

  try {
    const user = await getCurrentUser();
    const { data, error } = await (supabase as any)
      .from('plati')
      .select('pacient_id, suma')
      .in('pacient_id', uniqueIds)
      .eq('user_id', user.id);
    if (error) throw error;

    const dbTotals = new Map<string, number>();
    for (const row of (data ?? []) as any[]) {
      dbTotals.set(row.pacient_id, (dbTotals.get(row.pacient_id) || 0) + (row.suma || 0));
    }
    for (const id of uniqueIds) {
      totals.set(id, dbTotals.has(id) ? dbTotals.get(id)! : readLocalFallback(id));
    }
    return totals;
  } catch (e) {
    // Fallback la câte o interogare per pacient dacă cea grupată eșuează.
    console.error('Eroare citire plăți (interogare grupată); se încearcă per pacient:', e);
    const user = await getCurrentUser();
    await Promise.all(uniqueIds.map(async (id) => {
      try {
        const { data, error } = await (supabase as any)
          .from('plati')
          .select('suma')
          .eq('pacient_id', id)
          .eq('user_id', user.id);
        if (error) throw error;
        const rows = (data ?? []) as any[];
        const dbTotal = rows.reduce((t: number, p: any) => t + (p.suma || 0), 0);
        totals.set(id, rows.length > 0 ? dbTotal : readLocalFallback(id));
      } catch (perPatientError) {
        console.error(`Eroare citire plăți pentru pacientul ${id}:`, perPatientError);
        totals.set(id, readLocalFallback(id));
      }
    }));
    return totals;
  }
}

// ── „În afara pachetului” (cerere vs ofertă) ────────────────────
// Marchează programările viitoare care depășesc ședințele rămase:
// poziția în lista viitoare a pacientului > ședințe rămase.
// Eșecul nu oprește randarea — doar se sare marcajul (ca înainte).
export async function applyBeyondSupplyMarks(sessions: any[]): Promise<void> {
  if (!Array.isArray(sessions) || sessions.length === 0) return;
  try {
    const todayStr = localDateStr();
    const patientIds = [...new Set(sessions.map((s: any) => s.patientId).filter(Boolean))] as string[];
    if (patientIds.length === 0) return;

    const user = await getCurrentUser();
    const { data, error } = await (supabase as any)
      .from('programari')
      .select('id, pacient_id, data, ora')
      .in('pacient_id', patientIds)
      .eq('user_id', user.id)
      .gte('data', todayStr)
      .in('status', ['programat', 'confirmat'])
      .order('data', { ascending: true })
      .order('ora', { ascending: true });
    if (error) throw error;

    const byPatient = new Map<string, any[]>();
    for (const fa of (data ?? []) as any[]) {
      if (!byPatient.has(fa.pacient_id)) byPatient.set(fa.pacient_id, []);
      byPatient.get(fa.pacient_id)!.push(fa);
    }
    for (const s of sessions) {
      s.beyondSupply = false;
      if (!s.patientId || !['programat', 'confirmat'].includes(s.status)) continue;
      if ((s.selectedDate || '') < todayStr) continue;
      const list = byPatient.get(s.patientId) || [];
      const pos = list.findIndex((fa: any) => fa.id === s.id);
      if (pos >= 0 && pos + 1 > (s.remainingSessions || 0)) s.beyondSupply = true;
    }
  } catch (e) {
    console.warn('Marcaj „în afara pachetului” indisponibil:', e);
  }
}

// ── Grupare sesiuni (group_id sau aceeași oră) ──────────────────
export function groupSessions(sessions: any[], currentDate: string): any[] {
  const groups = new Map<string, any[]>();
  const singles: any[] = [];

  for (const s of sessions) {
    if (s.groupId) {
      if (!groups.has(s.groupId)) groups.set(s.groupId, []);
      groups.get(s.groupId)!.push(s);
    } else {
      singles.push(s);
    }
  }

  const byTime = new Map<string, any[]>();
  const trueSingles: any[] = [];
  for (const s of singles) {
    const timeKey = (s.selectedTime || '08:00').substring(0, 5);
    if (!byTime.has(timeKey)) byTime.set(timeKey, []);
    byTime.get(timeKey)!.push(s);
  }

  for (const [tKey, sameTimeList] of byTime) {
    if (sameTimeList.length > 1) {
      const autoGroupId = `time_group_${sameTimeList[0].selectedDate || currentDate}_${tKey}`;
      groups.set(autoGroupId, sameTimeList);
    } else {
      trueSingles.push(sameTimeList[0]);
    }
  }

  const result: any[] = [...trueSingles];
  for (const [gId, members] of groups) {
    if (members.length === 1) {
      result.push(members[0]);
    } else {
      result.push({
        isGroup: true,
        groupId: members[0].groupId || gId,
        members,
        selectedTime: members[0].selectedTime,
        selectedDate: members[0].selectedDate,
        location: members[0].location,
        status: members.some((m: any) => m.status === 'programat') ? 'programat' : members[0].status,
      });
    }
  }

  return result;
}

// ── Status plată (badge) ────────────────────────────────────────
// Regula unică pentru cardul individual: se verifică mai întâi statusul
// explicit al plății (ordinea canonică din calendar).
function deriveSinglePaymentBadge(session: any): { label: string; badgeClass: string } {
  const sumaIncasata = session.sumaIncasata || 0;
  const costTotal = session.costTotal || 0;
  const restDePlata = Math.max(0, costTotal - sumaIncasata);
  const isPaid = restDePlata <= 0 || session.paymentStatus === 'Achitat integral' || session.paymentStatus === 'Achitat';

  if (session.paymentStatus === 'Achitat parțial' || (sumaIncasata > 0 && restDePlata > 0)) {
    return {
      label: `${sumaIncasata}/${costTotal} RON`,
      badgeClass: 'bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-200/60 font-black shadow-sm',
    };
  }
  if (session.paymentStatus === 'Achitat integral' || session.paymentStatus === 'Achitat' || (costTotal > 0 && sumaIncasata >= costTotal && isPaid)) {
    return {
      label: 'Achitat',
      badgeClass: 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-transparent font-extrabold shadow-sm',
    };
  }
  return {
    label: 'Neachitat',
    badgeClass: 'bg-rose-50 hover:bg-rose-100 text-rose-700 border border-transparent font-extrabold shadow-sm',
  };
}

// Regula pentru cardurile de membru din grup: suma încasată primește
// prioritate (identic în ambele pagini înainte de unificare).
function deriveMemberPaymentBadge(m: any): { label: string; badgeClass: string } {
  const sumaIncasata = m.sumaIncasata || 0;
  const costTotal = m.costTotal || 0;
  const restDePlata = Math.max(0, costTotal - sumaIncasata);
  const isPaid = restDePlata <= 0 || m.paymentStatus === 'Achitat integral' || m.paymentStatus === 'Achitat';

  if (sumaIncasata > 0 && restDePlata > 0) {
    return {
      label: `${sumaIncasata}/${costTotal} RON`,
      badgeClass: 'bg-amber-100 hover:bg-amber-200 text-amber-900 font-black',
    };
  }
  if (isPaid || m.paymentStatus === 'Achitat integral' || m.paymentStatus === 'Achitat' || (costTotal > 0 && sumaIncasata >= costTotal)) {
    return {
      label: 'Achitat',
      badgeClass: 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-extrabold',
    };
  }
  return {
    label: 'Neachitat',
    badgeClass: 'bg-rose-50 hover:bg-rose-100 text-rose-700 font-extrabold',
  };
}

// ── Card individual ─────────────────────────────────────────────
export function createSessionCardHTML(session: any, isContinuation: boolean, ctx: SessionCardContext): string {
  const { currentDate, sessionDuration, variant = 'timeline' } = ctx;
  const todayStr = localDateStr();
  const isAgenda = variant === 'agenda';

  const locationStr = session.location || 'Ghimbav';
  const isGhimbav = locationStr.toLowerCase() === 'ghimbav';
  const cardClasses = isGhimbav ? 'bg-brand-secondary text-white' : 'bg-brand-primary text-black';
  const continuationClass = isContinuation ? 'opacity-70 border-l-4 border-black/20' : '';

  const count = session.attendanceCount ?? 0;
  const totalSess = session.totalSessions || 10;
  // Abonament epuizat: aceeași regulă în calendar și agendă — progres plin
  // („10/10” în rândul de progres) și „0/N ședințe” rămase în avertizare.
  const isTerminat = session.subscriptionDone || (totalSess > 0 && count >= totalSess);
  const displayCount = isTerminat ? totalSess : count;
  const progressPercentage = isTerminat ? 100 : (totalSess > 0 ? Math.min(100, Math.round((count / totalSess) * 100)) : 0);
  const progressBarFill = isGhimbav ? 'bg-brand-primary' : 'bg-brand-secondary';
  const progressBarTrack = isGhimbav ? 'bg-black/20' : 'bg-black/15';

  const rawTime = session.selectedTime || session.time || '08:00';
  const cleanTimeStr = rawTime.substring(0, 5);
  const patientNameStr = session.patientName || 'Pacient';
  const safePatientName = escapeHtml(patientNameStr);
  const safePatientNameJs = escapeJsString(session.patientName || '');
  const safeLocation = escapeHtml(locationStr);
  const safePhone = escapeHtml(session.patientPhone || '+1234567890');
  const timeParts = cleanTimeStr.split(':');
  const startH = parseInt(timeParts[0] || '8', 10);
  const startM = parseInt(timeParts[1] || '0', 10);
  const totalStartMin = startH * 60 + startM;
  const totalEndMin = totalStartMin + sessionDuration;
  const endH = Math.floor(totalEndMin / 60);
  const endM = totalEndMin % 60;
  const formattedStart = `${startH.toString().padStart(2, '0')}:${startM.toString().padStart(2, '0')}`;
  const formattedEnd = `${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}`;
  const timeRangeText = `${formattedStart} - ${formattedEnd}`;

  const now = new Date();
  const nowStr = now.toTimeString().slice(0, 5);
  const isToday = currentDate === todayStr;

  const sessionStatus = session.status || 'programat';
  const isOngoing = isToday && nowStr >= cleanTimeStr && nowStr < formattedEnd;

  // Icon-only status indicator for closed state
  // Bifa verde apare DOAR după confirmare (status = finalizat), nu doar pentru că a trecut ora.
  let statusIcon = '';
  if (sessionStatus === 'absent') {
    statusIcon = `<svg class="w-6 h-6 text-orange-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>`;
  } else if (sessionStatus === 'anulat') {
    statusIcon = `<svg class="w-6 h-6 text-rose-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>`;
  } else if (sessionStatus === 'finalizat') {
    statusIcon = `<svg class="w-6 h-6 ${isGhimbav ? 'text-brand-primary' : 'text-brand-secondary'} shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5" d="M5 13l4 4L19 7"/></svg>`;
  } else if (isOngoing) {
    statusIcon = `<svg class="w-7 h-7 ${isGhimbav ? 'text-brand-primary' : 'text-brand-secondary'} shrink-0 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
  }

  const beyondSupplyBadge = session.beyondSupply
    ? `<span class="shrink-0 px-2.5 py-1 rounded-full bg-amber-100 border border-amber-300 text-amber-900 text-[10px] font-black uppercase tracking-wide" title="În afara pachetului — devine activă la reînnoire">În afara pachetului</span>`
    : '';

  const subscriptionWarningDetails = isTerminat && !isRenewalDismissed(session.patientId)
    ? `<div class="px-6 pb-3">
        <div class="flex items-center gap-3 rounded-2xl bg-brand-secondary/15 border border-brand-secondary/30 p-3">
          <div class="flex-1 min-w-0">
            <p class="text-xs sm:text-sm font-black text-black truncate">Abonament terminat</p>
            <p class="text-[10px] font-bold text-black/70">0/${session.totalSessions || 10} ședințe</p>
          </div>
          <button type="button" class="shrink-0 px-4 py-2.5 rounded-full bg-brand-secondary text-black text-xs font-black uppercase tracking-wide shadow-sm active:scale-95 transition-transform" onclick="event.stopPropagation(); window.renewSubscription('${session.patientId}', ${session.totalSessions || 10}, '${safePatientNameJs}')">Reînnoiește</button>
          <button type="button" class="shrink-0 w-9 h-9 rounded-full bg-surface-card text-text-muted flex items-center justify-center active:scale-95 transition-transform" onclick="event.stopPropagation(); window.dismissSubscriptionWarning('${session.patientId}')" aria-label="Nu acum">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
      </div>`
    : '';

  const payment = deriveSinglePaymentBadge(session);

  const driveLink = session.driveLink || session.patientDriveLink || '';
  const safeDriveLink = escapeHtml(driveLink || '#');
  const hasDriveLink = Boolean(driveLink);

  const rootClasses = isAgenda
    ? 'block relative rounded-[2.5rem] shadow-sm overflow-hidden mx-1 md:mx-5'
    : `block relative rounded-[2.5rem] shadow-sm overflow-hidden ${continuationClass}`;
  const rootAttrs = isAgenda
    ? `data-session-id="${session.id}"`
    : `data-session-id="${session.id}" data-session-time="${cleanTimeStr}" data-session-date="${session.selectedDate || currentDate}"`;

  const watermark = isAgenda
    ? `<div class="absolute left-3 top-0 bottom-0 font-black text-[3.8rem] leading-[0.8] opacity-50 pointer-events-none tracking-tighter flex items-center justify-start z-0 w-20">
        <div class="flex items-start">
          ${startH.toString().padStart(2, '0')}
          <span class="text-xl mt-1 ml-0.5">${startM.toString().padStart(2, '0')}</span>
        </div>
      </div>`
    : '';
  const summaryClasses = isAgenda
    ? 'card-summary relative z-20 flex items-center justify-between cursor-pointer transition-transform active:scale-[0.98] min-h-[85px] py-5 px-6'
    : 'card-summary relative z-20 flex flex-col justify-between cursor-pointer transition-transform active:scale-[0.98] min-h-[80px] p-6';
  const summaryRowClasses = isAgenda
    ? 'flex items-center gap-3 w-full relative z-10 pl-24 justify-between'
    : 'flex items-center gap-3 w-full relative z-10 justify-between';
  const paymentRowClasses = isAgenda
    ? 'flex items-center justify-between pt-0.5 gap-4'
    : 'flex items-center justify-between pt-0.5';
  const paymentBtnClasses = isAgenda
    ? `h-11 flex items-center justify-center px-4 rounded-2xl ${payment.badgeClass} hover:opacity-90 active:scale-95 transition-all text-sm sm:text-base font-black cursor-pointer shadow-sm`
    : `h-11 flex items-center justify-center px-6 rounded-2xl ${payment.badgeClass} hover:opacity-90 active:scale-95 transition-all text-sm sm:text-base font-black cursor-pointer shadow-sm whitespace-nowrap`;

  return `
    <session-card class="${rootClasses}" ${rootAttrs}>
      <div class="relative w-full h-full rounded-[2.5rem] overflow-hidden">
        
        <!-- Swipe Action Background -->
        <div class="absolute inset-0 bg-neutral-100 flex items-center justify-end px-6 z-0">
          <div class="flex items-center gap-3" data-action-area>
            <button 
              type="button" 
              data-action-btn
              class="relative z-20 w-12 h-12 rounded-full bg-white shadow-sm text-black flex items-center justify-center active:scale-95 transition-transform border border-transparent" 
              onclick="event.stopPropagation(); event.preventDefault(); window.editSession('${session.id}');"
            >
              <svg class="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.89 1.12l-2.843.712a.75.75 0 01-.904-.903l.71-2.842a4.5 4.5 0 011.12-1.89L16.862 4.487z"></path><path d="M19.5 7.125L16.862 4.487"></path></svg>
            </button>
            <button 
              type="button" 
              data-action-btn
              class="relative z-20 w-12 h-12 rounded-full bg-orange-500 shadow-sm text-white flex items-center justify-center active:scale-95 transition-transform" 
              onclick="event.stopPropagation(); event.preventDefault(); window.cancelSession('${session.id}');"
              title="Marchează ca Anulat/Absent"
            >
              <svg class="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>
            </button>
            <button 
              type="button" 
              data-action-btn
              class="relative z-20 w-12 h-12 rounded-full bg-red-500 shadow-sm text-white flex items-center justify-center active:scale-95 transition-transform" 
              onclick="event.stopPropagation(); event.preventDefault(); window.deleteSession('${session.id}');"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
          </div>
        </div>

        <!-- Draggable Foreground -->
        <div class="swipe-surface relative z-10 w-full h-full rounded-[2.5rem] overflow-hidden transition-transform duration-300 will-change-transform ${cardClasses} ${session.isDuplicate ? 'opacity-45 saturate-50 border-2 border-dashed border-black/40' : ''}">
          
          <div class="${summaryClasses}">
            ${watermark}
            <div class="${summaryRowClasses}">
              <div class="flex-1 min-w-0">
                <h4 class="text-xl font-bold tracking-tight leading-none truncate">${safePatientName}</h4>
              </div>
              ${beyondSupplyBadge}
              ${statusIcon}
            </div>
          </div>

          <div class="card-details grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]" style="grid-template-rows: 0fr;">
            <div class="overflow-hidden relative z-20">
              ${subscriptionWarningDetails}
              
              <div class="px-6 pt-2 pb-6 space-y-3">
                <!-- Row 0: Progress Bar + Session Count -->
                <div class="flex items-center gap-3 px-5 py-3 rounded-2xl bg-white text-black text-sm font-extrabold shadow-sm">
                  <div class="h-2 flex-1 ${progressBarTrack} rounded-full overflow-hidden relative">
                    <div class="h-full rounded-full ${progressBarFill} transition-all duration-500 ease-out" style="width: ${progressPercentage}%;"></div>
                  </div>
                  <span class="text-xs font-black tracking-wide shrink-0">${displayCount}/${totalSess}</span>
                </div>

                <!-- Row 1: White Pill with Black Text & Icons for Time & Location -->
                <div class="flex items-center justify-between px-5 py-3.5 rounded-2xl bg-white text-black text-sm sm:text-base font-extrabold shadow-sm border border-transparent">
                  <span class="flex items-center gap-1.5 shrink-0 text-black">
                    <svg class="w-4 h-4 text-black opacity-75 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
                    </svg>
                    <span class="text-black font-black">${timeRangeText}</span>
                  </span>
                  <span class="flex items-center gap-1.5 shrink-0 text-black">
                    <svg class="w-4 h-4 text-black opacity-75 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
                    </svg>
                    <span class="text-black font-black">${safeLocation}</span>
                  </span>
                </div>

                <!-- Row 2: Payment Badge on Left (Spacious px-6 padding) + Icon-only Call/Folder Buttons on Right -->
                <div class="${paymentRowClasses}">
                  <button 
                    type="button"
                    class="${paymentBtnClasses}" 
                    onclick="event.stopPropagation(); window.dispatchEvent(new CustomEvent('${EVENTS.openPaymentSheet}', { detail: { patientId: '${session.patientId}' } }))"
                  >
                    <span>${payment.label}</span>
                  </button>

                  <div class="flex items-center gap-2">
                    <a href="tel:${safePhone}" class="w-11 h-11 rounded-2xl bg-white hover:bg-neutral-50 border border-transparent shadow-sm active:scale-95 transition-all flex items-center justify-center text-black cursor-pointer" title="Sună pacientul" onclick="event.stopPropagation()">
                      <svg class="w-5 h-5 text-black opacity-85" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                      </svg>
                    </a>

                    <a href="${safeDriveLink}" target="${hasDriveLink ? '_blank' : '_self'}" rel="noopener noreferrer" class="w-11 h-11 rounded-2xl bg-white hover:bg-neutral-50 border border-transparent shadow-sm active:scale-95 transition-all flex items-center justify-center text-black cursor-pointer" title="Deschide Dosar/Drive" onclick="event.stopPropagation(); if (!${hasDriveLink}) { event.preventDefault(); if (window.showToast) { window.showToast('Pacientul nu are un link de dosar/Drive salvat.', 'info'); } else { alert('Pacientul nu are un link de dosar/Drive salvat.'); } }">
                      <svg class="w-5 h-5 text-black opacity-85" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                    </a>
                  </div>
                </div>
              </div>

              ${sessionStatus !== 'finalizat' && sessionStatus !== 'anulat' && sessionStatus !== 'absent' && (!session.selectedDate || session.selectedDate < todayStr || (session.selectedDate === todayStr && nowStr >= formattedEnd)) ? `
                <div class="px-6 pb-6 pt-2">
                  <button type="button" class="w-full h-11 rounded-2xl ${isGhimbav ? 'bg-brand-primary text-black' : 'bg-brand-secondary text-white'} font-black text-xs sm:text-sm tracking-wider uppercase active:scale-95 transition-transform shadow-md flex items-center justify-center cursor-pointer border border-transparent hover:opacity-95" onclick="event.stopPropagation(); window.confirmSession('${session.id}')">
                    <span>CONFIRMĂ ȘEDINȚA</span>
                  </button>
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      </div>
    </session-card>
  `;
}

// ── Card de membru (în cardul de grup) ──────────────────────────
// variant 'timeline': card simplu cu telefon/dosar (calendar.astro).
// variant 'agenda': wrapper swipe-able cu acțiuni edit/absent/șterge
// (controllerele .member-card-front din DashboardLayout).
function createGroupMemberCardHTML(m: any, ctx: { isGhimbav: boolean; progressBarFill: string; progressBarTrack: string; variant: 'timeline' | 'agenda' }): string {
  const { isGhimbav, progressBarFill, progressBarTrack, variant } = ctx;
  const isAgenda = variant === 'agenda';

  const progress = m.totalSessions > 0 ? Math.min(100, Math.round(((m.attendanceCount || 0) / m.totalSessions) * 100)) : 0;
  const safeName = escapeHtml(m.patientName);
  const safePhone = escapeHtml(m.patientPhone || '');
  const driveLink = m.driveLink || m.patientDriveLink || '';
  const safeDriveLink = escapeHtml(driveLink || '#');
  const hasDriveLink = Boolean(driveLink);

  const payment = deriveMemberPaymentBadge(m);

  let statusBadge = '';
  if (m.status === 'finalizat') {
    statusBadge = `<span class="inline-flex items-center gap-1 text-[11px] font-black text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-lg shrink-0">✓ Finalizat</span>`;
  } else if (m.status === 'absent') {
    statusBadge = `<span class="inline-flex items-center gap-1 text-[11px] font-black text-orange-700 bg-orange-50 px-2 py-0.5 rounded-lg shrink-0">✗ Absent</span>`;
  } else if (m.status === 'anulat') {
    statusBadge = `<span class="inline-flex items-center gap-1 text-[11px] font-black text-rose-700 bg-rose-50 px-2 py-0.5 rounded-lg shrink-0">Anulat</span>`;
  }
  const beyondBadge = m.beyondSupply
    ? `<span class="inline-flex items-center text-[10px] font-black uppercase tracking-wide text-amber-900 bg-amber-100 border border-amber-300 px-2 py-0.5 rounded-lg shrink-0" title="În afara pachetului — devine activă la reînnoire">În afara pachetului</span>`
    : '';

  if (isAgenda) {
    return `
      <div class="member-swipe-wrapper relative rounded-2xl ${isGhimbav ? 'bg-white/95 text-black' : 'bg-white text-black'} shadow-sm border border-black/5 overflow-hidden" data-member-appointment-id="${m.id}" data-member-patient-id="${m.patientId}" data-member-patient-name="${safeName}">
        <div class="member-swipe-actions absolute inset-0 flex items-center justify-end gap-2 px-3 bg-neutral-100 z-0">
          <button
            type="button"
            class="member-action-btn w-10 h-10 rounded-full bg-white text-black shadow-sm flex items-center justify-center active:scale-95 transition-transform"
            title="Editează programare"
            onclick="event.stopPropagation(); window.editSession('${m.id}');"
          >
            <svg class="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.89 1.12l-2.843.712a.75.75 0 01-.904-.903l.71-2.842a4.5 4.5 0 011.12-1.89L16.862 4.487z"></path><path d="M19.5 7.125L16.862 4.487"></path></svg>
          </button>
          <button
            type="button"
            class="member-action-btn w-10 h-10 rounded-full bg-orange-500 text-white shadow-sm flex items-center justify-center active:scale-95 transition-transform"
            title="Marchează absent"
            onclick="event.stopPropagation(); window.markSessionAbsent('${m.id}');"
          >
            <svg class="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
          </button>
          <button
            type="button"
            class="member-action-btn w-10 h-10 rounded-full bg-red-500 text-white shadow-sm flex items-center justify-center active:scale-95 transition-transform"
            title="Șterge programare"
            onclick="event.stopPropagation(); window.deleteSession('${m.id}');"
          >
            <svg class="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
          </button>
        </div>
        <div class="member-card-front relative z-10 p-3.5 space-y-2 bg-white text-black rounded-2xl" onclick="event.stopPropagation();">
          <!-- Row 1: Nume & Contor -->
          <div class="flex items-center justify-between gap-2">
            <span class="font-black text-sm text-neutral-900 truncate flex-1">${safeName}</span>
            <div class="flex items-center gap-1.5 shrink-0">
              ${statusBadge}${beyondBadge}
              <span class="text-xs font-black text-neutral-700 bg-neutral-100 px-2 py-0.5 rounded-lg font-mono">${m.attendanceCount || 0}/${m.totalSessions || 10}</span>
            </div>
          </div>

          <!-- Row 2: Progres -->
          <div class="h-1.5 w-full ${progressBarTrack} rounded-full overflow-hidden">
            <div class="h-full rounded-full ${progressBarFill}" style="width: ${progress}%;"></div>
          </div>

          <!-- Row 3: Plată pe stânga + Butoane Telefon & Dosar pe dreapta -->
          <div class="flex items-center justify-between gap-2 pt-0.5">
            <button
              type="button"
              class="h-9 px-3 rounded-xl ${payment.badgeClass} text-xs font-black transition-all active:scale-95 cursor-pointer shadow-2xs flex items-center justify-center"
              onclick="event.stopPropagation(); window.dispatchEvent(new CustomEvent('${EVENTS.openPaymentSheet}', { detail: { patientId: '${m.patientId}' } }))"
            >
              <span>${payment.label}</span>
            </button>

            <div class="flex items-center gap-1.5 shrink-0">
              <a
                href="tel:${safePhone}"
                class="w-9 h-9 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-800 flex items-center justify-center active:scale-95 transition-all cursor-pointer shadow-2xs"
                title="Sună pacientul"
                onclick="event.stopPropagation()"
              >
                <svg class="w-4 h-4 text-neutral-800" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
              </a>

              <a
                href="${safeDriveLink}"
                target="${hasDriveLink ? '_blank' : '_self'}"
                rel="noopener noreferrer"
                class="w-9 h-9 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-800 flex items-center justify-center active:scale-95 transition-all cursor-pointer shadow-2xs"
                title="Deschide Dosar/Drive"
                onclick="event.stopPropagation(); if (!${hasDriveLink}) { event.preventDefault(); if (window.showToast) { window.showToast('Pacientul nu are dosar/Drive salvat.', 'info'); } else { alert('Pacientul nu are dosar/Drive salvat.'); } }"
              >
                <svg class="w-4 h-4 text-neutral-800" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
              </a>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="member-card p-3.5 rounded-2xl ${isGhimbav ? 'bg-white/95 text-black' : 'bg-white text-black'} shadow-sm space-y-2.5 border border-black/5 ${m.isDuplicate ? 'opacity-45 saturate-50 border-dashed !border-black/40' : ''}" onclick="event.stopPropagation();">
      <!-- Row 1: Nume & Actions -->
      <div class="flex items-center justify-between gap-2">
        <span class="font-black text-sm text-neutral-900 truncate flex-1">${safeName}</span>
        <div class="flex items-center gap-1 shrink-0">
          <a 
            href="tel:${safePhone}" 
            class="w-8 h-8 rounded-lg bg-neutral-100 hover:bg-neutral-200 text-neutral-700 flex items-center justify-center active:scale-95 transition-all cursor-pointer" 
            title="Sună pacientul" 
            onclick="event.stopPropagation()"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
            </svg>
          </a>

          <a 
            href="${safeDriveLink}" 
            target="${hasDriveLink ? '_blank' : '_self'}" 
            rel="noopener noreferrer" 
            class="w-8 h-8 rounded-lg bg-neutral-100 hover:bg-neutral-200 text-neutral-700 flex items-center justify-center active:scale-95 transition-all cursor-pointer" 
            title="Deschide Dosar/Drive" 
            onclick="event.stopPropagation(); if (!${hasDriveLink}) { event.preventDefault(); if (window.showToast) { window.showToast('Pacientul nu are dosar/Drive salvat.', 'info'); } else { alert('Pacientul nu are dosar/Drive salvat.'); } }"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </a>
        </div>
      </div>

      <!-- Row 2: Status & Counter -->
      <div class="flex items-center justify-between gap-2">
        ${statusBadge || '<span></span>'}${beyondBadge}
        <span class="text-xs font-black text-neutral-600 bg-neutral-100 px-2 py-0.5 rounded-lg font-mono">${m.attendanceCount || 0}/${m.totalSessions || 10}</span>
      </div>

      <!-- Row 3: Progres -->
      <div class="h-1.5 w-full ${progressBarTrack} rounded-full overflow-hidden">
        <div class="h-full rounded-full ${progressBarFill}" style="width: ${progress}%;"></div>
      </div>

      <!-- Row 4: Plată -->
      <button 
        type="button" 
        class="w-full h-9 rounded-xl ${payment.badgeClass} text-xs font-black transition-all active:scale-95 cursor-pointer shadow-2xs flex items-center justify-center"
        onclick="event.stopPropagation(); window.dispatchEvent(new CustomEvent('${EVENTS.openPaymentSheet}', { detail: { patientId: '${m.patientId}' } }))"
      >
        <span>${payment.label}</span>
      </button>
    </div>
  `;
}

// ── Card de grup ────────────────────────────────────────────────
export function createGroupCardHTML(group: any, ctx: SessionCardContext): string {
  const { sessionDuration, variant = 'timeline' } = ctx;
  const todayStr = localDateStr();
  const isAgenda = variant === 'agenda';

  const count = group.members.length;
  const timeStr = (group.selectedTime || '08:00').substring(0, 5);
  const timeParts = timeStr.split(':');
  const startH = parseInt(timeParts[0] || '8', 10);
  const startM = parseInt(timeParts[1] || '0', 10);
  const totalStartMin = startH * 60 + startM;
  const totalEndMin = totalStartMin + sessionDuration;
  const endH = Math.floor(totalEndMin / 60);
  const endM = totalEndMin % 60;
  const formattedEnd = `${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}`;
  
  const now = new Date();
  const nowStr = now.toTimeString().slice(0, 5);
  const isPastGroup = !group.selectedDate || group.selectedDate < todayStr || (group.selectedDate === todayStr && nowStr >= formattedEnd);

  const locationStr = group.location || 'Belaqva';
  const isGhimbav = locationStr.toLowerCase() === 'ghimbav';
  const cardClasses = isGhimbav ? 'bg-brand-secondary text-white' : 'bg-brand-primary text-black';
  const progressBarFill = isGhimbav ? 'bg-brand-secondary' : 'bg-brand-primary';
  const progressBarTrack = isGhimbav ? 'bg-black/20' : 'bg-black/15';
  const memberIds = group.members.map((m: any) => m.id).join(',');

  // Status icon for the group = any ongoing/finalized etc.
  const anyStatus = group.members.some((m: any) => m.status === 'programat') ? 'programat' : group.members[0]?.status || 'programat';
  let statusIcon = '';
  if (anyStatus === 'absent' || anyStatus === 'anulat') {
    statusIcon = `<svg class="w-6 h-6 ${isGhimbav ? 'text-brand-primary' : 'text-brand-secondary'} shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>`;
  } else if (anyStatus === 'finalizat') {
    statusIcon = `<svg class="w-6 h-6 ${isGhimbav ? 'text-brand-primary' : 'text-brand-secondary'} shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5" d="M5 13l4 4L19 7"/></svg>`;
  }

  const memberCards = group.members
    .map((m: any) => createGroupMemberCardHTML(m, { isGhimbav, progressBarFill, progressBarTrack, variant }))
    .join('');

  const rootClasses = isAgenda
    ? 'group-session-card block relative rounded-[2.5rem] shadow-sm overflow-hidden mx-1 md:mx-5'
    : 'group-session-card block relative rounded-[2.5rem] shadow-sm overflow-hidden';

  const watermark = isAgenda
    ? `<div class="absolute left-3 top-0 bottom-0 font-black text-[3.8rem] leading-[0.8] opacity-50 pointer-events-none tracking-tighter flex items-center justify-start z-0 w-20">
        <div class="flex items-start">
          ${startH.toString().padStart(2, '0')}
          <span class="text-xl mt-1 ml-0.5">${startM.toString().padStart(2, '0')}</span>
        </div>
      </div>`
    : '';
  const summaryClasses = isAgenda
    ? 'card-summary relative z-20 flex items-center justify-between cursor-pointer transition-transform active:scale-[0.98] min-h-[85px] py-5 px-6'
    : 'card-summary relative z-20 flex flex-col justify-between cursor-pointer transition-transform active:scale-[0.98] min-h-[80px] p-6';
  const summaryRowOpen = isAgenda
    ? '<div class="flex items-center gap-3 w-full relative z-10 pl-24 justify-between">'
    : '<div class="flex items-center gap-3 w-full relative z-10 justify-between">';
  // Pe timeline, sub titlu există un rând cu bara de progres a grupului.
  const summaryProgressRow = isAgenda
    ? ''
    : `<div class="flex items-center gap-4 mt-5 relative z-10">
        <div class="h-1.5 flex-1 ${progressBarTrack} rounded-full overflow-hidden relative">
          <div class="h-full rounded-full ${progressBarFill} transition-all duration-500 ease-out" style="width: 100%;"></div>
        </div>
      </div>`;

  return `
    <session-card class="${rootClasses}" data-group-id="${group.groupId}" data-group-member-ids="${memberIds}">
      <div class="absolute inset-0 bg-neutral-100 flex items-center justify-end px-6 z-0">
        <div class="flex items-center gap-3" data-action-area>
          <button 
            type="button" 
            data-action-btn
            class="relative z-20 w-12 h-12 rounded-full bg-white shadow-sm text-black flex items-center justify-center active:scale-95 transition-transform border border-transparent"
            onclick="event.stopPropagation(); event.preventDefault(); window.editGroupSession('${memberIds}', '${group.selectedDate || ''}', '${group.selectedTime || ''}', '${escapeJsString(locationStr)}');"
            title="Editează grupul"
          >
            <svg class="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.89 1.12l-2.843.712a.75.75 0 01-.904-.903l.71-2.842a4.5 4.5 0 011.12-1.89L16.862 4.487z"></path><path d="M19.5 7.125L16.862 4.487"></path></svg>
          </button>
          <button 
            type="button" 
            data-action-btn
            class="relative z-20 w-12 h-12 rounded-full bg-orange-500 shadow-sm text-white flex items-center justify-center active:scale-95 transition-transform"
            onclick="event.stopPropagation(); event.preventDefault(); window.cancelGroupSession('${memberIds}');"
            title="Marchează grupul ca Anulat/Absent"
          >
            <svg class="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>
          </button>
          <button 
            type="button" 
            data-action-btn
            class="relative z-20 w-12 h-12 rounded-full bg-red-500 shadow-sm text-white flex items-center justify-center active:scale-95 transition-transform"
            onclick="event.stopPropagation(); event.preventDefault(); window.deleteGroupSession('${memberIds}');"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
          </button>
        </div>
      </div>

      <div class="swipe-surface relative z-10 w-full h-full rounded-[2.5rem] overflow-hidden transition-transform duration-300 will-change-transform ${cardClasses}">
        <div class="${summaryClasses}" onclick="this.closest('session-card').classList.toggle('expanded')">
          ${watermark}
          ${summaryRowOpen}
            <div class="min-w-0 flex-1 flex flex-col gap-1">
              <h4 class="text-xl font-bold tracking-tight leading-none truncate">Grup</h4>
              <p class="text-xs font-black opacity-75">${count} pacienți · ${escapeHtml(locationStr)}</p>
            </div>
            ${statusIcon}
          </div>

          ${summaryProgressRow}
        </div>

        <div class="card-details grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]" style="grid-template-rows: 0fr;">
          <div class="overflow-hidden relative z-20">
            <div class="px-6 pb-6 pt-1">
              <div class="flex items-center gap-1.5 mb-3 px-1 text-sm font-black opacity-90">
                <svg class="w-4 h-4 shrink-0 opacity-75" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
                <span>${escapeHtml(locationStr)}</span>
              </div>
              <div class="group-members flex flex-col gap-2.5 mb-3">
                ${memberCards}
              </div>
              ${anyStatus !== 'finalizat' && anyStatus !== 'anulat' && anyStatus !== 'absent' && isPastGroup ? `
                <div class="pt-1 pb-1">
                  <button 
                    type="button" 
                    class="w-full h-11 rounded-2xl ${isGhimbav ? 'bg-brand-primary text-black' : 'bg-brand-secondary text-white'} font-black text-xs sm:text-sm tracking-wider uppercase active:scale-95 transition-transform shadow-md flex items-center justify-center cursor-pointer border border-transparent hover:opacity-95" 
                    onclick="event.stopPropagation(); if (typeof window.confirmGroupSession === 'function') { window.confirmGroupSession('${memberIds}'); }"
                  >
                    <span>CONFIRMĂ ȘEDINȚELE DE GRUP</span>
                  </button>
                </div>
              ` : ''}
              <div class="mt-2 text-xs font-bold text-center opacity-75 group-expanded-hint">Apasă pentru a ascunde pacienții</div>
            </div>
          </div>
        </div>
      </div>
    </session-card>
  `;
}
