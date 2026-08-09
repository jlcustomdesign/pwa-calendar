/**
 * settingsService.ts — Setări aplicație (singleton Supabase)
 * Folosit în: SettingsView.astro
 */
import { supabase } from '../supabase';
import type { Settings } from '../database.types';

// ── Citire settings ───────────────────────────────────────────
export async function getSettings(): Promise<Settings> {
  const { data, error } = await supabase
    .from('settings')
    .select('*')
    .single();

  if (error) throw new Error('Eroare la citirea setărilor: ' + error.message);
  return data;
}

// ── Salvare settings (UPDATE pe singurul rând existent) ────────
export async function saveSettings(updates: Partial<Settings>): Promise<Settings> {
  // Obținem ID-ul rândului singleton
  const { data: existing } = await supabase
    .from('settings')
    .select('id')
    .single();

  if (!existing) throw new Error('Nu există rând de settings în baza de date.');

  const { data, error } = await supabase
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

  const { error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', user.id);

  if (error) throw new Error('Eroare la salvarea profilului: ' + error.message);
}

// ── Citire profil terapeut ─────────────────────────────────────
export async function getProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (error) throw new Error('Eroare la citirea profilului: ' + error.message);
  return { ...data, email: user.email };
}
