# Plan de Acción y Estado de Implementación — Caminos Rurales de Carlos Tejedor

> **Estado actual del proyecto (Noviembre 2026):** Las **Fases 1 a 7 están 100% completadas, probadas y desplegadas en producción** (Supabase + PostGIS, GitHub y Netlify). Este documento registra la arquitectura vigente, las Fases 1 a 7 cerradas, y la **Ampliación de Intervenciones Viales y Rol Operario (Fases 9 a 14) combinada con la Fase 8 (Capacitor / App Nativa)**.

---

## 1. Arquitectura Definitiva y Tres Accesos Separados

El sistema cuenta con tres accesos bien diferenciados para garantizar máxima privacidad y usabilidad:

1. **App Móvil del Vecino (`/` — `apps/mobile`):**
   * **100% exclusiva y limpia para el vecino común:** acceso únicamente con **"Continuar con Google"** (sin mención de trabajadores, operarios ni formularios administrativos).
   * Grabación GPS real con persistencia inmediata en IndexedDB, cola de sincronización offline (*Outbox*) para recorridos y reclamos, y mapa satelital Mapbox HD `@2x`.
2. **Acceso Exclusivo de Operarios de Maquinaria (`/operarios`):**
   * Pantalla de login propia con **usuario/email y contraseña** asignados por el Municipio (sin obligar a usar Google personal en teléfonos de trabajo).
   * Al ingresar, accede a su **Lista de Tareas**: visualización de tareas asignadas (planificadas por el Admin), ejecución de tareas lineales con GPS o registro de tareas puntuales (alcantarillas) y generación de tareas espontáneas en el campo.
3. **Panel Web Municipal de Administración (`/admin` — `apps/admin`):**
   * Centro de control municipal con verificación `is_admin()`, menú fijo (*sticky*) con contador de reclamos nuevos, programación de intervenciones sobre el mapa, validación de recorridos y trabajos, catálogos y estadísticas.

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

## 3. Hoja de Ruta: Ampliación de Intervenciones Viales y Rol Operario (Fases 9 a 14) y Fase 8

### 🚜 Fase 9: Catálogos y Rol Operario en Base de Datos
* **Objetivo:** Crear tablas `operators`, `machines` y `work_types`, funciones `is_operator()` y `get_my_role()`, y políticas RLS.
* **Panel `/admin`:** Pestaña "Intervenciones" con subpantallas para administrar Maquinaria, Operarios y Tipos de trabajo (activar/desactivar, nada se borra).
* **Operarios:** Carga con cuenta (vinculada a Supabase Auth) o sin cuenta (solo registro para asignación histórica).
* **Criterio de salida:** Migraciones aplicadas, catálogos administrables, pruebas de permisos con 4 perfiles (usuario común, operario, admin y anónimo).

### 🗺️ Fase 10: Intervenciones Programadas desde el Panel y Capa en el Mapa
* **Objetivo:** Programar tareas viales desde `/admin` (`interventions`, `intervention_work_types`, `intervention_machines`, `intervention_operators`, `intervention_history`).
* **Definición de tramo:** Tres modos: (a) Seleccionar camino consolidado y marcar tramo, (b) marcar puntos sobre caminos con cálculo espacial (`ST_LineSubstring` en `EPSG:32720`) siguiendo curvas reales, o (c) dibujar a mano alzada.
* **Mapa General:** Tercera capa "Intervenciones" independiente de Caminos y Reclamos.
* **Criterio de salida:** Tareas programadas visibles en mapa y listado con filtros e historial.

### 📱 Fase 11: Interfaz Exclusiva del Operario (`/operarios`)
* **Objetivo:** Pantalla de acceso independiente `/operarios` con usuario y contraseña municipal.
* **Vista del Operario:** "Lista de Tareas" asignadas (planificadas y abiertas) con camino, tramo en mapa, maquinaria asignada y cache offline en IndexedDB.
* **Cero impacto en el vecino:** La ruta `/` permanece inalterada y sin botones de operarios.
* **Criterio de salida:** Operario accede por `/operarios`, ve solo sus tareas asignadas y consulta offline.

### 🧪 Fase 12: Prototipo de GPS de Trabajos con Datos Reales (Spike)
* **Objetivo:** Probar con 10 archivos GPX reales de motoniveladoras el algoritmo de detección de tramo trabajado (descartar pasadas repetidas de ida y vuelta, paradas largas y detectar tramos con curvas o esquinas).
* **Criterio de salida:** Algoritmo validado y documentado en `docs/spike-trabajos-resultados.md`.

### 📦 Fase 8: Conversión a Aplicación Nativa con Capacitor (Foreground Service)
* **Objetivo:** Empaquetar la aplicación móvil como APK nativo de Android configurando `@capacitor-community/background-geolocation` con servicio en primer plano (*Foreground Service*) y notificación persistente en barra de estado.
* **Por qué antes de Fase 13:** Permite que el maquinista bloquee la pantalla del teléfono y lo guarde en la cabina sin que Android suspenda el rastreo GPS durante la jornada de trabajo.
* **Criterio de salida:** APK compilado y probado con pantalla apagada en campo.

### 🚜 Fase 13: Ejecución de Trabajos desde el Celular y Validación Municipal
* **Objetivo:** El operario ejecuta tareas programadas o crea espontáneas desde `/operarios`.
* **Funcionalidad:**
  * Tareas lineales: botón "Ejecutar" con GPS (no graba traslado desde corralón). Soporta "Terminar por hoy" (suspende la tarea y abre nueva sesión al día siguiente).
  * Tareas puntuales (alcantarillas): registro de punto GPS y foto sin trackeo continuo.
  * Vinculación opcional con reclamo vial cercano para marcarlo resuelto.
* **Panel `/admin`:** Bandeja de validación de trabajos con aprobación/rechazo individual y masivo.
* **Criterio de salida:** Trabajo ejecutado en varios días validado en el mapa de intervenciones.

### 📊 Fase 14: Estadísticas e Indicadores de Intervenciones
* **Objetivo:** Sección de intervenciones en Estadísticas (km trabajados, maquinaria más utilizada, distribución por tipo de trabajo, reclamos resueltos).
* **Privacidad gremial:** Se reporta cantidad de operarios participantes sin rankings nominales de personas.
* **Avisos:** Se suman los trabajos pendientes al resumen semanal unificado por email (Brevo).
* **Criterio de salida:** Consultas de control en `supabase/tests/stats_checks.sql` aprobadas.
