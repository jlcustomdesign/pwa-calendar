-- Script Migrare Supabase Garantat (fără erori de conflict pe VIEW)
-- Execută în: https://supabase.com/dashboard/project/dlklegayibhgnrxnqapm/sql/new

-- 1. Creează tabela de plăți
CREATE TABLE IF NOT EXISTS public.plati (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pacient_id UUID NOT NULL REFERENCES public.pacienti(id) ON DELETE CASCADE,
    suma NUMERIC(10, 2) NOT NULL,
    data_platii DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Permisiuni RLS
ALTER TABLE public.plati ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all access to plati" ON public.plati;
CREATE POLICY "Allow all access to plati" ON public.plati FOR ALL USING (true) WITH CHECK (true);

-- 3. Șterge vizualizarea existentă cu CASCADE pentru a preveni erori de tipul "cannot change name/order of view column"
DROP VIEW IF EXISTS public.pacienti_view CASCADE;

-- 4. Re-creează vizualizarea pacienți cu câmpul suma_incasata
CREATE VIEW public.pacienti_view AS
SELECT 
    p.*,
    (p.prenume || ' ' || p.nume) AS name,
    COALESCE((SELECT COUNT(*) FROM public.programari pr WHERE pr.pacient_id = p.id AND pr.status = 'finalizata'), 0) AS sedinte_folosite,
    GREATEST(0, p.sedinte_total - COALESCE((SELECT COUNT(*) FROM public.programari pr WHERE pr.pacient_id = p.id AND pr.status = 'finalizata'), 0)) AS sedinte_ramase,
    COALESCE((SELECT SUM(pl.suma) FROM public.plati pl WHERE pl.pacient_id = p.id), 0) AS suma_incasata
FROM public.pacienti p;
