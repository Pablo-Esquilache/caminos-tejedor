-- ============================================================================
-- Migración 021: Ajustes de Auditoría v20 (Pre-Campo)
-- 1. Respaldo en audit_log del estado de métricas lineales de intervenciones
-- 2. Columna precalculada low_zone_length_m en road_segment_elevations y
--    limpieza de filas obsoletas de la migración 018 (45m / copernicus-dem-30m)
-- 3. Muestreo cada 90m hasta 250 pasos (22,5 km) + geom_hash en
--    admin_get_segments_needing_elevation
-- 4. Validación de geom_hash y tamaño de payload en admin_save_segment_elevation
-- 5. Eliminación de ST_GeomFromGeoJSON por fila y LIMIT 1500 en
--    get_consolidated_roads_map; bandera 'truncated' en get_admin_low_zones_map
-- 6. Guarda estricta is_admin() en admin_recalculate_intervention_metrics
-- ============================================================================

-- 1) Guardar instantánea auditable de las métricas lineales de intervenciones en audit_log
INSERT INTO public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
SELECT
  NULL,
  'intervention_metrics_snapshot_v21',
  'interventions',
  i.id::text,
  NULL,
  jsonb_build_object(
    'title', i.title,
    'status', i.status,
    'worked_length_m', i.worked_length_m,
    'total_gps_distance_m', i.total_gps_distance_m,
    'sessions_count', i.sessions_count,
    'snapshot_at', now()
  )
FROM public.interventions i
WHERE i.execution_mode = 'linear';

-- 2) Precalcular low_zone_length_m en road_segment_elevations y limpiar filas viejas de la 018
ALTER TABLE public.road_segment_elevations
  ADD COLUMN IF NOT EXISTS low_zone_length_m double precision NOT NULL DEFAULT 0;

-- Borrar perfiles creados con la migración 018 (muestreo cada 45 m o detector anterior)
-- para que sólo se calculen con el detector cóncavo bilateral corregido a 90 m
DELETE FROM public.road_segment_elevations
WHERE dem_source = 'copernicus-dem-30m'
   OR updated_at < now() + interval '1 second';

-- 3) admin_get_segments_needing_elevation: soporte de tramos largos (hasta 250 pasos = 22,5 km a 90m)
--    y retorno de geom_hash al momento del muestreo
CREATE OR REPLACE FUNCTION public.admin_get_segments_needing_elevation(
  p_limit integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Acceso restringido a administradores';
  END IF;

  SELECT COALESCE(
    jsonb_agg(seg_obj),
    '[]'::jsonb
  )
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'segment_id', s.id,
      'road_id', s.road_id,
      'road_name', r.normalized_name,
      'length_m', s.length_m,
      'geom_hash', md5(ST_AsEWKB(s.geom)),
      'sample_points', (
        SELECT jsonb_agg(
          jsonb_build_object(
            'dist_m', ROUND((s.length_m * (gs.idx::double precision / steps.n_steps))::numeric, 1),
            'lat', ST_Y(pt.geom_4326),
            'lon', ST_X(pt.geom_4326)
          )
          ORDER BY gs.idx
        )
        FROM (
          SELECT
            ST_Transform(s.geom, 32720) AS geom_utm,
            GREATEST(2, LEAST(250, CEIL(GREATEST(s.length_m, 90) / 90.0)::int)) AS n_steps
        ) steps,
        generate_series(0, steps.n_steps) AS gs(idx),
        LATERAL (
          SELECT ST_Transform(
            ST_LineInterpolatePoint(steps.geom_utm, gs.idx::double precision / steps.n_steps),
            4326
          ) AS geom_4326
        ) pt
      )
    ) AS seg_obj
    FROM public.road_segments s
    JOIN public.roads r ON r.id = s.road_id
    LEFT JOIN public.road_segment_elevations e ON e.segment_id = s.id
    WHERE (e.segment_id IS NULL OR e.geom_hash IS DISTINCT FROM md5(ST_AsEWKB(s.geom)))
      AND ST_NPoints(s.geom) >= 2
    ORDER BY s.length_m DESC
    LIMIT GREATEST(1, LEAST(p_limit, 100))
  ) sub;

  RETURN v_result;
END;
$$;

-- 4) admin_save_segment_elevation: validar geom_hash muestreado, forma/tamaño del payload
--    y precalcular low_zone_length_m una sola vez al guardar
DROP FUNCTION IF EXISTS public.admin_save_segment_elevation(uuid, jsonb, jsonb, double precision, double precision, double precision, boolean, text);

CREATE OR REPLACE FUNCTION public.admin_save_segment_elevation(
  p_segment_id uuid,
  p_profile_points jsonb,
  p_low_zones_geojson jsonb,
  p_min_elev double precision,
  p_max_elev double precision,
  p_avg_elev double precision,
  p_has_low_zone boolean,
  p_dem_source text DEFAULT 'copernicus-dem-90m',
  p_expected_geom_hash text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_geom_hash text;
  v_pts_count integer;
  v_low_len_m double precision := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Acceso restringido a administradores';
  END IF;

  IF p_min_elev < -50 OR p_max_elev > 500 OR p_min_elev > p_max_elev THEN
    RAISE EXCEPTION 'Valores de elevación fuera de rango válido para la llanura pampeana';
  END IF;

  IF p_profile_points IS NULL OR jsonb_typeof(p_profile_points) <> 'array' THEN
    RAISE EXCEPTION 'p_profile_points debe ser un arreglo JSON';
  END IF;

  v_pts_count := jsonb_array_length(p_profile_points);
  IF v_pts_count < 2 OR v_pts_count > 300 THEN
    RAISE EXCEPTION 'Cantidad de muestras de perfil fuera de rango permitido (2..300): %', v_pts_count;
  END IF;

  SELECT md5(ST_AsEWKB(s.geom))
  INTO v_geom_hash
  FROM public.road_segments s
  WHERE s.id = p_segment_id;

  IF v_geom_hash IS NULL THEN
    RAISE EXCEPTION 'El segmento % no existe', p_segment_id;
  END IF;

  IF p_expected_geom_hash IS NOT NULL AND p_expected_geom_hash <> v_geom_hash THEN
    RAISE EXCEPTION 'El tramo fue modificado durante el muestreo (geom_hash no coincide). Reintentá la sincronización.';
  END IF;

  IF COALESCE(p_has_low_zone, false) AND p_low_zones_geojson IS NOT NULL THEN
    v_low_len_m := ROUND(
      ST_Length(ST_SetSRID(ST_GeomFromGeoJSON(p_low_zones_geojson::text), 4326)::geography)::numeric,
      0
    );
  END IF;

  INSERT INTO public.road_segment_elevations (
    segment_id,
    min_elevation_m,
    max_elevation_m,
    avg_elevation_m,
    has_low_zone,
    low_zone_length_m,
    profile_points,
    low_zones_geojson,
    dem_source,
    geom_hash,
    updated_at
  )
  VALUES (
    p_segment_id,
    p_min_elev,
    p_max_elev,
    p_avg_elev,
    COALESCE(p_has_low_zone, false),
    COALESCE(v_low_len_m, 0),
    p_profile_points,
    p_low_zones_geojson,
    COALESCE(NULLIF(trim(p_dem_source), ''), 'copernicus-dem-90m'),
    v_geom_hash,
    now()
  )
  ON CONFLICT (segment_id) DO UPDATE SET
    min_elevation_m = EXCLUDED.min_elevation_m,
    max_elevation_m = EXCLUDED.max_elevation_m,
    avg_elevation_m = EXCLUDED.avg_elevation_m,
    has_low_zone = EXCLUDED.has_low_zone,
    low_zone_length_m = EXCLUDED.low_zone_length_m,
    profile_points = EXCLUDED.profile_points,
    low_zones_geojson = EXCLUDED.low_zones_geojson,
    dem_source = EXCLUDED.dem_source,
    geom_hash = EXCLUDED.geom_hash,
    updated_at = now();
END;
$$;

-- 5) get_consolidated_roads_map: usar e.low_zone_length_m precalculado (sin ST_GeomFromGeoJSON por fila)
--    y agregar LIMIT 1500 para acotar el payload
CREATE OR REPLACE FUNCTION public.get_consolidated_roads_map(
  p_min_lon double precision DEFAULT -63.0,
  p_min_lat double precision DEFAULT -36.0,
  p_max_lon double precision DEFAULT -61.8,
  p_max_lat double precision DEFAULT -34.8,
  p_zoom numeric DEFAULT 11
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bbox geometry;
  v_simplify_tol_m double precision;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  v_bbox := ST_MakeEnvelope(p_min_lon, p_min_lat, p_max_lon, p_max_lat, 4326);

  v_simplify_tol_m := CASE
    WHEN p_zoom >= 14 THEN 3.0
    WHEN p_zoom >= 12 THEN 8.0
    ELSE 18.0
  END;

  SELECT COALESCE(
    jsonb_agg(row_obj),
    '[]'::jsonb
  )
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'segment_id', s.id,
      'road_id', r.id,
      'normalized_name', r.normalized_name,
      'road_class', r.road_class,
      'total_length_m', r.total_length_m,
      'approved_trips_count', r.approved_trips_count,
      'min_elevation_m', e.min_elevation_m,
      'max_elevation_m', e.max_elevation_m,
      'has_low_zone', COALESCE(e.has_low_zone, false),
      'low_zone_length_m', COALESCE(e.low_zone_length_m, 0),
      'geojson', ST_AsGeoJSON(
        ST_Transform(
          ST_SimplifyPreserveTopology(ST_Transform(s.geom, 32720), v_simplify_tol_m),
          4326
        )
      )::jsonb
    ) AS row_obj
    FROM public.road_segments s
    JOIN public.roads r ON r.id = s.road_id
    LEFT JOIN public.road_segment_elevations e ON e.segment_id = s.id
    WHERE s.geom && v_bbox
      AND ST_Intersects(s.geom, v_bbox)
    ORDER BY r.total_length_m DESC
    LIMIT 1500
  ) sub;

  RETURN v_result;
END;
$$;

-- 6) get_admin_low_zones_map: usar e.low_zone_length_m precalculado y devolver bandera 'truncated'
CREATE OR REPLACE FUNCTION public.get_admin_low_zones_map(
  p_min_lon double precision DEFAULT -63.0,
  p_min_lat double precision DEFAULT -36.0,
  p_max_lon double precision DEFAULT -61.8,
  p_max_lat double precision DEFAULT -34.8
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bbox geometry;
  v_pending_count integer;
  v_total_matching integer;
  v_items jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Acceso restringido a administradores';
  END IF;

  v_bbox := ST_MakeEnvelope(p_min_lon, p_min_lat, p_max_lon, p_max_lat, 4326);

  SELECT COUNT(*)::int
  INTO v_pending_count
  FROM public.road_segments s
  LEFT JOIN public.road_segment_elevations e ON e.segment_id = s.id
  WHERE (e.segment_id IS NULL OR e.geom_hash IS DISTINCT FROM md5(ST_AsEWKB(s.geom)))
    AND ST_NPoints(s.geom) >= 2;

  SELECT COUNT(*)::int
  INTO v_total_matching
  FROM public.road_segment_elevations e
  JOIN public.road_segments s ON s.id = e.segment_id
  WHERE e.has_low_zone = true
    AND e.low_zones_geojson IS NOT NULL
    AND s.geom && v_bbox
    AND ST_Intersects(s.geom, v_bbox);

  SELECT COALESCE(
    jsonb_agg(item_obj),
    '[]'::jsonb
  )
  INTO v_items
  FROM (
    SELECT jsonb_build_object(
      'segment_id', s.id,
      'road_id', r.id,
      'road_name', r.normalized_name,
      'road_class', r.road_class,
      'length_m', s.length_m,
      'min_elevation_m', e.min_elevation_m,
      'max_elevation_m', e.max_elevation_m,
      'avg_elevation_m', e.avg_elevation_m,
      'has_low_zone', e.has_low_zone,
      'low_zone_length_m', COALESCE(e.low_zone_length_m, 0),
      'low_zones_geojson', e.low_zones_geojson,
      'profile_points', e.profile_points,
      'dem_source', e.dem_source
    ) AS item_obj
    FROM public.road_segment_elevations e
    JOIN public.road_segments s ON s.id = e.segment_id
    JOIN public.roads r ON r.id = s.road_id
    WHERE e.has_low_zone = true
      AND e.low_zones_geojson IS NOT NULL
      AND s.geom && v_bbox
      AND ST_Intersects(s.geom, v_bbox)
    ORDER BY s.length_m DESC
    LIMIT 300
  ) sub;

  RETURN jsonb_build_object(
    'pending_count', v_pending_count,
    'truncated', (v_total_matching > 300),
    'total_matching', v_total_matching,
    'items', v_items
  );
END;
$$;

-- 7) Endurecer guarda de admin_recalculate_intervention_metrics (exigir siempre public.is_admin())
CREATE OR REPLACE FUNCTION public.admin_recalculate_intervention_metrics(p_intervention_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.' USING ERRCODE = '42501';
  END IF;
  PERFORM public.recalculate_intervention_worked_metrics(p_intervention_id);
END;
$$;

-- 8) Re-aplicar REVOKE ALL y GRANT EXECUTE sobre las 51 funciones de la whitelist
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind IN ('f', 'p')
      AND p.prorettype <> 'trigger'::regtype
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
  END LOOP;
END $$;

DO $$
DECLARE
  r record;
  -- Whitelist exacta de 51 funciones RPC / helpers RLS
  v_names text[] := ARRAY[
    'get_consolidated_roads_map','submit_trip_with_track','get_trip_detail_geojson',
    'submit_claim_with_photo','get_claim_detail','get_my_claims_list','update_claim',
    'mark_notifications_read','get_my_role','is_admin','is_operator','get_my_operator_id',
    'operator_has_access_to_intervention',
    'list_active_staff_catalogs','operator_list_my_tasks','operator_list_nearby_claims',
    'operator_submit_session','get_map_interventions_geojson',
    'upsert_claim_category','admin_upsert_work_type','admin_upsert_operator','admin_upsert_machine',
    'update_classification_thresholds','set_road_classification_mode','set_road_class',
    'review_trip','review_trips_batch','reprocess_all_roads','rename_road','merge_roads',
    'get_admin_users_list','get_admin_trips_list','get_admin_statistics','get_admin_roads_list',
    'get_admin_map_trips','get_admin_map_claims','get_admin_dashboard_summary',
    'get_admin_claims_list','generate_weekly_pending_summary','get_intervention_statistics',
    'admin_upsert_intervention','admin_review_interventions_batch','admin_review_intervention',
    'admin_list_interventions','admin_list_catalogs','admin_get_intervention_detail',
    'admin_compute_road_substring_geojson',
    'admin_get_segments_needing_elevation','admin_save_segment_elevation','get_admin_low_zones_map',
    'admin_recalculate_intervention_metrics'
  ];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY (v_names)
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
  END LOOP;
END $$;

-- 9) Auto-verificación en migración
DO $$
DECLARE
  n integer;
  r record;
BEGIN
  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.prokind = 'f'
    AND p.prorettype <> 'trigger'::regtype
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF n > 0 THEN
    RAISE EXCEPTION 'FALLO SEGURIDAD: % funciones propias ejecutables por anon', n;
  END IF;

  FOR r IN SELECT unnest(ARRAY[
    'consolidate_trip','unconsolidate_trip','recalculate_road_metrics','reclassify_all_roads',
    'recalculate_intervention_worked_metrics','extract_worked_tramo_utm','split_utm_line_on_uturns'
  ]) AS fname
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = r.fname
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) THEN
      RAISE EXCEPTION 'FALLO SEGURIDAD: % ejecutable por authenticated', r.fname;
    END IF;
  END LOOP;
END $$;
