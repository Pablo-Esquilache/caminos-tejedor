// Generado automáticamente por scripts/generate-urban-polygons.mjs
// Fuente: Instituto Geográfico Nacional (IGN) — WFS capa ign:areas_de_asentamientos_y_edificios_020105
// Fecha de consulta: 2026-11-20
// Recorte aplicado: buffer negativo de 28 m | Simplificación: 4.5 m | Precisión: 5 decimales

export interface UrbanLocalityPolygon {
  name: string;
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  coordinates: number[][][][]; // MultiPolygon GeoJSON [polygon][ring][point][lon, lat]
}

export const IGN_URBAN_METADATA = {
  source: 'Instituto Geográfico Nacional (IGN)',
  layer: 'ign:areas_de_asentamientos_y_edificios_020105',
  fetchedAt: '2026-11-20',
  negativeBufferMeters: 28,
  simplifyToleranceMeters: 4.5,
} as const;

export const CARLOS_TEJEDOR_URBAN_GLOBAL_BBOX: [number, number, number, number] = [-62.78292,-35.64497,-62.18754,-35.18804];

export const CARLOS_TEJEDOR_URBAN_LOCALITIES: UrbanLocalityPolygon[] = [{"name":"Curarú","bbox":[-62.20045,-35.64497,-62.18754,-35.63596],"coordinates":[[[[-62.19275,-35.64422],[-62.18798,-35.64039],[-62.18754,-35.63962],[-62.19661,-35.63596],[-62.19709,-35.63668],[-62.20045,-35.63942],[-62.19369,-35.64497],[-62.19275,-35.64422]]]]},{"name":"Colonia Seré","bbox":[-62.73548,-35.44528,-62.72045,-35.43406],"coordinates":[[[[-62.72179,-35.4366],[-62.72245,-35.43406],[-62.73251,-35.43589],[-62.73193,-35.43819],[-62.73548,-35.43891],[-62.73475,-35.4415],[-62.73124,-35.44093],[-62.73009,-35.44528],[-62.72527,-35.44442],[-62.72586,-35.44224],[-62.72045,-35.44124],[-62.72179,-35.4366]]]]},{"name":"Tres Algarrobos","bbox":[-62.78292,-35.20621,-62.76156,-35.18804],"coordinates":[[[[-62.76777,-35.19488],[-62.77286,-35.1906],[-62.77132,-35.18938],[-62.7728,-35.18804],[-62.78292,-35.19634],[-62.77868,-35.19974],[-62.77968,-35.20055],[-62.77625,-35.20342],[-62.77531,-35.20266],[-62.77155,-35.20582],[-62.77156,-35.20582],[-62.77164,-35.20582],[-62.77065,-35.205],[-62.7705,-35.20512],[-62.7704,-35.20505],[-62.76901,-35.20621],[-62.76156,-35.20005],[-62.76777,-35.19488]]]]},{"name":"Timote","bbox":[-62.23422,-35.35567,-62.21573,-35.33994],"coordinates":[[[[-62.22008,-35.34393],[-62.22483,-35.33994],[-62.23208,-35.34578],[-62.23025,-35.3473],[-62.23422,-35.35051],[-62.22804,-35.35567],[-62.22404,-35.35245],[-62.22404,-35.35245],[-62.2241,-35.35251],[-62.22323,-35.35173],[-62.21573,-35.34577],[-62.21745,-35.34438],[-62.21856,-35.34523],[-62.22008,-35.34393]]]]},{"name":"Carlos Tejedor","bbox":[-62.43116,-35.40653,-62.41096,-35.38407],"coordinates":[[[[-62.41576,-35.38772],[-62.41666,-35.38407],[-62.42663,-35.3859],[-62.42658,-35.38587],[-62.42552,-35.3896],[-62.43116,-35.39065],[-62.43108,-35.39062],[-62.43104,-35.39051],[-62.42961,-35.39569],[-62.42695,-35.40653],[-62.42178,-35.40549],[-62.42307,-35.40098],[-62.42242,-35.40088],[-62.42242,-35.40086],[-62.42264,-35.40097],[-62.41773,-35.40019],[-62.41834,-35.39788],[-62.41309,-35.39692],[-62.41438,-35.39216],[-62.41166,-35.39164],[-62.41212,-35.38996],[-62.41096,-35.38975],[-62.41104,-35.38982],[-62.41103,-35.38985],[-62.4118,-35.38705],[-62.41176,-35.38709],[-62.4117,-35.3871],[-62.41522,-35.38776],[-62.4154,-35.38775],[-62.41576,-35.38772]]]]}];

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
