-- numara_sedinte trata doar tranziția contorizat↔necontorizat. Mutarea linkului
-- de pe pachet A pe pachet B (ambele contorizate, ex. la schimbarea datei)
-- trecea neobservată: -1 pe A, +1 pe B.
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
      -- Link mutat de pe un pachet pe altul (ex. ședință finalizată mutată pe altă dată):
      -- -1 pe pachetul sursă, +1 pe cel destinație. Pacientul nu se schimbă (±0).
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
