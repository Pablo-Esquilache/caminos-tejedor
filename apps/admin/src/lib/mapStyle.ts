import type { StyleSpecification } from 'maplibre-gl';
import { maptilerApiKey } from './supabase';

export const mapboxToken = (import.meta.env.VITE_MAPBOX_TOKEN as string) || '';

/**
 * Retorna la especificación de estilo para MapLibre GL en el panel de Administración.
 * Prioriza Mapbox HD (Satellite Streets o Streets v12 con @2x retina).
 * Si no hay token de Mapbox, recurre a MapTiler o a OpenStreetMap / ArcGIS World Imagery libre.
 */
export function getMapStyle(styleType: 'hybrid' | 'streets'): string | StyleSpecification {
  if (mapboxToken) {
    const styleId = styleType === 'hybrid' ? 'satellite-streets-v12' : 'streets-v12';
    return {
      version: 8,
      sources: {
        'mapbox-tiles': {
          type: 'raster',
          tiles: [
            `https://api.mapbox.com/styles/v1/mapbox/${styleId}/tiles/256/{z}/{x}/{y}@2x?access_token=${mapboxToken}`,
          ],
          tileSize: 256,
          attribution: '© Mapbox © OpenStreetMap',
        },
      },
      layers: [
        {
          id: 'mapbox-tiles-layer',
          type: 'raster',
          source: 'mapbox-tiles',
          minzoom: 0,
          maxzoom: 22,
        },
      ],
    };
  }

  if (maptilerApiKey && !maptilerApiKey.includes('PENDIENTE')) {
    const styleName = styleType === 'hybrid' ? 'hybrid' : 'streets-v2';
    return `https://api.maptiler.com/maps/${styleName}/style.json?key=${maptilerApiKey}`;
  }

  // Fallback abierto universal
  const tileUrl =
    styleType === 'hybrid'
      ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
      : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  return {
    version: 8,
    sources: {
      'base-tiles': {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [
      {
        id: 'base-tiles-layer',
        type: 'raster',
        source: 'base-tiles',
        minzoom: 0,
        maxzoom: 19,
      },
    ],
  };
}
