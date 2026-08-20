/**
 * sessionNotifier.ts — Notificări Web Automate pentru începutul și sfârșitul ședințelor
 */
import { getAppointmentsByDate, getPendingWrapUps } from './appointmentService';
import { toLocalISOString } from '../../utils/date';

let isNotifierRunning = false;
let checkIntervalId: any = null;

// Sets pentru a preveni notificarea dublă în aceeași zi
const notifiedStarts = new Set<string>();
const notifiedEnds = new Set<string>();

export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  try {
    if (Notification.permission === 'granted') {
      import('./pushService').then(({ subscribeToPushNotifications }) => {
        subscribeToPushNotifications().catch(() => {});
      }).catch(() => {});
      return true;
    }
    if (Notification.permission === 'denied') return false;
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      import('./pushService').then(({ subscribeToPushNotifications }) => {
        subscribeToPushNotifications().catch(() => {});
      }).catch(() => {});
      await triggerWebNotification(
        '🔔 Notificări Active!',
        'Vei primi notificări la începutul și finalul fiecărei ședințe.'
      );
      return true;
    }
    return false;
  } catch (e) {
    console.warn('requestPermission error:', e);
    return false;
  }
}

export function initSessionNotifier() {
  if (typeof window === 'undefined') return;
  if (isNotifierRunning) return;

  isNotifierRunning = true;

  // Expunere pe window pentru testare și utilizare
  (window as any).requestNotificationPermission = requestNotificationPermission;
  (window as any).testNotification = async () => {
    const granted = await requestNotificationPermission();
    if (granted) {
      await triggerWebNotification('🔔 Test Notificare', 'Notificările funcționează perfect pe acest dispozitiv!');
    } else {
      alert('Permisiunea pentru notificări este oprită în browser. Te rog să o activezi din setările browserului.');
    }
  };

  // Pe browsere moderne (iOS / Android / Desktop), cererea de permisiune necesită un gest utilizator (click / tap).
  // Înregistrăm un handler one-time pe prima interacțiune dacă permisiunea este 'default'.
  if ('Notification' in window && Notification.permission === 'default') {
    const askPermissionOnFirstTouch = async () => {
      document.removeEventListener('click', askPermissionOnFirstTouch);
      document.removeEventListener('touchend', askPermissionOnFirstTouch);
      document.removeEventListener('touchstart', askPermissionOnFirstTouch);
      await requestNotificationPermission();
    };
    document.addEventListener('click', askPermissionOnFirstTouch, { once: true });
    document.addEventListener('touchend', askPermissionOnFirstTouch, { once: true });
    document.addEventListener('touchstart', askPermissionOnFirstTouch, { once: true });
  }

  // La pornirea/revenirea în app: deschide popup-ul de confirmare pentru ședințele trecute neconfirmate.
  // Se repetă la fiecare pornire până când ședința este confirmată.
  promptMissedSessionWrapUp();

  // Verifică imediat și apoi la fiecare 20 de secunde (notificări realtime)
  checkTodaySessionsForNotifications();
  checkIntervalId = setInterval(checkTodaySessionsForNotifications, 20 * 1000);

  // Pe mobil: Când utilizatorul deblochează telefonul sau comută înapoi în aplicație, verificăm instant!
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      promptMissedSessionWrapUp();
      checkTodaySessionsForNotifications();
    }
  });
  window.addEventListener('focus', () => {
    promptMissedSessionWrapUp();
    checkTodaySessionsForNotifications();
  });
}

// Deschide popup-ul de wrap-up pentru cea mai recentă ședință trecută neconfirmată.
// Folosește handler-ul existent `window.confirmSession` și funcția existentă `getPendingWrapUps`.
async function promptMissedSessionWrapUp() {
  if (typeof window === 'undefined') return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

  try {
    const pending = await getPendingWrapUps();
    if (!pending || pending.length === 0) return;

    const missed = pending[pending.length - 1];
    if (!missed?.id) return;

    const confirmSession = (window as any).confirmSession;
    if (typeof confirmSession !== 'function') return;

    // Deschide imediat popup-ul existent de confirmare.
    confirmSession(missed.id);
  } catch (err) {
    console.error('promptMissedSessionWrapUp error:', err);
  }
}

async function checkTodaySessionsForNotifications() {
  if (typeof window === 'undefined') return;

  const now = new Date();
  const todayStr = toLocalISOString(now);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const canUseWebNotifications = 'Notification' in window && Notification.permission === 'granted';

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
          if (canUseWebNotifications) {
            await triggerWebNotification(
              `🔔 Ședință Nouă: ${patientName}`,
              `La ora ${timeStr} este programat ${patientName}. Locație: ${appt.pacienti?.locatie || 'Belaqva'}`
            );
          }
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

          // Popup în app — funcționează INDIFERENT de permisiunea de notificări web.
          // Pe mobil notificările web nu apar mereu când aplicația e în foreground,
          // așa că deschidem sheet-ul de wrap-up direct în aplicație.
          // Folosim setTimeout ca să dăm timp Sheet-ului de wrap-up să-și înregistreze listener-ul la load.
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent('openWrapUp', {
                detail: { appointment: appt }
              }));
            }, 500);
          }

          if (canUseWebNotifications) {
            await triggerWebNotification(
              `✅ Ședință Încheiată: ${patientName}`,
              `Ședința cu ${patientName} s-a terminat. ${nextMessage}`
            );
          }
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
