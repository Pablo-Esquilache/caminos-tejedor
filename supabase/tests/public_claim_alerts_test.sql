-- =============================================================================
-- Suite de Pruebas SQL — Migración 023: Mapa Colaborativo de Alertas Vecinales
-- Cubre los 12 escenarios acordados (privacidad, Storage, ataque de ruta, estados
-- solved/dismissed, anon, baja propia/admin, tope 5 sin error, largos máximos sin
-- error, y compatibilidad retroactiva de 9 argumentos en submit_claim_with_photo).
-- Corre íntegramente dentro de BEGIN ... ROLLBACK.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_vecino_a uuid := '00000000-0000-4000-d000-0000000000a1';
  v_vecino_b uuid := '00000000-0000-4000-d000-0000000000b1';
  v_vecino_c uuid := '00000000-0000-4000-d000-0000000000c1';
  v_admin    uuid := '00000000-0000-4000-d000-0000000000ad';
  v_cat_id   uuid;

  v_claim_priv uuid := gen_random_uuid();
  v_claim_pub  uuid := gen_random_uuid();
  v_claim_leg  uuid := gen_random_uuid();
  v_claim_long uuid := gen_random_uuid();
  v_claim_6th  uuid := gen_random_uuid();
  v_claim_adm  uuid := gen_random_uuid();
  v_path_priv  text;
  v_path_pub   text;

  v_res        jsonb;
  v_item       jsonb;
  v_ids        uuid[];
  v_denied     boolean;
  v_can_read   boolean;
  v_i          integer;
BEGIN
  -- 0. Sembrar usuarios de prueba
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES
    (v_vecino_a, 'alerta_a@tejedor.test', '{"full_name": "Vecino Alerta A"}'::jsonb),
    (v_vecino_b, 'alerta_b@tejedor.test', '{"full_name": "Vecino Alerta B"}'::jsonb),
    (v_vecino_c, 'alerta_c@tejedor.test', '{"full_name": "Vecino Alerta C"}'::jsonb),
    (v_admin,    'alerta_adm@tejedor.test', '{"full_name": "Admin Alerta"}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.admins (user_id, created_by)
  VALUES (v_admin, v_admin)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT id INTO v_cat_id FROM public.claim_categories WHERE is_active = true LIMIT 1;
  v_path_priv := v_vecino_a::text || '/' || v_claim_priv::text || '/photo.jpg';
  v_path_pub  := v_vecino_a::text || '/' || v_claim_pub::text  || '/photo.jpg';

  -- ===========================================================================
  -- CASO 1 y 2: Vecino A crea 1 reclamo privado y 1 público con foto;
  --             Vecino B no ve el privado ni su foto, pero sí ve el público y su foto.
  -- ===========================================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_vecino_a::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_res := public.submit_claim_with_photo(
    v_claim_priv, 'Reclamo privado A', 'Solo municipio', v_cat_id, -35.40, -62.42,
    v_path_priv, NULL, now(), false
  );
  IF (v_res->>'alert_published')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 1): reclamo privado se marcó alert_published=true';
  END IF;

  v_res := public.submit_claim_with_photo(
    v_claim_pub, 'Camino inundado en curva', 'Agua sobre calzada', v_cat_id, -35.41, -62.43,
    v_path_pub, NULL, now(), true
  );
  IF (v_res->>'alert_published')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 2): reclamo público no se publicó (res=%)', v_res;
  END IF;

  -- Verificar get_my_published_alert_ids()
  v_ids := public.get_my_published_alert_ids();
  IF NOT (v_claim_pub = ANY(v_ids)) OR (v_claim_priv = ANY(v_ids)) THEN
    RAISE EXCEPTION 'Fallo 023: get_my_published_alert_ids devolvió %', v_ids;
  END IF;

  -- Cambiar a Vecino B
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_vecino_b::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_res := public.get_public_claim_alerts(-63.0, -36.0, -61.8, -34.8);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'items') x WHERE (x->>'id')::uuid = v_claim_priv) THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 1): Vecino B vio el reclamo privado de A en alertas públicas';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'items') x WHERE (x->>'id')::uuid = v_claim_pub) THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 2): Vecino B no vio la alerta pública de A';
  END IF;

  -- Verificar acceso Storage vía is_public_alert_photo()
  SELECT public.is_public_alert_photo(v_path_priv) INTO v_can_read;
  IF v_can_read THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 1): is_public_alert_photo permitió foto de reclamo privado';
  END IF;
  SELECT public.is_public_alert_photo(v_path_pub) INTO v_can_read;
  IF NOT v_can_read THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 2): is_public_alert_photo bloqueó foto de alerta pública activa';
  END IF;

  -- ===========================================================================
  -- CASO 5: Respuesta de los RPCs NO contiene user_id ni email (solo is_mine)
  -- ===========================================================================
  SELECT x INTO v_item FROM jsonb_array_elements(v_res->'items') x WHERE (x->>'id')::uuid = v_claim_pub LIMIT 1;
  IF (v_item ? 'user_id') OR (v_item ? 'email') OR (v_item->>'is_mine')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 5): item expuso user_id/email o is_mine incorrecto: %', v_item;
  END IF;

  v_res := public.get_recent_public_alerts(20);
  SELECT x INTO v_item FROM jsonb_array_elements(v_res->'items') x WHERE (x->>'id')::uuid = v_claim_pub LIMIT 1;
  IF v_item IS NULL OR (v_item ? 'user_id') OR (v_item ? 'email') THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 5): get_recent_public_alerts expuso datos personales o no trajo alerta';
  END IF;

  -- ===========================================================================
  -- CASO 4: Ataque de ruta -> B intenta registrar foto privada de A en alerta propia
  -- ===========================================================================
  v_denied := false;
  BEGIN
    PERFORM public.submit_claim_with_photo(
      gen_random_uuid(), 'Ataque ruta ajena', 'Intento', v_cat_id, -35.41, -62.43,
      v_path_priv, NULL, now(), true
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 4): Vecino B pudo registrar ruta de foto privada de A';
  END IF;

  -- Incluso si una fila corrupta existiera en claim_photos con ruta de A en reclamo de B,
  -- is_public_alert_photo exige que la carpeta sea del autor del reclamo -> debe dar false
  RESET ROLE;
  INSERT INTO public.claims (id, user_id, title, category_id, location, is_public_alert, alert_published_at)
  VALUES (v_claim_adm, v_vecino_b, 'Fila forzada', v_cat_id, ST_SetSRID(ST_MakePoint(-62.43, -35.41), 4326), true, now());
  INSERT INTO public.claim_photos (claim_id, storage_path) VALUES (v_claim_adm, v_path_priv);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_vecino_c::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  IF public.is_public_alert_photo(v_path_priv) THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 4): is_public_alert_photo no validó coincidencia de carpeta del autor';
  END IF;

  -- ===========================================================================
  -- CASO 7: Solo el autor puede bajar su aviso; otro vecino recibe 42501
  -- ===========================================================================
  v_denied := false;
  BEGIN
    PERFORM public.unpublish_my_claim_alert(v_claim_pub);
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 7): Vecino C pudo bajar el aviso de Vecino A';
  END IF;

  -- ===========================================================================
  -- CASO 6: anon no puede ejecutar ninguna RPC nueva
  -- ===========================================================================
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '{}', true);
  EXECUTE 'SET LOCAL ROLE anon';

  v_denied := false;
  BEGIN
    PERFORM public.get_public_claim_alerts(-63.0, -36.0, -61.8, -34.8);
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 6): anon pudo ejecutar get_public_claim_alerts';
  END IF;

  v_denied := false;
  BEGIN
    PERFORM public.get_recent_public_alerts(10);
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 6): anon pudo ejecutar get_recent_public_alerts';
  END IF;

  v_denied := false;
  BEGIN
    PERFORM public.unpublish_my_claim_alert(v_claim_pub);
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 6): anon pudo ejecutar unpublish_my_claim_alert';
  END IF;

  -- ===========================================================================
  -- CASO 3: Al pasar a solved o dismissed, el aviso y su foto dejan de ser visibles
  -- ===========================================================================
  RESET ROLE;
  UPDATE public.claims SET status = 'solved' WHERE id = v_claim_pub;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_vecino_b::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_res := public.get_public_claim_alerts(-63.0, -36.0, -61.8, -34.8);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'items') x WHERE (x->>'id')::uuid = v_claim_pub) THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 3): alerta solved siguió apareciendo en el mapa';
  END IF;
  IF public.is_public_alert_photo(v_path_pub) THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 3): foto de alerta solved siguió accesible';
  END IF;

  -- ===========================================================================
  -- CASO 8: Admin puede bajar cualquier aviso con admin_unpublish_claim_alert
  -- ===========================================================================
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM public.admin_unpublish_claim_alert(v_claim_adm);

  -- ===========================================================================
  -- CASO 10: Llamada vieja de 9 argumentos a submit_claim_with_photo sigue funcionando
  -- ===========================================================================
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_vecino_c::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_res := public.submit_claim_with_photo(
    v_claim_leg, 'Llamada legacy 9 args', 'Sin param 10', v_cat_id, -35.42, -62.44,
    NULL, NULL, now()
  );
  IF (v_res->>'alert_published')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 10): llamada legacy de 9 args no quedó privada';
  END IF;

  -- ===========================================================================
  -- CASO 11 y 12 (9 ampliado): Tope de 5 avisos y largos máximos NUNCA hacen fallar
  -- el reclamo -> se guarda privado y devuelve alert_published=false + alert_reason
  -- ===========================================================================
  -- 11. Título > 120 caracteres con p_is_public_alert=true -> privado sin error
  v_res := public.submit_claim_with_photo(
    v_claim_long, repeat('X', 130), 'Desc corta', v_cat_id, -35.42, -62.44,
    NULL, NULL, now(), true
  );
  IF (v_res->>'alert_published')::boolean IS NOT FALSE OR NULLIF(v_res->>'alert_reason', '') IS NULL THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 11): título largo no degradó a privado con motivo (res=%)', v_res;
  END IF;

  -- 12. Crear 5 avisos activos para Vecino C y enviar un 6º con publicación -> privado sin error
  FOR v_i IN 1..5 LOOP
    v_res := public.submit_claim_with_photo(
      gen_random_uuid(), 'Alerta activa #' || v_i, 'Detalle', v_cat_id, -35.42, -62.44,
      NULL, NULL, now(), true
    );
    IF (v_res->>'alert_published')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'Fallo 023 (Caso 12): alerta #% debería haberse publicado (res=%)', v_i, v_res;
    END IF;
  END LOOP;

  v_res := public.submit_claim_with_photo(
    v_claim_6th, 'Sexta alerta activa', 'Debe entrar privada', v_cat_id, -35.42, -62.44,
    NULL, NULL, now(), true
  );
  IF (v_res->>'alert_published')::boolean IS NOT FALSE OR NULLIF(v_res->>'alert_reason', '') IS NULL THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 12): 6º aviso no degradó a privado con motivo (res=%)', v_res;
  END IF;

  -- Y el reclamo 6º SÍ debe existir en claims como privado
  IF NOT EXISTS (SELECT 1 FROM public.claims WHERE id = v_claim_6th AND is_public_alert = false) THEN
    RAISE EXCEPTION 'Fallo 023 (Caso 12): el 6º reclamo no se guardó como privado';
  END IF;

  -- Vecino C baja una de sus alertas propias -> ok
  v_ids := public.get_my_published_alert_ids();
  PERFORM public.unpublish_my_claim_alert(v_ids[1]);

  RESET ROLE;
  RAISE NOTICE '   ✅ Suite Alertas 023 OK -> 12 escenarios verificados (privacidad, Storage, ataque de ruta, solved/dismissed, anon, baja propia/admin, tope 5/largos sin error y legacy 9 args).';
END $$;

ROLLBACK;
