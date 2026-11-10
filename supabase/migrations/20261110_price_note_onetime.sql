-- update_package_price: acoperă și pacienții fără pachet activ (One Time).
-- Fără pachet se rescrie doar prețul pacientului și se lasă nota
-- „Modificare preț ședință: X → Y RON" în istoric.
CREATE OR REPLACE FUNCTION public.update_package_price(
  p_pacient_id uuid,
  p_cost numeric
) RETURNS void AS $f$
DECLARE
  v_pacient pacienti%ROWTYPE;
  v_pkg abonamente%ROWTYPE;
  v_new numeric;
  v_old numeric;
BEGIN
  SELECT * INTO v_pacient FROM pacienti WHERE id = p_pacient_id FOR UPDATE;
  IF NOT FOUND OR v_pacient.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Pacient invalid sau neautorizat.';
  END IF;
  v_new := GREATEST(0, p_cost);

  SELECT * INTO v_pkg FROM public.abonamente
    WHERE pacient_id = p_pacient_id AND status = 'activ' LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    IF v_pkg.pret IS DISTINCT FROM v_new THEN
      UPDATE public.abonamente SET pret = v_new WHERE id = v_pkg.id;
      INSERT INTO public.istoric_evenimente (pacient_id, user_id, text)
      VALUES (p_pacient_id, auth.uid(),
        'Modificare preț pachet: ' || v_pkg.pret || ' → ' || v_new || ' RON');
    END IF;
  ELSE
    v_old := COALESCE(v_pacient.cost, 0);
    IF v_old IS DISTINCT FROM v_new THEN
      INSERT INTO public.istoric_evenimente (pacient_id, user_id, text)
      VALUES (p_pacient_id, auth.uid(),
        'Modificare preț ședință: ' || v_old || ' → ' || v_new || ' RON');
    END IF;
  END IF;

  UPDATE public.pacienti SET cost = v_new WHERE id = p_pacient_id;
END $f$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.update_package_price(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_package_price(uuid, numeric) TO authenticated;
