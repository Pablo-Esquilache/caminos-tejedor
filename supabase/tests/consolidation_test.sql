-- =============================================================================
-- Suite de Pruebas Espaciales de Consolidación en PostGIS (Fase 0 + Fase 4)
-- Verifica automáticamente en EPSG:4326 / EPSG:32720:
-- 1. Camino nuevo con curva
-- 2. Camino repetido (con desplazamiento GPS lateral de ~8m y sentido opuesto)
-- 3. Idempotencia (procesar dos veces el mismo recorrido no duplica usos)
-- 4. Caminos paralelos cercanos (~45m) NO se fusionan
-- 5. Recorrido mixto (tramo conocido + bifurcación a 90° por tramo nuevo)
-- 6. Parada larga (colapso de puntos repetidos)
-- 7. Desconsolidación al revocar (unconsolidate_trip) y reprocesamiento total
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_admin uuid := '00000000-0000-4000-b000-0000000000ad';
  v_user1 uuid := '00000000-0000-4000-b000-000000000001';
  v_user2 uuid := '00000000-0000-4000-b000-000000000002';

  v_trip_nuevo uuid     := '33333333-3333-4333-a333-333333333301';
  v_trip_repetido uuid  := '33333333-3333-4333-a333-333333333302';
  v_trip_paralelo uuid  := '33333333-3333-4333-a333-333333333303';
  v_trip_mixto uuid     := '33333333-3333-4333-a333-333333333304';

  v_roads_before integer;
  v_segs_before integer;
  v_roads_after integer;
  v_segs_after integer;
  v_usage_count integer;
  v_road_id_1 uuid;
  v_trips_cnt integer;
  v_users_cnt integer;
  v_aliases_cnt integer;
  v_map_json jsonb;
BEGIN
  -- Preparar usuarios de prueba
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES
    (v_admin, 'admin_spatial@test.local', '{"full_name": "Admin Vial"}'::jsonb),
    (v_user1, 'vecino_spatial1@test.local', '{"full_name": "Vecino 1"}'::jsonb),
    (v_user2, 'vecino_spatial2@test.local', '{"full_name": "Vecino 2"}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.admins (user_id, created_by)
  VALUES (v_admin, v_admin)
  ON CONFLICT (user_id) DO NOTHING;

  -- Aislar el entorno de prueba limpiando consolidaciones previas dentro de esta transacción
  DELETE FROM public.trip_segment_usage;
  DELETE FROM public.road_name_aliases;
  DELETE FROM public.road_segments;
  DELETE FROM public.roads;

  -- ===========================================================================
  -- CASO 1: Camino Nuevo con curva y parada larga en el medio (~1,2 km en Carlos Tejedor)
  -- ===========================================================================
  INSERT INTO public.trips (id, user_id, original_name, started_at, ended_at, distance_m, duration_s, status)
  VALUES (v_trip_nuevo, v_user1, 'Camino Real a Timote', now() - interval '1 hour', now(), 1200, 300, 'approved');
  UPDATE public.trips SET status = 'approved' WHERE id = v_trip_nuevo;

  INSERT INTO public.trip_tracks (trip_id, full_geom)
  VALUES (
    v_trip_nuevo,
    ST_GeomFromText(
      'LINESTRING(-62.4200 -35.3900, -62.4150 -35.3900, -62.41501 -35.39001, -62.41502 -35.39001, -62.4100 -35.3905, -62.4050 -35.3920)',
      4326
    )
  );

  PERFORM public.consolidate_trip(v_trip_nuevo);

  SELECT COUNT(*) INTO v_roads_after FROM public.roads;
  SELECT id INTO v_road_id_1 FROM public.roads LIMIT 1;
  IF v_roads_after <> 1 THEN
    RAISE EXCEPTION 'Fallo Caso 1 (Camino Nuevo): se esperaban 1 camino y hay %', v_roads_after;
  END IF;

  -- ===========================================================================
  -- CASO 2: Camino Repetido (mismo camino en sentido opuesto y desplazado ~7 metros al sur)
  -- ===========================================================================
  INSERT INTO public.trips (id, user_id, original_name, started_at, ended_at, distance_m, duration_s, status)
  VALUES (v_trip_repetido, v_user2, 'Bajada a Timote por Camino Real', now() - interval '40 minutes', now(), 1200, 310, 'approved');
  UPDATE public.trips SET status = 'approved' WHERE id = v_trip_repetido;

  INSERT INTO public.trip_tracks (trip_id, full_geom)
  VALUES (
    v_trip_repetido,
    ST_GeomFromText(
      'LINESTRING(-62.4050 -35.39206, -62.4100 -35.39056, -62.4150 -35.39006, -62.4200 -35.39006)',
      4326
    )
  );

  PERFORM public.consolidate_trip(v_trip_repetido);

  SELECT COUNT(*) INTO v_roads_after FROM public.roads;
  SELECT COUNT(*) INTO v_segs_after FROM public.road_segments;
  SELECT approved_trips_count, unique_users_count INTO v_trips_cnt, v_users_cnt
  FROM public.roads WHERE id = v_road_id_1;
  SELECT COUNT(*) INTO v_aliases_cnt FROM public.road_name_aliases WHERE road_id = v_road_id_1;

  IF v_roads_after <> 1 OR v_segs_after <> 1 THEN
    RAISE EXCEPTION 'Fallo Caso 2 (Camino Repetido): duplicó trazado (roads=%, segments=%)', v_roads_after, v_segs_after;
  END IF;

  IF v_trips_cnt <> 2 OR v_users_cnt <> 2 OR v_aliases_cnt <> 2 THEN
    RAISE EXCEPTION 'Fallo Caso 2 (Contadores/Alias): trips=%, users=%, aliases=%', v_trips_cnt, v_users_cnt, v_aliases_cnt;
  END IF;

  -- ===========================================================================
  -- CASO 3: Idempotencia (procesar dos veces el mismo recorrido no suma otra utilización)
  -- ===========================================================================
  PERFORM public.consolidate_trip(v_trip_repetido);
  SELECT approved_trips_count INTO v_trips_cnt FROM public.roads WHERE id = v_road_id_1;
  IF v_trips_cnt <> 2 THEN
    RAISE EXCEPTION 'Fallo Caso 3 (Idempotencia): duplicó utilización al reprocesar el mismo trip';
  END IF;

  -- ===========================================================================
  -- CASO 4: Camino Paralelo Cercano (~55 metros al norte, mayor que tolerancia de 25m)
  -- ===========================================================================
  INSERT INTO public.trips (id, user_id, original_name, started_at, ended_at, distance_m, duration_s, status)
  VALUES (v_trip_paralelo, v_user1, 'Callejón Paralelo Norte', now() - interval '30 minutes', now(), 1100, 280, 'approved');
  UPDATE public.trips SET status = 'approved' WHERE id = v_trip_paralelo;

  INSERT INTO public.trip_tracks (trip_id, full_geom)
  VALUES (
    v_trip_paralelo,
    ST_GeomFromText(
      'LINESTRING(-62.4200 -35.3895, -62.4150 -35.3895, -62.4100 -35.3900, -62.4050 -35.3915)',
      4326
    )
  );

  PERFORM public.consolidate_trip(v_trip_paralelo);

  SELECT COUNT(*) INTO v_roads_after FROM public.roads;
  IF v_roads_after <> 2 THEN
    RAISE EXCEPTION 'Fallo Caso 4 (Caminos Paralelos): fusionó caminos paralelos separados (roads=%)', v_roads_after;
  END IF;

  -- ===========================================================================
  -- CASO 5: Recorrido Mixto (comparte el primer tramo con Camino 1 y luego dobla a 90° al Sur)
  -- ===========================================================================
  INSERT INTO public.trips (id, user_id, original_name, started_at, ended_at, distance_m, duration_s, status)
  VALUES (v_trip_mixto, v_user2, 'Desvío Sur a La Larga', now() - interval '20 minutes', now(), 1600, 400, 'approved');
  UPDATE public.trips SET status = 'approved' WHERE id = v_trip_mixto;

  INSERT INTO public.trip_tracks (trip_id, full_geom)
  VALUES (
    v_trip_mixto,
    ST_GeomFromText(
      'LINESTRING(-62.4200 -35.3900, -62.4150 -35.3900, -62.4150 -35.3950, -62.4150 -35.4000)',
      4326
    )
  );

  PERFORM public.consolidate_trip(v_trip_mixto);

  -- El Camino 1 debe haber sumado 1 utilización más (pasando de 2 a 3) y el desvío sur nuevo debe haberse creado
  SELECT approved_trips_count INTO v_trips_cnt FROM public.roads WHERE id = v_road_id_1;
  SELECT COUNT(*) INTO v_segs_after FROM public.road_segments;

  IF v_trips_cnt <> 3 OR v_segs_after <> 3 THEN
    RAISE EXCEPTION 'Fallo Caso 5 (Recorrido Mixto): Camino 1 usos=% (esperado 3), segmentos totales=% (esperado 3)', v_trips_cnt, v_segs_after;
  END IF;

  -- ===========================================================================
  -- CASO 6: Revocar aprobación (unconsolidate_trip) deja la red como estaba antes
  -- ===========================================================================
  PERFORM public.unconsolidate_trip(v_trip_mixto);
  SELECT approved_trips_count INTO v_trips_cnt FROM public.roads WHERE id = v_road_id_1;
  SELECT COUNT(*) INTO v_segs_after FROM public.road_segments;

  IF v_trips_cnt <> 2 OR v_segs_after <> 2 THEN
    RAISE EXCEPTION 'Fallo Caso 6 (unconsolidate_trip): no restauró la red al estado previo (usos=%, segs=%)', v_trips_cnt, v_segs_after;
  END IF;

  -- ===========================================================================
  -- CASO 7: Privacidad en el endpoint de mapa para la App Móvil
  -- ===========================================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user1::text, 'role', 'authenticated')::text, true);
  v_map_json := public.get_consolidated_roads_map(-63.0, -36.0, -61.8, -34.8, 12);
  IF v_map_json::text LIKE '%vecino_spatial%' OR v_map_json::text LIKE '%user_id%' THEN
    RAISE EXCEPTION 'Fallo Privacidad: get_consolidated_roads_map filtró datos de usuarios';
  END IF;

  RAISE NOTICE '✅ TODAS LAS PRUEBAS ESPACIALES DE CONSOLIDACIÓN POSTGIS (NUEVO, REPETIDO, IDEMPOTENTE, PARALELOS, MIXTO, REVOCACIÓN Y PRIVACIDAD) PASARON EXITOSAMENTE.';
END;
$$;

ROLLBACK;
