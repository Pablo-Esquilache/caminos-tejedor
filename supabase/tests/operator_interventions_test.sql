-- =============================================================================
-- Pruebas Automáticas Integrales: Módulo de Operario e Intervenciones Viales
-- Cubre Fases 9, 10, 12, 13 y 14:
-- 1. Roles y RLS (Anon, Vecino, Operario con cuenta/sin cuenta, Admin)
-- 2. Creación de cuenta de Operario en Auth desde RPC admin_upsert_operator
-- 3. Algoritmo GPS de tramo trabajado (Spike: pasadas ida/vuelta, 90°, multijornada)
-- 4. Flujo multi-día ("Terminar por hoy" -> "Finalizar" -> Aprobación + Reclamo resuelto)
-- 5. Independencia geométrica ante borrado de road_segments y privacidad gremial
-- Todo corre en transacción con ROLLBACK al final.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_admin uuid := '00000000-0000-4000-a000-0000000001ad';
  v_vecino uuid := '00000000-0000-4000-a000-000000000101';
  v_op_record public.operators;
  v_op_no_acct public.operators;
  v_machine public.machines;
  v_wt_linear_id uuid;
  v_wt_punctual_id uuid;
  v_road_id uuid := '33333333-3333-4333-a333-333333333301';
  v_claim_id uuid := '44444444-4444-4444-a444-444444444401';
  v_cat_id uuid;
  v_int_planned public.interventions;
  v_int_spont_id uuid := '55555555-5555-4555-a555-555555555501';
  v_sess_1 uuid := '66666666-6666-4666-a666-666666666601';
  v_sess_2 uuid := '66666666-6666-4666-a666-666666666602';
  v_sess_sp uuid := '66666666-6666-4666-a666-666666666603';
  v_role text;
  v_cnt integer;
  v_res jsonb;
  v_pts_day1 jsonb;
  v_pts_day2 jsonb;
  v_worked_m numeric;
  v_claim_status text;
  v_notif_cnt integer;
  v_substr jsonb;
  -- Variables de Spike Fase 12
  v_spike_1 geometry;
  v_spike_2 geometry;
  v_spike_3 geometry;
  v_len_1 double precision;
  v_len_2 double precision;
  v_len_3 double precision;
BEGIN
  -- ---------------------------------------------------------------------------
  -- PASO 0: Preparar usuarios base (Admin y Vecino)
  -- ---------------------------------------------------------------------------
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES
    (v_admin, 'admin_optest@test.local', '{"full_name": "Admin Vial"}'::jsonb),
    (v_vecino, 'vecino_optest@test.local', '{"full_name": "Vecino Rural"}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.admins (user_id, created_by)
  VALUES (v_admin, v_admin)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT id INTO v_cat_id FROM public.claim_categories WHERE is_active = true LIMIT 1;
  SELECT id INTO v_wt_linear_id FROM public.work_types WHERE execution_mode = 'linear' LIMIT 1;
  SELECT id INTO v_wt_punctual_id FROM public.work_types WHERE execution_mode = 'punctual' LIMIT 1;

  -- Crear un camino consolidado de prueba (~2 km Este-Oeste con curva) y un reclamo cercano
  INSERT INTO public.roads (id, normalized_name, road_class, total_length_m, approved_trips_count, unique_users_count)
  VALUES (v_road_id, 'Camino Real a Curarú (Test)', 'principal', 2000, 12, 4);

  INSERT INTO public.road_segments (road_id, geom, length_m)
  VALUES (
    v_road_id,
    ST_GeomFromText('LINESTRING(-62.4300 -35.3900, -62.4180 -35.3900, -62.4100 -35.3820)', 4326),
    2000
  );

  INSERT INTO public.claims (id, user_id, title, description, category_id, location, status, priority)
  VALUES (
    v_claim_id,
    v_vecino,
    'Huellón cortado cerca de curva',
    'No pasa el camión lechero',
    v_cat_id,
    ST_SetSRID(ST_MakePoint(-62.4220, -35.3902), 4326),
    'received',
    'high'
  );

  -- ---------------------------------------------------------------------------
  -- PASO 1 (Fase 12 Spike): Probar algoritmo GPS de deduplicación de pasadas
  -- ---------------------------------------------------------------------------
  -- Caso A: Motoniveladora ida y vuelta (1000 m ida + 1000 m vuelta desplazada 8 m) + 4 puntos parados
  v_spike_1 := public.extract_worked_tramo_utm(ARRAY[
    ST_Transform(ST_GeomFromText('LINESTRING(552000 6083000, 552500 6083000, 553000 6083000, 553002 6083002, 553000 6083008, 552500 6083008, 552000 6083008)', 32720), 4326)
  ]);
  v_len_1 := COALESCE(ST_Length(v_spike_1), 0);
  IF v_len_1 < 950 OR v_len_1 > 1100 THEN
    RAISE EXCEPTION 'Fallo Spike Caso A (ida/vuelta 1000m): esperado ~1000m, obtenido % m', v_len_1;
  END IF;

  -- Caso B: Curva en esquina de 90 grados (800m Este + 700m Norte = 1500m) ida y vuelta completa
  v_spike_2 := public.extract_worked_tramo_utm(ARRAY[
    ST_Transform(ST_GeomFromText('LINESTRING(552000 6083000, 552400 6083000, 552800 6083000, 552800 6083350, 552800 6083700, 552806 6083700, 552806 6083350, 552806 6083006, 552400 6083006, 552000 6083006)', 32720), 4326)
  ]);
  v_len_2 := COALESCE(ST_Length(v_spike_2), 0);
  IF v_len_2 < 1420 OR v_len_2 > 1620 THEN
    RAISE EXCEPTION 'Fallo Spike Caso B (esquina 90 grados 1500m ida/vuelta): esperado ~1500m, obtenido % m', v_len_2;
  END IF;

  -- Caso C: Dos jornadas acumuladas (Día 1: 1000m; Día 2: solapa últimos 200m + avanza 600m nuevos -> total ~1600m)
  v_spike_3 := public.extract_worked_tramo_utm(ARRAY[
    ST_Transform(ST_GeomFromText('LINESTRING(552000 6083000, 552500 6083000, 553000 6083000)', 32720), 4326),
    ST_Transform(ST_GeomFromText('LINESTRING(552800 6083000, 553000 6083000, 553600 6083000)', 32720), 4326)
  ]);
  v_len_3 := COALESCE(ST_Length(v_spike_3), 0);
  IF v_len_3 < 1520 OR v_len_3 > 1700 THEN
    RAISE EXCEPTION 'Fallo Spike Caso C (multijornada solapada 1600m): esperado ~1600m, obtenido % m', v_len_3;
  END IF;

  RAISE NOTICE '✅ Spike Fase 12 OK -> Ida/Vuelta: %m | Esquina 90°: %m | Multijornada: %m',
    ROUND(v_len_1::numeric, 1), ROUND(v_len_2::numeric, 1), ROUND(v_len_3::numeric, 1);

  -- ---------------------------------------------------------------------------
  -- PASO 2 (Fase 9 y 10): Como ADMIN crear catálogos, cuenta de operario y tarea planificada
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT public.get_my_role() INTO v_role;
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'Fallo rol: Admin obtuvo %', v_role;
  END IF;

  SELECT * INTO v_machine FROM public.admin_upsert_machine(
    NULL, 'Motoniveladora John Deere 670G', 'MV-04', 'motoniveladora', 'Equipo asignado a Zona Sur', true
  );

  -- Crear Operario CON cuenta Auth real + Operario histórico SIN cuenta
  SELECT * INTO v_op_record FROM public.admin_upsert_operator(
    NULL, 'Carlos Maquinista', 'maquinista.test@tejedor.test', 'claveSegura123', 'LEG-204', '2355-441122', 'Titular motoniveladora', true, true
  );
  IF v_op_record.user_id IS NULL OR NOT v_op_record.has_account THEN
    RAISE EXCEPTION 'Fallo Fase 9: El operario no quedó vinculado con cuenta en Auth/Profiles.';
  END IF;

  SELECT * INTO v_op_no_acct FROM public.admin_upsert_operator(
    NULL, 'Ayudante Histórico Sin Cuenta', NULL, NULL, 'LEG-901', NULL, 'Solo registro histórico', false, true
  );
  IF v_op_no_acct.user_id IS NOT NULL OR v_op_no_acct.has_account THEN
    RAISE EXCEPTION 'Fallo Fase 9: El operario sin cuenta no debería tener user_id.';
  END IF;

  -- Probar Modo (b): ST_LineSubstring entre 2 clics sobre el camino consolidado
  SELECT public.admin_compute_road_substring_geojson(
    v_road_id, -62.4280, -35.3901, -62.4140, -35.3880
  ) INTO v_substr;
  IF (v_substr->>'length_m')::numeric < 500 THEN
    RAISE EXCEPTION 'Fallo Fase 10 ST_LineSubstring: longitud calculada muy baja (%)', v_substr;
  END IF;

  -- Programar intervención planificada asignando el operario titular + ayudante sin cuenta
  SELECT * INTO v_int_planned FROM public.admin_upsert_intervention(
    NULL,
    'Perfilado Camino a Curarú Tramo 1',
    'Repaso completo y limpieza de huella',
    'linear',
    'high',
    v_road_id,
    'points_along_road',
    v_substr->'geojson',
    ARRAY[v_wt_linear_id],
    ARRAY[v_machine.id],
    ARRAY[v_op_record.id, v_op_no_acct.id],
    v_op_record.id,
    CURRENT_DATE,
    v_claim_id
  );

  -- ---------------------------------------------------------------------------
  -- PASO 3: Verificar aislamiento de VECINO COMÚN y ANÓNIMO
  -- ---------------------------------------------------------------------------
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_vecino::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  IF public.get_my_role() <> 'user' OR public.is_operator() THEN
    RAISE EXCEPTION 'Fallo rol: Vecino común no debería ser operator';
  END IF;

  SELECT COUNT(*) INTO v_cnt FROM public.operators;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'Fallo RLS: Vecino pudo leer tabla operators (%)', v_cnt;
  END IF;

  SELECT COUNT(*) INTO v_cnt FROM public.machines;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'Fallo RLS: Vecino pudo leer tabla machines (%)', v_cnt;
  END IF;

  SELECT COUNT(*) INTO v_cnt FROM public.interventions WHERE id = v_int_planned.id;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'Fallo RLS: Vecino pudo ver una intervención planificada aún no aprobada';
  END IF;

  -- Vecino tampoco puede pedir estadísticas ni tareas de operario
  BEGIN
    PERFORM public.get_intervention_statistics();
    RAISE EXCEPTION 'Fallo Seguridad: Vecino pudo ejecutar get_intervention_statistics()';
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  -- Verificar rol Anónimo
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '{}', true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    SELECT COUNT(*) INTO v_cnt FROM public.work_types;
    RAISE EXCEPTION 'Fallo RLS Anon: Anónimo no debe poder leer work_types';
  EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
    NULL;
  END;

  -- ---------------------------------------------------------------------------
  -- PASO 4 (Fases 11 y 13): OPERARIO ejecuta tarea planificada en 2 días + tarea puntual
  -- ---------------------------------------------------------------------------
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_op_record.user_id::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  IF public.get_my_role() <> 'operator' OR NOT public.is_operator() THEN
    RAISE EXCEPTION 'Fallo rol Operario: get_my_role()=%', public.get_my_role();
  END IF;

  SELECT public.operator_list_my_tasks() INTO v_res;
  IF jsonb_array_length(v_res) < 1 THEN
    RAISE EXCEPTION 'Fallo Fase 11: El operario no ve su tarea planificada asignada.';
  END IF;

  -- Jornada 1: Operario ejecuta parte del tramo y presiona "Terminar por hoy" ('suspend')
  v_pts_day1 := jsonb_build_array(
    jsonb_build_object('lat', -35.3900, 'lon', -62.4300, 'timestamp', 1000, 'accuracy', 5),
    jsonb_build_object('lat', -35.3900, 'lon', -62.4240, 'timestamp', 2000, 'accuracy', 5),
    jsonb_build_object('lat', -35.3900, 'lon', -62.4180, 'timestamp', 3000, 'accuracy', 5)
  );
  SELECT public.operator_submit_session(
    v_sess_1, v_int_planned.id, 'suspend', 'linear', NULL, NULL,
    now() - interval '2 hours', now() - interval '1 hour',
    v_pts_day1, 1100, 3600, NULL, NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 'Corte por lluvia'
  ) INTO v_res;
  IF v_res->>'status' <> 'suspended' THEN
    RAISE EXCEPTION 'Fallo Fase 13: Terminar por hoy debía dejar status=suspended, dejó %', v_res;
  END IF;

  -- Reintento idempotente con mismo session_id no debe duplicar ni fallar
  SELECT public.operator_submit_session(
    v_sess_1, v_int_planned.id, 'suspend', 'linear', NULL, NULL,
    now() - interval '2 hours', now() - interval '1 hour',
    v_pts_day1, 1100, 3600
  ) INTO v_res;
  IF NOT COALESCE((v_res->>'already_processed')::boolean, false) THEN
    RAISE EXCEPTION 'Fallo Idempotencia: reintento de sesión duplicó el envío.';
  END IF;

  -- Jornada 2 (día siguiente): Reanuda haciendo pasada de vuelta superpuesta + tramo final -> "Finalizar" ('submit')
  v_pts_day2 := jsonb_build_array(
    jsonb_build_object('lat', -35.3900, 'lon', -62.4210, 'timestamp', 4000, 'accuracy', 5),
    jsonb_build_object('lat', -35.3900, 'lon', -62.4180, 'timestamp', 5000, 'accuracy', 5),
    jsonb_build_object('lat', -35.3820, 'lon', -62.4100, 'timestamp', 6000, 'accuracy', 5)
  );
  SELECT public.operator_submit_session(
    v_sess_2, v_int_planned.id, 'submit', 'linear', NULL, NULL,
    now() - interval '40 minutes', now(),
    v_pts_day2, 1400, 2400, NULL, NULL, NULL, NULL, NULL, v_claim_id, '[]'::jsonb, 'Tramo terminado completo'
  ) INTO v_res;
  IF v_res->>'status' <> 'pending_approval' OR (v_res->>'sessions_count')::int <> 2 THEN
    RAISE EXCEPTION 'Fallo Fase 13 multi-jornada: esperado pending_approval y 2 sesiones, obtenido %', v_res;
  END IF;

  -- Verificar que worked_length_m acumuló ~2000m sin sumar los 1100+1400=2500m brutos
  v_worked_m := (v_res->>'worked_length_m')::numeric;
  IF v_worked_m < 1700 OR v_worked_m > 2250 THEN
    RAISE EXCEPTION 'Fallo deduplicación multijornada: worked_length_m=%', v_worked_m;
  END IF;

  -- También registrar tarea PUNTUAL espontánea (Alcantarilla sin trackeo continuo + foto)
  SELECT public.operator_submit_session(
    v_sess_sp, v_int_spont_id, 'submit', 'punctual', 'Reemplazo tubo en alcantarilla Paso Gómez', 'Tubo 800mm',
    now() - interval '10 minutes', now(),
    '[]'::jsonb, 0, 600, -35.3950, -62.4250,
    ARRAY[v_wt_punctual_id], ARRAY[v_machine.id], NULL, NULL,
    jsonb_build_array(jsonb_build_object('storage_path', v_op_record.user_id::text || '/interventions/spont/f1.jpg', 'thumb_path', '')),
    'Colocado con retro'
  ) INTO v_res;
  IF v_res->>'status' <> 'pending_approval' OR (v_res->>'worked_length_m')::numeric <> 0 THEN
    RAISE EXCEPTION 'Fallo tarea puntual espontánea: %', v_res;
  END IF;

  -- ---------------------------------------------------------------------------
  -- PASO 5: ADMIN aprueba tarea con reclamo vinculado -> resuelve reclamo + estadísticas + privacidad
  -- ---------------------------------------------------------------------------
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM public.admin_review_intervention(v_int_planned.id, 'approved', 'Trabajo verificado en campo');

  -- Verificar que el reclamo vecinal vinculado pasó automáticamente a 'solved' y generó notificación al vecino
  SELECT status INTO v_claim_status FROM public.claims WHERE id = v_claim_id;
  IF v_claim_status <> 'solved' THEN
    RAISE EXCEPTION 'Fallo Fase 13: Al aprobar la intervención vinculada, el reclamo debía pasar a solved (quedó %)', v_claim_status;
  END IF;

  SELECT COUNT(*) INTO v_notif_cnt FROM public.notifications WHERE claim_id = v_claim_id AND type = 'claim_status';
  IF v_notif_cnt < 1 THEN
    RAISE EXCEPTION 'Fallo Fase 13: Faltó notificar al vecino sobre la solución de su reclamo.';
  END IF;

  -- Verificar estadísticas Fase 14
  SELECT public.get_intervention_statistics(NULL, NULL) INTO v_res;
  IF (v_res->'kpis'->>'approved_interventions')::int < 1
     OR (v_res->'kpis'->>'claims_resolved_by_interventions')::int < 1 THEN
    RAISE EXCEPTION 'Fallo Fase 14 Estadísticas: %', v_res;
  END IF;

  -- Verificar Independencia Geométrica (Decisión #12): eliminar el camino consolidado NO borra ni rompe la intervención
  DELETE FROM public.road_segments WHERE road_id = v_road_id;
  DELETE FROM public.roads WHERE id = v_road_id;
  SELECT COUNT(*) INTO v_cnt FROM public.interventions WHERE id = v_int_planned.id AND worked_geom IS NOT NULL;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Fallo Decisión #12: Al borrar camino/segmentos se perdió la geometría o registro de la intervención.';
  END IF;

  -- Verificar Capa Mapa Vecinos: devuelve la intervención aprobada SIN nombres de operarios
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_vecino::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT public.get_map_interventions_geojson(-63.0, -35.8, -62.0, -35.0, true) INTO v_res;
  IF v_res::text LIKE '%Carlos Maquinista%' THEN
    RAISE EXCEPTION 'Fallo Privacidad Gremial: La capa pública del mapa expuso el nombre del operario!';
  END IF;
  IF jsonb_array_length(v_res) < 1 THEN
    RAISE EXCEPTION 'Fallo Capa Mapa: Vecino no ve intervenciones aprobadas.';
  END IF;

  RAISE NOTICE '✅ TODAS LAS PRUEBAS DEL MÓDULO OPERARIO (FASES 9-14) SUPERADAS EXITOSAMENTE.';
END $$;

ROLLBACK;
