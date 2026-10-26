-- Fix flux Ședință unică (One Time):
-- 1) numara_sedinte() nu incrementa contorul pacientului pentru ședințele One Time
--    (cerea abonament_id NOT NULL, dar lega_sedinta_de_pachet() lasă abonament_id
--    NULL pentru One Time) → contor blocat la 0, guardrail inactiv, status niciodată
--    'terminat'.
-- 2) renew_package refuza One Time → wrap-up-ul nu putea „reînnoi" folosința unică
--    la reprogramare. Acum resetează contorul fără a atinge tabela abonamente.

-- ── 1) Contorizează ORICE ședință finalizată pe pacienti; abonamentele doar
--       când ședința e legată de un pachet ──────────────────────────────
CREATE OR REPLACE FUNCTION public.numara_sedinte()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_old_counted boolean := false;
  v_new_counted boolean := false;
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
      UPDATE public.pacienti SET sedinte_folosite = LEAST(sedinte_folosite + 1, sedinte_total)
        WHERE id = NEW.pacient_id;
    ELSIF v_old_counted AND NOT v_new_counted THEN
      IF OLD.abonament_id IS NOT NULL THEN
        UPDATE public.abonamente SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
          WHERE id = OLD.abonament_id;
      END IF;
      UPDATE public.pacienti SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.pacient_id;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'finalizat' AND OLD.contorizeaza THEN
      IF OLD.abonament_id IS NOT NULL THEN
        UPDATE public.abonamente SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
          WHERE id = OLD.abonament_id;
      END IF;
      UPDATE public.pacienti SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.pacient_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- ── 2) renew_package: One Time = resetarea folosinței unice ─────────────
-- Fără rânduri în abonamente; plata rămâne per-ședință (plati fără abonament_id).
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

  IF v_pacient.plan IS DISTINCT FROM 'One Time' AND v_pacient.plan IS DISTINCT FROM 'Ședință unică' THEN
    SELECT * INTO v_old FROM public.abonamente
      WHERE pacient_id = p_pacient_id AND status = 'activ' FOR UPDATE;

    IF v_old.id IS NOT NULL AND v_old.sedinte_folosite - v_old.datorie_initiala < v_old.nr_sedinte THEN
      -- Pachet NEEPUIZAT: reînnoirea confirmă plata pe pachetul curent — rândul rămâne.
      UPDATE public.abonamente SET nr_sedinte = GREATEST(1, p_total), pret = GREATEST(0, p_cost)
        WHERE id = v_old.id;
    ELSE
      -- Datoria reală de over-delivery: uzaj efectiv peste plafon.
      SELECT COALESCE((
          SELECT sum(GREATEST(0, (a.sedinte_folosite - a.datorie_initiala) - a.nr_sedinte))
          FROM public.abonamente a WHERE a.pacient_id = p_pacient_id AND a.status = 'inchis'
        ), 0) + GREATEST(0, COALESCE(v_old.sedinte_folosite - v_old.datorie_initiala, 0) - COALESCE(v_old.nr_sedinte, 0))
        INTO v_debt;

      IF v_old.id IS NOT NULL THEN
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
    RETURN;
  END IF;

  -- One Time / Ședință unică: resetează folosința unică, fără pachete.
  PERFORM set_config('app.allow_counter_write', 'on', true);
  UPDATE public.pacienti SET
    sedinte_total = GREATEST(1, p_total),
    sedinte_folosite = 0,
    cost = GREATEST(0, p_cost),
    achitat = (p_status = 'Achitat'),
    status_abonament = 'activ',
    abonament_start = COALESCE(p_data_start, CURRENT_DATE)
  WHERE id = p_pacient_id;

  IF p_paid > 0 THEN
    INSERT INTO public.plati (pacient_id, suma, data_platii, user_id, abonament_id)
    VALUES (p_pacient_id, p_paid, COALESCE(p_data_start, CURRENT_DATE), auth.uid(), NULL);
  END IF;
END $f$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.renew_package(uuid, integer, numeric, numeric, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.renew_package(uuid, integer, numeric, numeric, text, text, date) TO authenticated;
