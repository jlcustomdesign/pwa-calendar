-- ═══════════════════════════════════════════════════════════════════
-- Eliminarea completă a abonamentului lunar (tip 'lunar' / plan
-- 'Abonament lunar'). Pachetele lunare devin pachete clasice pe număr
-- de ședințe (tip 'sedinte').
--
-- 1. Conversia datelor existente:
--    - pacienti.plan 'Abonament lunar' → 'Abonament'
--    - abonamente.tip 'lunar' → 'sedinte'
--    - abonamente lunare cu nr_sedinte 0/NULL → 20 ședințe (Vladimir
--      trece pe 20; sedinte_folosite NU se atinge — uzajul e păstrat)
--    - abonamente lunare ACTIVE aveau closed_at = sfârșitul ferestrei de
--      o lună; la pachetele clasice closed_at e NULL cât timp pachetul e
--      deschis → îl golim doar pe cele cu status 'activ' (cele 'inchis'
--      își păstrează data închiderii).
-- 2. CHECK-ul pe abonamente.tip nu mai acceptă 'lunar'.
-- 3. Funcțiile live rescrise fără ramurile lunar:
--    - renew_package (7 arg, varianta canonică din 20261011_canonical)
--    - lega_sedinta_de_pachet (ultima versiune: 20261011_lega_sedinta_fix)
--    - religa_la_mutare_data (ultima versiune: 20261011_review_fixes)
--    - sincronizeaza_pachet_la_plan (ultima versiune: 20261010_lunar_effective_monthly)
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Conversia datelor ────────────────────────────────────────────

UPDATE public.pacienti
  SET plan = 'Abonament'
  WHERE plan = 'Abonament lunar';

UPDATE public.abonamente
  SET tip = 'sedinte',
      nr_sedinte = CASE WHEN COALESCE(nr_sedinte, 0) = 0 THEN 20 ELSE nr_sedinte END,
      closed_at = CASE WHEN status = 'activ' THEN NULL ELSE closed_at END
  WHERE tip = 'lunar';

-- ── 2. CHECK-ul pe tip: doar 'sedinte' ──────────────────────────────

ALTER TABLE public.abonamente DROP CONSTRAINT IF EXISTS abonamente_tip_check;
ALTER TABLE public.abonamente ADD CONSTRAINT abonamente_tip_check
  CHECK (tip IN ('sedinte'));

-- Re-afișăm și CHECK-ul pe plan fără 'Abonament lunar' (idempotent —
-- valabil deja din 20261011_archive_softdelete, dar re-assert sigur).
ALTER TABLE public.pacienti DROP CONSTRAINT IF EXISTS pacienti_plan_check;
ALTER TABLE public.pacienti ADD CONSTRAINT pacienti_plan_check
  CHECK (plan = ANY (ARRAY['Abonament'::text, 'Ședință unică'::text, 'Subscription'::text, 'One Time'::text]));

-- ── 3a. renew_package fără ramura lunară ────────────────────────────
-- Semnătură identică cu varianta canonică (frontendul apelează aceeași
-- RPC); p_tip se păstrează în semnătură pentru compatibilitate dar e
-- ignorat — toate pachetele noi sunt 'sedinte' fără fereastră closed_at.

CREATE OR REPLACE FUNCTION public.renew_package(
  p_pacient_id uuid,
  p_total integer,
  p_cost numeric,
  p_paid numeric DEFAULT 0,
  p_status text DEFAULT 'Neachitat',
  p_tip text DEFAULT NULL,
  p_data_start date DEFAULT NULL
) RETURNS void AS $f$
DECLARE
  v_pacient pacienti%ROWTYPE;
  v_old abonamente%ROWTYPE;
  v_debt int;
BEGIN
  SELECT * INTO v_pacient FROM public.pacienti WHERE id = p_pacient_id FOR UPDATE;
  IF NOT FOUND OR v_pacient.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Pacient invalid sau neautorizat.';
  END IF;
  IF v_pacient.plan IS NOT DISTINCT FROM 'One Time' THEN
    RAISE EXCEPTION 'Pacientul cu ședință unică nu are abonament de reînnoit.';
  END IF;

  SELECT * INTO v_old FROM public.abonamente
    WHERE pacient_id = p_pacient_id AND status = 'activ' FOR UPDATE;

  IF v_old.id IS NOT NULL AND v_old.sedinte_folosite - v_old.datorie_initiala < v_old.nr_sedinte THEN
    -- Pachet NEEPUIZAT: reînnoirea confirmă plata pe pachetul curent — rândul rămâne.
    UPDATE public.abonamente SET nr_sedinte = GREATEST(1, p_total), pret = GREATEST(0, p_cost)
      WHERE id = v_old.id;
  ELSE
    -- Datoria reală de over-delivery: uzaj efectiv peste plafon, sumat pe
    -- pachetele închise + excedentul pachetului curent.
    SELECT COALESCE((
        SELECT sum(GREATEST(0, (a.sedinte_folosite - a.datorie_initiala) - a.nr_sedinte))
        FROM public.abonamente a WHERE a.pacient_id = p_pacient_id AND a.status = 'inchis'
      ), 0) + GREATEST(0, COALESCE(v_old.sedinte_folosite - v_old.datorie_initiala, 0) - COALESCE(v_old.nr_sedinte, 0))
      INTO v_debt;

    IF v_old.id IS NOT NULL THEN
      -- Backdating guard: closed_at nu trece niciodată înaintea lui created_at.
      UPDATE public.abonamente SET status = 'inchis',
        closed_at = GREATEST(COALESCE(p_data_start, CURRENT_DATE), v_old.created_at::date)
        WHERE id = v_old.id;
    END IF;

    INSERT INTO public.abonamente (pacient_id, user_id, nr_sedinte, pret, sedinte_folosite, datorie_initiala, status, tip, created_at, closed_at)
    VALUES (p_pacient_id, auth.uid(), GREATEST(1, p_total), GREATEST(0, p_cost), v_debt, v_debt, 'activ', 'sedinte', CURRENT_TIMESTAMP, NULL);
  END IF;

  PERFORM set_config('app.allow_counter_write', 'on', true);
  UPDATE public.pacienti SET
    sedinte_total = GREATEST(1, p_total),
    sedinte_folosite = COALESCE(
      (SELECT sedinte_folosite FROM public.abonamente WHERE pacient_id = p_pacient_id AND status = 'activ'), 0),
    cost = GREATEST(0, p_cost),
    achitat = (p_status = 'Achitat'),
    status_abonament = 'activ',
    abonament_start = COALESCE(p_data_start, CURRENT_DATE)
  WHERE id = p_pacient_id;

  IF p_paid > 0 THEN
    INSERT INTO public.plati (pacient_id, suma, data_platii, user_id, abonament_id)
    SELECT p_pacient_id, p_paid, COALESCE(p_data_start, CURRENT_DATE), auth.uid(), id
      FROM public.abonamente WHERE pacient_id = p_pacient_id AND status = 'activ';
  END IF;
END $f$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.renew_package(uuid, integer, numeric, numeric, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.renew_package(uuid, integer, numeric, numeric, text, text, date) TO authenticated;

-- ── 3b. lega_sedinta_de_pachet fără auto-crearea pachetului lunar ───
-- Fără ramura lunară: dacă niciun pachet nu acoperă data ședinței, se
-- leagă ultimul pachet activ (comportamentul clasic din ramura ELSE),
-- iar dacă nu există deloc pachet activ se ajunge la eroarea de mai jos.

CREATE OR REPLACE FUNCTION public.lega_sedinta_de_pachet()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_pkg uuid;
  v_plan text;
  v_nu_reinnoi boolean;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.status = 'finalizat' AND NEW.contorizeaza THEN
      IF NEW.abonament_id IS NULL THEN
        SELECT a.id INTO v_pkg
          FROM public.abonamente a
          WHERE a.pacient_id = NEW.pacient_id
            AND a.created_at::date <= NEW.data
            AND (a.closed_at IS NULL OR a.closed_at::date > NEW.data)
          ORDER BY a.created_at DESC LIMIT 1;
        IF v_pkg IS NULL THEN
          SELECT a.id INTO v_pkg
            FROM public.abonamente a
            WHERE a.pacient_id = NEW.pacient_id AND a.status = 'activ'
            ORDER BY a.created_at DESC LIMIT 1;
        END IF;
        IF v_pkg IS NULL THEN
          SELECT p.nu_reinnoi, p.plan INTO v_nu_reinnoi, v_plan
            FROM public.pacienti p WHERE p.id = NEW.pacient_id;
          IF v_plan IS DISTINCT FROM 'One Time' AND v_plan IS DISTINCT FROM 'Ședință unică'
             AND COALESCE(v_nu_reinnoi, false) = false THEN
            RAISE EXCEPTION 'Pacientul nu are un pachet activ. Reînnoiește abonamentul înainte de a confirma ședința.';
          END IF;
        END IF;
        NEW.abonament_id := v_pkg;
      END IF;
    ELSE
      NEW.abonament_id := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ── 3c. religa_la_mutare_data fără ramura lunară ────────────────────
-- Mutarea unei ședințe finalizate în afara oricărui pachet → eroare
-- (clasic), fără crearea automată a unui pachet lunar nou.

CREATE OR REPLACE FUNCTION public.religa_la_mutare_data()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_pkg uuid;
  v_plan text;
  v_nu_reinnoi boolean;
BEGIN
  IF NEW.status = 'finalizat' AND NEW.contorizeaza
     AND OLD.abonament_id IS NOT NULL
     AND NEW.data IS DISTINCT FROM OLD.data THEN
    SELECT a.id INTO v_pkg
      FROM public.abonamente a
      WHERE a.pacient_id = NEW.pacient_id
        AND a.created_at::date <= NEW.data
        AND (a.closed_at IS NULL OR a.closed_at::date > NEW.data)
      ORDER BY a.created_at DESC LIMIT 1;
    IF v_pkg IS NULL THEN
      SELECT p.nu_reinnoi, p.plan INTO v_nu_reinnoi, v_plan
        FROM public.pacienti p WHERE p.id = NEW.pacient_id;
      IF v_plan IS DISTINCT FROM 'One Time' AND v_plan IS DISTINCT FROM 'Ședință unică'
         AND COALESCE(v_nu_reinnoi, false) = false THEN
        RAISE EXCEPTION 'Noua dată (%) nu e acoperită de niciun pachet. Reînnoiește abonamentul sau definalizează ședința înainte de a muta data.', NEW.data;
      END IF;
    END IF;
    NEW.abonament_id := v_pkg;
  END IF;
  RETURN NEW;
END;
$$;

-- ── 3d. sincronizeaza_pachet_la_plan fără conversia lunară ──────────
-- Schimbarea planului nu mai convertește/crează pachete 'lunar';
-- rămâne doar deschiderea automată a unui pachet clasic la trecerea pe
-- un plan de abonament dacă pacientul nu are deloc pachete.

CREATE OR REPLACE FUNCTION public.sincronizeaza_pachet_la_plan()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan IS DISTINCT FROM OLD.plan
     AND NEW.plan IS DISTINCT FROM 'One Time' AND NEW.plan IS DISTINCT FROM 'Ședință unică'
     AND NOT EXISTS (SELECT 1 FROM public.abonamente WHERE pacient_id = NEW.id) THEN
    INSERT INTO public.abonamente (pacient_id, user_id, nr_sedinte, pret, status, tip, created_at, closed_at)
    VALUES (NEW.id, NEW.user_id, GREATEST(1, NEW.sedinte_total), GREATEST(0, NEW.cost), 'activ', 'sedinte',
            CURRENT_DATE, NULL);
  END IF;
  RETURN NEW;
END;
$$;
