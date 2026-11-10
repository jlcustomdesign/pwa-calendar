-- ═══════════════════════════════════════════════════════════════════
-- Modificarea numărului de ședințe al pachetului activ din fișa de
-- editare: update-ul normal lovea doar pacienti.sedinte_total, iar
-- pachetul rămânea cu nr_sedinte vechi — două surse de adevăr care
-- divergeau (listă 8/8, PaymentSheet 0/10). Același pattern ca
-- update_package_price: rescrie pachetul deschis + oglinda legacy,
-- atomar, cu FOR UPDATE.
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.update_package_sessions(
  p_pacient_id uuid,
  p_total int
) RETURNS void AS $f$
DECLARE
  v_pacient pacienti%ROWTYPE;
  v_pkg abonamente%ROWTYPE;
  v_new int;
BEGIN
  SELECT * INTO v_pacient FROM pacienti WHERE id = p_pacient_id FOR UPDATE;
  IF NOT FOUND OR v_pacient.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Pacient invalid sau neautorizat.';
  END IF;
  v_new := GREATEST(1, p_total);

  SELECT * INTO v_pkg FROM public.abonamente
    WHERE pacient_id = p_pacient_id AND status = 'activ' LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pacientul nu are pachet activ de modificat.';
  END IF;

  UPDATE public.abonamente SET nr_sedinte = v_new WHERE id = v_pkg.id;

  -- Oglinda legacy rămâne aliniată (triggerul blochează scrierea directă).
  PERFORM set_config('app.allow_counter_write', 'on', true);
  UPDATE public.pacienti SET sedinte_total = v_new WHERE id = p_pacient_id;
END $f$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.update_package_sessions(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_package_sessions(uuid, int) TO authenticated;
