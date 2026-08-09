/**
 * database.types.ts — Tipurile TypeScript generate din schema Supabase v3
 * Reflectă exact tabelele din supabase_schema_v3.sql
 *
 * Poți regenera automat cu:
 *   npx supabase gen types typescript --project-id YOUR_PROJECT_ID > src/lib/database.types.ts
 */

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {

      // ── profiles ──────────────────────────────────────────────
      profiles: {
        Row: {
          id:           string;
          display_name: string | null;
          username:     string;
          telefon:      string | null;
          created_at:   string;
          updated_at:   string;
        };
        Insert: {
          id:           string;
          display_name?: string | null;
          username:     string;
          telefon?:     string | null;
          created_at?:  string;
          updated_at?:  string;
        };
        Update: {
          id?:          string;
          display_name?: string | null;
          username?:    string;
          telefon?:     string | null;
          updated_at?:  string;
        };
      };

      // ── settings ──────────────────────────────────────────────
      settings: {
        Row: {
          id:                     string;
          therapist_name:         string;
          work_start:             string;   // "HH:MM"
          work_end:               string;
          lunch_start:            string;
          lunch_end:              string;
          session_duration:       number;   // minute
          break_buffer:           number;   // minute
          zile_lucratoare:        number[]; // isodow: 1=Luni...5=Vineri
          default_price:          number;
          default_total_sessions: number;
          reminder_threshold:     number;
          whatsapp_template:      string;
          categories:             string[];
          updated_at:             string;
        };
        Insert: Partial<Database['public']['Tables']['settings']['Row']>;
        Update: Partial<Database['public']['Tables']['settings']['Row']>;
      };

      // ── pacienti ──────────────────────────────────────────────
      pacienti: {
        Row: {
          id:               string;
          nume:             string;
          prenume:          string;
          telefon:          string;
          locatie:          'Belaqva' | 'Ghimbav';
          plan:             'Subscription' | 'One Time';
          frecventa:        string;
          cost:             number;
          sedinte_total:    number;
          sedinte_folosite: number;
          sedinte_ramase:   number;  // GENERATED — doar citire
          achitat:          boolean;
          status_abonament: 'activ' | 'ultima_sedinta' | 'terminat';
          notite:           string | null;
          drive_link:       string | null;
          created_at:       string;
          updated_at:       string;
        };
        Insert: {
          id?:              string;
          nume:             string;
          prenume:          string;
          telefon:          string;
          locatie?:         'Belaqva' | 'Ghimbav';
          plan?:            'Subscription' | 'One Time';
          frecventa?:       string;
          cost?:            number;
          sedinte_total?:   number;
          sedinte_folosite?: number;
          achitat?:         boolean;
          status_abonament?: 'activ' | 'ultima_sedinta' | 'terminat';
          notite?:          string | null;
          drive_link?:      string | null;
        };
        Update: Partial<Database['public']['Tables']['pacienti']['Insert']>;
      };

      // ── programari ────────────────────────────────────────────
      programari: {
        Row: {
          id:         string;
          pacient_id: string;
          data:       string;   // "YYYY-MM-DD"
          ora:        string;   // "HH:MM"
          locatie:    'Belaqva' | 'Ghimbav';
          status:     'programat' | 'confirmat' | 'finalizat' | 'anulat' | 'absent';
          note:       string | null;
          motiv:      string | null;
          created_at: string;
        };
        Insert: {
          id?:        string;
          pacient_id: string;
          data:       string;
          ora:        string;
          locatie?:   'Belaqva' | 'Ghimbav';
          status?:    'programat' | 'confirmat' | 'finalizat' | 'anulat' | 'absent';
          note?:      string | null;
          motiv?:     string | null;
        };
        Update: Partial<Database['public']['Tables']['programari']['Insert']>;
      };

      // ── notificari ────────────────────────────────────────────
      notificari: {
        Row: {
          id:              string;
          pacient_id:      string | null;
          titlu:           string;
          mesaj:           string | null;
          tip:             'info' | 'abonament' | 'plata' | 'reminder';
          data_declansare: string;
          citita:          boolean;
          created_at:      string;
        };
        Insert: {
          id?:              string;
          pacient_id?:      string | null;
          titlu:            string;
          mesaj?:           string | null;
          tip?:             'info' | 'abonament' | 'plata' | 'reminder';
          data_declansare?: string;
          citita?:          boolean;
        };
        Update: Partial<Database['public']['Tables']['notificari']['Insert']>;
      };

      // ── istoric_saptamanal ────────────────────────────────────
      istoric_saptamanal: {
        Row: {
          id:               string;
          saptamana_start:  string;  // "YYYY-MM-DD"
          saptamana_end:    string;
          total_programari: number;
          finalizate:       number;
          absente:          number;
          anulate:          number;
          procent_prezenta: number | null;
          venit_total:      number;
          program_activ:    Json | null;
          created_at:       string;
        };
        Insert: never;  // scris doar de cron — nu se inserează din frontend
        Update: never;
      };

    };

    Views: {
      // ── pacienti_view ─────────────────────────────────────────
      pacienti_view: {
        Row: Database['public']['Tables']['pacienti']['Row'] & {
          name: string; // prenume || ' ' || nume — câmpul complet pentru UI
        };
      };
    };

    Functions: {
      arhiveaza_saptamana: {
        Args:    { saptamana_start?: string };
        Returns: void;
      };
      genereaza_notificari_zilnice: {
        Args:    Record<string, never>;
        Returns: void;
      };
    };
  };
}

// ── Tipuri shorthand utile în componente ──────────────────────
export type Profile          = Database['public']['Tables']['profiles']['Row'];
export type Settings         = Database['public']['Tables']['settings']['Row'];
export type Pacient          = Database['public']['Tables']['pacienti']['Row'];
export type PacientInsert    = Database['public']['Tables']['pacienti']['Insert'];
export type PacientUpdate    = Database['public']['Tables']['pacienti']['Update'];
export type Programare       = Database['public']['Tables']['programari']['Row'];
export type ProgramareInsert = Database['public']['Tables']['programari']['Insert'];
export type Notificare       = Database['public']['Tables']['notificari']['Row'];
export type IstericSaptamanal = Database['public']['Tables']['istoric_saptamanal']['Row'];
export type PacientView      = Database['public']['Views']['pacienti_view']['Row'];
