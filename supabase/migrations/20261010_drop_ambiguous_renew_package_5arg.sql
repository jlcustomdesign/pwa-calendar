-- Doua overload-uri renew_package 5-arg si 6-arg (cu p_tip implicit) fac orice
-- apel de 5 argumente ambiguu (42725) → butonul de Reînnoire din aplicație crapa.
-- Varianta de 6 argumente cu default acoperă și apelul vechi de 5.
DROP FUNCTION IF EXISTS public.renew_package(uuid, integer, numeric, numeric, text);
