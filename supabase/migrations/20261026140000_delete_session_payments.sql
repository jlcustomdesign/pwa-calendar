-- Ștergerea unei programări nu atingea plățile: FK plati.programare_id e
-- ON DELETE SET NULL → plata rămânea în DB ca „bani încasați" pentru o ședință
-- care nu mai există. Două triggerere:
-- 1) BEFORE DELETE pe programari: șterge plățile legate DOAR de acea ședință
--    (plățile de pachet — abonament_id NOT NULL — rămân: pachetul nu s-a șters).
-- 2) INSERT/DELETE pe plati: recalculează pacienti.achitat (aceeași logică ca
--    record_payment), ca istoricul și cardul să rămână consecvente.

CREATE OR REPLACE FUNCTION public.sterge_platile_sedintei()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.plati
    WHERE programare_id = OLD.id AND abonament_id IS NULL;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_sterge_plati_sedinta ON public.programari;
CREATE TRIGGER trg_sterge_plati_sedinta
  BEFORE DELETE ON public.programari
  FOR EACH ROW EXECUTE FUNCTION public.sterge_platile_sedintei();

CREATE OR REPLACE FUNCTION public.recalc_achitat_la_plata()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_pkg abonamente%ROWTYPE;
  v_total numeric;
  v_cost numeric;
  v_pid uuid;
BEGIN
  v_pid := COALESCE(NEW.pacient_id, OLD.pacient_id);
  IF v_pid IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT * INTO v_pkg FROM public.abonamente
    WHERE pacient_id = v_pid AND status = 'activ' LIMIT 1;

  IF v_pkg.id IS NOT NULL THEN
    SELECT COALESCE(sum(suma), 0) INTO v_total FROM public.plati
      WHERE abonament_id = v_pkg.id;
    UPDATE public.pacienti SET
      achitat = (v_pkg.pret > 0 AND v_total >= v_pkg.pret)
      WHERE id = v_pid;
  ELSE
    SELECT cost INTO v_cost FROM public.pacienti WHERE id = v_pid;
    SELECT COALESCE(sum(suma), 0) INTO v_total FROM public.plati
      WHERE pacient_id = v_pid;
    UPDATE public.pacienti SET
      achitat = (v_cost > 0 AND v_total >= v_cost)
      WHERE id = v_pid;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_recalc_achitat_plata ON public.plati;
CREATE TRIGGER trg_recalc_achitat_plata
  AFTER INSERT OR DELETE ON public.plati
  FOR EACH ROW EXECUTE FUNCTION public.recalc_achitat_la_plata();
