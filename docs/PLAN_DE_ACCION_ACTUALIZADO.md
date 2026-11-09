# Plan de Acción y Estado de Implementación — Caminos Rurales de Carlos Tejedor

> [!IMPORTANT]
> **Estado del proyecto (Noviembre 2026):** Las **Fases 1 a 7 están 100% completadas, probadas y desplegadas en producción** (Supabase + PostGIS, GitHub y Netlify). Este documento resume la arquitectura definitiva, las 13 migraciones aplicadas, las mejoras recientes y la **hoja de ruta para la Fase 8 (Capacitor / App Nativa Android e iOS con GPS en segundo plano y pantalla bloqueada)**.

---

## 1. Arquitectura Definitiva y Estado del Sistema

### A. Despliegue Unificado (`/` y `/admin`) en Netlify
* **App Móvil del Vecino (`/` — `apps/mobile`):**
  * React 18 + Vite + TypeScript + MapLibre GL + Mapbox Satellite Streets HD (`@2x`).
  * Autenticación con Google (sin formularios administrativos a la vista).
  * Grabación GPS con persistencia inmediata en IndexedDB, pausa/reanudación, y cola offline (*Outbox*) para subir recorridos y reclamos automáticamente al recuperar señal.
  * Formulario de reclamos georreferenciados con compresión automática de fotos (JPEG < 350 KB) y mapa interactivo.
* **Panel Web de Administración Municipal (`/admin` — `apps/admin`):**
  * Protegido por verificación `is_admin()` en base de datos PostgreSQL y políticas RLS.
  * Menú lateral fijo (*sticky*) con **badge de notificación en tiempo real** de reclamos nuevos (`status === 'received'`).
  * **Bandeja de Reclamos:** tabla a **pantalla completa (100% de ancho)** con botón **"Gestionar"**, panel lateral de detalle con botón de cierre **✕**, y auto-cierre al guardar cambios y notificar al vecino.
  * **Alta rápida de reclamos del Admin:** modal con selector de prioridad inicial (*Alta, Media, Baja*).
  * **Grabador / Simulador de Campo del Administrador:** permite grabar GPS real o simular recorridos con trazas viales reales de Carlos Tejedor (OSRM) asignando jerarquía inicial (*Troncal, Principal, Secundario, Vecinal*) que se aprueba y consolida de forma inmediata.
  * **Clasificación híbrida de caminos:** selector entre modo estandarizado (umbrales manuales) o automático (percentiles dinámicos P90, P70, P40), más edición manual de nombre y jerarquía por camino.

### B. Cartografía y Mapas Satelitales (Mapbox HD)
* Integrado mediante [`mapStyle.ts`](file:///c:/Users/pablo/Downloads/Camino%20Rurales%20Carlos%20Tejedor/apps/mobile/src/lib/mapStyle.ts) en móvil y admin.
* Token público configurado: `pk.eyJ1IjoiY2FtaW5vc3J1cmFsZXMi... (configurado en .env y Netlify)`.
* **Capa Satelital Híbrida:** `satellite-streets-v12` renderizado a doble resolución (`@2x` retina), combinando fotografía satelital de alta definición con nombres oficiales de caminos rurales y parajes superpuestos.
* **Capa Vial:** `streets-v12` (`@2x`).
* **Fallback a prueba de fallos:** si no hay token o señal, conmuta automáticamente a ArcGIS World Imagery / OpenStreetMap libre.

### C. Backend Supabase + PostGIS (13 Migraciones Aplicadas)
1. `001_initial_schema.sql`: 16 tablas con geometrías PostGIS (`EPSG:4326` proyectadas a `EPSG:32720` UTM 20S).
2. `002_functions_and_triggers.sql`: triggers de auditoría, cálculo métrico y validación.
3. `003_rls_and_storage.sql`: políticas RLS estrictas y bucket privado `claim-photos`.
4. `004_seed_initial_data.sql`: categorías iniciales y configuración del sistema.
5. `005_mobile_trip_rpc.sql`: RPCs de recorridos móviles (`submit_trip_with_track`).
6. `006_admin_panel_rpcs.sql`: KPIs de portada, filtros por BBox y pads de usuarios.
7. `007_road_consolidation.sql`: motor geoespacial de consolidación vial y snapping de trazas.
8. `008_claims_and_notifications.sql`: gestión completa de reclamos y avisos in-app.
9. `009_statistics_and_kpis.sql`: estadísticas avanzadas y rankings viales.
10. `010_brevo_email_trigger.sql`: despacho de emails en tiempo real vía `pg_net` y Brevo.
11. `011_fix_safeupdate_where_clauses.sql`: corrección de cláusulas WHERE para compatibilidad con `safeupdate`.
12. `012_manual_and_dynamic_road_classification.sql`: jerarquía híbrida manual/automática y registro inicial de jerarquía.
13. `013_drop_overloaded_submit_trip_function.sql`: unificación y eliminación de sobrecarga duplicada de `submit_trip_with_track` para evitar ambigüedad de RPC.

### D. Costos Fijos por Municipio
* **Supabase Pro:** \$25 USD/mes (8 GB DB, 100 GB fotos, backups automáticos, sin pausa por inactividad).
* **Netlify Pro / Starter:** \$0 a \$9 USD/mes.
* **Brevo Starter / Free:** \$0 a \$9 USD/mes (hasta 300 mails/día gratis).
* **Mapbox:** \$0/mes (hasta 50.000 cargas mensuales incluidas; luego \$5 cada 1.000 cargas).
* **Total base:** **~\$25 a \$43 USD / mes por municipio**.

---

## 2. Lo que Falta: Fase 8 (Capacitor / App Nativa)

### ¿Por qué se requiere la Fase 8?
En navegadores móviles (Chrome en Android, Safari en iOS), el sistema operativo suspende o congela la ejecución de JavaScript en segundo plano tan pronto el usuario presiona el botón físico de bloqueo de pantalla para ahorrar batería. Para que un productor o transportista pueda guardar su celular en el bolsillo con la pantalla bloqueada mientras maneja 30 km por un camino rural, la app debe ejecutarse como una **aplicación nativa instalable (APK)** con un **Servicio en Primer Plano (*Foreground Service*)**.

### Hoja de Ruta Técnica para la Fase 8:
1. **Instalación de Capacitor en `apps/mobile`:**
   ```bash
   npm --prefix apps/mobile install @capacitor/core @capacitor/cli @capacitor/android @capacitor-community/background-geolocation
   npx cap init "Caminos Rurales" com.caminosrurales.tejedor --web-dir dist
   npx cap add android
   ```
2. **Configuración de Permisos en `AndroidManifest.xml`:**
   * `ACCESS_FINE_LOCATION`
   * `ACCESS_COARSE_LOCATION`
   * `ACCESS_BACKGROUND_LOCATION`
   * `FOREGROUND_SERVICE` y `FOREGROUND_SERVICE_LOCATION`
   * Notificación persistente en la barra de estado (*"Grabando camino rural..."*).
3. **Adaptación en `apps/mobile/src/lib/geo.ts`:**
   * Detección de entorno: si corre bajo Capacitor (`Capacitor.isNativePlatform()`), invocar el plugin de geolocalización en segundo plano con notificación de foreground service; si corre en navegador web/PWA, usar la API estándar `navigator.geolocation` con `WakeLock`.
4. **Compilación del APK de producción:**
   * `npx cap sync`
   * Generación del APK firmado en Android Studio listo para distribución directa o Google Play Store.

---

## 3. Verificaciones Realizadas
* ✅ Pruebas de base de datos (`npm run db:test`): las 5 suites SQL pasan 100% en verde.
* ✅ Compilación frontend (`npm run build`): compila limpiamente `apps/mobile` y `apps/admin` sin errores de TypeScript.
* ✅ Git: repositorio en rama `main` limpio y sincronizado con `origin/main`.
