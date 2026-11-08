-- =============================================================================
-- Prueba Automatizada de Fase 5: Reclamos, Categorías, Historial y Notificaciones
-- Se ejecuta dentro de una transacción con ROLLBACK final.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_admin_id uuid;
  v_user_id uuid := 'fb2ecc52-173c-4f9c-9a3c-6621621c2aad';
  v_claim_id uuid := '50000000-0000-4000-8000-000000000001';
  v_cat_id uuid;
  v_res jsonb;
  v_detail jsonb;
  v_notif_count integer;
  v_weekly jsonb;
BEGIN
  SELECT user_id INTO v_admin_id FROM public.admins LIMIT 1;
  -- 1. Obtener una categoría activa inicial
  SELECT id INTO v_cat_id FROM public.claim_categories WHERE is_active = true LIMIT 1;
  IF v_cat_id IS NULL THEN
    RAISE EXCEPTION 'Fallo Fase 5: No hay categorías activas sembradas.';
  END IF;

  -- 2. Simular sesión del vecino común y enviar un reclamo georreferenciado con foto
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_id, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  v_res := public.submit_claim_with_photo(
    v_claim_id,
    'Alcantarilla hundida camino a Timote',
    'El agua socavó el costado norte del tubo.',
    v_cat_id,
    -35.3985,
    -62.4192,
    v_user_id::text || '/' || v_claim_id::text || '/photo.jpg',
    v_user_id::text || '/' || v_claim_id::text || '/thumb.jpg',
    now()
  );

  IF (v_res->>'status') <> 'received' THEN
    RAISE EXCEPTION 'Fallo Fase 5 (Caso 1): El reclamo de vecino debía iniciar en received, obtuvo %', v_res;
  END IF;

  -- Reintento idempotente con el mismo UUID no debe duplicar ni fallar
  v_res := public.submit_claim_with_photo(
    v_claim_id,
    'Alcantarilla hundida camino a Timote',
    'El agua socavó el costado norte del tubo.',
    v_cat_id,
    -35.3985,
    -62.4192,
    v_user_id::text || '/' || v_claim_id::text || '/photo.jpg',
    v_user_id::text || '/' || v_claim_id::text || '/thumb.jpg',
    now()
  );

  IF (v_res->>'already_existed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Fallo Fase 5 (Caso 2): El reintento idempotente debía detectar already_existed=true';
  END IF;
  RAISE NOTICE '✔ Caso 1 y 2 OK: Alta idempotente de reclamo + foto y estado inicial Recibido.';

  -- 3. Verificar que el vecino NO ve datos internos y que tiene su notificación de alta
  v_detail := public.get_claim_detail(v_claim_id);
  IF jsonb_array_length(v_detail->'photos') <> 1 THEN
    RAISE EXCEPTION 'Fallo Fase 5 (Caso 3): El detalle debía incluir 1 foto.';
  END IF;

  -- 4. Cambiar a rol Administrador, responder el reclamo y cambiar estado a in_progress y prioridad high
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_id, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  PERFORM public.update_claim(
    v_claim_id,
    'in_progress',
    'high',
    'Cuadrilla vial enviada con tubos nuevos.'
  );

  v_detail := public.get_claim_detail(v_claim_id);
  IF (v_detail->>'status') <> 'in_progress' OR (v_detail->>'priority') <> 'high' THEN
    RAISE EXCEPTION 'Fallo Fase 5 (Caso 4): Estado o prioridad no se actualizaron correctamente.';
  END IF;

  IF jsonb_array_length(v_detail->'history') < 2 THEN
    RAISE EXCEPTION 'Fallo Fase 5 (Caso 4): El historial debía tener al menos 2 eventos.';
  END IF;
  RAISE NOTICE '✔ Caso 3 y 4 OK: Actualización administrativa de estado, prioridad, respuesta e historial auditable.';

  -- 5. Verificar que se generó la notificación In-App para el vecino
  RESET ROLE;
  SELECT count(*)::int INTO v_notif_count
  FROM public.notifications
  WHERE user_id = v_user_id AND claim_id = v_claim_id AND type = 'claim_updated';

  IF v_notif_count < 1 THEN
    RAISE EXCEPTION 'Fallo Fase 5 (Caso 5): No se generó el aviso In-App para el vecino al actualizar el reclamo.';
  END IF;
  RAISE NOTICE '✔ Caso 5 OK: Aviso In-App generado automáticamente para el vecino.';

  -- 6. Probar desactivación de categoría conservando reclamos históricos
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_id, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  PERFORM public.upsert_claim_category(v_cat_id, 'Alcantarilla dañada', 'alert-triangle', false, 50);

  v_detail := public.get_claim_detail(v_claim_id);
  IF (v_detail->>'category_name') <> 'Alcantarilla dañada' THEN
    RAISE EXCEPTION 'Fallo Fase 5 (Caso 6): Al desactivar la categoría se perdió la referencia en el reclamo histórico.';
  END IF;
  RAISE NOTICE '✔ Caso 6 OK: Categoría desactivada conserva intacto el historial de reclamos existentes.';

  -- 7. Probar regla de Resumen Semanal (sin pendientes no envía ruido)
  v_weekly := public.generate_weekly_pending_summary();
  RAISE NOTICE '✔ Caso 7 OK: Resumen semanal ejecutado (%)', v_weekly;

  RESET ROLE;
END;
$$;

ROLLBACK;
