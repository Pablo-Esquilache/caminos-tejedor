-- =============================================================================
-- Migración 001: Esquema inicial de Caminos Rurales de Carlos Tejedor
-- Incluye extensión PostGIS, las 15 tablas del modelo, restricciones e índices
-- =============================================================================

-- 1. Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Tabla: profiles (Dato interno, nunca público)
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Tabla: admins (Define quién es administrador del sistema)
CREATE TABLE IF NOT EXISTS public.admins (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Tabla: trips (Cabecera de recorridos GPS; id UUID generado en el celular)
CREATE TABLE IF NOT EXISTS public.trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  original_name text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  distance_m numeric(12, 2) NOT NULL DEFAULT 0 CHECK (distance_m >= 0),
  duration_s integer NOT NULL DEFAULT 0 CHECK (duration_s >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  auto_approved boolean NOT NULL DEFAULT false,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text,
  simplified_geom geometry(LineString, 4326),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 5. Tabla: trip_tracks (Traza original completa e inmutable, nunca se modifica)
CREATE TABLE IF NOT EXISTS public.trip_tracks (
  trip_id uuid PRIMARY KEY REFERENCES public.trips(id) ON DELETE RESTRICT,
  full_geom geometry(LineString, 4326) NOT NULL,
  raw_points jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 6. Tabla: roads (Caminos rurales consolidados)
CREATE TABLE IF NOT EXISTS public.roads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_name text NOT NULL,
  road_class text NOT NULL DEFAULT 'vecinal' CHECK (road_class IN ('troncal', 'principal', 'secundario', 'vecinal')),
  total_length_m numeric(12, 2) NOT NULL DEFAULT 0 CHECK (total_length_m >= 0),
  approved_trips_count integer NOT NULL DEFAULT 0 CHECK (approved_trips_count >= 0),
  unique_users_count integer NOT NULL DEFAULT 0 CHECK (unique_users_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 7. Tabla: road_segments (Tramos geométricos que componen un camino consolidado)
CREATE TABLE IF NOT EXISTS public.road_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  road_id uuid NOT NULL REFERENCES public.roads(id) ON DELETE CASCADE,
  geom geometry(LineString, 4326) NOT NULL,
  length_m numeric(12, 2) NOT NULL DEFAULT 0 CHECK (length_m >= 0),
  created_by_trip_id uuid REFERENCES public.trips(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 8. Tabla: trip_segment_usage (Relación idempotente entre recorridos aprobados y tramos)
CREATE TABLE IF NOT EXISTS public.trip_segment_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  segment_id uuid NOT NULL REFERENCES public.road_segments(id) ON DELETE CASCADE,
  covered_meters numeric(12, 2) NOT NULL DEFAULT 0 CHECK (covered_meters >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_trip_segment_usage UNIQUE (trip_id, segment_id)
);

-- 9. Tabla: road_name_aliases (Nombres originales asignados por los usuarios a cada camino)
CREATE TABLE IF NOT EXISTS public.road_name_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  road_id uuid NOT NULL REFERENCES public.roads(id) ON DELETE CASCADE,
  original_name text NOT NULL,
  trip_id uuid REFERENCES public.trips(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 10. Tabla: claim_categories (Categorías de reclamos administrables desde el panel)
CREATE TABLE IF NOT EXISTS public.claim_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  icon text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 11. Tabla: claims (Reclamos viales; id UUID generado en el cliente)
CREATE TABLE IF NOT EXISTS public.claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  title text NOT NULL,
  description text,
  category_id uuid NOT NULL REFERENCES public.claim_categories(id) ON DELETE RESTRICT,
  location geometry(Point, 4326) NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'evaluating', 'in_progress', 'solved', 'dismissed')),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 12. Tabla: claim_photos (Rutas en bucket privado de Supabase Storage)
CREATE TABLE IF NOT EXISTS public.claim_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE RESTRICT,
  storage_path text NOT NULL,
  thumb_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_claim_photo_path UNIQUE (claim_id, storage_path)
);

-- 13. Tabla: claim_history (Historial de estados y respuestas al vecino)
CREATE TABLE IF NOT EXISTS public.claim_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE RESTRICT,
  changed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action text NOT NULL,
  old_status text,
  new_status text,
  old_priority text,
  new_priority text,
  message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 14. Tabla: notifications (Bandeja de avisos in-app y control de envío de email)
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  claim_id uuid REFERENCES public.claims(id) ON DELETE SET NULL,
  is_read boolean NOT NULL DEFAULT false,
  email_sent_at timestamptz,
  email_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 15. Tabla: audit_log (Registro de auditoría de acciones administrativas)
CREATE TABLE IF NOT EXISTS public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action text NOT NULL,
  table_name text NOT NULL,
  record_id text NOT NULL,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 16. Tabla: settings (Parámetros de PostGIS y umbrales de clasificación)
CREATE TABLE IF NOT EXISTS public.settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  description text,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Índices Espaciales (GIST) y Comunes (estado, fecha, user_id)
-- =============================================================================

-- Índices GIST en todas las columnas geométricas
CREATE INDEX IF NOT EXISTS idx_trips_simplified_geom ON public.trips USING GIST (simplified_geom);
CREATE INDEX IF NOT EXISTS idx_trip_tracks_full_geom ON public.trip_tracks USING GIST (full_geom);
CREATE INDEX IF NOT EXISTS idx_road_segments_geom ON public.road_segments USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_claims_location ON public.claims USING GIST (location);

-- Índices B-Tree para filtros frecuentes en trips
CREATE INDEX IF NOT EXISTS idx_trips_user_id ON public.trips (user_id);
CREATE INDEX IF NOT EXISTS idx_trips_status ON public.trips (status);
CREATE INDEX IF NOT EXISTS idx_trips_created_at ON public.trips (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trips_status_created_at ON public.trips (status, created_at DESC);

-- Índices B-Tree para caminos y uso de segmentos
CREATE INDEX IF NOT EXISTS idx_road_segments_road_id ON public.road_segments (road_id);
CREATE INDEX IF NOT EXISTS idx_trip_segment_usage_trip_id ON public.trip_segment_usage (trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_segment_usage_segment_id ON public.trip_segment_usage (segment_id);
CREATE INDEX IF NOT EXISTS idx_road_name_aliases_road_id ON public.road_name_aliases (road_id);
CREATE INDEX IF NOT EXISTS idx_roads_road_class ON public.roads (road_class);

-- Índices B-Tree para reclamos, historial y notificaciones
CREATE INDEX IF NOT EXISTS idx_claims_user_id ON public.claims (user_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON public.claims (status);
CREATE INDEX IF NOT EXISTS idx_claims_category_id ON public.claims (category_id);
CREATE INDEX IF NOT EXISTS idx_claims_priority ON public.claims (priority);
CREATE INDEX IF NOT EXISTS idx_claims_created_at ON public.claims (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claim_photos_claim_id ON public.claim_photos (claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_history_claim_id ON public.claim_history (claim_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON public.notifications (user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON public.audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_table_record ON public.audit_log (table_name, record_id);
