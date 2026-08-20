/**
 * sessionNotifier.ts — Notificări Web Automate pentru începutul și sfârșitul ședințelor
 */
import { getAppointmentsByDate, getPendingWrapUps } from './appointmentService';
import { getSettings } from './settingsService';
import { toLocalISOString } from '../../utils/date';

let isNotifierRunning = false;
let checkIntervalId: any = null;

const WRAPUP_PROMPT_KEY = 'kineto-wrapup-prompted';
const NOTIFIER_KEY = 'kineto-session-notifier';

// Persistăm cheile de notificare în localStorage ca să nu se re-trimită
// la fiecare revenire în app sau la fiecare reload de pagină.
function getNotifiedKeys(): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(localStorage.getItem(NOTIFIER_KEY) || '{}');
  } catch {
    return {};
  }
}

function setNotifiedKey(key: string) {
  if (typeof window === 'undefined') return;
  try {
    const keys = getNotifiedKeys();
    keys[key] = true;
    localStorage.setItem(NOTIFIER_KEY, JSON.stringify(keys));
  } catch {
    // ignore
  }
}

function clearOldNotifiedKeys(todayStr: string) {
  if (typeof window === 'undefined') return;
  try {
    const keys = getNotifiedKeys();
    const updated: Record<string, boolean> = {};
    Object.entries(keys).forEach(([k, v]) => {
      if (k.startsWith(`${todayStr}_`)) updated[k] = v;
    });
    localStorage.setItem(NOTIFIER_KEY, JSON.stringify(updated));
  } catch {
    // ignore
  }
}

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

  // La pornirea/revenirea în app: deschide popup-ul de confirmare pentru ședințele de azi
  // trecute neconfirmate. Nu mai re-promptăm sesiuni istorice la fiecare deschidere.
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

// Deschide popup-ul de wrap-up pentru cea mai recentă ședință de azi, trecută neconfirmată.
// Nu mai deschide sesiuni istorice la fiecare revenire în app și nu repeta același ID
// dacă utilizatorul a închis popup-ul fără confirmare.
async function promptMissedSessionWrapUp() {
  if (typeof window === 'undefined') return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

  try {
    const pending = await getPendingWrapUps();
    if (!pending || pending.length === 0) return;

    const todayStr = toLocalISOString(new Date());
    // Auto-prompt doar pentru ședințele de azi. Sesiunile mai vechi rămân vizibile în calendar,
    // dar nu mai blochează experiența la fiecare deschidere a aplicației.
    const todayPending = pending.filter((a: any) => a.data === todayStr);
    if (todayPending.length === 0) return;

    const missed = todayPending[todayPending.length - 1];
    if (!missed?.id) return;

    // Evită re-prompt-ul aceluiași ID în aceeași zi (ex: utilizatorul a închis sheet-ul).
    try {
      const lastPrompted = JSON.parse(localStorage.getItem(WRAPUP_PROMPT_KEY) || '{}');
      if (lastPrompted.id === missed.id && lastPrompted.date === todayStr) return;
    } catch {
      // ignore localStorage errors
    }

    const confirmSession = (window as any).confirmSession;
    if (typeof confirmSession !== 'function') return;

    // Marchează ID-ul ca fiind deja auto-promptuit azi.
    try {
      localStorage.setItem(WRAPUP_PROMPT_KEY, JSON.stringify({ id: missed.id, date: todayStr }));
    } catch {
      // ignore localStorage errors
    }

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
    const [appts, settings] = await Promise.all([
      getAppointmentsByDate(todayStr),
      getSettings()
    ]);

    if (!appts || appts.length === 0) return;

    // Curăță notificările din zilele trecute pentru a nu umple localStorage.
    clearOldNotifiedKeys(todayStr);

    const sessionDuration = settings?.session_duration || 50;
    const notifiedKeys = getNotifiedKeys();

    // Sortează programările după oră
    const sorted = [...appts].sort((a, b) => (a.ora || '00:00').localeCompare(b.ora || '00:00'));

    for (let i = 0; i < sorted.length; i++) {
      const appt = sorted[i];
      if (appt.status === 'anulat' || appt.status === 'absent') continue;

      const timeStr = (appt.ora || '08:00').substring(0, 5);
      const parts = timeStr.split(':');
      const startH = parseInt(parts[0] || '8', 10);
      const startM = parseInt(parts[1] || '0', 10);
      const startTotalMin = startH * 60 + startM;
      const endTotalMin = startTotalMin + sessionDuration;

      const patientName = appt.pacienti ? `${appt.pacienti.prenume} ${appt.pacienti.nume}`.trim() : 'Pacient';
      const startKey = `${todayStr}_${appt.id}_start`;
      const endKey = `${todayStr}_${appt.id}_end`;

      // 1. Notificare ÎNCEPUT ȘEDINȚĂ
      // Fereastră mică: cu 1 min înainte până la 2 min după start. Dacă ai deschis app mult după,
      // nu vrei să primești notificări spam despre o ședință care a început deja.
      if (currentMinutes >= startTotalMin - 1 && currentMinutes <= startTotalMin + 2) {
        if (!notifiedKeys[startKey]) {
          setNotifiedKey(startKey);
          if (canUseWebNotifications) {
            await triggerWebNotification(
              `🔔 Începe: ${patientName}`,
              `La ora ${timeStr} începe ședința cu ${patientName}.`
            );
          }
        }
      }

      // 2. Notificare SFÂRȘIT ȘEDINȚĂ
      // Fereastră de la final până la 5 min după.
      if (currentMinutes >= endTotalMin && currentMinutes <= endTotalMin + 5) {
        if (!notifiedKeys[endKey]) {
          setNotifiedKey(endKey);

          // Caută dacă urmează un alt pacient
          const nextAppt = sorted.slice(i + 1).find(a => a.status !== 'anulat' && a.status !== 'absent');
          let nextMessage = '';
          if (nextAppt) {
            const nextName = nextAppt.pacienti ? `${nextAppt.pacienti.prenume} ${nextAppt.pacienti.nume}`.trim() : 'Pacient';
            const nextTime = (nextAppt.ora || '').substring(0, 5);
            nextMessage = ` Urmează ${nextName} la ora ${nextTime}.`;
          }

          // Popup în app — funcționează INDIFERENT de permisiunea de notificări web.
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent('openWrapUp', {
                detail: { appointment: appt }
              }));
            }, 500);
          }

          if (canUseWebNotifications) {
            await triggerWebNotification(
              `✅ Ședință încheiată: ${patientName}`,
              `Ședința de la ora ${timeStr} s-a încheiat.${nextMessage} Apasă pentru confirmare.`
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
