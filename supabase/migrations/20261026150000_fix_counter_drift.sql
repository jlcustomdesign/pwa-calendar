-- Fix drift: pacienti.sedinte_folosite era calculat aritmetic (LEAST(+1)/GREATEST(-1)),
-- asimetric la plafon: 2 ședințe finalizate pe pachet de 1 → contor 1; ștergerea uneia
-- → 0, deși mai exista una finalizată. Acum se RECALCULEAZĂ din adevăr la fiecare
-- eveniment: LEAST(ședințe finalizate contorizate, sedinte_total) fără pachet, sau
-- LEAST(folosite pachet activ, sedinte_total) cu pachet. Abonamentele rămân pe
-- aritmetică exactă (+1/-1, fără plafon — over-delivery real).

CREATE OR REPLACE FUNCTION public.numara_sedinte()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_old_counted boolean := false;
  v_new_counted boolean := false;
  v_pid uuid;
  v_pkg_folosite int;
  v_cnt int;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_counted := (NEW.status = 'finalizat' AND NEW.contorizeaza);
    IF TG_OP = 'UPDATE' THEN
      v_old_counted := (OLD.status = 'finalizat' AND OLD.contorizeaza);
    END IF;

    IF v_new_counted AND NOT v_old_counted THEN
      IF NEW.abonament_id IS NOT NULL THEN
        UPDATE public.abonamente SET sedinte_folosite = sedinte_folosite + 1
          WHERE id = NEW.abonament_id;
      END IF;
    ELSIF v_old_counted AND NOT v_new_counted THEN
      IF OLD.abonament_id IS NOT NULL THEN
        UPDATE public.abonamente SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
          WHERE id = OLD.abonament_id;
      END IF;
    END IF;
    v_pid := NEW.pacient_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'finalizat' AND OLD.contorizeaza AND OLD.abonament_id IS NOT NULL THEN
      UPDATE public.abonamente SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.abonament_id;
    END IF;
    v_pid := OLD.pacient_id;
  END IF;

  -- Recalcul exact al contorului pacientului (simetric, fără drift la plafon).
  SELECT a.sedinte_folosite INTO v_pkg_folosite
    FROM public.abonamente a
    WHERE a.pacient_id = v_pid AND a.status = 'activ'
    LIMIT 1;
  IF v_pkg_folosite IS NOT NULL THEN
    UPDATE public.pacienti SET sedinte_folosite = LEAST(v_pkg_folosite, sedinte_total)
      WHERE id = v_pid;
  ELSE
    SELECT count(*) INTO v_cnt FROM public.programari
      WHERE pacient_id = v_pid AND status = 'finalizat' AND contorizeaza;
    UPDATE public.pacienti SET sedinte_folosite = LEAST(v_cnt, sedinte_total)
      WHERE id = v_pid;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
