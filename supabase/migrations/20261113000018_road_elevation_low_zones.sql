-- ============================================================================
-- Fase 16: Perfil Macro de Elevación (MDE 30m) y Zonas Bajas / Anegables
-- Cruza la traza horizontal de los tramos consolidados contra Copernicus DEM 30m
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.road_segment_elevations (
  segment_id uuid PRIMARY KEY REFERENCES public.road_segments(id) ON DELETE CASCADE,
  min_elevation_m double precision,
  max_elevation_m double precision,
  avg_elevation_m double precision,
  has_low_zone boolean NOT NULL DEFAULT false,
  profile_points jsonb NOT NULL DEFAULT '[]'::jsonb,
  low_zones_geojson jsonb,
  dem_source text NOT NULL DEFAULT 'copernicus-dem-30m',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_road_segment_elevations_low_zone
  ON public.road_segment_elevations (has_low_zone)
  WHERE has_low_zone = true;

ALTER TABLE public.road_segment_elevations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins pueden leer elevaciones" ON public.road_segment_elevations;
CREATE POLICY "Admins pueden leer elevaciones"
  ON public.road_segment_elevations
  FOR SELECT
  USING (public.is_admin());

-- 1. Obtener tramos consolidados pendientes de muestreo altimétrico
CREATE OR REPLACE FUNCTION public.admin_get_segments_needing_elevation(
  p_limit integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
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
            'lat', ST_Y(pt.geom),
            'lon', ST_X(pt.geom)
          )
          ORDER BY gs.idx
        )
        FROM (SELECT GREATEST(3, LEAST(60, CEIL(GREATEST(s.length_m, 50) / 45.0)::int)) AS n_steps) steps,
             generate_series(0, steps.n_steps) AS gs(idx),
             LATERAL (SELECT ST_LineInterpolatePoint(s.geom, gs.idx::double precision / steps.n_steps) AS geom) pt
      )
    ) AS seg_obj
    FROM public.road_segments s
    JOIN public.roads r ON r.id = s.road_id
    LEFT JOIN public.road_segment_elevations e ON e.segment_id = s.id
    WHERE e.segment_id IS NULL
      AND ST_NPoints(s.geom) >= 2
    ORDER BY s.length_m DESC
    LIMIT GREATEST(1, LEAST(p_limit, 100))
  ) sub;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_segments_needing_elevation(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_get_segments_needing_elevation(integer) TO authenticated;

-- 2. Guardar perfil altimétrico y geometría de zonas bajas de un tramo
CREATE OR REPLACE FUNCTION public.admin_save_segment_elevation(
  p_segment_id uuid,
  p_profile_points jsonb,
  p_low_zones_geojson jsonb,
  p_min_elev double precision,
  p_max_elev double precision,
  p_avg_elev double precision,
  p_has_low_zone boolean,
  p_dem_source text DEFAULT 'copernicus-dem-30m'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Acceso restringido a administradores';
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
    COALESCE(NULLIF(trim(p_dem_source), ''), 'copernicus-dem-30m'),
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
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.admin_save_segment_elevation(uuid, jsonb, jsonb, double precision, double precision, double precision, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_save_segment_elevation(uuid, jsonb, jsonb, double precision, double precision, double precision, boolean, text) TO authenticated;

-- 3. Consultar zonas bajas visibles en el mapa admin + cantidad de tramos sin analizar
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
