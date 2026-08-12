/**
 * settingsService.ts — Setări aplicație (singleton Supabase)
 * Folosit în: SettingsView.astro
 */
import { supabase } from '../supabase';
import type { Settings } from '../database.types';

// ── Citire settings ───────────────────────────────────────────
export async function getSettings(): Promise<Settings> {
  const { data, error } = await (supabase as any)
    .from('settings')
    .select('*')
    .single();

  if (error || !data) {
    return {
      id: 'default',
      work_start: '08:00',
      work_end: '18:00',
      zile_lucratoare: [1, 2, 3, 4, 5],
      lunch_start: '13:00',
      lunch_end: '14:00',
      session_duration: 50,
      break_buffer: 10,
      default_price: 150,
      whatsapp_template: 'Salut {nume}! Îți reamintim că mai ai {ramase} ședințe rămase. Te așteptăm cu drag!',
      categories: ['Kinetoterapie', 'Masaj', 'Recuperare'],
      reminder_threshold: 2,
      updated_at: new Date().toISOString()
    } as Settings;
  }

  return {
    ...data,
    work_start: data.work_start || '08:00',
    work_end: data.work_end || '18:00',
  };
}

// ── Salvare settings (UPDATE pe singurul rând existent) ────────
export async function saveSettings(updates: Partial<Settings>): Promise<Settings> {
  // Obținem ID-ul rândului singleton
  const { data: existing } = await (supabase as any)
    .from('settings')
    .select('id')
    .single();

  if (!existing) throw new Error('Nu există rând de settings în baza de date.');

  const { data, error } = await (supabase as any)
    .from('settings')
    .update(updates)
    .eq('id', existing.id)
    .select()
    .single();

  if (error) throw new Error('Eroare la salvarea setărilor: ' + error.message);
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
    .single();

  if (error) throw new Error('Eroare la citirea profilului: ' + error.message);
  return { ...data, email: user.email };
}
