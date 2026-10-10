-- Fix test de absorbție în cascadă: +1/+1 pe (folosit, datorie) nu schimbă
-- folosit-datorie, deci testul vechi oprea lanțul prematur pe un pachet plin.
-- Corect: sesiunea e absorbită doar dacă pachetul avea capacitate liberă
-- ÎNAINTE să primească datoria (nr_sedinte - (folosit - datorie) >= spill).
CREATE OR REPLACE FUNCTION public.propaga_overflow_lant(p_pacient_id uuid, p_pkg_id uuid)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  v_spill int := 1;
  v_rec record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.abonamente
    WHERE id = p_pkg_id AND status = 'inchis'
      AND sedinte_folosite - datorie_initiala > nr_sedinte
  ) THEN
    RETURN;
  END IF;

  FOR v_rec IN
    SELECT a.id, a.nr_sedinte, a.sedinte_folosite, a.datorie_initiala
    FROM public.abonamente a
    WHERE a.pacient_id = p_pacient_id AND a.id <> p_pkg_id
    ORDER BY a.created_at ASC, a.id
  LOOP
    EXIT WHEN v_spill = 0;
    UPDATE public.abonamente
      SET datorie_initiala = datorie_initiala + v_spill,
          sedinte_folosite = sedinte_folosite + v_spill
      WHERE id = v_rec.id;
    -- absorbit doar dacă avea capacitate liberă înainte de datorie;
    -- dacă era la plafon, surplusul curge mai departe.
    IF v_rec.nr_sedinte - (v_rec.sedinte_folosite - v_rec.datorie_initiala) >= v_spill THEN
      v_spill := 0;
    END IF;
  END LOOP;
END $f$;
