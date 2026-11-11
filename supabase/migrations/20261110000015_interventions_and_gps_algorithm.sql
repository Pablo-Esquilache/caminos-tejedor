-- =============================================================================
-- Migración 015: Fases 10, 12, 13 y 14 - Intervenciones Viales, Sesiones
-- Multi-Jornada, Algoritmo GPS de Tramo Trabajado, Capa de Mapa y Estadísticas
-- =============================================================================

-- 1. Tabla principal: interventions (Independiente de road_segments; road_id es opcional)
CREATE TABLE IF NOT EXISTS public.interventions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  execution_mode text NOT NULL CHECK (execution_mode IN ('linear', 'punctual')),
  origin text NOT NULL DEFAULT 'planned' CHECK (origin IN ('planned', 'spontaneous')),
  status text NOT NULL DEFAULT 'planned' CHECK (
    status IN ('planned', 'in_progress', 'suspended', 'pending_approval', 'approved', 'rejected')
  ),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  road_id uuid REFERENCES public.roads(id) ON DELETE SET NULL,
  road_name_snapshot text,
  definition_mode text CHECK (
    definition_mode IN (
      'consolidated_road',
      'points_along_road',
      'freehand_draw',
      'gps_field',
      'punctual_point'
    )
  ),
  planned_geom geometry(Geometry, 4326),
  planned_length_m numeric(12, 2) NOT NULL DEFAULT 0 CHECK (planned_length_m >= 0),
  worked_geom geometry(Geometry, 4326),
  worked_length_m numeric(12, 2) NOT NULL DEFAULT 0 CHECK (worked_length_m >= 0),
  total_gps_distance_m numeric(12, 2) NOT NULL DEFAULT 0 CHECK (total_gps_distance_m >= 0),
  duration_s integer NOT NULL DEFAULT 0 CHECK (duration_s >= 0),
  sessions_count integer NOT NULL DEFAULT 0 CHECK (sessions_count >= 0),
  responsible_operator_id uuid REFERENCES public.operators(id) ON DELETE SET NULL,
  linked_claim_id uuid REFERENCES public.claims(id) ON DELETE SET NULL,
  scheduled_date date,
  started_at timestamptz,
  completed_at timestamptz,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_interventions_status ON public.interventions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_interventions_road_id ON public.interventions (road_id);
CREATE INDEX IF NOT EXISTS idx_interventions_resp_op ON public.interventions (responsible_operator_id);
CREATE INDEX IF NOT EXISTS idx_interventions_planned_geom ON public.interventions USING GIST (planned_geom);
CREATE INDEX IF NOT EXISTS idx_interventions_worked_geom ON public.interventions USING GIST (worked_geom);

-- 2. Tablas puente: Tipos de trabajo, Maquinarias y Operarios asignados/participantes
CREATE TABLE IF NOT EXISTS public.intervention_work_types (
  intervention_id uuid NOT NULL REFERENCES public.interventions(id) ON DELETE CASCADE,
  work_type_id uuid NOT NULL REFERENCES public.work_types(id) ON DELETE RESTRICT,
  PRIMARY KEY (intervention_id, work_type_id)
);

CREATE TABLE IF NOT EXISTS public.intervention_machines (
  intervention_id uuid NOT NULL REFERENCES public.interventions(id) ON DELETE CASCADE,
  machine_id uuid NOT NULL REFERENCES public.machines(id) ON DELETE RESTRICT,
  PRIMARY KEY (intervention_id, machine_id)
);

CREATE TABLE IF NOT EXISTS public.intervention_operators (
  intervention_id uuid NOT NULL REFERENCES public.interventions(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES public.operators(id) ON DELETE RESTRICT,
  is_responsible boolean NOT NULL DEFAULT false,
  PRIMARY KEY (intervention_id, operator_id)
);

-- 3. Tabla: intervention_sessions (Permite múltiples jornadas diarias bajo la misma intervención)
CREATE TABLE IF NOT EXISTS public.intervention_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intervention_id uuid NOT NULL REFERENCES public.interventions(id) ON DELETE CASCADE,
  operator_id uuid REFERENCES public.operators(id) ON DELETE SET NULL,
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  raw_points jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_geom geometry(Geometry, 4326),
  raw_distance_m numeric(12, 2) NOT NULL DEFAULT 0 CHECK (raw_distance_m >= 0),
  duration_s integer NOT NULL DEFAULT 0 CHECK (duration_s >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intervention_sessions_int_id ON public.intervention_sessions (intervention_id, started_at);
CREATE INDEX IF NOT EXISTS idx_intervention_sessions_geom ON public.intervention_sessions USING GIST (raw_geom);

-- 4. Tabla: intervention_photos (Fotos de respaldo en el bucket privado claim-photos)
CREATE TABLE IF NOT EXISTS public.intervention_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intervention_id uuid NOT NULL REFERENCES public.interventions(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.intervention_sessions(id) ON DELETE SET NULL,
  storage_path text NOT NULL,
  thumb_path text,
  uploaded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_intervention_photo_path UNIQUE (intervention_id, storage_path)
);

-- 5. Tabla: intervention_history (Auditoría de cambios y validaciones)
CREATE TABLE IF NOT EXISTS public.intervention_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intervention_id uuid NOT NULL REFERENCES public.interventions(id) ON DELETE CASCADE,
  changed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action text NOT NULL,
  old_status text,
  new_status text,
  message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intervention_history_int_id ON public.intervention_history (intervention_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_interventions_updated_at ON public.interventions;
CREATE TRIGGER trg_interventions_updated_at
  BEFORE UPDATE ON public.interventions
  FOR EACH ROW EXECUTE FUNCTION public.touch_catalog_updated_at();

-- =============================================================================
-- 6. RLS y Permisos sobre Intervenciones
-- =============================================================================
ALTER TABLE public.interventions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intervention_work_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intervention_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intervention_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intervention_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intervention_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intervention_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.interventions FROM anon;
REVOKE ALL ON public.intervention_work_types FROM anon;
REVOKE ALL ON public.intervention_machines FROM anon;
REVOKE ALL ON public.intervention_operators FROM anon;
REVOKE ALL ON public.intervention_sessions FROM anon;
REVOKE ALL ON public.intervention_photos FROM anon;
REVOKE ALL ON public.intervention_history FROM anon;

-- INTERVENTIONS:
-- Admin ve y edita todo.
-- Operario ve tareas (asignadas, abiertas/planificadas o aprobadas).
-- Vecino común SOLO puede ver intervenciones aprobadas (la identidad de operarios está en otras tablas o se omite en RPC).
DROP POLICY IF EXISTS interventions_select_by_role ON public.interventions;
CREATE POLICY interventions_select_by_role ON public.interventions
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR public.is_operator()
    OR status = 'approved'
  );

DROP POLICY IF EXISTS interventions_admin_all ON public.interventions;
CREATE POLICY interventions_admin_all ON public.interventions
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Tablas puente work_types y machines: visibles para autenticados en trabajos aprobados, staff ve todo
DROP POLICY IF EXISTS int_work_types_select ON public.intervention_work_types;
CREATE POLICY int_work_types_select ON public.intervention_work_types
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR public.is_operator()
    OR EXISTS (SELECT 1 FROM public.interventions i WHERE i.id = intervention_id AND i.status = 'approved')
  );

DROP POLICY IF EXISTS int_work_types_admin_all ON public.intervention_work_types;
CREATE POLICY int_work_types_admin_all ON public.intervention_work_types
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS int_machines_select ON public.intervention_machines;
CREATE POLICY int_machines_select ON public.intervention_machines
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR public.is_operator()
    OR EXISTS (SELECT 1 FROM public.interventions i WHERE i.id = intervention_id AND i.status = 'approved')
  );

DROP POLICY IF EXISTS int_machines_admin_all ON public.intervention_machines;
CREATE POLICY int_machines_admin_all ON public.intervention_machines
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- INTERVENTION_OPERATORS: Privacidad gremial — los vecinos comunes NUNCA ven qué operario hizo un trabajo
DROP POLICY IF EXISTS int_operators_select_staff ON public.intervention_operators;
CREATE POLICY int_operators_select_staff ON public.intervention_operators
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_operator());

DROP POLICY IF EXISTS int_operators_admin_all ON public.intervention_operators;
CREATE POLICY int_operators_admin_all ON public.intervention_operators
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- SESSIONS, PHOTOS y HISTORY: Solo personal autorizado (operarios y administradores)
DROP POLICY IF EXISTS int_sessions_select_staff ON public.intervention_sessions;
CREATE POLICY int_sessions_select_staff ON public.intervention_sessions
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_operator());

DROP POLICY IF EXISTS int_sessions_admin_all ON public.intervention_sessions;
CREATE POLICY int_sessions_admin_all ON public.intervention_sessions
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS int_photos_select_staff ON public.intervention_photos;
CREATE POLICY int_photos_select_staff ON public.intervention_photos
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_operator());

DROP POLICY IF EXISTS int_photos_admin_all ON public.intervention_photos;
CREATE POLICY int_photos_admin_all ON public.intervention_photos
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS int_history_select_staff ON public.intervention_history;
CREATE POLICY int_history_select_staff ON public.intervention_history
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_operator());

DROP POLICY IF EXISTS int_history_admin_all ON public.intervention_history;
CREATE POLICY int_history_admin_all ON public.intervention_history
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Ampliar lectura de storage para que operarios también puedan ver sus propias fotos o de sus intervenciones
DROP POLICY IF EXISTS storage_intervention_photos_select ON storage.objects;
CREATE POLICY storage_intervention_photos_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'claim-photos'
    AND (
      public.is_admin()
      OR (storage.foldername(name))[1] = auth.uid()::text
      OR (
        public.is_operator()
        AND EXISTS (
          SELECT 1 FROM public.intervention_photos ip
          WHERE ip.storage_path = name OR ip.thumb_path = name
        )
      )
    )
  );

-- =============================================================================
-- 7. Fase 12: Algoritmo GPS de Tramo Trabajado (Deduplicación de pasadas ida/vuelta)
-- =============================================================================

-- Parámetro configurable en settings para procesamiento de pasadas de maquinaria
INSERT INTO public.settings (key, value, description)
VALUES (
  'intervention_gps_params',
  '{"stop_cluster_radius_m": 12, "pass_dedup_buffer_m": 24, "uturn_split_angle_deg": 125, "min_pass_segment_m": 25}'::jsonb,
  'Parámetros PostGIS (UTM 20S) para extraer el tramo real trabajado descartando pasadas repetidas de ida y vuelta y paradas largas.'
)
ON CONFLICT (key) DO NOTHING;

-- Divide una línea en UTM 20S en pasadas continuas cada vez que hay un giro en U (> 125°)
-- manteniendo intactas las curvas suaves y esquinas a 90 grados.
CREATE OR REPLACE FUNCTION public.split_utm_line_on_uturns(
  p_line_utm geometry,
  p_uturn_angle_deg double precision DEFAULT 125.0
)
RETURNS geometry[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_simp geometry;
  v_npts integer;
  v_i integer;
  v_pts geometry[];
  v_cur_pts geometry[] := ARRAY[]::geometry[];
  v_res geometry[] := ARRAY[]::geometry[];
  v_p_prev geometry;
  v_p_curr geometry;
  v_p_next geometry;
  v_az1 double precision;
  v_az2 double precision;
  v_diff double precision;
  v_line geometry;
BEGIN
  IF p_line_utm IS NULL OR ST_IsEmpty(p_line_utm) THEN
    RETURN v_res;
  END IF;

  -- Si es MultiLineString procesamos cada parte simple recursivamente
  IF ST_GeometryType(p_line_utm) = 'ST_MultiLineString' THEN
    FOR v_line IN SELECT geom FROM ST_Dump(p_line_utm) LOOP
      v_res := v_res || public.split_utm_line_on_uturns(v_line, p_uturn_angle_deg);
    END LOOP;
    RETURN v_res;
  END IF;

  IF ST_GeometryType(p_line_utm) <> 'ST_LineString' THEN
    RETURN v_res;
  END IF;

  -- Colapsar ruido de parado (12 m) y simplificar preservando topología (4 m)
  v_simp := ST_SimplifyPreserveTopology(p_line_utm, 4.0);
  IF v_simp IS NULL OR ST_NPoints(v_simp) < 2 THEN
    v_simp := p_line_utm;
  END IF;

  v_npts := ST_NPoints(v_simp);
  IF v_npts < 2 THEN
    RETURN v_res;
  END IF;

  IF v_npts = 2 THEN
    IF ST_Length(v_simp) >= 5.0 THEN
      RETURN ARRAY[v_simp];
    END IF;
    RETURN v_res;
  END IF;

  SELECT ARRAY(
    SELECT (dp).geom
    FROM ST_DumpPoints(v_simp) AS dp
  ) INTO v_pts;

  v_cur_pts := ARRAY[v_pts[1], v_pts[2]];

  FOR v_i IN 2..(array_length(v_pts, 1) - 1) LOOP
    v_p_prev := v_pts[v_i - 1];
    v_p_curr := v_pts[v_i];
    v_p_next := v_pts[v_i + 1];

    IF NOT ST_Equals(v_p_prev, v_p_curr) AND NOT ST_Equals(v_p_curr, v_p_next) THEN
      v_az1 := degrees(ST_Azimuth(v_p_prev, v_p_curr));
      v_az2 := degrees(ST_Azimuth(v_p_curr, v_p_next));
      v_diff := ABS(v_az1 - v_az2);
      IF v_diff > 180.0 THEN
        v_diff := 360.0 - v_diff;
      END IF;

      -- Si invirtió el sentido de marcha (giro en U > umbral), cerrar pasada actual e iniciar nueva
      IF v_diff > p_uturn_angle_deg THEN
        v_line := ST_MakeLine(v_cur_pts);
        IF ST_Length(v_line) >= 10.0 THEN
          v_res := array_append(v_res, v_line);
        END IF;
        v_cur_pts := ARRAY[v_p_curr, v_p_next];
      ELSE
        v_cur_pts := array_append(v_cur_pts, v_p_next);
      END IF;
    ELSE
      v_cur_pts := array_append(v_cur_pts, v_p_next);
    END IF;
  END LOOP;

  IF array_length(v_cur_pts, 1) >= 2 THEN
    v_line := ST_MakeLine(v_cur_pts);
    IF ST_Length(v_line) >= 10.0 THEN
      v_res := array_append(v_res, v_line);
    END IF;
  END IF;

  RETURN v_res;
END;
$$;

-- Consolida múltiples pasadas y jornadas en una geometría neta sin duplicar metros recorridos
CREATE OR REPLACE FUNCTION public.extract_worked_tramo_utm(
  p_raw_geoms_4326 geometry[],
  p_stop_radius_m double precision DEFAULT 12.0,
  p_pass_buffer_m double precision DEFAULT 24.0,
  p_uturn_angle_deg double precision DEFAULT 125.0,
  p_min_segment_m double precision DEFAULT 25.0
)
RETURNS geometry
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_raw_geom geometry;
  v_geom_utm geometry;
  v_clean_utm geometry;
  v_passes geometry[];
  v_pass geometry;
  v_covered_buf geometry := NULL;
  v_kept_parts geometry := NULL;
  v_diff geometry;
  v_comp geometry;
  v_merged geometry;
BEGIN
  IF p_raw_geoms_4326 IS NULL OR array_length(p_raw_geoms_4326, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  FOREACH v_raw_geom IN ARRAY p_raw_geoms_4326 LOOP
    IF v_raw_geom IS NULL OR ST_IsEmpty(v_raw_geom) THEN
      CONTINUE;
    END IF;

    v_geom_utm := ST_Transform(v_raw_geom, 32720);
    v_clean_utm := ST_RemoveRepeatedPoints(v_geom_utm, p_stop_radius_m);
    IF v_clean_utm IS NULL OR ST_NPoints(v_clean_utm) < 2 THEN
      v_clean_utm := v_geom_utm;
    END IF;

    v_passes := public.split_utm_line_on_uturns(v_clean_utm, p_uturn_angle_deg);
    IF array_length(v_passes, 1) IS NULL THEN
      CONTINUE;
    END IF;

    FOREACH v_pass IN ARRAY v_passes LOOP
      IF ST_Length(v_pass) < p_min_segment_m THEN
        CONTINUE;
      END IF;

      IF v_covered_buf IS NULL THEN
        v_kept_parts := v_pass;
        v_covered_buf := ST_Buffer(v_pass, p_pass_buffer_m, 'endcap=round join=round');
      ELSE
        -- Recortar únicamente los sub-tramos que NO estén ya cubiertos por pasadas previas
        v_diff := ST_CollectionExtract(ST_Difference(v_pass, v_covered_buf), 2);
        IF v_diff IS NOT NULL AND NOT ST_IsEmpty(v_diff) THEN
          FOR v_comp IN SELECT geom FROM ST_Dump(v_diff) LOOP
            IF ST_GeometryType(v_comp) = 'ST_LineString' AND ST_Length(v_comp) >= p_min_segment_m THEN
              v_kept_parts := CASE
                WHEN v_kept_parts IS NULL THEN v_comp
                ELSE ST_Collect(v_kept_parts, v_comp)
              END;
              v_covered_buf := ST_Union(
                v_covered_buf,
                ST_Buffer(v_comp, p_pass_buffer_m, 'endcap=round join=round')
              );
            END IF;
          END LOOP;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  IF v_kept_parts IS NULL OR ST_IsEmpty(v_kept_parts) THEN
    RETURN NULL;
  END IF;

  v_merged := ST_LineMerge(v_kept_parts);
  RETURN v_merged;
END;
$$;

-- Recalcula métricas y geometría consolidada trabajada de una intervención desde sus sesiones
CREATE OR REPLACE FUNCTION public.recalculate_intervention_worked_metrics(p_intervention_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_int public.interventions;
  v_params jsonb;
  v_stop_r double precision;
  v_buf_m double precision;
  v_uturn_deg double precision;
  v_min_seg double precision;
  v_geoms geometry[];
  v_worked_utm geometry;
  v_worked_4326 geometry := NULL;
  v_worked_len numeric(12, 2) := 0;
  v_total_gps numeric(12, 2) := 0;
  v_total_dur integer := 0;
  v_sess_cnt integer := 0;
  v_min_start timestamptz;
  v_max_end timestamptz;
BEGIN
  SELECT * INTO v_int FROM public.interventions WHERE id = p_intervention_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT
    COUNT(*)::int,
    COALESCE(SUM(raw_distance_m), 0),
    COALESCE(SUM(duration_s), 0),
    MIN(started_at),
    MAX(ended_at),
    ARRAY_AGG(raw_geom ORDER BY started_at ASC) FILTER (WHERE raw_geom IS NOT NULL)
  INTO v_sess_cnt, v_total_gps, v_total_dur, v_min_start, v_max_end, v_geoms
  FROM public.intervention_sessions
  WHERE intervention_id = p_intervention_id;

  IF v_int.execution_mode = 'punctual' THEN
    -- Para tareas puntuales (alcantarilla / bacheo), tomamos el último punto reportado y longitud 0
    IF v_geoms IS NOT NULL AND array_length(v_geoms, 1) > 0 THEN
      v_worked_4326 := ST_Centroid(v_geoms[array_length(v_geoms, 1)]);
    END IF;
    v_worked_len := 0;
  ELSE
    SELECT value INTO v_params FROM public.settings WHERE key = 'intervention_gps_params';
    v_stop_r := COALESCE((v_params->>'stop_cluster_radius_m')::double precision, 12.0);
    v_buf_m := COALESCE((v_params->>'pass_dedup_buffer_m')::double precision, 24.0);
    v_uturn_deg := COALESCE((v_params->>'uturn_split_angle_deg')::double precision, 125.0);
    v_min_seg := COALESCE((v_params->>'min_pass_segment_m')::double precision, 25.0);

    v_worked_utm := public.extract_worked_tramo_utm(v_geoms, v_stop_r, v_buf_m, v_uturn_deg, v_min_seg);
    IF v_worked_utm IS NOT NULL AND NOT ST_IsEmpty(v_worked_utm) THEN
      v_worked_4326 := ST_Transform(v_worked_utm, 4326);
      v_worked_len := ROUND(ST_Length(v_worked_utm)::numeric, 2);
    END IF;
  END IF;

  UPDATE public.interventions
  SET
    worked_geom = COALESCE(v_worked_4326, worked_geom),
    worked_length_m = CASE WHEN v_int.execution_mode = 'linear' THEN v_worked_len ELSE 0 END,
    total_gps_distance_m = ROUND(v_total_gps::numeric, 2),
    duration_s = v_total_dur,
    sessions_count = v_sess_cnt,
    started_at = COALESCE(started_at, v_min_start),
    updated_at = now()
  WHERE id = p_intervention_id;
END;
$$;

-- =============================================================================
-- 8. Fase 10: RPCs para Panel Web Admin (Planificación, Subtramo y Mapa General)
-- =============================================================================

-- Modo (b) de definición de tramo: Calcular subtramo exacto siguiendo curvas del camino consolidado
CREATE OR REPLACE FUNCTION public.admin_compute_road_substring_geojson(
  p_road_id uuid,
  p_start_lon double precision,
  p_start_lat double precision,
  p_end_lon double precision,
  p_end_lat double precision
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_merged_utm geometry;
  v_comp geometry;
  v_pt_a_utm geometry;
  v_pt_b_utm geometry;
  v_frac_a double precision;
  v_frac_b double precision;
  v_sub_utm geometry;
  v_best_utm geometry := NULL;
  v_best_score double precision := 1e18;
  v_score double precision;
  v_len_m numeric(12, 2);
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.';
  END IF;

  v_pt_a_utm := ST_Transform(ST_SetSRID(ST_MakePoint(p_start_lon, p_start_lat), 4326), 32720);
  v_pt_b_utm := ST_Transform(ST_SetSRID(ST_MakePoint(p_end_lon, p_end_lat), 4326), 32720);

  SELECT ST_LineMerge(ST_Collect(ST_Transform(s.geom, 32720)))
  INTO v_merged_utm
  FROM public.road_segments s
  WHERE s.road_id = p_road_id;

  IF v_merged_utm IS NULL OR ST_IsEmpty(v_merged_utm) THEN
    RAISE EXCEPTION 'El camino seleccionado no tiene segmentos geométricos.';
  END IF;

  -- Si hay múltiples componentes, elegir la que minimiza la suma de distancias a ambos puntos
  FOR v_comp IN SELECT geom FROM ST_Dump(v_merged_utm) LOOP
    IF ST_GeometryType(v_comp) = 'ST_LineString' AND ST_Length(v_comp) > 1 THEN
      v_score := ST_Distance(v_comp, v_pt_a_utm) + ST_Distance(v_comp, v_pt_b_utm);
      IF v_score < v_best_score THEN
        v_best_score := v_score;
        v_best_utm := v_comp;
      END IF;
    END IF;
  END LOOP;

  IF v_best_utm IS NULL THEN
    RAISE EXCEPTION 'No se pudo proyectar el tramo sobre el camino.';
  END IF;

  v_frac_a := ST_LineLocatePoint(v_best_utm, v_pt_a_utm);
  v_frac_b := ST_LineLocatePoint(v_best_utm, v_pt_b_utm);

  IF ABS(v_frac_b - v_frac_a) < 0.0005 THEN
    -- Evitar subtramo degenerado
    v_sub_utm := v_best_utm;
  ELSE
    v_sub_utm := ST_LineSubstring(v_best_utm, LEAST(v_frac_a, v_frac_b), GREATEST(v_frac_a, v_frac_b));
  END IF;

  v_len_m := ROUND(ST_Length(v_sub_utm)::numeric, 2);

  RETURN jsonb_build_object(
    'geojson', ST_AsGeoJSON(ST_Transform(v_sub_utm, 4326))::jsonb,
    'length_m', v_len_m
  );
END;
$$;

-- Crear o actualizar intervención planificada desde /admin
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

  -- Resolver nombre del camino opcional
  IF p_road_id IS NOT NULL THEN
    SELECT normalized_name INTO v_road_name FROM public.roads WHERE id = p_road_id;
  END IF;

  -- Construir geometría planificada desde GeoJSON o desde road_id completo
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

  -- Sincronizar tipos de trabajo
  DELETE FROM public.intervention_work_types WHERE intervention_id = v_row.id;
  IF array_length(p_work_type_ids, 1) IS NOT NULL THEN
    FOREACH v_wid IN ARRAY p_work_type_ids LOOP
      INSERT INTO public.intervention_work_types (intervention_id, work_type_id)
      VALUES (v_row.id, v_wid)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  -- Sincronizar maquinarias
  DELETE FROM public.intervention_machines WHERE intervention_id = v_row.id;
  IF array_length(p_machine_ids, 1) IS NOT NULL THEN
    FOREACH v_mid IN ARRAY p_machine_ids LOOP
      INSERT INTO public.intervention_machines (intervention_id, machine_id)
      VALUES (v_row.id, v_mid)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  -- Sincronizar operarios (incluyendo siempre al responsable si se indicó)
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

      -- Notificar si es nueva asignación y el operario tiene cuenta Auth
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

-- Listado paginado de intervenciones para /admin con filtros completos
CREATE OR REPLACE FUNCTION public.admin_list_interventions(
  p_status text DEFAULT NULL,
  p_work_type_id uuid DEFAULT NULL,
  p_machine_id uuid DEFAULT NULL,
  p_operator_id uuid DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total integer;
  v_pending_cnt integer;
  v_items jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.';
  END IF;

  SELECT count(*)::int INTO v_pending_cnt
  FROM public.interventions
  WHERE status = 'pending_approval';

  SELECT count(*)::int INTO v_total
  FROM public.interventions i
  WHERE (p_status IS NULL OR p_status = 'all' OR i.status = p_status)
    AND (p_work_type_id IS NULL OR EXISTS (SELECT 1 FROM public.intervention_work_types iw WHERE iw.intervention_id = i.id AND iw.work_type_id = p_work_type_id))
    AND (p_machine_id IS NULL OR EXISTS (SELECT 1 FROM public.intervention_machines im WHERE im.intervention_id = i.id AND im.machine_id = p_machine_id))
    AND (p_operator_id IS NULL OR EXISTS (SELECT 1 FROM public.intervention_operators io WHERE io.intervention_id = i.id AND io.operator_id = p_operator_id))
    AND (p_date_from IS NULL OR i.created_at >= p_date_from)
    AND (p_date_to IS NULL OR i.created_at <= p_date_to);

  SELECT COALESCE(jsonb_agg(row_to_json(q)), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      i.id,
      i.title,
      i.description,
      i.execution_mode,
      i.origin,
      i.status,
      i.priority,
      i.road_id,
      COALESCE(r.normalized_name, i.road_name_snapshot) AS road_name,
      i.definition_mode,
      i.planned_length_m,
      i.worked_length_m,
      i.total_gps_distance_m,
      i.duration_s,
      i.sessions_count,
      i.scheduled_date,
      i.started_at,
      i.completed_at,
      i.linked_claim_id,
      i.reviewed_at,
      i.review_note,
      i.created_at,
      op_resp.full_name AS responsible_operator_name,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', wt.id, 'name', wt.name, 'color', wt.color, 'execution_mode', wt.execution_mode))
        FROM public.intervention_work_types iw
        JOIN public.work_types wt ON wt.id = iw.work_type_id
        WHERE iw.intervention_id = i.id
      ), '[]'::jsonb) AS work_types,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'code', m.code, 'machine_type', m.machine_type))
        FROM public.intervention_machines im
        JOIN public.machines m ON m.id = im.machine_id
        WHERE im.intervention_id = i.id
      ), '[]'::jsonb) AS machines,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', o.id, 'full_name', o.full_name, 'is_responsible', io.is_responsible))
        FROM public.intervention_operators io
        JOIN public.operators o ON o.id = io.operator_id
        WHERE io.intervention_id = i.id
      ), '[]'::jsonb) AS operators
    FROM public.interventions i
    LEFT JOIN public.roads r ON r.id = i.road_id
    LEFT JOIN public.operators op_resp ON op_resp.id = i.responsible_operator_id
    WHERE (p_status IS NULL OR p_status = 'all' OR i.status = p_status)
      AND (p_work_type_id IS NULL OR EXISTS (SELECT 1 FROM public.intervention_work_types iw WHERE iw.intervention_id = i.id AND iw.work_type_id = p_work_type_id))
      AND (p_machine_id IS NULL OR EXISTS (SELECT 1 FROM public.intervention_machines im WHERE im.intervention_id = i.id AND im.machine_id = p_machine_id))
      AND (p_operator_id IS NULL OR EXISTS (SELECT 1 FROM public.intervention_operators io WHERE io.intervention_id = i.id AND io.operator_id = p_operator_id))
      AND (p_date_from IS NULL OR i.created_at >= p_date_from)
      AND (p_date_to IS NULL OR i.created_at <= p_date_to)
    ORDER BY
      CASE i.status
        WHEN 'pending_approval' THEN 1
        WHEN 'in_progress' THEN 2
        WHEN 'suspended' THEN 3
        WHEN 'planned' THEN 4
        ELSE 5
      END,
      i.created_at DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    OFFSET GREATEST(p_offset, 0)
  ) q;

  RETURN jsonb_build_object(
    'total', v_total,
    'pending_approval_count', v_pending_cnt,
    'items', v_items
  );
END;
$$;

-- Detalle completo de una intervención para /admin (incluye geometrías, sesiones diarias, fotos y reclamo vinculado)
CREATE OR REPLACE FUNCTION public.admin_get_intervention_detail(p_intervention_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_int public.interventions;
  v_road_name text;
  v_resp_name text;
  v_claim jsonb := NULL;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.';
  END IF;

  SELECT * INTO v_int FROM public.interventions WHERE id = p_intervention_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Intervención no encontrada.';
  END IF;

  IF v_int.road_id IS NOT NULL THEN
    SELECT normalized_name INTO v_road_name FROM public.roads WHERE id = v_int.road_id;
  END IF;

  IF v_int.responsible_operator_id IS NOT NULL THEN
    SELECT full_name INTO v_resp_name FROM public.operators WHERE id = v_int.responsible_operator_id;
  END IF;

  IF v_int.linked_claim_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'id', c.id,
      'title', c.title,
      'status', c.status,
      'priority', c.priority,
      'category_name', cc.name
    ) INTO v_claim
    FROM public.claims c
    LEFT JOIN public.claim_categories cc ON cc.id = c.category_id
    WHERE c.id = v_int.linked_claim_id;
  END IF;

  RETURN jsonb_build_object(
    'id', v_int.id,
    'title', v_int.title,
    'description', v_int.description,
    'execution_mode', v_int.execution_mode,
    'origin', v_int.origin,
    'status', v_int.status,
    'priority', v_int.priority,
    'road_id', v_int.road_id,
    'road_name', COALESCE(v_road_name, v_int.road_name_snapshot),
    'definition_mode', v_int.definition_mode,
    'planned_geojson', CASE WHEN v_int.planned_geom IS NOT NULL THEN ST_AsGeoJSON(v_int.planned_geom)::jsonb ELSE NULL END,
    'planned_length_m', v_int.planned_length_m,
    'worked_geojson', CASE WHEN v_int.worked_geom IS NOT NULL THEN ST_AsGeoJSON(v_int.worked_geom)::jsonb ELSE NULL END,
    'worked_length_m', v_int.worked_length_m,
    'total_gps_distance_m', v_int.total_gps_distance_m,
    'duration_s', v_int.duration_s,
    'sessions_count', v_int.sessions_count,
    'scheduled_date', v_int.scheduled_date,
    'started_at', v_int.started_at,
    'completed_at', v_int.completed_at,
    'reviewed_at', v_int.reviewed_at,
    'review_note', v_int.review_note,
    'responsible_operator_id', v_int.responsible_operator_id,
    'responsible_operator_name', v_resp_name,
    'linked_claim', v_claim,
    'work_types', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', wt.id, 'name', wt.name, 'color', wt.color, 'execution_mode', wt.execution_mode))
      FROM public.intervention_work_types iw JOIN public.work_types wt ON wt.id = iw.work_type_id
      WHERE iw.intervention_id = v_int.id
    ), '[]'::jsonb),
    'machines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'code', m.code, 'machine_type', m.machine_type))
      FROM public.intervention_machines im JOIN public.machines m ON m.id = im.machine_id
      WHERE im.intervention_id = v_int.id
    ), '[]'::jsonb),
    'operators', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', o.id, 'full_name', o.full_name, 'is_responsible', io.is_responsible))
      FROM public.intervention_operators io JOIN public.operators o ON o.id = io.operator_id
      WHERE io.intervention_id = v_int.id
    ), '[]'::jsonb),
    'sessions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', s.id,
        'operator_name', o.full_name,
        'started_at', s.started_at,
        'ended_at', s.ended_at,
        'raw_distance_m', s.raw_distance_m,
        'duration_s', s.duration_s,
        'notes', s.notes,
        'raw_geojson', CASE WHEN s.raw_geom IS NOT NULL THEN ST_AsGeoJSON(s.raw_geom)::jsonb ELSE NULL END
      ) ORDER BY s.started_at ASC)
      FROM public.intervention_sessions s
      LEFT JOIN public.operators o ON o.id = s.operator_id
      WHERE s.intervention_id = v_int.id
    ), '[]'::jsonb),
    'photos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', ph.id,
        'storage_path', ph.storage_path,
        'thumb_path', ph.thumb_path,
        'created_at', ph.created_at
      ) ORDER BY ph.created_at ASC)
      FROM public.intervention_photos ph
      WHERE ph.intervention_id = v_int.id
    ), '[]'::jsonb),
    'history', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', h.id,
        'action', h.action,
        'old_status', h.old_status,
        'new_status', h.new_status,
        'message', h.message,
        'changed_by_name', p.full_name,
        'created_at', h.created_at
      ) ORDER BY h.created_at DESC)
      FROM public.intervention_history h
      LEFT JOIN public.profiles p ON p.id = h.changed_by
      WHERE h.intervention_id = v_int.id
    ), '[]'::jsonb)
  );
END;
$$;

-- Aprobar o rechazar intervención (y resolver reclamo vinculado si aplica)
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

  -- Si se aprueba y tiene un reclamo vecinal vinculado, marcar ese reclamo como Solucionado y notificar al vecino
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

  -- Notificar al operario responsable
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

-- Aprobación / Rechazo masivo en lote desde /admin
CREATE OR REPLACE FUNCTION public.admin_review_interventions_batch(
  p_ids uuid[],
  p_new_status text,
  p_note text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_cnt integer := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.';
  END IF;

  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  FOREACH v_id IN ARRAY p_ids LOOP
    PERFORM public.admin_review_intervention(v_id, p_new_status, p_note);
    v_cnt := v_cnt + 1;
  END LOOP;

  RETURN v_cnt;
END;
$$;

-- Capa general de mapa "Intervenciones" (Sin identidades de operarios)
CREATE OR REPLACE FUNCTION public.get_map_interventions_geojson(
  p_min_lon double precision DEFAULT -63.1,
  p_min_lat double precision DEFAULT -35.9,
  p_max_lon double precision DEFAULT -61.8,
  p_max_lat double precision DEFAULT -34.9,
  p_include_planned boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_env geometry;
  v_is_staff boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  v_is_staff := public.is_admin() OR public.is_operator();
  v_env := ST_MakeEnvelope(p_min_lon, p_min_lat, p_max_lon, p_max_lat, 4326);

  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(q))
    FROM (
      SELECT
        i.id,
        i.title,
        i.execution_mode,
        i.status,
        i.priority,
        COALESCE(r.normalized_name, i.road_name_snapshot) AS road_name,
        i.planned_length_m,
        i.worked_length_m,
        i.scheduled_date,
        i.completed_at,
        -- Preferimos worked_geom para aprobadas; si no tiene (o si es planificada), planned_geom
        ST_AsGeoJSON(COALESCE(i.worked_geom, i.planned_geom))::jsonb AS geojson,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('name', wt.name, 'color', wt.color))
          FROM public.intervention_work_types iw JOIN public.work_types wt ON wt.id = iw.work_type_id
          WHERE iw.intervention_id = i.id
        ), '[]'::jsonb) AS work_types,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('name', m.name, 'machine_type', m.machine_type))
          FROM public.intervention_machines im JOIN public.machines m ON m.id = im.machine_id
          WHERE im.intervention_id = i.id
        ), '[]'::jsonb) AS machines
      FROM public.interventions i
      LEFT JOIN public.roads r ON r.id = i.road_id
      WHERE COALESCE(i.worked_geom, i.planned_geom) IS NOT NULL
        AND ST_Intersects(COALESCE(i.worked_geom, i.planned_geom), v_env)
        AND (
          i.status = 'approved'
          OR (v_is_staff AND p_include_planned AND i.status IN ('planned', 'in_progress', 'suspended', 'pending_approval'))
        )
      ORDER BY i.updated_at DESC
      LIMIT 300
    ) q
  ), '[]'::jsonb);
END;
$$;

-- =============================================================================
-- 9. Fases 11 y 13: RPCs Operativos para App Móvil / PWA del Operario
-- =============================================================================

CREATE OR REPLACE FUNCTION public.operator_list_my_tasks()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id uuid;
  v_is_adm boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  v_op_id := public.get_my_operator_id();
  v_is_adm := public.is_admin();

  IF v_op_id IS NULL AND NOT v_is_adm THEN
    RAISE EXCEPTION 'Permiso denegado: tu cuenta no tiene rol de operario activo.';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(q))
    FROM (
      SELECT
        i.id,
        i.title,
        i.description,
        i.execution_mode,
        i.origin,
        i.status,
        i.priority,
        i.road_id,
        COALESCE(r.normalized_name, i.road_name_snapshot) AS road_name,
        i.planned_length_m,
        i.worked_length_m,
        i.total_gps_distance_m,
        i.duration_s,
        i.sessions_count,
        i.scheduled_date,
        i.linked_claim_id,
        i.review_note,
        i.created_at,
        i.updated_at,
        (i.responsible_operator_id = v_op_id) AS am_i_responsible,
        CASE WHEN i.planned_geom IS NOT NULL THEN ST_AsGeoJSON(i.planned_geom)::jsonb ELSE NULL END AS planned_geojson,
        CASE WHEN i.worked_geom IS NOT NULL THEN ST_AsGeoJSON(i.worked_geom)::jsonb ELSE NULL END AS worked_geojson,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('id', wt.id, 'name', wt.name, 'color', wt.color, 'execution_mode', wt.execution_mode))
          FROM public.intervention_work_types iw JOIN public.work_types wt ON wt.id = iw.work_type_id
          WHERE iw.intervention_id = i.id
        ), '[]'::jsonb) AS work_types,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'code', m.code, 'machine_type', m.machine_type))
          FROM public.intervention_machines im JOIN public.machines m ON m.id = im.machine_id
          WHERE im.intervention_id = i.id
        ), '[]'::jsonb) AS machines,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('id', o.id, 'full_name', o.full_name, 'is_responsible', io.is_responsible))
          FROM public.intervention_operators io JOIN public.operators o ON o.id = io.operator_id
          WHERE io.intervention_id = i.id
        ), '[]'::jsonb) AS operators
      FROM public.interventions i
      LEFT JOIN public.roads r ON r.id = i.road_id
      WHERE v_is_adm
        OR i.responsible_operator_id = v_op_id
        OR EXISTS (SELECT 1 FROM public.intervention_operators io WHERE io.intervention_id = i.id AND io.operator_id = v_op_id)
        -- Tareas abiertas sin operario específico también son visibles para poder tomarlas en campo
        OR (
          i.status = 'planned'
          AND i.responsible_operator_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.intervention_operators io WHERE io.intervention_id = i.id)
        )
      ORDER BY
        CASE i.status
          WHEN 'in_progress' THEN 1
          WHEN 'suspended' THEN 2
          WHEN 'planned' THEN 3
          WHEN 'rejected' THEN 4
          WHEN 'pending_approval' THEN 5
          ELSE 6
        END,
        i.scheduled_date ASC NULLS LAST,
        i.created_at DESC
    ) q
  ), '[]'::jsonb);
END;
$$;

-- Listar reclamos cercanos abiertos para vincular al finalizar un trabajo (sin identidad de vecinos)
CREATE OR REPLACE FUNCTION public.operator_list_nearby_claims(
  p_lat double precision,
  p_lon double precision,
  p_radius_m double precision DEFAULT 2000.0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pt_utm geometry;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF NOT (public.is_operator() OR public.is_admin()) THEN
    RAISE EXCEPTION 'Permiso denegado: solo personal municipal.';
  END IF;

  v_pt_utm := ST_Transform(ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326), 32720);

  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(q))
    FROM (
      SELECT
        c.id,
        c.title,
        c.status,
        c.priority,
        cc.name AS category_name,
        ROUND(ST_Distance(ST_Transform(c.location, 32720), v_pt_utm)::numeric, 0) AS distance_m,
        ST_Y(c.location) AS lat,
        ST_X(c.location) AS lon
      FROM public.claims c
      LEFT JOIN public.claim_categories cc ON cc.id = c.category_id
      WHERE c.status IN ('received', 'evaluating', 'in_progress')
        AND ST_DWithin(ST_Transform(c.location, 32720), v_pt_utm, LEAST(GREATEST(p_radius_m, 100.0), 15000.0))
      ORDER BY ST_Distance(ST_Transform(c.location, 32720), v_pt_utm) ASC
      LIMIT 15
    ) q
  ), '[]'::jsonb);
END;
$$;

-- Registrar jornada o finalización de intervención (idempotente por p_session_id)
-- Soporta tareas programadas, reanudación de suspendidas y creación de tareas espontáneas.
CREATE OR REPLACE FUNCTION public.operator_submit_session(
  p_session_id uuid,
  p_intervention_id uuid DEFAULT NULL,
  p_action text DEFAULT 'submit', -- 'suspend' ("Terminar por hoy") | 'submit' ("Finalizar trabajo")
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
  p_photo_paths jsonb DEFAULT '[]'::jsonb, -- Array de { storage_path, thumb_path }
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id uuid;
  v_is_adm boolean;
  v_int public.interventions;
  v_int_id uuid;
  v_old_status text := NULL;
  v_new_status text;
  v_raw_geom geometry := NULL;
  v_pt_count integer := 0;
  v_wid uuid;
  v_mid uuid;
  v_oid uuid;
  v_ph jsonb;
  v_admin record;
  v_resp_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  v_op_id := public.get_my_operator_id();
  v_is_adm := public.is_admin();

  IF v_op_id IS NULL AND NOT v_is_adm THEN
    RAISE EXCEPTION 'Permiso denegado: solo operarios activos o administradores pueden registrar trabajos.';
  END IF;

  IF p_action NOT IN ('suspend', 'submit') THEN
    RAISE EXCEPTION 'Acción inválida (debe ser suspend o submit).';
  END IF;

  IF p_execution_mode NOT IN ('linear', 'punctual') THEN
    RAISE EXCEPTION 'Modo de ejecución inválido.';
  END IF;

  -- Idempotencia de reintento offline: si esta sesión ya ingresó, devolver estado actual de la intervención
  IF EXISTS (SELECT 1 FROM public.intervention_sessions WHERE id = p_session_id) THEN
    SELECT i.* INTO v_int
    FROM public.interventions i
    JOIN public.intervention_sessions s ON s.intervention_id = i.id
    WHERE s.id = p_session_id;

    RETURN jsonb_build_object(
      'ok', true,
      'already_processed', true,
      'intervention_id', v_int.id,
      'status', v_int.status,
      'worked_length_m', v_int.worked_length_m
    );
  END IF;

  -- Construir geometría de la jornada
  IF p_execution_mode = 'linear' THEN
    v_pt_count := jsonb_array_length(COALESCE(p_raw_points, '[]'::jsonb));
    IF v_pt_count < 2 THEN
      RAISE EXCEPTION 'Un trabajo lineal requiere al menos 2 puntos GPS grabados.';
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
    IF p_punctual_lat IS NULL OR p_punctual_lon IS NULL THEN
      RAISE EXCEPTION 'Una tarea puntual requiere coordenadas GPS válidas.';
    END IF;
    v_raw_geom := ST_SetSRID(ST_MakePoint(p_punctual_lon, p_punctual_lat), 4326);
  END IF;

  v_new_status := CASE WHEN p_action = 'suspend' THEN 'suspended' ELSE 'pending_approval' END;

  -- Determinar si se asocia a tarea existente (planned / suspended) o es espontánea nueva
  IF p_intervention_id IS NOT NULL THEN
    SELECT * INTO v_int FROM public.interventions WHERE id = p_intervention_id;
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
      auth.uid()
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING * INTO v_int;

    IF v_int.id IS NULL THEN
      SELECT * INTO v_int FROM public.interventions WHERE id = v_int_id;
    END IF;
    v_old_status := NULL;
  ELSE
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
    auth.uid(),
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
      IF NULLIF(v_ph->>'storage_path', '') IS NOT NULL THEN
        INSERT INTO public.intervention_photos (
          intervention_id, session_id, storage_path, thumb_path, uploaded_by
        ) VALUES (
          v_int_id,
          p_session_id,
          v_ph->>'storage_path',
          NULLIF(v_ph->>'thumb_path', ''),
          auth.uid()
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
    auth.uid(),
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
    FOR v_admin IN SELECT user_id FROM public.admins WHERE user_id <> auth.uid() LOOP
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

-- =============================================================================
-- 10. Fase 14: Estadísticas de Intervenciones (Sin rankings nominales de personas)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_intervention_statistics(
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kpis jsonb;
  v_by_work_type jsonb;
  v_by_machine jsonb;
  v_monthly jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores pueden consultar estadísticas de intervenciones.';
  END IF;

  SELECT jsonb_build_object(
    'total_interventions', COUNT(*)::int,
    'approved_interventions', COUNT(*) FILTER (WHERE status = 'approved')::int,
    'pending_approval_interventions', COUNT(*) FILTER (WHERE status = 'pending_approval')::int,
    'suspended_interventions', COUNT(*) FILTER (WHERE status IN ('suspended', 'in_progress'))::int,
    'planned_interventions', COUNT(*) FILTER (WHERE status = 'planned')::int,
    'total_worked_km', COALESCE(ROUND((SUM(worked_length_m) FILTER (WHERE status = 'approved') / 1000.0)::numeric, 2), 0),
    'total_gps_km', COALESCE(ROUND((SUM(total_gps_distance_m) FILTER (WHERE status = 'approved') / 1000.0)::numeric, 2), 0),
    'claims_resolved_by_interventions', COUNT(*) FILTER (WHERE status = 'approved' AND linked_claim_id IS NOT NULL)::int
  )
  INTO v_kpis
  FROM public.interventions i
  WHERE (p_date_from IS NULL OR COALESCE(i.completed_at, i.created_at) >= p_date_from)
    AND (p_date_to IS NULL OR COALESCE(i.completed_at, i.created_at) <= p_date_to);

  -- Distribución por Tipo de Obra (metros/km trabajados aprobados y cantidad de obras)
  SELECT COALESCE(jsonb_agg(row_to_json(q)), '[]'::jsonb)
  INTO v_by_work_type
  FROM (
    SELECT
      wt.id,
      wt.name,
      wt.execution_mode,
      wt.color,
      COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'approved')::int AS approved_count,
      COALESCE(ROUND((SUM(i.worked_length_m) FILTER (WHERE i.status = 'approved') / 1000.0)::numeric, 2), 0) AS worked_km
    FROM public.work_types wt
    LEFT JOIN public.intervention_work_types iw ON iw.work_type_id = wt.id
    LEFT JOIN public.interventions i ON i.id = iw.intervention_id
      AND (p_date_from IS NULL OR COALESCE(i.completed_at, i.created_at) >= p_date_from)
      AND (p_date_to IS NULL OR COALESCE(i.completed_at, i.created_at) <= p_date_to)
    GROUP BY wt.id, wt.name, wt.execution_mode, wt.color
    ORDER BY worked_km DESC, approved_count DESC, wt.name ASC
  ) q;

  -- Uso por Maquinaria Municipal (sin rankings de personas/operarios — Decisión #13)
  SELECT COALESCE(jsonb_agg(row_to_json(q)), '[]'::jsonb)
  INTO v_by_machine
  FROM (
    SELECT
      m.id,
      m.name,
      m.code,
      m.machine_type,
      COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'approved')::int AS interventions_count,
      COALESCE(ROUND((SUM(i.worked_length_m) FILTER (WHERE i.status = 'approved') / 1000.0)::numeric, 2), 0) AS worked_km
    FROM public.machines m
    LEFT JOIN public.intervention_machines im ON im.machine_id = m.id
    LEFT JOIN public.interventions i ON i.id = im.intervention_id
      AND (p_date_from IS NULL OR COALESCE(i.completed_at, i.created_at) >= p_date_from)
      AND (p_date_to IS NULL OR COALESCE(i.completed_at, i.created_at) <= p_date_to)
    GROUP BY m.id, m.name, m.code, m.machine_type
    ORDER BY worked_km DESC, interventions_count DESC, m.name ASC
  ) q;

  -- Evolución mensual de obras aprobadas y km netos trabajados
  SELECT COALESCE(jsonb_agg(row_to_json(q)), '[]'::jsonb)
  INTO v_monthly
  FROM (
    SELECT
      to_char(date_trunc('month', COALESCE(i.completed_at, i.created_at)), 'YYYY-MM') AS month,
      COUNT(*)::int AS interventions_count,
      COALESCE(ROUND((SUM(i.worked_length_m) / 1000.0)::numeric, 2), 0) AS worked_km,
      ROUND(AVG((SELECT COUNT(*) FROM public.intervention_operators io WHERE io.intervention_id = i.id))::numeric, 1) AS avg_crew_size
    FROM public.interventions i
    WHERE i.status = 'approved'
      AND (p_date_from IS NULL OR COALESCE(i.completed_at, i.created_at) >= p_date_from)
      AND (p_date_to IS NULL OR COALESCE(i.completed_at, i.created_at) <= p_date_to)
    GROUP BY 1
    ORDER BY 1 ASC
  ) q;

  RETURN jsonb_build_object(
    'kpis', v_kpis,
    'by_work_type', v_by_work_type,
    'by_machine', v_by_machine,
    'monthly_trend', v_monthly
  );
END;
$$;

-- Función auxiliar para resumen semanal unificado en Brevo (incluye recorridos, reclamos y trabajos viales)
CREATE OR REPLACE FUNCTION public.get_weekly_digest_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado.';
  END IF;

  RETURN jsonb_build_object(
    'pending_trips', (SELECT COUNT(*)::int FROM public.trips WHERE status = 'pending'),
    'open_claims', (SELECT COUNT(*)::int FROM public.claims WHERE status IN ('received', 'evaluating', 'in_progress')),
    'pending_interventions', (SELECT COUNT(*)::int FROM public.interventions WHERE status = 'pending_approval'),
    'suspended_interventions', (SELECT COUNT(*)::int FROM public.interventions WHERE status IN ('suspended', 'in_progress')),
    'approved_interventions_7d', (SELECT COUNT(*)::int FROM public.interventions WHERE status = 'approved' AND reviewed_at >= now() - interval '7 days')
  );
END;
$$;
