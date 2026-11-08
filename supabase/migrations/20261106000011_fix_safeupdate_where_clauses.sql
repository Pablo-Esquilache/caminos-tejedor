-- =============================================================================
-- Migración 011: Corregir funciones PL/pgSQL para cumplimiento estricto de cláusula WHERE
-- (Evita el error 'UPDATE requires WHERE clause' de safeupdate en Supabase)
-- =============================================================================

-- 1. recalculate_road_metrics con cláusula WHERE explícita sobre columna id
CREATE OR REPLACE FUNCTION public.recalculate_road_metrics(p_road_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_road_id IS NOT NULL THEN
    UPDATE public.roads r
    SET
      total_length_m = COALESCE(
        (SELECT ROUND(SUM(s.length_m)::numeric, 2) FROM public.road_segments s WHERE s.road_id = r.id),
        0
      ),
      approved_trips_count = COALESCE(
        (
          SELECT COUNT(DISTINCT t.id)
          FROM public.trip_segment_usage u
          JOIN public.road_segments s ON s.id = u.segment_id
          JOIN public.trips t ON t.id = u.trip_id
          WHERE s.road_id = r.id AND t.status = 'approved'
        ),
        0
      ),
      unique_users_count = COALESCE(
        (
          SELECT COUNT(DISTINCT t.user_id)
          FROM public.trip_segment_usage u
          JOIN public.road_segments s ON s.id = u.segment_id
          JOIN public.trips t ON t.id = u.trip_id
          WHERE s.road_id = r.id AND t.status = 'approved'
        ),
        0
      ),
      updated_at = now()
    WHERE r.id = p_road_id;
  ELSE
    UPDATE public.roads r
    SET
      total_length_m = COALESCE(
        (SELECT ROUND(SUM(s.length_m)::numeric, 2) FROM public.road_segments s WHERE s.road_id = r.id),
        0
      ),
      approved_trips_count = COALESCE(
        (
          SELECT COUNT(DISTINCT t.id)
          FROM public.trip_segment_usage u
          JOIN public.road_segments s ON s.id = u.segment_id
          JOIN public.trips t ON t.id = u.trip_id
          WHERE s.road_id = r.id AND t.status = 'approved'
        ),
        0
      ),
      unique_users_count = COALESCE(
        (
          SELECT COUNT(DISTINCT t.user_id)
          FROM public.trip_segment_usage u
          JOIN public.road_segments s ON s.id = u.segment_id
          JOIN public.trips t ON t.id = u.trip_id
          WHERE s.road_id = r.id AND t.status = 'approved'
        ),
        0
      ),
      updated_at = now()
    WHERE r.id IS NOT NULL;
  END IF;
END;
$$;

-- 2. reclassify_all_roads con cláusula WHERE explícita sobre columna id
CREATE OR REPLACE FUNCTION public.reclassify_all_roads()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg jsonb;
  v_troncal integer;
  v_principal integer;
  v_secundario integer;
  v_count integer;
BEGIN
  SELECT value INTO v_cfg
  FROM public.settings
  WHERE key = 'road_classification_thresholds';

  v_troncal := COALESCE((v_cfg->>'troncal_min_trips')::integer, 25);
  v_principal := COALESCE((v_cfg->>'principal_min_trips')::integer, 10);
  v_secundario := COALESCE((v_cfg->>'secundario_min_trips')::integer, 3);

  UPDATE public.roads
  SET road_class = CASE
        WHEN approved_trips_count >= v_troncal THEN 'troncal'
        WHEN approved_trips_count >= v_principal THEN 'principal'
        WHEN approved_trips_count >= v_secundario THEN 'secundario'
        ELSE 'vecinal'
      END,
      updated_at = now()
  WHERE id IS NOT NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 3. reprocess_all_roads con cláusula WHERE explícita en todos los DELETE
CREATE OR REPLACE FUNCTION public.reprocess_all_roads()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip record;
  v_processed_count integer := 0;
  v_new_roads_count integer := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo un administrador puede reprocesar la red de caminos.';
  END IF;

  DELETE FROM public.trip_segment_usage WHERE trip_id IS NOT NULL;
  DELETE FROM public.road_name_aliases WHERE id IS NOT NULL;
  DELETE FROM public.road_segments WHERE id IS NOT NULL;
  DELETE FROM public.roads WHERE id IS NOT NULL;

  FOR v_trip IN
    SELECT id
    FROM public.trips
    WHERE status = 'approved'
    ORDER BY created_at ASC
  LOOP
    PERFORM public.consolidate_trip(v_trip.id);
    v_processed_count := v_processed_count + 1;
  END LOOP;

  SELECT count(*) INTO v_new_roads_count FROM public.roads;

  INSERT INTO public.audit_log (
    actor_id, action, table_name, record_id, old_data, new_data
  ) VALUES (
    auth.uid(),
    'reprocess_all_roads',
    'roads',
    NULL,
    NULL,
    jsonb_build_object(
      'processed_trips', v_processed_count,
      'resulting_roads', v_new_roads_count
    )
  );

  RETURN jsonb_build_object(
    'status', 'success',
    'processed_trips', v_processed_count,
    'resulting_roads', v_new_roads_count
  );
END;
$$;
