-- =============================================================================
-- Migración 024: Cierre pre-piloto (bloqueo de rejected, lock de alertas,
--                prefijo de foto por reclamo y reintento idempotente coherente)
-- =============================================================================
-- Cambios puntuales (sin DROP ni cambio de firmas -> conserva GRANTs vigentes):
--   1. operator_submit_session(): copia exacta de la 022 cambiando únicamente
--      la lista de estados permitidos a ('planned', 'in_progress', 'suspended'),
--      bloqueando 'rejected' con SQLSTATE '22023'.
--   2. submit_claim_with_photo(): copia de la 023 con 3 ajustes puntuales:
--      a) Prefijo estricto ${auth.uid()}/${p_claim_id}/ en storage_path y thumb_path
--         para usuarios no-admin (impide reutilizar fotos privadas entre reclamos propios).
--      b) pg_advisory_xact_lock(hashtextextended('claim_alert:' || v_user_id::text, 0))
--         en la rama de reclamo nuevo justo antes del count(*) del tope de 5 alertas.
--      c) En la rama idempotente (reclamo ya existente), nunca publica el reclamo y,
--         si el cliente pidió publicar pero quedó privado, devuelve alert_reason.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. operator_submit_session(): bloquea 'rejected' en PostgreSQL (22023)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.operator_submit_session(
  p_session_id uuid,
  p_intervention_id uuid DEFAULT NULL,
  p_action text DEFAULT 'submit',
  p_execution_mode text DEFAULT 'linear',
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_started_at timestamptz DEFAULT now(),
  p_ended_at timestamptz DEFAULT now(),
  p_raw_points jsonb DEFAULT '[]'::jsonb,
  p_raw_distance_m numeric DEFAULT 0,
  p_duration_s integer DEFAULT 0,
  p_punctual_lat double precision DEFAULT NULL,
  p_punctual_lon double precision DEFAULT NULL,
  p_work_type_ids uuid[] DEFAULT NULL,
  p_machine_ids uuid[] DEFAULT NULL,
  p_participant_operator_ids uuid[] DEFAULT NULL,
  p_linked_claim_id uuid DEFAULT NULL,
  p_photo_paths jsonb DEFAULT '[]'::jsonb,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_op_id uuid;
  v_is_adm boolean;
  v_int public.interventions;
  v_existing_sess public.intervention_sessions;
  v_int_id uuid;
  v_raw_geom geometry;
  v_pt_count integer;
  v_invalid_coords integer;
  v_photo_count integer;
  v_new_status text;
  v_old_status text;
  v_has_access boolean;
  v_is_unassigned boolean;
  v_expected_prefix text;
  v_ph jsonb;
  v_ph_storage text;
  v_ph_thumb text;
  v_wid uuid;
  v_mid uuid;
  v_oid uuid;
  v_admin record;
  v_resp_name text;
BEGIN
  v_user_id := auth.uid();
  v_op_id := public.get_my_operator_id();
  v_is_adm := public.is_admin();

  IF v_user_id IS NULL OR (v_op_id IS NULL AND NOT v_is_adm) THEN
    RAISE EXCEPTION 'Permiso denegado: solo operarios activos o administradores pueden registrar trabajos.' USING ERRCODE = '42501';
  END IF;

  IF p_action NOT IN ('suspend', 'submit') THEN
    RAISE EXCEPTION 'Acción inválida (debe ser suspend o submit).';
  END IF;

  IF p_execution_mode NOT IN ('linear', 'punctual') THEN
    RAISE EXCEPTION 'Modo de ejecución inválido.';
  END IF;

  -- Idempotencia segura: verificar propiedad antes de devolver estado existente
  SELECT * INTO v_existing_sess
  FROM public.intervention_sessions
  WHERE id = p_session_id;

  IF FOUND THEN
    IF NOT v_is_adm
       AND v_existing_sess.user_id IS DISTINCT FROM v_user_id
       AND (v_op_id IS NULL OR v_existing_sess.operator_id IS DISTINCT FROM v_op_id)
    THEN
      RAISE EXCEPTION 'Permiso denegado: la sesión pertenece a otro operario.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_int
    FROM public.interventions
    WHERE id = v_existing_sess.intervention_id;

    RETURN jsonb_build_object(
      'ok', true,
      'already_processed', true,
      'intervention_id', v_int.id,
      'status', v_int.status,
      'worked_length_m', v_int.worked_length_m
    );
  END IF;

  -- Coherencia temporal
  IF p_started_at IS NULL OR p_ended_at IS NULL OR p_ended_at < p_started_at THEN
    RAISE EXCEPTION 'Fechas de jornada inválidas (la fecha de fin no puede ser anterior al inicio).';
  END IF;

  -- Validar fotos (máximo 3 y prefijo de carpeta propia para no-admins)
  v_expected_prefix := v_user_id::text || '/';
  IF p_photo_paths IS NOT NULL AND jsonb_typeof(p_photo_paths) = 'array' THEN
    v_photo_count := jsonb_array_length(p_photo_paths);
    IF v_photo_count > 3 THEN
      RAISE EXCEPTION 'Máximo 3 fotografías permitidas por jornada.';
    END IF;

    IF NOT v_is_adm THEN
      FOR v_ph IN SELECT * FROM jsonb_array_elements(p_photo_paths) LOOP
        v_ph_storage := NULLIF(btrim(COALESCE(v_ph->>'storage_path', '')), '');
        v_ph_thumb   := NULLIF(btrim(COALESCE(v_ph->>'thumb_path', '')), '');

        IF v_ph_storage IS NOT NULL AND (
          left(v_ph_storage, length(v_expected_prefix)) <> v_expected_prefix
          OR position('..' in v_ph_storage) > 0
        ) THEN
          RAISE EXCEPTION 'Permiso denegado: la ruta de fotografía no pertenece al usuario autenticado.' USING ERRCODE = '42501';
        END IF;

        IF v_ph_thumb IS NOT NULL AND (
          left(v_ph_thumb, length(v_expected_prefix)) <> v_expected_prefix
          OR position('..' in v_ph_thumb) > 0
        ) THEN
          RAISE EXCEPTION 'Permiso denegado: la ruta de miniatura no pertenece al usuario autenticado.' USING ERRCODE = '42501';
        END IF;
      END LOOP;
    END IF;
  END IF;

  -- Construir geometría de la jornada con tope de 20.000 puntos
  IF p_execution_mode = 'linear' THEN
    IF p_raw_points IS NULL OR jsonb_typeof(p_raw_points) <> 'array' THEN
      RAISE EXCEPTION 'Un trabajo lineal requiere un arreglo de puntos GPS válidos.';
    END IF;
    v_pt_count := jsonb_array_length(p_raw_points);
    IF v_pt_count < 2 OR v_pt_count > 20000 THEN
      RAISE EXCEPTION 'Cantidad de puntos GPS fuera de rango permitido (2 a 20000).';
    END IF;

    SELECT count(*) INTO v_invalid_coords
    FROM jsonb_array_elements(p_raw_points) AS pt
    WHERE (pt->>'lat') IS NULL
       OR (pt->>'lon') IS NULL
       OR (pt->>'lat')::double precision < -90
       OR (pt->>'lat')::double precision > 90
       OR (pt->>'lon')::double precision < -180
       OR (pt->>'lon')::double precision > 180;

    IF v_invalid_coords > 0 THEN
      RAISE EXCEPTION 'La jornada contiene coordenadas GPS fuera de rango válido.';
    END IF;

    SELECT ST_SetSRID(
      ST_MakeLine(
        ARRAY(
          SELECT ST_MakePoint((pt->>'lon')::double precision, (pt->>'lat')::double precision)
          FROM jsonb_array_elements(p_raw_points) WITH ORDINALITY AS t(pt, ord)
          ORDER BY ord
        )
      ),
      4326
    ) INTO v_raw_geom;
  ELSE
    IF p_punctual_lat IS NULL OR p_punctual_lon IS NULL
       OR p_punctual_lat < -90 OR p_punctual_lat > 90
       OR p_punctual_lon < -180 OR p_punctual_lon > 180
    THEN
      RAISE EXCEPTION 'Una tarea puntual requiere coordenadas GPS válidas.';
    END IF;
    v_raw_geom := ST_SetSRID(ST_MakePoint(p_punctual_lon, p_punctual_lat), 4326);
  END IF;

  v_new_status := CASE WHEN p_action = 'suspend' THEN 'suspended' ELSE 'pending_approval' END;

  -- Determinar si se asocia a tarea existente (bloqueo atómico FOR UPDATE) o es espontánea nueva
  IF p_intervention_id IS NOT NULL THEN
    SELECT * INTO v_int
    FROM public.interventions
    WHERE id = p_intervention_id
    FOR UPDATE;
  END IF;

  IF v_int.id IS NULL THEN
    -- Crear intervención espontánea con ID fijo si vino p_intervention_id (idempotente) o uno nuevo
    v_int_id := COALESCE(p_intervention_id, gen_random_uuid());
    INSERT INTO public.interventions (
      id, title, description, execution_mode, origin, status, priority,
      definition_mode, responsible_operator_id, linked_claim_id,
      started_at, completed_at, created_by
    ) VALUES (
      v_int_id,
      COALESCE(NULLIF(btrim(COALESCE(p_title, '')), ''), 'Trabajo vial espontáneo'),
      NULLIF(btrim(COALESCE(p_description, '')), ''),
      p_execution_mode,
      'spontaneous',
      v_new_status,
      'medium',
      CASE WHEN p_execution_mode = 'linear' THEN 'gps_field' ELSE 'punctual_point' END,
      v_op_id,
      p_linked_claim_id,
      p_started_at,
      CASE WHEN p_action = 'submit' THEN p_ended_at ELSE NULL END,
      v_user_id
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING * INTO v_int;

    IF v_int.id IS NULL THEN
      SELECT * INTO v_int FROM public.interventions WHERE id = v_int_id FOR UPDATE;
    END IF;
    v_old_status := NULL;
  ELSE
    -- Máquina de estados: solo planned, in_progress o suspended
    -- (bloquea pending_approval, approved y rejected; la reapertura es exclusiva del Admin)
    IF v_int.status NOT IN ('planned', 'in_progress', 'suspended') THEN
      RAISE EXCEPTION 'No se puede registrar trabajo sobre una intervención en estado %.', v_int.status USING ERRCODE = '22023';
    END IF;

    -- Autorización: asignado al operario o tarea abierta sin asignar (admin siempre habilitado)
    IF NOT v_is_adm THEN
      v_has_access := (
        v_int.responsible_operator_id = v_op_id
        OR EXISTS (
          SELECT 1 FROM public.intervention_operators io
          WHERE io.intervention_id = v_int.id AND io.operator_id = v_op_id
        )
      );
      v_is_unassigned := (
        v_int.responsible_operator_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.intervention_operators io
          WHERE io.intervention_id = v_int.id
        )
      );

      IF NOT v_has_access AND NOT v_is_unassigned THEN
        RAISE EXCEPTION 'Permiso denegado: la intervención está asignada a otro operario.' USING ERRCODE = '42501';
      END IF;
    END IF;

    v_int_id := v_int.id;
    v_old_status := v_int.status;

    UPDATE public.interventions
    SET
      status = v_new_status,
      responsible_operator_id = COALESCE(responsible_operator_id, v_op_id),
      linked_claim_id = COALESCE(p_linked_claim_id, linked_claim_id),
      started_at = COALESCE(started_at, p_started_at),
      completed_at = CASE WHEN p_action = 'submit' THEN p_ended_at ELSE completed_at END,
      updated_at = now()
    WHERE id = v_int_id;
  END IF;

  -- Actualizar tipos de trabajo / máquinas / participantes si el operario los especificó
  IF p_work_type_ids IS NOT NULL AND array_length(p_work_type_ids, 1) IS NOT NULL THEN
    FOREACH v_wid IN ARRAY p_work_type_ids LOOP
      INSERT INTO public.intervention_work_types (intervention_id, work_type_id)
      VALUES (v_int_id, v_wid)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  IF p_machine_ids IS NOT NULL AND array_length(p_machine_ids, 1) IS NOT NULL THEN
    FOREACH v_mid IN ARRAY p_machine_ids LOOP
      INSERT INTO public.intervention_machines (intervention_id, machine_id)
      VALUES (v_int_id, v_mid)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  IF v_op_id IS NOT NULL THEN
    INSERT INTO public.intervention_operators (intervention_id, operator_id, is_responsible)
    VALUES (v_int_id, v_op_id, true)
    ON CONFLICT (intervention_id, operator_id) DO NOTHING;
  END IF;

  IF p_participant_operator_ids IS NOT NULL AND array_length(p_participant_operator_ids, 1) IS NOT NULL THEN
    FOREACH v_oid IN ARRAY p_participant_operator_ids LOOP
      INSERT INTO public.intervention_operators (intervention_id, operator_id, is_responsible)
      VALUES (v_int_id, v_oid, false)
      ON CONFLICT (intervention_id, operator_id) DO NOTHING;
    END LOOP;
  END IF;

  -- Insertar la jornada en intervention_sessions
  INSERT INTO public.intervention_sessions (
    id, intervention_id, operator_id, user_id, started_at, ended_at,
    raw_points, raw_geom, raw_distance_m, duration_s, notes
  ) VALUES (
    p_session_id,
    v_int_id,
    v_op_id,
    v_user_id,
    p_started_at,
    p_ended_at,
    CASE WHEN p_execution_mode = 'linear' THEN p_raw_points ELSE jsonb_build_array(jsonb_build_object('lat', p_punctual_lat, 'lon', p_punctual_lon)) END,
    v_raw_geom,
    CASE WHEN p_execution_mode = 'linear' THEN ROUND(COALESCE(NULLIF(p_raw_distance_m, 0), ST_Length(ST_Transform(v_raw_geom, 32720)))::numeric, 2) ELSE 0 END,
    GREATEST(COALESCE(p_duration_s, 0), 0),
    NULLIF(btrim(COALESCE(p_notes, '')), '')
  );

  -- Insertar fotos asociadas si se enviaron
  IF p_photo_paths IS NOT NULL AND jsonb_typeof(p_photo_paths) = 'array' THEN
    FOR v_ph IN SELECT * FROM jsonb_array_elements(p_photo_paths) LOOP
      v_ph_storage := NULLIF(btrim(COALESCE(v_ph->>'storage_path', '')), '');
      v_ph_thumb   := NULLIF(btrim(COALESCE(v_ph->>'thumb_path', '')), '');
      IF v_ph_storage IS NOT NULL THEN
        INSERT INTO public.intervention_photos (
          intervention_id, session_id, storage_path, thumb_path, uploaded_by
        ) VALUES (
          v_int_id,
          p_session_id,
          v_ph_storage,
          v_ph_thumb,
          v_user_id
        )
        ON CONFLICT (intervention_id, storage_path) DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  -- Recalcular métricas netas y geometría trabajada deduplicada (Fase 12)
  PERFORM public.recalculate_intervention_worked_metrics(v_int_id);
  SELECT * INTO v_int FROM public.interventions WHERE id = v_int_id;

  -- Registrar historial de la acción
  INSERT INTO public.intervention_history (intervention_id, changed_by, action, old_status, new_status, message)
  VALUES (
    v_int_id,
    v_user_id,
    CASE WHEN p_action = 'suspend' THEN 'suspended' ELSE 'submitted' END,
    v_old_status,
    v_new_status,
    CASE WHEN p_action = 'suspend'
      THEN 'Jornada pausada ("Terminar por hoy"). Sesiones acumuladas: ' || v_int.sessions_count || '.'
      ELSE 'Trabajo finalizado y enviado a validación municipal.'
    END || CASE WHEN p_notes IS NOT NULL AND btrim(p_notes) <> '' THEN ' Notas: ' || p_notes ELSE '' END
  );

  -- Notificar a los administradores cuando el operario envía un trabajo terminado para validar
  IF p_action = 'submit' THEN
    SELECT full_name INTO v_resp_name FROM public.operators WHERE id = v_op_id;
    FOR v_admin IN SELECT user_id FROM public.admins WHERE user_id <> v_user_id LOOP
      INSERT INTO public.notifications (user_id, type, title, body)
      VALUES (
        v_admin.user_id,
        'intervention_submitted',
        'Trabajo vial pendiente de validación: ' || v_int.title,
        COALESCE(v_resp_name, 'Personal municipal') || ' finalizó una intervención' ||
        CASE WHEN v_int.execution_mode = 'linear'
          THEN ' (' || ROUND((v_int.worked_length_m / 1000.0)::numeric, 2) || ' km netos trabajados).'
          ELSE ' (tarea puntual con respaldo georreferenciado).'
        END
      );
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'already_processed', false,
    'intervention_id', v_int.id,
    'status', v_int.status,
    'worked_length_m', v_int.worked_length_m,
    'sessions_count', v_int.sessions_count
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. submit_claim_with_photo(): prefijo por reclamo, advisory lock y reintento
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_claim_with_photo(
  p_claim_id uuid,
  p_title text,
  p_description text,
  p_category_id uuid,
  p_lat double precision,
  p_lon double precision,
  p_storage_path text DEFAULT NULL,
  p_thumb_path text DEFAULT NULL,
  p_created_at timestamptz DEFAULT now(),
  p_is_public_alert boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_is_adm boolean;
  v_owner_id uuid;
  v_exists boolean;
  v_cat_active boolean;
  v_clean_title text;
  v_clean_desc text;
  v_clean_storage text;
  v_clean_thumb text;
  v_expected_prefix text;
  v_status text;
  v_active_alerts integer;
  v_publish boolean := false;
  v_published_at timestamptz := NULL;
  v_alert_reason text := NULL;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Debés iniciar sesión para enviar un reclamo.' USING ERRCODE = '42501';
  END IF;

  v_is_adm := public.is_admin();

  IF p_lat IS NULL OR p_lon IS NULL OR p_lat < -90 OR p_lat > 90 OR p_lon < -180 OR p_lon > 180 THEN
    RAISE EXCEPTION 'Coordenadas GPS fuera de rango válido.';
  END IF;

  v_clean_storage := NULLIF(btrim(COALESCE(p_storage_path, '')), '');
  v_clean_thumb   := NULLIF(btrim(COALESCE(p_thumb_path, '')), '');
  v_expected_prefix := v_user_id::text || '/' || p_claim_id::text || '/';

  IF NOT v_is_adm THEN
    IF v_clean_storage IS NOT NULL AND (
      left(v_clean_storage, length(v_expected_prefix)) <> v_expected_prefix
      OR position('..' in v_clean_storage) > 0
    ) THEN
      RAISE EXCEPTION 'Permiso denegado: la ruta de fotografía no corresponde a este reclamo del usuario autenticado.' USING ERRCODE = '42501';
    END IF;

    IF v_clean_thumb IS NOT NULL AND (
      left(v_clean_thumb, length(v_expected_prefix)) <> v_expected_prefix
      OR position('..' in v_clean_thumb) > 0
    ) THEN
      RAISE EXCEPTION 'Permiso denegado: la ruta de miniatura no corresponde a este reclamo del usuario autenticado.' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT user_id, is_public_alert
  INTO v_owner_id, v_publish
  FROM public.claims
  WHERE id = p_claim_id;
  v_exists := FOUND;

  IF v_exists THEN
    IF v_owner_id <> v_user_id AND NOT v_is_adm THEN
      RAISE EXCEPTION 'Permiso denegado: el reclamo pertenece a otro usuario.' USING ERRCODE = '42501';
    END IF;

    -- El reintento idempotente NUNCA publica un reclamo ya existente;
    -- informa motivo coherente si el cliente pidió publicar pero quedó privado.
    IF COALESCE(p_is_public_alert, false) = true AND COALESCE(v_publish, false) = false THEN
      v_alert_reason := 'Tu reclamo ya estaba guardado para la municipalidad en modo privado (no publicado como alerta en el mapa).';
    END IF;
  ELSE
    SELECT is_active INTO v_cat_active
    FROM public.claim_categories
    WHERE id = p_category_id;

    IF v_cat_active IS DISTINCT FROM true AND NOT v_is_adm THEN
      RAISE EXCEPTION 'La categoría seleccionada ya no se encuentra activa.';
    END IF;

    v_clean_title := COALESCE(NULLIF(btrim(p_title), ''), 'Reclamo en camino rural');
    v_clean_desc  := NULLIF(btrim(COALESCE(p_description, '')), '');

    -- Reglas de publicación de alerta comunitaria: NUNCA hacen fallar el reclamo.
    -- Si no cumple tope o largos máximos, se guarda como privado y se informa motivo.
    v_publish := false;
    v_published_at := NULL;
    v_alert_reason := NULL;

    IF COALESCE(p_is_public_alert, false) = true THEN
      IF char_length(v_clean_title) > 120 OR char_length(COALESCE(v_clean_desc, '')) > 600 THEN
        v_alert_reason := 'El título (máx. 120 caracteres) o la descripción (máx. 600 caracteres) exceden el límite para alertas públicas; tu reclamo igual se envió al municipio de forma privada.';
      ELSE
        -- Serializar publicaciones concurrentes del mismo vecino dentro de la transacción
        PERFORM pg_advisory_xact_lock(hashtextextended('claim_alert:' || v_user_id::text, 0));

        SELECT count(*) INTO v_active_alerts
        FROM public.claims
        WHERE user_id = v_user_id
          AND is_public_alert = true
          AND status IN ('received', 'evaluating', 'in_progress');

        IF v_active_alerts >= 5 THEN
          v_alert_reason := 'Alcanzaste el máximo de 5 alertas públicas activas; tu reclamo igual se envió al municipio de forma privada.';
        ELSE
          v_publish := true;
          v_published_at := now();
        END IF;
      END IF;
    END IF;

    INSERT INTO public.claims (
      id,
      user_id,
      title,
      description,
      category_id,
      location,
      created_at,
      is_public_alert,
      alert_published_at
    ) VALUES (
      p_claim_id,
      v_user_id,
      v_clean_title,
      v_clean_desc,
      p_category_id,
      ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326),
      COALESCE(p_created_at, now()),
      v_publish,
      v_published_at
    );
  END IF;

  IF v_clean_storage IS NOT NULL THEN
    INSERT INTO public.claim_photos (
      claim_id,
      storage_path,
      thumb_path
    ) VALUES (
      p_claim_id,
      v_clean_storage,
      v_clean_thumb
    )
    ON CONFLICT (claim_id, storage_path) DO UPDATE
      SET thumb_path = COALESCE(EXCLUDED.thumb_path, public.claim_photos.thumb_path);
  END IF;

  SELECT status INTO v_status FROM public.claims WHERE id = p_claim_id;

  RETURN jsonb_build_object(
    'id', p_claim_id,
    'status', v_status,
    'already_existed', v_exists,
    'alert_published', COALESCE(v_publish, false),
    'alert_reason', v_alert_reason
  );
END;
$$;
