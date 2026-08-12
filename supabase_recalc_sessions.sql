-- 1. Recalculate existing counters for used sessions (sedinte_folosite)
UPDATE public.pacienti p
SET sedinte_folosite = COALESCE(
  (
    SELECT COUNT(*)
    FROM public.programari pr
    WHERE pr.pacient_id = p.id
      AND pr.status = 'finalizat'
  ),
  0
);

-- 2. Update the subscription status (status_abonament) based on the newly calculated counters
UPDATE public.pacienti p
SET status_abonament = CASE
  WHEN p.sedinte_total > 0 AND p.sedinte_folosite >= p.sedinte_total THEN 'terminat'
  WHEN p.sedinte_total > 0 AND p.sedinte_folosite = p.sedinte_total - 1 THEN 'ultima_sedinta'
  ELSE 'activ'
END
WHERE status_abonament NOT IN ('inactiv');

-- 3. Verify if the auto-increment trigger exists
SELECT trigger_name
FROM information_schema.triggers
WHERE trigger_name = 'trg_incrementeaza_sedinte';
