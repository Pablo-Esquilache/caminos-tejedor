import { supabase } from './supabase';

export interface ElevationSamplePoint {
  dist_m: number;
  lat: number;
  lon: number;
}

export interface ElevationProfilePoint extends ElevationSamplePoint {
  elev_m: number;
  is_low_zone: boolean;
}

export interface LowZoneMapItem {
  segment_id: string;
  road_id: string;
  road_name: string;
  road_class: string;
  length_m: number;
  min_elevation_m: number;
  max_elevation_m: number;
  avg_elevation_m: number;
  has_low_zone: boolean;
  low_zone_length_m?: number;
  low_zones_geojson: GeoJSON.MultiLineString | GeoJSON.LineString;
  profile_points: ElevationProfilePoint[];
  dem_source: string;
}

/**
 * Consulta elevaciones en Copernicus DEM 30m vía Open-Meteo Elevation API (gratuita, sin API key).
 * Agrupa de a 90 coordenadas por request para minimizar llamadas de red.
 */
export async function fetchDemElevationsBatch(
  points: Array<{ lat: number; lon: number }>
): Promise<number[]> {
  if (points.length === 0) return [];
  const results: number[] = [];
  const CHUNK_SIZE = 90;

  for (let i = 0; i < points.length; i += CHUNK_SIZE) {
    const chunk = points.slice(i, i + CHUNK_SIZE);
    const lats = chunk.map((p) => p.lat.toFixed(6)).join(',');
    const lons = chunk.map((p) => p.lon.toFixed(6)).join(',');
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Error consultando MDE (${res.status})`);
    }
    const json = (await res.json()) as { elevation?: number[] };
    if (!Array.isArray(json.elevation) || json.elevation.length !== chunk.length) {
      throw new Error('Respuesta inesperada del servicio de elevación MDE');
    }
    for (const val of json.elevation) {
      results.push(Number(Number(val).toFixed(2)));
    }
  }

  return results;
}

/**
 * Analiza un perfil longitudinal en llanura pampeana para detectar bajos locales / zonas anegables.
 * Compara cada punto contra su entorno local (~±270m) y el relieve general del tramo.
 */
export function analyzeSegmentElevation(
  samplePoints: ElevationSamplePoint[],
  elevations: number[]
): {
  profilePoints: ElevationProfilePoint[];
  lowZonesGeojson: { type: 'MultiLineString'; coordinates: number[][][] } | null;
  minElev: number;
  maxElev: number;
  avgElev: number;
  hasLowZone: boolean;
} {
  if (samplePoints.length === 0 || samplePoints.length !== elevations.length) {
    return {
      profilePoints: [],
      lowZonesGeojson: null,
      minElev: 0,
      maxElev: 0,
      avgElev: 0,
      hasLowZone: false,
    };
  }

  let minElev = Infinity;
  let maxElev = -Infinity;
  let sum = 0;
  for (const e of elevations) {
    if (e < minElev) minElev = e;
    if (e > maxElev) maxElev = e;
    sum += e;
  }
  const avgElev = Number((sum / elevations.length).toFixed(2));
  const totalRelief = maxElev - minElev;

  const WINDOW_RADIUS = 6; // ±6 muestras (~270 m a cada lado)
  const profilePoints: ElevationProfilePoint[] = samplePoints.map((pt, idx) => {
    const elev = elevations[idx];
    const start = Math.max(0, idx - WINDOW_RADIUS);
    const end = Math.min(elevations.length - 1, idx + WINDOW_RADIUS);
    let localMax = -Infinity;
    for (let j = start; j <= end; j++) {
      if (elevations[j] > localMax) localMax = elevations[j];
    }

    const localDrop = localMax - elev;
    const globalDrop = maxElev - elev;
    const isLow =
      localDrop >= 0.45 ||
      (totalRelief >= 0.8 && globalDrop >= 0.6 && elev <= avgElev - 0.25);

    return {
      dist_m: pt.dist_m,
      lat: pt.lat,
      lon: pt.lon,
      elev_m: elev,
      is_low_zone: isLow,
    };
  });

  // Extraer sub-tramos contiguos marcados como zona baja
  const lines: number[][][] = [];
  let i = 0;
  while (i < profilePoints.length) {
    if (!profilePoints[i].is_low_zone) {
      i++;
      continue;
    }
    const runStart = Math.max(0, i - 1);
    let j = i;
    while (j + 1 < profilePoints.length && profilePoints[j + 1].is_low_zone) {
      j++;
    }
    const runEnd = Math.min(profilePoints.length - 1, j + 1);
    if (runEnd > runStart) {
      const coords = profilePoints
        .slice(runStart, runEnd + 1)
        .map((p) => [p.lon, p.lat]);
      if (coords.length >= 2) {
        lines.push(coords);
      }
    }
    i = j + 1;
  }

  const hasLowZone = lines.length > 0;
  return {
    profilePoints,
    lowZonesGeojson: hasLowZone ? { type: 'MultiLineString', coordinates: lines } : null,
    minElev: Number(minElev.toFixed(2)),
    maxElev: Number(maxElev.toFixed(2)),
    avgElev,
    hasLowZone,
  };
}

interface PendingSegmentRow {
  segment_id: string;
  road_id: string;
  road_name: string;
  length_m: number;
  sample_points: ElevationSamplePoint[];
}

/**
 * Procesa hasta `maxBatches` lotes de tramos consolidados sin perfil MDE y los guarda en Supabase.
 */
export async function syncPendingRoadElevations(
  onProgress?: (processed: number) => void,
  maxBatches = 10
): Promise<{ processed: number; remaining: boolean }> {
  let processed = 0;

  for (let batch = 0; batch < maxBatches; batch++) {
    const { data, error } = await supabase.rpc('admin_get_segments_needing_elevation', {
      p_limit: 15,
    });
    if (error) {
      throw new Error(error.message || 'No se pudieron obtener tramos para analizar.');
    }
    const rows = (Array.isArray(data) ? data : []) as PendingSegmentRow[];
    if (rows.length === 0) {
      return { processed, remaining: false };
    }

    const allPoints: Array<{ lat: number; lon: number }> = [];
    const slices: Array<{ row: PendingSegmentRow; startIdx: number; count: number }> = [];
    for (const row of rows) {
      const pts = Array.isArray(row.sample_points) ? row.sample_points : [];
      if (pts.length < 2) continue;
      slices.push({ row, startIdx: allPoints.length, count: pts.length });
      for (const p of pts) {
        allPoints.push({ lat: p.lat, lon: p.lon });
      }
    }

    if (allPoints.length === 0) {
      return { processed, remaining: false };
    }

    const elevations = await fetchDemElevationsBatch(allPoints);

    for (const s of slices) {
      const segElevs = elevations.slice(s.startIdx, s.startIdx + s.count);
      const analyzed = analyzeSegmentElevation(s.row.sample_points, segElevs);

      const { error: saveErr } = await supabase.rpc('admin_save_segment_elevation', {
        p_segment_id: s.row.segment_id,
        p_profile_points: analyzed.profilePoints,
        p_low_zones_geojson: analyzed.lowZonesGeojson,
        p_min_elev: analyzed.minElev,
        p_max_elev: analyzed.maxElev,
        p_avg_elev: analyzed.avgElev,
        p_has_low_zone: analyzed.hasLowZone,
        p_dem_source: 'copernicus-dem-30m',
      });
      if (saveErr) {
        throw new Error(saveErr.message || 'Error guardando perfil altimétrico.');
      }
      processed++;
      onProgress?.(processed);
    }
  }

  return { processed, remaining: true };
}
