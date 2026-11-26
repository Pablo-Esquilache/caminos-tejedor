-- =============================================================================
-- Suite Adversarial de Seguridad — Migración 022 (security_v22_test.sql)
-- Prueba con identidades independientes (Vecino A/B, Operario A/B/sin asignar, Admin)
-- usando banderas explícitas v_denied (nunca EXCEPTION WHEN OTHERS THEN NULL).
-- Corre dentro de BEGIN ... ROLLBACK para no ensuciar la base.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_vecino_a uuid := '00000000-0000-4000-c000-0000000000a1';
  v_vecino_b uuid := '00000000-0000-4000-c000-0000000000b1';
  v_op_a_uid uuid := '00000000-0000-4000-c000-0000000000c1';
  v_op_b_uid uuid := '00000000-0000-4000-c000-0000000000c2';
  v_op_c_uid uuid := '00000000-0000-4000-c000-0000000000c3';
  v_admin    uuid := '00000000-0000-4000-c000-0000000000ad';

  v_op_a_id  uuid;
  v_op_b_id  uuid;
  v_op_c_id  uuid;
  v_cat_id   uuid;

  v_claim_a  uuid := gen_random_uuid();
  v_int_b    uuid := gen_random_uuid();
  v_int_open uuid := gen_random_uuid();
  v_int_appr uuid := gen_random_uuid();
  v_int_rej  uuid := gen_random_uuid();
  v_sess_b   uuid := gen_random_uuid();
  v_sess_open uuid := gen_random_uuid();

  v_pts      jsonb := '[{"lat":-35.40,"lon":-62.42},{"lat":-35.41,"lon":-62.42}]'::jsonb;
  v_huge_pts jsonb;
  v_denied   boolean;
  v_escaped  text;
  v_rows     integer;
  v_email    text;
BEGIN
  -- 1. Crear usuarios de prueba
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES
    (v_vecino_a, 'vecino_a_022@tejedor.test', '{"full_name": "Vecino A 022"}'::jsonb),
    (v_vecino_b, 'vecino_b_022@tejedor.test', '{"full_name": "Vecino B 022"}'::jsonb),
    (v_op_a_uid, 'op_a_022@tejedor.test',     '{"full_name": "Operario A 022"}'::jsonb),
    (v_op_b_uid, 'op_b_022@tejedor.test',     '{"full_name": "Operario B 022"}'::jsonb),
    (v_op_c_uid, 'op_c_022@tejedor.test',     '{"full_name": "Operario C 022"}'::jsonb),
    (v_admin,    'admin_022@tejedor.test',    '{"full_name": "Admin 022"}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.admins (user_id, created_by)
  VALUES (v_admin, v_admin)
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.operators (user_id, full_name, is_active)
  VALUES (v_op_a_uid, 'Operario A 022', true)
  RETURNING id INTO v_op_a_id;

  INSERT INTO public.operators (user_id, full_name, is_active)
  VALUES (v_op_b_uid, 'Operario B 022', true)
  RETURNING id INTO v_op_b_id;

  INSERT INTO public.operators (user_id, full_name, is_active)
  VALUES (v_op_c_uid, 'Operario C 022', true)
  RETURNING id INTO v_op_c_id;

  SELECT id INTO v_cat_id FROM public.claim_categories WHERE is_active = true LIMIT 1;

  -- 2. Verificar helper escape_html()
  v_escaped := public.escape_html('<img src=x onerror="alert(1)"> & ''test''');
  IF position('<img' in v_escaped) > 0 OR position('&lt;img' in v_escaped) = 0 OR position('&amp;' in v_escaped) = 0 THEN
    RAISE EXCEPTION 'Fallo 022: escape_html no escapó correctamente (resultado: %)', v_escaped;
  END IF;

  -- 3. Sembrar intervenciones de prueba (B exclusiva, abierta sin asignar, aprobada, rechazada)
  INSERT INTO public.interventions (id, title, execution_mode, origin, status, responsible_operator_id, created_by)
  VALUES
    (v_int_b,    'Tarea exclusiva de B', 'linear', 'planned', 'planned', v_op_b_id, v_admin),
    (v_int_open, 'Tarea abierta',        'linear', 'planned', 'planned', NULL,      v_admin),
    (v_int_appr, 'Tarea ya aprobada',    'linear', 'planned', 'approved', v_op_a_id, v_admin),
    (v_int_rej,  'Tarea rechazada',      'linear', 'planned', 'rejected', v_op_a_id, v_admin);

  INSERT INTO public.intervention_operators (intervention_id, operator_id, is_responsible)
  VALUES
    (v_int_b,    v_op_b_id, true),
    (v_int_appr, v_op_a_id, true),
    (v_int_rej,  v_op_a_id, true);

  -- ===========================================================================
  -- PRUEBA 1: Vecino A crea reclamo propio vía RPC; escritura directa bloqueada
  -- ===========================================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_vecino_a::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM public.submit_claim_with_photo(
    v_claim_a, 'Pozo en camino norte', 'Muy profundo', v_cat_id, -35.40, -62.42,
    v_vecino_a::text || '/' || v_claim_a::text || '/photo.jpg',
    v_vecino_a::text || '/' || v_claim_a::text || '/thumb.jpg'
  );

  -- 1.a INSERT directo en trips bloqueado por RLS
  v_denied := false;
  BEGIN
    INSERT INTO public.trips (id, user_id, original_name, started_at, ended_at, distance_m, duration_s)
    VALUES (gen_random_uuid(), v_vecino_a, 'Bypass', now() - interval '5 min', now(), 500, 300);
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 022: Vecino pudo hacer INSERT directo en trips';
  END IF;

  -- 1.b INSERT directo en claims bloqueado por RLS
  v_denied := false;
  BEGIN
    INSERT INTO public.claims (id, user_id, title, category_id, location)
    VALUES (gen_random_uuid(), v_vecino_a, 'Bypass', v_cat_id, ST_SetSRID(ST_MakePoint(-62.42, -35.40), 4326));
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 022: Vecino pudo hacer INSERT directo en claims';
  END IF;

  -- 1.c UPDATE directo en profiles.email bloqueado (0 filas modificadas)
  UPDATE public.profiles SET email = 'hacked@evil.com' WHERE id = v_vecino_a;
  SELECT email INTO v_email FROM public.profiles WHERE id = v_vecino_a;
  IF v_email = 'hacked@evil.com' THEN
    RAISE EXCEPTION 'Fallo 022: Vecino pudo modificar profiles.email directamente';
  END IF;

  -- 1.d Ruta de foto ajena en submit_claim_with_photo -> rechazada (42501)
  v_denied := false;
  BEGIN
    PERFORM public.submit_claim_with_photo(
      gen_random_uuid(), 'Intento ruta ajena', NULL, v_cat_id, -35.40, -62.42,
      v_vecino_b::text || '/ajena/photo.jpg', NULL
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 022: Vecino A pudo registrar ruta de foto perteneciente a Vecino B';
  END IF;

  -- 1.e Fechas invertidas en submit_trip_with_track -> rechazadas
  v_denied := false;
  BEGIN
    PERFORM public.submit_trip_with_track(
      gen_random_uuid(), 'Fechas invertidas', now(), now() - interval '10 min', 500, 600, v_pts
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%Fechas de recorrido%' THEN v_denied := true; ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 022: submit_trip_with_track aceptó ended_at < started_at';
  END IF;

  -- 1.f > 20.000 puntos en submit_trip_with_track -> rechazado
  SELECT jsonb_agg(jsonb_build_object('lat', -35.40, 'lon', -62.42))
  INTO v_huge_pts
  FROM generate_series(1, 20001);

  v_denied := false;
  BEGIN
    PERFORM public.submit_trip_with_track(
      gen_random_uuid(), 'Demasiados puntos', now() - interval '10 min', now(), 500, 600, v_huge_pts
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%fuera de rango permitido%' THEN v_denied := true; ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 022: submit_trip_with_track aceptó > 20000 puntos';
  END IF;

  -- ===========================================================================
  -- PRUEBA 2: Vecino B intenta adjuntar foto al reclamo de Vecino A (idempotencia)
  -- ===========================================================================
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_vecino_b::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_denied := false;
  BEGIN
    PERFORM public.submit_claim_with_photo(
      v_claim_a, 'Secuestro', NULL, v_cat_id, -35.40, -62.42,
      v_vecino_b::text || '/evil/photo.jpg', NULL
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 022: Vecino B pudo adjuntar foto al reclamo de Vecino A';
  END IF;

  -- ===========================================================================
  -- PRUEBA 3: Operario B registra sesión válida en su tarea; Operario A intenta robarla
  -- ===========================================================================
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_op_b_uid::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM public.operator_submit_session(
    v_sess_b, v_int_b, 'suspend', 'linear', NULL, NULL,
    now() - interval '15 min', now(), v_pts, 1100, 900,
    NULL, NULL, NULL, NULL, NULL, NULL,
    jsonb_build_array(jsonb_build_object('storage_path', v_op_b_uid::text || '/op/p1.jpg')),
    'Jornada válida de B'
  );

  -- Ahora como Operario A: intentar operar sobre tarea de B -> 42501
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_op_a_uid::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_denied := false;
  BEGIN
    PERFORM public.operator_submit_session(
      gen_random_uuid(), v_int_b, 'submit', 'linear', NULL, NULL,
      now() - interval '10 min', now(), v_pts, 1100, 600
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 022: Operario A pudo registrar trabajo sobre tarea exclusiva de Operario B';
  END IF;

  -- Operario A intenta consultar sesión idempotente de Operario B -> 42501
  v_denied := false;
  BEGIN
    PERFORM public.operator_submit_session(
      v_sess_b, v_int_b, 'suspend', 'linear', NULL, NULL,
      now() - interval '10 min', now(), v_pts, 1100, 600
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 022: Operario A pudo consultar respuesta idempotente de sesión de Operario B';
  END IF;

  -- Operario A intenta modificar tarea ya aprobada -> rechazado
  v_denied := false;
  BEGIN
    PERFORM public.operator_submit_session(
      gen_random_uuid(), v_int_appr, 'submit', 'linear', NULL, NULL,
      now() - interval '10 min', now(), v_pts, 1100, 600
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 022: Operario A pudo modificar una tarea ya aprobada';
  END IF;

  -- Operario A puede registrar sobre tarea rechazada en 022 (se bloqueará en migración posterior tras APK con A1)
  PERFORM public.operator_submit_session(
    gen_random_uuid(), v_int_rej, 'suspend', 'linear', NULL, NULL,
    now() - interval '10 min', now(), v_pts, 1100, 600
  );

  -- Operario A intenta adjuntar > 3 fotos -> rechazado
  v_denied := false;
  BEGIN
    PERFORM public.operator_submit_session(
      gen_random_uuid(), NULL, 'submit', 'linear', 'Espontánea 4 fotos', NULL,
      now() - interval '10 min', now(), v_pts, 1100, 600,
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_array(
        jsonb_build_object('storage_path', v_op_a_uid::text || '/1.jpg'),
        jsonb_build_object('storage_path', v_op_a_uid::text || '/2.jpg'),
        jsonb_build_object('storage_path', v_op_a_uid::text || '/3.jpg'),
        jsonb_build_object('storage_path', v_op_a_uid::text || '/4.jpg')
      )
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%Máximo 3 fotografías%' THEN v_denied := true; ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 022: operator_submit_session aceptó más de 3 fotos';
  END IF;

  -- Operario A intenta adjuntar ruta de foto de Operario B -> rechazado (42501)
  v_denied := false;
  BEGIN
    PERFORM public.operator_submit_session(
      gen_random_uuid(), NULL, 'submit', 'linear', 'Espontánea ruta ajena', NULL,
      now() - interval '10 min', now(), v_pts, 1100, 600,
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_array(jsonb_build_object('storage_path', v_op_b_uid::text || '/ajena.jpg'))
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 022: Operario A pudo adjuntar foto de carpeta ajena';
  END IF;

  -- ===========================================================================
  -- PRUEBA 4: Operario C toma tarea abierta sin asignar -> permitido
  -- ===========================================================================
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_op_c_uid::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM public.operator_submit_session(
    v_sess_open, v_int_open, 'submit', 'linear', NULL, NULL,
    now() - interval '10 min', now(), v_pts, 1100, 600
  );

  -- Y una vez en pending_approval, ni Operario C puede volver a meter otra sesión -> rechazado
  v_denied := false;
  BEGIN
    PERFORM public.operator_submit_session(
      gen_random_uuid(), v_int_open, 'submit', 'linear', NULL, NULL,
      now() - interval '5 min', now(), v_pts, 1100, 300
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 022: se pudo registrar trabajo sobre una tarea ya en pending_approval';
  END IF;

  RESET ROLE;
  RAISE NOTICE '   ✅ Suite Seguridad 022 OK -> RLS escrituras directas, idempotencia, rutas Storage, asignación, estados (incl. rejected), límites y escape HTML verificados.';
END $$;

ROLLBACK;
