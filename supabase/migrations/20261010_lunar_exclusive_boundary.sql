-- closed_at e capăt EXCLUSIV al ferestrei pachetului (fereastra = [created_at, closed_at)).
-- Cu >=, o ședință fix pe ziua de expirare (ex. 10 nov pentru pachet 10 oct–10 nov)
-- se lipea de luna veche în loc să declanșeze pachetul lunii noi.
CREATE OR REPLACE FUNCTION public.lega_sedinta_de_pachet()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_pkg uuid;
  v_plan text;
  v_nu_reinnoi boolean;
  v_last abonamente%ROWTYPE;
  v_month_start date;
  v_month_end date;
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
            v_month_start := NEW.data;
            v_month_end := (v_month_start + interval '1 month')::date;
            UPDATE public.abonamente SET status = 'inchis', closed_at = v_month_start
              WHERE pacient_id = NEW.pacient_id AND status = 'activ';
            INSERT INTO public.abonamente (pacient_id, user_id, nr_sedinte, pret, tip, status, created_at, closed_at)
            VALUES (NEW.pacient_id, (SELECT user_id FROM public.pacienti WHERE id = NEW.pacient_id),
                    COALESCE(v_last.nr_sedinte, GREATEST(1, (SELECT sedinte_total FROM public.pacienti WHERE id = NEW.pacient_id))),
                    COALESCE(v_last.pret, GREATEST(0, (SELECT cost FROM public.pacienti WHERE id = NEW.pacient_id))),
                    'lunar', 'activ', v_month_start, v_month_end)
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
