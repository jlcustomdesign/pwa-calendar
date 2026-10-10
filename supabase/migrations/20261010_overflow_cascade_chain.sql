-- Datoria de over-delivery cascadează prin lanț: o ședință uitată adăugată pe un
-- pachet ÎNCHIS care depășește plafonul propagă +1 (datorie + contor) prin fiecare
-- pachet ulterior, până la primul cu capacitate liberă sau până în cel activ.
-- Fără asta, surplusul rămânea „înghițit" în istoric și contorul pachetului
-- curent mințea cu o ședință (vulnerabilitatea „time-travel" din audit).
CREATE OR REPLACE FUNCTION public.propaga_overflow_lant(p_pacient_id uuid, p_pkg_id uuid)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  v_spill int := 1;
  v_rec record;
BEGIN
  -- declanșare doar dacă pachetul sursă e închis și peste plafon
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
    ORDER BY a.created_at ASC, a.id
  LOOP
    EXIT WHEN v_spill = 0;
    UPDATE public.abonamente
      SET datorie_initiala = datorie_initiala + v_spill,
          sedinte_folosite = sedinte_folosite + v_spill
      WHERE id = v_rec.id;
    -- rămâne surplus doar dacă pachetul era exact la plafon (1 peste acum);
    -- altfel ședința e absorbită aici și lanțul se oprește.
    IF v_rec.sedinte_folosite + v_spill - (v_rec.datorie_initiala + v_spill) <= v_rec.nr_sedinte THEN
      v_spill := 0;
    END IF;
  END LOOP;
END $f$;

-- numara_sedinte: după +1 pe pachet, dacă ținta e un pachet închis peste plafon,
-- pornește cascada. (Apel doar din ramura +1 — acolo se livrează ședința.)
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
      PERFORM public.propaga_overflow_lant(NEW.pacient_id, NEW.abonament_id);
      UPDATE public.pacienti SET sedinte_folosite = LEAST(sedinte_folosite + 1, sedinte_total)
        WHERE id = NEW.pacient_id;
    ELSIF v_old_counted AND NOT v_new_counted THEN
      UPDATE public.abonamente SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.abonament_id;
      UPDATE public.pacienti SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.pacient_id;
    ELSIF v_old_counted AND v_new_counted
          AND OLD.abonament_id IS DISTINCT FROM NEW.abonament_id THEN
      UPDATE public.abonamente SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.abonament_id;
      UPDATE public.abonamente SET sedinte_folosite = sedinte_folosite + 1
        WHERE id = NEW.abonament_id;
      PERFORM public.propaga_overflow_lant(NEW.pacient_id, NEW.abonament_id);
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
