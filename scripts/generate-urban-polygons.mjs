import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GEOJSON_SRC = path.join(ROOT, 'packages/shared/src/urbanas-tejedor.geojson');
const OUT_FILE = path.join(ROOT, 'packages/shared/src/urbanBoundary.ts');

const TARGETS = ['Carlos Tejedor', 'Tres Algarrobos', 'Timote', 'Colonia Seré', 'Curarú'];

function segIntersects(a, b, c, d) {
  const ccw = (p1, p2, p3) =>
    (p3[1] - p1[1]) * (p2[0] - p1[0]) > (p2[1] - p1[1]) * (p3[0] - p1[0]);
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

function countSelfIntersections(ring) {
  const n = ring.length - 1;
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segIntersects(ring[i], ring[i + 1], ring[j], ring[j + 1])) {
        count++;
      }
    }
  }
  return count;
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

function main() {
  const geo = JSON.parse(fs.readFileSync(GEOJSON_SRC, 'utf8'));
  const localities = [];

  for (const f of geo.features || []) {
    const name = f.properties?.name || f.properties?.fna || f.properties?.nam;
    if (!TARGETS.includes(name)) continue;

    const coords =
      f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];

    for (const poly of coords) {
      for (const ring of poly) {
        if (ring.length < 4) {
          throw new Error(`Invalid ring with <4 vertices in ${name}`);
        }
        const crossings = countSelfIntersections(ring);
        if (crossings > 0) {
          throw new Error(`Self-intersection detected (${crossings}) in ${name}`);
        }
      }
    }

    const bbox = bboxOfMultiPolygon(coords);
    const totalPts = coords.reduce((acc, p) => acc + p.reduce((s, r) => s + r.length, 0), 0);
    console.log(`- ${name}: ${coords.length} polygon(s), ${totalPts} vertices, 0 self-intersections, bbox=${JSON.stringify(bbox)}`);

    localities.push({
      name,
      bbox,
      coordinates: coords,
    });
  }

  if (localities.length !== TARGETS.length) {
    throw new Error(`Expected ${TARGETS.length} localities, got ${localities.length}`);
  }

  const globalBbox = [
    Math.min(...localities.map((l) => l.bbox[0])),
    Math.min(...localities.map((l) => l.bbox[1])),
    Math.max(...localities.map((l) => l.bbox[2])),
    Math.max(...localities.map((l) => l.bbox[3])),
  ];

  const tsContent = `// Generado automáticamente por scripts/generate-urban-polygons.mjs
// Fuente de verdad: packages/shared/src/urbanas-tejedor.geojson (base IGN WFS ign:areas_de_asentamientos_y_edificios_020105 + ajuste satelital + corredor acceso oeste 60 m)
// Precisión: 5 decimales | 0 autointersecciones

export interface UrbanLocalityPolygon {
  name: string;
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  coordinates: number[][][][]; // MultiPolygon GeoJSON [polygon][ring][point][lon, lat]
}

export const IGN_URBAN_METADATA = {
  source: 'Instituto Geográfico Nacional (IGN) + ajuste satelital municipal',
  layer: 'ign:areas_de_asentamientos_y_edificios_020105',
  fetchedAt: '2026-11-20',
  westAccessCorridorWidthMeters: 60,
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
    if (!isPointInRing(lon, lat, polygon[0])) continue;
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

main();
