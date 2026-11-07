-- =============================================================================
-- Migración 008: Fase 5 - Reclamos Georreferenciados, Fotos, Categorías y Avisos
-- =============================================================================

-- 1. Asegurar política UPDATE en storage.objects para reintentos idempotentes de fotos
DROP POLICY IF EXISTS storage_claim_photos_update ON storage.objects;
CREATE POLICY storage_claim_photos_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'claim-photos'
    AND (
      public.is_admin()
      OR (storage.foldername(name))[1] = auth.uid()::text
    )
  )
  WITH CHECK (
    bucket_id = 'claim-photos'
    AND (
      public.is_admin()
      OR (storage.foldername(name))[1] = auth.uid()::text
    )
  );

-- 2. Trigger en trips para notificar al vecino cuando el admin aprueba o rechaza su recorrido
CREATE OR REPLACE FUNCTION public.notify_user_on_trip_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('approved', 'rejected') AND NOT NEW.auto_approved THEN
    INSERT INTO public.notifications (
      user_id,
      type,
      title,
      body
    ) VALUES (
      NEW.user_id,
      'trip_' || NEW.status,
      CASE NEW.status
        WHEN 'approved' THEN 'Recorrido aprobado: ' || NEW.original_name
        ELSE 'Actualización sobre tu recorrido: ' || NEW.original_name
      END,
      CASE NEW.status
        WHEN 'approved' THEN 'Tu recorrido fue validado e incorporado al mapa vial colaborativo de Carlos Tejedor.'
        ELSE 'Tu recorrido fue revisado y no pudo incluirse en el mapa consolidado.'
      END ||
      CASE
        WHEN NEW.review_note IS NOT NULL AND btrim(NEW.review_note) <> '' THEN ' Nota: ' || NEW.review_note
        ELSE ''
      END
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_user_on_trip_review ON public.trips;
CREATE TRIGGER trg_notify_user_on_trip_review
  AFTER UPDATE OF status ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_user_on_trip_review();

-- 3. Ampliar trigger de nuevo reclamo para avisar también a todos los administradores
CREATE OR REPLACE FUNCTION public.handle_claim_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin record;
  v_cat_name text;
BEGIN
  SELECT name INTO v_cat_name
  FROM public.claim_categories
  WHERE id = NEW.category_id;

  INSERT INTO public.claim_history (
    claim_id, changed_by, action, old_status, new_status, old_priority, new_priority, message
  ) VALUES (
    NEW.id, NEW.user_id, 'created', NULL, NEW.status, NULL, NEW.priority, 'Reclamo ingresado en el sistema.'
  );

  -- Aviso para el vecino que creó el reclamo
  INSERT INTO public.notifications (
    user_id, type, title, body, claim_id
  ) VALUES (
    NEW.user_id,
    'claim_created',
    'Reclamo recibido: ' || NEW.title,
    'Recibimos tu reclamo (' || COALESCE(v_cat_name, 'Vial') || ') y quedó registrado con estado Recibido.',
    NEW.id
  );

  -- Aviso inmediato para los administradores (si quien lo creó no es ese mismo admin)
  FOR v_admin IN SELECT user_id FROM public.admins WHERE user_id <> NEW.user_id LOOP
    INSERT INTO public.notifications (
      user_id, type, title, body, claim_id
    ) VALUES (
      v_admin.user_id,
      'admin_new_claim',
      'Nuevo reclamo vial: ' || NEW.title,
      'Categoría: ' || COALESCE(v_cat_name, 'General') || '. Prioridad inicial: Media.',
      NEW.id
    );
  END LOOP;

  RETURN NEW;
END;
$$;

-- 4. RPC submit_claim_with_photo: Alta idempotente de reclamo georreferenciado + fotos
CREATE OR REPLACE FUNCTION public.submit_claim_with_photo(
  p_claim_id uuid,
  p_title text,
  p_description text,
  p_category_id uuid,
  p_lat double precision,
  p_lon double precision,
  p_storage_path text DEFAULT NULL,
  p_thumb_path text DEFAULT NULL,
  p_created_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_clean_title text;
  v_exists boolean;
  v_cat_active boolean;
  v_status text;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Debés iniciar sesión para enviar un reclamo.';
  END IF;

  IF p_lat < -90 OR p_lat > 90 OR p_lon < -180 OR p_lon > 180 THEN
    RAISE EXCEPTION 'Coordenadas GPS fuera de rango válido.';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.claims WHERE id = p_claim_id) INTO v_exists;

  IF NOT v_exists THEN
    SELECT is_active INTO v_cat_active
    FROM public.claim_categories
    WHERE id = p_category_id;

    IF v_cat_active IS DISTINCT FROM true AND NOT public.is_admin() THEN
      RAISE EXCEPTION 'La categoría seleccionada ya no se encuentra activa.';
    END IF;

    v_clean_title := COALESCE(NULLIF(btrim(p_title), ''), 'Reclamo en camino rural');

    INSERT INTO public.claims (
      id,
      user_id,
      title,
      description,
      category_id,
      location,
      created_at
    ) VALUES (
      p_claim_id,
      v_user_id,
      v_clean_title,
      NULLIF(btrim(COALESCE(p_description, '')), ''),
      p_category_id,
      ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326),
      COALESCE(p_created_at, now())
    );
  END IF;

  IF p_storage_path IS NOT NULL AND btrim(p_storage_path) <> '' THEN
    INSERT INTO public.claim_photos (
      claim_id,
      storage_path,
      thumb_path
    ) VALUES (
      p_claim_id,
      btrim(p_storage_path),
      NULLIF(btrim(COALESCE(p_thumb_path, '')), '')
    )
    ON CONFLICT (claim_id, storage_path) DO UPDATE
      SET thumb_path = COALESCE(EXCLUDED.thumb_path, public.claim_photos.thumb_path);
  END IF;

  SELECT status INTO v_status FROM public.claims WHERE id = p_claim_id;

  RETURN jsonb_build_object(
    'claim_id', p_claim_id,
    'status', v_status,
    'already_existed', v_exists
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_claim_with_photo(uuid, text, text, uuid, double precision, double precision, text, text, timestamptz) TO authenticated;

-- 5. RPC get_my_claims_list: Listado paginado liviano de Mis Reclamos para la app móvil
CREATE OR REPLACE FUNCTION public.get_my_claims_list(
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  title text,
  description text,
  category_id uuid,
  category_name text,
  category_icon text,
  status text,
  priority text,
  lat double precision,
  lon double precision,
  thumb_path text,
  photos_count bigint,
  latest_reply text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.title,
    c.description,
    c.category_id,
    cat.name AS category_name,
    cat.icon AS category_icon,
    c.status,
    c.priority,
    ST_Y(c.location)::double precision AS lat,
    ST_X(c.location)::double precision AS lon,
    (
      SELECT cp.thumb_path
      FROM public.claim_photos cp
      WHERE cp.claim_id = c.id
      ORDER BY cp.created_at ASC
      LIMIT 1
    ) AS thumb_path,
    (
      SELECT count(*)
      FROM public.claim_photos cp
      WHERE cp.claim_id = c.id
    ) AS photos_count,
    (
      SELECT ch.message
      FROM public.claim_history ch
      WHERE ch.claim_id = c.id
        AND ch.message IS NOT NULL
        AND btrim(ch.message) <> ''
        AND ch.action <> 'created'
      ORDER BY ch.created_at DESC
      LIMIT 1
    ) AS latest_reply,
    c.created_at,
    c.updated_at
  FROM public.claims c
  JOIN public.claim_categories cat ON cat.id = c.category_id
  WHERE c.user_id = auth.uid()
  ORDER BY c.created_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_claims_list(integer, integer) TO authenticated;

-- 6. RPC get_claim_detail: Detalle completo de un reclamo (con fotos e historial)
CREATE OR REPLACE FUNCTION public.get_claim_detail(
  p_claim_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim record;
  v_is_admin boolean;
  v_photos jsonb;
  v_history jsonb;
BEGIN
  v_is_admin := public.is_admin();

  SELECT
    c.id,
    c.user_id,
    c.title,
    c.description,
    c.category_id,
    cat.name AS category_name,
    cat.icon AS category_icon,
    c.status,
    c.priority,
    ST_Y(c.location)::double precision AS lat,
    ST_X(c.location)::double precision AS lon,
    c.created_at,
    c.updated_at,
    p.full_name AS user_name,
    p.email AS user_email
  INTO v_claim
  FROM public.claims c
  JOIN public.claim_categories cat ON cat.id = c.category_id
  LEFT JOIN public.profiles p ON p.id = c.user_id
  WHERE c.id = p_claim_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reclamo no encontrado.';
  END IF;

  IF v_claim.user_id <> auth.uid() AND NOT v_is_admin THEN
    RAISE EXCEPTION 'No tenés permiso para ver este reclamo.';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', cp.id,
        'storage_path', cp.storage_path,
        'thumb_path', cp.thumb_path,
        'created_at', cp.created_at
      )
      ORDER BY cp.created_at ASC
    ),
    '[]'::jsonb
  )
  INTO v_photos
  FROM public.claim_photos cp
  WHERE cp.claim_id = p_claim_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', ch.id,
        'action', ch.action,
        'old_status', ch.old_status,
        'new_status', ch.new_status,
        'old_priority', ch.old_priority,
        'new_priority', ch.new_priority,
        'message', ch.message,
        'created_at', ch.created_at
      )
      ORDER BY ch.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_history
  FROM public.claim_history ch
  WHERE ch.claim_id = p_claim_id;

  RETURN jsonb_build_object(
    'id', v_claim.id,
    'title', v_claim.title,
    'description', v_claim.description,
    'category_id', v_claim.category_id,
    'category_name', v_claim.category_name,
    'category_icon', v_claim.category_icon,
    'status', v_claim.status,
    'priority', v_claim.priority,
    'lat', v_claim.lat,
    'lon', v_claim.lon,
    'created_at', v_claim.created_at,
    'updated_at', v_claim.updated_at,
    'user_name', CASE WHEN v_is_admin THEN v_claim.user_name ELSE NULL END,
    'user_email', CASE WHEN v_is_admin THEN v_claim.user_email ELSE NULL END,
    'photos', v_photos,
    'history', v_history
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_claim_detail(uuid) TO authenticated;

-- 7. RPC get_admin_claims_list: Bandeja administrativa de reclamos con filtros y paginación
CREATE OR REPLACE FUNCTION public.get_admin_claims_list(
  p_status text DEFAULT NULL,
  p_priority text DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  title text,
  description text,
  category_id uuid,
  category_name text,
  category_icon text,
  status text,
  priority text,
  lat double precision,
  lon double precision,
  user_id uuid,
  user_name text,
  user_email text,
  thumb_path text,
  photos_count bigint,
  created_at timestamptz,
  updated_at timestamptz,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.';
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT
      c.id,
      c.title,
      c.description,
      c.category_id,
      cat.name AS category_name,
      cat.icon AS category_icon,
      c.status,
      c.priority,
      ST_Y(c.location)::double precision AS lat,
      ST_X(c.location)::double precision AS lon,
      c.user_id,
      COALESCE(p.full_name, split_part(p.email, '@', 1), 'Usuario') AS user_name,
      COALESCE(p.email, '-') AS user_email,
      (
        SELECT cp.thumb_path
        FROM public.claim_photos cp
        WHERE cp.claim_id = c.id
        ORDER BY cp.created_at ASC
        LIMIT 1
      ) AS thumb_path,
      (
        SELECT count(*)
        FROM public.claim_photos cp
        WHERE cp.claim_id = c.id
      ) AS photos_count,
      c.created_at,
      c.updated_at,
      count(*) OVER() AS total_count
    FROM public.claims c
    JOIN public.claim_categories cat ON cat.id = c.category_id
    LEFT JOIN public.profiles p ON p.id = c.user_id
    WHERE (p_status IS NULL OR p_status = 'all' OR c.status = p_status)
      AND (p_priority IS NULL OR p_priority = 'all' OR c.priority = p_priority)
      AND (p_category_id IS NULL OR c.category_id = p_category_id)
      AND (p_date_from IS NULL OR c.created_at >= p_date_from)
      AND (p_date_to IS NULL OR c.created_at <= p_date_to)
  )
  SELECT *
  FROM filtered
  ORDER BY created_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_claims_list(text, text, uuid, timestamptz, timestamptz, integer, integer) TO authenticated;

-- 8. RPC get_admin_map_claims: Puntos de reclamos para capa de mapa administrativo con clustering
CREATE OR REPLACE FUNCTION public.get_admin_map_claims(
  p_min_lon double precision,
  p_min_lat double precision,
  p_max_lon double precision,
  p_max_lat double precision,
  p_status text DEFAULT NULL,
  p_category_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  title text,
  status text,
  priority text,
  category_id uuid,
  category_name text,
  category_icon text,
  lat double precision,
  lon double precision,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bbox geometry(Polygon, 4326);
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.';
  END IF;

  v_bbox := ST_MakeEnvelope(p_min_lon, p_min_lat, p_max_lon, p_max_lat, 4326);

  RETURN QUERY
  SELECT
    c.id,
    c.title,
    c.status,
    c.priority,
    c.category_id,
    cat.name AS category_name,
    cat.icon AS category_icon,
    ST_Y(c.location)::double precision AS lat,
    ST_X(c.location)::double precision AS lon,
    c.created_at
  FROM public.claims c
  JOIN public.claim_categories cat ON cat.id = c.category_id
  WHERE c.location && v_bbox
    AND (p_status IS NULL OR p_status = 'all' OR c.status = p_status)
    AND (p_category_id IS NULL OR c.category_id = p_category_id)
  ORDER BY c.created_at DESC
  LIMIT 500;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_map_claims(double precision, double precision, double precision, double precision, text, uuid) TO authenticated;

-- 9. RPC upsert_claim_category: Crear, editar o activar/desactivar categoría de reclamo con audit_log
CREATE OR REPLACE FUNCTION public.upsert_claim_category(
  p_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_icon text DEFAULT 'alert-triangle',
  p_is_active boolean DEFAULT true,
  p_sort_order integer DEFAULT 0
)
RETURNS public.claim_categories
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean_name text;
  v_old_cat public.claim_categories;
  v_new_cat public.claim_categories;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.';
  END IF;

  v_clean_name := btrim(COALESCE(p_name, ''));
  IF v_clean_name = '' THEN
    RAISE EXCEPTION 'El nombre de la categoría no puede estar vacío.';
  END IF;

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_old_cat FROM public.claim_categories WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Categoría no encontrada.';
    END IF;

    UPDATE public.claim_categories
    SET name = v_clean_name,
        icon = COALESCE(NULLIF(btrim(p_icon), ''), 'alert-triangle'),
        is_active = COALESCE(p_is_active, true),
        sort_order = COALESCE(p_sort_order, 0),
        updated_at = now()
    WHERE id = p_id
    RETURNING * INTO v_new_cat;

    INSERT INTO public.audit_log (
      actor_id, action, table_name, record_id, old_data, new_data
    ) VALUES (
      auth.uid(),
      'update_claim_category',
      'claim_categories',
      p_id::text,
      to_jsonb(v_old_cat),
      to_jsonb(v_new_cat)
    );
  ELSE
    INSERT INTO public.claim_categories (
      name, icon, is_active, sort_order, created_at, updated_at
    ) VALUES (
      v_clean_name,
      COALESCE(NULLIF(btrim(p_icon), ''), 'alert-triangle'),
      COALESCE(p_is_active, true),
      COALESCE(p_sort_order, 0),
      now(),
      now()
    )
    RETURNING * INTO v_new_cat;

    INSERT INTO public.audit_log (
      actor_id, action, table_name, record_id, old_data, new_data
    ) VALUES (
      auth.uid(),
      'create_claim_category',
      'claim_categories',
      v_new_cat.id::text,
      NULL,
      to_jsonb(v_new_cat)
    );
  END IF;

  RETURN v_new_cat;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_claim_category(uuid, text, text, boolean, integer) TO authenticated;

-- 10. RPC mark_notifications_read: Marcar uno o todos los avisos como leídos
CREATE OR REPLACE FUNCTION public.mark_notifications_read(
  p_notification_id uuid DEFAULT NULL,
  p_mark_all boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF p_mark_all THEN
    UPDATE public.notifications
    SET is_read = true
    WHERE user_id = auth.uid() AND is_read = false;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  ELSIF p_notification_id IS NOT NULL THEN
    UPDATE public.notifications
    SET is_read = true
    WHERE id = p_notification_id AND user_id = auth.uid();
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  END IF;

  RETURN v_updated;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid, boolean) TO authenticated;

-- 11. RPC generate_weekly_pending_summary: Resumen semanal a admins solo si hay recorridos pendientes > 0
CREATE OR REPLACE FUNCTION public.generate_weekly_pending_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pending_trips integer;
  v_pending_claims integer;
  v_admin record;
  v_sent_count integer := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.';
  END IF;

  SELECT count(*)::int INTO v_pending_trips
  FROM public.trips
  WHERE status = 'pending';

  -- Regla del PDF: Si no hay recorridos pendientes, no se envía aviso ni correo para evitar ruido
  IF v_pending_trips = 0 THEN
    RETURN jsonb_build_object(
      'sent', false,
      'pending_trips', 0,
      'reason', 'No hay recorridos pendientes de validación; se omite el envío para evitar ruido.'
    );
  END IF;

  SELECT count(*)::int INTO v_pending_claims
  FROM public.claims
  WHERE status IN ('received', 'evaluating', 'in_progress');

  FOR v_admin IN SELECT user_id FROM public.admins LOOP
    INSERT INTO public.notifications (
      user_id,
      type,
      title,
      body
    ) VALUES (
      v_admin.user_id,
      'weekly_pending_summary',
      'Resumen semanal: ' || v_pending_trips || ' recorrido(s) pendiente(s) de validar',
      'Tenés ' || v_pending_trips || ' recorrido(s) enviado(s) por vecinos esperando aprobación en la Bandeja de Validación y ' ||
      v_pending_claims || ' reclamo(s) activo(s).'
    );
    v_sent_count := v_sent_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'sent', true,
    'pending_trips', v_pending_trips,
    'pending_claims', v_pending_claims,
    'admins_notified', v_sent_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_weekly_pending_summary() TO authenticated;
