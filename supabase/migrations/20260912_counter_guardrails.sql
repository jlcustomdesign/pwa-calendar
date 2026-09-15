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
--    Reînnoirea NU pornește pachetul de la data plății: noul pachet începe la
--    PRIMA ședință reală neacoperită, iar ședințele finalizate peste plafon se
--    poartă în noul pachet (contorul nu se resetează la 0).
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
  v_uncovered int := 0;
  v_new_start date;
BEGIN
  SELECT * INTO v_pacient FROM pacienti WHERE id = p_pacient_id FOR UPDATE;
  IF NOT FOUND OR v_pacient.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Pacient invalid sau neautorizat.';
  END IF;

  SELECT count(*) INTO v_n_all FROM programari
    WHERE pacient_id = p_pacient_id AND status = 'finalizat';

  IF v_pacient.abonament_start IS NOT NULL THEN
    -- pachet urmărit deja: ședințele acestui pachet = finalizate de la abonament_start
    SELECT count(*) INTO v_n FROM programari
      WHERE pacient_id = p_pacient_id AND status = 'finalizat' AND data >= v_pacient.abonament_start;
    v_uncovered := GREATEST(0, v_n - GREATEST(1, v_pacient.sedinte_total));
  ELSE
    -- legacy (fără dată de start): contorul e singura sursă — sesiunile livrate
    -- peste contor sunt neacoperite și se poartă în noul pachet
    v_uncovered := GREATEST(0, v_n_all - v_pacient.sedinte_folosite);
  END IF;

  -- noul pachet începe la PRIMA ședință reală neacoperită, nu la data plății
  IF v_uncovered > 0 THEN
    SELECT data INTO v_new_start FROM (
      SELECT data, row_number() OVER (ORDER BY data, ora) AS rn
      FROM programari WHERE pacient_id = p_pacient_id AND status = 'finalizat'
    ) t WHERE rn = (v_n_all - v_uncovered + 1);
  ELSE
    v_new_start := CURRENT_DATE;
  END IF;

  PERFORM set_config('app.allow_counter_write', 'on', true); -- local to transaction
  UPDATE pacienti SET
    sedinte_total = GREATEST(1, p_total),
    sedinte_folosite = LEAST(v_uncovered, GREATEST(1, p_total)),
    cost = GREATEST(0, p_cost),
    achitat = (p_status = 'Achitat'),
    status_abonament = 'activ',
    abonament_start = COALESCE(v_new_start, CURRENT_DATE)
  WHERE id = p_pacient_id;
  IF p_paid > 0 THEN
    INSERT INTO plati (pacient_id, suma, data_platii, user_id)
    VALUES (p_pacient_id, p_paid, CURRENT_DATE, auth.uid());
  END IF;
END $f$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.renew_subscription(uuid, int, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.renew_subscription(uuid, int, numeric, numeric, text) TO authenticated;
