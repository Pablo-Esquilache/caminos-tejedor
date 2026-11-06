# Plan de Acción Definitivo — Caminos Rurales de Carlos Tejedor

Este documento consolida el plan original con todos los ajustes acordados para que el sistema sea **100% funcional en Android, iPhone y Web**, operable con **herramientas gratuitas** desde tus propias cuentas técnicas, y listo para **entregar o comercializar a un Municipio** sin exponer datos personales.

---

## 1. Decisiones Cerradas y Arquitectura

### A. Estrategia de Dispositivos (Android + iPhone + Panel Web)
* **Panel del Administrador (`apps/admin`):** Web App en **React + Vite + TypeScript**, alojada en **Netlify** (plan gratuito). Diseñada para usar cómodamente en computadora o tablet en el municipio.
* **App del Usuario/Vecino (`apps/mobile`):** Desarrollada con **Expo (React Native + TypeScript + Expo Router)** con doble salida desde el mismo código:
  1. **Android:** Instalable gratis mediante enlace directo o código QR (`.apk`), con soporte completo de GPS en segundo plano con pantalla apagada.
  2. **iPhone (iOS) sin costo de Apple Store:** Desplegada también como **PWA (Web App instalable desde Safari en "Agregar a Inicio")** en Netlify. Para reclamos, fotos y mapas funciona igual que nativa; para trackear caminos activa `WakeLock` (mantiene la pantalla encendida mientras graba para que iOS no corte el GPS). Si en el futuro el Municipio decide pagar los $99 USD/año de Apple Developer, el mismo código se compila directo a la App Store sin reprogramar nada.

### B. Cuentas, Propiedad y Entrega al Municipio
* **Cuentas técnicas (GitHub, Supabase, Netlify, Brevo, MapTiler):** Quedan bajo control del desarrollador/proveedor. Todo se configura mediante variables de entorno (`.env`) y migraciones SQL (`supabase/migrations/`), lo que permite levantar otra instancia para otro municipio en minutos o transferirla si fuera necesario.
* **Lo que recibe el Municipio:** El enlace al Panel Web, las credenciales de sus administradores y el enlace/QR de la App para vecinos.
* **Privacidad de la cuenta personal:** En **Brevo** y en la pantalla de **Google OAuth** se configura un correo neutro del sistema (ej. `avisos.caminosrurales@gmail.com`) como remitente verificado para que ningún vecino ni funcionario vea el correo personal del desarrollador.

### C. Reglas de Negocio Clave
1. **Administradores (`admins`):** Pueden ser varios. Su cuenta está en la tabla `admins` y les sirve tanto para gestionar en el Panel Web como para usar la App Móvil (enviar reclamos y trackear caminos).
2. **Validación de recorridos:**
   * Los recorridos de un **administrador** entran directamente con estado `approved`.
   * Los recorridos de un **usuario común** entran con estado `pending` (no vencen nunca) y solo suman a la red de caminos y estadísticas cuando un administrador los aprueba.
   * En la app, el vecino ve el estado de su recorrido: `"En revisión"`, `"Aprobado"` o `"No incluido en el mapa"`.
3. **Aviso claro de Modo Sin Señal (Offline):** Si el usuario graba un recorrido o crea un reclamo sin señal en el campo, queda guardado en el teléfono y la app muestra un aviso claro: *"Guardado en el dispositivo (sin señal). Se enviará automáticamente cuando recuperes conexión"*.
4. **Mapa propio sobre referencias reales:** Se usa **MapLibre GL + MapTiler (plan gratuito)** para mostrar la base geográfica (rutas, localidades como Carlos Tejedor, Tres Algarrobos, Colonia Seré, Timote, Curarú, y opción de vista satelital/calles), dibujando por encima **nuestra propia red consolidada de caminos rurales** con colores, grosores y nombres propios.
5. **Notificaciones:** Por **email (vía API de Brevo, 300 mails/día gratis)** y **bandeja interna en la app** (`notifications`). Sin notificaciones push nativas.
6. **Privacidad:** Ninguna pantalla pública ni endpoint accesible por vecinos devuelve el nombre o correo de quién grabó un camino o hizo un reclamo. Nada se borra físicamente de la base de datos.

---

## 2. Estructura del Monorepo

```text
caminos-rurales/
  apps/
    mobile/             # Expo (React Native + Web/PWA) + TypeScript
    admin/              # React + Vite + TypeScript (Panel Municipal)
  packages/
    shared/             # Tipos TypeScript, constantes y validaciones compartidas
  supabase/
    migrations/         # Esquema SQL + PostGIS versionado
    functions/          # Edge Functions (envío de emails con Brevo, cron semanal)
    seed/               # Categorías iniciales y parámetros de configuración
    tests/              # Pruebas SQL de permisos (RLS), consolidación y estadísticas
  docs/
    PLAN.md             # Este plan de acción
    DECISIONES.md       # Registro de decisiones técnicas con fecha
```

---

## 3. Fases de Ejecución

1. **Fase 1: Base del Proyecto, Supabase, Roles y Seguridad (RLS)**
2. **Fase 2: App del Vecino (Login, Grabación GPS, Mapa Base y Aviso Sin Señal)**
3. **Fase 3: Panel Web del Administrador, Mapa Operativo y Validación**
4. **Fase 4: Consolidación de Caminos en PostGIS (Curvas, Cruces, Pruebas y Clasificación)**
5. **Fase 5: Reclamos con Fotos y Notificaciones (Brevo + In-App)**
6. **Fase 6: Estadísticas e Indicadores para el Municipio**
7. **Fase 7: Cola Offline Completa, Optimización, Seguridad y Cierre**
