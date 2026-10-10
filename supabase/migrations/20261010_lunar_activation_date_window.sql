-- Două corecții la fluxul lunar automat:
-- 1) la rostogolire, pachetul vechi se închidea cu closed_at = sfârșitul NOI luni
--    (suprapunere totală cu pachetul nou). Corect: se închide la începutul
--    ferestrei noi (capăt exclusiv) — [vechi] .. [nou] fără suprapunere.
-- 2) pachetul auto-creat folosea date_trunc('month', data) → forța începutul de
--    lună calendaristică, distrugând regula "de la activare, o lună". Corect:
--    fereastra pornește din data ședinței care declanșează activarea.
CREATE OR REPLACE FUNCTION public.lega_sedinta_de_pachet()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_pkg uuid;
  v_plan text;
  v_nu_reinnoi boolean;
  v_last abonamente%ROWTYPE;
  v_start date;
  v_end date;
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
            -- lună efectivă de la activare (data ședinței), nu lună calendaristică
            v_start := NEW.data;
            v_end := (NEW.data + interval '1 month')::date;
            UPDATE public.abonamente SET status = 'inchis', closed_at = v_start
              WHERE pacient_id = NEW.pacient_id AND status = 'activ';
            INSERT INTO public.abonamente (pacient_id, user_id, nr_sedinte, pret, tip, status, created_at, closed_at)
            VALUES (NEW.pacient_id, (SELECT user_id FROM public.pacienti WHERE id = NEW.pacient_id),
                    COALESCE(v_last.nr_sedinte, GREATEST(1, (SELECT sedinte_total FROM public.pacienti WHERE id = NEW.pacient_id))),
                    COALESCE(v_last.pret, GREATEST(0, (SELECT cost FROM public.pacienti WHERE id = NEW.pacient_id))),
                    'lunar', 'activ', v_start, v_end)
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

-- Același principiu la mutarea datei unei ședințe finale: pachetul lunar creat
-- automat acoperă o lună de la noua dată, nu de la 1 a lunii.
CREATE OR REPLACE FUNCTION public.religa_la_mutare_data()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_pkg uuid;
  v_plan text;
  v_nu_reinnoi boolean;
BEGIN
  IF NEW.status = 'finalizat' AND NEW.contorizeaza
     AND OLD.abonament_id IS NOT NULL
     AND NEW.data IS DISTINCT FROM OLD.data THEN
    SELECT a.id INTO v_pkg
      FROM public.abonamente a
      WHERE a.pacient_id = NEW.pacient_id
        AND a.created_at::date <= NEW.data
        AND (a.closed_at IS NULL OR a.closed_at::date > NEW.data)
      ORDER BY a.created_at DESC LIMIT 1;
    IF v_pkg IS NULL THEN
      SELECT p.nu_reinnoi, p.plan INTO v_nu_reinnoi, v_plan
        FROM public.pacienti p WHERE p.id = NEW.pacient_id;
      IF v_plan = 'Abonament lunar' OR EXISTS (
           SELECT 1 FROM public.abonamente a
           WHERE a.pacient_id = NEW.pacient_id AND a.tip = 'lunar'
         ) THEN
        UPDATE public.abonamente SET status = 'inchis', closed_at = NEW.data
          WHERE pacient_id = NEW.pacient_id AND status = 'activ';
        INSERT INTO public.abonamente (pacient_id, user_id, nr_sedinte, pret, tip, status, created_at, closed_at)
        SELECT NEW.pacient_id, p.user_id,
               GREATEST(1, p.sedinte_total), GREATEST(0, p.cost),
               'lunar', 'activ',
               NEW.data, (NEW.data + interval '1 month')::date
        FROM public.pacienti p WHERE p.id = NEW.pacient_id
        RETURNING id INTO v_pkg;
      ELSIF v_plan IS DISTINCT FROM 'One Time' AND v_plan IS DISTINCT FROM 'Ședință unică'
            AND COALESCE(v_nu_reinnoi, false) = false THEN
        RAISE EXCEPTION 'Noua dată (%) nu e acoperită de niciun pachet. Reînnoiește abonamentul sau definalizează ședința înainte de a muta data.', NEW.data;
      END IF;
    END IF;
    NEW.abonament_id := v_pkg;
  END IF;
  RETURN NEW;
END;
$$;
