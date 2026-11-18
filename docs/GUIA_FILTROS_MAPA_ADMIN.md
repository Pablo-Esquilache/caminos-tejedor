# Guía Detallada de Filtros y Capas del Mapa — Panel Web de Administrador

Esta guía describe en lenguaje claro qué muestra y cómo funciona cada filtro del **Mapa General del Partido de Carlos Tejedor** (`/admin` → `AdminMap.tsx`), incluyendo los filtros avanzados de **Zonas Bajas / Relieve (MDE)** y **Satélite Reciente / Agua Detectada**.

---

## 1. Panel Flotante de Capas (`Capas del Partido de Carlos Tejedor`)

* **Botón `"Ver mapa ▲"` / `"Abrir ▼"` (fijo arriba):**
  * Al hacer clic en **`Ver mapa ▲`**, el cuadro de filtros se repliega en una pastilla compacta arriba a la izquierda para despejar todo el mapa sin apagar ninguna capa activa. Si la capa satelital está encendida, la pastilla sigue mostrando el satélite y la fecha activa.
  * Al hacer clic en **`Abrir ▼`**, se despliega nuevamente.
  * Si el panel tiene muchos controles abiertos, cuenta con scroll interno manteniendo el encabezado siempre fijo arriba.
* **Selector de mapa base (abajo a la izquierda):** Alterna entre **`Satélite + Caminos`** (foto aérea de alta definición con calles) y **`Mapa Vial`** (cartografía vial limpia).
* **Créditos (`ⓘ` abajo a la derecha):** Muestra la atribución oficial de los mapas base (`Mapbox / OpenStreetMap / Esri`) y de los productos satelitales (`NASA GIBS / OPERA DSWx / MODIS / Copernicus Sentinel`).

---

## 2. Capas Municipales Base (Vectoriales)

Todas estas capas se dibujan **por encima** del mapa base y de cualquier capa satelital, para que las líneas y puntos nunca queden tapados:

1. **Red Consolidada de Caminos** *(encendida por defecto)*:
   * Muestra los tramos oficiales de caminos rurales consolidados, coloreados y con grosor según su jerarquía vial:
     * **Troncal:** rojo (más ancho)
     * **Principal:** naranja
     * **Secundario:** azul
     * **Vecinal:** verde
   * **Al hacer clic en un tramo:** abre una ficha con nombre normalizado, jerarquía, longitud total, cantidad de recorridos aprobados y, si ya fue analizado con relieve, su cota mínima/máxima (m s.n.m.) y si presenta tramo bajo detectado.
2. **Reclamos Viales (Cluster)** *(encendido por defecto)*:
   * Agrupa reclamos cercanos en círculos numerados (clic para acercar y expandir).
   * Los puntos individuales cambian de color según su estado (**rojo:** recibido; **amarillo/naranja:** en evaluación o en proceso; **verde:** resuelto; **gris:** desestimado) y de tamaño según prioridad.
   * **Al hacer clic en un reclamo:** muestra título, categoría, estado, prioridad y botón **`Gestionar este reclamo`**.
3. **Recorridos pendientes de revisión** *(encendido por defecto)*:
   * Muestra con línea punteada naranja los recorridos enviados por vecinos que todavía esperan aprobación o rechazo administrativo.
4. **Intervenciones Viales** *(encendida por defecto)*:
   * **Línea sólida (color según tipo de obra):** trabajos lineales aprobados.
   * **Línea punteada naranja:** trabajos lineales programados, en ejecución o por aprobar.
   * **Círculos:** obras puntuales (alcantarillas, bacheo, etc.).
   * **Al hacer clic:** muestra obra, equipo/maquinaria asignada y longitud trabajada neta o planificada.
5. **Trazas individuales aprobadas** *(apagada por defecto)*:
   * Muestra con línea verde las trazas individuales ya aprobadas que alimentaron la Red Consolidada.

---

## 3. Filtro Avanzado: Zonas Bajas / Relieve (MDE)

* **Estado inicial:** Apagado por defecto.
* **Qué muestra en el mapa:** Resalta en **color celeste neón (con borde oscuro)** los subtramos de caminos consolidados donde el análisis altimétrico detectó una **depresión o cubeta relativa** propensa a acumular agua.
* **Cómo funciona por dentro (Copernicus DEM 90 m):**
  * Para cada tramo consolidado, toma muestras de elevación cada ~90 metros (hasta 250 muestras por tramo, cubriendo más de 22 km sin perder detalle) consultando el modelo digital de elevación **Copernicus DEM GLO-90**.
  * Utiliza un **detector de depresiones cóncavas bilaterales**: evalúa si un sector del camino está más bajo que **ambos** bordes (hacia atrás y hacia adelante, tomando la cota de desborde `min(máximo izquierdo, máximo derecho)`), aplicando suavizado para filtrar ruido puntual del satélite y exigiendo al menos 2 muestras contiguas (~180 m) con profundidad `>= 0,55 m` suavizada (`>= 0,65 m` cruda y pico `>= 0,70 m`).
  * **Ventaja clave:** Una pendiente suave y continua (donde el terreno baja hacia un canal o arroyo y el agua escurre) **no** se marca como zona baja; solo se marcan los bajos cerrados o cubetas donde el agua tiende a estancarse.
* **Controles e interacción:**
  * Si existen tramos consolidados sin analizar en la zona visible, aparece el botón azul **`Calcular Zonas Bajas (N tramo/s nuevos)`** para procesarlos bajo demanda y guardarlos en la base.
  * Si hay más de 300 zonas bajas en la ventana visible, muestra un aviso para acercar el zoom.
  * **Al hacer clic en una línea celeste:** se abre abajo un panel con el **Perfil Longitudinal de Elevación** (gráfico cota vs. distancia en metros, cota mínima/máxima s.n.m., desnivel y puntos azules marcando el bajo).
* **Limitación importante:** Es un **indicio macro** a escala de 90 metros para priorizar inspecciones. No reemplaza un relevamiento topográfico ni detecta pozos chicos o alcantarillas tapadas de pocos metros.

---

## 4. Filtro Avanzado: Imagen Satelital Reciente / Agua Detectada (NASA GIBS)

* **Estado inicial:** Apagado por defecto (no consume datos ni hace pedidos hasta que el administrador tilda la casilla).
* **Nombre dinámico en el panel:**
  * Muestra **`Imagen satelital reciente (contexto de agua)`** cuando se usan satélites de reflectancia continua (`MODIS 7-2-1` o `HLS Color Real`).
  * Muestra **`Agua detectada por satélite (indicio)`** cuando se usan los productos de clasificación de agua (`OPERA Radar S1` u `OPERA Óptico HLS`).
* **Controles del panel:**
  * **Sensor / Producto NASA GIBS:** Permite elegir entre los 4 productos detallados abajo (al cambiar de producto, la opacidad se ajusta automáticamente al valor recomendado).
  * **Fecha UTC de observación:**
    * Al activarlo, sondea automáticamente los últimos 15 días en horario UTC sobre el Partido de Carlos Tejedor (`Buscando pasadas...`), guarda las fechas con cobertura en caché del navegador (`sessionStorage`) y selecciona la **última fecha con datos observados**.
    * Con **`◀ Ant.`** y **`Sig. ▶`** se salta directamente entre las fechas que tuvieron pasada real.
    * Con el selector de calendario se puede elegir manualmente cualquier fecha pasada (útil para comparar antes/después de una lluvia o coincidir con la fecha de un reclamo).
  * **Opacidad (`20%` a `95%`):** Ajusta en vivo la transparencia de la capa satelital sin volver a descargar imágenes ni parpadear, permitiendo ver el mapa base nítido por debajo.

### Detalle de los 4 Satélites / Productos Disponibles

| Producto en el selector | Resolución | Frecuencia | Qué muestra y cómo leer los colores | Cuándo usarlo y limitaciones |
| :--- | :---: | :---: | :--- | :--- |
| **1. MODIS Infrarrojo 7-2-1** *(seleccionado por defecto)* | **250 m/píxel** | **Diaria** (todos los días, sin cortes ni errores 500) | Imagen continua en falso color: **azul oscuro / negro** = agua abierta, lagunas y suelos muy anegados; **verde brillante** = vegetación/cultivos; **marrón/naranja** = suelo arado o rastrojo; **celeste/turquesa** = nubes. | Ideal como **mapa de contexto regional** de todo el partido para ver lagunas crecidas y grandes bajos inundados tras lluvias fuertes. **Limitación:** a 250 m por píxel no permite ver agua sobre un camino rural puntual de 6–10 m, y un suelo muy mojado también se ve oscuro. |
| **2. Foto Satelital Reciente Color Real (HLS Sentinel-2)** | **30 m/píxel** | Cada **2 a 5 días** (según órbita) | Foto satelital reciente en colores reales (sin velo blanco en tierra seca): **azul oscuro / negro** = lagunas y espejos de agua; **blanco brillante** = nubes. | Ideal para **verificar visualmente** cómo está una zona del partido en un día despejado reciente y chequear si había nubes ese día. **Limitación:** si ese día estuvo nublado, las nubes tapan el suelo; por su escala de 30 m sirve para anegamientos medianos/grandes, no para huellas finas de 6 m. |
| **3. Radar Sentinel-1 (OPERA DSWx-S1)** | **30 m/píxel** | Cada **2 a 6 días** (compuesto diario UTC) | Clasificación oficial de agua superficial por radar SAR (atraviesa nubes): **azul** = agua abierta; **verde** = vegetación inundada; **blanco opaco** = suelo seco observado; **gris** = máscara de relieve (HAND) o sombra radar. | Útil cuando el cielo estuvo **nublado varios días seguidos** y los satélites ópticos no ven el suelo. **Limitaciones:** NASA GIBS pinta el suelo seco de **blanco opaco** (por eso arranca al 45% de opacidad) con rayado de franja radar, puede fallar ocasionalmente en zoom 11–12 con HTTP 500 desde el servidor de la NASA, y el viento fuerte o vegetación muy densa pueden atenuar la detección. |
| **4. Óptico Landsat + Sentinel-2 (OPERA DSWx-HLS)** | **30 m/píxel** | Cada **2 a 5 días** | Clasificación automática óptica de agua: **azul** = agua abierta; **celeste** = agua superficial parcial; **blanco opaco** = suelo seco observado; **gris** = nube (sin dato óptico). | Útil en **días despejados** para resaltar automáticamente espejos de agua y distinguir claramente suelo seco de zonas tapadas por nubes (gris). **Limitaciones:** también pinta suelo seco en blanco opaco (opacidad inicial 45%) y en días nublados o con errores puntuales de tile en NASA GIBS puede mostrar zonas grises o incompletas. |

> **Regla práctica de interpretación:** Ningún satélite gratuito de 30 m o 250 m afirma por sí solo si una calzada puntual de 6–10 metros está cortada. Estas capas funcionan como **contexto e indicio macro** para cruzar contra los **reclamos con foto georreferenciada**, los **recorridos GPS** y la capa de **Zonas Bajas (MDE)**.
