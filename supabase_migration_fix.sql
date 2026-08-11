-- ============================================================
-- MIGRATION FIX — Kineto Dashboard
-- Rulează în: Supabase Dashboard → SQL Editor → New Query
-- SAFE: nu șterge date existente, doar repară conflictele
-- ============================================================

-- ============================================================
-- FIX 1: status_abonament trigger — să NU suprascrie 'inactiv'
-- PROBLEMA: triggerul suprascria 'inactiv' cu 'activ' sau 'terminat'
-- la orice UPDATE pe sedinte_folosite. Dacă un pacient era marcat
-- 'inactiv' de logica din patientService.ts, triggerul îl rescria.
-- ============================================================
CREATE OR REPLACE FUNCTION public.actualizeaza_status_abonament()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  ramase INT;
BEGIN
  -- Păstrează 'inactiv' dacă a fost setat explicit — nu-l suprascrie
  IF NEW.status_abonament = 'inactiv' THEN
    RETURN NEW;
  END IF;

  ramase := NEW.sedinte_total - NEW.sedinte_folosite;
  IF ramase <= 0 THEN
    NEW.status_abonament := 'terminat';
  ELSIF ramase = 1 THEN
    NEW.status_abonament := 'ultima_sedinta';
  ELSE
    NEW.status_abonament := 'activ';
  END IF;
  RETURN NEW;
END;
$$;


-- ============================================================
-- FIX 2: pacienti_view — singură definiție corectă
-- PROBLEMA: în schema veche existau 2 definiții care se suprascriau
-- și cea de-a doua folosea status = 'finalizata' (greșit, trebuia 'finalizat')
-- Acum: o singură VIEW clară, cu suma_incasata calculată din tabela plati
-- ============================================================
CREATE OR REPLACE VIEW public.pacienti_view AS
SELECT 
    p.id,
    (p.prenume || ' ' || p.nume)                                           AS name,
    p.nume,
    p.prenume,
    p.telefon,
    p.locatie,
    p.plan,
    p.frecventa,
    p.cost,
    p.sedinte_total,
    p.sedinte_folosite,
    GREATEST(0, p.sedinte_total - p.sedinte_folosite)                      AS sedinte_ramase,
    p.achitat,
    p.status_abonament,
    p.notite,
    p.drive_link,
    p.created_at,
    p.updated_at,
    -- Suma totală plătită (din tabela plati) — folosit în PaymentSheet
    COALESCE(
        (SELECT SUM(pl.suma) FROM public.plati pl WHERE pl.pacient_id = p.id),
        0
    )                                                                       AS suma_incasata
FROM public.pacienti p;


-- ============================================================
-- FIX 3: tabela plati — asigură că există și are permisiuni corecte
-- PROBLEMA: tabela plati putea lipsi dacă schema nu a fost rulată complet
-- ============================================================
CREATE TABLE IF NOT EXISTS public.plati (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pacient_id  UUID        NOT NULL REFERENCES public.pacienti(id) ON DELETE CASCADE,
    suma        NUMERIC(10,2) NOT NULL,
    data_platii DATE        NOT NULL DEFAULT CURRENT_DATE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plati_pacient ON public.plati (pacient_id);
CREATE INDEX IF NOT EXISTS idx_plati_data    ON public.plati (data_platii);

-- RLS dezactivat pentru acces liber (terapeut unic)
ALTER TABLE public.plati DISABLE ROW LEVEL SECURITY;


-- ============================================================
-- FIX 4: trigger incrementeaza_sedinte — verifică să nu depășim total
-- PROBLEMA: dacă sedinte_folosite = sedinte_total și se apelează
-- completeSession() din nou, viola CHECK (sedinte_folosite <= sedinte_total)
-- și aplicația crăpa. Acum folosim LEAST() pentru a preveni asta.
-- ============================================================
CREATE OR REPLACE FUNCTION public.incrementeaza_sedinte_folosite()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- La finalizare: incrementează, dar nu depăși sedinte_total
  IF NEW.status = 'finalizat' AND (OLD.status IS NULL OR OLD.status <> 'finalizat') THEN
    UPDATE public.pacienti
    SET sedinte_folosite = LEAST(sedinte_folosite + 1, sedinte_total)
    WHERE id = NEW.pacient_id;
  END IF;

  -- La revenire din finalizat (corecție manuală): decrementează
  IF OLD.status = 'finalizat' AND NEW.status <> 'finalizat' THEN
    UPDATE public.pacienti
    SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
    WHERE id = NEW.pacient_id;
  END IF;

  RETURN NEW;
END;
$$;

-- Asigură trigger-ul e montat corect
DROP TRIGGER IF EXISTS trg_incrementeaza_sedinte ON public.programari;
CREATE TRIGGER trg_incrementeaza_sedinte
  AFTER INSERT OR UPDATE OF status ON public.programari
  FOR EACH ROW EXECUTE FUNCTION public.incrementeaza_sedinte_folosite();


-- ============================================================
-- FIX 5: trigger validare programare — permite UPDATE status
-- PROBLEMA: trigger-ul de validare se declanșa și la UPDATE status
-- (ex: când marcam 'finalizat', 'anulat'), blocând uneori salvarea
-- dacă settings s-a schimbat între timp (alt program de lucru).
-- Acum: validarea rulează DOAR la INSERT și UPDATE pe data/ora.
-- ============================================================
DROP TRIGGER IF EXISTS trg_valideaza_programare ON public.programari;
CREATE TRIGGER trg_valideaza_programare
  BEFORE INSERT OR UPDATE OF data, ora ON public.programari
  FOR EACH ROW EXECUTE FUNCTION public.valideaza_programare();


-- ============================================================
-- FIX 6: RLS dezactivat pe tabele principale
-- (asigură că nu blochează operațiunile din aplicație)
-- ============================================================
ALTER TABLE public.pacienti   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.programari DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.notificari DISABLE ROW LEVEL SECURITY;


-- ============================================================
-- VERIFICARE FINALĂ — rulează aceste query-uri să confirmi că totul e ok
-- ============================================================
-- SELECT column_name, data_type FROM information_schema.columns 
--   WHERE table_name = 'pacienti' ORDER BY ordinal_position;

-- SELECT column_name, data_type FROM information_schema.columns 
--   WHERE table_name = 'plati' ORDER BY ordinal_position;

-- SELECT * FROM public.pacienti_view LIMIT 3;

-- SELECT * FROM public.settings LIMIT 1;
