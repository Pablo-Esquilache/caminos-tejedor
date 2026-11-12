import type { RawGpsPoint } from '@shared';

export const DEFAULT_MAX_GPS_ACCURACY_M = 35;

export function calculateDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '0 m';
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  const km = (meters / 1000).toFixed(2).replace('.', ',');
  return `${km} km`;
}

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
 * Calcula el rumbo (bearing) en grados (0° a 360°) entre dos coordenadas geográficas.
 */
export function calculateBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLambda = toRad(lon2 - lon1);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const theta = Math.atan2(y, x);
  return (toDeg(theta) + 360) % 360;
}

/**
 * Calcula la diferencia angular mínima en grados (0° a 180°) entre dos rumbos.
 */
export function angleDifferenceDegrees(b1: number, b2: number): number {
  const diff = Math.abs(b1 - b2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Filtro Anti-Jitter y Anti-Retroceso:
 * Detecta si un punto nuevo es un rebote / ruido de frenada o una inversión artificial de marcha
 * en la misma cuadra producto de multipath GPS en esquinas.
 */
export function isGpsJitterOrReverse(
  points: RawGpsPoint[],
  newPt: RawGpsPoint,
  deltaMeters: number
): boolean {
  if (points.length < 1) return false;

  const speedKmH = newPt.speed != null ? newPt.speed * 3.6 : null;

  // 1. Si el vehículo está detenido o casi quieto (< 3.6 km/h / ~1 m/s) y se movió menos de 4 metros: es ruido estático
  if ((speedKmH != null && speedKmH < 3.6) && deltaMeters < 4) {
    return true;
  }

  // 2. Micro-ruido menor a 2 metros en cualquier circunstancia
  if (deltaMeters < 2 && points.length >= 2) {
    return true;
  }

  // 3. Chequeo de anti-retroceso / rebote en esquinas:
  // Si tenemos puntos previos, comparamos el rumbo del último tramo con el punto nuevo
  const lastPt = points[points.length - 1];
  let anchorPt: RawGpsPoint | null = null;
  for (let i = points.length - 2; i >= 0; i--) {
    const d = calculateDistanceMeters(points[i].lat, points[i].lon, lastPt.lat, lastPt.lon);
    if (d >= 5) {
      anchorPt = points[i];
      break;
    }
  }

  if (anchorPt) {
    const prevBearing = calculateBearing(anchorPt.lat, anchorPt.lon, lastPt.lat, lastPt.lon);
    const newBearing = calculateBearing(lastPt.lat, lastPt.lon, newPt.lat, newPt.lon);
    const angleDiff = angleDifferenceDegrees(prevBearing, newBearing);

    // Si el rumbo cambia bruscamente más de 135° (vuelve hacia atrás sobre la misma cuadra)
    // y la distancia es corta (< 22 metros) con velocidad baja o moderada (< 25 km/h),
    // es un rebote satelital por esquina o frenada
    if (angleDiff > 135 && deltaMeters < 22 && (speedKmH == null || speedKmH < 25)) {
      return true;
    }
  }

  return false;
}

/**
 * Limpieza geométrica al detener la grabación:
 * Desanuda lazos / rulos espurios producidos en esquinas o paradas menores a 20 metros,
 * dejando una traza continua, limpia y fiel sobre el camino.
 */
export function cleanTrackLoopsAndJitter(rawPoints: RawGpsPoint[]): RawGpsPoint[] {
  if (rawPoints.length <= 3) return rawPoints;

  const cleaned: RawGpsPoint[] = [];

  for (let i = 0; i < rawPoints.length; i++) {
    const pt = rawPoints[i];

    if (cleaned.length === 0) {
      cleaned.push(pt);
      continue;
    }

    const prev = cleaned[cleaned.length - 1];
    const distFromPrev = calculateDistanceMeters(prev.lat, prev.lon, pt.lat, pt.lon);

    // Quitar micro-duplicados a menos de 2 metros
    if (distFromPrev < 2) {
      continue;
    }

    // Detección de bucle de rebote ("ida y vuelta en la misma cuadra"):
    // Si este punto regresa muy cerca del punto ante-anterior (< 15m) mientras que el punto
    // anterior se había desviado hacia adelante/costado formando un pico artificial de frenada
    if (cleaned.length >= 2) {
      const antePrev = cleaned[cleaned.length - 2];
      const distAntePrev = calculateDistanceMeters(antePrev.lat, antePrev.lon, pt.lat, pt.lon);
      const spikeDist = calculateDistanceMeters(antePrev.lat, antePrev.lon, prev.lat, prev.lon);

      if (distAntePrev < spikeDist * 0.7 && spikeDist < 25) {
        cleaned.pop(); // Eliminar el punto de pico espurio
      }
    }

    cleaned.push(pt);
  }

  return cleaned.length >= 2 ? cleaned : rawPoints;
}

export const SAMPLE_TEJEDOR_ROUTES: Array<{
  name: string;
  description: string;
  coords: Array<[number, number]>;
}> = [
  {
    "name": "Camino Rural Carlos Tejedor → Timote",
    "description": "Traza real (10,3 km) siguiendo las curvas y esquinas del camino hacia Timote",
    "coords": [
      [
        -62.420924,
        -35.392362
      ],
      [
        -62.420376,
        -35.392259
      ],
      [
        -62.420038,
        -35.393482
      ],
      [
        -62.419691,
        -35.394739
      ],
      [
        -62.419352,
        -35.395967
      ],
      [
        -62.420847,
        -35.396246
      ],
      [
        -62.42155,
        -35.396377
      ],
      [
        -62.422351,
        -35.396526
      ],
      [
        -62.423862,
        -35.396809
      ],
      [
        -62.425114,
        -35.397042
      ],
      [
        -62.426402,
        -35.397283
      ],
      [
        -62.427292,
        -35.397449
      ],
      [
        -62.427649,
        -35.397516
      ],
      [
        -62.428556,
        -35.397685
      ],
      [
        -62.429304,
        -35.397825
      ],
      [
        -62.430586,
        -35.398067
      ],
      [
        -62.431867,
        -35.398309
      ],
      [
        -62.433149,
        -35.398552
      ],
      [
        -62.434431,
        -35.398794
      ],
      [
        -62.434593,
        -35.398822
      ],
      [
        -62.434677,
        -35.398814
      ],
      [
        -62.434673,
        -35.398764
      ],
      [
        -62.434686,
        -35.398714
      ],
      [
        -62.434718,
        -35.398665
      ],
      [
        -62.434767,
        -35.398626
      ],
      [
        -62.434827,
        -35.3986
      ],
      [
        -62.434894,
        -35.39859
      ],
      [
        -62.434962,
        -35.398596
      ],
      [
        -62.435017,
        -35.39862
      ],
      [
        -62.435078,
        -35.398656
      ],
      [
        -62.435098,
        -35.398668
      ],
      [
        -62.435288,
        -35.398776
      ],
      [
        -62.435597,
        -35.398904
      ],
      [
        -62.436012,
        -35.39904
      ],
      [
        -62.436612,
        -35.399158
      ],
      [
        -62.436725,
        -35.399179
      ],
      [
        -62.438104,
        -35.399438
      ],
      [
        -62.439484,
        -35.399698
      ],
      [
        -62.440863,
        -35.399957
      ],
      [
        -62.44245,
        -35.400247
      ],
      [
        -62.444037,
        -35.400537
      ],
      [
        -62.445751,
        -35.400843
      ],
      [
        -62.446024,
        -35.400886
      ],
      [
        -62.446154,
        -35.400894
      ],
      [
        -62.446247,
        -35.400886
      ],
      [
        -62.446341,
        -35.400867
      ],
      [
        -62.446449,
        -35.40082
      ],
      [
        -62.446498,
        -35.400776
      ],
      [
        -62.446513,
        -35.400763
      ],
      [
        -62.446574,
        -35.400725
      ],
      [
        -62.44666,
        -35.400703
      ],
      [
        -62.446748,
        -35.400718
      ],
      [
        -62.446821,
        -35.400755
      ],
      [
        -62.446865,
        -35.400822
      ],
      [
        -62.446849,
        -35.401012
      ],
      [
        -62.446823,
        -35.401137
      ],
      [
        -62.446794,
        -35.401218
      ],
      [
        -62.446752,
        -35.401315
      ],
      [
        -62.446662,
        -35.401458
      ],
      [
        -62.446601,
        -35.401587
      ],
      [
        -62.446552,
        -35.401722
      ],
      [
        -62.446497,
        -35.401903
      ],
      [
        -62.446445,
        -35.402116
      ],
      [
        -62.446298,
        -35.402697
      ],
      [
        -62.446035,
        -35.403875
      ],
      [
        -62.445771,
        -35.405053
      ],
      [
        -62.445508,
        -35.406231
      ],
      [
        -62.445219,
        -35.407529
      ],
      [
        -62.444833,
        -35.409198
      ],
      [
        -62.444589,
        -35.410091
      ],
      [
        -62.444499,
        -35.410387
      ],
      [
        -62.444409,
        -35.410643
      ],
      [
        -62.444166,
        -35.41117
      ],
      [
        -62.443851,
        -35.411728
      ],
      [
        -62.443442,
        -35.412316
      ],
      [
        -62.443031,
        -35.412818
      ],
      [
        -62.44256,
        -35.41328
      ],
      [
        -62.442189,
        -35.413579
      ],
      [
        -62.441681,
        -35.413932
      ],
      [
        -62.441237,
        -35.41421
      ],
      [
        -62.440676,
        -35.414508
      ],
      [
        -62.439972,
        -35.414839
      ],
      [
        -62.439311,
        -35.41509
      ],
      [
        -62.438553,
        -35.415316
      ],
      [
        -62.437167,
        -35.415683
      ],
      [
        -62.435781,
        -35.416049
      ],
      [
        -62.434523,
        -35.416381
      ],
      [
        -62.433265,
        -35.416713
      ],
      [
        -62.432007,
        -35.417045
      ],
      [
        -62.430813,
        -35.41736
      ],
      [
        -62.429619,
        -35.417674
      ],
      [
        -62.428379,
        -35.418003
      ],
      [
        -62.427138,
        -35.418332
      ],
      [
        -62.425898,
        -35.418661
      ],
      [
        -62.424657,
        -35.41899
      ],
      [
        -62.423417,
        -35.41932
      ],
      [
        -62.422176,
        -35.419649
      ],
      [
        -62.420935,
        -35.419978
      ],
      [
        -62.419695,
        -35.420307
      ],
      [
        -62.418455,
        -35.420636
      ],
      [
        -62.417214,
        -35.420965
      ],
      [
        -62.416551,
        -35.421147
      ],
      [
        -62.41545,
        -35.421454
      ],
      [
        -62.415324,
        -35.421492
      ],
      [
        -62.414571,
        -35.421812
      ],
      [
        -62.414135,
        -35.422013
      ],
      [
        -62.413565,
        -35.422328
      ],
      [
        -62.41302,
        -35.422691
      ],
      [
        -62.412405,
        -35.423153
      ],
      [
        -62.41149,
        -35.42394
      ],
      [
        -62.410575,
        -35.424727
      ],
      [
        -62.40966,
        -35.425514
      ],
      [
        -62.409384,
        -35.425737
      ],
      [
        -62.408389,
        -35.426556
      ],
      [
        -62.407395,
        -35.427376
      ],
      [
        -62.4064,
        -35.428195
      ],
      [
        -62.405405,
        -35.429014
      ],
      [
        -62.404411,
        -35.429834
      ],
      [
        -62.403416,
        -35.430653
      ],
      [
        -62.402455,
        -35.431442
      ],
      [
        -62.401494,
        -35.432232
      ],
      [
        -62.400533,
        -35.433021
      ],
      [
        -62.399572,
        -35.43381
      ],
      [
        -62.398611,
        -35.4346
      ],
      [
        -62.39765,
        -35.435389
      ],
      [
        -62.396678,
        -35.436188
      ],
      [
        -62.395705,
        -35.436986
      ],
      [
        -62.394733,
        -35.437784
      ],
      [
        -62.393761,
        -35.438583
      ],
      [
        -62.392788,
        -35.439381
      ],
      [
        -62.391816,
        -35.44018
      ],
      [
        -62.391937,
        -35.440329
      ],
      [
        -62.392276,
        -35.440658
      ],
      [
        -62.392961,
        -35.441214
      ]
    ]
  },
  {
    "name": "Camino Vecinal hacia Colonia Seré",
    "description": "Traza real siguiendo el camino rural hacia Colonia Seré",
    "coords": [
      [
        -62.423938,
        -35.394218
      ],
      [
        -62.42454,
        -35.394332
      ],
      [
        -62.424717,
        -35.393684
      ],
      [
        -62.424876,
        -35.393104
      ],
      [
        -62.424907,
        -35.392991
      ],
      [
        -62.425221,
        -35.391882
      ],
      [
        -62.426492,
        -35.392111
      ],
      [
        -62.42777,
        -35.392347
      ],
      [
        -62.429034,
        -35.39258
      ],
      [
        -62.429778,
        -35.392714
      ],
      [
        -62.429887,
        -35.392734
      ],
      [
        -62.43026,
        -35.392881
      ],
      [
        -62.43048,
        -35.392996
      ],
      [
        -62.430656,
        -35.393103
      ],
      [
        -62.430753,
        -35.393141
      ],
      [
        -62.430942,
        -35.393281
      ],
      [
        -62.431067,
        -35.3934
      ],
      [
        -62.431233,
        -35.393614
      ],
      [
        -62.432518,
        -35.395346
      ],
      [
        -62.433253,
        -35.39637
      ],
      [
        -62.433989,
        -35.397394
      ],
      [
        -62.434383,
        -35.39796
      ],
      [
        -62.434632,
        -35.398276
      ],
      [
        -62.434772,
        -35.398477
      ],
      [
        -62.434849,
        -35.398549
      ],
      [
        -62.434962,
        -35.398596
      ],
      [
        -62.435017,
        -35.39862
      ],
      [
        -62.435078,
        -35.398656
      ],
      [
        -62.435098,
        -35.398668
      ],
      [
        -62.435288,
        -35.398776
      ],
      [
        -62.435597,
        -35.398904
      ],
      [
        -62.436012,
        -35.39904
      ],
      [
        -62.436612,
        -35.399158
      ],
      [
        -62.436725,
        -35.399179
      ],
      [
        -62.438104,
        -35.399438
      ],
      [
        -62.439484,
        -35.399698
      ],
      [
        -62.440863,
        -35.399957
      ],
      [
        -62.44245,
        -35.400247
      ],
      [
        -62.444037,
        -35.400537
      ],
      [
        -62.445751,
        -35.400843
      ],
      [
        -62.446024,
        -35.400886
      ],
      [
        -62.446154,
        -35.400894
      ],
      [
        -62.446247,
        -35.400886
      ],
      [
        -62.446341,
        -35.400867
      ],
      [
        -62.446449,
        -35.40082
      ],
      [
        -62.446498,
        -35.400776
      ],
      [
        -62.446513,
        -35.400763
      ],
      [
        -62.446574,
        -35.400725
      ],
      [
        -62.44666,
        -35.400703
      ],
      [
        -62.446748,
        -35.400718
      ],
      [
        -62.446821,
        -35.400755
      ],
      [
        -62.446865,
        -35.400822
      ],
      [
        -62.446849,
        -35.401012
      ],
      [
        -62.446823,
        -35.401137
      ],
      [
        -62.446794,
        -35.401218
      ],
      [
        -62.446752,
        -35.401315
      ],
      [
        -62.446662,
        -35.401458
      ],
      [
        -62.446601,
        -35.401587
      ],
      [
        -62.446552,
        -35.401722
      ],
      [
        -62.446497,
        -35.401903
      ],
      [
        -62.446445,
        -35.402116
      ],
      [
        -62.446298,
        -35.402697
      ],
      [
        -62.446035,
        -35.403875
      ],
      [
        -62.445771,
        -35.405053
      ],
      [
        -62.445508,
        -35.406231
      ],
      [
        -62.445219,
        -35.407529
      ],
      [
        -62.444833,
        -35.409198
      ],
      [
        -62.444589,
        -35.410091
      ],
      [
        -62.445838,
        -35.410323
      ],
      [
        -62.447087,
        -35.410555
      ],
      [
        -62.448337,
        -35.410787
      ],
      [
        -62.449586,
        -35.411019
      ],
      [
        -62.450835,
        -35.411251
      ],
      [
        -62.452426,
        -35.411546
      ],
      [
        -62.454016,
        -35.411841
      ],
      [
        -62.455252,
        -35.41207
      ],
      [
        -62.456489,
        -35.412299
      ],
      [
        -62.457725,
        -35.412528
      ],
      [
        -62.458961,
        -35.412757
      ],
      [
        -62.460198,
        -35.412986
      ],
      [
        -62.461434,
        -35.413215
      ],
      [
        -62.46267,
        -35.413444
      ],
      [
        -62.463907,
        -35.413673
      ],
      [
        -62.465143,
        -35.413902
      ],
      [
        -62.466379,
        -35.414131
      ],
      [
        -62.467616,
        -35.41436
      ],
      [
        -62.468852,
        -35.414589
      ],
      [
        -62.468933,
        -35.414608
      ],
      [
        -62.469004,
        -35.414633
      ],
      [
        -62.46906,
        -35.414676
      ],
      [
        -62.469092,
        -35.414727
      ],
      [
        -62.469096,
        -35.414798
      ],
      [
        -62.469072,
        -35.414869
      ],
      [
        -62.469033,
        -35.414921
      ],
      [
        -62.468728,
        -35.415167
      ],
      [
        -62.467724,
        -35.416001
      ],
      [
        -62.466721,
        -35.416834
      ],
      [
        -62.465717,
        -35.417668
      ],
      [
        -62.465647,
        -35.417742
      ],
      [
        -62.465646,
        -35.417858
      ],
      [
        -62.466174,
        -35.41949
      ],
      [
        -62.466293,
        -35.419657
      ],
      [
        -62.46715,
        -35.420318
      ],
      [
        -62.467397,
        -35.420517
      ],
      [
        -62.468166,
        -35.421143
      ],
      [
        -62.469256,
        -35.422022
      ],
      [
        -62.470347,
        -35.422901
      ],
      [
        -62.471437,
        -35.42378
      ],
      [
        -62.472451,
        -35.4246
      ],
      [
        -62.473465,
        -35.42542
      ],
      [
        -62.474478,
        -35.426239
      ],
      [
        -62.475492,
        -35.427059
      ]
    ]
  },
  {
    "name": "Acceso Rural Norte hacia Curarú / RP 70",
    "description": "Traza real (5,5 km) por el acceso rural norte hacia Curarú",
    "coords": [
      [
        -62.418965,
        -35.388127
      ],
      [
        -62.418385,
        -35.38802
      ],
      [
        -62.416888,
        -35.387742
      ],
      [
        -62.415503,
        -35.387486
      ],
      [
        -62.415368,
        -35.387484
      ],
      [
        -62.415476,
        -35.387139
      ],
      [
        -62.415578,
        -35.386802
      ],
      [
        -62.414213,
        -35.386548
      ],
      [
        -62.412848,
        -35.386295
      ],
      [
        -62.411484,
        -35.386041
      ],
      [
        -62.410119,
        -35.385787
      ],
      [
        -62.408874,
        -35.385553
      ],
      [
        -62.407628,
        -35.385319
      ],
      [
        -62.406383,
        -35.385085
      ],
      [
        -62.405137,
        -35.384851
      ],
      [
        -62.403892,
        -35.384617
      ],
      [
        -62.402646,
        -35.384383
      ],
      [
        -62.401401,
        -35.38415
      ],
      [
        -62.400155,
        -35.383916
      ],
      [
        -62.39891,
        -35.383682
      ],
      [
        -62.397664,
        -35.383448
      ],
      [
        -62.396419,
        -35.383214
      ],
      [
        -62.395173,
        -35.38298
      ],
      [
        -62.393928,
        -35.382746
      ],
      [
        -62.392723,
        -35.382521
      ],
      [
        -62.391518,
        -35.382296
      ],
      [
        -62.390313,
        -35.382071
      ],
      [
        -62.389107,
        -35.381846
      ],
      [
        -62.387902,
        -35.381621
      ],
      [
        -62.386697,
        -35.381396
      ],
      [
        -62.385492,
        -35.381171
      ],
      [
        -62.384287,
        -35.380946
      ],
      [
        -62.383082,
        -35.380721
      ],
      [
        -62.381876,
        -35.380496
      ],
      [
        -62.380671,
        -35.380271
      ],
      [
        -62.379466,
        -35.380046
      ],
      [
        -62.378261,
        -35.379821
      ],
      [
        -62.377056,
        -35.379596
      ],
      [
        -62.375851,
        -35.379371
      ],
      [
        -62.374645,
        -35.379146
      ],
      [
        -62.37344,
        -35.378921
      ],
      [
        -62.372235,
        -35.378696
      ],
      [
        -62.370976,
        -35.378461
      ],
      [
        -62.369717,
        -35.378226
      ],
      [
        -62.368458,
        -35.377991
      ],
      [
        -62.367199,
        -35.377756
      ],
      [
        -62.365941,
        -35.37752
      ],
      [
        -62.364682,
        -35.377285
      ],
      [
        -62.363423,
        -35.37705
      ],
      [
        -62.362164,
        -35.376815
      ],
      [
        -62.360905,
        -35.37658
      ]
    ]
  }
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
    speed: 14.0,
  };
}
