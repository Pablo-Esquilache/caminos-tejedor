-- 20261109000013_drop_overloaded_submit_trip_function.sql
-- Elimina la sobrecarga de la función submit_trip_with_track de 7 parámetros.
-- Al existir con 7 parámetros y con 8 parámetros (donde el 8vo tiene valor por defecto DEFAULT NULL),
-- PostgreSQL producía un error de ambigüedad "Could not choose the best candidate function".

DROP FUNCTION IF EXISTS public.submit_trip_with_track(
  uuid,
  text,
  timestamptz,
  timestamptz,
  numeric,
  integer,
  jsonb
);

-- Asegurar permisos de ejecución para usuarios autenticados sobre la versión definitiva (8 parámetros con default)
GRANT EXECUTE ON FUNCTION public.submit_trip_with_track(
  uuid,
  text,
  timestamptz,
  timestamptz,
  numeric,
  integer,
  jsonb,
  text
) TO authenticated;
