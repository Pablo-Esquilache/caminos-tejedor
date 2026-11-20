import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/pablo/OneDrive/Escritorio/Camino Rurales Carlos Tejedor';
const OUT_FILE = path.join(ROOT, 'packages/shared/src/urbanBoundary.ts');
const IGN_URLS = [
  'https://wms.ign.gob.ar/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=ign:areas_de_asentamientos_y_edificios_020105&outputFormat=application/json&srsName=EPSG:4326&bbox=-62.95,-35.75,-62.10,-35.15,EPSG:4326',
  'https://wms.ign.gob.ar/geoserver/ign/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=ign:areas_de_asentamientos_y_edificios_020105&outputFormat=application/json&srsName=EPSG:4326&bbox=-35.75,-62.95,-35.15,-62.10,urn:ogc:def:crs:EPSG::4326',
];

const TARGETS = ['Carlos Tejedor', 'Tres Algarrobos', 'Timote', 'Colonia Seré', 'Curarú'];
const NEGATIVE_BUFFER_M = 28; // Contradicción/margen interior 25-30 m (coincide con MAX_ACCURACY_M = 22)
const SIMPLIFY_TOLERANCE_M = 4.5; // Tolerancia <= 5 m

function toMeters(lon, lat, refLon, refLat) {
  const mPerDegLat = 110574;
  const mPerDegLon = 111320 * Math.cos((refLat * Math.PI) / 180);
  return [(lon - refLon) * mPerDegLon, (lat - refLat) * mPerDegLat];
}

function toLonLat(x, y, refLon, refLat) {
  const mPerDegLat = 110574;
  const mPerDegLon = 111320 * Math.cos((refLat * Math.PI) / 180);
  return [
    Number((refLon + x / mPerDegLon).toFixed(5)),
    Number((refLat + y / mPerDegLat).toFixed(5)),
  ];
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * Desplaza hacia el interior (buffer negativo) un anillo cerrado en coordenadas métricas (metros).
 * Asegura orientación CCW para anillos exteriores y CW para huecos antes de desplazar.
 */
function offsetRingInward(ringXY, insetMeters, isHole = false) {
  const open = ringXY.slice(0, -1);
  if (open.length < 3) return ringXY;

  // Para anillo exterior: CCW (area > 0) -> interior está a la izquierda de cada arista (-ny, nx)
  // Para hueco (si hubiera): CW (area < 0) -> queremos expandir el hueco hacia el polígono exterior,
  // pero como nuestros ejidos son polígonos simples sin huecos o exteriores CCW, normalizamos:
  const area = signedArea(open);
  const pts = (!isHole && area < 0) || (isHole && area > 0) ? [...open].reverse() : [...open];

  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const pPrev = pts[(i - 1 + n) % n];
    const pCurr = pts[i];
    const pNext = pts[(i + 1) % n];

    const dx1 = pCurr[0] - pPrev[0];
    const dy1 = pCurr[1] - pPrev[1];
    const len1 = Math.hypot(dx1, dy1) || 1;
    const nx1 = -dy1 / len1;
    const ny1 = dx1 / len1;

    const dx2 = pNext[0] - pCurr[0];
    const dy2 = pNext[1] - pCurr[1];
    const len2 = Math.hypot(dx2, dy2) || 1;
    const nx2 = -dy2 / len2;
    const ny2 = dx2 / len2;

    let bx = nx1 + nx2;
    let by = ny1 + ny2;
    const bLen = Math.hypot(bx, by);
    if (bLen < 1e-6) {
      out.push([pCurr[0] + nx1 * insetMeters, pCurr[1] + ny1 * insetMeters]);
    } else {
      bx /= bLen;
      by /= bLen;
      const cosHalf = bx * nx1 + by * ny1;
      const scale = Math.min(2.2, 1 / Math.max(0.45, cosHalf));
      out.push([pCurr[0] + bx * insetMeters * scale, pCurr[1] + by * insetMeters * scale]);
    }
  }
  out.push(out[0]);
  return out;
}

function perpDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function simplifyDP(pts, tol) {
  if (pts.length <= 4) return pts;
  let maxDist = 0;
  let idx = 0;
  const end = pts.length - 1;
  for (let i = 1; i < end; i++) {
    const d = perpDist(pts[i], pts[0], pts[end]);
    if (d > maxDist) {
      maxDist = d;
      idx = i;
    }
  }
  if (maxDist > tol) {
    const left = simplifyDP(pts.slice(0, idx + 1), tol);
    const right = simplifyDP(pts.slice(idx), tol);
    return [...left.slice(0, -1), ...right];
  }
  return [pts[0], pts[end]];
}

function bboxOfMultiPolygon(mpCoords) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const poly of mpCoords) {
    for (const ring of poly) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return [
    Number(minLon.toFixed(5)),
    Number(minLat.toFixed(5)),
    Number(maxLon.toFixed(5)),
    Number(maxLat.toFixed(5)),
  ];
}

async function main() {
  console.log('Fetching IGN WFS urban polygons...');
  let res;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const url = IGN_URLS[(attempt - 1) % IGN_URLS.length];
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (res.ok) break;
      console.warn(`IGN WFS attempt ${attempt} returned HTTP ${res.status}, retrying...`);
    } catch (e) {
      console.warn(`IGN WFS attempt ${attempt} failed (${e.message}), retrying...`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!res || !res.ok) throw new Error(`IGN WFS HTTP ${res?.status}`);
  const geo = await res.json();
  const fetchedAt = new Date().toISOString().slice(0, 10);

  const localities = [];
  for (const f of geo.features || []) {
    const name = f.properties?.fna || f.properties?.nam;
    if (!TARGETS.includes(name)) continue;

    const rawPolys =
      f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];

    const processedPolys = [];
    for (const poly of rawPolys) {
      const processedRings = [];
      for (let rIdx = 0; rIdx < poly.length; rIdx++) {
        const ring = poly[rIdx];
        const refLon = ring[0][0];
        const refLat = ring[0][1];
        const ringXY = ring.map(([lon, lat]) => toMeters(lon, lat, refLon, refLat));
        const insetXY = offsetRingInward(ringXY, NEGATIVE_BUFFER_M, rIdx > 0);
        const simpXY = simplifyDP(insetXY, SIMPLIFY_TOLERANCE_M);
        if (simpXY.length < 4 || Math.abs(signedArea(simpXY.slice(0, -1))) < 1000) {
          throw new Error(`Polygon collapsed or empty for ${name} (ring ${rIdx})`);
        }
        const lonLatRing = simpXY.map(([x, y]) => toLonLat(x, y, refLon, refLat));
        lonLatRing[lonLatRing.length - 1] = lonLatRing[0];
        processedRings.push(lonLatRing);
      }
      processedPolys.push(processedRings);
    }

    const bbox = bboxOfMultiPolygon(processedPolys);
    const totalPts = processedPolys.reduce((acc, p) => acc + p.reduce((s, r) => s + r.length, 0), 0);
    console.log(`- ${name}: ${processedPolys.length} polygon(s), ${totalPts} vertices, bbox=${JSON.stringify(bbox)}`);

    localities.push({
      name,
      bbox,
      coordinates: processedPolys,
    });
  }

  if (localities.length !== TARGETS.length) {
    throw new Error(`Expected ${TARGETS.length} localities, got ${localities.length}`);
  }

  // Global bbox
  const globalBbox = [
    Math.min(...localities.map((l) => l.bbox[0])),
    Math.min(...localities.map((l) => l.bbox[1])),
    Math.max(...localities.map((l) => l.bbox[2])),
    Math.max(...localities.map((l) => l.bbox[3])),
  ];

  const tsContent = `// Generado automáticamente por scripts/generate-urban-polygons.mjs
// Fuente: Instituto Geográfico Nacional (IGN) — WFS capa ign:areas_de_asentamientos_y_edificios_020105
// Fecha de consulta: ${fetchedAt}
// Recorte aplicado: buffer negativo de ${NEGATIVE_BUFFER_M} m | Simplificación: ${SIMPLIFY_TOLERANCE_M} m | Precisión: 5 decimales

export interface UrbanLocalityPolygon {
  name: string;
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  coordinates: number[][][][]; // MultiPolygon GeoJSON [polygon][ring][point][lon, lat]
}

export const IGN_URBAN_METADATA = {
  source: 'Instituto Geográfico Nacional (IGN)',
  layer: 'ign:areas_de_asentamientos_y_edificios_020105',
  fetchedAt: '${fetchedAt}',
  negativeBufferMeters: ${NEGATIVE_BUFFER_M},
  simplifyToleranceMeters: ${SIMPLIFY_TOLERANCE_M},
} as const;

export const CARLOS_TEJEDOR_URBAN_GLOBAL_BBOX: [number, number, number, number] = ${JSON.stringify(globalBbox)};

export const CARLOS_TEJEDOR_URBAN_LOCALITIES: UrbanLocalityPolygon[] = ${JSON.stringify(localities)};

function isPointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function isPointInMultiPolygon(lon: number, lat: number, multiPolygonCoords: number[][][][]): boolean {
  for (const polygon of multiPolygonCoords) {
    if (polygon.length === 0) continue;
    // Anillo exterior
    if (!isPointInRing(lon, lat, polygon[0])) continue;
    // Si cae dentro de algún hueco interior, NO está dentro del polígono
    let inHole = false;
    for (let r = 1; r < polygon.length; r++) {
      if (isPointInRing(lon, lat, polygon[r])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/**
 * Devuelve true si (lat, lon) cae dentro de cualquiera de los 5 ejidos urbanos del Partido de Carlos Tejedor.
 * Orden: bounding box global -> bounding box por localidad -> ray-casting MultiPolygon con soporte de huecos.
 */
export function isPointInsideUrbanArea(lat: number, lon: number): boolean {
  const [gMinLon, gMinLat, gMaxLon, gMaxLat] = CARLOS_TEJEDOR_URBAN_GLOBAL_BBOX;
  if (lon < gMinLon || lon > gMaxLon || lat < gMinLat || lat > gMaxLat) {
    return false;
  }
  for (const loc of CARLOS_TEJEDOR_URBAN_LOCALITIES) {
    const [minLon, minLat, maxLon, maxLat] = loc.bbox;
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) {
      continue;
    }
    if (isPointInMultiPolygon(lon, lat, loc.coordinates)) {
      return true;
    }
  }
  return false;
}
`;

  fs.writeFileSync(OUT_FILE, tsContent, 'utf8');
  console.log(`Generated ${OUT_FILE} (${(Buffer.byteLength(tsContent) / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
