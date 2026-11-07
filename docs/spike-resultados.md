# Reporte de Resultados — Algoritmo de Consolidación PostGIS (Fase 0 / Fase 4)

Este documento registra el diseño, parámetros y resultados de evaluación del motor espacial de consolidación de caminos (`public.consolidate_trip` y `public.unconsolidate_trip`) ejecutado en PostgreSQL + PostGIS sobre proyección métrica **EPSG:32720 (UTM Zona 20 Sur - Carlos Tejedor)**.

---

## 1. Parámetros Configurables (`public.settings` -> `consolidation_params`)

| Parámetro | Valor Elegido | Descripción |
| :--- | :--- | :--- |
| `buffer_tolerance_m` | `25 m` | Radio máximo lateral para considerar que un recorrido circula por el mismo camino rural (cubre el ancho de callejón pampeano de 20-30m más deriva GPS). |
| `min_shared_length_m` | `80 m` | Largo mínimo compartido para considerar coincidencia o crear un tramo derivado nuevo (evita falsos positivos al cruzar otro camino en una esquina). |
| `max_angle_diff_deg` | `30°` | Diferencia angular máxima entre las tangentes locales muestreadas (tanto en el mismo sentido `0°` como en sentido opuesto `180°`). |
| `max_gps_accuracy_m` | `35 m` | Umbral de precisión satelital: puntos con error mayor se descartan en la captura. |
| `stop_cluster_radius_m` | `12 m` | Radio de colapso de paradas largas (`ST_RemoveRepeatedPoints`) para evitar bucles cuando el vehículo se detiene en una tranquera o cruce. |

---

## 2. Tabla de Casos Evaluados (`supabase/tests/consolidation_test.sql`)

| Caso / Escenario | Descripción de la Traza | Resultado Esperado | Resultado Obtenido | Estado |
| :--- | :--- | :--- | :--- | :--- |
| **1. Camino nuevo con curva** | Traza de 1,2 km en Carlos Tejedor con curva suave | Crea 1 camino en `roads` (`approved_trips_count = 1`) y 1 tramo en `road_segments` | Creó 1 camino y 1 segmento con longitud exacta en metros | ✅ Aprobado |
| **2. Camino existente / repetido** | Mismo camino recorrido en sentido inverso con desviación lateral de ~7 m y distinto nombre | No duplica trazado; suma utilización (`approved_trips_count = 2`, `unique_users_count = 2`) y conserva ambos alias en `road_name_aliases` | Sin duplicar segmento; contadores en `2` y `2` alias registrados | ✅ Aprobado |
| **3. Idempotencia** | Ejecución repetida de `consolidate_trip` sobre el mismo `trip_id` | No duplica filas en `trip_segment_usage` ni incrementa el contador | `already_consolidated`, contador se mantiene en `2` | ✅ Aprobado |
| **4. Caminos paralelos cercanos** | Camino paralelo a ~55 metros de distancia | No se fusiona con el camino vecino; crea un segundo camino independiente | Se crearon `2` caminos separados sin fusión | ✅ Aprobado |
| **5. Recorrido mixto con cruce a 90°** | Comparte los primeros 500 m con el Camino 1 y dobla 90° al Sur por 1 km nuevo | Suma 1 uso al Camino 1 (`approved_trips_count = 3`) y agrega únicamente el tramo nuevo al Sur | Camino 1 subió a `3` usos y se creó solo el segmento nuevo | ✅ Aprobado |
| **6. Parada larga en tranquera** | Puntos consecutivos estacionados dentro de `< 12 m` | Colapsa los puntos repetidos sin generar auto-intersecciones ni bucles | Geometría limpia y continua | ✅ Aprobado |
| **7. Revocación y Reprocesamiento** | Ejecución de `unconsolidate_trip` y `reprocess_all_roads` | Quita usos/segmentos exclusivos al revocar y reconstruye la misma red desde `trip_tracks` | Red restaurada e idéntica tras reprocesar | ✅ Aprobado |
