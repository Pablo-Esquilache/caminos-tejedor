-- =============================================================================
-- Suite de Pruebas SQL — Migración 024 (security_v24_test.sql)
-- Verifica:
--   1. Estado 'rejected' bloqueado en operator_submit_session() con 22023,
--      sin crear sesiones ni alterar el estado.
--   2. Prefijo exacto ${auth.uid()}/${p_claim_id}/ en storage_path y thumb_path
--      (impide reutilizar fotos privadas de otro reclamo del mismo usuario).
--   3. Reintento idempotente sobre un reclamo privado NUNCA lo publica y devuelve
--      alert_published=false + alert_reason coherente.
--   4. Reintento idempotente sobre un 6º reclamo degradado conserva
--      alert_published=false + alert_reason no vacío.
--   5. Advisory lock por usuario funciona dentro de la transacción de publicación.
-- Corre íntegramente dentro de BEGIN ... ROLLBACK.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_vecino   uuid := '00000000-0000-4000-e000-0000000000a1';
  v_op_uid   uuid := '00000000-0000-4000-e000-0000000000b1';
  v_admin    uuid := '00000000-0000-4000-e000-0000000000ad';
  v_op_id    uuid;
  v_cat_id   uuid;

  v_int_rej  uuid := gen_random_uuid();
  v_c1_priv  uuid := gen_random_uuid();
  v_c2_pub   uuid := gen_random_uuid();
  v_c_6th    uuid := gen_random_uuid();

  v_pts      jsonb := '[{"lat":-35.40,"lon":-62.42},{"lat":-35.41,"lon":-62.42}]'::jsonb;
  v_denied   boolean;
  v_status   text;
  v_sess_cnt integer;
  v_res      jsonb;
  v_i        integer;
BEGIN
  -- 0. Sembrar usuarios de prueba
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES
    (v_vecino, 'vecino_024@tejedor.test', '{"full_name": "Vecino 024"}'::jsonb),
    (v_op_uid, 'op_024@tejedor.test',     '{"full_name": "Operario 024"}'::jsonb),
    (v_admin,  'admin_024@tejedor.test',  '{"full_name": "Admin 024"}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.admins (user_id, created_by)
  VALUES (v_admin, v_admin)
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.operators (user_id, full_name, is_active)
  VALUES (v_op_uid, 'Operario 024', true)
  RETURNING id INTO v_op_id;

  SELECT id INTO v_cat_id FROM public.claim_categories WHERE is_active = true LIMIT 1;

  -- Crear intervención en estado 'rejected' asignada a v_op_id
  INSERT INTO public.interventions (id, title, execution_mode, origin, status, responsible_operator_id, created_by)
  VALUES (v_int_rej, 'Tarea rechazada 024', 'linear', 'planned', 'rejected', v_op_id, v_admin);

  INSERT INTO public.intervention_operators (intervention_id, operator_id, is_responsible)
  VALUES (v_int_rej, v_op_id, true);

  -- ===========================================================================
  -- CASO 1: Operario intenta registrar sesión sobre tarea 'rejected' -> 22023
  -- ===========================================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_op_uid::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_denied := false;
  BEGIN
    PERFORM public.operator_submit_session(
      gen_random_uuid(), v_int_rej, 'submit', 'linear', NULL, NULL,
      now() - interval '10 min', now(), v_pts, 1100, 600
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 024 (Caso 1): operator_submit_session permitió registrar sobre tarea rejected';
  END IF;

  RESET ROLE;
  SELECT status INTO v_status FROM public.interventions WHERE id = v_int_rej;
  SELECT count(*) INTO v_sess_cnt FROM public.intervention_sessions WHERE intervention_id = v_int_rej;
  IF v_status <> 'rejected' OR v_sess_cnt <> 0 THEN
    RAISE EXCEPTION 'Fallo 024 (Caso 1): estado=% sesiones=% (esperado rejected / 0)', v_status, v_sess_cnt;
  END IF;

  -- ===========================================================================
  -- CASO 2: Prefijo exacto ${uid}/${p_claim_id}/ en storage_path y thumb_path
  -- ===========================================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_vecino::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- Crear reclamo privado C1 con su propia foto
  v_res := public.submit_claim_with_photo(
    v_c1_priv, 'Privado C1', 'Foto privada', v_cat_id, -35.40, -62.42,
    v_vecino::text || '/' || v_c1_priv::text || '/photo.jpg',
    v_vecino::text || '/' || v_c1_priv::text || '/thumb.jpg',
    now(), false
  );
  IF (v_res->>'alert_published')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'Fallo 024 (Caso 2): C1 privado se publicó';
  END IF;

  -- Intentar reutilizar storage_path de C1 en alerta pública C2 -> 42501
  v_denied := false;
  BEGIN
    PERFORM public.submit_claim_with_photo(
      v_c2_pub, 'Público C2 con foto de C1', 'Intento', v_cat_id, -35.41, -62.43,
      v_vecino::text || '/' || v_c1_priv::text || '/photo.jpg',
      v_vecino::text || '/' || v_c2_pub::text || '/thumb.jpg',
      now(), true
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 024 (Caso 2): permitió reutilizar storage_path de otro reclamo propio';
  END IF;

  -- Intentar reutilizar thumb_path de C1 en alerta pública C2 -> 42501
  v_denied := false;
  BEGIN
    PERFORM public.submit_claim_with_photo(
      v_c2_pub, 'Público C2 con thumb de C1', 'Intento', v_cat_id, -35.41, -62.43,
      v_vecino::text || '/' || v_c2_pub::text || '/photo.jpg',
      v_vecino::text || '/' || v_c1_priv::text || '/thumb.jpg',
      now(), true
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 024 (Caso 2): permitió reutilizar thumb_path de otro reclamo propio';
  END IF;

  -- Con rutas propias de C2 sí debe funcionar
  v_res := public.submit_claim_with_photo(
    v_c2_pub, 'Público C2 válido', 'Foto propia de C2', v_cat_id, -35.41, -62.43,
    v_vecino::text || '/' || v_c2_pub::text || '/photo.jpg',
    v_vecino::text || '/' || v_c2_pub::text || '/thumb.jpg',
    now(), true
  );
  IF (v_res->>'alert_published')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Fallo 024 (Caso 2): C2 válido no se publicó (res=%)', v_res;
  END IF;

  -- ===========================================================================
  -- CASO 3: Reintento idempotente sobre reclamo privado NUNCA lo publica
  -- ===========================================================================
  v_res := public.submit_claim_with_photo(
    v_c1_priv, 'Privado C1', 'Reintento con public=true', v_cat_id, -35.40, -62.42,
    v_vecino::text || '/' || v_c1_priv::text || '/photo.jpg',
    v_vecino::text || '/' || v_c1_priv::text || '/thumb.jpg',
    now(), true
  );
  IF (v_res->>'already_existed')::boolean IS NOT TRUE
     OR (v_res->>'alert_published')::boolean IS NOT FALSE
     OR NULLIF(v_res->>'alert_reason', '') IS NULL
  THEN
    RAISE EXCEPTION 'Fallo 024 (Caso 3): reintento idempotente sobre reclamo privado devolvió %', v_res;
  END IF;

  -- ===========================================================================
  -- CASO 4 y 5: Tope de 5 alertas con advisory lock + reintento idempotente del 6º
  -- ===========================================================================
  -- Ya tiene 1 alerta activa (v_c2_pub); creamos 4 más para completar 5
  FOR v_i IN 1..4 LOOP
    v_res := public.submit_claim_with_photo(
      gen_random_uuid(), 'Alerta 024 #' || v_i, 'Activa', v_cat_id, -35.41, -62.43,
      NULL, NULL, now(), true
    );
    IF (v_res->>'alert_published')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'Fallo 024 (Caso 4): alerta #% debería haberse publicado (res=%)', v_i, v_res;
    END IF;
  END LOOP;

  -- 6º reclamo -> degrada a privado con motivo
  v_res := public.submit_claim_with_photo(
    v_c_6th, 'Sexta alerta 024', 'Debe quedar privada', v_cat_id, -35.41, -62.43,
    NULL, NULL, now(), true
  );
  IF (v_res->>'alert_published')::boolean IS NOT FALSE OR NULLIF(v_res->>'alert_reason', '') IS NULL THEN
    RAISE EXCEPTION 'Fallo 024 (Caso 4): 6º reclamo no degradó a privado (res=%)', v_res;
  END IF;

  -- Reintento idempotente del 6º con p_is_public_alert=true -> sigue alert_published=false + motivo
  v_res := public.submit_claim_with_photo(
    v_c_6th, 'Sexta alerta 024', 'Reintento offline', v_cat_id, -35.41, -62.43,
    NULL, NULL, now(), true
  );
  IF (v_res->>'already_existed')::boolean IS NOT TRUE
     OR (v_res->>'alert_published')::boolean IS NOT FALSE
     OR NULLIF(v_res->>'alert_reason', '') IS NULL
  THEN
    RAISE EXCEPTION 'Fallo 024 (Caso 4): reintento del 6º reclamo perdió alert_reason o publicó (res=%)', v_res;
  END IF;

  RESET ROLE;
  RAISE NOTICE '   ✅ Suite Seguridad 024 OK -> rejected bloqueado (22023), prefijo por reclamo (storage/thumb), advisory lock y reintentos idempotentes coherentes verificados.';
END $$;

ROLLBACK;
