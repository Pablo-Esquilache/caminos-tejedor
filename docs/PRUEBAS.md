# Guía de Pruebas Automatizadas, Rendimiento y Despliegue — Caminos Rurales de Carlos Tejedor

## 1. Suites de Pruebas Automatizadas en Base de Datos (`npm run db:test`)

El comando `npm run db:test` ejecuta contra Supabase PostgreSQL (dentro de transacciones seguras con `ROLLBACK` automático para no ensuciar datos reales) las **5 suites de verificación**:

1. **`supabase/tests/rls_permissions_test.sql` (Fase 1)**:
   - Verifica aislamiento entre Vecino A y Vecino B (`trips`, `trip_tracks`, `claims`, `notifications`).
   - Verifica bloqueo de usuarios anónimos (`anon`).
   - Verifica que un vecino común no pueda auto-aprobar un recorrido ni modificar trazas en `trip_tracks`.
   - Verifica auto-aprobación automática cuando graba un Administrador (`public.admins`).
2. **`supabase/tests/consolidation_test.sql` (Fase 4)**:
   - Caso 1: Primer recorrido aprobado crea camino y segmento inicial en `EPSG:32720`.
   - Caso 2: Segundo recorrido superpuesto incrementa `approved_trips_count` sin duplicar geometrías.
   - Caso 3: Idempotencia (`consolidate_trip` ejecutado dos veces sobre el mismo `trip_id` no infla contadores).
   - Caso 4: Camino paralelo a > 70 metros se conserva como camino independiente.
   - Caso 5: Recorrido parcialmente compartido y parcialmente nuevo divide/extiende solo el tramo nuevo (`ST_Difference`).
   - Caso 6: Des-consolidación (`unconsolidate_trip`) revierte contadores al revocar un recorrido.
   - Caso 7: Verificación de privacidad en `get_consolidated_roads_map` (cero datos personales expuestos).
3. **`supabase/tests/claims_notifications_test.sql` (Fase 5)**:
   - Alta idempotente de reclamo georreferenciado con foto y miniatura (`submit_claim_with_photo`).
   - Cambio de estado, prioridad y respuesta oficial (`update_claim`) con generación de `claim_history`, `audit_log` y notificación In-App al vecino.
   - Desactivación de categoría (`upsert_claim_category`) preservando intactos los reclamos históricos.
   - Regla de resumen semanal (`generate_weekly_pending_summary`: si hay 0 recorridos pendientes, no envía correo/ruido).
4. **`supabase/tests/stats_checks.sql` (Fase 6)**:
   - Verifica consistencia matemática exacta entre totales de reclamos y los desgloses por estado, prioridad y categoría.
   - Verifica la asociación espacial PostGIS (`ST_DWithin` en `EPSG:32720`) entre reclamos y caminos consolidados cercanos.
5. **`supabase/tests/performance_explain_test.sql` (Fase 7)**:
   - Verifica la presencia de los 4 índices espaciales `GIST` y mide con `EXPLAIN (ANALYZE, FORMAT JSON)` que las consultas espaciales por ventana visible (`Bounding Box`) respondan en pocos milisegundos.

---

## 2. Cómo Desplegar en Netlify (App Móvil y Panel Admin)

El repositorio cuenta con `netlify.toml` y archivos `_redirects` listos para subir a Netlify conectando tu repositorio de GitHub (`https://github.com/Pablo-Esquilache/caminos-tejedor.git`).

### A. Desplegar la App Móvil / Vecinos (`apps/mobile`) — Para probar GPS en el celular
1. Entrá a [app.netlify.com](https://app.netlify.com/) -> **Add new site** -> **Import an existing project** -> **GitHub**.
2. Elegí el repositorio `Pablo-Esquilache/caminos-tejedor`.
3. Netlify detectará automáticamente la configuración de `netlify.toml`:
   - **Base directory**: `apps/mobile`
   - **Build command**: `npm install && npm run build`
   - **Publish directory**: `apps/mobile/dist`
4. En **Environment variables**, agregá estas 3 variables (con los mismos valores de tu `.env`):
   - `VITE_SUPABASE_URL` = `https://kxtquopeuxrrxvgrbfsy.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = `sb_publishable_OLGoKYZstJTaJXocxjhuRA_6kULS_fg`
   - `VITE_MAPTILER_API_KEY` = `vXCRGvZe0t2COY8hcviE`
5. Hacé clic en **Deploy site**.

### B. Desplegar el Panel Municipal de Administración (`apps/admin`)
1. En Netlify, hacé clic otra vez en **Add new site** -> **Import an existing project** -> elegí el mismo repositorio `Pablo-Esquilache/caminos-tejedor`.
2. Configurá los directorios para apuntar a `apps/admin`:
   - **Base directory**: `apps/admin`
   - **Build command**: `npm install && npm run build`
   - **Publish directory**: `apps/admin/dist`
3. Agregá las mismas 3 variables de entorno (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_MAPTILER_API_KEY`).
4. **Paso final para Login con Google en Netlify**:
   - Cuando Netlify te dé la URL pública de tu app (ej. `https://caminos-tejedor.netlify.app`), entrá a tu proyecto de **Supabase** -> **Authentication** -> **URL Configuration** y agregá esa URL en **Redirect URLs** (y como **Site URL**).
