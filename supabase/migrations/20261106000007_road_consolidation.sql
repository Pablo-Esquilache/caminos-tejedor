-- =============================================================================
-- Migración 007: Consolidación Espacial de Caminos en PostGIS (Fase 4 + Fase 0)
-- Proyección métrica de trabajo: EPSG:32720 (UTM Zona 20 Sur - Carlos Tejedor)
-- Reglas:
-- - Nunca modifica trip_tracks (inmutable).
-- - Idempotente (UNIQUE(trip_id, segment_id)).
-- - Soporta caminos con curvas, cruces a 90° y separa caminos paralelos cercanos.
-- =============================================================================

-- 1. Función auxiliar: compara dirección local punto a punto entre dos líneas en UTM (EPSG:32720)
-- Soporta caminos con curvas comparando la tangente local en múltiples puntos muestreados
-- y acepta ambos sentidos de circulación (0° o 180°).
CREATE OR REPLACE FUNCTION public.lines_have_similar_direction(
  p_line_a_utm geometry,
  p_line_b_utm geometry,
  p_max_angle_deg double precision DEFAULT 30.0
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_samples integer := 5;
  v_i integer;
  v_frac_1 double precision;
  v_frac_2 double precision;
  v_pt_a1 geometry;
  v_pt_a2 geometry;
  v_loc_b1 double precision;
  v_loc_b2 double precision;
  v_pt_b1 geometry;
  v_pt_b2 geometry;
  v_az_a double precision;
  v_az_b double precision;
  v_diff double precision;
  v_collinear_diff double precision;
  v_valid_samples integer := 0;
  v_matching_samples integer := 0;
  v_geom_a geometry;
  v_geom_b geometry;
BEGIN
  -- Asegurar que trabajamos con LineString simples (si es MultiLineString tomamos la componente más larga)
  IF ST_GeometryType(p_line_a_utm) = 'ST_MultiLineString' THEN
    SELECT geom INTO v_geom_a
    FROM ST_Dump(p_line_a_utm)
    ORDER BY ST_Length(geom) DESC
    LIMIT 1;
  ELSE
    v_geom_a := p_line_a_utm;
  END IF;

  IF ST_GeometryType(p_line_b_utm) = 'ST_MultiLineString' THEN
    SELECT geom INTO v_geom_b
    FROM ST_Dump(p_line_b_utm)
    ORDER BY ST_Length(geom) DESC
    LIMIT 1;
  ELSE
    v_geom_b := p_line_b_utm;
  END IF;

  IF v_geom_a IS NULL OR v_geom_b IS NULL OR ST_Length(v_geom_a) < 5 OR ST_Length(v_geom_b) < 5 THEN
    RETURN false;
  END IF;

  FOR v_i IN 1..v_samples LOOP
    v_frac_1 := ((v_i - 1)::double precision / v_samples::double precision) + 0.02;
    v_frac_2 := (v_i::double precision / v_samples::double precision) - 0.02;

    v_pt_a1 := ST_LineInterpolatePoint(v_geom_a, GREATEST(0.0, LEAST(1.0, v_frac_1)));
    v_pt_a2 := ST_LineInterpolatePoint(v_geom_a, GREATEST(0.0, LEAST(1.0, v_frac_2)));

    IF NOT ST_Equals(v_pt_a1, v_pt_a2) THEN
      v_loc_b1 := ST_LineLocatePoint(v_geom_b, v_pt_a1);
      v_loc_b2 := ST_LineLocatePoint(v_geom_b, v_pt_a2);

      -- Si ambos puntos proyectan al mismo extremo en B, tomar una pequeña ventana en B
      IF ABS(v_loc_b2 - v_loc_b1) < 0.01 THEN
        v_loc_b1 := GREATEST(0.0, v_loc_b1 - 0.03);
        v_loc_b2 := LEAST(1.0, v_loc_b2 + 0.03);
      END IF;

      v_pt_b1 := ST_LineInterpolatePoint(v_geom_b, v_loc_b1);
      v_pt_b2 := ST_LineInterpolatePoint(v_geom_b, v_loc_b2);

      IF NOT ST_Equals(v_pt_b1, v_pt_b2) THEN
        v_az_a := degrees(ST_Azimuth(v_pt_a1, v_pt_a2));
        v_az_b := degrees(ST_Azimuth(v_pt_b1, v_pt_b2));

        v_diff := ABS(v_az_a - v_az_b);
        IF v_diff > 180.0 THEN
          v_diff := 360.0 - v_diff;
        END IF;

        -- Diferencia respecto a misma dirección (0°) o sentido opuesto (180°)
        v_collinear_diff := LEAST(v_diff, ABS(180.0 - v_diff));

        v_valid_samples := v_valid_samples + 1;
        IF v_collinear_diff <= p_max_angle_deg THEN
          v_matching_samples := v_matching_samples + 1;
        END IF;
      END IF;
    END IF;
  END LOOP;

  IF v_valid_samples = 0 THEN
    RETURN false;
  END IF;

  -- Al menos el 60% de las muestras del tramo compartido deben tener dirección compatible
  RETURN (v_matching_samples::double precision / v_valid_samples::double precision) >= 0.6;
END;
$$;

-- 2. Recalcular contadores exactos y longitud de un camino (o todos)
CREATE OR REPLACE FUNCTION public.recalculate_road_metrics(p_road_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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
  WHERE (p_road_id IS NULL OR r.id = p_road_id);
END;
$$;

-- 3. Reclasificar todos los caminos según los umbrales de settings
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
      updated_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 4. Algoritmo principal: consolidate_trip(p_trip_id)
CREATE OR REPLACE FUNCTION public.consolidate_trip(p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip public.trips;
  v_full_geom geometry;
  v_params jsonb;
  v_tolerance_m double precision;
  v_min_length_m double precision;
  v_max_angle_deg double precision;
  v_stop_radius_m double precision;
  v_geom_utm geometry;
  v_clean_utm geometry;
  v_seg record;
  v_seg_utm geometry;
  v_seg_buf_utm geometry;
  v_shared_utm geometry;
  v_shared_len double precision;
  v_matched_buffers_utm geometry := NULL;
  v_matched_segments_count integer := 0;
  v_new_segments_count integer := 0;
  v_diff_utm geometry;
  v_part geometry;
  v_part_len double precision;
  v_new_road_id uuid;
  v_new_seg_id uuid;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND OR v_trip.status <> 'approved' THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'not_approved');
  END IF;

  -- Regla 5 (Idempotencia): si el recorrido ya tiene utilizaciones registradas, no duplicar
  IF EXISTS (SELECT 1 FROM public.trip_segment_usage WHERE trip_id = p_trip_id) THEN
    RETURN jsonb_build_object('status', 'already_consolidated', 'trip_id', p_trip_id);
  END IF;

  SELECT full_geom INTO v_full_geom FROM public.trip_tracks WHERE trip_id = p_trip_id;
  IF v_full_geom IS NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_track');
  END IF;

  -- Leer parámetros desde settings
  SELECT value INTO v_params FROM public.settings WHERE key = 'consolidation_params';
  v_tolerance_m := COALESCE((v_params->>'buffer_tolerance_m')::double precision, 25.0);
  v_min_length_m := COALESCE((v_params->>'min_shared_length_m')::double precision, 80.0);
  v_max_angle_deg := COALESCE((v_params->>'max_angle_diff_deg')::double precision, 30.0);
  v_stop_radius_m := COALESCE((v_params->>'stop_cluster_radius_m')::double precision, 12.0);

  -- Transformar a metros (EPSG:32720 - UTM Zona 20 Sur) y colapsar paradas largas
  v_geom_utm := ST_Transform(v_full_geom, 32720);
  v_clean_utm := ST_RemoveRepeatedPoints(v_geom_utm, v_stop_radius_m);
  IF v_clean_utm IS NULL OR ST_NPoints(v_clean_utm) < 2 THEN
    v_clean_utm := v_geom_utm;
  END IF;

  -- Evaluar coincidencias contra tramos existentes (distancia <= tolerancia Y ángulo similar Y largo >= mínimo)
  FOR v_seg IN
    SELECT s.id, s.road_id, s.geom
    FROM public.road_segments s
    WHERE ST_DWithin(ST_Transform(s.geom, 32720), v_clean_utm, v_tolerance_m)
  LOOP
    v_seg_utm := ST_Transform(v_seg.geom, 32720);
    v_seg_buf_utm := ST_Buffer(v_seg_utm, v_tolerance_m);
    v_shared_utm := ST_Intersection(v_clean_utm, v_seg_buf_utm);
    v_shared_len := COALESCE(ST_Length(v_shared_utm), 0.0);

    IF v_shared_len >= v_min_length_m
       AND public.lines_have_similar_direction(v_shared_utm, v_seg_utm, v_max_angle_deg)
    THEN
      INSERT INTO public.trip_segment_usage (trip_id, segment_id, covered_meters)
      VALUES (p_trip_id, v_seg.id, ROUND(v_shared_len::numeric, 2))
      ON CONFLICT (trip_id, segment_id) DO NOTHING;

      -- Guardar alias del nombre original propuesto por el usuario en este camino
      IF NOT EXISTS (
        SELECT 1 FROM public.road_name_aliases
        WHERE road_id = v_seg.road_id AND trip_id = p_trip_id
      ) THEN
        INSERT INTO public.road_name_aliases (road_id, original_name, trip_id)
        VALUES (v_seg.road_id, v_trip.original_name, p_trip_id);
      END IF;

      IF v_matched_buffers_utm IS NULL THEN
        v_matched_buffers_utm := v_seg_buf_utm;
      ELSE
        v_matched_buffers_utm := ST_Union(v_matched_buffers_utm, v_seg_buf_utm);
      END IF;

      v_matched_segments_count := v_matched_segments_count + 1;
    END IF;
  END LOOP;

  -- Resolver los 3 casos:
  -- Caso 1: Camino totalmente nuevo (0 coincidencias)
  IF v_matched_segments_count = 0 THEN
    v_part_len := COALESCE(ST_Length(v_clean_utm), 0.0);
    IF v_part_len > 0 THEN
      INSERT INTO public.roads (normalized_name, road_class, total_length_m, approved_trips_count, unique_users_count)
      VALUES (v_trip.original_name, 'vecinal', ROUND(v_part_len::numeric, 2), 1, 1)
      RETURNING id INTO v_new_road_id;

      INSERT INTO public.road_segments (road_id, geom, length_m, created_by_trip_id)
      VALUES (
        v_new_road_id,
        ST_Transform(v_clean_utm, 4326),
        ROUND(v_part_len::numeric, 2),
        p_trip_id
      )
      RETURNING id INTO v_new_seg_id;

      INSERT INTO public.trip_segment_usage (trip_id, segment_id, covered_meters)
      VALUES (p_trip_id, v_new_seg_id, ROUND(v_part_len::numeric, 2))
      ON CONFLICT (trip_id, segment_id) DO NOTHING;

      INSERT INTO public.road_name_aliases (road_id, original_name, trip_id)
      VALUES (v_new_road_id, v_trip.original_name, p_trip_id);

      v_new_segments_count := 1;
    END IF;
  ELSE
    -- Caso 2 y 3: Camino existente o Recorrido mixto (extraer tramos nuevos >= v_min_length_m)
    v_diff_utm := ST_Difference(v_clean_utm, v_matched_buffers_utm);

    IF v_diff_utm IS NOT NULL AND NOT ST_IsEmpty(v_diff_utm) THEN
      FOR v_part IN
        SELECT (ST_Dump(ST_LineMerge(v_diff_utm))).geom
      LOOP
        IF ST_GeometryType(v_part) = 'ST_LineString' THEN
          v_part_len := COALESCE(ST_Length(v_part), 0.0);
          IF v_part_len >= v_min_length_m THEN
            INSERT INTO public.roads (normalized_name, road_class, total_length_m, approved_trips_count, unique_users_count)
            VALUES (v_trip.original_name, 'vecinal', ROUND(v_part_len::numeric, 2), 1, 1)
            RETURNING id INTO v_new_road_id;

            INSERT INTO public.road_segments (road_id, geom, length_m, created_by_trip_id)
            VALUES (
              v_new_road_id,
              ST_Transform(v_part, 4326),
              ROUND(v_part_len::numeric, 2),
              p_trip_id
            )
            RETURNING id INTO v_new_seg_id;

            INSERT INTO public.trip_segment_usage (trip_id, segment_id, covered_meters)
            VALUES (p_trip_id, v_new_seg_id, ROUND(v_part_len::numeric, 2))
            ON CONFLICT (trip_id, segment_id) DO NOTHING;

            INSERT INTO public.road_name_aliases (road_id, original_name, trip_id)
            VALUES (v_new_road_id, v_trip.original_name, p_trip_id);

            v_new_segments_count := v_new_segments_count + 1;
          END IF;
        END IF;
      END LOOP;
    END IF;
  END IF;

  PERFORM public.recalculate_road_metrics(NULL);
  PERFORM public.reclassify_all_roads();

  RETURN jsonb_build_object(
    'status', 'consolidated',
    'trip_id', p_trip_id,
    'matched_segments', v_matched_segments_count,
    'new_segments', v_new_segments_count
  );
END;
$$;

-- 5. Función unconsolidate_trip(p_trip_id): al revocar una aprobación quita usos y tramos exclusivos
CREATE OR REPLACE FUNCTION public.unconsolidate_trip(p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted_usages integer := 0;
  v_deleted_segments integer := 0;
  v_deleted_roads integer := 0;
BEGIN
  -- 1. Eliminar utilizaciones del recorrido
  DELETE FROM public.trip_segment_usage
  WHERE trip_id = p_trip_id;
  GET DIAGNOSTICS v_deleted_usages = ROW_COUNT;

  -- 2. Eliminar alias aportados por este recorrido
  DELETE FROM public.road_name_aliases
  WHERE trip_id = p_trip_id;

  -- 3. Eliminar segmentos creados solo por este recorrido y que ya no tengan ninguna utilización
  DELETE FROM public.road_segments s
  WHERE s.created_by_trip_id = p_trip_id
    AND NOT EXISTS (
      SELECT 1 FROM public.trip_segment_usage u WHERE u.segment_id = s.id
    );
  GET DIAGNOSTICS v_deleted_segments = ROW_COUNT;

  -- 4. Eliminar caminos que hayan quedado sin ningún segmento
  DELETE FROM public.roads r
  WHERE NOT EXISTS (
    SELECT 1 FROM public.road_segments s WHERE s.road_id = r.id
  );
  GET DIAGNOSTICS v_deleted_roads = ROW_COUNT;

  PERFORM public.recalculate_road_metrics(NULL);
  PERFORM public.reclassify_all_roads();

  INSERT INTO public.audit_log (
    actor_id, action, table_name, record_id, old_data, new_data
  ) VALUES (
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

-- 6. Actualizar submit_trip_with_track y review_trip para que llamen a consolidate_trip / unconsolidate_trip
CREATE OR REPLACE FUNCTION public.submit_trip_with_track(
  p_trip_id uuid,
  p_original_name text,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_distance_m numeric,
  p_duration_s integer,
  p_raw_points jsonb
)
RETURNS public.trips
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_geom geometry(LineString, 4326);
  v_trip public.trips;
  v_point_count integer;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado: debés iniciar sesión para guardar un recorrido.';
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF FOUND THEN
    IF v_trip.user_id <> v_user_id AND NOT public.is_admin() THEN
      RAISE EXCEPTION 'Conflicto de identificador de recorrido.';
    END IF;
    RETURN v_trip;
  END IF;

  v_point_count := jsonb_array_length(COALESCE(p_raw_points, '[]'::jsonb));
  IF v_point_count < 2 THEN
    RAISE EXCEPTION 'El recorrido debe tener al menos 2 puntos GPS válidos.';
  END IF;

  SELECT ST_SetSRID(
    ST_MakeLine(
      ARRAY(
        SELECT ST_MakePoint(
          (pt->>'lon')::double precision,
          (pt->>'lat')::double precision
        )
        FROM jsonb_array_elements(p_raw_points) WITH ORDINALITY AS t(pt, ord)
        ORDER BY ord
      )
    ),
    4326
  ) INTO v_geom;

  INSERT INTO public.trips (
    id, user_id, original_name, started_at, ended_at, distance_m, duration_s
  ) VALUES (
    p_trip_id,
    v_user_id,
    btrim(COALESCE(NULLIF(p_original_name, ''), 'Camino sin nombre')),
    p_started_at,
    p_ended_at,
    ROUND(COALESCE(p_distance_m, ST_Length(ST_Transform(v_geom, 32720)))::numeric, 2),
    GREATEST(COALESCE(p_duration_s, 0), 0)
  )
  RETURNING * INTO v_trip;

  INSERT INTO public.trip_tracks (trip_id, full_geom, raw_points)
  VALUES (p_trip_id, v_geom, p_raw_points);

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;

  -- Si entró ya aprobado (por ser de un Administrador), consolidar en el acto
  IF v_trip.status = 'approved' THEN
    PERFORM public.consolidate_trip(v_trip.id);
  END IF;

  RETURN v_trip;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_trip(
  p_trip_id uuid,
  p_new_status text,
  p_note text DEFAULT NULL
)
RETURNS public.trips
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_trip public.trips;
  v_new_trip public.trips;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo un administrador puede revisar recorridos.';
  END IF;

  IF p_new_status NOT IN ('pending', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'Estado inválido: %', p_new_status;
  END IF;

  SELECT * INTO v_old_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recorrido no encontrado: %', p_trip_id;
  END IF;

  UPDATE public.trips
  SET status = p_new_status,
      auto_approved = false,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_note = COALESCE(p_note, review_note),
      updated_at = now()
  WHERE id = p_trip_id
  RETURNING * INTO v_new_trip;

  INSERT INTO public.audit_log (
    actor_id, action, table_name, record_id, old_data, new_data
  ) VALUES (
    auth.uid(),
    'review_trip_' || p_new_status,
    'trips',
    p_trip_id::text,
    jsonb_build_object(
      'status', v_old_trip.status,
      'reviewed_by', v_old_trip.reviewed_by,
      'review_note', v_old_trip.review_note
    ),
    jsonb_build_object(
      'status', v_new_trip.status,
      'reviewed_by', v_new_trip.reviewed_by,
      'review_note', v_new_trip.review_note
    )
  );

  -- Si pasó a approved -> consolidar; si antes estaba approved y se revocó/rechazó -> desconsolidar
  IF p_new_status = 'approved' THEN
    PERFORM public.consolidate_trip(p_trip_id);
  ELSIF v_old_trip.status = 'approved' AND p_new_status <> 'approved' THEN
    PERFORM public.unconsolidate_trip(p_trip_id);
  END IF;

  RETURN v_new_trip;
END;
$$;

-- =============================================================================
-- Funciones Administrativas de Gestión de Caminos (Renombrar, Unificar, Reprocesar)
-- =============================================================================

-- 7. Renombrar el nombre normalizado de un camino (conserva los alias)
CREATE OR REPLACE FUNCTION public.rename_road(
  p_road_id uuid,
  p_new_name text
)
RETURNS public.roads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_name text;
  v_road public.roads;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo un administrador puede renombrar caminos.';
  END IF;

  IF p_new_name IS NULL OR btrim(p_new_name) = '' THEN
    RAISE EXCEPTION 'El nombre normalizado no puede estar vacío.';
  END IF;

  SELECT normalized_name INTO v_old_name FROM public.roads WHERE id = p_road_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Camino no encontrado.';
  END IF;

  UPDATE public.roads
  SET normalized_name = btrim(p_new_name),
      updated_at = now()
  WHERE id = p_road_id
  RETURNING * INTO v_road;

  INSERT INTO public.audit_log (
    actor_id, action, table_name, record_id, old_data, new_data
  ) VALUES (
    auth.uid(),
    'rename_road',
    'roads',
    p_road_id::text,
    jsonb_build_object('normalized_name', v_old_name),
    jsonb_build_object('normalized_name', v_road.normalized_name)
  );

  RETURN v_road;
END;
$$;

-- 8. Unificar dos o más caminos en uno solo (conserva todos los tramos y todos los alias originales)
CREATE OR REPLACE FUNCTION public.merge_roads(
  p_target_road_id uuid,
  p_source_road_ids uuid[],
  p_new_normalized_name text DEFAULT NULL
)
RETURNS public.roads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target public.roads;
  v_src_id uuid;
  v_old_names text[];
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo un administrador puede unificar caminos.';
  END IF;

  SELECT * INTO v_target FROM public.roads WHERE id = p_target_road_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Camino destino no encontrado.';
  END IF;

  SELECT array_agg(normalized_name) INTO v_old_names
  FROM public.roads
  WHERE id = ANY(p_source_road_ids) AND id <> p_target_road_id;

  FOREACH v_src_id IN ARRAY p_source_road_ids LOOP
    IF v_src_id <> p_target_road_id THEN
      -- Guardar el nombre anterior también como alias por si no figuraba
      INSERT INTO public.road_name_aliases (road_id, original_name)
      SELECT p_target_road_id, normalized_name
      FROM public.roads
      WHERE id = v_src_id;

      -- Mover todos los alias al camino destino
      UPDATE public.road_name_aliases
      SET road_id = p_target_road_id
      WHERE road_id = v_src_id;

      -- Mover todos los segmentos al camino destino
      UPDATE public.road_segments
      SET road_id = p_target_road_id
      WHERE road_id = v_src_id;

      -- Eliminar el registro de camino absorbido
      DELETE FROM public.roads WHERE id = v_src_id;
    END IF;
  END LOOP;

  IF p_new_normalized_name IS NOT NULL AND btrim(p_new_normalized_name) <> '' THEN
    UPDATE public.roads
    SET normalized_name = btrim(p_new_normalized_name),
        updated_at = now()
    WHERE id = p_target_road_id;
  END IF;

  PERFORM public.recalculate_road_metrics(p_target_road_id);
  PERFORM public.reclassify_all_roads();

  SELECT * INTO v_target FROM public.roads WHERE id = p_target_road_id;

  INSERT INTO public.audit_log (
    actor_id, action, table_name, record_id, old_data, new_data
  ) VALUES (
    auth.uid(),
    'merge_roads',
    'roads',
    p_target_road_id::text,
    jsonb_build_object('merged_road_ids', p_source_road_ids, 'merged_names', v_old_names),
    jsonb_build_object('normalized_name', v_target.normalized_name, 'total_length_m', v_target.total_length_m)
  );

  RETURN v_target;
END;
$$;

-- 9. Reprocesar toda la red desde cero a partir de los recorridos aprobados y trip_tracks originales
CREATE OR REPLACE FUNCTION public.reprocess_all_roads()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip_id uuid;
  v_processed integer := 0;
  v_roads_count integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo un administrador puede reprocesar la red.';
  END IF;

  -- Vaciar únicamente las tablas derivadas de consolidación (trip_tracks jamás se toca)
  DELETE FROM public.trip_segment_usage;
  DELETE FROM public.road_name_aliases;
  DELETE FROM public.road_segments;
  DELETE FROM public.roads;

  FOR v_trip_id IN
    SELECT id FROM public.trips WHERE status = 'approved' ORDER BY started_at ASC, created_at ASC
  LOOP
    PERFORM public.consolidate_trip(v_trip_id);
    v_processed := v_processed + 1;
  END LOOP;

  SELECT COUNT(*) INTO v_roads_count FROM public.roads;

  INSERT INTO public.audit_log (
    actor_id, action, table_name, record_id, old_data, new_data
  ) VALUES (
    auth.uid(),
    'reprocess_all_roads',
    'roads',
    'ALL',
    NULL,
    jsonb_build_object('trips_processed', v_processed, 'resulting_roads', v_roads_count)
  );

  RETURN jsonb_build_object(
    'trips_processed', v_processed,
    'resulting_roads', v_roads_count
  );
END;
$$;

-- 10. Consultas del Panel Admin y App Móvil para Caminos Consolidados
CREATE OR REPLACE FUNCTION public.get_admin_roads_list(
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total integer;
  v_items jsonb;
  v_percentiles jsonb;
  v_thresholds jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado';
  END IF;

  SELECT COUNT(*) INTO v_total FROM public.roads;

  SELECT COALESCE(jsonb_agg(row_data), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT jsonb_build_object(
      'id', r.id,
      'normalized_name', r.normalized_name,
      'road_class', r.road_class,
      'total_length_m', r.total_length_m,
      'approved_trips_count', r.approved_trips_count,
      'unique_users_count', r.unique_users_count,
      'updated_at', r.updated_at,
      'aliases', COALESCE(
        (
          SELECT jsonb_agg(DISTINCT a.original_name)
          FROM public.road_name_aliases a
          WHERE a.road_id = r.id
        ),
        '[]'::jsonb
      )
    ) AS row_data
    FROM public.roads r
    ORDER BY r.approved_trips_count DESC, r.total_length_m DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    OFFSET GREATEST(p_offset, 0)
  ) sub;

  -- Propuesta de umbrales por percentiles (P90 -> troncal, P70 -> principal, P40 -> secundario)
  SELECT jsonb_build_object(
    'p90_troncal', GREATEST(COALESCE( ROUND(percentile_cont(0.90) WITHIN GROUP (ORDER BY approved_trips_count))::int, 5), 3),
    'p70_principal', GREATEST(COALESCE( ROUND(percentile_cont(0.70) WITHIN GROUP (ORDER BY approved_trips_count))::int, 3), 2),
    'p40_secundario', GREATEST(COALESCE( ROUND(percentile_cont(0.40) WITHIN GROUP (ORDER BY approved_trips_count))::int, 2), 1)
  )
  INTO v_percentiles
  FROM public.roads;

  SELECT value INTO v_thresholds
  FROM public.settings
  WHERE key = 'road_classification_thresholds';

  RETURN jsonb_build_object(
    'total', COALESCE(v_total, 0),
    'items', v_items,
    'proposed_percentiles', v_percentiles,
    'current_thresholds', v_thresholds
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_classification_thresholds(
  p_troncal integer,
  p_principal integer,
  p_secundario integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_val jsonb;
  v_reclassified integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado';
  END IF;

  v_new_val := jsonb_build_object(
    'troncal_min_trips', GREATEST(p_troncal, 1),
    'principal_min_trips', GREATEST(p_principal, 1),
    'secundario_min_trips', GREATEST(p_secundario, 1)
  );

  UPDATE public.settings
  SET value = v_new_val,
      updated_by = auth.uid(),
      updated_at = now()
  WHERE key = 'road_classification_thresholds';

  v_reclassified := public.reclassify_all_roads();

  INSERT INTO public.audit_log (
    actor_id, action, table_name, record_id, old_data, new_data
  ) VALUES (
    auth.uid(),
    'update_classification_thresholds',
    'settings',
    'road_classification_thresholds',
    NULL,
    v_new_val
  );

  RETURN jsonb_build_object(
    'thresholds', v_new_val,
    'reclassified_roads', v_reclassified
  );
END;
$$;

-- 11. Función RPC para el Mapa de Caminos Consolidados (Tanto en Panel como en App Móvil)
-- Devuelve solo geometría simplificada, nombre normalizado, clase e intensidad de uso.
-- CERO identidades de usuarios (cumple Regla 10 de Privacidad).
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
SET search_path = public
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

  -- Simplificación dinámica según el nivel de zoom
  v_simplify_tol_m := CASE
    WHEN p_zoom >= 14 THEN 3.0
    WHEN p_zoom >= 12 THEN 8.0
    ELSE 18.0
  END;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'segment_id', s.id,
        'road_id', r.id,
        'normalized_name', r.normalized_name,
        'road_class', r.road_class,
        'total_length_m', r.total_length_m,
        'approved_trips_count', r.approved_trips_count,
        'geojson', ST_AsGeoJSON(
          ST_Transform(
            ST_SimplifyPreserveTopology(ST_Transform(s.geom, 32720), v_simplify_tol_m),
            4326
          )
        )::jsonb
      )
    ),
    '[]'::jsonb
  )
  INTO v_result
  FROM public.road_segments s
  JOIN public.roads r ON r.id = s.road_id
  WHERE s.geom && v_bbox
    AND ST_Intersects(s.geom, v_bbox);

  RETURN v_result;
END;
$$;
