-- Rămășițe de la adăugarea argului 7: overloadul de 6 argamente e acum
-- un footgun de ambiguitate (la fel ca cel de 5 de ieri).
DROP FUNCTION IF EXISTS public.renew_package(uuid, integer, numeric, numeric, text, text);

-- Cascada de overflow: doar pachetele create DUPĂ pachetul sursă primesc datorie
-- (înainte iteraa tot istoricul, incl. pachete închise cu mult înainte).
CREATE OR REPLACE FUNCTION public.propaga_overflow_lant(p_pacient_id uuid, p_pkg_id uuid)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  v_spill int := 1;
  v_rec record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.abonamente
    WHERE id = p_pkg_id AND status = 'inchis'
      AND sedinte_folosite - datorie_initiala > nr_sedinte
  ) THEN
    RETURN;
  END IF;

  FOR v_rec IN
    SELECT a.id, a.nr_sedinte, a.sedinte_folosite, a.datorie_initiala
    FROM public.abonamente a
    WHERE a.pacient_id = p_pacient_id AND a.id <> p_pkg_id
      AND a.created_at >= (SELECT created_at FROM public.abonamente WHERE id = p_pkg_id)
    ORDER BY a.created_at ASC, a.id
  LOOP
    EXIT WHEN v_spill = 0;
    UPDATE public.abonamente
      SET datorie_initiala = datorie_initiala + v_spill,
          sedinte_folosite = sedinte_folosite + v_spill
      WHERE id = v_rec.id;
    IF v_rec.nr_sedinte - (v_rec.sedinte_folosite - v_rec.datorie_initiala) >= v_spill THEN
      v_spill := 0;
    END IF;
  END LOOP;
END $f$;

-- religa_la_mutare_data (ramura lunară): pachetul nou moștenește datoria
-- pachetului închis (ca renew_package), altfel over-delivery se pierdea.
CREATE OR REPLACE FUNCTION public.religa_la_mutare_data()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_pkg uuid;
  v_plan text;
  v_nu_reinnoi boolean;
  v_debt int;
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
      IF v_plan = 'Abonament lunar' OR EXISTS (
           SELECT 1 FROM public.abonamente a
           WHERE a.pacient_id = NEW.pacient_id AND a.tip = 'lunar'
         ) THEN
        SELECT COALESCE((
          SELECT sum(GREATEST(0, a.sedinte_folosite - a.nr_sedinte))
          FROM public.abonamente a
          WHERE a.pacient_id = NEW.pacient_id AND a.status = 'inchis'
        ), 0) INTO v_debt;
        UPDATE public.abonamente SET status = 'inchis', closed_at = NEW.data
          WHERE pacient_id = NEW.pacient_id AND status = 'activ';
        INSERT INTO public.abonamente (pacient_id, user_id, nr_sedinte, pret, sedinte_folosite, datorie_initiala, tip, status, created_at, closed_at)
        SELECT NEW.pacient_id, p.user_id,
               GREATEST(1, p.sedinte_total), GREATEST(0, p.cost),
               v_debt, v_debt,
               'lunar', 'activ',
               NEW.data, (NEW.data + interval '1 month')::date
        FROM public.pacienti p WHERE p.id = NEW.pacient_id
        RETURNING id INTO v_pkg;
      ELSIF v_plan IS DISTINCT FROM 'One Time' AND v_plan IS DISTINCT FROM 'Ședință unică'
            AND COALESCE(v_nu_reinnoi, false) = false THEN
        RAISE EXCEPTION 'Noua dată (%) nu e acoperită de niciun pachet. Reînnoiește abonamentul sau definalizează ședința înainte de a muta data.', NEW.data;
      END IF;
    END IF;
    NEW.abonament_id := v_pkg;
  END IF;
  RETURN NEW;
END;
$$;
