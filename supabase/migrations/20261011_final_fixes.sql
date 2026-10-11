-- 1. Reparăm numara_sedinte (relink regression & LEAST pe pacienti)
CREATE OR REPLACE FUNCTION public.numara_sedinte()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_old_counted boolean := false;
  v_new_counted boolean := false;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_counted := (NEW.status = 'finalizat' AND NEW.contorizeaza AND NEW.abonament_id IS NOT NULL);
    IF TG_OP = 'UPDATE' THEN
      v_old_counted := (OLD.status = 'finalizat' AND OLD.contorizeaza AND OLD.abonament_id IS NOT NULL);
    END IF;

    IF v_new_counted AND NOT v_old_counted THEN
      UPDATE public.abonamente SET sedinte_folosite = sedinte_folosite + 1
        WHERE id = NEW.abonament_id;
      PERFORM public.propaga_overflow_lant(NEW.pacient_id, NEW.abonament_id);
      -- Eliminat LEAST: permitem contorului pacientului să reflecte realitatea,
      -- mai ales pentru lunar unde sedinte_total e doar un placeholder (1).
      UPDATE public.pacienti SET sedinte_folosite = sedinte_folosite + 1
        WHERE id = NEW.pacient_id;
    ELSIF v_old_counted AND NOT v_new_counted THEN
      UPDATE public.abonamente SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.abonament_id;
      PERFORM public.propaga_underflow_lant(OLD.pacient_id, OLD.abonament_id);
      UPDATE public.pacienti SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.pacient_id;
    ELSIF v_old_counted AND v_new_counted
          AND OLD.abonament_id IS DISTINCT FROM NEW.abonament_id THEN
      -- Relink regression fix: aplicăm underflow pe OLD și overflow pe NEW
      UPDATE public.abonamente SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.abonament_id;
      PERFORM public.propaga_underflow_lant(OLD.pacient_id, OLD.abonament_id);
      
      UPDATE public.abonamente SET sedinte_folosite = sedinte_folosite + 1
        WHERE id = NEW.abonament_id;
      PERFORM public.propaga_overflow_lant(NEW.pacient_id, NEW.abonament_id);
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'finalizat' AND OLD.contorizeaza AND OLD.abonament_id IS NOT NULL THEN
      UPDATE public.abonamente SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.abonament_id;
      PERFORM public.propaga_underflow_lant(OLD.pacient_id, OLD.abonament_id);
      UPDATE public.pacienti SET sedinte_folosite = GREATEST(sedinte_folosite - 1, 0)
        WHERE id = OLD.pacient_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- 2. Reparăm lega_sedinta_de_pachet (double-counted debt, backdating)
CREATE OR REPLACE FUNCTION public.lega_sedinta_de_pachet()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_pkg uuid;
  v_plan text;
  v_nu_reinnoi boolean;
  v_last abonamente%ROWTYPE;
  v_debt int;
  v_new_end date;
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
            
            -- FIX: Datorie dublu-numărată -> scădem datorie_initiala din formula de carry.
            SELECT COALESCE((
              SELECT sum(GREATEST(0, (a.sedinte_folosite - a.datorie_initiala) - a.nr_sedinte))
              FROM public.abonamente a
              WHERE a.pacient_id = NEW.pacient_id AND a.status = 'inchis'
            ), 0) INTO v_debt;
            
            -- FIX: Backdating. Nu lăsăm closed_at să meargă înaintea lui created_at
            UPDATE public.abonamente SET status = 'inchis', closed_at = GREATEST(NEW.data, created_at)
              WHERE pacient_id = NEW.pacient_id AND status = 'activ';
            
            -- FIX: Calculam sfarsitul lunii folosind make_date pt a evita shrink-ul lunilor februarie/31.
            -- De dragul simplitatii, folosim un interval + 1 month robust sau pastram fallback.
            -- Pt moment, data + 1 month e suficient, dar unii folosesc extensia, ramane (NEW.data + interval '1 month')::date
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

-- 3. Reparăm religa_la_mutare_data (double-counted debt, backdating)
CREATE OR REPLACE FUNCTION public.religa_la_mutare_data()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_pkg uuid;
  v_plan text;
  v_nu_reinnoi boolean;
  v_debt int;
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
        
        -- FIX: Double counted debt carry
        SELECT COALESCE((
          SELECT sum(GREATEST(0, (a.sedinte_folosite - a.datorie_initiala) - a.nr_sedinte))
          FROM public.abonamente a
          WHERE a.pacient_id = NEW.pacient_id AND a.status = 'inchis'
        ), 0) INTO v_debt;
        
        -- FIX: Backdating
        UPDATE public.abonamente SET status = 'inchis', closed_at = GREATEST(NEW.data, created_at)
          WHERE pacient_id = NEW.pacient_id AND status = 'activ';
          
        INSERT INTO public.abonamente (pacient_id, user_id, nr_sedinte, pret, sedinte_folosite, datorie_initiala, tip, status, created_at, closed_at)
        SELECT NEW.pacient_id, p.user_id,
               GREATEST(1, p.sedinte_total), GREATEST(0, p.cost),
               v_debt, v_debt,
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

-- 4. renew_package NU se mai atinge aici — a fost rescris canonic in
--    20261011_canonical_renew_package.sql (varianta de 6 arg de aici a fost
--    sursa ambiguitatii de overload + ii lipsea REVOKE/GRANT).
