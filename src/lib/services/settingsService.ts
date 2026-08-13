/**
 * settingsService.ts — Setări aplicație (singleton Supabase)
 * Folosit în: SettingsView.astro
 */
import { supabase } from '../supabase';
import type { Settings } from '../database.types';

const DEFAULT_SETTINGS: Settings = {
  id: 'default',
  therapist_name: 'Roxana',
  work_start: '08:00',
  work_end: '18:00',
  lunch_start: '13:00',
  lunch_end: '14:00',
  session_duration: 50,
  break_buffer: 10,
  zile_lucratoare: [1, 2, 3, 4, 5],
  default_price: 150,
  default_total_sessions: 10,
  reminder_threshold: 2,
  whatsapp_template: 'Salut {nume}! Îți reamintim că mai ai {ramase} ședințe rămase. Te așteptăm cu drag!',
  categories: ['Kinetoterapie', 'Masaj', 'Recuperare'],
  updated_at: new Date().toISOString()
} as Settings;

// ── Citire settings (cu cache local instant pentru 0ms delay pe mobil) ──
export async function getSettings(): Promise<Settings> {
  let cached: Settings | null = null;
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem('kineto_settings_cache');
      if (raw) cached = JSON.parse(raw);
    } catch (e) {}
  }

  try {
    const { data, error } = await (supabase as any)
      .from('settings')
      .select('*')
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn('getSettings warning:', error);
      if (cached) return cached;
    }

    if (!data) {
      const fallback = cached || {
        ...DEFAULT_SETTINGS,
        updated_at: new Date().toISOString()
      };
      return fallback;
    }

    const result = {
      ...data,
      work_start: data.work_start || '08:00',
      work_end: data.work_end || '18:00',
    };

    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('kineto_settings_cache', JSON.stringify(result));
      } catch (e) {}
    }

    return result;
  } catch (err) {
    console.error('getSettings error:', err);
    if (cached) return cached;
    return DEFAULT_SETTINGS;
  }
}

// ── Salvare settings (UPDATE pe singurul rând existent, INSERT dacă lipsește) ────────
export async function saveSettings(updates: Partial<Settings>): Promise<Settings> {
  // Obținem rândul singleton fără a da eroare dacă tabela e goală.
  const { data: existing } = await (supabase as any)
    .from('settings')
    .select('id')
    .limit(1)
    .maybeSingle();

  let data: any;
  let error: any;

  if (!existing) {
    // Tabela e goală: inserăm un rând nou cu defaults + updates.
    const insertResult = await (supabase as any)
      .from('settings')
      .insert({ ...DEFAULT_SETTINGS, ...updates })
      .select()
      .maybeSingle();
    data = insertResult.data;
    error = insertResult.error;
  } else {
    const updateResult = await (supabase as any)
      .from('settings')
      .update(updates)
      .eq('id', existing.id)
      .select()
      .maybeSingle();
    data = updateResult.data;
    error = updateResult.error;
  }

  if (error) throw new Error('Eroare la salvarea setărilor: ' + error.message);
  if (!data) throw new Error('Setările nu au putut fi salvate.');

  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem('kineto_settings_cache', JSON.stringify(data));
    } catch (e) {}
  }

  return data;
}

// ── Salvare profil terapeut (din Settings → Profil personal) ──
export async function saveProfile(updates: {
  display_name?: string;
  telefon?: string;
  username?: string;
}) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Utilizatorul nu este autentificat.');

  const { error } = await (supabase as any)
    .from('profiles')
    .update(updates)
    .eq('id', user.id);

  if (error) throw new Error('Eroare la salvarea profilului: ' + error.message);
}

// ── Citire profil terapeut ─────────────────────────────────────
export async function getProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await (supabase as any)
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error('Eroare la citirea profilului: ' + error.message);
  return data ? { ...data, email: user.email } : null;
}
