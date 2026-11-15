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

async function fetchJsonWithRetryAndTimeout<T>(
  url: string,
  timeoutMs = 12000,
  maxAttempts = 3
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        clearTimeout(timer);
        const waitMs = 800 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, waitMs));
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        const httpErr = new Error(`Error consultando MDE (${res.status})`) as Error & { noRetry?: boolean };
        httpErr.noRetry = res.status >= 400 && res.status < 500;
        throw httpErr;
      }
      const data = (await res.json()) as T;
      return data;
    } catch (err: any) {
      lastErr = err;
      if (err?.noRetry) break;
      if (attempt < maxAttempts) {
        const waitMs = 700 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Timeout consultando servicio MDE');
}

/**
 * Consulta elevaciones en Copernicus DEM GLO-90 (90m) vía Open-Meteo Elevation API (gratuita, sin API key).
 * Agrupa de a 90 coordenadas por request con timeout, reintentos ante HTTP 429/5xx y validación numérica.
 */
export async function fetchDemElevationsBatch(
  points: Array<{ lat: number; lon: number }>
): Promise<number[]> {
  if (points.length === 0) return [];
  const results: number[] = [];
  const CHUNK_SIZE = 90;

  for (let i = 0; i < points.length; i += CHUNK_SIZE) {
    const chunk = points.slice(i, i + CHUNK_SIZE);
    const lats = chunk.map((p) => Number(p.lat).toFixed(6)).join(',');
    const lons = chunk.map((p) => Number(p.lon).toFixed(6)).join(',');
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
    const json = await fetchJsonWithRetryAndTimeout<{ elevation?: unknown[] }>(url, 12000, 3);
    if (!Array.isArray(json.elevation) || json.elevation.length !== chunk.length) {
      throw new Error('Respuesta inesperada del servicio de elevación MDE');
    }
    for (const rawVal of json.elevation) {
      const num = Number(rawVal);
      if (!Number.isFinite(num) || num < -50 || num > 500) {
        throw new Error('Valor de elevación MDE inválido o fuera de rango');
      }
      results.push(Number(num.toFixed(2)));
    }
  }

  return results;
}

/**
 * Analiza un perfil longitudinal en llanura pampeana (MDE 90m) para detectar
 * únicamente depresiones cóncavas bilaterales (cubetas / bajos cerrados donde el terreno
 * baja respecto a ambos bordes izquierdo y derecho y vuelve a subir).
 *
 * - Las pendientes monótonas (sin importar el desnivel) dan siempre 0% porque el borde
 *   aguas abajo es más bajo que el punto evaluado (el agua escurre y no se acumula).
 * - Se aplica suavizado de 3 muestras (1-2-1) y se exigen al menos 2 muestras contiguas
 *   (~180 m) con profundidad de cubeta >= 0,55 m (suavizada) y >= 0,65 m (cruda) respecto
 *   a la cota de desborde bilateral min(maxIzq, maxDer), filtrando el ruido puntual del DEM.
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
  const n = samplePoints.length;
  if (n === 0 || n !== elevations.length) {
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
    if (!Number.isFinite(e)) {
      return {
        profilePoints: [],
        lowZonesGeojson: null,
        minElev: 0,
        maxElev: 0,
        avgElev: 0,
        hasLowZone: false,
      };
    }
    if (e < minElev) minElev = e;
    if (e > maxElev) maxElev = e;
    sum += e;
  }
  const avgElev = Number((sum / n).toFixed(2));

  // 1. Suavizado de media móvil ponderada 1-2-1 para suprimir ruido de muestra aislada del DEM
  const smooth: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) {
      smooth[i] = elevations[i];
    } else {
      smooth[i] = 0.25 * elevations[i - 1] + 0.5 * elevations[i] + 0.25 * elevations[i + 1];
    }
  }

  // 2. Evaluar prominencia cóncava bilateral contra ambos hombros (izquierdo y derecho)
  const RIM_RADIUS = Math.min(10, Math.max(4, Math.floor(n / 3))); // ~360 m a 900 m a cada lado
  const candidateLow: boolean[] = new Array(n).fill(false);
  const rawDepths: number[] = new Array(n).fill(0);
  const smoothDepths: number[] = new Array(n).fill(0);

  for (let i = 1; i < n - 1; i++) {
    const leftStart = Math.max(0, i - RIM_RADIUS);
    const rightEnd = Math.min(n - 1, i + RIM_RADIUS);

    let leftSmoothMax = -Infinity;
    let leftRawMax = -Infinity;
    for (let j = leftStart; j < i; j++) {
      if (smooth[j] > leftSmoothMax) leftSmoothMax = smooth[j];
      if (elevations[j] > leftRawMax) leftRawMax = elevations[j];
    }

    let rightSmoothMax = -Infinity;
    let rightRawMax = -Infinity;
    for (let j = i + 1; j <= rightEnd; j++) {
      if (smooth[j] > rightSmoothMax) rightSmoothMax = smooth[j];
      if (elevations[j] > rightRawMax) rightRawMax = elevations[j];
    }

    // Cota de desborde de la cubeta: el menor de los dos bordes que la encierran
    const spilloverSmooth = Math.min(leftSmoothMax, rightSmoothMax);
    const spilloverRaw = Math.min(leftRawMax, rightRawMax);

    const depthSmooth = spilloverSmooth - smooth[i];
    const depthRaw = spilloverRaw - elevations[i];

    smoothDepths[i] = depthSmooth;
    rawDepths[i] = depthRaw;

    if (depthSmooth >= 0.55 && depthRaw >= 0.65) {
      candidateLow[i] = true;
    }
  }

  // 3. Filtrar espigas aisladas: exigir corridas de al menos 2 muestras contiguas (~180 m)
  //    donde la depresión alcance al menos 0,70 m de profundidad cruda (o >= 0,65 m suavizada)
  const confirmedLow: boolean[] = new Array(n).fill(false);
  let idx = 0;
  while (idx < n) {
    if (!candidateLow[idx]) {
      idx++;
      continue;
    }
    let endIdx = idx;
    let peakRaw = rawDepths[idx];
    let peakSmooth = smoothDepths[idx];
    while (endIdx + 1 < n && candidateLow[endIdx + 1]) {
      endIdx++;
      if (rawDepths[endIdx] > peakRaw) peakRaw = rawDepths[endIdx];
      if (smoothDepths[endIdx] > peakSmooth) peakSmooth = smoothDepths[endIdx];
    }
    const runLen = endIdx - idx + 1;
    if (runLen >= 2 && (peakRaw >= 0.70 || peakSmooth >= 0.65)) {
      for (let k = idx; k <= endIdx; k++) {
        confirmedLow[k] = true;
      }
    }
    idx = endIdx + 1;
  }

  const profilePoints: ElevationProfilePoint[] = samplePoints.map((pt, i) => ({
    dist_m: pt.dist_m,
    lat: pt.lat,
    lon: pt.lon,
    elev_m: elevations[i],
    is_low_zone: confirmedLow[i],
  }));

  // 4. Extraer sub-tramos contiguos confirmados como cubeta / zona baja
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
  geom_hash?: string;
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
        p_dem_source: 'copernicus-dem-90m',
        p_expected_geom_hash: s.row.geom_hash || null,
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
