-- One-time fix: recalculează sedinte_folosite pe baza programărilor finalizate.
-- Rulează acest script în SQL Editor din Supabase dacă contoarele sunt dezacordate.

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

-- Actualizează și statusul abonamentului conform noilor valori
UPDATE public.pacienti p
SET status_abonament = CASE
  WHEN p.sedinte_total > 0 AND p.sedinte_folosite >= p.sedinte_total THEN 'terminat'
  WHEN p.sedinte_total > 0 AND p.sedinte_folosite = p.sedinte_total - 1 THEN 'ultima_sedinta'
  ELSE 'activ'
END
WHERE status_abonament NOT IN ('inactiv');
