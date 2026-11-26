-- =============================================================================
-- Pruebas Automáticas de Permisos y RLS (Fase 1)
-- Verifica los 4 perfiles: Usuario A, Usuario B, Administrador y Anónimo.
-- Corre dentro de una transacción con ROLLBACK al final para no ensuciar datos.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_user_a uuid := '00000000-0000-4000-a000-00000000000a';
  v_user_b uuid := '00000000-0000-4000-a000-00000000000b';
  v_admin  uuid := '00000000-0000-4000-a000-0000000000ad';
  v_cat_id uuid;
  v_trip_a uuid := '11111111-1111-4111-a111-11111111111a';
  v_trip_b uuid := '11111111-1111-4111-a111-11111111111b';
  v_trip_adm uuid := '11111111-1111-4111-a111-1111111111ad';
  v_claim_a uuid := '22222222-2222-4222-a222-22222222222a';
  v_claim_b uuid := '22222222-2222-4222-a222-22222222222b';
  v_count integer;
  v_status text;
BEGIN
  -- 1. Preparar usuarios de prueba en auth.users (el trigger crea sus profiles)
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES
    (v_user_a, 'vecino_a@test.local', '{"full_name": "Vecino A"}'::jsonb),
    (v_user_b, 'vecino_b@test.local', '{"full_name": "Vecino B"}'::jsonb),
    (v_admin,  'admin_test@test.local', '{"full_name": "Admin Municipal"}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  -- Registrar a v_admin en la tabla admins
  INSERT INTO public.admins (user_id, created_by)
  VALUES (v_admin, v_admin)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT id INTO v_cat_id FROM public.claim_categories WHERE is_active = true LIMIT 1;
  IF v_cat_id IS NULL THEN
    RAISE EXCEPTION 'Fallo precondición: no hay categorías activas en claim_categories.';
  END IF;

  -- ===========================================================================
  -- CASO 1: Usuario A inserta recorrido y reclamo vía RPCs (escritura directa cerrada en 022)
  -- ===========================================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM public.submit_trip_with_track(
    v_trip_a,
    'Camino a Timote',
    now() - interval '30 minutes',
    now(),
    5200,
    1800,
    '[{"lat":-35.3928,"lon":-62.4208},{"lat":-35.4028,"lon":-62.4208}]'::jsonb
  );

  -- Verificar que el recorrido de Usuario A entró en estado 'pending'
  SELECT status INTO v_status FROM public.trips WHERE id = v_trip_a;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'Fallo RLS/Trigger: Usuario A insertó recorrido y quedó en % (esperado: pending)', v_status;
  END IF;

  PERFORM public.submit_claim_with_photo(
    v_claim_a,
    'Alcantarilla rota en bajada',
    'No se puede pasar con lluvia',
    v_cat_id,
    -35.3928,
    -62.4208
  );

  -- Verificar que el reclamo de Usuario A entró en estado 'received'
  SELECT status INTO v_status FROM public.claims WHERE id = v_claim_a;
  IF v_status <> 'received' THEN
    RAISE EXCEPTION 'Fallo RLS/Trigger: Usuario A insertó reclamo y quedó en %', v_status;
  END IF;

  -- Intentar que Usuario A cambie el estado de su propio reclamo (debe ser bloqueado por RLS: 0 filas afectadas)
  UPDATE public.claims SET status = 'solved' WHERE id = v_claim_a;
  SELECT status INTO v_status FROM public.claims WHERE id = v_claim_a;
  IF v_status <> 'received' THEN
    RAISE EXCEPTION 'Fallo RLS: Usuario A pudo cambiar el estado de su propio reclamo a %', v_status;
  END IF;

  -- ===========================================================================
  -- CASO 2: Usuario B inserta sus datos vía RPC y verificamos aislamiento entre A y B
  -- ===========================================================================
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_b::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM public.submit_trip_with_track(
    v_trip_b,
    'Camino Colonia Seré',
    now() - interval '20 minutes',
    now(),
    3100,
    1200,
    '[{"lat":-35.4100,"lon":-62.4500},{"lat":-35.4200,"lon":-62.4500}]'::jsonb
  );

  PERFORM public.submit_claim_with_photo(
    v_claim_b,
    'Pozo profundo',
    'Cerca de la escuela',
    v_cat_id,
    -35.4100,
    -62.4500
  );

  -- Usuario B NO debe ver el recorrido ni el reclamo ni el perfil de Usuario A
  SELECT count(*) INTO v_count FROM public.trips WHERE id = v_trip_a;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Fallo RLS: Usuario B pudo ver el recorrido de Usuario A';
  END IF;

  SELECT count(*) INTO v_count FROM public.claims WHERE id = v_claim_a;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Fallo RLS: Usuario B pudo ver el reclamo de Usuario A';
  END IF;

  SELECT count(*) INTO v_count FROM public.profiles WHERE id = v_user_a;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Fallo RLS: Usuario B pudo ver el perfil privado de Usuario A';
  END IF;

  -- ===========================================================================
  -- CASO 3: Anónimo (anon) no tiene acceso a nada
  -- ===========================================================================
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '{}', true);
  EXECUTE 'SET LOCAL ROLE anon';

  BEGIN
    SELECT count(*) INTO v_count FROM public.trips;
    IF v_count > 0 THEN
      RAISE EXCEPTION 'Fallo RLS: Anónimo pudo leer trips';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    -- Esperado: REVOKE ALL bloquea incluso el SELECT a anon
    NULL;
  END;

  -- ===========================================================================
  -- CASO 4: Administrador ve todo, sus recorridos entran approved y audita cambios
  -- ===========================================================================
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- El recorrido de un administrador debe entrar automáticamente como 'approved'
  PERFORM public.submit_trip_with_track(
    v_trip_adm,
    'Relevamiento Municipal Ruta 226',
    now() - interval '40 minutes',
    now(),
    12000,
    2400,
    '[{"lat":-35.3800,"lon":-62.4100},{"lat":-35.3900,"lon":-62.4100}]'::jsonb
  );

  SELECT status INTO v_status FROM public.trips WHERE id = v_trip_adm;
  IF v_status <> 'approved' THEN
    RAISE EXCEPTION 'Fallo Trigger Admin: El recorrido del administrador entró como % en vez de approved', v_status;
  END IF;

  -- Admin debe ver los recorridos de A, B y el suyo
  SELECT count(*) INTO v_count FROM public.trips WHERE id IN (v_trip_a, v_trip_b, v_trip_adm);
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'Fallo RLS Admin: El administrador vio % recorridos en vez de 3', v_count;
  END IF;

  -- Admin aprueba el recorrido de Usuario A vía RPC y verifica audit_log
  PERFORM public.review_trip(v_trip_a, 'approved', 'Verificado contra traza satelital');

  SELECT status INTO v_status FROM public.trips WHERE id = v_trip_a;
  IF v_status <> 'approved' THEN
    RAISE EXCEPTION 'Fallo RPC review_trip: El estado no cambió a approved';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.audit_log
  WHERE table_name = 'trips' AND record_id = v_trip_a::text AND actor_id = v_admin;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'Fallo Auditoría: review_trip no dejó registro en audit_log';
  END IF;

  RESET ROLE;
  RAISE NOTICE '✅ TODAS LAS PRUEBAS DE PERMISOS (USUARIO A, USUARIO B, ANÓNIMO, ADMIN) PASARON EXITOSAMENTE.';
END;
$$;

ROLLBACK;
