# Plan de Acción y Estado de Implementación — Caminos Rurales de Carlos Tejedor

> [!IMPORTANT]
> **Estado del proyecto (Noviembre 2026):** Las **Fases 1 a 7 están 100% completadas, probadas y en producción**. Se incorpora la **Ampliación de Intervenciones Viales y Rol Operario (Fases 9 a 14)** estructurada en un esquema de **3 accesos independientes (`/`, `/operarios`, `/admin`)** y coordinada con la **Fase 8 (Capacitor / App Nativa)**.

---

## 1. Esquema de 3 Accesos Independientes

1. **App Móvil del Vecino (`/`):**
   * 100% limpia para el vecino rural. Ingreso exclusivo con **"Continuar con Google"**.
   * Sin botones, menciones ni accesos de operarios ni administradores.
2. **Acceso Exclusivo de Operarios de Maquinaria (`/operarios`):**
   * Pantalla de login propia con **usuario y contraseña** generados por el Municipio.
   * Interfaz operativa en formato **Lista de Tareas**: visualización de órdenes de trabajo asignadas por el Admin, ejecución con GPS en tramos viales o registro de alcantarillas puntuales, y carga de trabajos espontáneos.
3. **Panel Web de Administración Municipal (`/admin`):**
   * Centro de comando para intendente y secretarios: planificación de obras en el mapa, catálogos de máquinas y operarios, validación de tareas y métricas.

---

## 2. Hoja de Ruta de Fases 9 a 14 y Fase 8

| Fase | Alcance y Objetivo | Dependencias | Salida Esperada |
|---|---|---|---|
| **Fase 9: Catálogos y Rol en Base** | Tablas `operators`, `machines`, `work_types`. Funciones `is_operator()`, `get_my_role()`, RLS y pantallas de gestión en `/admin`. | Fases 1 a 7 | Catálogos administrables, rol asignable y tests SQL con 4 perfiles. |
| **Fase 10: Intervenciones desde `/admin`** | Programación de tareas con tramo en mapa (`ST_LineSubstring`), listado, historial y 3ra capa en el mapa general. | Fase 9 | Tareas programadas visibles en mapa y listado con filtros. |
| **Fase 11: Interfaz Operario en `/operarios`** | Pantalla de login `/operarios`, Lista de Tareas asignadas (solo lectura + cache offline), sin tocar `/`. | Fases 9 y 10 | Operario ingresa a `/operarios`, ve sus tareas y consulta sin señal. |
| **Fase 12: Prototipo GPS de Trabajos** | Spike con 10 GPX reales de motoniveladoras para validar algoritmo de tramo trabajado (descarte de pasadas repetidas). | Fase 10 | Algoritmo validado y documentado con casos borde. |
| **Fase 8: App Nativa (Capacitor)** | Empaquetado APK Android con *Foreground Service* (`@capacitor-community/background-geolocation`) para grabar GPS con pantalla bloqueada en la cabina. | Fases 11 y 12 | App nativa lista con grabación garantizada en segundo plano. |
| **Fase 13: Trabajos desde el Celular** | Ejecución de tareas programadas y espontáneas, botón "Terminar por hoy" (sesiones múltiples), y validación en `/admin`. | Fase 8 y 12 | Trabajo de varios días ejecutado en campo y validado en mapa. |
| **Fase 14: Estadísticas y Avisos** | Métricas de km trabajados, máquinas utilizadas y resumen semanal unificado por email (Brevo). Sin rankings de personas. | Fase 13 | KPIs consolidados en `/admin` y consultas de control aprobadas. |
