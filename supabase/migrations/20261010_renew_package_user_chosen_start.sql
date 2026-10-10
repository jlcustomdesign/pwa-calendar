-- Reînnoire cu dată aleasă de terapeut: dacă înregistrează reînnoirea mai târziu,
-- pachetul poate începe din ziua reală (ex. plata a fost ieri, nu azi).
-- p_data_start NULL = comportamentul vechi (azi).
-- Datele pachetelor (created_at, closed_at, nr_sedinte, pret) erau deja editabile
-- direct de user: guardul protejează doar contorul sedinte_folosite.
CREATE OR REPLACE FUNCTION public.renew_package(
  p_pacient_id uuid, p_total int, p_cost numeric, p_paid numeric DEFAULT 0, p_status text DEFAULT 'Neachitat', p_tip text DEFAULT NULL, p_data_start date DEFAULT NULL
) RETURNS void AS $f$
DECLARE
  v_pacient pacienti%ROWTYPE;
  v_old abonamente%ROWTYPE;
  v_debt int;
  v_start date;
  v_end date;
  v_tip text;
BEGIN
  SELECT * INTO v_pacient FROM pacienti WHERE id = p_pacient_id FOR UPDATE;
  IF NOT FOUND OR v_pacient.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Pacient invalid sau neautorizat.';
  END IF;
  IF v_pacient.plan IS NOT DISTINCT FROM 'One Time' THEN
    RAISE EXCEPTION 'Pacientul cu ședință unică nu are abonament de reînnoit.';
  END IF;

  SELECT * INTO v_old FROM abonamente
    WHERE pacient_id = p_pacient_id AND status = 'activ' FOR UPDATE;

  v_tip := CASE
    WHEN p_tip IN ('sedinte','lunar') THEN p_tip
    ELSE COALESCE(v_old.tip, 'sedinte')
  END;

  IF FOUND AND v_old.sedinte_folosite - v_old.datorie_initiala < v_old.nr_sedinte THEN
    UPDATE abonamente SET nr_sedinte = GREATEST(1, p_total), pret = GREATEST(0, p_cost),
      tip = v_tip,
      created_at = COALESCE(p_data_start, created_at),
      closed_at = CASE
        WHEN v_tip = 'lunar'
        THEN (COALESCE(p_data_start, CURRENT_DATE) + interval '1 month')::date
        ELSE closed_at END
      WHERE id = v_old.id;
  ELSE
    SELECT COALESCE((
        SELECT sum(GREATEST(0, a.sedinte_folosite - a.nr_sedinte))
        FROM abonamente a WHERE a.pacient_id = p_pacient_id AND a.status = 'inchis'
      ), 0) + GREATEST(0, COALESCE(v_old.sedinte_folosite, 0) - COALESCE(v_old.nr_sedinte, 0))
      INTO v_debt;
    IF FOUND THEN
      UPDATE abonamente SET status = 'inchis', closed_at = COALESCE(p_data_start, now()) WHERE id = v_old.id;
    END IF;
    v_start := COALESCE(p_data_start, CURRENT_DATE);
    IF v_tip = 'lunar' THEN
      v_end := (v_start + interval '1 month')::date;
    ELSE
      v_end := NULL;
    END IF;
    INSERT INTO public.abonamente (pacient_id, user_id, nr_sedinte, pret, sedinte_folosite, datorie_initiala, status, tip, created_at, closed_at)
    VALUES (p_pacient_id, auth.uid(), GREATEST(1, p_total), GREATEST(0, p_cost), v_debt, v_debt, 'activ', v_tip, v_start, v_end);
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
    abonament_start = COALESCE(p_data_start, CURRENT_DATE)
  WHERE id = p_pacient_id;

  IF p_paid > 0 THEN
    INSERT INTO plati (pacient_id, suma, data_platii, user_id, abonament_id)
    SELECT p_pacient_id, p_paid, COALESCE(p_data_start, CURRENT_DATE), auth.uid(), id
      FROM abonamente WHERE pacient_id = p_pacient_id AND status = 'activ';
  END IF;
END $f$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.renew_package(uuid, int, numeric, numeric, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.renew_package(uuid, int, numeric, numeric, text, text, date) TO authenticated;
