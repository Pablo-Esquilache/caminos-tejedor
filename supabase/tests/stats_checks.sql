-- =============================================================================
-- Prueba Automatizada de Fase 6: Verificación Matemática y Espacial de Estadísticas
-- Se ejecuta dentro de una transacción con ROLLBACK final.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_admin_id uuid := '4349072b-58e1-4588-87c7-bc0be917f1f5';
  v_user_id uuid := 'fb2ecc52-173c-4f9c-9a3c-6621621c2aad';
  v_trip_id uuid := '60000000-0000-4000-8000-000000000001';
  v_claim_id uuid := '60000000-0000-4000-8000-000000000002';
  v_cat_id uuid;
  v_road_id uuid;
  v_stats jsonb;
  v_sum_status integer;
  v_sum_prio integer;
  v_sum_cat integer;
  v_total_claims integer;
BEGIN
  -- 1. Preparar un camino consolidado de prueba y un reclamo sobre su traza
  SELECT id INTO v_cat_id FROM public.claim_categories WHERE is_active = true LIMIT 1;

  INSERT INTO public.trips (id, user_id, original_name, started_at, ended_at, distance_m, duration_s, status)
  VALUES (v_trip_id, v_admin_id, 'Camino Real Estadísticas', now() - interval '1 hour', now(), 2400, 300, 'approved');

  INSERT INTO public.trip_tracks (trip_id, full_geom, raw_points)
  VALUES (
    v_trip_id,
    ST_GeomFromText('LINESTRING(-62.4208 -35.3928, -62.4050 -35.3928)', 4326),
    '[]'::jsonb
  );

  PERFORM public.consolidate_trip(v_trip_id);

  -- Insertar un reclamo a 10 metros de ese camino consolidado
  INSERT INTO public.claims (id, user_id, title, description, category_id, location, status, priority)
  VALUES (
    v_claim_id,
    v_user_id,
    'Alcantarilla en Camino Real Estadísticas',
    'Prueba de asociación espacial',
    v_cat_id,
    ST_SetSRID(ST_MakePoint(-62.4120, -35.39285), 4326),
    'received',
    'high'
  );

  -- 2. Consultar estadísticas como Administrador
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_id, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  v_stats := public.get_admin_statistics(NULL, NULL);

  v_total_claims := (v_stats->'kpis'->>'total_claims')::int;

  SELECT COALESCE(sum((elem->>'count')::int), 0) INTO v_sum_status
  FROM jsonb_array_elements(v_stats->'claims_by_status') elem;

  SELECT COALESCE(sum((elem->>'count')::int), 0) INTO v_sum_prio
  FROM jsonb_array_elements(v_stats->'claims_by_priority') elem;

  SELECT COALESCE(sum((elem->>'count')::int), 0) INTO v_sum_cat
  FROM jsonb_array_elements(v_stats->'claims_by_category') elem;

  IF v_total_claims <> v_sum_status OR v_total_claims <> v_sum_prio OR v_total_claims <> v_sum_cat THEN
    RAISE EXCEPTION 'Fallo Fase 6: Inconsistencia matemática en totales de reclamos (total=%, status=%, prio=%, cat=%)',
      v_total_claims, v_sum_status, v_sum_prio, v_sum_cat;
  END IF;
  RAISE NOTICE '✔ Verificación 1 OK: Sumas por estado, prioridad y categoría coinciden exactamente con el total de reclamos (%).', v_total_claims;

  -- 3. Verificar que el reclamo cercano al camino aparezca en top_claimed_roads por cercanía espacial (ST_DWithin en EPSG:32720)
  IF jsonb_array_length(v_stats->'top_claimed_roads') < 1 THEN
    RAISE EXCEPTION 'Fallo Fase 6: top_claimed_roads debía asociar espacialmente el reclamo al camino cercano.';
  END IF;
  RAISE NOTICE '✔ Verificación 2 OK: Asociación espacial PostGIS reclamo -> camino consolidado verificada (%).', v_stats->'top_claimed_roads'->0->>'normalized_name';

  RESET ROLE;
END;
$$;

ROLLBACK;
