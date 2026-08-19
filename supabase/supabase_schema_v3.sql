-- ============================================================
-- MyCalendar — Schema Supabase v3 CORECTĂ (Postgres)
-- Rulează în: Supabase Dashboard → SQL Editor → New Query
-- SAFE TO RE-RUN: folosește DROP IF EXISTS + OR REPLACE
--
-- CE S-A SCHIMBAT FAȚĂ DE v2:
--   1) `pacienti` — adăugate 4 coloane lipsă față de UI:
--        cost, plan, locatie, frecventa
--   2) `programari` — adăugată coloana `note` (Session Notes din WrapUp)
--   3) `historic_saptamanal` — adăugată coloana `venit_total`
--        (calculată automat în funcția de arhivare)
--   4) `profiles` — adăugat `display_name` pentru afișaj (nu doar username)
-- ============================================================

-- ------------------------------------------------------------
-- EXTENSII
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ------------------------------------------------------------
-- CURĂȚĂ TABELELE VECHI
-- ------------------------------------------------------------
DROP TABLE IF EXISTS public.istoric_saptamanal  CASCADE;
DROP TABLE IF EXISTS public.notificari           CASCADE;
DROP TABLE IF EXISTS public.programari           CASCADE;
DROP TABLE IF EXISTS public.pacienti             CASCADE;
DROP TABLE IF EXISTS public.profiles             CASCADE;
DROP TABLE IF EXISTS public.settings             CASCADE;

-- ------------------------------------------------------------
-- CURĂȚĂ FUNCȚIILE VECHI
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.handle_new_user()                CASCADE;
DROP FUNCTION IF EXISTS public.actualizeaza_status_abonament()  CASCADE;
DROP FUNCTION IF EXISTS public.set_updated_at()                 CASCADE;
DROP FUNCTION IF EXISTS public.genereaza_notificari_zilnice()   CASCADE;
DROP FUNCTION IF EXISTS public.valideaza_programare()           CASCADE;
DROP FUNCTION IF EXISTS public.impune_settings_singleton()      CASCADE;
DROP FUNCTION IF EXISTS public.arhiveaza_saptamana(date)        CASCADE;

-- Dezînscrie job-uri cron vechi
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'notificari-zilnice';
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'arhivare-saptamanala';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;


-- ============================================================
-- FUNCȚIE UTILITARĂ: updated_at automat (folosită pe mai multe tabele)
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$;


-- ============================================================
-- 1. PROFILES — extinde auth.users (terapeut unic)
--    Câmpuri aliniate cu ecranul Settings → Profil personal:
--      display_name  → câmpul "Nume" din UI
--      username      → câmpul "Utilizator (@roxanavieru)"
--      telefon       → câmpul "Telefon"
--    Email vine direct din auth.users.email — nu se duplică aici.
-- ============================================================
CREATE TABLE public.profiles (
  id            UUID         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  TEXT,                          -- ex: "Roxana Vieru"
  username      TEXT         NOT NULL UNIQUE,  -- ex: "@roxanavieru"
  telefon       TEXT,                          -- ex: "+40 722 000 111"
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, username, display_name)
  VALUES (
    new.id,
    COALESCE(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    COALESCE(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS trg_new_user ON auth.users;
CREATE TRIGGER trg_new_user
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================
-- 2. SETTINGS — configurare aplicație (singleton: 1 singur rând)
--    Aliniat complet cu ecranul Settings din UI:
--      therapist_name          → Settings → Profil → Nume (alias vizual)
--      work_start/work_end     → Settings → Program de lucru → Ore
--      zile_lucratoare         → Settings → Program → Zile (L=1...V=5)
--      lunch_start/lunch_end   → Settings → Pauza de masă
--      session_duration        → Settings → Ședințe → Durată
--      break_buffer            → Settings → Ședințe → Pauză între pacienți
--      default_price           → Settings → Ședințe → Preț ședință
--      reminder_threshold      → Settings → Reminder → ultima ședință (la câte)
--      whatsapp_template       → Settings → Reminder → Mesaj reminder
--      categories              → Settings → Categorii pacienți
-- ============================================================
CREATE TABLE public.settings (
  id                      UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist_name          VARCHAR(100)   DEFAULT 'Roxana',
  work_start              TIME           DEFAULT '08:00',
  work_end                TIME           DEFAULT '20:00',
  lunch_start             TIME           DEFAULT '12:00',
  lunch_end               TIME           DEFAULT '12:30',
  session_duration        INT            DEFAULT 50  CHECK (session_duration > 0),
  break_buffer            INT            DEFAULT 10  CHECK (break_buffer >= 0),
  zile_lucratoare         INT[]          DEFAULT ARRAY[1,2,3,4,5],
  default_price           DECIMAL(10,2)  DEFAULT 150.00,
  default_total_sessions  INT            DEFAULT 10,
  reminder_threshold      INT            DEFAULT 2,
  whatsapp_template       TEXT           DEFAULT 'Bună, {nume}! Mai ai {ramase} ședințe rămase. Dorești reînnoirea?',
  categories              TEXT[]         DEFAULT ARRAY['Kinetoterapie', 'Belaqva', 'Ghimbav', 'Recuperare'],
  updated_at              TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CHECK (work_start < work_end),
  CHECK (lunch_start < lunch_end),
  CHECK (lunch_start >= work_start AND lunch_end <= work_end)
);

CREATE OR REPLACE FUNCTION public.impune_settings_singleton()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM public.settings) >= 1 THEN
    RAISE EXCEPTION 'Există deja un rând de settings — modifică-l cu UPDATE.';
  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS trg_settings_singleton ON public.settings;
CREATE TRIGGER trg_settings_singleton
  BEFORE INSERT ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.impune_settings_singleton();

DROP TRIGGER IF EXISTS trg_settings_updated_at ON public.settings;
CREATE TRIGGER trg_settings_updated_at
  BEFORE UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.settings DEFAULT VALUES;


-- ============================================================
-- 3. PACIENTI — aliniat complet cu AddPatientSheet.astro
--    Câmpuri noi față de v2:
--      cost     → câmpul "Cost (RON)" per pacient (poate diferi de default_price)
--      plan     → chip-urile "Subscription" / "One Time"
--      locatie  → chip-urile "Belaqva" / "Ghimbav" (folosit și la filtrare)
--      frecventa → chip-urile "1/week", "2/week", "3/week", "Occasional"
--
--    Decizie: UI trimite un câmp unic "name" (ex: "Maria Popescu").
--    DB îl stochează ca nume + prenume separate (primul cuvânt = prenume,
--    restul = nume) — util pentru sortare și afișaj formal.
--    La citire: concatenăm prenume || ' ' || nume pentru UI.
-- ============================================================
CREATE TABLE public.pacienti (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  nume              TEXT         NOT NULL,                     -- ex: "Popescu"
  prenume           TEXT         NOT NULL,                     -- ex: "Maria"
  telefon           TEXT         NOT NULL,
  locatie           TEXT         NOT NULL DEFAULT 'Belaqva'
                      CHECK (locatie IN ('Belaqva', 'Ghimbav')),
  plan              TEXT         NOT NULL DEFAULT 'Subscription'
                      CHECK (plan IN ('Subscription', 'One Time')),
  frecventa         TEXT         NOT NULL DEFAULT '1/week',    -- text liber sau chip
  cost              DECIMAL(10,2) NOT NULL DEFAULT 0,          -- cost per pachet
  sedinte_total     INT          NOT NULL DEFAULT 0 CHECK (sedinte_total >= 0),
  sedinte_folosite  INT          NOT NULL DEFAULT 0 CHECK (sedinte_folosite >= 0),
  sedinte_ramase    INT          GENERATED ALWAYS AS (sedinte_total - sedinte_folosite) STORED,
  achitat           BOOLEAN      NOT NULL DEFAULT false,
  status_abonament  TEXT         NOT NULL DEFAULT 'activ'
                      CHECK (status_abonament IN ('activ','ultima_sedinta','terminat')),
  notite            TEXT,                                      -- câmp liber, opțional
  drive_link        TEXT,                                      -- link Google Drive
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CHECK (sedinte_folosite <= sedinte_total)
);

CREATE INDEX IF NOT EXISTS idx_pacienti_nume     ON public.pacienti (nume, prenume);
CREATE INDEX IF NOT EXISTS idx_pacienti_locatie  ON public.pacienti (locatie);
CREATE INDEX IF NOT EXISTS idx_pacienti_achitat  ON public.pacienti (achitat);

-- Trigger: actualizează automat status_abonament la schimbarea ședințelor
CREATE OR REPLACE FUNCTION public.actualizeaza_status_abonament()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  ramase INT;
BEGIN
  ramase := new.sedinte_total - new.sedinte_folosite;
  IF ramase <= 0 THEN
    new.status_abonament := 'terminat';
  ELSIF ramase = 1 THEN
    new.status_abonament := 'ultima_sedinta';
  ELSE
    new.status_abonament := 'activ';
  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS trg_status_abonament ON public.pacienti;
CREATE TRIGGER trg_status_abonament
  BEFORE INSERT OR UPDATE OF sedinte_total, sedinte_folosite ON public.pacienti
  FOR EACH ROW EXECUTE FUNCTION public.actualizeaza_status_abonament();

DROP TRIGGER IF EXISTS trg_pacienti_updated_at ON public.pacienti;
CREATE TRIGGER trg_pacienti_updated_at
  BEFORE UPDATE ON public.pacienti
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================
-- 4. PROGRAMARI — aliniat cu AddSessionSheet + SessionWrapUpSheet
--    Câmpuri noi față de v2:
--      note → câmpul "Session Notes" din SessionWrapUpSheet
--      locatie → locația sesiunii (poate diferi de locația preferată a pacientului)
--    `motiv` → păstrat pentru motiv anulare/absență (diferit de note)
-- ============================================================
CREATE TABLE public.programari (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pacient_id  UUID        NOT NULL REFERENCES public.pacienti(id) ON DELETE CASCADE,
  data        DATE        NOT NULL,
  ora         TIME        NOT NULL,
  locatie     TEXT        NOT NULL DEFAULT 'Belaqva'
                CHECK (locatie IN ('Belaqva', 'Ghimbav')),
  status      TEXT        NOT NULL DEFAULT 'programat'
                CHECK (status IN ('programat','confirmat','finalizat','anulat','absent')),
  note        TEXT,       -- note de sesiune (SessionWrapUpSheet → "Session Notes")
  motiv       TEXT,       -- motiv anulare sau absență
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_programari_data    ON public.programari (data);
CREATE INDEX IF NOT EXISTS idx_programari_pacient ON public.programari (pacient_id);
CREATE INDEX IF NOT EXISTS idx_programari_status  ON public.programari (status);

-- Trigger: validare dinamică a programării față de settings curent
CREATE OR REPLACE FUNCTION public.valideaza_programare()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  s         public.settings;
  durata    INTERVAL;
  fereastra INTERVAL;
  conflicte INT;
BEGIN
  SELECT * INTO s FROM public.settings LIMIT 1;
  IF s IS NULL THEN
    RAISE EXCEPTION 'Nu există configurare în settings.';
  END IF;

  durata    := (s.session_duration || ' minutes')::interval;
  fereastra := ((s.session_duration + s.break_buffer) || ' minutes')::interval;

  -- 1) Zi lucrătoare
  IF NOT (EXTRACT(isodow FROM new.data)::int = ANY (s.zile_lucratoare)) THEN
    RAISE EXCEPTION 'Data % nu este zi de lucru conform setărilor curente.', new.data;
  END IF;

  -- 2) Interval orar de lucru
  IF NOT (new.ora >= s.work_start AND new.ora + durata <= s.work_end) THEN
    RAISE EXCEPTION 'Ora % este în afara programului de lucru (% – %).', new.ora, s.work_start, s.work_end;
  END IF;

  -- 3) Fără suprapunere cu pauza de masă
  IF NOT (new.ora + durata <= s.lunch_start OR new.ora >= s.lunch_end) THEN
    RAISE EXCEPTION 'Ora % se suprapune cu pauza de masă (% – %).', new.ora, s.lunch_start, s.lunch_end;
  END IF;

  -- 4) Fără suprapunere cu altă programare activă
  SELECT count(*) INTO conflicte
  FROM public.programari p
  WHERE p.data = new.data
    AND p.status NOT IN ('anulat', 'absent')
    AND p.id IS DISTINCT FROM new.id
    AND tsrange((p.data + p.ora)::timestamp, (p.data + p.ora)::timestamp + fereastra)
        && tsrange((new.data + new.ora)::timestamp, (new.data + new.ora)::timestamp + fereastra);

  IF conflicte > 0 THEN
    RAISE EXCEPTION 'Ora % se suprapune cu o altă programare (fereastră minimă: % min).',
      new.ora, s.session_duration + s.break_buffer;
  END IF;

  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS trg_valideaza_programare ON public.programari;
-- Validăm doar când se programează/reprogramează (data sau ora), nu la schimbarea statusului.
CREATE TRIGGER trg_valideaza_programare
  BEFORE INSERT OR UPDATE OF data, ora ON public.programari
  FOR EACH ROW EXECUTE FUNCTION public.valideaza_programare();

-- Trigger: incrementează/decrementează automat sedinte_folosite la finalizarea/ștergerea sesiunii
CREATE OR REPLACE FUNCTION public.incrementeaza_sedinte_folosite()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Când o programare devine 'finalizat', incrementăm sedinte_folosite,
  -- dar nu depășim sedinte_total (evităm violarea check-ului când pachetul e terminat)
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.status = 'finalizat' AND (OLD.status IS NULL OR OLD.status <> 'finalizat') THEN
      UPDATE public.pacienti
      SET sedinte_folosite = LEAST(sedinte_folosite + 1, sedinte_total)
      WHERE id = NEW.pacient_id;
    END IF;
    -- Dacă revenim din 'finalizat' (corecție), decrementăm
    IF OLD.status = 'finalizat' AND NEW.status <> 'finalizat' THEN
      UPDATE public.pacienti
      SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
      WHERE id = NEW.pacient_id;
    END IF;
  END IF;

  -- Dacă o programare 'finalizat' este ștearsă, decrementăm contorul
  -- pentru a nu contoriza dublu la ștergere + recreare aceeași ședință.
  IF TG_OP = 'DELETE' AND OLD.status = 'finalizat' THEN
    UPDATE public.pacienti
    SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
    WHERE id = OLD.pacient_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_incrementeaza_sedinte ON public.programari;
CREATE TRIGGER trg_incrementeaza_sedinte
  AFTER INSERT OR UPDATE OF status OR DELETE ON public.programari
  FOR EACH ROW EXECUTE FUNCTION public.incrementeaza_sedinte_folosite();


-- ============================================================
-- 4b. PLĂȚI — înregistrări financiare separate pentru flexibilitate
-- ============================================================
CREATE TABLE IF NOT EXISTS public.plati (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pacient_id  UUID        NOT NULL REFERENCES public.pacienti(id) ON DELETE CASCADE,
  suma        NUMERIC(10, 2) NOT NULL,
  data_platii DATE        NOT NULL DEFAULT CURRENT_DATE,
  metoda      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plati_pacient ON public.plati (pacient_id);
CREATE INDEX IF NOT EXISTS idx_plati_data     ON public.plati (data_platii);

ALTER TABLE public.plati ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all access to plati" ON public.plati;
CREATE POLICY "Allow all access to plati" ON public.plati FOR ALL USING (true) WITH CHECK (true);


-- ============================================================
-- 5. NOTIFICARI
-- ============================================================
CREATE TABLE public.notificari (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pacient_id       UUID        REFERENCES public.pacienti(id) ON DELETE CASCADE,
  titlu            TEXT        NOT NULL,
  mesaj            TEXT,
  tip              TEXT        NOT NULL DEFAULT 'info'
                     CHECK (tip IN ('info', 'abonament', 'plata', 'reminder')),
  data_declansare  TIMESTAMPTZ NOT NULL DEFAULT now(),
  citita           BOOLEAN     NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notificari_necitite  ON public.notificari (citita) WHERE citita = false;
CREATE INDEX IF NOT EXISTS idx_notificari_pacient   ON public.notificari (pacient_id);

CREATE OR REPLACE FUNCTION public.genereaza_notificari_zilnice()
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  -- Notificări abonament terminat / ultima ședință
  INSERT INTO public.notificari (pacient_id, titlu, mesaj, tip)
  SELECT p.id,
         CASE p.status_abonament
           WHEN 'terminat'      THEN 'Abonament terminat'
           ELSE                      'Ultima ședință din pachet'
         END,
         p.prenume || ' ' || p.nume ||
           CASE p.status_abonament
             WHEN 'terminat' THEN ' nu mai are ședințe în pachet.'
             ELSE                 ' este la ultima ședință din pachet.'
           END,
         'abonament'
  FROM public.pacienti p
  WHERE p.status_abonament IN ('terminat','ultima_sedinta')
    AND NOT EXISTS (
      SELECT 1 FROM public.notificari n
      WHERE n.pacient_id = p.id
        AND n.tip = 'abonament'
        AND n.created_at > now() - INTERVAL '7 days'
    );

  -- Notificări plată în așteptare
  INSERT INTO public.notificari (pacient_id, titlu, mesaj, tip)
  SELECT p.id,
         'Plată în așteptare',
         p.prenume || ' ' || p.nume || ' nu a achitat încă.',
         'plata'
  FROM public.pacienti p
  WHERE p.achitat = false
    AND NOT EXISTS (
      SELECT 1 FROM public.notificari n
      WHERE n.pacient_id = p.id
        AND n.tip = 'plata'
        AND n.created_at > now() - INTERVAL '7 days'
    );

  -- Curăță notificările vechi citite (>30 zile)
  DELETE FROM public.notificari
  WHERE citita = true AND created_at < now() - INTERVAL '30 days';
END;
$$;

SELECT cron.schedule(
  'notificari-zilnice',
  '0 7 * * *',
  $$SELECT public.genereaza_notificari_zilnice();$$
);


-- ============================================================
-- 6. ISTORIC SĂPTĂMÂNAL — aliniat cu ReportsView.astro
--    Câmp nou față de v2:
--      venit_total → venitul calculat din cost × ședințe finalizate
--                    (pentru graficul săptămânal din Reports)
-- ============================================================
CREATE TABLE public.istoric_saptamanal (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  saptamana_start   DATE        NOT NULL,
  saptamana_end     DATE        NOT NULL,
  total_programari  INT         NOT NULL DEFAULT 0,
  finalizate        INT         NOT NULL DEFAULT 0,
  absente           INT         NOT NULL DEFAULT 0,
  anulate           INT         NOT NULL DEFAULT 0,
  procent_prezenta  NUMERIC(5,2),
  venit_total       DECIMAL(10,2) DEFAULT 0, -- RON încasat în săptămâna respectivă
  program_activ     JSONB,                   -- snapshot din settings la momentul arhivării
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (saptamana_start)
);

CREATE INDEX IF NOT EXISTS idx_istoric_saptamana ON public.istoric_saptamanal (saptamana_start DESC);

CREATE OR REPLACE FUNCTION public.arhiveaza_saptamana(saptamana_start DATE DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  start_zi    DATE;
  sfarsit_zi  DATE;
  s           public.settings;
  v_total     INT;
  v_final     INT;
  v_absent    INT;
  v_anulat    INT;
  v_venit     DECIMAL(10,2);
BEGIN
  start_zi   := COALESCE(saptamana_start, (date_trunc('week', CURRENT_DATE - INTERVAL '7 days'))::date);
  sfarsit_zi := start_zi + 4;

  SELECT * INTO s FROM public.settings LIMIT 1;

  SELECT
    count(*),
    count(*) FILTER (WHERE pr.status = 'finalizat'),
    count(*) FILTER (WHERE pr.status = 'absent'),
    count(*) FILTER (WHERE pr.status = 'anulat'),
    -- venitul: suma costurilor pacienților cu ședințe finalizate în săptămână
    COALESCE(SUM(p.cost) FILTER (WHERE pr.status = 'finalizat'), 0)
  INTO v_total, v_final, v_absent, v_anulat, v_venit
  FROM public.programari pr
  JOIN public.pacienti p ON p.id = pr.pacient_id
  WHERE pr.data BETWEEN start_zi AND sfarsit_zi;

  INSERT INTO public.istoric_saptamanal
    (saptamana_start, saptamana_end, total_programari, finalizate, absente, anulate,
     procent_prezenta, venit_total, program_activ)
  VALUES (
    start_zi, sfarsit_zi, v_total, v_final, v_absent, v_anulat,
    CASE WHEN v_total > 0 THEN round(100.0 * v_final / v_total, 2) ELSE NULL END,
    v_venit,
    to_jsonb(s)
  )
  ON CONFLICT (saptamana_start) DO UPDATE SET
    saptamana_end    = EXCLUDED.saptamana_end,
    total_programari = EXCLUDED.total_programari,
    finalizate       = EXCLUDED.finalizate,
    absente          = EXCLUDED.absente,
    anulate          = EXCLUDED.anulate,
    procent_prezenta = EXCLUDED.procent_prezenta,
    venit_total      = EXCLUDED.venit_total,
    program_activ    = EXCLUDED.program_activ;
END;
$$;

SELECT cron.schedule(
  'arhivare-saptamanala',
  '10 0 * * 1',
  $$SELECT public.arhiveaza_saptamana();$$
);

GRANT EXECUTE ON FUNCTION public.arhiveaza_saptamana(date) TO authenticated;


-- ============================================================
-- 7. ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE public.profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pacienti           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.programari         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notificari         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.istoric_saptamanal ENABLE ROW LEVEL SECURITY;

-- Profiles: fiecare utilizator vede/modifică doar propriul profil
CREATE POLICY "acces propriul profil" ON public.profiles
  FOR ALL USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Pacienti: orice utilizator autentificat (terapeut unic)
CREATE POLICY "admin acces total pacienti" ON public.pacienti
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- Programari: orice utilizator autentificat
CREATE POLICY "admin acces total programari" ON public.programari
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- Notificari: orice utilizator autentificat
CREATE POLICY "admin acces total notificari" ON public.notificari
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- Settings: citire publică (pentru trigger), modificare doar autentificat
CREATE POLICY "citire publica settings" ON public.settings
  FOR SELECT USING (true);
CREATE POLICY "admin modificare settings" ON public.settings
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- Istoric: citire autentificat (scriere doar din cron, nu e supus RLS)
CREATE POLICY "admin citire istoric" ON public.istoric_saptamanal
  FOR SELECT USING (auth.role() = 'authenticated');


-- ============================================================
-- 8. VIEW UTILĂ: pacienti_complet
--    Returnează numele complet (prenume || ' ' || nume), toate
--    câmpurile pacientului și suma încasată totală din tabela plati.
-- ============================================================
CREATE OR REPLACE VIEW public.pacienti_view AS
SELECT
  p.id,
  p.prenume || ' ' || p.nume                       AS name,   -- "Maria Popescu" — compatibil cu UI
  p.nume,
  p.prenume,
  p.telefon,
  p.locatie,
  p.plan,
  p.frecventa,
  p.cost,
  p.sedinte_total,
  p.sedinte_folosite,
  p.sedinte_ramase,
  p.achitat,
  p.status_abonament,
  p.notite,
  p.drive_link,
  p.created_at,
  p.updated_at,
  COALESCE((SELECT SUM(pl.suma) FROM public.plati pl WHERE pl.pacient_id = p.id), 0) AS suma_incasata
FROM public.pacienti p;


-- ============================================================
-- 9. EXEMPLE DE UTILIZARE DIN FRONTEND (Supabase JS)
-- ============================================================
--
-- [AUTH] Login:
--   const { data, error } = await supabase.auth.signInWithPassword({ email, password })
--
-- [AUTH] Signup:
--   const { data, error } = await supabase.auth.signUp({
--     email, password,
--     options: { data: { username: '@roxanavieru', display_name: 'Roxana Vieru' } }
--   })
--
-- [SETTINGS] Citire:
--   const { data: settings } = await supabase.from('settings').select('*').single()
--
-- [SETTINGS] Salvare orar:
--   await supabase.from('settings').update({ work_start: '09:00', work_end: '18:00' }).eq('id', settings.id)
--
-- [PACIENTI] Listă cu filtru locație:
--   const { data } = await supabase.from('pacienti_view').select('*').eq('locatie', 'Belaqva')
--
-- [PACIENTI] Adăugare (name "Maria Popescu" → split în JS):
--   const parts = name.trim().split(' ')
--   const prenume = parts[0]                    // "Maria"
--   const nume = parts.slice(1).join(' ')       // "Popescu"
--   await supabase.from('pacienti').insert({ nume, prenume, telefon, locatie, plan, cost, ... })
--
-- [PROGRAMARI] Adăugare sesiune:
--   await supabase.from('programari').insert({ pacient_id, data, ora, locatie })
--   // Trigger-ul valideaza_programare rulează automat în DB
--
-- [PROGRAMARI] Finalizare sesiune (WrapUp):
--   await supabase.from('programari').update({ status: 'finalizat', note: notesText }).eq('id', sessionId)
--   // Trigger-ul incrementeaza_sedinte_folosite rulează automat
--
-- [PLATA] Marcare achitat:
--   await supabase.from('pacienti').update({ achitat: true }).eq('id', patientId)
--
-- [RAPOARTE] Istoricul ultimelor 8 săptămâni:
--   const { data } = await supabase
--     .from('istoric_saptamanal')
--     .select('saptamana_start, finalizate, absente, procent_prezenta, venit_total')
--     .order('saptamana_start', { ascending: false })
--     .limit(8)
--
-- [RAPOARTE] Arhivare manuală săptămână:
--   await supabase.rpc('arhiveaza_saptamana', { saptamana_start: '2026-08-03' })
--
-- [NOTIFICARI] Necitite:
--   const { data } = await supabase.from('notificari').select('*').eq('citita', false).order('created_at', { ascending: false })
--
-- [NOTIFICARI] Marcare citită:
--   await supabase.from('notificari').update({ citita: true }).eq('id', notifId)
--
-- ============================================================
