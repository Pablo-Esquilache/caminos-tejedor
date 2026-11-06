-- =============================================================================
-- Migración 002: Funciones de seguridad, Triggers y RPCs de Administración
-- =============================================================================

-- 1. Función is_admin(): decide en la base de datos quién tiene rol administrador
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admins
    WHERE user_id = auth.uid()
  );
$$;

-- 2. Trigger para crear/actualizar automáticamente el perfil al registrarse un usuario
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
BEGIN
  v_name := COALESCE(
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'name',
    split_part(COALESCE(NEW.email, ''), '@', 1)
  );

  INSERT INTO public.profiles (id, full_name, email, created_at, updated_at)
  VALUES (NEW.id, v_name, NEW.email, now(), now())
  ON CONFLICT (id) DO UPDATE
    SET full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name),
        email = COALESCE(EXCLUDED.email, public.profiles.email),
        updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT OR UPDATE OF email, raw_user_meta_data ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- 3. Trigger en trips: si el usuario está en admins entra approved; si no, pending
CREATE OR REPLACE FUNCTION public.enforce_trip_insert_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_user_admin boolean;
BEGIN
  -- Asegurar que el user_id sea el usuario autenticado si viene nulo
  IF NEW.user_id IS NULL AND auth.uid() IS NOT NULL THEN
    NEW.user_id := auth.uid();
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.admins WHERE user_id = NEW.user_id
  ) INTO v_is_user_admin;

  IF v_is_user_admin THEN
    NEW.status := 'approved';
    NEW.auto_approved := true;
    NEW.reviewed_by := NEW.user_id;
    NEW.reviewed_at := now();
  ELSE
    -- El cliente común jamás puede forzar otro estado inicial
    NEW.status := 'pending';
    NEW.auto_approved := false;
    NEW.reviewed_by := NULL;
    NEW.reviewed_at := NULL;
    NEW.review_note := NULL;
  END IF;

  NEW.created_at := COALESCE(NEW.created_at, now());
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_trip_insert_rules ON public.trips;
CREATE TRIGGER trg_enforce_trip_insert_rules
  BEFORE INSERT ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_trip_insert_rules();

-- 4. Trigger que calcula la geometría simplificada en el servidor al insertar trip_tracks
CREATE OR REPLACE FUNCTION public.sync_trip_simplified_geom()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Simplifica en proyección métrica UTM 20S (EPSG:32720) con tolerancia de 8 metros
  UPDATE public.trips
  SET simplified_geom = ST_Transform(
        ST_SimplifyPreserveTopology(
          ST_Transform(NEW.full_geom, 32720),
          8.0
        ),
        4326
      ),
      updated_at = now()
  WHERE id = NEW.trip_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_trip_simplified_geom ON public.trip_tracks;
CREATE TRIGGER trg_sync_trip_simplified_geom
  AFTER INSERT ON public.trip_tracks
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_trip_simplified_geom();

-- 5. Protección de inmutabilidad en trip_tracks (nunca se modifica ni se borra)
CREATE OR REPLACE FUNCTION public.prevent_trip_tracks_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'La tabla trip_tracks es inmutable: no se permite modificar ni eliminar trazas originales.';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_trip_tracks_mutation ON public.trip_tracks;
CREATE TRIGGER trg_prevent_trip_tracks_mutation
  BEFORE UPDATE OR DELETE ON public.trip_tracks
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_trip_tracks_mutation();

-- 6. Trigger en claims: el usuario común no puede forzar status ni priority al crear
CREATE OR REPLACE FUNCTION public.enforce_claim_insert_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NULL AND auth.uid() IS NOT NULL THEN
    NEW.user_id := auth.uid();
  END IF;

  IF NOT public.is_admin() THEN
    NEW.status := 'received';
    NEW.priority := 'medium';
  END IF;

  NEW.created_at := COALESCE(NEW.created_at, now());
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_claim_insert_rules ON public.claims;
CREATE TRIGGER trg_enforce_claim_insert_rules
  BEFORE INSERT ON public.claims
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_claim_insert_rules();

-- 7. Trigger post-alta de reclamo: registra historial inicial y notificación al usuario
CREATE OR REPLACE FUNCTION public.handle_claim_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.claim_history (
    claim_id, changed_by, action, old_status, new_status, old_priority, new_priority, message
  ) VALUES (
    NEW.id, NEW.user_id, 'created', NULL, NEW.status, NULL, NEW.priority, 'Reclamo ingresado en el sistema.'
  );

  INSERT INTO public.notifications (
    user_id, type, title, body, claim_id
  ) VALUES (
    NEW.user_id,
    'claim_created',
    'Reclamo recibido: ' || NEW.title,
    'Recibimos tu reclamo y quedó registrado con estado Recibido.',
    NEW.id
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_handle_claim_created ON public.claims;
CREATE TRIGGER trg_handle_claim_created
  AFTER INSERT ON public.claims
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_claim_created();

-- =============================================================================
-- Funciones RPC Administrativas (con registro obligatorio en audit_log)
-- =============================================================================

-- 8. RPC review_trip: aprueba, rechaza o revoca (vuelve a pending) un recorrido
CREATE OR REPLACE FUNCTION public.review_trip(
  p_trip_id uuid,
  p_new_status text,
  p_note text DEFAULT NULL
)
RETURNS public.trips
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_trip public.trips;
  v_new_trip public.trips;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo un administrador puede revisar recorridos.';
  END IF;

  IF p_new_status NOT IN ('pending', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'Estado inválido: %', p_new_status;
  END IF;

  SELECT * INTO v_old_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recorrido no encontrado: %', p_trip_id;
  END IF;

  UPDATE public.trips
  SET status = p_new_status,
      auto_approved = false,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_note = COALESCE(p_note, review_note),
      updated_at = now()
  WHERE id = p_trip_id
  RETURNING * INTO v_new_trip;

  INSERT INTO public.audit_log (
    actor_id, action, table_name, record_id, old_data, new_data
  ) VALUES (
    auth.uid(),
    'review_trip_' || p_new_status,
    'trips',
    p_trip_id::text,
    jsonb_build_object(
      'status', v_old_trip.status,
      'reviewed_by', v_old_trip.reviewed_by,
      'review_note', v_old_trip.review_note
    ),
    jsonb_build_object(
      'status', v_new_trip.status,
      'reviewed_by', v_new_trip.reviewed_by,
      'review_note', v_new_trip.review_note
    )
  );

  RETURN v_new_trip;
END;
$$;

-- 9. RPC update_claim: cambia estado, prioridad y/o envía respuesta al vecino con auditoría
CREATE OR REPLACE FUNCTION public.update_claim(
  p_claim_id uuid,
  p_new_status text DEFAULT NULL,
  p_new_priority text DEFAULT NULL,
  p_message text DEFAULT NULL
)
RETURNS public.claims
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_claim public.claims;
  v_new_claim public.claims;
  v_status text;
  v_priority text;
  v_status_label text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo un administrador puede actualizar reclamos.';
  END IF;

  SELECT * INTO v_old_claim
  FROM public.claims
  WHERE id = p_claim_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reclamo no encontrado: %', p_claim_id;
  END IF;

  v_status := COALESCE(p_new_status, v_old_claim.status);
  v_priority := COALESCE(p_new_priority, v_old_claim.priority);

  IF v_status NOT IN ('received', 'evaluating', 'in_progress', 'solved', 'dismissed') THEN
    RAISE EXCEPTION 'Estado de reclamo inválido: %', v_status;
  END IF;

  IF v_priority NOT IN ('low', 'medium', 'high') THEN
    RAISE EXCEPTION 'Prioridad inválida: %', v_priority;
  END IF;

  UPDATE public.claims
  SET status = v_status,
      priority = v_priority,
      updated_at = now()
  WHERE id = p_claim_id
  RETURNING * INTO v_new_claim;

  INSERT INTO public.claim_history (
    claim_id, changed_by, action, old_status, new_status, old_priority, new_priority, message
  ) VALUES (
    p_claim_id,
    auth.uid(),
    CASE
      WHEN v_old_claim.status IS DISTINCT FROM v_status THEN 'status_changed'
      WHEN p_message IS NOT NULL AND btrim(p_message) <> '' THEN 'admin_reply'
      ELSE 'priority_changed'
    END,
    v_old_claim.status,
    v_status,
    v_old_claim.priority,
    v_priority,
    p_message
  );

  -- Si cambió el estado o hay mensaje del administrador, notificar al usuario
  IF (v_old_claim.status IS DISTINCT FROM v_status) OR (p_message IS NOT NULL AND btrim(p_message) <> '') THEN
    v_status_label := CASE v_status
      WHEN 'received' THEN 'Recibido'
      WHEN 'evaluating' THEN 'En evaluación'
      WHEN 'in_progress' THEN 'En proceso'
      WHEN 'solved' THEN 'Solucionado'
      WHEN 'dismissed' THEN 'Desestimado'
      ELSE v_status
    END;

    INSERT INTO public.notifications (
      user_id, type, title, body, claim_id
    ) VALUES (
      v_old_claim.user_id,
      'claim_updated',
      'Actualización en tu reclamo: ' || v_old_claim.title,
      'Nuevo estado: ' || v_status_label ||
        CASE
          WHEN p_message IS NOT NULL AND btrim(p_message) <> '' THEN '. Respuesta: ' || p_message
          ELSE ''
        END,
      p_claim_id
    );
  END IF;

  INSERT INTO public.audit_log (
    actor_id, action, table_name, record_id, old_data, new_data
  ) VALUES (
    auth.uid(),
    'update_claim',
    'claims',
    p_claim_id::text,
    jsonb_build_object(
      'status', v_old_claim.status,
      'priority', v_old_claim.priority
    ),
    jsonb_build_object(
      'status', v_new_claim.status,
      'priority', v_new_claim.priority,
      'message', p_message
    )
  );

  RETURN v_new_claim;
END;
$$;
