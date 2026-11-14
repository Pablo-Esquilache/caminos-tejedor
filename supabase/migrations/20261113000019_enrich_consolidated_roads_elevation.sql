-- ============================================================================
-- Fase 16b: Incluir resumen de Zona Baja / Cota MDE en get_consolidated_roads_map
-- y longitud de zona baja en get_admin_low_zones_map
-- ============================================================================

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
        'min_elevation_m', e.min_elevation_m,
        'max_elevation_m', e.max_elevation_m,
        'has_low_zone', COALESCE(e.has_low_zone, false),
        'low_zone_length_m', CASE
          WHEN e.has_low_zone = true AND e.low_zones_geojson IS NOT NULL THEN
            ROUND(ST_Length(ST_SetSRID(ST_GeomFromGeoJSON(e.low_zones_geojson::text), 4326)::geography)::numeric, 0)
          ELSE 0
        END,
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
  LEFT JOIN public.road_segment_elevations e ON e.segment_id = s.id
  WHERE s.geom && v_bbox
    AND ST_Intersects(s.geom, v_bbox);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_consolidated_roads_map(double precision, double precision, double precision, double precision, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_consolidated_roads_map(double precision, double precision, double precision, double precision, numeric) TO authenticated;

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
SET search_path = public
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
  WHERE e.segment_id IS NULL
    AND ST_NPoints(s.geom) >= 2;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
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
      )
    ),
    '[]'::jsonb
  )
  INTO v_items
  FROM public.road_segment_elevations e
  JOIN public.road_segments s ON s.id = e.segment_id
  JOIN public.roads r ON r.id = s.road_id
  WHERE e.has_low_zone = true
    AND e.low_zones_geojson IS NOT NULL
    AND s.geom && v_bbox
    AND ST_Intersects(s.geom, v_bbox);

  RETURN jsonb_build_object(
    'pending_count', v_pending_count,
    'items', v_items
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_low_zones_map(double precision, double precision, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_low_zones_map(double precision, double precision, double precision, double precision) TO authenticated;
