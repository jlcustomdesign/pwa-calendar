-- Recalculul achitat exista doar pe triggerul de plati. Dar ștergerea unei
-- programări șterge plata ei ÎNAINTE ca rândul programare să dispară →
-- recalc vedea încă sedinta (rest 260, achitat=false), apoi sedinta dispărea
-- și nimeni nu mai recalcula → pacientul rămânea „neachitat" degeaba.
-- Soluție: funcție unică recalc_achitat_pacient() apelată DIN AMBELE triggerere.

CREATE OR REPLACE FUNCTION public.recalc_achivat_pacient(p_pid uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_pkg abonamente%ROWTYPE;
  v_total numeric;
  v_cost numeric;
  v_sessions int;
BEGIN
  SELECT * INTO v_pkg FROM public.abonamente
    WHERE pacient_id = p_pid AND status = 'activ' LIMIT 1;
  IF v_pkg.id IS NOT NULL THEN
    SELECT COALESCE(sum(suma), 0) INTO v_total FROM public.plati
      WHERE abonament_id = v_pkg.id;
    UPDATE public.pacienti SET
      achitat = (v_pkg.pret > 0 AND v_total >= v_pkg.pret)
      WHERE id = p_pid;
  ELSE
    SELECT cost INTO v_cost FROM public.pacienti WHERE id = p_pid;
    SELECT COALESCE(sum(suma), 0) INTO v_total FROM public.plati
      WHERE pacient_id = p_pid;
    SELECT count(*) INTO v_sessions FROM public.programari
      WHERE pacient_id = p_pid AND status = 'finalizat' AND contorizeaza;
    UPDATE public.pacienti SET
      achitat = (v_cost > 0 AND v_total >= v_sessions * v_cost)
      WHERE id = p_pid;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.recalc_achitat_la_plata()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_pid uuid;
BEGIN
  v_pid := COALESCE(NEW.pacient_id, OLD.pacient_id);
  IF v_pid IS NOT NULL THEN
    PERFORM public.recalc_achivat_pacient(v_pid);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

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
  PERFORM public.recalc_achivat_pacient(v_pid);

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Recalculează flag-urile existente (ordinea triggerelor vechi a lăsat unele stale)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM public.pacienti LOOP
    PERFORM public.recalc_achivat_pacient(r.id);
  END LOOP;
END $$;
