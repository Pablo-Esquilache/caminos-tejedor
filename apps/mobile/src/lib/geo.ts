import type { RawGpsPoint } from '@shared';

// Umbral por defecto de precisión GPS en metros (puntos con mayor error se descartan)
export const DEFAULT_MAX_GPS_ACCURACY_M = 35;

/**
 * Calcula la distancia en metros entre dos coordenadas WGS84 usando la fórmula de Haversine.
 */
export function calculateDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Radio terrestre medio en metros
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Formatea metros a texto legible (ej. "420 m" o "12,45 km")
 */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '0 m';
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  const km = (meters / 1000).toFixed(2).replace('.', ',');
  return `${km} km`;
}

/**
 * Formatea segundos a HH:MM:SS o MM:SS
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hrs > 0) {
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

/**
 * Trazas reales de referencia sobre caminos rurales de Carlos Tejedor (con curvas y cruces)
 * para poder probar el grabador punto a punto también desde escritorio o bajo techo.
 */
export const SAMPLE_TEJEDOR_ROUTES: Array<{
  name: string;
  description: string;
  coords: Array<[number, number]>; // [lon, lat]
}> = [
  {
    name: 'Camino Real a Timote (Tramo Norte)',
    description: 'Sale del acceso sur de Carlos Tejedor hacia Timote con curvas suaves',
    coords: [
      [-62.4208, -35.3928],
      [-62.4182, -35.3965],
      [-62.4145, -35.4012],
      [-62.4110, -35.4058],
      [-62.4068, -35.4095],
      [-62.4015, -35.4122],
      [-62.3960, -35.4160],
      [-62.3912, -35.4210],
      [-62.3865, -35.4265],
      [-62.3820, -35.4318],
    ],
  },
  {
    name: 'Camino Vecinal Colonia Seré — Escuela Rural',
    description: 'Tramo con esquina a 90° típica de cuadrícula rural pampeana',
    coords: [
      [-62.4520, -35.4110],
      [-62.4465, -35.4145],
      [-62.4410, -35.4180],
      [-62.4355, -35.4215],
      [-62.4300, -35.4250], // Esquina / cruce
      [-62.4342, -35.4295],
      [-62.4385, -35.4340],
      [-62.4430, -35.4385],
    ],
  },
  {
    name: 'Bajada Ruta 226 hacia Curarú',
    description: 'Camino secundario con curva en S cerca de bajo rural',
    coords: [
      [-62.3610, -35.3710],
      [-62.3555, -35.3740],
      [-62.3502, -35.3778],
      [-62.3468, -35.3825],
      [-62.3455, -35.3875],
      [-62.3415, -35.3910],
      [-62.3360, -35.3945],
    ],
  },
];

export function buildSimulatedPoint(
  lon: number,
  lat: number,
  accuracy = 6
): RawGpsPoint {
  return {
    lat,
    lon,
    timestamp: Date.now(),
    accuracy,
    speed: 11.5,
  };
}
