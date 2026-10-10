-- Cascada inversă: dacă o ședință care declanșase overflow pe un pachet închis
-- se anulează (definalizare / contorizeaza=false / DELETE), datoria propagată
-- prin lanț revine. Simetric cu propaga_overflow_lant: -1 pe fiecare pachet
-- ulterior, oprindu-se la pachetul care absorbise sesiunea. Fără asta, datoria
-- rămânea blocată și oscilările bifează/debifează o acumulau indefinit.
CREATE OR REPLACE FUNCTION public.propaga_underflow_lant(p_pacient_id uuid, p_pkg_id uuid)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  v_rec record;
BEGIN
  -- declanșare doar dacă pachetul (deja decrementat) NU mai e peste plafon;
  -- dacă e încă peste plafon, -1 a revenit pe pachetul sursă, fără cascadă.
  IF EXISTS (
    SELECT 1 FROM public.abonamente
    WHERE id = p_pkg_id AND sedinte_folosite - datorie_initiala > nr_sedinte
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
    -- pachet fără datorie de cascadă: nu l-am atins la +1, nu-l atingem nici la -1
    EXIT WHEN v_rec.datorie_initiala <= 0;
    UPDATE public.abonamente
      SET datorie_initiala = GREATEST(datorie_initiala - 1, 0),
          sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
      WHERE id = v_rec.id;
    -- dacă după -1 pachetul are loc liber, el era absorberul: stop.
    IF v_rec.sedinte_folosite - 1 - (v_rec.datorie_initiala - 1) < v_rec.nr_sedinte THEN
      EXIT;
    END IF;
  END LOOP;
END $f$;

-- numara_sedinte: pornește underflow pe ramurile de -1.
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
      PERFORM public.propaga_underflow_lant(OLD.pacient_id, OLD.abonament_id);
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
      PERFORM public.propaga_underflow_lant(OLD.pacient_id, OLD.abonament_id);
      UPDATE public.pacienti SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.pacient_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
