# Plan de Acción y Estado de Implementación — Caminos Rurales de Carlos Tejedor

> **Estado actual del proyecto (Noviembre 2026):** Las **Fases 1 a 7 están 100% completadas, probadas y desplegadas en producción** (Supabase + PostGIS, GitHub y Netlify). Este documento registra tanto la arquitectura definitiva implementada como las modificaciones realizadas durante el desarrollo y la **Fase 8 (hoja de ruta para empaquetado como App Nativa en Google Play Store y Apple App Store con Capacitor)**.

---

## 1. Arquitectura Definitiva Implementada y Decisiones de Diseño

### A. Esquema de Aplicaciones y Despliegue Unificado (`/` y `/admin`)
* **Despliegue actual unificado en Netlify (`scripts/build-netlify.mjs` + `netlify.toml`):**
  Un único sitio de Netlify compila y publica ambas aplicaciones desde el monorepo:
  1. **App Móvil del Vecino (`/` — `apps/mobile`):**
     * Construida en **React + Vite + TypeScript + MapLibre GL + PWA (`manifest.webmanifest` + `sw.js` + `IndexedDB`)**.
     * **100% exclusiva y limpia para el vecino común:** pantalla de ingreso únicamente con **"Continuar con Google"** (sin formularios de acceso administrativo ni opciones de simulación de prueba).
     * Incluye grabación GPS real con soporte de pausa/reanudación, `WakeLock` para mantener activo el GPS en iOS/Android, persistencia inmediata punto por punto en `IndexedDB`, cola de sincronización offline (*Outbox*) para recorridos y reclamos sin señal, mapa de la red consolidada y bandeja de notificaciones.
  2. **Panel Web Municipal de Administración (`/admin` — `apps/admin`):**
     * Construido en **React + Vite + TypeScript + MapLibre GL**, servido bajo la ruta `/admin` del mismo dominio.
     * Protegido por verificación `is_admin()` en base de datos y políticas RLS.
     * Además de todas las funciones de gestión municipal (Portada de KPIs, Mapa General a pantalla completa, Bandeja de Validación de Recorridos en lote/individual, Consolidación y Clasificación de Caminos, Gestión de Reclamos y Categorías, Padrón de Usuarios y Estadísticas), **integra herramientas propias de relevamiento para el Administrador dentro de `/admin`**:
       * **Botón "Grabar / Simular Recorrido" (en Portada y Mapa de `/admin`):** abre el grabador del Administrador permitiendo elegir entre el **Simulador de Campo** (con trazas viales reales de Carlos Tejedor obtenidas con OSRM) o el **GPS real del dispositivo** (si el administrador abre `/admin` desde su celular en el campo). Al finalizar, el recorrido del administrador **se aprueba y consolida automáticamente** en la red vial.
       * **Botón "+ Generar reclamo" (en la sección Reclamos de `/admin`):** permite al administrador dar de alta reclamos georreferenciados con foto comprimida directamente desde el panel administrativo.

### B. Correo Electrónico Transaccional en Tiempo Real (Brevo + Supabase `pg_net`)
* **Sin servidores intermedios ni exposición de claves en el frontend:**
  * La clave privada de **Brevo (`BREVO_API_KEY`)** y el remitente verificado (`caminostejedor@gmail.com` — *Caminos Rurales Carlos Tejedor*) están almacenados dentro de la tabla privada del servidor `public.private_secrets` en Supabase (con RLS activo y permisos revocados para `anon` y `authenticated`).
  * Mediante la extensión **`pg_net`** de PostgreSQL (migración `20261106000010_brevo_email_trigger.sql`), el trigger `trg_dispatch_notification_email_brevo` en `public.notifications` envía automáticamente el correo electrónico a través de `https://api.brevo.com/v3/smtp/email` en el mismo instante en que se crea un reclamo, cambia su estado o se emite el resumen semanal.
  * No se requiere configurar variables de Brevo en Netlify.

### C. Motor Geoespacial PostGIS (`EPSG:4326` y `EPSG:32720`)
* Todas las geometrías se almacenan en **`EPSG:4326` (WGS84)** y todos los cálculos métricos (longitudes en metros, buffers de proximidad, cruces e intersecciones espaciales `ST_DWithin`) se ejecutan proyectando a **`EPSG:32720` (UTM Zona 20S — centro de la Provincia de Buenos Aires / Carlos Tejedor)**.

---

## 2. Resumen de las 7 Fases Completadas

1. **Fase 1 (Base, Esquema PostGIS, Roles y RLS):** 16 tablas, índices espaciales `GIST`, bucket privado `claim-photos` y políticas RLS estrictas (`20261106000001` a `004`).
2. **Fase 2 (App Móvil del Vecino, Grabación GPS y Cola Offline):** Grabación punto a punto en `IndexedDB`, filtro de precisión GPS, recuperación ante cierres y cola offline (`20261106000005`).
3. **Fase 3 (Panel Web del Administrador y Bandeja de Validación):** KPIs, mapa con filtro `bbox`, aprobación/rechazo individual y masivo con auditoría (`20261106000006`).
4. **Fase 4 (Consolidación PostGIS y Clasificación Jerárquica):** `consolidate_trip`, `unconsolidate_trip`, `reclassify_all_roads`, `rename_road`, `merge_roads`, `reprocess_all_roads` y niveles `Troncal`, `Principal`, `Secundario` y `Vecinal` (`20261106000007`).
5. **Fase 5 (Reclamos Georreferenciados, Fotos Comprimidas y Correos Brevo):** Compresión en cliente (`1600px` + miniatura `320px`), URLs firmadas temporales, clustering en mapa, alta de reclamos desde `/admin` y despacho automático de correos vía Brevo con `pg_net` (`20261106000008` y `010`).
6. **Fase 6 (Estadísticas e Indicadores Municipales):** Ranking de uso, distribución por jerarquía, evolución mensual y cruce espacial reclamos-caminos con `ST_DWithin` (`20261106000009`).
7. **Fase 7 (Offline PWA, Auditoría `EXPLAIN ANALYZE` y Pruebas):** Service Worker, documentación de seguridad/pruebas y 5 suites de tests SQL aprobadas.

---

## 3. Fase 8 (Próxima Etapa): Conversión a Aplicación Nativa (Android & iOS) con Capacitor

1. **El Panel del Administrador (`/admin`) sigue alojado gratis en Netlify.**
2. **La App del Vecino (`apps/mobile`) se empaqueta con Capacitor (`com.caminostejedor.app`):**
   * **Paso 1:** Instalar `@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, `@capacitor/ios` en `apps/mobile` con `appId: 'com.caminostejedor.app'`.
   * **Paso 2:** Configurar el esquema de redirección OAuth `com.caminostejedor.app://auth-callback` en Supabase Auth, `AndroidManifest.xml` e `Info.plist`.
   * **Paso 3:** Declarar permisos de ubicación y cámara en `AndroidManifest.xml` e `Info.plist`.
   * **Paso 4:** Compilar y publicar en **Google Play Console (USD 25 pago único)** y **Apple Developer Program / App Store (USD 99 anuales)**.
