-- ═══════════════════════════════════════════════════════════════════
-- Modificarea prețului pachetului activ din fișa de editare:
-- update-ul normal lovea doar coloana legacy pacienti.cost, iar afișarea
-- citea pretul pachetului — prețul „nou” nu prindea nicăieri. Acest RPC
-- rescrie prețul pachetului deschis și lasă notă în istoric:
-- „Modificare preț pachet: X → Y RON".
-- switch_plan primește și el nota când reiterează prețul pachetului existent.
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.update_package_price(
  p_pacient_id uuid,
  p_cost numeric
) RETURNS void AS $f$
DECLARE
  v_pacient pacienti%ROWTYPE;
  v_pkg abonamente%ROWTYPE;
  v_new numeric;
BEGIN
  SELECT * INTO v_pacient FROM pacienti WHERE id = p_pacient_id FOR UPDATE;
  IF NOT FOUND OR v_pacient.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Pacient invalid sau neautorizat.';
  END IF;
  v_new := GREATEST(0, p_cost);

  SELECT * INTO v_pkg FROM public.abonamente
    WHERE pacient_id = p_pacient_id AND status = 'activ' LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pacientul nu are pachet activ de modificat.';
  END IF;

  IF v_pkg.pret IS DISTINCT FROM v_new THEN
    UPDATE public.abonamente SET pret = v_new WHERE id = v_pkg.id;
    INSERT INTO public.istoric_evenimente (pacient_id, user_id, text)
    VALUES (p_pacient_id, auth.uid(),
      'Modificare preț pachet: ' || v_pkg.pret || ' → ' || v_new || ' RON');
  END IF;

  -- Oglinda legacy rămâne aliniată (afișările care citesc pacienti.cost).
  UPDATE public.pacienti SET cost = v_new WHERE id = p_pacient_id;
END $f$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.update_package_price(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_package_price(uuid, numeric) TO authenticated;

-- switch_plan: notă și când reiterează prețul pachetului existent.
CREATE OR REPLACE FUNCTION public.switch_plan(
  p_pacient_id uuid,
  p_plan text,
  p_total int,
  p_cost numeric
) RETURNS void AS $f$
DECLARE
  v_pacient pacienti%ROWTYPE;
  v_old text;
  v_label_old text;
  v_label_new text;
  v_pkg abonamente%ROWTYPE;
  v_new numeric;
BEGIN
  SELECT * INTO v_pacient FROM pacienti WHERE id = p_pacient_id FOR UPDATE;
  IF NOT FOUND OR v_pacient.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Pacient invalid sau neautorizat.';
  END IF;
  IF p_plan IS DISTINCT FROM 'One Time' AND p_plan IS DISTINCT FROM 'Subscription' THEN
    RAISE EXCEPTION 'Plan necunoscut: %', p_plan;
  END IF;

  v_old := v_pacient.plan;
  v_label_old := CASE v_old
    WHEN 'One Time' THEN 'Ședință unică'
    WHEN 'Subscription' THEN 'Abonament'
    ELSE COALESCE(v_old, '—') END;
  v_label_new := CASE p_plan
    WHEN 'One Time' THEN 'Ședință unică'
    WHEN 'Subscription' THEN 'Abonament'
    ELSE p_plan END;
  v_new := GREATEST(0, p_cost);

  IF p_plan IS NOT DISTINCT FROM 'One Time' THEN
    UPDATE public.abonamente SET status = 'inchis', closed_at = now()
      WHERE pacient_id = p_pacient_id AND status = 'activ';
  ELSIF NOT EXISTS (SELECT 1 FROM public.abonamente WHERE pacient_id = p_pacient_id AND status = 'activ') THEN
    INSERT INTO public.abonamente (pacient_id, user_id, nr_sedinte, pret, status)
    VALUES (p_pacient_id, auth.uid(), GREATEST(1, p_total), v_new, 'activ');
  ELSE
    SELECT * INTO v_pkg FROM public.abonamente
      WHERE pacient_id = p_pacient_id AND status = 'activ' LIMIT 1;
    UPDATE public.abonamente SET nr_sedinte = GREATEST(1, p_total), pret = v_new
      WHERE id = v_pkg.id;
    IF v_pkg.pret IS DISTINCT FROM v_new THEN
      INSERT INTO public.istoric_evenimente (pacient_id, user_id, text)
      VALUES (p_pacient_id, auth.uid(),
        'Modificare preț pachet: ' || v_pkg.pret || ' → ' || v_new || ' RON');
    END IF;
  END IF;

  PERFORM set_config('app.allow_counter_write', 'on', true);
  UPDATE public.pacienti SET
    plan = p_plan,
    sedinte_total = GREATEST(1, p_total),
    sedinte_folosite = 0,
    cost = v_new,
    status_abonament = 'activ',
    abonament_start = CURRENT_DATE
  WHERE id = p_pacient_id;

  INSERT INTO public.istoric_evenimente (pacient_id, user_id, text)
  VALUES (p_pacient_id, auth.uid(),
    'Schimbare tip abonament: ' || v_label_old || ' → ' || v_label_new);
END $f$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.switch_plan(uuid, text, int, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switch_plan(uuid, text, int, numeric) TO authenticated;
