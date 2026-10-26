-- Aliniaza flag-ul achitat cu realitatea: pentru pacienti fara pachet (One Time)
-- achitat = platile acopera TOATE sedintele finalizate contorizate (sedinte x cost),
-- nu doar pretul unei sedinte. Inainte: o singura plata de 130 marca "achitat"
-- chiar daca pacientul avea 3 sedinte facute.
CREATE OR REPLACE FUNCTION public.recalc_achitat_la_plata()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_pkg abonamente%ROWTYPE;
  v_total numeric;
  v_cost numeric;
  v_pid uuid;
  v_sessions int;
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
    SELECT count(*) INTO v_sessions FROM public.programari
      WHERE pacient_id = v_pid AND status = 'finalizat' AND contorizeaza;
    UPDATE public.pacienti SET
      achitat = (v_cost > 0 AND v_total >= v_sessions * v_cost)
      WHERE id = v_pid;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
