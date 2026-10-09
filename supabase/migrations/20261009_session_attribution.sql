-- ═══════════════════════════════════════════════════════════════════
-- Atașarea ședințelor la realitate (session attribution)
--
-- 1. programari.contorizeaza (default true): ședință finalizată care NU
--    trebuie să consume din pachet (gratuită, recuperare, plătită separat)
--    poate fi exclusă explicit. Contorul numără DOAR
--    finalizat AND contorizeaza — nu mai e un simplu COUNT pe fereastră.
-- 2. plati.programare_id (nullable): o plată poate fi legată de o ședință
--    concretă (ședințe unice) sau de pachet (NULL, ca până acum).
-- 3. Trigger de contor rescris: tranzitia efectivă contorizată este
--    (finalizat AND contorizeaza); schimbarea lui contorizeaza la o ședință
--    deja finalizată ajustează contorul ±1.
-- 4. renew_subscription: toate COUNT-urile filtrează contorizeaza.
-- 5. record_payment: parametru nou optional p_programare_id.
-- ═══════════════════════════════════════════════════════════════════

-- a) Flag de contorizare pe ședință
ALTER TABLE programari ADD COLUMN IF NOT EXISTS contorizeaza boolean NOT NULL DEFAULT true;

-- b) Plată legată opțional de o ședință concretă
ALTER TABLE plati ADD COLUMN IF NOT EXISTS programare_id uuid REFERENCES programari(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_plati_programare_id ON plati(programare_id);

-- c) Trigger contor: starea contorizată = finalizat AND contorizeaza
--    Triggerul trebuie refăcut explicit: definiția veche era
--    `UPDATE OF status`, deci o flip de contorizeaza NU-l declanșa.
DROP TRIGGER IF EXISTS trg_incrementeaza_sedinte ON public.programari;
CREATE TRIGGER trg_incrementeaza_sedinte
  AFTER INSERT OR UPDATE OF status, contorizeaza OR DELETE ON public.programari
  FOR EACH ROW EXECUTE FUNCTION public.incrementeaza_sedinte_folosite();

CREATE OR REPLACE FUNCTION public.incrementeaza_sedinte_folosite()
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
      UPDATE public.pacienti
      SET sedinte_folosite = LEAST(sedinte_folosite + 1, sedinte_total)
      WHERE id = NEW.pacient_id;
    ELSIF v_old_counted AND NOT v_new_counted THEN
      UPDATE public.pacienti
      SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
      WHERE id = NEW.pacient_id;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'finalizat' AND OLD.contorizeaza THEN
      UPDATE public.pacienti
      SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
      WHERE id = OLD.pacient_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- d) Reînnoire: contează doar ședințele contorizate
CREATE OR REPLACE FUNCTION renew_subscription(
  p_pacient_id uuid,
  p_total int,
  p_cost numeric,
  p_paid numeric DEFAULT 0,
  p_status text DEFAULT 'Neachitat'
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
    WHERE pacient_id = p_pacient_id AND status = 'finalizat' AND contorizeaza;

  v_old_total := GREATEST(1, v_pacient.sedinte_total);

  IF v_pacient.sedinte_folosite >= v_old_total THEN
    IF v_pacient.abonament_start IS NOT NULL THEN
      SELECT count(*) INTO v_n FROM programari
        WHERE pacient_id = p_pacient_id AND status = 'finalizat' AND contorizeaza AND data >= v_pacient.abonament_start;
    ELSE
      v_n := v_n_all;
    END IF;
    v_new_used := GREATEST(0, v_n - v_old_total);
    IF v_new_used > 0 THEN
      SELECT data INTO v_new_start FROM (
        SELECT data, row_number() OVER (ORDER BY data, ora) AS rn
        FROM programari WHERE pacient_id = p_pacient_id AND status = 'finalizat' AND contorizeaza
      ) t WHERE rn = (v_n_all - v_new_used + 1);
    ELSE
      v_new_start := CURRENT_DATE;
    END IF;
  ELSE
    IF v_pacient.abonament_start IS NOT NULL THEN
      SELECT count(*) INTO v_n FROM programari
        WHERE pacient_id = p_pacient_id AND status = 'finalizat' AND contorizeaza AND data >= v_pacient.abonament_start;
      v_new_used := GREATEST(v_pacient.sedinte_folosite, v_n);
      v_new_start := v_pacient.abonament_start;
    ELSE
      v_new_used := v_pacient.sedinte_folosite;
      v_new_start := v_pacient.abonament_start;
    END IF;
  END IF;

  PERFORM set_config('app.allow_counter_write', 'on', true);
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

-- e) record_payment cu plată opțional legată de o ședință
DROP FUNCTION IF EXISTS public.record_payment(uuid, numeric, boolean);
CREATE OR REPLACE FUNCTION public.record_payment(
  p_pacient_id uuid,
  p_suma numeric,
  p_mark_achitat boolean DEFAULT false,
  p_programare_id uuid DEFAULT NULL
) RETURNS void AS $f$
DECLARE
  v_pacient pacienti%ROWTYPE;
  v_total numeric;
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

  IF p_suma > 0 THEN
    INSERT INTO plati (pacient_id, suma, data_platii, user_id, programare_id)
    VALUES (p_pacient_id, p_suma, CURRENT_DATE, auth.uid(), p_programare_id);
  END IF;

  IF v_pacient.abonament_start IS NOT NULL THEN
    SELECT COALESCE(sum(suma), 0) INTO v_total FROM plati
      WHERE pacient_id = p_pacient_id
        AND data_platii >= LEAST(v_pacient.abonament_start, CURRENT_DATE);
  ELSE
    SELECT COALESCE(sum(suma), 0) INTO v_total FROM plati
      WHERE pacient_id = p_pacient_id;
  END IF;

  UPDATE pacienti SET
    achitat = (p_mark_achitat OR (v_pacient.cost > 0 AND v_total >= v_pacient.cost))
  WHERE id = p_pacient_id;
END $f$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.record_payment(uuid, numeric, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payment(uuid, numeric, boolean, uuid) TO authenticated;
