-- =============================================================================
-- Migración 005: Funciones RPC atómicas para la App Móvil (Fase 2)
-- 1. submit_trip_with_track: Guarda cabecera + traza completa en 1 sola transacción
--    idempotente (ideal para señales rurales inestables) y calcula simplified_geom.
-- 2. get_trip_detail_geojson: Devuelve el detalle del recorrido y su traza
--    simplificada ya convertida a GeoJSON para dibujar directo en MapLibre.
-- =============================================================================

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

  -- Si el recorrido ya fue enviado antes (reintento offline), devolver el existente (idempotencia)
  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id;

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

  -- Construir LineString EPSG:4326 ordenado a partir del JSON de puntos
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

  -- Insertar cabecera en trips (el trigger trg_enforce_trip_insert_rules asigna status pending o approved si es admin)
  INSERT INTO public.trips (
    id,
    user_id,
    original_name,
    started_at,
    ended_at,
    distance_m,
    duration_s
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

  -- Insertar traza completa inmutable (dispara trg_sync_trip_simplified_geom)
  INSERT INTO public.trip_tracks (
    trip_id,
    full_geom,
    raw_points
  ) VALUES (
    p_trip_id,
    v_geom,
    p_raw_points
  );

  -- Recargar el registro actualizado con simplified_geom
  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id;

  RETURN v_trip;
END;
$$;

-- Función para obtener el detalle de un recorrido con su geometría simplificada en GeoJSON
CREATE OR REPLACE FUNCTION public.get_trip_detail_geojson(
  p_trip_id uuid,
  p_include_full_track boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip public.trips;
  v_profile public.profiles;
  v_reviewer public.profiles;
  v_full_geojson jsonb := NULL;
  v_raw_points jsonb := NULL;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recorrido no encontrado';
  END IF;

  -- Verificar permiso: dueño del recorrido o administrador
  IF v_trip.user_id <> auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado para ver este recorrido';
  END IF;

  IF p_include_full_track THEN
    SELECT
      ST_AsGeoJSON(tt.full_geom)::jsonb,
      tt.raw_points
    INTO v_full_geojson, v_raw_points
    FROM public.trip_tracks tt
    WHERE tt.trip_id = p_trip_id;
  END IF;

  -- Solo si es admin incluimos los datos secundarios del usuario y revisor
  IF public.is_admin() THEN
    SELECT * INTO v_profile FROM public.profiles WHERE id = v_trip.user_id;
    IF v_trip.reviewed_by IS NOT NULL THEN
      SELECT * INTO v_reviewer FROM public.profiles WHERE id = v_trip.reviewed_by;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'id', v_trip.id,
    'user_id', v_trip.user_id,
    'original_name', v_trip.original_name,
    'started_at', v_trip.started_at,
    'ended_at', v_trip.ended_at,
    'distance_m', v_trip.distance_m,
    'duration_s', v_trip.duration_s,
    'status', v_trip.status,
    'auto_approved', v_trip.auto_approved,
    'reviewed_by', v_trip.reviewed_by,
    'reviewed_at', v_trip.reviewed_at,
    'review_note', CASE WHEN public.is_admin() THEN v_trip.review_note ELSE NULL END,
    'created_at', v_trip.created_at,
    'simplified_geojson', CASE
      WHEN v_trip.simplified_geom IS NOT NULL THEN ST_AsGeoJSON(v_trip.simplified_geom)::jsonb
      ELSE NULL
    END,
    'full_geojson', v_full_geojson,
    'raw_points', v_raw_points,
    'user_info', CASE
      WHEN public.is_admin() THEN jsonb_build_object(
        'full_name', v_profile.full_name,
        'email', v_profile.email
      )
      ELSE NULL
    END,
    'reviewer_info', CASE
      WHEN public.is_admin() AND v_reviewer.id IS NOT NULL THEN jsonb_build_object(
        'full_name', v_reviewer.full_name,
        'email', v_reviewer.email
      )
      ELSE NULL
    END
  );
END;
$$;
