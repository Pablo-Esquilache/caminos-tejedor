-- ============================================================================
-- Migración 020:
-- 1. Endurecimiento de permisos EXECUTE en funciones RPC y políticas RLS
-- 2. Reescritura segura de unconsolidate_trip con guarda is_admin() y lock
-- 3. Algoritmo de deduplicación de pasadas por tramos direccionales de 20m
--    con tolerancia a fallos geométricos (BEGIN ... EXCEPTION)
-- 4. Refinamiento MDE 90m (Copernicus GLO-90), invalidación por geom_hash y LIMIT
-- ============================================================================

-- 0) Privilegios por defecto: las funciones nuevas NO nacen ejecutables por PUBLIC/anon
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- 1) Helper de pertenencia de operario a intervención
CREATE OR REPLACE FUNCTION public.operator_has_access_to_intervention(p_intervention_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.intervention_operators io
    WHERE io.intervention_id = p_intervention_id
      AND io.operator_id = public.get_my_operator_id()
  );
$$;

-- 2) unconsolidate_trip: guarda de rol, bloqueo y alcance acotado
CREATE OR REPLACE FUNCTION public.unconsolidate_trip(p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted_usages integer := 0;
  v_deleted_segments integer := 0;
  v_deleted_roads integer := 0;
  v_road_ids uuid[];
  v_rid uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('road_network', 0));

  SELECT COALESCE(array_agg(DISTINCT s.road_id) FILTER (WHERE s.road_id IS NOT NULL), ARRAY[]::uuid[])
  INTO v_road_ids
  FROM public.road_segments s
  WHERE s.created_by_trip_id = p_trip_id
     OR s.id IN (SELECT u.segment_id FROM public.trip_segment_usage u WHERE u.trip_id = p_trip_id);

  DELETE FROM public.trip_segment_usage WHERE trip_id = p_trip_id;
  GET DIAGNOSTICS v_deleted_usages = ROW_COUNT;

  DELETE FROM public.road_name_aliases WHERE trip_id = p_trip_id;

  DELETE FROM public.road_segments s
  WHERE s.created_by_trip_id = p_trip_id
    AND NOT EXISTS (SELECT 1 FROM public.trip_segment_usage u WHERE u.segment_id = s.id);
  GET DIAGNOSTICS v_deleted_segments = ROW_COUNT;

  DELETE FROM public.roads r
  WHERE r.id = ANY(v_road_ids)
    AND NOT EXISTS (SELECT 1 FROM public.road_segments s WHERE s.road_id = r.id);
  GET DIAGNOSTICS v_deleted_roads = ROW_COUNT;

  FOREACH v_rid IN ARRAY v_road_ids LOOP
    IF EXISTS (SELECT 1 FROM public.roads WHERE id = v_rid) THEN
      PERFORM public.recalculate_road_metrics(v_rid);
    END IF;
  END LOOP;

  PERFORM public.reclassify_all_roads();

  INSERT INTO public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
  VALUES (
    auth.uid(),
    'unconsolidate_trip',
    'trips',
    p_trip_id::text,
    NULL,
    jsonb_build_object(
      'deleted_usages', v_deleted_usages,
      'deleted_segments', v_deleted_segments,
      'deleted_roads', v_deleted_roads
    )
  );

  RETURN jsonb_build_object(
    'status', 'unconsolidated',
    'deleted_usages', v_deleted_usages,
    'deleted_segments', v_deleted_segments,
    'deleted_roads', v_deleted_roads
  );
END;
$$;

-- 3) Algoritmo de deduplicación de pasadas por tramos direccionales de 20m
CREATE OR REPLACE FUNCTION public.extract_worked_tramo_utm(
  p_raw_geoms_4326 geometry[],
  p_stop_radius_m double precision DEFAULT 12.0,
  p_pass_buffer_m double precision DEFAULT 15.0,
  p_uturn_angle_deg double precision DEFAULT 125.0,
  p_min_segment_m double precision DEFAULT 25.0
)
RETURNS geometry
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  c_chunk_m    constant double precision := 20.0;
  c_simplify_m constant double precision := 3.0;
  c_par        constant double precision := radians(30.0);
  c_gap        constant integer := 12; -- 12 tramos = 240 m
  v_result geometry;
BEGIN
  IF p_raw_geoms_4326 IS NULL OR array_length(p_raw_geoms_4326, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    DROP TABLE IF EXISTS pg_temp.wt_chunks;
    CREATE TEMP TABLE wt_chunks (
      id   serial PRIMARY KEY,
      sess integer NOT NULL,
      n    integer NOT NULL,
      geom geometry(LineString, 32720) NOT NULL,
      az   double precision NOT NULL,
      dup  boolean NOT NULL DEFAULT false
    ) ON COMMIT DROP;

    -- 1) Trazas -> UTM -> limpias -> tramos de 20 m, numerados por sesión
    INSERT INTO wt_chunks (sess, n, geom, az)
    SELECT
      t.sess,
      row_number() OVER (PARTITION BY t.sess ORDER BY t.part_path, t.k)::int,
      t.geom,
      ST_Azimuth(ST_StartPoint(t.geom), ST_EndPoint(t.geom))
    FROM (
      SELECT
        s.ord::int AS sess,
        d.path AS part_path,
        k.k,
        ST_LineSubstring(
          d.geom,
          LEAST(1.0, (k.k * c_chunk_m) / ST_Length(d.geom)),
          LEAST(1.0, ((k.k + 1) * c_chunk_m) / ST_Length(d.geom))
        ) AS geom
      FROM unnest(p_raw_geoms_4326) WITH ORDINALITY AS s(g, ord)
      CROSS JOIN LATERAL (
        SELECT (ST_Dump(
          ST_CollectionExtract(
            ST_MakeValid(
              ST_SimplifyPreserveTopology(
                ST_RemoveRepeatedPoints(ST_Transform(s.g, 32720), p_stop_radius_m),
                c_simplify_m
              )
            ),
            2
          )
        )).*
      ) AS d
      CROSS JOIN LATERAL generate_series(
        0,
        GREATEST(ceil(ST_Length(d.geom) / c_chunk_m)::int, 1) - 1
      ) AS k(k)
      WHERE s.g IS NOT NULL AND NOT ST_IsEmpty(s.g) AND ST_Length(d.geom) > 0
    ) t
    WHERE GeometryType(t.geom) = 'LINESTRING'
      AND ST_Length(t.geom) > 0.5
      AND ST_Azimuth(ST_StartPoint(t.geom), ST_EndPoint(t.geom)) IS NOT NULL;

    CREATE INDEX wt_chunks_geom_gix ON wt_chunks USING gist (geom);
    ANALYZE wt_chunks;

    -- 2) Marcar tramos repetidos (paralelos y cercanos a uno anterior del orden)
    UPDATE wt_chunks a
    SET dup = true
    WHERE EXISTS (
      SELECT 1
      FROM wt_chunks b
      CROSS JOIN LATERAL (
        SELECT LEAST(abs(a.az - b.az), 2 * pi() - abs(a.az - b.az)) AS d
      ) x
      WHERE b.id < a.id
        AND ST_DWithin(a.geom, b.geom, p_pass_buffer_m)
        AND (x.d <= c_par OR x.d >= pi() - c_par)
        AND (
          b.sess <> a.sess
          OR x.d >= pi() - c_par
          OR (a.n - b.n) > c_gap
        )
    );

    -- 3) Geometría neta; fragmentos aislados cortos fuera
    SELECT ST_LineMerge(ST_Collect(geom)) INTO v_result
    FROM wt_chunks WHERE NOT dup;

    IF v_result IS NULL OR ST_IsEmpty(v_result) THEN
      RETURN NULL;
    END IF;

    SELECT ST_Collect(dd.geom) INTO v_result
    FROM ST_Dump(v_result) dd
    WHERE ST_Length(dd.geom) >= p_min_segment_m;

    RETURN v_result;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'extract_worked_tramo_utm falló (%): %. Se usa respaldo.', SQLSTATE, SQLERRM;
    PERFORM set_config('app.worked_degraded', '1', true);
    BEGIN
      SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Transform(g, 32720)), 2))
      INTO v_result
      FROM unnest(p_raw_geoms_4326) AS g
      WHERE g IS NOT NULL AND NOT ST_IsEmpty(g)
      ORDER BY ST_Length(ST_Transform(g, 32720)) DESC
      LIMIT 1;
      RETURN v_result;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END;
  END;
END;
$$;

UPDATE public.settings
SET value = jsonb_set(value, '{pass_dedup_buffer_m}', '15'::jsonb)
WHERE key = 'intervention_gps_params';

-- 4) recalculate_intervention_worked_metrics con bloque EXCEPTION
CREATE OR REPLACE FUNCTION public.recalculate_intervention_worked_metrics(p_intervention_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_int public.interventions;
  v_params jsonb;
  v_geoms geometry[];
  v_worked_utm geometry;
  v_worked_4326 geometry := NULL;
  v_worked_len numeric(12, 2) := 0;
  v_total_gps numeric(12, 2) := 0;
  v_total_dur integer := 0;
  v_sess_cnt integer := 0;
  v_min_start timestamptz;
  v_failed boolean := false;
  v_degraded boolean := false;
BEGIN
  SELECT * INTO v_int FROM public.interventions WHERE id = p_intervention_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT
    COUNT(*)::int,
    COALESCE(SUM(CASE WHEN raw_geom IS NOT NULL AND GeometryType(raw_geom) LIKE '%LINESTRING'
                      THEN ST_Length(ST_Transform(raw_geom, 32720)) ELSE 0 END), 0)::numeric,
    COALESCE(SUM(duration_s), 0),
    MIN(started_at),
    ARRAY_AGG(raw_geom ORDER BY started_at ASC) FILTER (WHERE raw_geom IS NOT NULL)
  INTO v_sess_cnt, v_total_gps, v_total_dur, v_min_start, v_geoms
  FROM public.intervention_sessions
  WHERE intervention_id = p_intervention_id;

  IF v_int.execution_mode = 'punctual' THEN
    IF v_geoms IS NOT NULL AND array_length(v_geoms, 1) > 0 THEN
      v_worked_4326 := ST_Centroid(v_geoms[array_length(v_geoms, 1)]);
    END IF;
    v_worked_len := 0;
  ELSE
    SELECT value INTO v_params FROM public.settings WHERE key = 'intervention_gps_params';
    BEGIN
      PERFORM set_config('app.worked_degraded', '0', true);
      v_worked_utm := public.extract_worked_tramo_utm(
        v_geoms,
        COALESCE((v_params->>'stop_cluster_radius_m')::double precision, 12.0),
        COALESCE((v_params->>'pass_dedup_buffer_m')::double precision, 15.0),
        COALESCE((v_params->>'uturn_split_angle_deg')::double precision, 125.0),
        COALESCE((v_params->>'min_pass_segment_m')::double precision, 25.0)
      );
      v_degraded := COALESCE(current_setting('app.worked_degraded', true), '0') = '1';
    EXCEPTION WHEN OTHERS THEN
      v_failed := true;
      v_worked_utm := NULL;
      RAISE WARNING 'recalculate_intervention_worked_metrics % falló (%): %', p_intervention_id, SQLSTATE, SQLERRM;
    END;

    IF v_worked_utm IS NOT NULL AND NOT ST_IsEmpty(v_worked_utm) THEN
      v_worked_4326 := ST_Transform(v_worked_utm, 4326);
      v_worked_len := ROUND(ST_Length(v_worked_utm)::numeric, 2);
    END IF;
  END IF;

  UPDATE public.interventions
  SET
    worked_geom = COALESCE(v_worked_4326, worked_geom),
    worked_length_m = CASE
      WHEN v_int.execution_mode <> 'linear' THEN 0
      WHEN v_worked_4326 IS NULL THEN worked_length_m
      ELSE v_worked_len END,
    total_gps_distance_m = ROUND(v_total_gps, 2),
    duration_s = v_total_dur,
    sessions_count = v_sess_cnt,
    started_at = COALESCE(started_at, v_min_start),
    updated_at = now()
  WHERE id = p_intervention_id;

  IF v_failed OR v_degraded THEN
    INSERT INTO public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
    VALUES (
      auth.uid(),
      CASE WHEN v_failed THEN 'worked_metrics_failed' ELSE 'worked_metrics_degraded' END,
      'interventions',
      p_intervention_id::text,
      NULL,
      jsonb_build_object('sessions', v_sess_cnt)
    );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_recalculate_intervention_metrics(p_intervention_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.' USING ERRCODE = '42501';
  END IF;
  PERFORM public.recalculate_intervention_worked_metrics(p_intervention_id);
END;
$$;

-- Reprocesar las intervenciones lineales existentes con el nuevo algoritmo
DO $$
DECLARE
  v_id uuid;
BEGIN
  FOR v_id IN SELECT id FROM public.interventions WHERE execution_mode = 'linear' LOOP
    PERFORM public.recalculate_intervention_worked_metrics(v_id);
  END LOOP;
END $$;

-- 5) RLS: cada operario ve solo lo suyo o lo de sus intervenciones asignadas
DROP POLICY IF EXISTS int_sessions_select_staff ON public.intervention_sessions;
DROP POLICY IF EXISTS int_sessions_select_own_or_assigned ON public.intervention_sessions;
CREATE POLICY int_sessions_select_own_or_assigned ON public.intervention_sessions
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR (
      public.is_operator()
      AND (
        operator_id = public.get_my_operator_id()
        OR user_id = auth.uid()
        OR public.operator_has_access_to_intervention(intervention_id)
      )
    )
  );

DROP POLICY IF EXISTS int_photos_select_staff ON public.intervention_photos;
DROP POLICY IF EXISTS int_photos_select_assigned ON public.intervention_photos;
CREATE POLICY int_photos_select_assigned ON public.intervention_photos
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR (
      public.is_operator()
      AND (
        uploaded_by = auth.uid()
        OR public.operator_has_access_to_intervention(intervention_id)
      )
    )
  );

DROP POLICY IF EXISTS int_history_select_staff ON public.intervention_history;
DROP POLICY IF EXISTS int_history_select_assigned ON public.intervention_history;
CREATE POLICY int_history_select_assigned ON public.intervention_history
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR (
      public.is_operator()
      AND public.operator_has_access_to_intervention(intervention_id)
    )
  );

DROP POLICY IF EXISTS int_operators_select_staff ON public.intervention_operators;
DROP POLICY IF EXISTS int_operators_select_assigned ON public.intervention_operators;
CREATE POLICY int_operators_select_assigned ON public.intervention_operators
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR (
      public.is_operator()
      AND (
        operator_id = public.get_my_operator_id()
        OR public.operator_has_access_to_intervention(intervention_id)
      )
    )
  );

DROP POLICY IF EXISTS interventions_select_by_role ON public.interventions;
CREATE POLICY interventions_select_by_role ON public.interventions
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_operator());

DROP POLICY IF EXISTS storage_intervention_photos_select ON storage.objects;
CREATE POLICY storage_intervention_photos_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'claim-photos'
    AND (
      public.is_admin()
      OR (storage.foldername(name))[1] = auth.uid()::text
      OR (
        public.is_operator()
        AND EXISTS (
          SELECT 1 FROM public.intervention_photos ip
          WHERE (ip.storage_path = name OR ip.thumb_path = name)
            AND public.operator_has_access_to_intervention(ip.intervention_id)
        )
      )
    )
  );

-- 6) Refinamientos MDE 90m (Copernicus GLO-90), geom_hash y LIMIT
ALTER TABLE public.road_segment_elevations
  ADD COLUMN IF NOT EXISTS geom_hash text;

ALTER TABLE public.road_segment_elevations
  ALTER COLUMN dem_source SET DEFAULT 'copernicus-dem-90m';

UPDATE public.road_segment_elevations e
SET geom_hash = md5(ST_AsEWKB(s.geom))
FROM public.road_segments s
WHERE s.id = e.segment_id
  AND e.geom_hash IS NULL;

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
            GREATEST(2, LEAST(40, CEIL(GREATEST(s.length_m, 90) / 90.0)::int)) AS n_steps
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

CREATE OR REPLACE FUNCTION public.admin_save_segment_elevation(
  p_segment_id uuid,
  p_profile_points jsonb,
  p_low_zones_geojson jsonb,
  p_min_elev double precision,
  p_max_elev double precision,
  p_avg_elev double precision,
  p_has_low_zone boolean,
  p_dem_source text DEFAULT 'copernicus-dem-90m'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_geom_hash text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Acceso restringido a administradores';
  END IF;

  IF p_min_elev < -50 OR p_max_elev > 500 OR p_min_elev > p_max_elev THEN
    RAISE EXCEPTION 'Valores de elevación fuera de rango válido para la llanura pampeana';
  END IF;

  SELECT md5(ST_AsEWKB(s.geom))
  INTO v_geom_hash
  FROM public.road_segments s
  WHERE s.id = p_segment_id;

  IF v_geom_hash IS NULL THEN
    RAISE EXCEPTION 'El segmento % no existe', p_segment_id;
  END IF;

  INSERT INTO public.road_segment_elevations (
    segment_id,
    min_elevation_m,
    max_elevation_m,
    avg_elevation_m,
    has_low_zone,
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
    COALESCE(p_profile_points, '[]'::jsonb),
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
    profile_points = EXCLUDED.profile_points,
    low_zones_geojson = EXCLUDED.low_zones_geojson,
    dem_source = EXCLUDED.dem_source,
    geom_hash = EXCLUDED.geom_hash,
    updated_at = now();
END;
$$;

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
      'low_zone_length_m', CASE
        WHEN e.has_low_zone = true AND e.low_zones_geojson IS NOT NULL THEN
          ROUND(ST_Length(ST_SetSRID(ST_GeomFromGeoJSON(e.low_zones_geojson::text), 4326)::geography)::numeric, 0)
        ELSE 0
      END,
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
    'items', v_items
  );
END;
$$;

-- 7) Cerrar EXECUTE en TODAS las funciones propias del esquema public (salvo extensiones y triggers)
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

-- 8) Conceder EXECUTE únicamente a las 45 funciones que el cliente / RLS invoca
DO $$
DECLARE
  r record;
  v_names text[] := ARRAY[
    -- vecinos / sesión / helpers RLS
    'get_consolidated_roads_map','submit_trip_with_track','get_trip_detail_geojson',
    'submit_claim_with_photo','get_claim_detail','get_my_claims_list','update_claim',
    'mark_notifications_read','get_my_role','is_admin','is_operator','get_my_operator_id',
    'operator_has_access_to_intervention',
    -- operarios
    'list_active_staff_catalogs','operator_list_my_tasks','operator_list_nearby_claims',
    'operator_submit_session','get_map_interventions_geojson',
    -- administración
    'upsert_claim_category','admin_upsert_work_type','admin_upsert_operator','admin_upsert_machine',
    'update_classification_thresholds','set_road_classification_mode','set_road_class',
    'review_trip','review_trips_batch','reprocess_all_roads','rename_road','merge_roads',
    'get_admin_users_list','get_admin_trips_list','get_admin_statistics','get_admin_roads_list',
    'get_admin_map_trips','get_admin_map_claims','get_admin_dashboard_summary',
    'get_admin_claims_list','generate_weekly_pending_summary','get_intervention_statistics',
    'admin_upsert_intervention','admin_review_interventions_batch','admin_review_intervention',
    'admin_list_interventions','admin_list_catalogs','admin_get_intervention_detail',
    'admin_compute_road_substring_geojson',
    -- Fase 16 + reproceso de métricas
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

-- 9) Auto-verificación en migración: permisos EXECUTE + 5 pruebas geométricas (A..E)
DO $$
DECLARE
  n integer;
  r record;
  b geometry := ST_Transform(ST_SetSRID(ST_MakePoint(-62.43, -35.39), 4326), 32720);
  v_bx double precision := ST_X(b);
  v_by double precision := ST_Y(b);
  g geometry;
  len double precision;
BEGIN
  -- 1) Ninguna función no-trigger propia ejecutable por anon
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

  -- 2) Las funciones internas no son ejecutables por authenticated
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

  -- Prueba A: Ida y vuelta con giro en U cerrado (radio ~5 m), 1000 m -> esperado ~1000 m
  g := public.extract_worked_tramo_utm(ARRAY[
    ST_Transform(ST_Translate(ST_GeomFromText(
      'LINESTRING(0 0, 500 0, 1000 0, 1004 4, 1000 8, 500 8, 0 8)', 32720), v_bx, v_by), 4326)
  ]);
  len := COALESCE(ST_Length(g), 0);
  IF len NOT BETWEEN 950 AND 1080 THEN
    RAISE EXCEPTION 'Prueba A falló: esperado ~1000 m, dio %', len;
  END IF;

  -- Prueba B: Empalme en T con dos sesiones: 1000 m + 700 m = ~1700 m
  g := public.extract_worked_tramo_utm(ARRAY[
    ST_Transform(ST_Translate(ST_GeomFromText('LINESTRING(0 0, 1000 0)', 32720), v_bx, v_by), 4326),
    ST_Transform(ST_Translate(ST_GeomFromText('LINESTRING(500 0, 500 700)', 32720), v_bx, v_by), 4326)
  ]);
  len := COALESCE(ST_Length(g), 0);
  IF len NOT BETWEEN 1650 AND 1760 THEN
    RAISE EXCEPTION 'Prueba B falló: esperado ~1700 m, dio %', len;
  END IF;

  -- Prueba C: Segunda jornada sobre el mismo tramo, mismo sentido, 5 m desplazada: no suma
  g := public.extract_worked_tramo_utm(ARRAY[
    ST_Transform(ST_Translate(ST_GeomFromText('LINESTRING(0 0, 1000 0)', 32720), v_bx, v_by), 4326),
    ST_Transform(ST_Translate(ST_GeomFromText('LINESTRING(0 5, 1000 5)', 32720), v_bx, v_by), 4326)
  ]);
  len := COALESCE(ST_Length(g), 0);
  IF len NOT BETWEEN 950 AND 1060 THEN
    RAISE EXCEPTION 'Prueba C falló: esperado ~1000 m, dio %', len;
  END IF;

  -- Prueba D: Dos caminos paralelos a 40 m (más que el buffer de 15 m): se cuentan ambos (~2000 m)
  g := public.extract_worked_tramo_utm(ARRAY[
    ST_Transform(ST_Translate(ST_GeomFromText('LINESTRING(0 0, 1000 0)', 32720), v_bx, v_by), 4326),
    ST_Transform(ST_Translate(ST_GeomFromText('LINESTRING(0 40, 1000 40)', 32720), v_bx, v_by), 4326)
  ]);
  len := COALESCE(ST_Length(g), 0);
  IF len NOT BETWEEN 1950 AND 2060 THEN
    RAISE EXCEPTION 'Prueba D falló: esperado ~2000 m, dio %', len;
  END IF;

  -- Prueba E: Entradas degeneradas: nulas, vacías o de longitud cero no lanzan excepción
  PERFORM public.extract_worked_tramo_utm(ARRAY[NULL::geometry, 'LINESTRING EMPTY'::geometry]);
  PERFORM public.extract_worked_tramo_utm(ARRAY[ST_SetSRID(ST_GeomFromText('LINESTRING(-62.43 -35.39, -62.43 -35.39)'), 4326)]);
END $$;
