// Generado automáticamente por scripts/generate-urban-polygons.mjs
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

export const CARLOS_TEJEDOR_URBAN_GLOBAL_BBOX: [number, number, number, number] = [-62.78292,-35.64497,-62.18754,-35.18804];

export const CARLOS_TEJEDOR_URBAN_LOCALITIES: UrbanLocalityPolygon[] = [{"name":"Curarú","bbox":[-62.20045,-35.64497,-62.18754,-35.63596],"coordinates":[[[[-62.19275,-35.64422],[-62.18798,-35.64039],[-62.18754,-35.63962],[-62.19661,-35.63596],[-62.19709,-35.63668],[-62.20045,-35.63942],[-62.19369,-35.64497],[-62.19275,-35.64422]]]]},{"name":"Colonia Seré","bbox":[-62.73548,-35.44528,-62.72045,-35.43406],"coordinates":[[[[-62.72179,-35.4366],[-62.72245,-35.43406],[-62.73251,-35.43589],[-62.73193,-35.43819],[-62.73548,-35.43891],[-62.73475,-35.4415],[-62.73124,-35.44093],[-62.73009,-35.44528],[-62.72527,-35.44442],[-62.72586,-35.44224],[-62.72045,-35.44124],[-62.72179,-35.4366]]]]},{"name":"Tres Algarrobos","bbox":[-62.78292,-35.20621,-62.76156,-35.18804],"coordinates":[[[[-62.76777,-35.19488],[-62.77286,-35.1906],[-62.77132,-35.18938],[-62.7728,-35.18804],[-62.78292,-35.19634],[-62.77868,-35.19974],[-62.77968,-35.20055],[-62.77625,-35.20342],[-62.77531,-35.20266],[-62.77155,-35.20582],[-62.77065,-35.205],[-62.7705,-35.20512],[-62.76901,-35.20621],[-62.76156,-35.20005],[-62.76777,-35.19488]]]]},{"name":"Timote","bbox":[-62.23422,-35.35567,-62.21573,-35.33994],"coordinates":[[[[-62.22008,-35.34393],[-62.22483,-35.33994],[-62.23208,-35.34578],[-62.23025,-35.3473],[-62.23422,-35.35051],[-62.22804,-35.35567],[-62.22404,-35.35245],[-62.22323,-35.35173],[-62.21573,-35.34577],[-62.21745,-35.34438],[-62.21856,-35.34523],[-62.22008,-35.34393]]]]},{"name":"Carlos Tejedor","bbox":[-62.4466,-35.40653,-62.4102,-35.38379],"coordinates":[[[[-62.41535,-35.38753],[-62.41642,-35.38379],[-62.42693,-35.38578],[-62.42585,-35.38943],[-62.43122,-35.39041],[-62.43099,-35.39035],[-62.43143,-35.39042],[-62.43071,-35.39311],[-62.4349,-35.39865],[-62.43481,-35.39877],[-62.4466,-35.40077],[-62.4466,-35.40131],[-62.43475,-35.39933],[-62.43265,-35.40578],[-62.42966,-35.40225],[-62.42843,-35.40206],[-62.42695,-35.40653],[-62.42178,-35.40549],[-62.42307,-35.40098],[-62.42242,-35.40088],[-62.42264,-35.40097],[-62.41773,-35.40019],[-62.41794,-35.39802],[-62.41271,-35.39718],[-62.41403,-35.39232],[-62.4102,-35.39164],[-62.41071,-35.38995],[-62.41077,-35.38972],[-62.41096,-35.38975],[-62.41082,-35.38962],[-62.41146,-35.38713],[-62.41155,-35.38682],[-62.41535,-35.38753]]]]}];

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
