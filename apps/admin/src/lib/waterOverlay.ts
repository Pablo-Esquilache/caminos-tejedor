import type maplibregl from 'maplibre-gl';

export type WaterOverlayProduct = 'modis_721' | 'hls_truecolor' | 'opera_s1' | 'opera_hls';

export interface WaterOverlayProductConfig {
  id: WaterOverlayProduct;
  gibsLayerId: string;
  label: string;
  shortLabel: string;
  resolution: string;
  tileMatrixSet: string;
  maxZoom: number;
  formatExt: 'png' | 'jpg';
  defaultOpacity: number;
  description: string;
  legendItems: Array<{ color: string; border?: string; label: string }>;
}

export const WATER_OVERLAY_SOURCE_ID = 'nasa-gibs-water-source';
export const WATER_OVERLAY_LAYER_ID = 'nasa-gibs-water-layer';
export const WATER_OVERLAY_ATTRIBUTION =
  'NASA GIBS / OPERA DSWx (JPL) · MODIS · contiene datos modificados de Copernicus Sentinel';

export const WATER_OVERLAY_PRODUCTS: Record<WaterOverlayProduct, WaterOverlayProductConfig> = {
  modis_721: {
    id: 'modis_721',
    gibsLayerId: 'MODIS_Terra_CorrectedReflectance_Bands721',
    label: 'MODIS Infrarrojo 7-2-1 (Diario · sin franjas ni cortes)',
    shortLabel: 'MODIS 7-2-1 (Diario)',
    resolution: '250 m/píxel',
    tileMatrixSet: 'GoogleMapsCompatible_Level9',
    maxZoom: 9,
    formatExt: 'jpg',
    defaultOpacity: 0.75,
    description:
      'Imagen diaria continua NASA MODIS (bandas 7-2-1). Resalta espejos de agua y suelos muy anegados en azul oscuro/negro y vegetación en verde brillante, sin rectángulos blancos.',
    legendItems: [
      { color: '#0f172a', label: 'Agua / lagunas / zonas anegadas' },
      { color: '#22c55e', label: 'Vegetación / cultivos' },
      { color: '#d97706', label: 'Suelo desnudo / rastrojo' },
      { color: '#38bdf8', label: 'Nubes (celeste/turquesa)' },
    ],
  },
  hls_truecolor: {
    id: 'hls_truecolor',
    gibsLayerId: 'HLS_S30_Nadir_BRDF_Adjusted_Reflectance',
    label: 'Foto Satelital Reciente Color Real (HLS Sentinel-2 · 30m)',
    shortLabel: 'Color Real S2 (30m)',
    resolution: '30 m/píxel',
    tileMatrixSet: 'GoogleMapsCompatible_Level12',
    maxZoom: 12,
    formatExt: 'png',
    defaultOpacity: 0.85,
    description:
      'Reflectancia corregida en color real (Sentinel-2 armonizado). Permite verificar visualmente nubes y lagunas sin velo blanco.',
    legendItems: [
      { color: '#1e3a8a', label: 'Agua / lagunas (azul oscuro/negro)' },
      { color: '#f8fafc', border: '#94a3b8', label: 'Nubes (blanco brillante)' },
    ],
  },
  opera_s1: {
    id: 'opera_s1',
    gibsLayerId: 'OPERA_L3_Dynamic_Surface_Water_Extent-Sentinel-1',
    label: 'Radar Sentinel-1 (OPERA DSWx-S1 · 30m · franjas)',
    shortLabel: 'Radar Sentinel-1 (30m)',
    resolution: '30 m/píxel',
    tileMatrixSet: 'GoogleMapsCompatible_Level12',
    maxZoom: 12,
    formatExt: 'png',
    defaultOpacity: 0.45,
    description:
      'Compuesto diario UTC de radar SAR (OPERA DSWx-S1). Nota: NASA GIBS pinta la tierra seca de blanco opaco y puede tener rayado de franja o demoras en zoom alto.',
    legendItems: [
      { color: '#0000ff', label: 'Agua abierta' },
      { color: '#00ff00', border: '#15803d', label: 'Vegetación inundada' },
      { color: '#ffffff', border: '#94a3b8', label: 'Suelo sin agua (blanco opaco)' },
      { color: '#c8c8c8', border: '#64748b', label: 'Máscara HAND / sombra radar' },
    ],
  },
  opera_hls: {
    id: 'opera_hls',
    gibsLayerId: 'OPERA_L3_Dynamic_Surface_Water_Extent-HLS',
    label: 'Óptico Landsat + Sentinel-2 (OPERA DSWx-HLS · 30m)',
    shortLabel: 'Óptico HLS (30m)',
    resolution: '30 m/píxel',
    tileMatrixSet: 'GoogleMapsCompatible_Level12',
    maxZoom: 12,
    formatExt: 'png',
    defaultOpacity: 0.45,
    description:
      'Clasificación óptica de agua superficial (OPERA DSWx-HLS). Pinta suelo seco en blanco opaco y nubes en gris.',
    legendItems: [
      { color: '#0000ff', label: 'Agua abierta' },
      { color: '#b4d5f4', border: '#0284c7', label: 'Agua superficial parcial' },
      { color: '#ffffff', border: '#94a3b8', label: 'Suelo sin agua (blanco opaco)' },
      { color: '#afafaf', border: '#475569', label: 'Nube (sin dato óptico)' },
    ],
  },
};

/**
 * Grilla 2x2 de tiles z=10 en EPSG:3857 que cubre la totalidad del Partido de Carlos Tejedor
 * (lon -62.93° a -62.22°, lat -35.17° a -35.74°).
 */
const TEJEDOR_Z10_TILES: Array<{ z: number; x: number; y: number }> = [
  { z: 10, x: 333, y: 619 },
  { z: 10, x: 334, y: 619 },
  { z: 10, x: 333, y: 620 },
  { z: 10, x: 334, y: 620 },
];

const VECTOR_SOURCE_IDS = new Set([
  'admin-low-zones',
  'interventions-layer',
  'consolidated-roads',
  'admin-claims',
  'admin-trips',
  'single-trip',
  'single-trip-pts',
]);

/**
 * Devuelve la fecha UTC en formato YYYY-MM-DD restando `daysAgo` días.
 */
export function getUtcDateString(daysAgo = 0): string {
  const now = new Date();
  const utcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo);
  return new Date(utcMs).toISOString().slice(0, 10);
}

/**
 * Construye la plantilla de URL WMTS EPSG:3857 de NASA GIBS para una capa y fecha dada.
 */
export function buildGibsTileUrlTemplate(product: WaterOverlayProduct, dateIso: string): string {
  const cfg = WATER_OVERLAY_PRODUCTS[product];
  const cleanDate = /^\d{4}-\d{2}-\d{2}$/.test(dateIso) ? dateIso : getUtcDateString(1);
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${cfg.gibsLayerId}/default/${cleanDate}/${cfg.tileMatrixSet}/{z}/{y}/{x}.${cfg.formatExt}`;
}

function buildProbeTileUrl(
  product: WaterOverlayProduct,
  dateIso: string,
  tile: { z: number; x: number; y: number }
): string {
  const cfg = WATER_OVERLAY_PRODUCTS[product];
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${cfg.gibsLayerId}/default/${dateIso}/${cfg.tileMatrixSet}/${tile.z}/${tile.y}/${tile.x}.${cfg.formatExt}`;
}

/**
 * Sondea los últimos `lookbackDays` días en UTC (máximo 15) sobre la grilla 2x2 de tiles z=10
 * del Partido de Carlos Tejedor para identificar qué fechas tienen datos observados reales
 * (en GIBS, un tile 256x256 totalmente "No Data / transparente" pesa ~334 bytes, mientras que
 * un tile con pasada observada —incluso en día seco donde "Not Water" es blanco— pesa >1.8 KB).
 *
 * Cachea en sessionStorage (dentro de try/catch) y soporta cancelación vía AbortSignal.
 */
export async function probeAvailableDatesForTejedor(
  product: WaterOverlayProduct,
  lookbackDays = 15,
  signal?: AbortSignal
): Promise<string[]> {
  const clampedDays = Math.min(15, Math.max(1, lookbackDays));
  const todayUtc = getUtcDateString(0);
  const cacheKey = `caminos_gibs_dates_v1_${product}_${todayUtc}`;

  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as string[];
      }
    }
  } catch {
    // sessionStorage deshabilitado o lleno
  }

  const candidateDates: string[] = [];
  for (let d = 0; d < clampedDays; d++) {
    candidateDates.push(getUtcDateString(d));
  }

  const datesWithPass: string[] = [];
  const BATCH_SIZE = 5;

  const probeTiles =
    WATER_OVERLAY_PRODUCTS[product].maxZoom < 10
      ? [
          { z: 9, x: 166, y: 309 },
          { z: 9, x: 167, y: 309 },
        ]
      : TEJEDOR_Z10_TILES;

  for (let i = 0; i < candidateDates.length; i += BATCH_SIZE) {
    if (signal?.aborted) break;
    const batch = candidateDates.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (dateIso) => {
        if (signal?.aborted) return null;
        try {
          const tileChecks = await Promise.all(
            probeTiles.map(async (tile) => {
              const res = await fetch(buildProbeTileUrl(product, dateIso, tile), { signal });
              if (!res.ok) return 0;
              const buf = await res.arrayBuffer();
              return buf.byteLength;
            })
          );
          const maxBytes = Math.max(0, ...tileChecks);
          // > 1800 bytes indica píxeles observados en al menos uno de los 4 cuadrantes del Partido
          return maxBytes > 1800 ? dateIso : null;
        } catch {
          return null;
        }
      })
    );
    for (const hit of batchResults) {
      if (hit) datesWithPass.push(hit);
    }
  }

  if (!signal?.aborted && datesWithPass.length > 0) {
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify(datesWithPass));
    } catch {
      // Ignorar errores de cuota en sessionStorage
    }
  }

  return datesWithPass;
}

/**
 * Encuentra el primer layer vectorial municipal en map.getStyle().layers buscando por `source`
 * para insertar la capa raster de agua siempre por debajo de todas las capas vectoriales.
 */
export function findFirstVectorLayerId(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle()?.layers;
  if (!Array.isArray(layers)) return undefined;
  for (const layer of layers) {
    if ('source' in layer && typeof layer.source === 'string' && VECTOR_SOURCE_IDS.has(layer.source)) {
      return layer.id;
    }
  }
  return undefined;
}

/**
 * Crea, actualiza o elimina la capa raster de agua satelital en MapLibre GL.
 */
export function syncWaterOverlayOnMap(
  map: maplibregl.Map,
  options: {
    enabled: boolean;
    product: WaterOverlayProduct;
    dateIso: string;
    opacity: number;
  }
): void {
  if (!map.getStyle()) return;

  if (map.getLayer(WATER_OVERLAY_LAYER_ID)) {
    map.removeLayer(WATER_OVERLAY_LAYER_ID);
  }
  if (map.getSource(WATER_OVERLAY_SOURCE_ID)) {
    map.removeSource(WATER_OVERLAY_SOURCE_ID);
  }

  if (!options.enabled || !options.dateIso) {
    return;
  }

  const cfg = WATER_OVERLAY_PRODUCTS[options.product];
  const tileUrl = buildGibsTileUrlTemplate(options.product, options.dateIso);
  const beforeId = findFirstVectorLayerId(map);

  map.addSource(WATER_OVERLAY_SOURCE_ID, {
    type: 'raster',
    tiles: [tileUrl],
    tileSize: 256,
    minzoom: 0,
    maxzoom: cfg.maxZoom,
    attribution: WATER_OVERLAY_ATTRIBUTION,
  });

  map.addLayer(
    {
      id: WATER_OVERLAY_LAYER_ID,
      type: 'raster',
      source: WATER_OVERLAY_SOURCE_ID,
      paint: {
        'raster-opacity': Math.max(0.1, Math.min(1, options.opacity)),
        'raster-resampling': 'nearest',
      },
    },
    beforeId
  );
}
