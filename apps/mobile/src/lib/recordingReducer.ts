import { isPointInsideCarlosTejedor, type RawGpsPoint } from '@shared';
import {
  calculateDistanceMeters,
  DEFAULT_MAX_GPS_ACCURACY_M,
  isGpsJitterOrReverse,
} from './geo';
import type { ActiveRecordingSession } from './localDb';

export interface ReducePointResult {
  next: ActiveRecordingSession;
  nextHighSpeedStartedAt: number | null;
  pauseMsg?: string;
}

export interface ReduceBatchOptions {
  /** Si es true, omite pausas por velocidad sostenida o salida del partido en recuperación (solo descarta puntos fuera). */
  recoveryMode?: boolean;
  /** Último instante de alta velocidad (>100 km/h) acumulado antes del lote. */
  initialHighSpeedStartedAt?: number | null;
}

export interface ReduceBatchResult {
  session: ActiveRecordingSession;
  nextHighSpeedStartedAt: number | null;
  pauseMsg?: string;
}

/**
 * Función 100% pura que aplica los filtros de geocerca municipal, velocidad sostenida,
 * precisión máxima, velocidad cinemática aparente y anti-jitter sobre un punto GPS entrante.
 */
export function reduceIncomingPoint(
  cur: ActiveRecordingSession,
  pt: RawGpsPoint,
  highSpeedStartedAt: number | null
): ReducePointResult {
  // 1. Filtro geográfico oficial del Partido de Carlos Tejedor (con margen de 3 km)
  if (!isPointInsideCarlosTejedor(pt.lat, pt.lon, 3)) {
    return {
      next: cur,
      nextHighSpeedStartedAt: highSpeedStartedAt,
      pauseMsg:
        'Saliste del Partido de Carlos Tejedor (límite municipal con tolerancia de 3 km). Grabación pausada preventivamente.',
    };
  }

  // 2. Filtro de velocidad sostenida en ruta (30 minutos continuos a > 100 km/h)
  let nextHs = highSpeedStartedAt;
  const speedKmH = pt.speed != null ? pt.speed * 3.6 : null;
  if (speedKmH != null && speedKmH > 100) {
    if (nextHs === null) {
      nextHs = pt.timestamp || Date.now();
    } else if ((pt.timestamp || Date.now()) - nextHs >= 30 * 60 * 1000) {
      return {
        next: cur,
        nextHighSpeedStartedAt: null,
        pauseMsg:
          'Se detectó velocidad de ruta sostenida (> 100 km/h por más de 30 minutos). Grabación pausada preventivamente.',
      };
    }
  } else if (speedKmH != null && speedKmH < 90) {
    nextHs = null;
  }

  // 3. Filtrar puntos con precisión mala (> umbral configurable)
  if (pt.accuracy > DEFAULT_MAX_GPS_ACCURACY_M) {
    return {
      next: {
        ...cur,
        discardedPointsCount: cur.discardedPointsCount + 1,
      },
      nextHighSpeedStartedAt: nextHs,
    };
  }

  const prevPoint = cur.points.length > 0 ? cur.points[cur.points.length - 1] : null;
  let deltaMeters = 0;

  if (prevPoint) {
    deltaMeters = calculateDistanceMeters(prevPoint.lat, prevPoint.lon, pt.lat, pt.lon);
    // 4. Filtro cinemático de velocidad aparente (> 42 m/s ~ 151 km/h entre dos puntos = salto de antena)
    const dt = (pt.timestamp - prevPoint.timestamp) / 1000;
    if (dt > 0.3 && deltaMeters / dt > 42) {
      return {
        next: {
          ...cur,
          discardedPointsCount: cur.discardedPointsCount + 1,
        },
        nextHighSpeedStartedAt: nextHs,
      };
    }
    // 5. Filtro Anti-Jitter y Anti-Retroceso (evita idas y vueltas artificiales en esquinas o paradas)
    if (isGpsJitterOrReverse(cur.points, pt, deltaMeters)) {
      return { next: cur, nextHighSpeedStartedAt: nextHs };
    }
  }

  return {
    next: {
      ...cur,
      distanceMeters: cur.distanceMeters + deltaMeters,
      points: [...cur.points, pt],
    },
    nextHighSpeedStartedAt: nextHs,
  };
}

/**
 * Reduce un lote completo de puntos usando la misma función pura tanto en vivo como en recuperación.
 */
export function reduceIncomingBatch(
  initialSession: ActiveRecordingSession,
  pts: RawGpsPoint[],
  options: ReduceBatchOptions = {}
): ReduceBatchResult {
  let cur = initialSession;
  let hs = options.initialHighSpeedStartedAt ?? null;
  let pauseMsg: string | undefined;

  for (const pt of pts) {
    const res = reduceIncomingPoint(cur, pt, hs);
    cur = res.next;
    hs = res.nextHighSpeedStartedAt;
    if (res.pauseMsg) {
      if (options.recoveryMode) {
        // En recuperación tras cierre de la app, simplemente se omiten los puntos que dispararían pausa
        continue;
      }
      pauseMsg = res.pauseMsg;
      break;
    }
  }

  return {
    session: cur,
    nextHighSpeedStartedAt: hs,
    pauseMsg,
  };
}
