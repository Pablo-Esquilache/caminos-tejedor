-- =============================================================================
-- Migración 016: Corregir columnas de audit_log (actor_id, table_name, record_id,
-- old_data, new_data) en las RPCs del Módulo de Operario e Intervenciones
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_upsert_work_type(
  p_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_execution_mode text DEFAULT 'linear',
  p_color text DEFAULT '#0ea5e9',
  p_description text DEFAULT NULL,
  p_sort_order integer DEFAULT 0,
  p_is_active boolean DEFAULT true
)
RETURNS public.work_types
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.work_types;
  v_clean_name text := btrim(COALESCE(p_name, ''));
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.';
  END IF;

  IF v_clean_name = '' THEN
    RAISE EXCEPTION 'El nombre del tipo de trabajo es obligatorio.';
  END IF;

  IF p_execution_mode NOT IN ('linear', 'punctual') THEN
    RAISE EXCEPTION 'Modo de ejecución inválido (debe ser linear o punctual).';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.work_types (name, execution_mode, color, description, sort_order, is_active)
    VALUES (v_clean_name, p_execution_mode, COALESCE(NULLIF(btrim(p_color), ''), '#0ea5e9'), NULLIF(btrim(COALESCE(p_description, '')), ''), COALESCE(p_sort_order, 0), COALESCE(p_is_active, true))
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.work_types
    SET
      name = v_clean_name,
      execution_mode = p_execution_mode,
      color = COALESCE(NULLIF(btrim(p_color), ''), color),
      description = NULLIF(btrim(COALESCE(p_description, '')), ''),
      sort_order = COALESCE(p_sort_order, sort_order),
      is_active = COALESCE(p_is_active, is_active),
      updated_at = now()
    WHERE id = p_id
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Tipo de trabajo no encontrado.';
    END IF;
  END IF;

  INSERT INTO public.audit_log (actor_id, action, table_name, record_id, new_data)
  VALUES (
    auth.uid(),
    CASE WHEN p_id IS NULL THEN 'work_type_created' ELSE 'work_type_updated' END,
    'work_types',
    v_row.id::text,
    jsonb_build_object('name', v_row.name, 'execution_mode', v_row.execution_mode, 'is_active', v_row.is_active)
  );

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_upsert_machine(
  p_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_code text DEFAULT NULL,
  p_machine_type text DEFAULT 'motoniveladora',
  p_description text DEFAULT NULL,
  p_is_active boolean DEFAULT true
)
RETURNS public.machines
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.machines;
  v_clean_name text := btrim(COALESCE(p_name, ''));
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.';
  END IF;

  IF v_clean_name = '' THEN
    RAISE EXCEPTION 'El nombre o identificación de la máquina es obligatorio.';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.machines (name, code, machine_type, description, is_active)
    VALUES (
      v_clean_name,
      NULLIF(btrim(COALESCE(p_code, '')), ''),
      p_machine_type,
      NULLIF(btrim(COALESCE(p_description, '')), ''),
      COALESCE(p_is_active, true)
    )
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.machines
    SET
      name = v_clean_name,
      code = NULLIF(btrim(COALESCE(p_code, '')), ''),
      machine_type = p_machine_type,
      description = NULLIF(btrim(COALESCE(p_description, '')), ''),
      is_active = COALESCE(p_is_active, is_active),
      updated_at = now()
    WHERE id = p_id
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Maquinaria no encontrada.';
    END IF;
  END IF;

  INSERT INTO public.audit_log (actor_id, action, table_name, record_id, new_data)
  VALUES (
    auth.uid(),
    CASE WHEN p_id IS NULL THEN 'machine_created' ELSE 'machine_updated' END,
    'machines',
    v_row.id::text,
    jsonb_build_object('name', v_row.name, 'machine_type', v_row.machine_type, 'is_active', v_row.is_active)
  );

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_upsert_operator(
  p_id uuid DEFAULT NULL,
  p_full_name text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_password text DEFAULT NULL,
  p_legajo text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_role_notes text DEFAULT NULL,
  p_create_account boolean DEFAULT false,
  p_is_active boolean DEFAULT true
)
RETURNS public.operators
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_row public.operators;
  v_existing public.operators;
  v_clean_name text := btrim(COALESCE(p_full_name, ''));
  v_clean_email text := NULLIF(lower(btrim(COALESCE(p_email, ''))), '');
  v_user_id uuid;
  v_has_account boolean := false;
  v_is_target_admin boolean := false;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.';
  END IF;

  IF v_clean_name = '' THEN
    RAISE EXCEPTION 'El nombre completo del operario es obligatorio.';
  END IF;

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.operators WHERE id = p_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Operario no encontrado.';
    END IF;
    v_user_id := v_existing.user_id;
    v_has_account := v_existing.has_account;
  END IF;

  IF COALESCE(p_create_account, false) AND v_user_id IS NULL THEN
    IF v_clean_email IS NULL OR position('@' IN v_clean_email) = 0 THEN
      RAISE EXCEPTION 'Ingresá un correo válido para crear la cuenta del operario.';
    END IF;

    SELECT id INTO v_user_id
    FROM auth.users
    WHERE lower(email) = v_clean_email
      AND deleted_at IS NULL
    LIMIT 1;

    IF v_user_id IS NULL THEN
      IF p_password IS NULL OR length(btrim(p_password)) < 6 THEN
        RAISE EXCEPTION 'La clave inicial del operario debe tener al menos 6 caracteres.';
      END IF;

      v_user_id := gen_random_uuid();

      INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        confirmation_token, recovery_token, email_change_token_new, email_change,
        phone_change, phone_change_token, email_change_token_current, reauthentication_token,
        raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous, created_at, updated_at
      ) VALUES (
        '00000000-0000-0000-0000-000000000000'::uuid,
        v_user_id, 'authenticated', 'authenticated', v_clean_email,
        extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
        now(), '', '', '', '', '', '', '', '',
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('full_name', v_clean_name, 'email_verified', true),
        false, false, now(), now()
      );

      INSERT INTO auth.identities (
        id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), v_user_id,
        jsonb_build_object('sub', v_user_id::text, 'email', v_clean_email, 'email_verified', true, 'phone_verified', false),
        'email', v_user_id::text, now(), now(), now()
      );
    ELSE
      INSERT INTO public.profiles (id, full_name, email, created_at, updated_at)
      VALUES (v_user_id, v_clean_name, v_clean_email, now(), now())
      ON CONFLICT (id) DO NOTHING;

      IF p_password IS NOT NULL AND length(btrim(p_password)) >= 6 THEN
        UPDATE auth.users
        SET
          encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
          email_confirmed_at = COALESCE(email_confirmed_at, now()),
          updated_at = now()
        WHERE id = v_user_id;
      END IF;
    END IF;

    v_has_account := true;
  ELSIF v_user_id IS NOT NULL AND p_password IS NOT NULL AND length(btrim(p_password)) >= 6 THEN
    UPDATE auth.users
    SET
      encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
      updated_at = now()
    WHERE id = v_user_id;
    v_has_account := true;
  END IF;

  IF v_user_id IS NOT NULL THEN
    INSERT INTO public.profiles (id, full_name, email, created_at, updated_at)
    VALUES (v_user_id, v_clean_name, v_clean_email, now(), now())
    ON CONFLICT (id) DO UPDATE
      SET full_name = COALESCE(NULLIF(public.profiles.full_name, ''), EXCLUDED.full_name),
          email = COALESCE(public.profiles.email, EXCLUDED.email),
          updated_at = now();

    SELECT EXISTS (SELECT 1 FROM public.admins WHERE user_id = v_user_id) INTO v_is_target_admin;
    IF NOT v_is_target_admin THEN
      UPDATE auth.users
      SET
        banned_until = CASE WHEN COALESCE(p_is_active, true) THEN NULL ELSE '2099-12-31T23:59:59Z'::timestamptz END,
        updated_at = now()
      WHERE id = v_user_id;
    END IF;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.operators (
      user_id, full_name, email, legajo, phone, role_notes, has_account, is_active, created_by
    ) VALUES (
      v_user_id,
      v_clean_name,
      v_clean_email,
      NULLIF(btrim(COALESCE(p_legajo, '')), ''),
      NULLIF(btrim(COALESCE(p_phone, '')), ''),
      NULLIF(btrim(COALESCE(p_role_notes, '')), ''),
      v_has_account,
      COALESCE(p_is_active, true),
      auth.uid()
    )
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.operators
    SET
      user_id = COALESCE(v_user_id, user_id),
      full_name = v_clean_name,
      email = COALESCE(v_clean_email, email),
      legajo = NULLIF(btrim(COALESCE(p_legajo, '')), ''),
      phone = NULLIF(btrim(COALESCE(p_phone, '')), ''),
      role_notes = NULLIF(btrim(COALESCE(p_role_notes, '')), ''),
      has_account = (COALESCE(v_user_id, user_id) IS NOT NULL),
      is_active = COALESCE(p_is_active, is_active),
      updated_at = now()
    WHERE id = p_id
    RETURNING * INTO v_row;
  END IF;

  INSERT INTO public.audit_log (actor_id, action, table_name, record_id, new_data)
  VALUES (
    auth.uid(),
    CASE WHEN p_id IS NULL THEN 'operator_created' ELSE 'operator_updated' END,
    'operators',
    v_row.id::text,
    jsonb_build_object('full_name', v_row.full_name, 'has_account', v_row.has_account, 'is_active', v_row.is_active)
  );

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_upsert_intervention(
  p_id uuid DEFAULT NULL,
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_execution_mode text DEFAULT 'linear',
  p_priority text DEFAULT 'medium',
  p_road_id uuid DEFAULT NULL,
  p_definition_mode text DEFAULT 'freehand_draw',
  p_planned_geojson jsonb DEFAULT NULL,
  p_work_type_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_machine_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_operator_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_responsible_operator_id uuid DEFAULT NULL,
  p_scheduled_date date DEFAULT NULL,
  p_linked_claim_id uuid DEFAULT NULL
)
RETURNS public.interventions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.interventions;
  v_clean_title text := btrim(COALESCE(p_title, ''));
  v_geom geometry;
  v_len_m numeric(12, 2) := 0;
  v_road_name text := NULL;
  v_wid uuid;
  v_mid uuid;
  v_oid uuid;
  v_all_ops uuid[];
  v_op_user_id uuid;
  v_old_status text := NULL;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.';
  END IF;

  IF v_clean_title = '' THEN
    RAISE EXCEPTION 'El título de la intervención es obligatorio.';
  END IF;

  IF p_execution_mode NOT IN ('linear', 'punctual') THEN
    RAISE EXCEPTION 'Modo de ejecución inválido.';
  END IF;

  IF p_road_id IS NOT NULL THEN
    SELECT normalized_name INTO v_road_name FROM public.roads WHERE id = p_road_id;
  END IF;

  IF p_planned_geojson IS NOT NULL THEN
    v_geom := ST_SetSRID(ST_GeomFromGeoJSON(p_planned_geojson::text), 4326);
  ELSIF p_road_id IS NOT NULL AND p_definition_mode = 'consolidated_road' THEN
    SELECT ST_LineMerge(ST_Collect(geom)) INTO v_geom FROM public.road_segments WHERE road_id = p_road_id;
  END IF;

  IF v_geom IS NOT NULL AND NOT ST_IsEmpty(v_geom) THEN
    IF p_execution_mode = 'linear' THEN
      v_len_m := ROUND(ST_Length(ST_Transform(v_geom, 32720))::numeric, 2);
    ELSE
      v_len_m := 0;
    END IF;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.interventions (
      title, description, execution_mode, origin, status, priority,
      road_id, road_name_snapshot, definition_mode,
      planned_geom, planned_length_m,
      responsible_operator_id, linked_claim_id, scheduled_date, created_by
    ) VALUES (
      v_clean_title,
      NULLIF(btrim(COALESCE(p_description, '')), ''),
      p_execution_mode,
      'planned',
      'planned',
      COALESCE(p_priority, 'medium'),
      p_road_id,
      v_road_name,
      p_definition_mode,
      v_geom,
      v_len_m,
      p_responsible_operator_id,
      p_linked_claim_id,
      p_scheduled_date,
      auth.uid()
    )
    RETURNING * INTO v_row;
  ELSE
    SELECT status INTO v_old_status FROM public.interventions WHERE id = p_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Intervención no encontrada.';
    END IF;

    UPDATE public.interventions
    SET
      title = v_clean_title,
      description = NULLIF(btrim(COALESCE(p_description, '')), ''),
      execution_mode = p_execution_mode,
      priority = COALESCE(p_priority, priority),
      road_id = p_road_id,
      road_name_snapshot = COALESCE(v_road_name, road_name_snapshot),
      definition_mode = COALESCE(p_definition_mode, definition_mode),
      planned_geom = COALESCE(v_geom, planned_geom),
      planned_length_m = CASE WHEN v_geom IS NOT NULL THEN v_len_m ELSE planned_length_m END,
      responsible_operator_id = p_responsible_operator_id,
      linked_claim_id = p_linked_claim_id,
      scheduled_date = p_scheduled_date,
      updated_at = now()
    WHERE id = p_id
    RETURNING * INTO v_row;
  END IF;

  DELETE FROM public.intervention_work_types WHERE intervention_id = v_row.id;
  IF array_length(p_work_type_ids, 1) IS NOT NULL THEN
    FOREACH v_wid IN ARRAY p_work_type_ids LOOP
      INSERT INTO public.intervention_work_types (intervention_id, work_type_id)
      VALUES (v_row.id, v_wid)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  DELETE FROM public.intervention_machines WHERE intervention_id = v_row.id;
  IF array_length(p_machine_ids, 1) IS NOT NULL THEN
    FOREACH v_mid IN ARRAY p_machine_ids LOOP
      INSERT INTO public.intervention_machines (intervention_id, machine_id)
      VALUES (v_row.id, v_mid)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  DELETE FROM public.intervention_operators WHERE intervention_id = v_row.id;
  v_all_ops := COALESCE(p_operator_ids, ARRAY[]::uuid[]);
  IF p_responsible_operator_id IS NOT NULL AND NOT (p_responsible_operator_id = ANY(v_all_ops)) THEN
    v_all_ops := array_append(v_all_ops, p_responsible_operator_id);
  END IF;

  IF array_length(v_all_ops, 1) IS NOT NULL THEN
    FOREACH v_oid IN ARRAY v_all_ops LOOP
      INSERT INTO public.intervention_operators (intervention_id, operator_id, is_responsible)
      VALUES (v_row.id, v_oid, (v_oid = p_responsible_operator_id))
      ON CONFLICT (intervention_id, operator_id) DO UPDATE
        SET is_responsible = EXCLUDED.is_responsible;

      IF p_id IS NULL THEN
        SELECT user_id INTO v_op_user_id FROM public.operators WHERE id = v_oid AND is_active = true;
        IF v_op_user_id IS NOT NULL THEN
          INSERT INTO public.notifications (user_id, type, title, body)
          VALUES (
            v_op_user_id,
            'intervention_assigned',
            'Nueva tarea asignada: ' || v_row.title,
            'El Municipio te asignó una intervención vial' ||
            CASE WHEN v_row.scheduled_date IS NOT NULL THEN ' para el ' || to_char(v_row.scheduled_date, 'DD/MM/YYYY') ELSE '' END || '.'
          );
        END IF;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.intervention_history (intervention_id, changed_by, action, old_status, new_status, message)
  VALUES (
    v_row.id,
    auth.uid(),
    CASE WHEN p_id IS NULL THEN 'created' ELSE 'updated' END,
    v_old_status,
    v_row.status,
    CASE WHEN p_id IS NULL THEN 'Intervención programada desde Panel Admin.' ELSE 'Intervención editada desde Panel Admin.' END
  );

  INSERT INTO public.audit_log (actor_id, action, table_name, record_id, new_data)
  VALUES (
    auth.uid(),
    CASE WHEN p_id IS NULL THEN 'intervention_created' ELSE 'intervention_updated' END,
    'interventions',
    v_row.id::text,
    jsonb_build_object('title', v_row.title, 'execution_mode', v_row.execution_mode, 'road_id', v_row.road_id)
  );

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_review_intervention(
  p_intervention_id uuid,
  p_new_status text,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_int public.interventions;
  v_op_user_id uuid;
  v_claim public.claims;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.';
  END IF;

  IF p_new_status NOT IN ('approved', 'rejected', 'planned', 'suspended') THEN
    RAISE EXCEPTION 'Estado de revisión inválido: %', p_new_status;
  END IF;

  SELECT * INTO v_int FROM public.interventions WHERE id = p_intervention_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Intervención no encontrada.';
  END IF;

  UPDATE public.interventions
  SET
    status = p_new_status,
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    review_note = NULLIF(btrim(COALESCE(p_note, '')), ''),
    updated_at = now()
  WHERE id = p_intervention_id;

  IF p_new_status = 'approved' AND v_int.linked_claim_id IS NOT NULL THEN
    SELECT * INTO v_claim FROM public.claims WHERE id = v_int.linked_claim_id;
    IF FOUND AND v_claim.status NOT IN ('solved', 'dismissed') THEN
      UPDATE public.claims
      SET status = 'solved', updated_at = now()
      WHERE id = v_claim.id;

      INSERT INTO public.claim_history (
        claim_id, changed_by, action, old_status, new_status, old_priority, new_priority, message
      ) VALUES (
        v_claim.id,
        auth.uid(),
        'solved_by_intervention',
        v_claim.status,
        'solved',
        v_claim.priority,
        v_claim.priority,
        'Reclamo solucionado mediante intervención vial municipal: ' || v_int.title
      );

      INSERT INTO public.notifications (user_id, type, title, body, claim_id)
      VALUES (
        v_claim.user_id,
        'claim_status',
        'Reclamo solucionado: ' || v_claim.title,
        'El Municipio completó y validó el trabajo vial "' || v_int.title || '" resolviendo tu reclamo.',
        v_claim.id
      );
    END IF;
  END IF;

  IF v_int.responsible_operator_id IS NOT NULL AND p_new_status IN ('approved', 'rejected') THEN
    SELECT user_id INTO v_op_user_id FROM public.operators WHERE id = v_int.responsible_operator_id;
    IF v_op_user_id IS NOT NULL THEN
      INSERT INTO public.notifications (user_id, type, title, body)
      VALUES (
        v_op_user_id,
        'intervention_' || p_new_status,
        CASE WHEN p_new_status = 'approved' THEN 'Trabajo aprobado: ' ELSE 'Trabajo devuelto/rechazado: ' END || v_int.title,
        CASE WHEN p_new_status = 'approved'
          THEN 'La intervención fue validada por el Municipio e incorporada al mapa oficial.'
          ELSE 'La intervención fue rechazada o requiere corrección.' || CASE WHEN p_note IS NOT NULL AND btrim(p_note) <> '' THEN ' Nota: ' || p_note ELSE '' END
        END
      );
    END IF;
  END IF;

  INSERT INTO public.intervention_history (intervention_id, changed_by, action, old_status, new_status, message)
  VALUES (
    p_intervention_id,
    auth.uid(),
    CASE p_new_status WHEN 'approved' THEN 'approved' WHEN 'rejected' THEN 'rejected' ELSE 'reopened' END,
    v_int.status,
    p_new_status,
    COALESCE(NULLIF(btrim(COALESCE(p_note, '')), ''), 'Revisión administrativa registrada.')
  );

  INSERT INTO public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
  VALUES (
    auth.uid(),
    'intervention_review_' || p_new_status,
    'interventions',
    p_intervention_id::text,
    jsonb_build_object('status', v_int.status),
    jsonb_build_object('status', p_new_status, 'note', p_note)
  );

  RETURN jsonb_build_object('ok', true, 'status', p_new_status);
END;
$$;
