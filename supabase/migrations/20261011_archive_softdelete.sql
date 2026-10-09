-- ═══════════════════════════════════════════════════════════════════
-- Slice 3: arhivare (soft delete), plan CHECK, unica sursă de adevăr
--
-- 1. pacienti.sters_la: ștergerea din UI arhivează; ștergerea reală (DELETE)
--    e blocată de trigger dacă pacientul are plăți sau ședințe.
-- 2. plan: CHECK constraint cu valorile permise.
-- 3. pacienti_view include acum nu_reinnoi + sters_la.
-- (Citirile aplicației trec prin applyPackageTruth — pachetul deschis
--  suprascrie câmpurile legacy; coloanele vechi rămân doar oglindă internă.)
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE pacienti DROP CONSTRAINT IF EXISTS pacienti_plan_check;
ALTER TABLE pacienti ADD CONSTRAINT pacienti_plan_check
  CHECK (plan = ANY (ARRAY['Abonament'::text, 'Ședință unică'::text, 'Subscription'::text, 'One Time'::text]));

ALTER TABLE pacienti ADD COLUMN IF NOT EXISTS sters_la timestamptz;

CREATE OR REPLACE FUNCTION public.blocheaza_stergere_cu_istoric() RETURNS trigger AS $f$
BEGIN
  IF EXISTS (SELECT 1 FROM plati WHERE pacient_id = OLD.id)
     OR EXISTS (SELECT 1 FROM programari WHERE pacient_id = OLD.id) THEN
    RAISE EXCEPTION 'Pacientul are istoric (plăți/ședințe) și nu poate fi șters definitiv. Folosește arhivarea.';
  END IF;
  RETURN OLD;
END $f$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_blocheaza_stergere_pacient ON public.pacienti;
CREATE TRIGGER trg_blocheaza_stergere_pacient
  BEFORE DELETE ON public.pacienti FOR EACH ROW
  EXECUTE FUNCTION public.blocheaza_stergere_cu_istoric();

DROP VIEW IF EXISTS pacienti_view;
CREATE VIEW pacienti_view
WITH (security_invoker = true) AS
SELECT p.id, p.nume, p.prenume, p.telefon, p.locatie, p.plan, p.frecventa,
  p.cost, p.sedinte_total, p.sedinte_folosite, p.sedinte_ramase, p.achitat,
  p.status_abonament, p.notite, p.drive_link, p.created_at, p.updated_at,
  p.user_id, p.nu_reinnoi, p.sters_la,
  TRIM(BOTH FROM (COALESCE(p.prenume, ''::text) || ' '::text) || COALESCE(p.nume, ''::text)) AS name,
  COALESCE(pl.total, 0::numeric) AS suma_incasata,
  COALESCE(pr.cnt, 0::bigint) AS numar_programari
FROM pacienti p
  LEFT JOIN (SELECT pacient_id, sum(suma) AS total FROM plati GROUP BY pacient_id) pl
    ON pl.pacient_id = p.id
  LEFT JOIN (SELECT pacient_id, count(*) AS cnt FROM programari GROUP BY pacient_id) pr
    ON pr.pacient_id = p.id;
