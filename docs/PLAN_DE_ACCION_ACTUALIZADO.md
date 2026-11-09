# Plan de Acción y Estado de Implementación — Caminos Rurales de Carlos Tejedor

> [!IMPORTANT]
> **Estado del proyecto (Noviembre 2026):** Las **Fases 1 a 7 están 100% completadas, probadas y en producción**. Se incorpora la **Ampliación de Intervenciones Viales y Rol Operario (Fases 9 a 14)** y la **Fase 8 (Capacitor para Android e iOS)** con el esquema de login unificado inteligente para Vecinos, Operarios y Administrador.

---

## 1. Login Unificado Inteligente en la App Móvil

* **Pantalla de Inicio de Sesión única:**
  * **Botón principal central:** *"Continuar con Google"* (para los vecinos).
  * **Enlace discreto inferior:** *`"¿Sos personal municipal? Ingresar con usuario y clave"`*, que despliega los campos de email y contraseña.
* **Detección automática de roles post-login:**
  * Si ingresa un **Vecino (`user`)**: accede a la app de siempre (grabar caminos, reclamos con fotos y mapa satelital).
  * Si ingresa un **Operario (`operator`)**: accede a su **Lista de Tareas** asignadas por el Municipio (ejecutar obras con GPS o cargar alcantarillas puntuales).
  * Si ingresa el **Administrador (`admin`)**: puede grabar con GPS nativo en el campo y sus recorridos se **auto-aprueban y consolidan de inmediato**.

---

## 2. Estrategia de Empaquetado Nativo (Fase 8: Android & iOS)

* **Capacitor (`apps/mobile`):** Crea las carpetas nativas `/android` e `/ios` manteniendo el mismo código React.
* **Para Android:** Se compila directamente en tu PC con Windows mediante **Android Studio**.
  * Genera el archivo **`.apk`** para prueba inmediata en tu celular (compartible por WhatsApp o enlace directo).
  * Genera el archivo **`.aab`** para publicar en **Google Play Store** (\$25 USD pago único).
* **Para iOS (iPhone):** Se compila con **Xcode** (usando una Mac o servicio de compilación en la nube como GitHub Actions).
  * Genera el archivo para publicar en **Apple App Store Connect** (\$99 USD/año).
* **Segundo Plano (Foreground Service):** Configurado para que el GPS siga grabando con la pantalla del teléfono apagada y bloqueada en el bolsillo o la cabina.

---

## 3. Hoja de Ruta de Fases 9 a 14 y Fase 8

| Fase | Alcance y Objetivo | Dependencias | Salida Esperada |
|---|---|---|---|
| **Fase 9: Catálogos y Rol en Base** | Tablas `operators`, `machines`, `work_types`. Funciones `is_operator()`, `get_my_role()`, RLS y pantallas de gestión en `/admin`. | Fases 1 a 7 | Catálogos administrables, rol asignable y tests SQL con 4 perfiles. |
| **Fase 10: Intervenciones desde `/admin`** | Programación de tareas con tramo en mapa (`ST_LineSubstring`), listado, historial y 3ra capa en el mapa general. | Fase 9 | Tareas programadas visibles en mapa y listado con filtros. |
| **Fase 11: Interfaz Operario en la App Móvil** | Integración de la vista de Lista de Tareas para operarios en `apps/mobile` con login de usuario y clave, sin tocar la vista del vecino. | Fases 9 y 10 | Operario entra con su clave, ve sus tareas asignadas y consulta sin señal. |
| **Fase 12: Prototipo GPS de Trabajos** | Spike con 10 GPX reales de motoniveladoras para validar algoritmo de tramo trabajado (descarte de pasadas repetidas). | Fase 10 | Algoritmo validado y documentado con casos borde. |
| **Fase 8: App Nativa (Capacitor Android & iOS)** | Empaquetado APK Android con *Foreground Service* (`@capacitor-community/background-geolocation`) y proyecto iOS para App Store. | Fases 11 y 12 | App nativa lista con grabación garantizada en segundo plano. |
| **Fase 13: Trabajos desde el Celular** | Ejecución de tareas programadas y espontáneas, botón "Terminar por hoy" (sesiones múltiples), y validación en `/admin`. | Fase 8 y 12 | Trabajo de varios días ejecutado en campo y validado en mapa. |
| **Fase 14: Estadísticas y Avisos** | Métricas de km trabajados, máquinas utilizadas y resumen semanal unificado por email (Brevo). Sin rankings de personas. | Fase 13 | KPIs consolidados en `/admin` y consultas de control aprobadas. |
