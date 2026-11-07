-- =============================================================================
-- Migración 009: Fase 6 - Estadísticas e Indicadores Municipales con PostGIS
-- =============================================================================

-- 1. Parámetro configurable en settings para asociar espacialmente un reclamo al camino más cercano
INSERT INTO public.settings (key, value, description)
VALUES (
  'claim_road_match_distance_m',
  '60'::jsonb,
  'Distancia máxima en metros (UTM 20S EPSG:32720) para asociar un reclamo georreferenciado a un camino consolidado en las estadísticas.'
)
ON CONFLICT (key) DO NOTHING;

-- 2. RPC get_admin_statistics: Devuelve todos los indicadores y rankings filtrables por período
CREATE OR REPLACE FUNCTION public.get_admin_statistics(
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match_dist_m double precision := 60.0;
  v_setting_val jsonb;
  v_kpis jsonb;
  v_top_used_roads jsonb;
  v_roads_by_class jsonb;
  v_claims_by_status jsonb;
  v_claims_by_category jsonb;
  v_claims_by_priority jsonb;
  v_claims_monthly jsonb;
  v_top_claimed_roads jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores pueden consultar estadísticas.';
  END IF;

  SELECT value INTO v_setting_val
  FROM public.settings
  WHERE key = 'claim_road_match_distance_m';

  IF v_setting_val IS NOT NULL THEN
    v_match_dist_m := COALESCE((v_setting_val#>>'{}')::double precision, 60.0);
  END IF;

  -- A. Indicadores Generales (KPIs del período y red)
  WITH trip_stats AS (
    SELECT
      count(*) FILTER (WHERE status = 'approved')::int AS approved_trips,
      count(*) FILTER (WHERE status = 'pending')::int AS pending_trips,
      count(*) FILTER (WHERE status = 'rejected')::int AS rejected_trips,
      count(*)::int AS total_trips
    FROM public.trips t
    WHERE (p_date_from IS NULL OR t.created_at >= p_date_from)
      AND (p_date_to IS NULL OR t.created_at <= p_date_to)
  ),
  road_totals AS (
    SELECT
      count(*)::int AS total_roads,
      COALESCE(round((sum(total_length_m) / 1000.0)::numeric, 2), 0) AS total_consolidated_km
    FROM public.roads
  ),
  claim_stats AS (
    SELECT
      count(*)::int AS total_claims,
      count(*) FILTER (WHERE status = 'solved')::int AS solved_claims,
      count(*) FILTER (WHERE status IN ('received', 'evaluating', 'in_progress'))::int AS open_claims,
      count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed_claims
    FROM public.claims c
    WHERE (p_date_from IS NULL OR c.created_at >= p_date_from)
      AND (p_date_to IS NULL OR c.created_at <= p_date_to)
  ),
  active_users AS (
    SELECT count(DISTINCT uid)::int AS active_users_count
    FROM (
      SELECT t.user_id AS uid
      FROM public.trips t
      WHERE (p_date_from IS NULL OR t.created_at >= p_date_from)
        AND (p_date_to IS NULL OR t.created_at <= p_date_to)
      UNION
      SELECT c.user_id AS uid
      FROM public.claims c
      WHERE (p_date_from IS NULL OR c.created_at >= p_date_from)
        AND (p_date_to IS NULL OR c.created_at <= p_date_to)
    ) u
  )
  SELECT jsonb_build_object(
    'total_roads', rt.total_roads,
    'total_consolidated_km', rt.total_consolidated_km,
    'total_trips', ts.total_trips,
    'approved_trips', ts.approved_trips,
    'pending_trips', ts.pending_trips,
    'rejected_trips', ts.rejected_trips,
    'active_users_count', au.active_users_count,
    'total_claims', cs.total_claims,
    'solved_claims', cs.solved_claims,
    'open_claims', cs.open_claims,
    'dismissed_claims', cs.dismissed_claims,
    'resolution_rate_pct', CASE
      WHEN cs.total_claims > 0 THEN round((cs.solved_claims::numeric * 100.0) / cs.total_claims, 1)
      ELSE 0
    END,
    'claim_road_match_distance_m', v_match_dist_m
  )
  INTO v_kpis
  FROM trip_stats ts, road_totals rt, claim_stats cs, active_users au;

  -- B. Top 10 caminos más utilizados (filtrando recorridos aprobados en el período si se especifican fechas)
  SELECT COALESCE(
    jsonb_agg(row_to_json(q)),
    '[]'::jsonb
  )
  INTO v_top_used_roads
  FROM (
    SELECT
      r.id,
      r.normalized_name,
      r.road_class,
      round((r.total_length_m / 1000.0)::numeric, 2) AS length_km,
      count(DISTINCT t.id)::int AS period_approved_trips,
      count(DISTINCT t.user_id)::int AS period_unique_users
    FROM public.roads r
    LEFT JOIN public.road_segments rs ON rs.road_id = r.id
    LEFT JOIN public.trip_segment_usage tsu ON tsu.segment_id = rs.id
    LEFT JOIN public.trips t ON t.id = tsu.trip_id
      AND t.status = 'approved'
      AND (p_date_from IS NULL OR t.created_at >= p_date_from)
      AND (p_date_to IS NULL OR t.created_at <= p_date_to)
    GROUP BY r.id, r.normalized_name, r.road_class, r.total_length_m
    ORDER BY count(DISTINCT t.id) DESC, r.total_length_m DESC
    LIMIT 10
  ) q;

  -- C. Distribución de caminos por jerarquía (Troncal, Principal, Secundario, Vecinal)
  SELECT COALESCE(
    jsonb_agg(row_to_json(q)),
    '[]'::jsonb
  )
  INTO v_roads_by_class
  FROM (
    SELECT
      cls.road_class,
      count(r.id)::int AS roads_count,
      COALESCE(round((sum(r.total_length_m) / 1000.0)::numeric, 2), 0) AS total_km
    FROM (
      VALUES ('troncal', 1), ('principal', 2), ('secundario', 3), ('vecinal', 4)
    ) AS cls(road_class, ord)
    LEFT JOIN public.roads r ON r.road_class = cls.road_class
    GROUP BY cls.road_class, cls.ord
    ORDER BY cls.ord ASC
  ) q;

  -- D. Reclamos por Estado
  SELECT COALESCE(
    jsonb_agg(row_to_json(q)),
    '[]'::jsonb
  )
  INTO v_claims_by_status
  FROM (
    SELECT
      st.status,
      count(c.id)::int AS count
    FROM (
      VALUES ('received', 1), ('evaluating', 2), ('in_progress', 3), ('solved', 4), ('dismissed', 5)
    ) AS st(status, ord)
    LEFT JOIN public.claims c ON c.status = st.status
      AND (p_date_from IS NULL OR c.created_at >= p_date_from)
      AND (p_date_to IS NULL OR c.created_at <= p_date_to)
    GROUP BY st.status, st.ord
    ORDER BY st.ord ASC
  ) q;

  -- E. Reclamos por Categoría
  SELECT COALESCE(
    jsonb_agg(row_to_json(q)),
    '[]'::jsonb
  )
  INTO v_claims_by_category
  FROM (
    SELECT
      cat.id AS category_id,
      cat.name AS category_name,
      cat.is_active,
      count(c.id)::int AS count
    FROM public.claim_categories cat
    LEFT JOIN public.claims c ON c.category_id = cat.id
      AND (p_date_from IS NULL OR c.created_at >= p_date_from)
      AND (p_date_to IS NULL OR c.created_at <= p_date_to)
    GROUP BY cat.id, cat.name, cat.is_active, cat.sort_order
    ORDER BY count(c.id) DESC, cat.sort_order ASC
  ) q;

  -- F. Reclamos por Prioridad
  SELECT COALESCE(
    jsonb_agg(row_to_json(q)),
    '[]'::jsonb
  )
  INTO v_claims_by_priority
  FROM (
    SELECT
      pr.priority,
      count(c.id)::int AS count
    FROM (
      VALUES ('high', 1), ('medium', 2), ('low', 3)
    ) AS pr(priority, ord)
    LEFT JOIN public.claims c ON c.priority = pr.priority
      AND (p_date_from IS NULL OR c.created_at >= p_date_from)
      AND (p_date_to IS NULL OR c.created_at <= p_date_to)
    GROUP BY pr.priority, pr.ord
    ORDER BY pr.ord ASC
  ) q;

  -- G. Evolución mensual de reclamos (creados vs solucionados)
  SELECT COALESCE(
    jsonb_agg(row_to_json(q)),
    '[]'::jsonb
  )
  INTO v_claims_monthly
  FROM (
    SELECT
      to_char(date_trunc('month', c.created_at), 'YYYY-MM') AS month,
      count(*)::int AS total_created,
      count(*) FILTER (WHERE c.status = 'solved')::int AS solved_count
    FROM public.claims c
    WHERE (p_date_from IS NULL OR c.created_at >= p_date_from)
      AND (p_date_to IS NULL OR c.created_at <= p_date_to)
    GROUP BY date_trunc('month', c.created_at)
    ORDER BY date_trunc('month', c.created_at) ASC
    LIMIT 12
  ) q;

  -- H. Top 10 caminos con mayor concentración de reclamos (Asociación espacial en PostGIS EPSG:32720)
  SELECT COALESCE(
    jsonb_agg(row_to_json(q)),
    '[]'::jsonb
  )
  INTO v_top_claimed_roads
  FROM (
    WITH claim_nearest_road AS (
      SELECT DISTINCT ON (c.id)
        c.id AS claim_id,
        c.status AS claim_status,
        rs.road_id
      FROM public.claims c
      JOIN public.road_segments rs
        ON ST_DWithin(
          ST_Transform(c.location, 32720),
          ST_Transform(rs.geom, 32720),
          v_match_dist_m
        )
      WHERE (p_date_from IS NULL OR c.created_at >= p_date_from)
        AND (p_date_to IS NULL OR c.created_at <= p_date_to)
      ORDER BY
        c.id,
        ST_Distance(ST_Transform(c.location, 32720), ST_Transform(rs.geom, 32720)) ASC
    )
    SELECT
      r.id,
      r.normalized_name,
      r.road_class,
      round((r.total_length_m / 1000.0)::numeric, 2) AS length_km,
      count(cnr.claim_id)::int AS claims_count,
      count(cnr.claim_id) FILTER (WHERE cnr.claim_status IN ('received', 'evaluating', 'in_progress'))::int AS open_claims_count,
      count(cnr.claim_id) FILTER (WHERE cnr.claim_status = 'solved')::int AS solved_claims_count
    FROM public.roads r
    JOIN claim_nearest_road cnr ON cnr.road_id = r.id
    GROUP BY r.id, r.normalized_name, r.road_class, r.total_length_m
    ORDER BY count(cnr.claim_id) DESC, r.total_length_m DESC
    LIMIT 10
  ) q;

  RETURN jsonb_build_object(
    'kpis', v_kpis,
    'top_used_roads', v_top_used_roads,
    'roads_by_class', v_roads_by_class,
    'claims_by_status', v_claims_by_status,
    'claims_by_category', v_claims_by_category,
    'claims_by_priority', v_claims_by_priority,
    'claims_monthly', v_claims_monthly,
    'top_claimed_roads', v_top_claimed_roads
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_statistics(timestamptz, timestamptz) TO authenticated;
