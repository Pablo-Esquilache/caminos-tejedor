-- =============================================================================
-- Pruebas Automáticas de Migración 021 (audit_v21_fixes_test.sql)
-- Valida hash esperado (distinto y caracterización de NULL), cotas -50..500 m,
-- tamaño de payload (2..300), restricción admin y flag truncated (>300 zonas).
-- Corre íntegramente dentro de BEGIN ... ROLLBACK para no contaminar la base.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_user_nonadmin uuid := '00000000-0000-4000-b000-000000000021';
  v_admin         uuid := '00000000-0000-4000-a000-000000000021';
  v_road_id       uuid := '33333333-3333-4333-b333-000000000001';
  v_seg_id        uuid := '44444444-4444-4444-b444-000000000001';
  v_hash          text;
  v_valid_pts     jsonb := '[{"dist_m":0,"lat":-35.40,"lon":-62.42,"elev_m":94.1,"is_low_zone":false},{"dist_m":90,"lat":-35.41,"lon":-62.42,"elev_m":94.0,"is_low_zone":false}]'::jsonb;
  v_oversize_pts  jsonb;
  v_res           jsonb;
  v_i             integer;
  v_tmp_seg_id    uuid;
  v_denied        boolean;
BEGIN
  -- 1. Preparar usuarios de prueba en auth.users y rol admin
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES
    (v_user_nonadmin, 'vecino_v21@test.local', '{"full_name": "Vecino Test 021"}'::jsonb),
    (v_admin,         'admin_v21@test.local',  '{"full_name": "Admin Test 021"}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.admins (user_id, created_by)
  VALUES (v_admin, v_admin)
  ON CONFLICT (user_id) DO NOTHING;

  -- 2. Crear un camino y segmento de prueba dentro del Partido
  INSERT INTO public.roads (id, normalized_name, road_class, total_length_m, approved_trips_count)
  VALUES (v_road_id, 'Camino Test 021', 'vecinal', 1000, 1)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.road_segments (id, road_id, geom, length_m)
  VALUES (
    v_seg_id,
    v_road_id,
    ST_SetSRID(ST_MakeLine(ST_MakePoint(-62.42, -35.40), ST_MakePoint(-62.42, -35.41)), 4326),
    1110
  );

  SELECT md5(ST_AsEWKB(geom)) INTO v_hash FROM public.road_segments WHERE id = v_seg_id;

  -- ===========================================================================
  -- CASO 1: Usuario no-admin rechazado en RPCs administrativas de la 021
  -- ===========================================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_nonadmin::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_denied := false;
  BEGIN
    PERFORM public.admin_save_segment_elevation(v_seg_id, v_valid_pts, NULL, 94.0, 94.1, 94.05, false, 'copernicus-dem-90m', v_hash);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%administradores%' THEN v_denied := true; ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo seguridad 021: no-admin pudo llamar admin_save_segment_elevation';
  END IF;

  v_denied := false;
  BEGIN
    PERFORM public.get_admin_low_zones_map(-63.0, -36.0, -61.8, -34.8);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%administradores%' THEN v_denied := true; ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo seguridad 021: no-admin pudo llamar get_admin_low_zones_map';
  END IF;

  v_denied := false;
  BEGIN
    PERFORM public.admin_recalculate_intervention_metrics(gen_random_uuid());
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF SQLERRM LIKE '%Permiso denegado%' THEN v_denied := true; ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo seguridad 021: no-admin pudo llamar admin_recalculate_intervention_metrics';
  END IF;

  EXECUTE 'RESET ROLE';

  -- ===========================================================================
  -- CASO 2: Como Admin, probar hash distinto, caracterización NULL, cotas y payload
  -- ===========================================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- 2.a Hash distinto -> rechazado
  v_denied := false;
  BEGIN
    PERFORM public.admin_save_segment_elevation(v_seg_id, v_valid_pts, NULL, 94.0, 94.1, 94.05, false, 'copernicus-dem-90m', 'hash_invalido_000');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%geom_hash no coincide%' THEN v_denied := true; ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 021: aceptó geom_hash distinto';
  END IF;

  -- 2.b Caracterización: p_expected_geom_hash IS NULL hoy saltea el chequeo de hash
  PERFORM public.admin_save_segment_elevation(v_seg_id, v_valid_pts, NULL, 94.0, 94.1, 94.05, false, 'copernicus-dem-90m', NULL);

  -- 2.c Cotas fuera de rango (-50..500 m) -> rechazadas
  v_denied := false;
  BEGIN
    PERFORM public.admin_save_segment_elevation(v_seg_id, v_valid_pts, NULL, -60.0, 94.1, 94.05, false, 'copernicus-dem-90m', v_hash);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%fuera de rango%' THEN v_denied := true; ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 021: aceptó cota < -50';
  END IF;

  v_denied := false;
  BEGIN
    PERFORM public.admin_save_segment_elevation(v_seg_id, v_valid_pts, NULL, 94.0, 550.0, 94.05, false, 'copernicus-dem-90m', v_hash);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%fuera de rango%' THEN v_denied := true; ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 021: aceptó cota > 500';
  END IF;

  -- 2.d Bordes exactos de tamaño de payload (1 -> rechaza, 300 -> acepta, 301 -> rechaza)
  v_denied := false;
  BEGIN
    PERFORM public.admin_save_segment_elevation(
      v_seg_id,
      '[{"dist_m":0,"lat":-35.40,"lon":-62.42,"elev_m":94.1,"is_low_zone":false}]'::jsonb,
      NULL, 94.1, 94.1, 94.1, false, 'copernicus-dem-90m', v_hash
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%fuera de rango permitido%' THEN v_denied := true; ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 021: aceptó 1 sola muestra (mínimo es 2)';
  END IF;

  SELECT jsonb_agg(jsonb_build_object('dist_m', g * 90, 'lat', -35.4, 'lon', -62.42, 'elev_m', 94.0, 'is_low_zone', false))
  INTO v_oversize_pts
  FROM generate_series(0, 299) AS g;
  PERFORM public.admin_save_segment_elevation(v_seg_id, v_oversize_pts, NULL, 94.0, 94.1, 94.05, false, 'copernicus-dem-90m', v_hash);

  SELECT jsonb_agg(jsonb_build_object('dist_m', g * 90, 'lat', -35.4, 'lon', -62.42, 'elev_m', 94.0, 'is_low_zone', false))
  INTO v_oversize_pts
  FROM generate_series(0, 300) AS g;

  v_denied := false;
  BEGIN
    PERFORM public.admin_save_segment_elevation(v_seg_id, v_oversize_pts, NULL, 94.0, 94.1, 94.05, false, 'copernicus-dem-90m', v_hash);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%fuera de rango permitido%' THEN v_denied := true; ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 021: aceptó 301 muestras (máximo es 300)';
  END IF;

  -- ===========================================================================
  -- CASO 3: Sembrar 301 zonas bajas y verificar truncated = true y límite 300
  -- ===========================================================================
  EXECUTE 'RESET ROLE';
  FOR v_i IN 1..301 LOOP
    v_tmp_seg_id := gen_random_uuid();
    INSERT INTO public.road_segments (id, road_id, geom, length_m)
    VALUES (
      v_tmp_seg_id,
      v_road_id,
      ST_SetSRID(ST_MakeLine(ST_MakePoint(-62.42, -35.40), ST_MakePoint(-62.43, -35.41)), 4326),
      1000 + v_i
    );
    INSERT INTO public.road_segment_elevations (
      segment_id, min_elevation_m, max_elevation_m, avg_elevation_m,
      has_low_zone, low_zone_length_m, profile_points, low_zones_geojson, dem_source, geom_hash
    )
    VALUES (
      v_tmp_seg_id,
      92.5, 94.5, 93.8,
      true, 200,
      v_valid_pts,
      '{"type":"MultiLineString","coordinates":[[[-62.42,-35.40],[-62.425,-35.405]]]}'::jsonb,
      'copernicus-dem-90m',
      md5(ST_AsEWKB(ST_SetSRID(ST_MakeLine(ST_MakePoint(-62.42, -35.40), ST_MakePoint(-62.43, -35.41)), 4326)))
    );
  END LOOP;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_res := public.get_admin_low_zones_map(-63.0, -36.0, -61.8, -34.8);
  IF (v_res ->> 'truncated')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Fallo 021: get_admin_low_zones_map no marcó truncated=true con >300 filas (res=%)', v_res ->> 'truncated';
  END IF;
  IF jsonb_array_length(v_res -> 'items') <> 300 THEN
    RAISE EXCEPTION 'Fallo 021: esperaba exactamente 300 items en respuesta truncada, devolvió %', jsonb_array_length(v_res -> 'items');
  END IF;

  EXECUTE 'RESET ROLE';
  RAISE NOTICE '   ✅ Suite 021 OK -> hash distinto/NULL, cotas -50..500, payload >300, no-admin y truncated=true (300/301+) verificados.';
END $$;

ROLLBACK;
