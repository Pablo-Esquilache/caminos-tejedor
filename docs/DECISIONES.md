# Registro de Decisiones Técnicas (`DECISIONES.md`)

En este documento se registran todas las decisiones de arquitectura, diseño y producto tomadas durante el desarrollo del proyecto **Caminos Rurales de Carlos Tejedor**.

---

## 2026-11-06 — Definición inicial de arquitectura y ajustes sobre el plan base

### 1. Integración de la Fase 0 (Prototipo de Consolidación) dentro de la Fase 4
* **Contexto:** El plan original planteaba una Fase 0 aislada en Docker local antes de crear la base de datos y la aplicación móvil, requiriendo salir a grabar 10 recorridos reales con una app externa.
* **Decisión:** Se unifica la validación del algoritmo de consolidación dentro de la **Fase 4**. De esta forma, primero se construye la base en Supabase (Fase 1), la App Móvil (Fase 2) y el Panel Web (Fase 3), permitiendo probar el algoritmo tanto con trazas automáticas sobre coordenadas reales de Carlos Tejedor (incluyendo **curvas cerradas, cruces a 90° y caminos paralelos cercanos**) como saliendo a grabar recorridos reales directamente con nuestra propia aplicación.

### 2. Estrategia Multi-dispositivo para Municipios (Android APK + iPhone PWA + Panel Web)
* **Contexto:** En Android se puede distribuir un `.apk` directo por enlace o código QR sin costo. En cambio, iOS (iPhone) bloquea la instalación de apps nativas fuera de la App Store salvo que se pague el programa Apple Developer ($99 USD/año).
* **Decisión:** Construir `apps/mobile` con **Expo (React Native + Web/PWA)**:
  * **Android:** Se distribuye como `.apk` nativo (con soporte de servicio en primer plano para GPS con pantalla apagada).
  * **iPhone (iOS):** Se despliega además como **PWA (Web App instalable en Safari)** en Netlify usando la API `WakeLock` para mantener activo el GPS durante la grabación sin exigirle al Municipio o al desarrollador pagar la cuenta de Apple desde el día 1. El código sigue siendo 100% compatible para compilarse a iOS nativo cuando se desee subir a la App Store.

### 3. Proveedor de Emails Transaccionales: Brevo vía API HTTP
* **Contexto:** Se evaluó usar SMTP de Gmail con contraseña de aplicación vs. Brevo.
* **Decisión:** Se elige **Brevo (API REST HTTPS, plan gratuito de 300 emails/día)** desde las Edge Functions de Supabase. Evita bloqueos de puertos SMTP en entornos serverless y bloqueos de seguridad de Google por envíos automatizados. Además, permite configurar una dirección de correo neutra como remitente verificado para no exponer el correo personal del desarrollador ante los vecinos o el Municipio.

### 4. Proveedor de Mapas y Capa Propia
* **Contexto:** Se requiere construir un mapa propio de caminos rurales a partir de los trackeos aprobados, pero manteniendo referencias geográficas claras (rutas, localidades, caminos base y vista satelital) sin usar el servidor público de OpenStreetMap.
* **Decisión:** Usar **MapLibre GL** junto con **MapTiler** (plan gratuito de 100.000 cargas/mes), superponiendo las capas vectoriales propias de recorridos y caminos consolidados de PostGIS.

### 5. Identidad de Administradores y Validación de Recorridos
* **Decisión:**
  * El sistema soporta múltiples administradores definidos en la tabla `public.admins` y verificados en base de datos con `public.is_admin()`.
  * La misma cuenta de un administrador sirve tanto en el Panel Web como en la App Móvil: cuando un administrador graba un camino o envía un reclamo desde la app, el recorrido ingresa directamente con estado `approved` mediante un trigger en PostgreSQL.
  * Los recorridos de usuarios comunes ingresan siempre como `pending` y no vencen hasta ser aprobados o rechazados.

### 6. Visibilidad de Estados y Modo Sin Señal (Offline) en la App
* **Decisión:**
  * El vecino ve en su listado los estados `"En revisión"` (`pending`), `"Aprobado"` (`approved`) o `"No incluido en el mapa"` (`rejected`).
  * Cuando se graba un recorrido o se crea un reclamo sin conexión a internet, la app guarda los datos localmente y muestra un aviso explícito indicando que se sincronizará automáticamente al recuperar señal.
