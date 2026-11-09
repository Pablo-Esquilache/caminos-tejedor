# Plan de Acción y Estado de Implementación — Caminos Rurales de Carlos Tejedor

> **Estado actual del proyecto (Noviembre 2026):** Las **Fases 1 a 7 están 100% completadas, probadas y desplegadas en producción** (Supabase + PostGIS, GitHub y Netlify). Este documento registra la arquitectura vigente, las Fases 1 a 7 cerradas, y la **Ampliación de Intervenciones Viales y Rol Operario (Fases 9 a 14) combinada con la Fase 8 (Capacitor / App Nativa para Android e iOS)**.

---

## 1. Arquitectura Definitiva y Acceso a la Plataforma

### A. App Móvil Unificada (Nativa para Android e iOS con Capacitor)
Una única aplicación instalable en teléfonos móviles que atiende a todos los usuarios con detección inteligente de roles:

* **Pantalla de Inicio de Sesión:**
  * **Botón principal central:** *"Continuar con Google"* (la opción estándar e intuitiva para los vecinos rurales).
  * **Enlace discreto inferior:** *`"¿Sos personal municipal? Ingresar con usuario y clave"`*. Al tocarlo, despliega los campos de correo y contraseña para que el **Administrador** (`caminostejedor@gmail.com`) y los **Operarios de Maquinaria** inicien sesión con sus credenciales municipales en Supabase Auth, sin confundir al vecino común.
* **Comportamiento según el rol tras el login:**
  * **Rol Vecino (`user`):** Interfaz estándar de grabación de caminos, reclamos viales con fotos y mapa satelital.
  * **Rol Operario (`operator`):** Interfaz operativa de **Lista de Tareas**, con órdenes de trabajo asignadas por el Admin, ejecución con GPS en tramos o tareas puntuales (alcantarillas) y registro de tareas espontáneas.
  * **Rol Administrador (`admin`):** Permite grabar con GPS en el campo con pantalla apagada; al guardar, el recorrido se **auto-aprueba y consolida inmediatamente en la red vial oficial**.
* **Capacitor y Grabación en Segundo Plano:**
  * Empaquetado nativo con `@capacitor-community/background-geolocation` y *Foreground Service* (Android) / *Background Location* (iOS) con notificación persistente para garantizar la grabación continua de GPS con la pantalla del celular apagada y bloqueada en el bolsillo.

### B. Panel Web Municipal de Administración (`/admin` en Netlify)
* Centro de control para el intendente y secretarios de obras públicas.
* **En PC de escritorio:** Pantalla completa al 100%, mapa satelital Mapbox HD `@2x`, planificación de intervenciones, gestión de reclamos, catálogos y estadísticas.
* **En el celular del Administrador (Web Mobile Responsive):** Si el intendente entra desde el navegador de su teléfono a `.../admin`, la interfaz se adapta automáticamente a la pantalla pequeña, permitiendo aprobar reclamos y consultar tareas desde cualquier lugar.

---

## 2. Resumen de Fases 1 a 7 (Completadas en Producción)

1. **Fase 1 (Base, Esquema PostGIS, Roles y RLS):** 16 tablas, índices espaciales `GIST`, bucket privado `claim-photos` y políticas RLS estrictas (`20261106000001` a `004`).
2. **Fase 2 (App Móvil del Vecino, Grabación GPS y Cola Offline):** Grabación punto a punto en `IndexedDB`, filtro de precisión GPS, recuperación ante cierres y cola offline (`20261106000005`).
3. **Fase 3 (Panel Web del Administrador y Bandeja de Validación):** KPIs, mapa con filtro `bbox`, aprobación/rechazo individual y masivo con auditoría (`20261106000006`).
4. **Fase 4 (Consolidación PostGIS y Clasificación Jerárquica):** `consolidate_trip`, `unconsolidate_trip`, `reclassify_all_roads`, `rename_road`, `merge_roads`, `reprocess_all_roads` y niveles `Troncal`, `Principal`, `Secundario` y `Vecinal` (`20261106000007`).
5. **Fase 5 (Reclamos Georreferenciados, Fotos Comprimidas y Correos Brevo):** Compresión en cliente (`1600px` + miniatura `320px`), URLs firmadas temporales, clustering en mapa, alta de reclamos desde `/admin` y despacho automático de correos vía Brevo con `pg_net` (`20261106000008` y `010`).
6. **Fase 6 (Estadísticas e Indicadores Municipales):** Ranking de uso, distribución por jerarquía, evolución mensual y cruce espacial reclamos-caminos con `ST_DWithin` (`20261106000009`).
7. **Fase 7 (Offline PWA, Auditoría `EXPLAIN ANALYZE`, Mapbox HD y Pruebas):** Service Worker, Mapbox Satellite Streets HD `@2x` retina, clasificación híbrida (migraciones `011`, `012`, `013`) y 5 suites de tests SQL aprobadas 100%.

---

## 3. Hoja de Ruta: Fases 9 a 14 y Fase 8 (Capacitor Android e iOS)

### 🚜 Fase 9: Catálogos y Rol Operario en Base de Datos
* **Objetivo:** Tablas `operators`, `machines`, `work_types`, funciones `is_operator()` y `get_my_role()`, y políticas RLS.
* **Panel `/admin`:** Pestaña "Intervenciones" con subpantallas para administrar Maquinaria, Operarios y Tipos de trabajo (activar/desactivar, nada se borra).
* **Operarios:** Carga con cuenta (Supabase Auth) o sin cuenta (registro para asignación histórica).

### 🗺️ Fase 10: Intervenciones Programadas desde el Panel y Capa en el Mapa
* **Objetivo:** Programar tareas viales desde `/admin` (`interventions`, `intervention_work_types`, `intervention_machines`, `intervention_operators`, `intervention_history`).
* **Definición de tramo:** Tres modos: (a) Seleccionar camino consolidado y marcar tramo, (b) marcar puntos sobre caminos con cálculo espacial (`ST_LineSubstring` en `EPSG:32720`) siguiendo curvas reales, o (c) dibujar a mano alzada.
* **Mapa General:** Tercera capa "Intervenciones" independiente de Caminos y Reclamos.

### 📱 Fase 11: Interfaz Operativa de Lista de Tareas en la App Móvil
* **Objetivo:** Incorporar la vista de **Lista de Tareas** para operarios dentro de `apps/mobile` con el acceso diferenciado por usuario y clave.
* **Vista del Operario:** Lista de tareas asignadas (planificadas y abiertas) con camino, tramo en mapa, maquinaria asignada y cache offline en IndexedDB.

### 🧪 Fase 12: Prototipo de GPS de Trabajos con Datos Reales (Spike)
* **Objetivo:** Probar con 10 archivos GPX reales de motoniveladoras el algoritmo de detección de tramo trabajado (descartar pasadas repetidas de ida y vuelta, paradas largas y detectar tramos con curvas o esquinas).

### 📦 Fase 8: Conversión a Aplicación Nativa con Capacitor (Android & iOS)
* **Objetivo:** Empaquetar la aplicación móvil como App Nativa para distribución directa y tiendas oficiales:
  * **Para Android:** Compilación directa en la PC con Windows usando **Android Studio** para generar el archivo de prueba **`.apk`** (distribuible por WhatsApp/enlace) y el paquete de producción **`.aab`** para **Google Play Console** (\$25 USD pago único).
  * **Para iOS (iPhone):** Generación del proyecto nativo en `/ios`. Compilación con **Xcode** (usando una Mac o servicio de compilación en la nube como GitHub Actions / Codemagic) para generar el archivo firmado para **Apple App Store Connect** (\$99 USD/año).
  * **Segundo Plano Garantizado:** Configuración de `FOREGROUND_SERVICE` y permisos de ubicación en segundo plano para que el GPS no se corte con la pantalla apagada.

### 🚜 Fase 13: Ejecución de Trabajos desde el Celular y Validación Municipal
* **Objetivo:** El operario ejecuta tareas programadas o crea espontáneas desde su teléfono.
* **Funcionalidad:**
  * Tareas lineales: botón "Ejecutar" con GPS (no graba traslado de corralón) y botón "Terminar por hoy" (suspende y acumula sesiones sin duplicar tareas).
  * Tareas puntuales (alcantarillas): registro de punto GPS y fotos sin trackeo continuo.
  * Vinculación opcional con reclamo vial cercano para marcarlo resuelto al validar.
* **Panel `/admin`:** Bandeja de validación de trabajos con aprobación/rechazo individual y masivo.

### 📊 Fase 14: Estadísticas e Indicadores de Intervenciones
* **Objetivo:** Sección de intervenciones en Estadísticas (km trabajados, maquinaria más utilizada, distribución por tipo de trabajo, reclamos resueltos).
* **Privacidad gremial:** Cantidad de operarios participantes sin rankings nominales de personas.
* **Avisos:** Se suman los trabajos pendientes al resumen semanal unificado por email (Brevo).
