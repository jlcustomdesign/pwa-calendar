-- ═══════════════════════════════════════════════════════════════════
-- Gărzi pentru contorul de ședințe (counter guardrails)
--
-- 1. Protecție contor: sedinte_folosite poate fi modificat DOAR de sistem
--    (triggerul de pe programari) sau de reînnoirea atomica (GUC
--    app.allow_counter_write = 'on'), nu de scrieri manuale/stale.
-- 2. abonament_start: data de început a pachetului curent; reînnoirea
--    poartă ședințele finalizate neacoperite de pachetul anterior.
--    Rândurile existente rămân NULL (legacy — fără portare sesiuni).
-- 3. renew_subscription: reînnoire ATOMICĂ (pachet nou + plată inițială
--    într-o singură tranzacție) care PĂSTREAZĂ istoricul din plati
--    (nu mai șterge nimic din tabela de plăți).
-- ═══════════════════════════════════════════════════════════════════

-- a) Data de start a pachetului curent (rândurile existente rămân NULL = legacy)
ALTER TABLE pacienti ADD COLUMN IF NOT EXISTS abonament_start date;
ALTER TABLE pacienti ALTER COLUMN abonament_start SET DEFAULT CURRENT_DATE;

-- b) Protecția contorului de ședințe
CREATE OR REPLACE FUNCTION protejeaza_contor_sedinte() RETURNS trigger AS $f$
BEGIN
  IF NEW.sedinte_folosite IS DISTINCT FROM OLD.sedinte_folosite THEN
    IF current_setting('app.allow_counter_write', true) IS DISTINCT FROM 'on' AND pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'Contorul de ședințe (sedinte_folosite) poate fi modificat doar de sistem: finalizarea/anularea ședințelor sau reînnoirea abonamentului.';
    END IF;
  END IF;
  RETURN NEW;
END $f$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protejeaza_contor ON pacienti;
CREATE TRIGGER trg_protejeaza_contor BEFORE UPDATE ON pacienti FOR EACH ROW EXECUTE FUNCTION protejeaza_contor_sedinte();

-- c) Reînnoire atomică — NU șterge din plati, păstrează istoricul plăților
--    Contorul NU se resetează niciodată la reînnoire:
--    • pachet NEEPUIZAT (sedinte_folosite < sedinte_total): reînnoirea confirmă
--      plata pe pachetul curent — contorul și data de start rămân; la pachete
--      urmărite contorul e adus la realitate cu ședințele livrate necontorizate;
--    • pachet EPUIZAT: pachet nou care poartă în cont ședințele livrate peste
--      plafonul anterior (exces = datorie, nu se pierde); noul pachet începe la
--      PRIMA ședință reală neacoperită, nu la data plății.
CREATE OR REPLACE FUNCTION renew_subscription(
  p_pacient_id uuid,
  p_total int,
  p_cost numeric,
  p_paid numeric DEFAULT 0,
  p_status text DEFAULT 'Neachitat'  -- 'Neachitat' | 'Parțial' | 'Achitat'
) RETURNS void AS $f$
DECLARE
  v_pacient pacienti%ROWTYPE;
  v_n_all int;
  v_n int;
  v_old_total int;
  v_new_used int;
  v_new_start date;
BEGIN
  SELECT * INTO v_pacient FROM pacienti WHERE id = p_pacient_id FOR UPDATE;
  IF NOT FOUND OR v_pacient.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Pacient invalid sau neautorizat.';
  END IF;

  SELECT count(*) INTO v_n_all FROM programari
    WHERE pacient_id = p_pacient_id AND status = 'finalizat';

  v_old_total := GREATEST(1, v_pacient.sedinte_total);

  IF v_pacient.sedinte_folosite >= v_old_total THEN
    -- Pachet EPUIZAT: pachet nou; în el se poartă doar ședințele livrate
    -- peste plafonul pachetului anterior (exces = datorie, nu se pierde)
    IF v_pacient.abonament_start IS NOT NULL THEN
      SELECT count(*) INTO v_n FROM programari
        WHERE pacient_id = p_pacient_id AND status = 'finalizat' AND data >= v_pacient.abonament_start;
    ELSE
      v_n := v_n_all;
    END IF;
    v_new_used := GREATEST(0, v_n - v_old_total);
    IF v_new_used > 0 THEN
      SELECT data INTO v_new_start FROM (
        SELECT data, row_number() OVER (ORDER BY data, ora) AS rn
        FROM programari WHERE pacient_id = p_pacient_id AND status = 'finalizat'
      ) t WHERE rn = (v_n_all - v_new_used + 1);
    ELSE
      v_new_start := CURRENT_DATE;
    END IF;
  ELSE
    -- Pachet NEEPUIZAT: reînnoirea confirmă plata pe pachetul curent —
    -- contorul NU se resetează. La pachete urmărite aducem contorul la
    -- realitate cu ședințele livrate necontorizate (drift de import).
    IF v_pacient.abonament_start IS NOT NULL THEN
      SELECT count(*) INTO v_n FROM programari
        WHERE pacient_id = p_pacient_id AND status = 'finalizat' AND data >= v_pacient.abonament_start;
      v_new_used := GREATEST(v_pacient.sedinte_folosite, v_n);
      v_new_start := v_pacient.abonament_start;
    ELSE
      v_new_used := v_pacient.sedinte_folosite; -- legacy: istoricul vechi nu e decodabil
      v_new_start := v_pacient.abonament_start; -- rămâne NULL (legacy)
    END IF;
  END IF;

  PERFORM set_config('app.allow_counter_write', 'on', true); -- local to transaction
  UPDATE pacienti SET
    sedinte_total = GREATEST(1, p_total),
    sedinte_folosite = LEAST(v_new_used, GREATEST(1, p_total)),
    cost = GREATEST(0, p_cost),
    achitat = (p_status = 'Achitat'),
    status_abonament = 'activ',
    abonament_start = v_new_start
  WHERE id = p_pacient_id;
  IF p_paid > 0 THEN
    INSERT INTO plati (pacient_id, suma, data_platii, user_id)
    VALUES (p_pacient_id, p_paid, CURRENT_DATE, auth.uid());
  END IF;
END $f$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.renew_subscription(uuid, int, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.renew_subscription(uuid, int, numeric, numeric, text) TO authenticated;
