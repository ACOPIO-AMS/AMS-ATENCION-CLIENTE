-- EJECUTAR SOLO UNA VEZ desde Supabase SQL Editor, después de respaldar.
-- Conserva contraseña y referencia de sesiones sin borrar la cuenta.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ams_operator_accounts WHERE operator_name='SUGELLY CONTRERAS GARCIA')
     AND EXISTS (SELECT 1 FROM public.ams_operator_accounts WHERE operator_name='SUGELLY CONTRERAS CAJA')
  THEN RAISE EXCEPTION 'Ya existe el nombre nuevo; revisar antes de fusionar cuentas.';
  END IF;
END $$;
ALTER TABLE public.ams_operator_sessions DROP CONSTRAINT IF EXISTS ams_operator_sessions_operator_name_fkey;
ALTER TABLE public.ams_operator_sessions
  ADD CONSTRAINT ams_operator_sessions_operator_name_fkey
  FOREIGN KEY(operator_name) REFERENCES public.ams_operator_accounts(operator_name) ON UPDATE CASCADE;
UPDATE public.ams_operator_accounts
 SET operator_name='SUGELLY CONTRERAS CAJA', updated_at=now()
 WHERE operator_name='SUGELLY CONTRERAS GARCIA';
COMMIT;
SELECT operator_name,(password_hash IS NOT NULL) AS clave_configurada,disabled
FROM public.ams_operator_accounts WHERE operator_name LIKE 'SUGELLY%';
