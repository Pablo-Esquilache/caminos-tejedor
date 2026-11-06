-- =============================================================================
-- Migración 004 / Seed inicial: Categorías de Reclamos y Parámetros (settings)
-- =============================================================================

-- 1. Categorías iniciales de reclamos
INSERT INTO public.claim_categories (name, icon, is_active, sort_order)
VALUES
  ('Pozos', 'alert-circle', true, 1),
  ('Camino en mal estado', 'road', true, 2),
  ('Alcantarillas rotas', 'water-outline', true, 3),
  ('Inundado / camino cortado', 'warning', true, 4),
  ('Otros', 'help-circle', true, 5)
ON CONFLICT (name) DO UPDATE
  SET icon = EXCLUDED.icon,
      sort_order = EXCLUDED.sort_order;

-- 2. Parámetros iniciales en settings (Consolidación PostGIS, GPS y Clasificación)
INSERT INTO public.settings (key, value, description)
VALUES
  (
    'consolidation_params',
    '{
      "buffer_tolerance_m": 25,
      "min_shared_length_m": 80,
      "max_angle_diff_deg": 30,
      "max_gps_accuracy_m": 35,
      "stop_cluster_radius_m": 12,
      "stop_min_duration_s": 60
    }'::jsonb,
    'Parámetros espaciales de PostGIS para limpieza de trazas y consolidación de caminos en EPSG:32720'
  ),
  (
    'road_classification_thresholds',
    '{
      "troncal_min_trips": 25,
      "principal_min_trips": 10,
      "secundario_min_trips": 3
    }'::jsonb,
    'Umbrales de cantidad de recorridos aprobados para clasificar caminos en troncal, principal, secundario y vecinal'
  ),
  (
    'stats_params',
    '{
      "claim_to_road_max_distance_m": 100,
      "active_user_days_window": 90
    }'::jsonb,
    'Parámetros para indicadores: distancia máxima para asociar un reclamo a un camino y ventana de usuario activo'
  )
ON CONFLICT (key) DO NOTHING;
