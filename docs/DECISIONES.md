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

## 2026-11-09 — Ampliación: Intervenciones Viales y Rol Operario (Fases 9 a 14) y Fase 8

### 6. Login Unificado Inteligente en la App Móvil (Vecino vs. Personal Municipal)
* **Contexto:** Se requiere brindar acceso tanto al vecino común (con Google) como a los operarios de maquinaria y administradores (con correo y contraseña municipal creados en Supabase Auth) desde la misma app móvil, sin confundir al vecino ni obligar a los maquinistas a usar cuentas personales de Google en teléfonos de trabajo.
* **Decisión:**
  * **Pantalla de Login Móvil:**
    * Botón central principal: *"Continuar con Google"* (destinado al vecino).
    * Enlace discreto inferior: *`"¿Sos personal municipal? Ingresar con usuario y clave"`*, que al tocarse despliega los campos de email y contraseña.
  * **Detección de Roles post-login:**
    * Si ingresa un **Vecino (`user`)**: accede a la app de siempre (grabar caminos, reclamos y mapa).
    * Si ingresa un **Operario (`operator`)**: accede a la **Lista de Tareas** asignadas por el Municipio (ejecutar trabajos con GPS o tareas puntuales).
    * Si ingresa el **Administrador (`admin`)**: la app le permite grabar con GPS nativo en segundo plano y sus recorridos se **auto-aprueban y consolidan de inmediato**.

### 7. Estrategia de Empaquetado Nativo con Capacitor (Fase 8: Android & iOS)
* **Decisión:**
  * **Android:** Compilación en la PC del desarrollador con **Android Studio** para generar el `.apk` de prueba directa (compartible por WhatsApp/enlace) y el paquete `.aab` para **Google Play Console** (\$25 USD pago único).
  * **iOS (iPhone):** Generación del proyecto nativo en `/ios` con Capacitor. Compilación con **Xcode** (usando Mac o servicio de compilación en la nube) para generar el `.ipa` publicado en **Apple App Store Connect** (\$99 USD/año).
  * **Servicio en Primer Plano:** Uso de `@capacitor-community/background-geolocation` con `FOREGROUND_SERVICE` para que el GPS de la máquina o vehículo no se suspenda al bloquear la pantalla.

### 8. Enfoque de Lista de Tareas y Dualidad de Tareas (Lineales vs. Puntuales)
* **Decisión:**
  * **Tareas Lineales (motoniveladora, alteo, cuneteo, perfilado):** Requieren **trackeo GPS** para certificar tramo, pasadas y kilómetros reales. El rastreo inicia en el tramo de trabajo (no se graba el traslado desde el corralón).
  * **Tareas Puntuales (alcantarillas, tubos, bacheo):** **No requieren trackeo continuo**; se registran marcando el punto en el mapa o con la ubicación del dispositivo al momento de finalizar.
  * **Jornadas múltiples (Estado "Suspendida"):** Un trabajo puede ejecutarse en varios días mediante la opción "Terminar por hoy", cerrando la sesión del día y reanudando al día siguiente bajo la misma intervención sin duplicar tareas.

### 9. Independencia Geométrica de Intervenciones respecto a la Red de Caminos
* **Decisión:** Las intervenciones se vinculan a nivel de camino (`road_id`) o por cálculo espacial en el mapa, y no a los segmentos internos `road_segments`. Esto garantiza que operaciones del motor vial (reprocesamiento, unión de caminos con `merge_roads` o revocaciones) jamás rompan ni borren el historial de obras realizadas.

### 10. Privacidad Gremial y Protección Laboral
* **Decisión:** En los paneles públicos y estadísticas de intervenciones **no se generan rankings nominales de operarios ni competencias de personas**. Se reportan metros/kilómetros trabajados por máquina y tipos de obra, y en trabajos compartidos se distingue al **operario responsable** (que opera el rastreo) de los **participantes**.
