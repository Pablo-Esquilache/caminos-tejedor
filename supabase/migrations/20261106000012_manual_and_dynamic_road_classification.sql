-- =============================================================================
-- Migración 012: Clasificación Híbrida de Caminos (Manual por Admin + Automática por Percentiles)
-- =============================================================================

-- 1. Agregar is_manual_class a public.roads
ALTER TABLE public.roads
ADD COLUMN IF NOT EXISTS is_manual_class boolean NOT NULL DEFAULT false;

-- 2. Asegurar configuración del modo de clasificación en public.settings
INSERT INTO public.settings (key, value, description)
VALUES (
  'road_classification_mode',
  '{"mode": "manual_thresholds"}'::jsonb,
  'Modo de clasificación vial: manual_thresholds (umbrales numéricos fijos) o auto_percentiles (distribución dinámica por tránsito)'
)
ON CONFLICT (key) DO NOTHING;

-- 3. Actualizar función reclassify_all_roads respetando is_manual_class y el modo activo
CREATE OR REPLACE FUNCTION public.reclassify_all_roads()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mode text;
  v_cfg jsonb;
  v_troncal integer;
  v_principal integer;
  v_secundario integer;
  v_count integer;
BEGIN
  SELECT COALESCE(value->>'mode', 'manual_thresholds') INTO v_mode
  FROM public.settings
  WHERE key = 'road_classification_mode';

  IF v_mode = 'auto_percentiles' THEN
    -- Percentiles dinámicos calculados sobre los caminos que no están fijados a mano
    SELECT
      GREATEST(COALESCE(ROUND(percentile_cont(0.85) WITHIN GROUP (ORDER BY approved_trips_count))::int, 4), 3),
      GREATEST(COALESCE(ROUND(percentile_cont(0.60) WITHIN GROUP (ORDER BY approved_trips_count))::int, 3), 2),
      GREATEST(COALESCE(ROUND(percentile_cont(0.30) WITHIN GROUP (ORDER BY approved_trips_count))::int, 2), 1)
    INTO v_troncal, v_principal, v_secundario
    FROM public.roads
    WHERE is_manual_class = false;

    v_troncal := COALESCE(v_troncal, 4);
    v_principal := COALESCE(v_principal, 3);
    v_secundario := COALESCE(v_secundario, 2);
  ELSE
    SELECT value INTO v_cfg
    FROM public.settings
    WHERE key = 'road_classification_thresholds';

    v_troncal := COALESCE((v_cfg->>'troncal_min_trips')::integer, 25);
    v_principal := COALESCE((v_cfg->>'principal_min_trips')::integer, 10);
    v_secundario := COALESCE((v_cfg->>'secundario_min_trips')::integer, 3);
  END IF;

  -- Actualizar únicamente los caminos cuya clasificación no haya sido fijada a mano por el Admin
  UPDATE public.roads
  SET road_class = CASE
        WHEN approved_trips_count >= v_troncal THEN 'troncal'
        WHEN approved_trips_count >= v_principal THEN 'principal'
        WHEN approved_trips_count >= v_secundario THEN 'secundario'
        ELSE 'vecinal'
      END,
      updated_at = now()
  WHERE id IS NOT NULL
    AND is_manual_class = false;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 4. RPC set_road_class: permite al Admin fijar la categoría a mano o volver a modo automático
CREATE OR REPLACE FUNCTION public.set_road_class(
  p_road_id uuid,
  p_road_class text,
  p_is_manual boolean DEFAULT true
)
RETURNS public.roads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_road public.roads;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo un administrador puede modificar la jerarquía de un camino.';
  END IF;

  IF p_road_class NOT IN ('troncal', 'principal', 'secundario', 'vecinal') THEN
    RAISE EXCEPTION 'Jerarquía inválida: %', p_road_class;
  END IF;

  UPDATE public.roads
  SET road_class = p_road_class,
      is_manual_class = p_is_manual,
      updated_at = now()
  WHERE id = p_road_id
  RETURNING * INTO v_road;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Camino no encontrado.';
  END IF;

  -- Si se devolvió a modo automático, recalcular su clase según el modo activo
  IF NOT p_is_manual THEN
    PERFORM public.reclassify_all_roads();
    SELECT * INTO v_road FROM public.roads WHERE id = p_road_id;
  END IF;

  INSERT INTO public.audit_log (
    actor_id, action, table_name, record_id, old_data, new_data
  ) VALUES (
    auth.uid(),
    'set_road_class',
    'roads',
    p_road_id::text,
    NULL,
    jsonb_build_object('road_class', v_road.road_class, 'is_manual_class', v_road.is_manual_class)
  );

  RETURN v_road;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_road_class(uuid, text, boolean) TO authenticated;

-- 5. RPC set_road_classification_mode: activar/desactivar modo estándar o automático
CREATE OR REPLACE FUNCTION public.set_road_classification_mode(
  p_mode text
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
    RAISE EXCEPTION 'Permiso denegado: solo un administrador puede modificar el modo de clasificación.';
  END IF;

  IF p_mode NOT IN ('manual_thresholds', 'auto_percentiles') THEN
    RAISE EXCEPTION 'Modo inválido: % (debe ser manual_thresholds o auto_percentiles)', p_mode;
  END IF;

  v_new_val := jsonb_build_object('mode', p_mode);

  UPDATE public.settings
  SET value = v_new_val,
      updated_by = auth.uid(),
      updated_at = now()
  WHERE key = 'road_classification_mode';

  v_reclassified := public.reclassify_all_roads();

  INSERT INTO public.audit_log (
    actor_id, action, table_name, record_id, old_data, new_data
  ) VALUES (
    auth.uid(),
    'set_road_classification_mode',
    'settings',
    'road_classification_mode',
    NULL,
    v_new_val
  );

  RETURN jsonb_build_object(
    'mode', p_mode,
    'reclassified_count', v_reclassified
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_road_classification_mode(text) TO authenticated;

-- 6. Actualizar get_admin_roads_list para incluir is_manual_class y el modo activo
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
  v_mode jsonb;
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
      'is_manual_class', r.is_manual_class,
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

  SELECT jsonb_build_object(
    'p90_troncal', GREATEST(COALESCE( ROUND(percentile_cont(0.85) WITHIN GROUP (ORDER BY approved_trips_count))::int, 4), 3),
    'p70_principal', GREATEST(COALESCE( ROUND(percentile_cont(0.60) WITHIN GROUP (ORDER BY approved_trips_count))::int, 3), 2),
    'p40_secundario', GREATEST(COALESCE( ROUND(percentile_cont(0.30) WITHIN GROUP (ORDER BY approved_trips_count))::int, 2), 1)
  )
  INTO v_percentiles
  FROM public.roads;

  SELECT value INTO v_thresholds
  FROM public.settings
  WHERE key = 'road_classification_thresholds';

  SELECT value INTO v_mode
  FROM public.settings
  WHERE key = 'road_classification_mode';

  RETURN jsonb_build_object(
    'total', COALESCE(v_total, 0),
    'items', v_items,
    'proposed_percentiles', v_percentiles,
    'current_thresholds', v_thresholds,
    'classification_mode', COALESCE(v_mode->>'mode', 'manual_thresholds')
  );
END;
$$;

-- 7. Actualizar submit_trip_with_track para permitir definir jerarquía inicial si el autor es Admin
CREATE OR REPLACE FUNCTION public.submit_trip_with_track(
  p_trip_id uuid,
  p_original_name text,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_distance_m numeric,
  p_duration_s integer,
  p_raw_points jsonb,
  p_initial_road_class text DEFAULT NULL
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
  v_cons_res jsonb;
  v_created_road_id uuid;
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

    -- Si el administrador indicó una jerarquía inicial explícita, aplicarla al camino consolidado
    IF public.is_admin() AND p_initial_road_class IN ('troncal', 'principal', 'secundario', 'vecinal') THEN
      SELECT s.road_id INTO v_created_road_id
      FROM public.road_segments s
      WHERE s.created_by_trip_id = v_trip.id
      LIMIT 1;

      IF v_created_road_id IS NOT NULL THEN
        UPDATE public.roads
        SET road_class = p_initial_road_class,
            is_manual_class = true,
            updated_at = now()
        WHERE id = v_created_road_id;
      END IF;
    END IF;
  END IF;

  RETURN v_trip;
END;
$$;
