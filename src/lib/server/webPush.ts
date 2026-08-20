/**
 * webPush.ts — Server-side Web Push configuration & helpers
 */
import webPush from 'web-push';

export const VAPID_PUBLIC_KEY =
  process.env.PUBLIC_VAPID_PUBLIC_KEY ||
  'BGo-s4_9bT6qlpe4ZdjTr0AeFoxOswhgkJh-rHSOHJshhoSufsSByScAgLIQLmhE6EMvjTGGlB0rj7fgOdnRemY';

export const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY ||
  'Ch1BUr0CZvFtDswk2nYEZJyyFEedcAXdHqr_t55JW98';

export const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT ||
  'mailto:admin@kinetoagenda.ro';

try {
  webPush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
} catch (err) {
  console.warn('VAPID details init warning:', err);
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
  badge?: string;
}

export async function sendPushToSubscription(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload
) {
  const pushSubscription = {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth
    }
  };

  const payloadString = JSON.stringify({
    title: payload.title || '🔔 Agendă Kineto',
    body: payload.body || '',
    url: payload.url || '/dashboard',
    tag: payload.tag || 'kineto-session-alert',
    icon: payload.icon || '/favicon.svg',
    badge: payload.badge || '/favicon.svg'
  });

  return webPush.sendNotification(pushSubscription, payloadString, {
    TTL: 60 * 60 * 24 // 24 hours
  });
}
