# Registro de Decisiones Técnicas (`DECISIONES.md`)

En este documento se registran todas las decisiones de arquitectura, diseño y producto tomadas durante el desarrollo del proyecto **Caminos Rurales de Carlos Tejedor**.

---

## 2026-11-06 — Definición inicial de arquitectura y ajustes sobre el plan base

### 1. Integración de la Fase 0 (Prototipo de Consolidación) dentro de la Fase 4
* **Decisión:** Se unifica la validación del algoritmo de consolidación dentro de la **Fase 4**. Primero se construye la base en Supabase (Fase 1), la App Móvil (Fase 2) y el Panel Web (Fase 3), permitiendo probar el algoritmo tanto con trazas automáticas sobre coordenadas reales de Carlos Tejedor como saliendo a grabar recorridos reales.

### 2. Estrategia Multi-dispositivo para Municipios (Android APK + iPhone PWA + Panel Web)
* **Decisión:** PWA en Netlify con `WakeLock` para navegadores móviles y posterior empaquetado con Capacitor para Android (APK nativo con Foreground Service para pantalla apagada).

### 3. Proveedor de Emails Transaccionales: Brevo vía API HTTP (`pg_net`)
* **Decisión:** Se utiliza **Brevo** sin intermediarios mediante la extensión `pg_net` de PostgreSQL disparada por triggers de auditoría, manteniendo las credenciales protegidas en `private_secrets`.

### 4. Proveedor de Mapas: Mapbox Satellite Streets HD (`@2x`)
* **Decisión:** Se utiliza **Mapbox Satellite Streets HD** a doble resolución retina con fallback transparente a ArcGIS World Imagery / OpenStreetMap.

### 5. Identidad de Administradores y Validación de Recorridos
* **Decisión:** Múltiples administradores definidos en `public.admins` con verificación `is_admin()`. Recorridos del admin se auto-aprueban y consolidan; los de vecinos ingresan como `pending`.

---

## 2026-11-09 — Ampliación: Intervenciones Viales y Rol Operario (Fases 9 a 14)

### 6. Tres Accesos Separados e Independientes (`/`, `/operarios`, `/admin`)
* **Contexto:** Se requiere brindar a los maquinistas y cuadrillas viales una herramienta operativa sin alterar la experiencia simple del vecino ni mezclarla con el panel administrativo general.
* **Decisión:**
  * **App del Vecino (`/`):** 100% limpia y exclusiva para vecinos con botón "Continuar con Google". Sin textos ni opciones de acceso de trabajadores.
  * **Acceso Operarios (`/operarios`):** Pantalla de acceso propia con usuario/email y contraseña generados por el Municipio en Supabase Auth.
  * **Panel Municipal (`/admin`):** Acceso con permisos de administrador para intendente y secretarios.

### 7. Enfoque de Lista de Tareas y Dualidad de Tareas (Lineales vs. Puntuales)
* **Decisión:**
  * **Tareas Lineales (motoniveladora, alteo, cuneteo, perfilado):** Requieren **trackeo GPS** para certificar tramo, pasadas y kilómetros reales. El rastreo inicia en el tramo de trabajo (no se graba el traslado desde el corralón).
  * **Tareas Puntuales (alcantarillas, tubos, bacheo):** **No requieren trackeo continuo**; se registran marcando el punto en el mapa o con la ubicación del dispositivo al momento de finalizar.
  * **Jornadas múltiples (Estado "Suspendida"):** Un trabajo puede ejecutarse en varios días mediante la opción "Terminar por hoy", cerrando la sesión del día y reanudando al día siguiente bajo la misma intervención sin duplicar tareas.

### 8. Independencia Geométrica de Intervenciones respecto a la Red de Caminos
* **Decisión:** Las intervenciones se vinculan a nivel de camino (`road_id`) o por cálculo espacial en el mapa, y no a los segmentos internos `road_segments`. Esto garantiza que operaciones del motor vial (reprocesamiento, unión de caminos con `merge_roads` o revocaciones) jamás rompan ni borren el historial de obras realizadas.

### 9. Privacidad Gremial y Protección Laboral
* **Decisión:** En los paneles públicos y estadísticas de intervenciones **no se generan rankings nominales de operarios ni competencias de personas**. Se reportan metros/kilómetros trabajados por máquina y tipos de obra, y en trabajos compartidos se distingue al **operario responsable** (que opera el rastreo) de los **participantes**.
