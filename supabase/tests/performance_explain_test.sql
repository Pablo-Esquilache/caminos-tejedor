-- =============================================================================
-- Prueba Automatizada de Fase 7: Auditoría de Índices Espaciales GIST y Rendimiento
-- Verifica la existencia de los índices GIST/B-Tree y mide tiempos con EXPLAIN ANALYZE
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_gist_count integer;
  v_explain_roads jsonb;
  v_explain_claims jsonb;
  v_exec_time_ms numeric;
BEGIN
  -- 1. Verificar que los 4 índices espaciales GIST obligatorios existan en el catálogo
  SELECT count(*)::int INTO v_gist_count
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN (
      'idx_trips_simplified_geom',
      'idx_trip_tracks_full_geom',
      'idx_road_segments_geom',
      'idx_claims_location'
    );

  IF v_gist_count < 4 THEN
    RAISE EXCEPTION 'Fallo Fase 7: Faltan índices espaciales GIST obligatorios (encontrados % de 4).', v_gist_count;
  END IF;
  RAISE NOTICE '✔ Auditoría de Índices OK: Los 4 índices espaciales GIST (trips, trip_tracks, road_segments, claims) están activos.';

  -- 2. Ejecutar EXPLAIN (ANALYZE, FORMAT JSON) sobre consulta de ventana visible (Bounding Box) de caminos consolidados
  EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON)
    SELECT rs.id, r.normalized_name
    FROM public.road_segments rs
    JOIN public.roads r ON r.id = rs.road_id
    WHERE rs.geom && ST_MakeEnvelope(-62.65, -35.60, -62.20, -35.20, 4326)
    LIMIT 200'
  INTO v_explain_roads;

  v_exec_time_ms := COALESCE((v_explain_roads->0->>'Execution Time')::numeric, 0);
  IF v_exec_time_ms > 250 THEN
    RAISE EXCEPTION 'Fallo Fase 7: Consulta espacial de road_segments demoró demasiado (% ms).', v_exec_time_ms;
  END IF;
  RAISE NOTICE '✔ EXPLAIN ANALYZE (Mapa Caminos Consolidados BBox): % ms.', round(v_exec_time_ms, 2);

  -- 3. Ejecutar EXPLAIN (ANALYZE, FORMAT JSON) sobre consulta espacial de reclamos y asociación a caminos
  EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON)
    SELECT c.id, c.title, c.status
    FROM public.claims c
    WHERE c.location && ST_MakeEnvelope(-62.65, -35.60, -62.20, -35.20, 4326)
      AND c.status IN (''received'', ''evaluating'', ''in_progress'')
    ORDER BY c.created_at DESC
    LIMIT 100'
  INTO v_explain_claims;

  v_exec_time_ms := COALESCE((v_explain_claims->0->>'Execution Time')::numeric, 0);
  IF v_exec_time_ms > 250 THEN
    RAISE EXCEPTION 'Fallo Fase 7: Consulta espacial de claims demoró demasiado (% ms).', v_exec_time_ms;
  END IF;
  RAISE NOTICE '✔ EXPLAIN ANALYZE (Mapa Reclamos BBox + Estado): % ms.', round(v_exec_time_ms, 2);
END;
$$;

ROLLBACK;
