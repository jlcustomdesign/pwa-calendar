-- Fix: plățile înregistrate prin aplicație nu erau legate de ședință
-- (programare_id NULL) → istoricul per-ședință al pacienților One Time arăta
-- permanent „Neplătită" deși plata exista și cardul era achitat.
-- record_payment leagă acum plata de ultima ședință finalizată a pacientului
-- (doar pentru pacienți fără pachet, când apelantul nu indică ședința).

CREATE OR REPLACE FUNCTION public.record_payment(
  p_pacient_id uuid,
  p_suma numeric,
  p_mark_achitat boolean DEFAULT false,
  p_programare_id uuid DEFAULT NULL,
  p_abonament_id uuid DEFAULT NULL
) RETURNS void AS $f$
DECLARE
  v_pacient pacienti%ROWTYPE;
  v_pkg abonamente%ROWTYPE;
  v_total numeric;
  v_prog uuid;
BEGIN
  SELECT * INTO v_pacient FROM pacienti WHERE id = p_pacient_id FOR UPDATE;
  IF NOT FOUND OR v_pacient.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Pacient invalid sau neautorizat.';
  END IF;

  IF p_programare_id IS NOT NULL THEN
    PERFORM 1 FROM programari WHERE id = p_programare_id AND pacient_id = p_pacient_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Programarea nu aparține acestui pacient.';
    END IF;
  END IF;

  IF p_abonament_id IS NOT NULL THEN
    SELECT * INTO v_pkg FROM abonamente WHERE id = p_abonament_id AND pacient_id = p_pacient_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pachetul nu aparține acestui pacient.';
    END IF;
  ELSE
    SELECT * INTO v_pkg FROM abonamente
      WHERE pacient_id = p_pacient_id AND status = 'activ' LIMIT 1;
  END IF;

  -- Fără pachet (One Time) și fără ședință indicată: leagă plata de ultima
  -- ședință finalizată, ca istoricul per-ședință să o reflecte.
  IF p_programare_id IS NULL AND v_pkg.id IS NULL THEN
    SELECT id INTO v_prog FROM programari
      WHERE pacient_id = p_pacient_id AND status = 'finalizat'
      ORDER BY data DESC, ora DESC LIMIT 1;
    IF v_prog IS NOT NULL THEN
      p_programare_id := v_prog;
    END IF;
  END IF;

  IF p_suma > 0 THEN
    INSERT INTO plati (pacient_id, suma, data_platii, user_id, programare_id, abonament_id)
    VALUES (p_pacient_id, p_suma, CURRENT_DATE, auth.uid(), p_programare_id, v_pkg.id);
  END IF;

  IF v_pkg.id IS NOT NULL THEN
    SELECT COALESCE(sum(suma), 0) INTO v_total FROM plati
      WHERE abonament_id = v_pkg.id;
    UPDATE pacienti SET achitat = (p_mark_achitat OR (v_pkg.pret > 0 AND v_total >= v_pkg.pret))
      WHERE id = p_pacient_id;
  ELSE
    -- Ședință unică / legacy fără pachet: total istoric (costul e per ședință).
    SELECT COALESCE(sum(suma), 0) INTO v_total FROM plati WHERE pacient_id = p_pacient_id;
    UPDATE pacienti SET achitat = (p_mark_achitat OR (v_pacient.cost > 0 AND v_total >= v_pacient.cost))
      WHERE id = p_pacient_id;
  END IF;
END $f$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.record_payment(uuid, numeric, boolean, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payment(uuid, numeric, boolean, uuid, uuid) TO authenticated;
