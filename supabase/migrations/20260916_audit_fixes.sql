-- ═══════════════════════════════════════════════════════════════════
-- Audit fixes (2026-09-16)
--
-- 1. pacienti_view: the old definition joined plati and programari in a
--    single query, so the one-to-many joins multiplied into a cartesian
--    product — every payment was counted once per appointment (a patient
--    with 750 lei paid and 10 appointments appeared as 7500).
--    Fixed by pre-aggregating each side in its own subquery.
--    Also switched to security_invoker = true so the view respects the
--    caller's RLS policies instead of the owner's.
-- 2. record_payment: atomic insert of a plati row + recalculation of
--    `achitat` for the CURRENT package only (payments since abonament_start;
--    legacy rows with abonament_start NULL count all-time). Replaces the
--    client's 4-round-trip, race-prone addPayment flow and fixes the stale
--    assumption that renewals wipe plati.
-- ═══════════════════════════════════════════════════════════════════

-- 1) View fără înmulțirea carteziană
CREATE OR REPLACE VIEW pacienti_view
WITH (security_invoker = true) AS
SELECT p.id,
  p.nume,
  p.prenume,
  p.telefon,
  p.locatie,
  p.plan,
  p.frecventa,
  p.cost,
  p.sedinte_total,
  p.sedinte_folosite,
  p.sedinte_ramase,
  p.achitat,
  p.status_abonament,
  p.notite,
  p.drive_link,
  p.created_at,
  p.updated_at,
  p.user_id,
  TRIM(BOTH FROM (COALESCE(p.prenume, ''::text) || ' '::text) || COALESCE(p.nume, ''::text)) AS name,
  COALESCE(pl.total, 0::numeric) AS suma_incasata,
  COALESCE(pr.cnt, 0::bigint) AS numar_programari
FROM pacienti p
  LEFT JOIN (SELECT pacient_id, sum(suma) AS total FROM plati GROUP BY pacient_id) pl
    ON pl.pacient_id = p.id
  LEFT JOIN (SELECT pacient_id, count(*) AS cnt FROM programari GROUP BY pacient_id) pr
    ON pr.pacient_id = p.id;

-- 2) Plată atomică + recalculare achitat pe pachetul curent
CREATE OR REPLACE FUNCTION public.record_payment(
  p_pacient_id uuid,
  p_suma numeric,
  p_mark_achitat boolean DEFAULT false
) RETURNS void AS $f$
DECLARE
  v_pacient pacienti%ROWTYPE;
  v_total numeric;
BEGIN
  SELECT * INTO v_pacient FROM pacienti WHERE id = p_pacient_id FOR UPDATE;
  IF NOT FOUND OR v_pacient.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Pacient invalid sau neautorizat.';
  END IF;

  IF p_suma > 0 THEN
    INSERT INTO plati (pacient_id, suma, data_platii, user_id)
    VALUES (p_pacient_id, p_suma, CURRENT_DATE, auth.uid());
  END IF;

  -- total achitat pentru pachetul CURENT: de la abonament_start
  -- (legacy: fără dată de start => tot istoricul)
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

REVOKE EXECUTE ON FUNCTION public.record_payment(uuid, numeric, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payment(uuid, numeric, boolean) TO authenticated;
