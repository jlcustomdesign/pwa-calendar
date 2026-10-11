-- Curățenie finală: wrapper mort + funcție orfană (niciun trigger nu le folosește;
-- frontendul apelează renew_package canonic direct).
DROP FUNCTION IF EXISTS public.renew_subscription(uuid, integer, numeric, numeric, text);
DROP FUNCTION IF EXISTS public.incrementeaza_sedinte_folosite();
