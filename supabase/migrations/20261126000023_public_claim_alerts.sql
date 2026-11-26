-- =============================================================================
-- Migración 023: Mapa Colaborativo de Alertas Vecinales (Bloque B1)
-- =============================================================================
-- Dependencia: requiere Migración 022 aplicada previamente.
-- Reglas clave:
--   - Estados públicos activos (lista positiva): received, evaluating, in_progress.
--     Al pasar a solved o dismissed desaparecen automáticamente del mapa/Storage.
--   - Un reclamo NUNCA falla por las reglas de publicación de alerta (tope 5 o
--     largos máximos): si no califica, se guarda como privado y devuelve
--     alert_published=false + alert_reason.
--   - Nunca exponer user_id ni email en las RPCs de lectura comunitaria (solo is_mine).
--   - DROP FUNCTION de submit_claim_with_photo (9 args) + nueva de 10 args + GRANT explícito.
--   - Storage: función SECURITY DEFINER STABLE is_public_alert_photo(name) exigiendo
--     reclamo público activo + pertenencia a ese reclamo + carpeta del autor.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Columnas nuevas en claims y claim_categories + índices
-- -----------------------------------------------------------------------------
ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS is_public_alert boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alert_published_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_claims_public_alerts_active
  ON public.claims (alert_published_at DESC)
  WHERE is_public_alert = true AND status IN ('received', 'evaluating', 'in_progress');

ALTER TABLE public.claim_categories
  ADD COLUMN IF NOT EXISTS color text;

-- Rellenar colores diferenciados para categorías existentes según sort_order
WITH palette AS (
  SELECT ARRAY[
    '#dc2626', '#d97706', '#2563eb', '#7c3aed', '#059669',
    '#db2777', '#0891b2', '#ea580c', '#4f46e5', '#65a30d'
  ] AS colors
),
ordered AS (
  SELECT id, row_number() OVER (ORDER BY sort_order ASC, name ASC) AS rn
  FROM public.claim_categories
  WHERE color IS NULL
)
UPDATE public.claim_categories cc
SET color = p.colors[((o.rn - 1) % array_length(p.colors, 1)) + 1]
FROM ordered o, palette p
WHERE cc.id = o.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'claim_categories_color_hex_chk'
      AND conrelid = 'public.claim_categories'::regclass
  ) THEN
    ALTER TABLE public.claim_categories
      ADD CONSTRAINT claim_categories_color_hex_chk
      CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$');
  END IF;
END $$;

-- Índices de soporte para validación rápida de rutas de fotos en Storage
CREATE INDEX IF NOT EXISTS idx_claim_photos_storage_path
  ON public.claim_photos (storage_path);

CREATE INDEX IF NOT EXISTS idx_claim_photos_thumb_path
  ON public.claim_photos (thumb_path)
  WHERE thumb_path IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Función SECURITY DEFINER STABLE para lectura de fotos de alertas públicas
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_public_alert_photo(p_object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p_object_name IS NOT NULL
    AND position('..' in p_object_name) = 0
    AND EXISTS (
      SELECT 1
      FROM public.claim_photos cp
      JOIN public.claims c ON c.id = cp.claim_id
      WHERE (cp.storage_path = p_object_name OR cp.thumb_path = p_object_name)
        AND c.is_public_alert = true
        AND c.status IN ('received', 'evaluating', 'in_progress')
        AND split_part(p_object_name, '/', 1) = c.user_id::text
    );
$$;

REVOKE ALL ON FUNCTION public.is_public_alert_photo(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_public_alert_photo(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_public_alert_photo(text) TO authenticated;

DROP POLICY IF EXISTS storage_public_alert_photos_select ON storage.objects;
CREATE POLICY storage_public_alert_photos_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'claim-photos'
    AND public.is_public_alert_photo(name)
  );

-- -----------------------------------------------------------------------------
-- 3. submit_claim_with_photo(): DROP firma 9 args -> crear 10 args + GRANT
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.submit_claim_with_photo(
  uuid, text, text, uuid, double precision, double precision, text, text, timestamptz
);

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
  v_expected_prefix := v_user_id::text || '/';

  IF NOT v_is_adm THEN
    IF v_clean_storage IS NOT NULL AND (
      left(v_clean_storage, length(v_expected_prefix)) <> v_expected_prefix
      OR position('..' in v_clean_storage) > 0
    ) THEN
      RAISE EXCEPTION 'Permiso denegado: la ruta de fotografía no pertenece al usuario autenticado.' USING ERRCODE = '42501';
    END IF;

    IF v_clean_thumb IS NOT NULL AND (
      left(v_clean_thumb, length(v_expected_prefix)) <> v_expected_prefix
      OR position('..' in v_clean_thumb) > 0
    ) THEN
      RAISE EXCEPTION 'Permiso denegado: la ruta de miniatura no pertenece al usuario autenticado.' USING ERRCODE = '42501';
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
    'alert_published', v_publish,
    'alert_reason', v_alert_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_claim_with_photo(
  uuid, text, text, uuid, double precision, double precision, text, text, timestamptz, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_claim_with_photo(
  uuid, text, text, uuid, double precision, double precision, text, text, timestamptz, boolean
) FROM anon;
GRANT EXECUTE ON FUNCTION public.submit_claim_with_photo(
  uuid, text, text, uuid, double precision, double precision, text, text, timestamptz, boolean
) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. RPCs de gestión de alertas (baja propia, baja de emergencia admin, IDs propios)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unpublish_my_claim_alert(p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Debés iniciar sesión.' USING ERRCODE = '42501';
  END IF;

  SELECT user_id INTO v_owner FROM public.claims WHERE id = p_claim_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reclamo no encontrado.';
  END IF;

  IF v_owner <> v_uid THEN
    RAISE EXCEPTION 'Permiso denegado: solo el autor puede bajar su aviso del mapa.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.claims
  SET is_public_alert = false,
      alert_published_at = NULL,
      updated_at = now()
  WHERE id = p_claim_id;

  RETURN jsonb_build_object('ok', true, 'id', p_claim_id, 'is_public_alert', false);
END;
$$;

REVOKE ALL ON FUNCTION public.unpublish_my_claim_alert(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unpublish_my_claim_alert(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.unpublish_my_claim_alert(uuid) TO authenticated;

-- Baja de emergencia solo para administradores (uso desde SQL; sin botón UI en esta etapa)
CREATE OR REPLACE FUNCTION public.admin_unpublish_claim_alert(p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.claims
  SET is_public_alert = false,
      alert_published_at = NULL,
      updated_at = now()
  WHERE id = p_claim_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reclamo no encontrado.';
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', p_claim_id, 'is_public_alert', false);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_unpublish_claim_alert(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_unpublish_claim_alert(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_unpublish_claim_alert(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_published_alert_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(c.id), ARRAY[]::uuid[])
  FROM public.claims c
  WHERE c.user_id = auth.uid()
    AND c.is_public_alert = true
    AND c.status IN ('received', 'evaluating', 'in_progress');
$$;

REVOKE ALL ON FUNCTION public.get_my_published_alert_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_published_alert_ids() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_published_alert_ids() TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. RPCs de lectura comunitaria (NUNCA exponen user_id ni email; solo is_mine)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_claim_alerts(
  p_min_lon double precision,
  p_min_lat double precision,
  p_max_lon double precision,
  p_max_lat double precision
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_items jsonb;
  v_count integer;
  v_truncated boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Debés iniciar sesión para ver el mapa de alertas.' USING ERRCODE = '42501';
  END IF;

  IF p_min_lon IS NULL OR p_min_lat IS NULL OR p_max_lon IS NULL OR p_max_lat IS NULL
     OR p_min_lon < -180 OR p_max_lon > 180 OR p_min_lon >= p_max_lon
     OR p_min_lat < -90  OR p_max_lat > 90  OR p_min_lat >= p_max_lat
  THEN
    RAISE EXCEPTION 'Rango de viewport inválido.';
  END IF;

  WITH matched AS (
    SELECT
      c.id,
      c.title,
      c.description,
      c.category_id,
      COALESCE(cat.name, 'Reclamo vial') AS category_name,
      COALESCE(cat.color, '#dc2626') AS category_color,
      ST_Y(c.location::geometry) AS lat,
      ST_X(c.location::geometry) AS lon,
      c.alert_published_at,
      c.created_at,
      (c.user_id = v_uid) AS is_mine,
      ph.storage_path,
      ph.thumb_path
    FROM public.claims c
    LEFT JOIN public.claim_categories cat ON cat.id = c.category_id
    LEFT JOIN LATERAL (
      SELECT cp.storage_path, cp.thumb_path
      FROM public.claim_photos cp
      WHERE cp.claim_id = c.id
      ORDER BY cp.created_at ASC
      LIMIT 1
    ) ph ON true
    WHERE c.is_public_alert = true
      AND c.status IN ('received', 'evaluating', 'in_progress')
      AND c.location && ST_MakeEnvelope(p_min_lon, p_min_lat, p_max_lon, p_max_lat, 4326)
    ORDER BY c.alert_published_at DESC NULLS LAST, c.created_at DESC
    LIMIT 301
  ),
  limited AS (
    SELECT * FROM matched LIMIT 300
  )
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', l.id,
          'title', l.title,
          'description', l.description,
          'category_id', l.category_id,
          'category_name', l.category_name,
          'category_color', l.category_color,
          'lat', l.lat,
          'lon', l.lon,
          'alert_published_at', l.alert_published_at,
          'created_at', l.created_at,
          'is_mine', l.is_mine,
          'storage_path', l.storage_path,
          'thumb_path', l.thumb_path
        )
      ),
      '[]'::jsonb
    ),
    (SELECT count(*) FROM matched)
  INTO v_items, v_count
  FROM limited l;

  IF v_count > 300 THEN
    v_truncated := true;
  END IF;

  RETURN jsonb_build_object(
    'items', v_items,
    'truncated', v_truncated
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_public_claim_alerts(double precision, double precision, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_public_claim_alerts(double precision, double precision, double precision, double precision) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_public_claim_alerts(double precision, double precision, double precision, double precision) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_recent_public_alerts(p_limit integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_lim integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_items jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Debés iniciar sesión para ver alertas comunitarias.' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', t.id,
        'title', t.title,
        'description', t.description,
        'category_id', t.category_id,
        'category_name', t.category_name,
        'category_color', t.category_color,
        'lat', t.lat,
        'lon', t.lon,
        'alert_published_at', t.alert_published_at,
        'created_at', t.created_at,
        'is_mine', t.is_mine,
        'storage_path', t.storage_path,
        'thumb_path', t.thumb_path
      )
    ),
    '[]'::jsonb
  )
  INTO v_items
  FROM (
    SELECT
      c.id,
      c.title,
      c.description,
      c.category_id,
      COALESCE(cat.name, 'Reclamo vial') AS category_name,
      COALESCE(cat.color, '#dc2626') AS category_color,
      ST_Y(c.location::geometry) AS lat,
      ST_X(c.location::geometry) AS lon,
      c.alert_published_at,
      c.created_at,
      (c.user_id = v_uid) AS is_mine,
      ph.storage_path,
      ph.thumb_path
    FROM public.claims c
    LEFT JOIN public.claim_categories cat ON cat.id = c.category_id
    LEFT JOIN LATERAL (
      SELECT cp.storage_path, cp.thumb_path
      FROM public.claim_photos cp
      WHERE cp.claim_id = c.id
      ORDER BY cp.created_at ASC
      LIMIT 1
    ) ph ON true
    WHERE c.is_public_alert = true
      AND c.status IN ('received', 'evaluating', 'in_progress')
    ORDER BY c.alert_published_at DESC NULLS LAST, c.created_at DESC
    LIMIT v_lim
  ) t;

  RETURN jsonb_build_object('items', v_items);
END;
$$;

REVOKE ALL ON FUNCTION public.get_recent_public_alerts(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_recent_public_alerts(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_recent_public_alerts(integer) TO authenticated;
