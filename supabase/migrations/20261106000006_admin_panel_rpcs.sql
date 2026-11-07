-- =============================================================================
-- Migración 006: Funciones RPC para el Panel de Administración (Fase 3)
-- Incluye:
-- 1. get_admin_dashboard_summary: Indicadores de portada (pendientes, aprobados, km).
-- 2. get_admin_map_trips: Carga espacial por Bounding Box con geometría simplificada.
-- 3. get_admin_trips_list: Bandeja paginada con filtros de estado y fecha (sin trazas).
-- 4. review_trips_batch: Aprobación en lote con auditoría individual en audit_log.
-- 5. get_admin_users_list: Listado paginado de usuarios con conteo de aportes.
-- =============================================================================

-- 1. Indicadores de portada del Panel Admin
CREATE OR REPLACE FUNCTION public.get_admin_dashboard_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pending integer;
  v_approved integer;
  v_rejected integer;
  v_approved_km numeric(12, 2);
  v_users integer;
  v_claims integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: acceso exclusivo para administradores.';
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE status = 'pending'),
    COUNT(*) FILTER (WHERE status = 'approved'),
    COUNT(*) FILTER (WHERE status = 'rejected'),
    ROUND(COALESCE(SUM(distance_m) FILTER (WHERE status = 'approved'), 0) / 1000.0, 2)
  INTO v_pending, v_approved, v_rejected, v_approved_km
  FROM public.trips;

  SELECT COUNT(*) INTO v_users FROM public.profiles;
  SELECT COUNT(*) INTO v_claims FROM public.claims;

  RETURN jsonb_build_object(
    'pending_trips_count', COALESCE(v_pending, 0),
    'approved_trips_count', COALESCE(v_approved, 0),
    'rejected_trips_count', COALESCE(v_rejected, 0),
    'approved_km', COALESCE(v_approved_km, 0),
    'total_users_count', COALESCE(v_users, 0),
    'total_claims_count', COALESCE(v_claims, 0)
  );
END;
$$;

-- 2. Carga de recorridos para el Mapa General filtrando por Bounding Box visible
CREATE OR REPLACE FUNCTION public.get_admin_map_trips(
  p_min_lon double precision,
  p_min_lat double precision,
  p_max_lon double precision,
  p_max_lat double precision,
  p_statuses text[] DEFAULT ARRAY['approved']
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bbox geometry;
  v_result jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: acceso exclusivo para administradores.';
  END IF;

  v_bbox := ST_MakeEnvelope(p_min_lon, p_min_lat, p_max_lon, p_max_lat, 4326);

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', t.id,
        'original_name', t.original_name,
        'status', t.status,
        'distance_m', t.distance_m,
        'duration_s', t.duration_s,
        'started_at', t.started_at,
        'auto_approved', t.auto_approved,
        'geojson', ST_AsGeoJSON(t.simplified_geom)::jsonb
      )
    ),
    '[]'::jsonb
  )
  INTO v_result
  FROM public.trips t
  WHERE t.simplified_geom IS NOT NULL
    AND t.status = ANY(p_statuses)
    AND t.simplified_geom && v_bbox
    AND ST_Intersects(t.simplified_geom, v_bbox);

  RETURN v_result;
END;
$$;

-- 3. Listado paginado de la Bandeja de Validación de Recorridos (25 por página, sin geometrías)
CREATE OR REPLACE FUNCTION public.get_admin_trips_list(
  p_status text DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
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
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: acceso exclusivo para administradores.';
  END IF;

  SELECT COUNT(*)
  INTO v_total
  FROM public.trips t
  WHERE (p_status IS NULL OR p_status = 'all' OR t.status = p_status)
    AND (p_date_from IS NULL OR t.started_at >= p_date_from)
    AND (p_date_to IS NULL OR t.started_at <= p_date_to);

  SELECT COALESCE(
    jsonb_agg(row_data),
    '[]'::jsonb
  )
  INTO v_items
  FROM (
    SELECT jsonb_build_object(
      'id', t.id,
      'original_name', t.original_name,
      'started_at', t.started_at,
      'ended_at', t.ended_at,
      'distance_m', t.distance_m,
      'duration_s', t.duration_s,
      'status', t.status,
      'auto_approved', t.auto_approved,
      'reviewed_at', t.reviewed_at,
      'review_note', t.review_note,
      'created_at', t.created_at,
      'user_name', COALESCE(p.full_name, split_part(p.email, '@', 1)),
      'user_email', p.email,
      'reviewer_name', COALESCE(r.full_name, split_part(r.email, '@', 1)),
      'reviewer_email', r.email
    ) AS row_data
    FROM public.trips t
    LEFT JOIN public.profiles p ON p.id = t.user_id
    LEFT JOIN public.profiles r ON r.id = t.reviewed_by
    WHERE (p_status IS NULL OR p_status = 'all' OR t.status = p_status)
      AND (p_date_from IS NULL OR t.started_at >= p_date_from)
      AND (p_date_to IS NULL OR t.started_at <= p_date_to)
    ORDER BY t.created_at DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    OFFSET GREATEST(p_offset, 0)
  ) sub;

  RETURN jsonb_build_object(
    'total', COALESCE(v_total, 0),
    'items', v_items
  );
END;
$$;

-- 4. Aprobación en lote con auditoría individual en audit_log
CREATE OR REPLACE FUNCTION public.review_trips_batch(
  p_trip_ids uuid[],
  p_new_status text,
  p_note text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_count integer := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo un administrador puede aprobar en lote.';
  END IF;

  IF p_trip_ids IS NULL OR array_length(p_trip_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  FOREACH v_id IN ARRAY p_trip_ids LOOP
    PERFORM public.review_trip(v_id, p_new_status, p_note);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- 5. Listado paginado de usuarios con cantidad de recorridos y reclamos
CREATE OR REPLACE FUNCTION public.get_admin_users_list(
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
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: acceso exclusivo para administradores.';
  END IF;

  SELECT COUNT(*) INTO v_total FROM public.profiles;

  SELECT COALESCE(
    jsonb_agg(row_data),
    '[]'::jsonb
  )
  INTO v_items
  FROM (
    SELECT jsonb_build_object(
      'id', p.id,
      'full_name', p.full_name,
      'email', p.email,
      'created_at', p.created_at,
      'is_admin', (a.user_id IS NOT NULL),
      'trips_count', (SELECT COUNT(*) FROM public.trips t WHERE t.user_id = p.id),
      'approved_trips_count', (SELECT COUNT(*) FROM public.trips t WHERE t.user_id = p.id AND t.status = 'approved'),
      'claims_count', (SELECT COUNT(*) FROM public.claims c WHERE c.user_id = p.id)
    ) AS row_data
    FROM public.profiles p
    LEFT JOIN public.admins a ON a.user_id = p.id
    ORDER BY p.created_at DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    OFFSET GREATEST(p_offset, 0)
  ) sub;

  RETURN jsonb_build_object(
    'total', COALESCE(v_total, 0),
    'items', v_items
  );
END;
$$;
