-- =============================================================================
-- Migración 003: Políticas Row Level Security (RLS) y Bucket Privado de Storage
-- Regla: Anónimo no ve nada. Usuario común solo ve/inserta lo propio. Admin todo.
-- =============================================================================

-- 1. Activar RLS en TODAS las 15 tablas del esquema
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.road_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_segment_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.road_name_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

-- Asegurar que el rol anon no tenga acceso directo a tablas
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

-- =============================================================================
-- Políticas por tabla (solo para rol authenticated)
-- =============================================================================

-- PROFILES: Usuario lee/edita solo su perfil; Admin lee todos
CREATE POLICY profiles_select_own_or_admin ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_admin());

CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- ADMINS: Usuario puede consultar si su propio user_id es admin; Admin gestiona todos
CREATE POLICY admins_select_own_or_admin ON public.admins
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY admins_manage_by_admin ON public.admins
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- TRIPS: Usuario común inserta y lee solo los suyos (no puede hacer UPDATE ni DELETE)
CREATE POLICY trips_select_own_or_admin ON public.trips
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY trips_insert_own ON public.trips
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY trips_update_admin_only ON public.trips
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- TRIP_TRACKS: Usuario común inserta y lee solo trazas de sus propios recorridos
CREATE POLICY trip_tracks_select_own_or_admin ON public.trip_tracks
  FOR SELECT TO authenticated
  USING (
    public.is_admin() OR EXISTS (
      SELECT 1 FROM public.trips t
      WHERE t.id = trip_tracks.trip_id AND t.user_id = auth.uid()
    )
  );

CREATE POLICY trip_tracks_insert_own ON public.trip_tracks
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.trips t
      WHERE t.id = trip_tracks.trip_id AND t.user_id = auth.uid()
    )
  );

-- ROADS y ROAD_SEGMENTS: Lectura de red consolidada para usuarios autenticados (sin identidades); escritura solo Admin
CREATE POLICY roads_select_authenticated ON public.roads
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY roads_manage_admin ON public.roads
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY road_segments_select_authenticated ON public.road_segments
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY road_segments_manage_admin ON public.road_segments
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- TRIP_SEGMENT_USAGE y ROAD_NAME_ALIASES: Solo administradores (contienen relación con trip_id)
CREATE POLICY trip_segment_usage_admin_only ON public.trip_segment_usage
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY road_name_aliases_admin_only ON public.road_name_aliases
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- CLAIM_CATEGORIES: Usuario lee categorías activas (o asociadas a un reclamo propio histórico); Admin gestiona todas
CREATE POLICY claim_categories_select ON public.claim_categories
  FOR SELECT TO authenticated
  USING (
    is_active = true
    OR public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.claims c
      WHERE c.category_id = claim_categories.id AND c.user_id = auth.uid()
    )
  );

CREATE POLICY claim_categories_manage_admin ON public.claim_categories
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- CLAIMS: Usuario común inserta y lee solo sus propios reclamos; no puede hacer UPDATE ni DELETE
CREATE POLICY claims_select_own_or_admin ON public.claims
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY claims_insert_own ON public.claims
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY claims_update_admin_only ON public.claims
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- CLAIM_PHOTOS: Usuario sube y lee fotos de sus propios reclamos; Admin lee y sube todas
CREATE POLICY claim_photos_select_own_or_admin ON public.claim_photos
  FOR SELECT TO authenticated
  USING (
    public.is_admin() OR EXISTS (
      SELECT 1 FROM public.claims c
      WHERE c.id = claim_photos.claim_id AND c.user_id = auth.uid()
    )
  );

CREATE POLICY claim_photos_insert_own_or_admin ON public.claim_photos
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin() OR EXISTS (
      SELECT 1 FROM public.claims c
      WHERE c.id = claim_photos.claim_id AND c.user_id = auth.uid()
    )
  );

-- CLAIM_HISTORY: Usuario lee el historial de sus propios reclamos; Admin lee e inserta
CREATE POLICY claim_history_select_own_or_admin ON public.claim_history
  FOR SELECT TO authenticated
  USING (
    public.is_admin() OR EXISTS (
      SELECT 1 FROM public.claims c
      WHERE c.id = claim_history.claim_id AND c.user_id = auth.uid()
    )
  );

CREATE POLICY claim_history_insert_admin ON public.claim_history
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

-- NOTIFICATIONS: Usuario lee solo sus notificaciones y puede marcarlas como leídas
CREATE POLICY notifications_select_own_or_admin ON public.notifications
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY notifications_update_own ON public.notifications
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.is_admin())
  WITH CHECK (user_id = auth.uid() OR public.is_admin());

CREATE POLICY notifications_insert_admin ON public.notifications
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

-- AUDIT_LOG y SETTINGS: Exclusivo para administradores
CREATE POLICY audit_log_admin_only ON public.audit_log
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY settings_admin_only ON public.settings
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- =============================================================================
-- Bucket privado en Supabase Storage para fotos de reclamos
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'claim-photos',
  'claim-photos',
  false,
  5242880, -- 5 MB máximo por archivo
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = 5242880,
      allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

-- Políticas en storage.objects: cada usuario sube/lee en su carpeta {user_id}/* y el admin lee/sube todo
DROP POLICY IF EXISTS storage_claim_photos_select ON storage.objects;
CREATE POLICY storage_claim_photos_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'claim-photos'
    AND (
      public.is_admin()
      OR (storage.foldername(name))[1] = auth.uid()::text
    )
  );

DROP POLICY IF EXISTS storage_claim_photos_insert ON storage.objects;
CREATE POLICY storage_claim_photos_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'claim-photos'
    AND (
      public.is_admin()
      OR (storage.foldername(name))[1] = auth.uid()::text
    )
  );
