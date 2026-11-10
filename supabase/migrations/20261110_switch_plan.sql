-- ═══════════════════════════════════════════════════════════════════
-- Schimbare de plan din fișa de editare (Abonament ↔ Ședință unică)
--
-- Contorul de ședințe e protejat de trigger (trg_protejeaza_contor) și
-- renew_package refuză pacienții One Time — deci switch-ul de plan nu
-- putea fi făcut niciodată din client fără să lovească una dintre cele
-- două gărzi. Acest RPC face tranziția pe calea sistemului: închide/
-- deschide pachetul și resetează contorul cu GUC-ul oficial.
-- Istoricul nu se pierde: programari + abonamente închise rămân.
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.switch_plan(
  p_pacient_id uuid,
  p_plan text,
  p_total int,
  p_cost numeric
) RETURNS void AS $f$
DECLARE
  v_pacient pacienti%ROWTYPE;
BEGIN
  SELECT * INTO v_pacient FROM pacienti WHERE id = p_pacient_id FOR UPDATE;
  IF NOT FOUND OR v_pacient.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Pacient invalid sau neautorizat.';
  END IF;
  IF p_plan IS DISTINCT FROM 'One Time' AND p_plan IS DISTINCT FROM 'Subscription' THEN
    RAISE EXCEPTION 'Plan necunoscut: %', p_plan;
  END IF;

  IF p_plan IS NOT DISTINCT FROM 'One Time' THEN
    -- Ședință unică: pachetul deschis se închide; sesiunea unică pornește
    -- cu contor curat (istoricul rămâne în programari + abonamente).
    UPDATE public.abonamente SET status = 'inchis', closed_at = now()
      WHERE pacient_id = p_pacient_id AND status = 'activ';
  ELSIF NOT EXISTS (SELECT 1 FROM public.abonamente WHERE pacient_id = p_pacient_id AND status = 'activ') THEN
    -- Abonament fără pachet activ (ex. venit din One Time): pachet nou.
    INSERT INTO public.abonamente (pacient_id, user_id, nr_sedinte, pret, status)
    VALUES (p_pacient_id, auth.uid(), GREATEST(1, p_total), GREATEST(0, p_cost), 'activ');
  ELSE
    -- Abonament cu pachet activ: reiterează plafonul/prețul pachetului curent.
    UPDATE public.abonamente SET nr_sedinte = GREATEST(1, p_total), pret = GREATEST(0, p_cost)
      WHERE pacient_id = p_pacient_id AND status = 'activ';
  END IF;

  PERFORM set_config('app.allow_counter_write', 'on', true);
  UPDATE public.pacienti SET
    plan = p_plan,
    sedinte_total = GREATEST(1, p_total),
    sedinte_folosite = 0,
    cost = GREATEST(0, p_cost),
    status_abonament = 'activ',
    abonament_start = CURRENT_DATE
  WHERE id = p_pacient_id;
END $f$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.switch_plan(uuid, text, int, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switch_plan(uuid, text, int, numeric) TO authenticated;
