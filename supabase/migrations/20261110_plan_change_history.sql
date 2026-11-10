-- ═══════════════════════════════════════════════════════════════════
-- Note de istoric pentru pacient + notă automată la schimbarea planului.
-- Schimbarea Abonament ↔ Ședință unică nu rescrie nimic din trecut —
-- doar închide/deschide pachetul și lasă în istoric o linie vizibilă:
-- „Schimbare tip abonament: Abonament → Ședință unică" (și invers).
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.istoric_evenimente (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pacient_id uuid NOT NULL REFERENCES public.pacienti(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.istoric_evenimente ENABLE ROW LEVEL SECURITY;

CREATE POLICY "istoric_select_own" ON public.istoric_evenimente
  FOR SELECT USING (auth.uid() = user_id);
-- INSERT/UPDATE/DELETE nu se acordă la client: doar RPC-urile security definer
-- (switch_plan) scriu aici.

CREATE OR REPLACE FUNCTION public.switch_plan(
  p_pacient_id uuid,
  p_plan text,
  p_total int,
  p_cost numeric
) RETURNS void AS $f$
DECLARE
  v_pacient pacienti%ROWTYPE;
  v_old text;
  v_label_old text;
  v_label_new text;
BEGIN
  SELECT * INTO v_pacient FROM pacienti WHERE id = p_pacient_id FOR UPDATE;
  IF NOT FOUND OR v_pacient.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Pacient invalid sau neautorizat.';
  END IF;
  IF p_plan IS DISTINCT FROM 'One Time' AND p_plan IS DISTINCT FROM 'Subscription' THEN
    RAISE EXCEPTION 'Plan necunoscut: %', p_plan;
  END IF;

  v_old := v_pacient.plan;
  v_label_old := CASE v_old
    WHEN 'One Time' THEN 'Ședință unică'
    WHEN 'Subscription' THEN 'Abonament'
    ELSE COALESCE(v_old, '—') END;
  v_label_new := CASE p_plan
    WHEN 'One Time' THEN 'Ședință unică'
    WHEN 'Subscription' THEN 'Abonament'
    ELSE p_plan END;

  IF p_plan IS NOT DISTINCT FROM 'One Time' THEN
    -- Ședință unică: pachetul deschis se închide; sesiunea unică pornește
    -- cu contor curat (istoricul rămâne în programari + abonamente).
    UPDATE public.abonamente SET status = 'inchis', closed_at = now()
      WHERE pacient_id = p_pacient_id AND status = 'activ';
  ELSIF NOT EXISTS (SELECT 1 FROM public.abonamente WHERE pacient_id = p_pacient_id AND status = 'activ') THEN
    -- Abonament fără pachet activ (ex. venit din One Time): pachet nou.
    INSERT INTO public.abonamente (pacient_id, user_id, nr_sedinte, pret, status)
    VALUES (p_pacient_id, auth.uid(), GREATEST(1, p_total), GREATEST(0, p_cost), 'activ');
  ELSE
    -- Abonament cu pachet activ: reiterează plafonul/prețul pachetului curent.
    UPDATE public.abonamente SET nr_sedinte = GREATEST(1, p_total), pret = GREATEST(0, p_cost)
      WHERE pacient_id = p_pacient_id AND status = 'activ';
  END IF;

  PERFORM set_config('app.allow_counter_write', 'on', true);
  UPDATE public.pacienti SET
    plan = p_plan,
    sedinte_total = GREATEST(1, p_total),
    sedinte_folosite = 0,
    cost = GREATEST(0, p_cost),
    status_abonament = 'activ',
    abonament_start = CURRENT_DATE
  WHERE id = p_pacient_id;

  INSERT INTO public.istoric_evenimente (pacient_id, user_id, text)
  VALUES (p_pacient_id, auth.uid(),
    'Schimbare tip abonament: ' || v_label_old || ' → ' || v_label_new);
END $f$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.switch_plan(uuid, text, int, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switch_plan(uuid, text, int, numeric) TO authenticated;
