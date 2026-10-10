-- Fix bug in lega_sedinta_de_pachet:
-- 1. Eliminate date_trunc('month', NEW.data) which forced calendar months.
-- 2. Fix closed_at overlap logic (it incorrectly set closed_at = v_month_end on the old package).
CREATE OR REPLACE FUNCTION public.lega_sedinta_de_pachet()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_pkg uuid;
  v_plan text;
  v_nu_reinnoi boolean;
  v_last abonamente%ROWTYPE;
  v_debt int;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.status = 'finalizat' AND NEW.contorizeaza THEN
      IF NEW.abonament_id IS NULL THEN
        SELECT a.id INTO v_pkg
          FROM public.abonamente a
          WHERE a.pacient_id = NEW.pacient_id
            AND a.created_at::date <= NEW.data
            AND (a.closed_at IS NULL OR a.closed_at::date > NEW.data)
          ORDER BY a.created_at DESC LIMIT 1;
        IF v_pkg IS NULL THEN
          SELECT a.* INTO v_last FROM public.abonamente a
            WHERE a.pacient_id = NEW.pacient_id ORDER BY a.created_at DESC LIMIT 1;
          IF (v_last.id IS NOT NULL AND v_last.tip = 'lunar')
             OR (v_last.id IS NULL AND EXISTS (
                   SELECT 1 FROM public.pacienti p
                   LEFT JOIN public.abonamente a2 ON a2.pacient_id = p.id
                   WHERE p.id = NEW.pacient_id
                   GROUP BY p.plan
                   HAVING p.plan = 'Abonament lunar' OR bool_or(a2.tip = 'lunar')
                 )) THEN
            
            -- Calculăm datoria de pe pachetele închise
            SELECT COALESCE((
              SELECT sum(GREATEST(0, a.sedinte_folosite - a.nr_sedinte))
              FROM public.abonamente a
              WHERE a.pacient_id = NEW.pacient_id AND a.status = 'inchis'
            ), 0) INTO v_debt;
            
            -- FIX: pachetul vechi se închide la data noii programări (fără overlap!)
            UPDATE public.abonamente SET status = 'inchis', closed_at = NEW.data
              WHERE pacient_id = NEW.pacient_id AND status = 'activ';
              
            -- FIX: pachetul nou pleacă fix de la data ședinței pe 1 lună (fără calendar force)
            INSERT INTO public.abonamente (pacient_id, user_id, nr_sedinte, pret, sedinte_folosite, datorie_initiala, tip, status, created_at, closed_at)
            VALUES (NEW.pacient_id, (SELECT user_id FROM public.pacienti WHERE id = NEW.pacient_id),
                    COALESCE(v_last.nr_sedinte, GREATEST(1, (SELECT sedinte_total FROM public.pacienti WHERE id = NEW.pacient_id))),
                    COALESCE(v_last.pret, GREATEST(0, (SELECT cost FROM public.pacienti WHERE id = NEW.pacient_id))),
                    v_debt, v_debt, 'lunar', 'activ', NEW.data, (NEW.data + interval '1 month')::date)
            RETURNING id INTO v_pkg;
          ELSE
            SELECT a.id INTO v_pkg
              FROM public.abonamente a
              WHERE a.pacient_id = NEW.pacient_id AND a.status = 'activ'
              ORDER BY a.created_at DESC LIMIT 1;
          END IF;
        END IF;
        IF v_pkg IS NULL THEN
          SELECT p.nu_reinnoi, p.plan INTO v_nu_reinnoi, v_plan
            FROM public.pacienti p WHERE p.id = NEW.pacient_id;
          IF v_plan IS DISTINCT FROM 'One Time' AND v_plan IS DISTINCT FROM 'Ședință unică'
             AND COALESCE(v_nu_reinnoi, false) = false THEN
            RAISE EXCEPTION 'Pacientul nu are un pachet activ. Reînnoiește abonamentul înainte de a confirma ședința.';
          END IF;
        END IF;
        NEW.abonament_id := v_pkg;
      END IF;
    ELSE
      NEW.abonament_id := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
