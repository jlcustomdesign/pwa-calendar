/**
 * store.ts — Global Settings & State Store
 *
 * Singleton lightweight care:
 * - Cachează settings în memorie (fără re-fetch la fiecare componentă)
 * - Emite events globale pentru sincronizare între pagini/componente
 *
 * Nu există ascultare Supabase Realtime — sincronizarea se face prin
 * evenimentele CustomEvent dispatch-uite de services (vezi events.ts).
 *
 * Usage:
 *   import { setSettingsCache } from '../lib/store';
 */

import { EVENTS, emit } from './events';
import type { Settings } from './database.types';

// ── In-memory cache ────────────────────────────────────────────
let _settings: Settings | null = null;

/**
 * Actualizează cache-ul local și notifică toate componentele.
 * Apelat după saveSettings() din SettingsView.
 */
export function setSettingsCache(settings: Settings) {
  _settings = settings;
  emit(EVENTS.settingsUpdated, { settings });
}

/**
 * Invalidează cache-ul (forțează re-fetch la următorul apel getSettings()).
 */
export function invalidateSettingsCache() {
  _settings = null;
}
