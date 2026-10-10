-- Contorul trebuie să reacționeze și la mutarea datei unei ședințe finalizate:
-- religa_la_mutare_data poate schimba abonament_id în BEFORE, iar triggerul AFTER
-- nu declanșa fiindcă abonament_id nu era în SET. Adăugarea lui `data` în
-- lista UPDATE OF acoperă tranziția; fără schimbare de pachet e no-op.
DROP TRIGGER IF EXISTS trg_incrementeaza_sedinte ON public.programari;
CREATE TRIGGER trg_incrementeaza_sedinte
  AFTER INSERT OR UPDATE OF status, contorizeaza, abonament_id, data OR DELETE ON public.programari
  FOR EACH ROW EXECUTE FUNCTION public.numara_sedinte();
