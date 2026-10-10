-- Mutarea datei unei ședințe finalizate re-atribuie pachetul: dacă noua dată
-- cade într-un alt pachet (deschis sau închis care acoperea data), linkul se
-- mută și contoarele se ajustează prin triggerul AFTER existent (-1/+1).
-- Dacă noua dată nu e acoperită de niciun pachet → eroare explicită, nu
-- atribuire silențioasă greșită (cea de-a doua vulnerabilitate din audit).
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
    -- Pachetul care acoperă noua dată (aceeași regulă ca la finalizare).
    SELECT a.id INTO v_pkg
      FROM public.abonamente a
      WHERE a.pacient_id = NEW.pacient_id
        AND a.created_at::date <= NEW.data
        AND (a.closed_at IS NULL OR a.closed_at::date > NEW.data)
      ORDER BY a.created_at DESC LIMIT 1;
    IF v_pkg IS NULL THEN
      -- fără pachet care să acopere noua dată: lunar primește luna țintă
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
               NEW.data,
               (NEW.data + interval '1 month')::date
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

DROP TRIGGER IF EXISTS trg_religa_la_mutare_data ON public.programari;
CREATE TRIGGER trg_religa_la_mutare_data
  BEFORE UPDATE OF data ON public.programari
  FOR EACH ROW EXECUTE FUNCTION public.religa_la_mutare_data();
