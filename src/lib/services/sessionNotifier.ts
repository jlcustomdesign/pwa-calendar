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

  // Verifică imediat și apoi la fiecare 20 de secunde
  checkTodaySessionsForNotifications();
  checkIntervalId = setInterval(checkTodaySessionsForNotifications, 20 * 1000);

  // Pe mobil: Când utilizatorul deblochează telefonul sau comută înapoi în aplicație, verificăm instant!
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkTodaySessionsForNotifications();
    }
  });
  window.addEventListener('focus', () => {
    checkTodaySessionsForNotifications();
  });
}

export async function sendTestNotification() {
  await triggerWebNotification(
    '🔔 Test Notificare: Kineto Agenda',
    'Notificările pentru începutul și sfârșitul ședințelor sunt active și funcționează!'
  );
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

      // 1. Notificare ÎNCEPUT ȘEDINȚĂ
      // Fereastră extinsă (cu 2 min înainte până la 15 min după) pentru a prinde notificarea chiar dacă telefonul a fost în standby
      if (currentMinutes >= startTotalMin - 2 && currentMinutes < startTotalMin + 15) {
        if (!notifiedStarts.has(startKey)) {
          notifiedStarts.add(startKey);
          await triggerWebNotification(
            `🔔 Ședință Nouă: ${patientName}`,
            `La ora ${timeStr} este programat ${patientName}. Locație: ${appt.pacienti?.locatie || 'Belaqva'}`
          );
        }
      }

      // 2. Notificare SFÂRȘIT ȘEDINȚĂ
      // Fereastră extinsă de la finalul ședinței până la 15 min după
      if (currentMinutes >= endTotalMin && currentMinutes < endTotalMin + 15) {
        if (!notifiedEnds.has(endKey)) {
          notifiedEnds.add(endKey);

          // Caută dacă urmează un alt pacient
          const nextAppt = sorted.slice(i + 1).find(a => a.status !== 'anulat' && a.status !== 'absent');
          let nextMessage = 'Nicio altă ședință imediată.';
          if (nextAppt) {
            const nextName = nextAppt.pacienti ? `${nextAppt.pacienti.prenume} ${nextAppt.pacienti.nume}` : 'Pacient';
            nextMessage = `Urmează ${nextName} la ora ${nextAppt.ora || ''}.`;
          }

          // Pe mobil notificările web nu apar mereu când aplicația e în foreground,
          // așa că deschidem și popup-ul în app ca fallback.
          // Folosim setTimeout ca să dăm timp Sheet-ului de wrap-up să-și înregistreze listener-ul la load.
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent('openWrapUp', {
                detail: { appointment: appt }
              }));
            }, 500);
          }

          await triggerWebNotification(
            `✅ Ședință Încheiată: ${patientName}`,
            `Ședința cu ${patientName} s-a terminat. ${nextMessage}`
          );
        }
      }
    }
  } catch (err) {
    console.error('SessionNotifier check error:', err);
  }
}

export async function triggerWebNotification(title: string, body: string) {
  try {
    if (typeof window === 'undefined') return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const options: any = {
      body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: 'kineto-session-alert',
      data: { url: '/dashboard' },
      vibrate: [200, 100, 200]
    };

    // 1. Suport Mobil principal: Trimitere prin Service Worker (Necesitate absolută pentru iOS Safari 16.4+ și Android Chrome)
    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.ready;
        if (reg && reg.showNotification) {
          await reg.showNotification(title, options);
          return;
        }
      } catch (swErr) {
        console.warn('SW showNotification fallback:', swErr);
      }
    }

    // 2. Fallback Desktop pentru browserele standard
    const notif = new Notification(title, options);
    notif.onclick = () => {
      window.focus();
      notif.close();
    };
  } catch (e) {
    console.error('Error triggering web notification:', e);
  }
}
