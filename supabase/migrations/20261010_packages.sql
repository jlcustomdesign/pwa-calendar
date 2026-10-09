-- ═══════════════════════════════════════════════════════════════════
-- Pachete de ședințe ca rânduri reale (packages as first-class rows)
--
-- Până acum „pachetul" era o inferență din date și sume (abonament_start,
-- ferestre de date) — de acolo veneau amestecurile. De acum:
-- 1. abonamente: un rând per pachet real. Ședința contorizează DOAR prin
--    programari.abonament_id (FK), niciodată prin ferestre de date.
-- 2. Un singur pachet deschis per pacient (index unic parțial) — reînnoirea
--    închide rândul vechi și deschide unul nou cu datorie de over-delivery.
-- 3. Plata se leagă de pachet (plati.abonament_id); achitat = SUM >= pret
--    pe acel pachet — nu mai există fereastră de ghicit.
-- 4. Triggerul de contor menține AMBELE contoare (rândul pachet + coloanele
--    vechi de pe pacienti) ca să rămână compatibil cu aplicația deja
--    deployed până când citirile migrează complet.
-- ═══════════════════════════════════════════════════════════════════

-- a) Tabelul de pachete
CREATE TABLE IF NOT EXISTS public.abonamente (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pacient_id uuid NOT NULL REFERENCES public.pacienti(id) ON DELETE CASCADE,
  user_id uuid,
  nr_sedinte int NOT NULL DEFAULT 8 CHECK (nr_sedinte > 0),
  pret numeric NOT NULL DEFAULT 0 CHECK (pret >= 0),
  sedinte_folosite int NOT NULL DEFAULT 0 CHECK (sedinte_folosite >= 0),
  datorie_initiala int NOT NULL DEFAULT 0 CHECK (datorie_initiala >= 0),
  status text NOT NULL DEFAULT 'activ' CHECK (status IN ('activ', 'inchis')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS abonamente_one_open_per_patient
  ON public.abonamente(pacient_id) WHERE status = 'activ';
CREATE INDEX IF NOT EXISTS abonamente_pacient_idx ON public.abonamente(pacient_id);

ALTER TABLE public.abonamente ENABLE ROW LEVEL SECURITY;
CREATE POLICY abonamente_owner ON public.abonamente FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Vizualizare: pachetul deschis al fiecărui pacient
CREATE OR REPLACE VIEW public.pachet_curent
WITH (security_invoker = true) AS
SELECT * FROM public.abonamente WHERE status = 'activ';

-- b) Legături explicite
ALTER TABLE programari ADD COLUMN IF NOT EXISTS abonament_id uuid REFERENCES public.abonamente(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_programari_abonament ON programari(abonament_id);
ALTER TABLE plati ADD COLUMN IF NOT EXISTS abonament_id uuid REFERENCES public.abonamente(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_plati_abonament ON plati(abonament_id);

-- c) Backfill cu triggerul vechi oprit (altfel +1 pe pacienti la fiecare legare).
--    Un pachet per pacient cu abonament; ședințele contorizate se leagă la el.
ALTER TABLE public.programari DISABLE TRIGGER trg_incrementeaza_sedinte;

INSERT INTO public.abonamente (pacient_id, user_id, nr_sedinte, pret, sedinte_folosite, status, created_at)
SELECT p.id, p.user_id, GREATEST(1, p.sedinte_total), GREATEST(0, p.cost), p.sedinte_folosite, 'activ',
       COALESCE(p.abonament_start::timestamptz, p.created_at)
FROM public.pacienti p
WHERE p.plan IS DISTINCT FROM 'One Time'
  AND NOT EXISTS (SELECT 1 FROM public.abonamente a WHERE a.pacient_id = p.id);

UPDATE public.programari pr
SET abonament_id = a.id
FROM public.abonamente a
JOIN public.pacienti p ON p.id = a.pacient_id
WHERE a.status = 'activ'
  AND pr.pacient_id = a.pacient_id
  AND pr.status = 'finalizat'
  AND pr.contorizeaza
  AND pr.abonament_id IS NULL
  AND (p.abonament_start IS NULL OR pr.data >= p.abonament_start);

-- Contorul pachetului = numărul real de ședințe legate (poate depăși
-- plafonul — over-delivery nu se mai pierde).
UPDATE public.abonamente a
SET sedinte_folosite = COALESCE(sub.cnt, 0)
FROM (
  SELECT abonament_id, count(*) AS cnt
  FROM public.programari
  WHERE abonament_id IS NOT NULL AND status = 'finalizat'
  GROUP BY abonament_id
) sub
WHERE a.id = sub.abonament_id;

-- Plățile din fereastra curentă se leagă la pachetul deschis.
UPDATE public.plati pl
SET abonament_id = a.id
FROM public.abonamente a
JOIN public.pacienti p ON p.id = a.pacient_id
WHERE a.status = 'activ'
  AND pl.pacient_id = a.pacient_id
  AND pl.abonament_id IS NULL
  AND (p.abonament_start IS NULL OR pl.data_platii >= p.abonament_start);

-- d) BEFORE trigger: leagă ședința de pachetul deschis la finalizare.
--    Pacient cu abonament fără pachet activ → EROARE (wrap-up forțează reînnoirea).
CREATE OR REPLACE FUNCTION public.lega_sedinta_de_pachet()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_pkg uuid;
  v_plan text;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.status = 'finalizat' AND NEW.contorizeaza THEN
      IF NEW.abonament_id IS NULL THEN
        SELECT id INTO v_pkg FROM public.abonamente
          WHERE pacient_id = NEW.pacient_id AND status = 'activ' LIMIT 1;
        IF v_pkg IS NULL THEN
          SELECT plan INTO v_plan FROM public.pacienti WHERE id = NEW.pacient_id;
          IF v_plan IS DISTINCT FROM 'One Time' THEN
            RAISE EXCEPTION 'Pacientul nu are un pachet activ. Reînnoiește abonamentul înainte de a confirma ședința.';
          END IF;
        END IF;
        NEW.abonament_id := v_pkg; -- NULL pentru Ședință unică (fără pachet)
      END IF;
    ELSE
      NEW.abonament_id := NULL; -- nefinalizată sau exclusă: fără pachet
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lega_sedinta ON public.programari;
CREATE TRIGGER trg_lega_sedinta
  BEFORE INSERT OR UPDATE OF status, contorizeaza ON public.programari
  FOR EACH ROW EXECUTE FUNCTION public.lega_sedinta_de_pachet();

-- e) AFTER trigger: contor pe rândul pachetului + compatibilitate coloanele
--    vechi de pe pacienti (LEAST/... ca înainte — aplicația deployed le citește).
CREATE OR REPLACE FUNCTION public.numara_sedinte()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_old_counted boolean := false;
  v_new_counted boolean := false;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_counted := (NEW.status = 'finalizat' AND NEW.contorizeaza AND NEW.abonament_id IS NOT NULL);
    IF TG_OP = 'UPDATE' THEN
      v_old_counted := (OLD.status = 'finalizat' AND OLD.contorizeaza AND OLD.abonament_id IS NOT NULL);
    END IF;

    IF v_new_counted AND NOT v_old_counted THEN
      UPDATE public.abonamente SET sedinte_folosite = sedinte_folosite + 1
        WHERE id = NEW.abonament_id;
      UPDATE public.pacienti SET sedinte_folosite = LEAST(sedinte_folosite + 1, sedinte_total)
        WHERE id = NEW.pacient_id;
    ELSIF v_old_counted AND NOT v_new_counted THEN
      UPDATE public.abonamente SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.abonament_id;
      UPDATE public.pacienti SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.pacient_id;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'finalizat' AND OLD.contorizeaza AND OLD.abonament_id IS NOT NULL THEN
      UPDATE public.abonamente SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.abonament_id;
      UPDATE public.pacienti SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.pacient_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_incrementeaza_sedinte ON public.programari;
CREATE TRIGGER trg_incrementeaza_sedinte
  AFTER INSERT OR UPDATE OF status, contorizeaza, abonament_id OR DELETE ON public.programari
  FOR EACH ROW EXECUTE FUNCTION public.numara_sedinte();

-- f) Reînnoire pe rânduri: pachet neepuizat → confirmă plata pe el;
--    pachet epuizat → închide + pachet nou cu datoria de over-delivery.
CREATE OR REPLACE FUNCTION public.renew_package(
  p_pacient_id uuid,
  p_total int,
  p_cost numeric,
  p_paid numeric DEFAULT 0,
  p_status text DEFAULT 'Neachitat'
) RETURNS void AS $f$
DECLARE
  v_pacient pacienti%ROWTYPE;
  v_old abonamente%ROWTYPE;
  v_debt int;
BEGIN
  SELECT * INTO v_pacient FROM pacienti WHERE id = p_pacient_id FOR UPDATE;
  IF NOT FOUND OR v_pacient.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Pacient invalid sau neautorizat.';
  END IF;

  SELECT * INTO v_old FROM abonamente
    WHERE pacient_id = p_pacient_id AND status = 'activ' FOR UPDATE;

  IF FOUND AND v_old.sedinte_folosite - v_old.datorie_initiala < v_old.nr_sedinte THEN
    -- Pachet NEEPUIZAT: reînnoirea confirmă plata pe pachetul curent — rândul rămâne.
    UPDATE abonamente SET nr_sedinte = GREATEST(1, p_total), pret = GREATEST(0, p_cost)
      WHERE id = v_old.id;
  ELSE
    -- Pachet EPUIZAT (sau inexistent): închide și deschide unul nou care
    -- poartă ședințele livrate peste plafon (datorie, nu se pierde).
    v_debt := GREATEST(0, COALESCE(v_old.sedinte_folosite, 0) - COALESCE(v_old.nr_sedinte, 0));
    IF FOUND THEN
      UPDATE abonamente SET status = 'inchis', closed_at = now() WHERE id = v_old.id;
    END IF;
    INSERT INTO abonamente (pacient_id, user_id, nr_sedinte, pret, sedinte_folosite, datorie_initiala, status)
    VALUES (p_pacient_id, auth.uid(), GREATEST(1, p_total), GREATEST(0, p_cost), v_debt, v_debt, 'activ');
  END IF;

  PERFORM set_config('app.allow_counter_write', 'on', true);
  UPDATE pacienti SET
    sedinte_total = GREATEST(1, p_total),
    sedinte_folosite = LEAST(
      COALESCE((SELECT sedinte_folosite FROM abonamente WHERE pacient_id = p_pacient_id AND status = 'activ'), 0),
      GREATEST(1, p_total)),
    cost = GREATEST(0, p_cost),
    achitat = (p_status = 'Achitat'),
    status_abonament = 'activ',
    abonament_start = CURRENT_DATE
  WHERE id = p_pacient_id;

  IF p_paid > 0 THEN
    INSERT INTO plati (pacient_id, suma, data_platii, user_id, abonament_id)
    SELECT p_pacient_id, p_paid, CURRENT_DATE, auth.uid(), id
      FROM abonamente WHERE pacient_id = p_pacient_id AND status = 'activ';
  END IF;
END $f$ LANGUAGE plpgsql SECURITY DEFINER;

-- g) record_payment atașat la pachet; achitat = SUM(plati pe pachet) >= pret.
CREATE OR REPLACE FUNCTION public.record_payment(
  p_pacient_id uuid,
  p_suma numeric,
  p_mark_achitat boolean DEFAULT false,
  p_programare_id uuid DEFAULT NULL,
  p_abonament_id uuid DEFAULT NULL
) RETURNS void AS $f$
DECLARE
  v_pacient pacienti%ROWTYPE;
  v_pkg abonamente%ROWTYPE;
  v_total numeric;
BEGIN
  SELECT * INTO v_pacient FROM pacienti WHERE id = p_pacient_id FOR UPDATE;
  IF NOT FOUND OR v_pacient.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Pacient invalid sau neautorizat.';
  END IF;

  IF p_programare_id IS NOT NULL THEN
    PERFORM 1 FROM programari WHERE id = p_programare_id AND pacient_id = p_pacient_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Programarea nu aparține acestui pacient.';
    END IF;
  END IF;

  IF p_abonament_id IS NOT NULL THEN
    SELECT * INTO v_pkg FROM abonamente WHERE id = p_abonament_id AND pacient_id = p_pacient_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pachetul nu aparține acestui pacient.';
    END IF;
  ELSE
    SELECT * INTO v_pkg FROM abonamente
      WHERE pacient_id = p_pacient_id AND status = 'activ' LIMIT 1;
  END IF;

  IF p_suma > 0 THEN
    INSERT INTO plati (pacient_id, suma, data_platii, user_id, programare_id, abonament_id)
    VALUES (p_pacient_id, p_suma, CURRENT_DATE, auth.uid(), p_programare_id, v_pkg.id);
  END IF;

  IF v_pkg.id IS NOT NULL THEN
    SELECT COALESCE(sum(suma), 0) INTO v_total FROM plati
      WHERE abonament_id = v_pkg.id;
    UPDATE pacienti SET achitat = (p_mark_achitat OR (v_pkg.pret > 0 AND v_total >= v_pkg.pret))
      WHERE id = p_pacient_id;
  ELSE
    -- Ședință unică / legacy fără pachet: total istoric (costul e per ședință).
    SELECT COALESCE(sum(suma), 0) INTO v_total FROM plati WHERE pacient_id = p_pacient_id;
    UPDATE pacienti SET achitat = (p_mark_achitat OR (v_pacient.cost > 0 AND v_total >= v_pacient.cost))
      WHERE id = p_pacient_id;
  END IF;
END $f$ LANGUAGE plpgsql SECURITY DEFINER;

DROP FUNCTION IF EXISTS public.record_payment(uuid, numeric, boolean);
DROP FUNCTION IF EXISTS public.record_payment(uuid, numeric, boolean, uuid);
-- renew_subscription devine wrapper peste renew_package (compatibilitate cu
-- aplicația deployed până la migrarea completă a citirilor).
CREATE OR REPLACE FUNCTION public.renew_subscription(
  p_pacient_id uuid,
  p_total int,
  p_cost numeric,
  p_paid numeric DEFAULT 0,
  p_status text DEFAULT 'Neachitat'
) RETURNS void AS $f$
BEGIN
  PERFORM public.renew_package(p_pacient_id, p_total, p_cost, p_paid, p_status);
END $f$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.record_payment(uuid, numeric, boolean, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payment(uuid, numeric, boolean, uuid, uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.renew_package(uuid, int, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.renew_package(uuid, int, numeric, numeric, text) TO authenticated;
