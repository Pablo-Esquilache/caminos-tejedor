-- =============================================================================
-- Migración 014: Fase 9 - Catálogos (Operarios, Maquinaria, Tipos de Trabajo),
-- Funciones de Rol (is_operator, get_my_role) y Políticas RLS
-- =============================================================================

-- 1. Tabla: operators (Personal municipal / maquinistas, con o sin cuenta en Auth)
CREATE TABLE IF NOT EXISTS public.operators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE REFERENCES public.profiles(id) ON DELETE SET NULL,
  full_name text NOT NULL,
  email text,
  legajo text,
  phone text,
  role_notes text,
  has_account boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_operators_email_lower
  ON public.operators (lower(btrim(email)))
  WHERE email IS NOT NULL AND btrim(email) <> '';

-- 2. Tabla: machines (Maquinaria vial y flota municipal; nunca se borran, se desactivan)
CREATE TABLE IF NOT EXISTS public.machines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text,
  machine_type text NOT NULL CHECK (
    machine_type IN (
      'motoniveladora',
      'retroexcavadora',
      'pala_cargadora',
      'camion_volcador',
      'tractor',
      'desmalezadora',
      'otra'
    )
  ),
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Tabla: work_types (Tipos de trabajo vial; dualidad lineal vs puntual)
CREATE TABLE IF NOT EXISTS public.work_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  execution_mode text NOT NULL CHECK (execution_mode IN ('linear', 'punctual')),
  color text NOT NULL DEFAULT '#0ea5e9',
  description text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Índices auxiliares
CREATE INDEX IF NOT EXISTS idx_operators_active ON public.operators (is_active);
CREATE INDEX IF NOT EXISTS idx_machines_active ON public.machines (is_active);
CREATE INDEX IF NOT EXISTS idx_work_types_active ON public.work_types (is_active, sort_order);

-- Triggers updated_at (reutilizamos touch_updated_at() si existe, o definimos uno local)
CREATE OR REPLACE FUNCTION public.touch_catalog_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_operators_updated_at ON public.operators;
CREATE TRIGGER trg_operators_updated_at
  BEFORE UPDATE ON public.operators
  FOR EACH ROW EXECUTE FUNCTION public.touch_catalog_updated_at();

DROP TRIGGER IF EXISTS trg_machines_updated_at ON public.machines;
CREATE TRIGGER trg_machines_updated_at
  BEFORE UPDATE ON public.machines
  FOR EACH ROW EXECUTE FUNCTION public.touch_catalog_updated_at();

DROP TRIGGER IF EXISTS trg_work_types_updated_at ON public.work_types;
CREATE TRIGGER trg_work_types_updated_at
  BEFORE UPDATE ON public.work_types
  FOR EACH ROW EXECUTE FUNCTION public.touch_catalog_updated_at();

-- 4. Datos iniciales del catálogo de Tipos de Trabajo (idempotente)
INSERT INTO public.work_types (name, execution_mode, color, description, sort_order)
VALUES
  ('Perfilado / Repaso', 'linear', '#0ea5e9', 'Repaso de calzada con motoniveladora manteniendo bombeo.', 1),
  ('Abovedado y Cuneteo', 'linear', '#2563eb', 'Conformación de lomo central y limpieza de cunetas laterales.', 2),
  ('Alteo / Consolidación de suelo', 'linear', '#7c3aed', 'Levantamiento de traza en bajos y estabilización con tosca o suelo seleccionado.', 3),
  ('Desmalezado de banquinas', 'linear', '#16a34a', 'Corte de pastizales y limpieza de visibilidad en cruces y banquinas.', 4),
  ('Colocación de alcantarilla / tubos', 'punctual', '#f59e0b', 'Instalación o reemplazo puntual de tubos y cabeceras de hormigón.', 5),
  ('Bacheo / Relleno puntual', 'punctual', '#ef4444', 'Reparación puntual de cortes, huellones profundos o pozos.', 6),
  ('Limpieza de puente / vado / desagüe', 'punctual', '#06b6d4', 'Desobstrucción puntual de alcantarillas y canales de desagüe.', 7)
ON CONFLICT (name) DO NOTHING;

-- 5. Funciones de rol: is_operator() y get_my_role()
CREATE OR REPLACE FUNCTION public.is_operator()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.operators o
    WHERE o.user_id = auth.uid()
      AND o.is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION public.get_my_operator_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id
  FROM public.operators o
  WHERE o.user_id = auth.uid()
    AND o.is_active = true
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN 'anon';
  END IF;
  IF public.is_admin() THEN
    RETURN 'admin';
  END IF;
  IF public.is_operator() THEN
    RETURN 'operator';
  END IF;
  RETURN 'user';
END;
$$;

-- 6. Seguridad RLS estricta en los catálogos
ALTER TABLE public.operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_types ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.operators FROM anon;
REVOKE ALL ON public.machines FROM anon;
REVOKE ALL ON public.work_types FROM anon;

-- OPERATORS: El operario ve solo su propio registro; Admin gestiona todo (sin DELETE real)
DROP POLICY IF EXISTS operators_select_own_or_admin ON public.operators;
CREATE POLICY operators_select_own_or_admin ON public.operators
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS operators_insert_admin ON public.operators;
CREATE POLICY operators_insert_admin ON public.operators
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS operators_update_admin ON public.operators;
CREATE POLICY operators_update_admin ON public.operators
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- MACHINES: Solo operadores activos y admins ven flota; Admin crea/edita/desactiva
DROP POLICY IF EXISTS machines_select_staff ON public.machines;
CREATE POLICY machines_select_staff ON public.machines
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR (public.is_operator() AND is_active = true)
  );

DROP POLICY IF EXISTS machines_insert_admin ON public.machines;
CREATE POLICY machines_insert_admin ON public.machines
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS machines_update_admin ON public.machines;
CREATE POLICY machines_update_admin ON public.machines
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- WORK_TYPES: Autenticados leen tipos activos (para capa general); Admin gestiona todos
DROP POLICY IF EXISTS work_types_select_authenticated ON public.work_types;
CREATE POLICY work_types_select_authenticated ON public.work_types
  FOR SELECT TO authenticated
  USING (is_active = true OR public.is_admin() OR public.is_operator());

DROP POLICY IF EXISTS work_types_insert_admin ON public.work_types;
CREATE POLICY work_types_insert_admin ON public.work_types
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS work_types_update_admin ON public.work_types;
CREATE POLICY work_types_update_admin ON public.work_types
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 7. RPC para listar compañeros operarios sin exponer email ni teléfono (privacidad)
CREATE OR REPLACE FUNCTION public.list_active_staff_catalogs()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF NOT (public.is_admin() OR public.is_operator()) THEN
    RAISE EXCEPTION 'Permiso denegado: solo personal municipal autorizado.';
  END IF;

  RETURN jsonb_build_object(
    'work_types', COALESCE((
      SELECT jsonb_agg(row_to_json(w))
      FROM (
        SELECT id, name, execution_mode, color, description, sort_order
        FROM public.work_types
        WHERE is_active = true
        ORDER BY sort_order ASC, name ASC
      ) w
    ), '[]'::jsonb),
    'machines', COALESCE((
      SELECT jsonb_agg(row_to_json(m))
      FROM (
        SELECT id, name, code, machine_type, description
        FROM public.machines
        WHERE is_active = true
        ORDER BY name ASC
      ) m
    ), '[]'::jsonb),
    'operators', COALESCE((
      SELECT jsonb_agg(row_to_json(o))
      FROM (
        SELECT id, full_name, legajo, has_account, (user_id = auth.uid()) AS is_me
        FROM public.operators
        WHERE is_active = true
        ORDER BY full_name ASC
      ) o
    ), '[]'::jsonb)
  );
END;
$$;

-- 8. RPCs del Panel Web Admin para administrar catálogos y cuentas de operarios
CREATE OR REPLACE FUNCTION public.admin_list_catalogs()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.';
  END IF;

  RETURN jsonb_build_object(
    'operators', COALESCE((
      SELECT jsonb_agg(row_to_json(o))
      FROM (
        SELECT
          op.id, op.user_id, op.full_name, op.email, op.legajo, op.phone,
          op.role_notes, op.has_account, op.is_active, op.created_at, op.updated_at
        FROM public.operators op
        ORDER BY op.is_active DESC, op.full_name ASC
      ) o
    ), '[]'::jsonb),
    'machines', COALESCE((
      SELECT jsonb_agg(row_to_json(m))
      FROM (
        SELECT id, name, code, machine_type, description, is_active, created_at, updated_at
        FROM public.machines
        ORDER BY is_active DESC, name ASC
      ) m
    ), '[]'::jsonb),
    'work_types', COALESCE((
      SELECT jsonb_agg(row_to_json(w))
      FROM (
        SELECT id, name, execution_mode, color, description, is_active, sort_order, created_at, updated_at
        FROM public.work_types
        ORDER BY is_active DESC, sort_order ASC, name ASC
      ) w
    ), '[]'::jsonb)
  );
END;
$$;

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

  -- Si se solicita cuenta con usuario/clave en Supabase Auth (para iniciar sesión en la app móvil)
  IF COALESCE(p_create_account, false) AND v_user_id IS NULL THEN
    IF v_clean_email IS NULL OR position('@' IN v_clean_email) = 0 THEN
      RAISE EXCEPTION 'Ingresá un correo válido para crear la cuenta del operario.';
    END IF;

    -- Verificar si ya existe en auth.users
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
        instance_id,
        id,
        aud,
        role,
        email,
        encrypted_password,
        email_confirmed_at,
        confirmation_token,
        recovery_token,
        email_change_token_new,
        email_change,
        phone_change,
        phone_change_token,
        email_change_token_current,
        reauthentication_token,
        raw_app_meta_data,
        raw_user_meta_data,
        is_sso_user,
        is_anonymous,
        created_at,
        updated_at
      ) VALUES (
        '00000000-0000-0000-0000-000000000000'::uuid,
        v_user_id,
        'authenticated',
        'authenticated',
        v_clean_email,
        extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
        now(),
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('full_name', v_clean_name, 'email_verified', true),
        false,
        false,
        now(),
        now()
      );

      INSERT INTO auth.identities (
        id,
        user_id,
        identity_data,
        provider,
        provider_id,
        last_sign_in_at,
        created_at,
        updated_at
      ) VALUES (
        gen_random_uuid(),
        v_user_id,
        jsonb_build_object(
          'sub', v_user_id::text,
          'email', v_clean_email,
          'email_verified', true,
          'phone_verified', false
        ),
        'email',
        v_user_id::text,
        now(),
        now(),
        now()
      );
    ELSE
      -- Asegurar que profiles exista y actualizar contraseña si el admin indicó una nueva
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

  -- Sincronizar perfil y bloqueo/desbloqueo de login si el operario tiene cuenta Auth
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
