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

### 9. Deep Linking para Retorno de Google OAuth en App Nativa (Android & iOS)
* **Contexto:** Al tocar "Continuar con Google" desde la app nativa empaquetada (Capacitor APK), el sistema operativo abre el navegador (Chrome). Al completarse la autenticación, el navegador debe devolver el control y los tokens de sesión a la app nativa instalada en lugar de continuar dentro del navegador web.
* **Decisión:**
  * Se implementa un **Deep Link** con esquema personalizado `com.caminosrurales.tejedor://login-callback`.
  * Se agrega el `<intent-filter>` correspondiente en `AndroidManifest.xml` y bloque `<queries>` para permitir la invocación de Custom Tabs en Android 11+.
  * Se utilizan `@capacitor/app` y `@capacitor/browser` para detectar el retorno `appUrlOpen`, extraer el código o hash de sesión y llamar a `supabase.auth.exchangeCodeForSession` o `setSession`.

### 10. Adaptabilidad de Pantalla Móvil (Safe Area Insets) y Administrador Utilitario en Teléfono
* **Contexto:** En celulares con notch, cámara frontal perforada o barras de navegación virtuales por gestos, el contenido de la app nativa se solapaba con los iconos del sistema (hora, batería, señal) y los botones inferiores de navegación de Android. Asimismo, el Administrador en el celular no requiere un panel de escritorio pesado, sino una herramienta utilitaria de campo.
* **Decisión:**
  * **Safe Area Insets:** Se incorporan márgenes dinámicos en CSS (`env(safe-area-inset-top)` y `env(safe-area-inset-bottom)`) en el encabezado `.top-bar`, la navegación `.bottom-nav` y la pantalla de ingreso.
  * **Administrador en el Móvil:** La app se mantiene 100% como herramienta operativa (grabación de caminos con auto-aprobación y carga de reclamos). Se agrega en el encabezado un botón directo *"Panel Web ↗"* que abre la plataforma web de gestión completa en el navegador, preservando la ligereza de la app de campo.

### 11. Frecuencia de Muestreo GPS: Pantalla Activa vs. Pantalla Bloqueada
* **Contexto:** En los caminos rurales de Carlos Tejedor, las curvas no son continuas sino que suelen presentar esquinas pronunciadas a 90 grados al doblar entre cuadros o parcelas. Al bloquear la pantalla para ahorrar batería, un muestreo excesivamente espaciado cortaba las esquinas con líneas rectas.
* **Decisión:**
  * **Pantalla activa / encendida:** Muestreo de alta frecuencia cada 1 a 2 segundos mediante `watchPosition`.
  * **Pantalla bloqueada / en segundo plano:** Muestreo cada 2 a 3 segundos (2.5s) o 10 metros mediante temporizador nativo reforzado, registrando de 3 a 4 puntos en cada giro de 90° (que a 15-20 km/h demora entre 6 y 10 segundos), capturando la geometría real del camino sin gastar batería innecesaria. Se descarta ruido por micro-movimiento (< 2 metros) al estar detenido.

### 12. Independencia Geométrica de Intervenciones respecto a la Red de Caminos
* **Decisión:** Las intervenciones se vinculan a nivel de camino (`road_id`) o por cálculo espacial en el mapa, y no a los segmentos internos `road_segments`. Esto garantiza que operaciones del motor vial (reprocesamiento, unión de caminos con `merge_roads` o revocaciones) jamás rompan ni borren el historial de obras realizadas.

### 13. Privacidad Gremial y Protección Laboral
* **Decisión:** En los paneles públicos y estadísticas de intervenciones **no se generan rankings nominales de operarios ni competencias de personas**. Se reportan metros/kilómetros trabajados por máquina y tipos de obra, y en trabajos compartidos se distingue al **operario responsable** (que opera el rastreo) de los **participantes**.

### 14. Puente Web OAuth (`auth-callback.html`) para Retorno a App Nativa
* **Contexto:** Al autenticar con Google en dispositivos móviles, los navegadores y proveedores OAuth (Google Cloud Console y Supabase) exigen redirecciones a dominios web `https://` autorizados y restringen esquemas URI personalizados (`com.caminosrurales.tejedor://`). Si se intenta redirigir directamente al esquema custom, Supabase recae en la URL base del sitio y deja al usuario atrapado en el navegador interno.
* **Decisión:** Se implementa una página puente estática en Netlify (`/auth-callback.html`). Google y Supabase redirigen con éxito a esta URL web HTTPS permitida, y el script de la página dispara de inmediato el Deep Link nativo `com.caminosrurales.tejedor://login-callback` con el token o código correspondiente. Android intercepta el esquema, vuelve a la app móvil en primer plano y cierra automáticamente la pestaña del navegador con `Browser.close()`.

### 15. Transferencia de Sesión (SSO Handoff) desde App Móvil al Panel Web de Administración
* **Contexto:** La app móvil instalada y el navegador Chrome mantienen almacenamientos y cookies completamente aislados. Cuando el Administrador pulsa *"Panel Web ↗"*, Chrome no tenía acceso a la sesión iniciada en la app y volvía a pedir usuario y contraseña.
* **Decisión:** Al pulsar *"Panel Web ↗"*, la app móvil adjunta los tokens de sesión activos (`access_token` y `refresh_token`) en el fragmento hash de la URL (`#access_token=...&refresh_token=...&type=sso`). El Panel Web en `/admin` detecta estos tokens al montar, los registra en Supabase (`setSession`), limpia de inmediato la barra de direcciones con `window.history.replaceState` para no exponer los tokens, y concede acceso directo al panel administrativo sin solicitar nuevamente las credenciales.

### 16. Retorno Automático a la Lista de Recorridos tras Validar en el Panel Web
* **Contexto:** Al revisar un recorrido en el panel web administrativo y pulsar *"Aprobar"* o *"Rechazar"*, la interfaz permanecía fija en la ficha de detalle, obligando al usuario a hacer clic manualmente en la flecha de volver para seleccionar el siguiente recorrido de la bandeja.
* **Decisión:** Tras ejecutar la aprobación o rechazo (individual o en lote), el estado de detalle se restablece (`detailTripId = null`), regresando de forma inmediata y automática al listado general de recorridos pendientes para agilizar la validación masiva.

### 17. Servicio Nativo en Primer Plano (Foreground Service) para Pantalla Bloqueada
* **Contexto:** En teléfonos Android modernos, el modo de ahorro de energía (*Doze Mode*) congela los temporizadores JavaScript (`setInterval`) y los escuchadores de WebView cuando la pantalla se apaga o bloquea, provocando que sólo se grabaran el punto de inicio y el punto de desbloqueo, trazando líneas rectas que cortaban las curvas.
* **Decisión:** Se implementa un servicio nativo en Java (`LocationService`) que se ejecuta como **Foreground Service** con notificación persistente en la barra de estado (*"Caminos Tejedor: Relevamiento activo"*), permiso `FOREGROUND_SERVICE_LOCATION` y un `WakeLock` parcial. Esto garantiza que la CPU y el chip GPS continúen muestreando y emitiendo coordenadas cada 2 segundos con exactitud geométrica idéntica tanto con pantalla encendida como bloqueada en el bolsillo.

### 18. Límite Geográfico Oficial del Partido de Carlos Tejedor (Geofence con Buffer de 3 km)
* **Contexto:** Se requiere prevenir que la app grabe recorridos fuera de la jurisdicción municipal o en viajes hacia otras localidades lejanas de la provincia.
* **Decisión:** Se incorpora en `@shared/boundary` el polígono oficial del Partido de Carlos Tejedor (IGN / INDEC / OSM Relation 2564066, abarcando Carlos Tejedor cabecera, Tres Algarrobos, Timote, Curarú, Colonia Seré y cuarteles rurales). Se aplica un **margen de tolerancia (buffer) de 3 km** hacia el exterior para preservar los caminos rurales limítrofes compartidos con distritos vecinos (Pehuajó, Trenque Lauquen, General Villegas, Rivadavia y General Pinto). Si el vehículo traspasa este límite, la grabación se pausa preventivamente.

### 19. Temporizador de Seguridad de 1 Hora y Filtro de Velocidad Sostenida en Ruta
* **Contexto:** Para evitar consumos innecesarios de batería si el usuario olvida detener la grabación al llegar a su destino, o si se desplaza por rutas asfaltadas nacionales/provinciales a alta velocidad durante viajes interurbanos.
* **Decisión (Unificada para App y Web):**
  * **Temporizador de 1 hora (60 minutos):** Al cumplirse 60 minutos continuos de grabación, la app entra en pausa preventiva, emite un tono audible y vibración, y despliega un diálogo emergente: *"¿Seguís en el camino? Llevás 1 hora grabando"*, ofreciendo *"Sí, seguir grabando"* (reinicia el temporizador de seguridad) o *"No, guardar recorrido"*. Si el usuario no responde de inmediato, los puntos permanecen resguardados en pausa sin perder datos.
  * **Filtro de velocidad sostenida en ruta:** Si el vehículo mantiene de manera ininterrumpida una velocidad mayor a 100 km/h durante más de 30 minutos, se detecta automáticamente tránsito en ruta interurbana y se pausa preventivamente la toma de datos. Cruces o traslados cortos por Ruta 226 (< 30 min) no se interrumpen.

### 20. Alta de Cuentas de Operarios y Algoritmo de Deduplicación Multi-Pasada (Fases 9-14)
* **Decisión:**
  * **Alta de operarios desde `/admin`:** La función SQL `admin_upsert_operator` permite al Administrador crear credenciales reales de ingreso (`email` + `password` en `auth.users` y `auth.identities`) directamente desde el Panel Web sin exponer la `SERVICE_ROLE_KEY` en el cliente, además de permitir operarios históricos sin cuenta y bloqueo inmediato al desactivar.
  * **Deduplicación GPS de maquinaria vial (`extract_worked_tramo_utm`):** Divide las trazas en pasadas continuas ante giros en U (> 125°) preservando esquinas de 90°, colapsa paradas largas (12 m) y recorta mediante `ST_Difference` con buffer lateral (24 m en `EPSG:32720`) cualquier pasada repetida de ida y vuelta o superpuesta entre jornadas múltiples (*"Terminar por hoy"*).
  * **Despliegue Web/PWA preservando APK:** El workflow `.github/workflows/build-apk.yml` pasó a ejecución manual (`workflow_dispatch`) mientras se valida el Módulo de Operario en Web/PWA, evitando pisar el release `v1.0.0-apk` existente.
