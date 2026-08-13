/**
 * sessionNotifier.ts — Notificări Web Automate pentru începutul și sfârșitul ședințelor
 */
import { getAppointmentsByDate } from './appointmentService';
import { toLocalISOString } from '../../utils/date';

let isNotifierRunning = false;
let checkIntervalId: any = null;

// Sets pentru a preveni notificarea dublă în aceeași zi
const notifiedStarts = new Set<string>();
const notifiedEnds = new Set<string>();

export function initSessionNotifier() {
  if (typeof window === 'undefined') return;
  if (isNotifierRunning) return;
  
  isNotifierRunning = true;

  // Verifică imediat și apoi la fiecare 30 de secunde
  checkTodaySessionsForNotifications();
  checkIntervalId = setInterval(checkTodaySessionsForNotifications, 30 * 1000);
}

async function checkTodaySessionsForNotifications() {
  if (typeof window === 'undefined') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const now = new Date();
  const todayStr = toLocalISOString(now);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  try {
    const appts = await getAppointmentsByDate(todayStr);
    if (!appts || appts.length === 0) return;

    // Sortează programările după oră
    const sorted = [...appts].sort((a, b) => (a.ora || '00:00').localeCompare(b.ora || '00:00'));

    for (let i = 0; i < sorted.length; i++) {
      const appt = sorted[i];
      if (appt.status === 'anulat' || appt.status === 'absent') continue;

      const timeStr = appt.ora || '08:00';
      const parts = timeStr.split(':');
      const startH = parseInt(parts[0] || '8', 10);
      const startM = parseInt(parts[1] || '0', 10);
      const startTotalMin = startH * 60 + startM;
      const endTotalMin = startTotalMin + 50; // Ședință de 50 minute

      const patientName = appt.pacienti ? `${appt.pacienti.prenume} ${appt.pacienti.nume}` : 'Pacient';
      const startKey = `${todayStr}_${appt.id}_start`;
      const endKey = `${todayStr}_${appt.id}_end`;

      // 1. Notificare ÎNCEPUT ȘEDINȚĂ (dacă ora curentă e la începutul ședinței: startTotalMin <= currentMinutes < startTotalMin + 5)
      if (currentMinutes >= startTotalMin && currentMinutes < startTotalMin + 5) {
        if (!notifiedStarts.has(startKey)) {
          notifiedStarts.add(startKey);
          triggerWebNotification(
            `🔔 Ședință Nouă: ${patientName}`,
            `Ședința a început la ora ${timeStr}. Locație: ${appt.pacienti?.locatie || 'Belaqva'}`
          );
        }
      }

      // 2. Notificare SFÂRȘIT ȘEDINȚĂ (dacă ora curentă e la finalul ședinței: endTotalMin <= currentMinutes < endTotalMin + 5)
      if (currentMinutes >= endTotalMin && currentMinutes < endTotalMin + 5) {
        if (!notifiedEnds.has(endKey)) {
          notifiedEnds.add(endKey);

          // Caută dacă urmează un alt pacient
          const nextAppt = sorted.slice(i + 1).find(a => a.status !== 'anulat' && a.status !== 'absent');
          let nextMessage = 'Nicio altă ședință imediată.';
          if (nextAppt) {
            const nextName = nextAppt.pacienti ? `${nextAppt.pacienti.prenume} ${nextAppt.pacienti.nume}` : 'Pacient';
            nextMessage = `Urmează ${nextName} la ora ${nextAppt.ora || ''}.`;
          }

          triggerWebNotification(
            `✅ Ședință Încheiată: ${patientName}`,
            `Ședința s-a terminat. ${nextMessage}`
          );
        }
      }
    }
  } catch (err) {
    console.error('SessionNotifier check error:', err);
  }
}

function triggerWebNotification(title: string, body: string) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const notif = new Notification(title, {
        body,
        icon: '/favicon.svg',
        badge: '/favicon.svg',
        tag: 'kineto-session-alert'
      });
      notif.onclick = () => {
        window.focus();
        notif.close();
      };
    }
  } catch (e) {
    console.error('Error triggering web notification:', e);
  }
}
