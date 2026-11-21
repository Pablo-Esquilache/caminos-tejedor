import { describe, expect, it } from 'vitest';
import {
  isPointInMultiPolygon,
  isPointInsideUrbanArea,
  type RawGpsPoint,
} from '@shared';
import { DEFAULT_MAX_GPS_ACCURACY_M } from './geo';
import type { ActiveRecordingSession } from './localDb';
import { reduceIncomingBatch, reduceIncomingPoint, trimUrbanTail } from './recordingReducer';

function makeSession(overrides: Partial<ActiveRecordingSession> = {}): ActiveRecordingSession {
  return {
    id: 'current',
    tripUuid: '00000000-0000-4000-8000-000000000001',
    status: 'recording',
    startedAt: '2026-11-20T12:00:00.000Z',
    lastResumedAt: 1795000000000,
    accumulatedDurationMs: 0,
    distanceMeters: 0,
    points: [],
    discardedPointsCount: 0,
    nativeSeq: 0,
    ...overrides,
  };
}

function pt(lat: number, lon: number, timestamp: number, accuracy = 8, speed?: number): RawGpsPoint {
  return { lat, lon, timestamp, accuracy, speed };
}

describe('Fase 1: reduceIncomingPoint y reduceIncomingBatch (paridad vivo / recuperación)', () => {
  it('dispara pauseMsg si el punto sale del Partido de Carlos Tejedor (+3 km)', () => {
    const s = makeSession();
    // Buenos Aires Obelisco: claramente fuera del partido
    const res = reduceIncomingPoint(s, pt(-34.6037, -58.3816, 1795000005000), null);
    expect(res.pauseMsg).toContain('Saliste del Partido de Carlos Tejedor');
    expect(res.next.points).toHaveLength(0);
  });

  it('descarta puntos con accuracy > DEFAULT_MAX_GPS_ACCURACY_M e incrementa discardedPointsCount', () => {
    const s = makeSession();
    const res = reduceIncomingPoint(
      s,
      pt(-35.42, -62.45, 1795000005000, DEFAULT_MAX_GPS_ACCURACY_M + 15),
      null
    );
    expect(res.pauseMsg).toBeUndefined();
    expect(res.next.points).toHaveLength(0);
    expect(res.next.discardedPointsCount).toBe(1);
  });

  it('descarta saltos cinemáticos > 42 m/s entre dos puntos consecutivos', () => {
    const t0 = 1795000000000;
    const s = makeSession({
      points: [pt(-35.42, -62.45, t0, 8)],
    });
    // ~1.1 km en 1 segundo = 1100 m/s >> 42 m/s
    const res = reduceIncomingPoint(s, pt(-35.41, -62.45, t0 + 1000, 8), null);
    expect(res.next.points).toHaveLength(1);
    expect(res.next.discardedPointsCount).toBe(1);
  });

  it('dispara pauseMsg tras 30 minutos sostenidos a > 100 km/h', () => {
    const t0 = 1795000000000;
    const speedMs = 110 / 3.6; // 110 km/h
    const s = makeSession();
    const r1 = reduceIncomingPoint(s, pt(-35.42, -62.45, t0, 8, speedMs), null);
    expect(r1.pauseMsg).toBeUndefined();
    expect(r1.nextHighSpeedStartedAt).toBe(t0);

    const r2 = reduceIncomingPoint(
      r1.next,
      pt(-35.421, -62.45, t0 + 30 * 60 * 1000 + 1000, 8, speedMs),
      r1.nextHighSpeedStartedAt
    );
    expect(r2.pauseMsg).toContain('velocidad de ruta sostenida');
  });

  it('mantiene paridad 100 % entre reduceIncomingBatch (vivo y recuperación) sobre un lote válido', () => {
    const t0 = 1795000000000;
    const batch: RawGpsPoint[] = [
      pt(-35.4200, -62.4500, t0, 7),
      pt(-35.4205, -62.4500, t0 + 4000, 8),
      pt(-35.4210, -62.4500, t0 + 8000, DEFAULT_MAX_GPS_ACCURACY_M + 15), // descartado por accuracy
      pt(-35.4215, -62.4500, t0 + 12000, 6),
    ];

    const live = reduceIncomingBatch(makeSession(), batch);
    const recovered = reduceIncomingBatch(makeSession(), batch, { recoveryMode: true });

    expect(live.pauseMsg).toBeUndefined();
    expect(recovered.session.points).toEqual(live.session.points);
    expect(recovered.session.distanceMeters).toBeCloseTo(live.session.distanceMeters, 6);
    expect(recovered.session.discardedPointsCount).toBe(1);
    expect(live.session.points).toHaveLength(3);
  });
});

describe('Fase 2: Geocerca de Ejido Urbano (5 localidades IGN)', () => {
  const URBAN_CENTERS = [
    { name: 'Carlos Tejedor', lat: -35.3915, lon: -62.4200 },
    { name: 'Tres Algarrobos', lat: -35.1956, lon: -62.7744 },
    { name: 'Timote', lat: -35.3475, lon: -62.2229 },
    { name: 'Colonia Seré', lat: -35.4365, lon: -62.7279 },
    { name: 'Curarú', lat: -35.6409, lon: -62.1947 },
  ];

  it('detecta el centro de las 5 localidades como urbano y un punto rural afuera', () => {
    for (const c of URBAN_CENTERS) {
      expect(isPointInsideUrbanArea(c.lat, c.lon), `Centro de ${c.name}`).toBe(true);
    }
    // Punto rural abierto entre Carlos Tejedor y Timote
    expect(isPointInsideUrbanArea(-35.37, -62.32)).toBe(false);
  });

  it('valida puntos a ~50 m sobre el borde norte de Carlos Tejedor y corredor de 60 m (±20 m adentro, 45 m afuera) en el acceso oeste', () => {
    // Borde norte aproximado de Carlos Tejedor (~lat -35.3847, lon -62.4215):
    expect(isPointInsideUrbanArea(-35.3852, -62.4215)).toBe(true); // ~50m adentro
    expect(isPointInsideUrbanArea(-35.3834, -62.4215)).toBe(false); // ~50m afuera al norte
    // Acceso oeste con corredor de 60 m (±30 m del eje en lon -62.4407, eje ~lat -35.40005):
    expect(isPointInsideUrbanArea(-35.39987, -62.4407)).toBe(true); // +20 m norte del eje
    expect(isPointInsideUrbanArea(-35.40023, -62.4407)).toBe(true); // -20 m sur del eje
    expect(isPointInsideUrbanArea(-35.39955, -62.4407)).toBe(false); // ~55 m norte del eje (afuera)
    expect(isPointInsideUrbanArea(-35.40104, -62.4472)).toBe(false); // afuera al oeste de la punta
  });

  it('soporta MultiPolygon con huecos en isPointInMultiPolygon', () => {
    const polyWithHole = [
      [
        [
          [-62.5, -35.5],
          [-62.3, -35.5],
          [-62.3, -35.3],
          [-62.5, -35.3],
          [-62.5, -35.5],
        ],
        [
          [-62.42, -35.42],
          [-62.38, -35.42],
          [-62.38, -35.38],
          [-62.42, -35.38],
          [-62.42, -35.42],
        ],
      ],
    ];
    expect(isPointInMultiPolygon(-62.45, -35.45, polyWithHole)).toBe(true);
    expect(isPointInMultiPolygon(-62.40, -35.40, polyWithHole)).toBe(false);
  });

  it('omite el inicio dentro de cada localidad y arranca solo con el primer punto rural', () => {
    const t0 = 1795000000000;
    for (const c of URBAN_CENTERS) {
      const batch: RawGpsPoint[] = [
        pt(c.lat, c.lon, t0, 8),
        pt(c.lat + 0.0005, c.lon, t0 + 3000, 8),
        pt(-35.3700, -62.3200, t0 + 60000, 8), // primer rural
        pt(-35.3710, -62.3200, t0 + 65000, 8), // segundo rural
      ];
      const res = reduceIncomingBatch(makeSession(), batch, { isSimulator: false });
      expect(res.pauseMsg).toBeUndefined();
      expect(res.session.points).toHaveLength(2);
      expect(res.session.discardedPointsCount).toBe(0);
      expect(res.session.points[0].lat).toBeCloseTo(-35.37, 4);
    }
  });

  it('conserva puntos de un pueblo intermedio sin cortar ni dibujar cuerdas', () => {
    const t0 = 1795000000000;
    const batch: RawGpsPoint[] = [
      pt(-35.3700, -62.3200, t0, 8), // rural
      pt(-35.3710, -62.3200, t0 + 5000, 8), // rural
      pt(-35.3475, -62.2229, t0 + 700000, 8), // cruce por Timote (~9.2 km en 695s ~ 13 m/s)
      pt(-35.3300, -62.2000, t0 + 1000000, 8), // vuelve a rural (~2.8 km en 300s ~ 9 m/s)
    ];
    const res = reduceIncomingBatch(makeSession(), batch, { isSimulator: false });
    expect(res.session.points).toHaveLength(4);
  });

  it('recorta la cola urbana al finalizar y recalcula distancia neta rural', () => {
    const t0 = 1795000000000;
    const pts: RawGpsPoint[] = [
      pt(-35.3700, -62.3200, t0, 8),
      pt(-35.3710, -62.3200, t0 + 5000, 8),
      pt(-35.3915, -62.4200, t0 + 120000, 8), // Carlos Tejedor urbano (cola)
      pt(-35.3920, -62.4205, t0 + 125000, 8), // Carlos Tejedor urbano (cola)
    ];
    const trimmed = trimUrbanTail(pts, false);
    expect(trimmed.points).toHaveLength(2);
    expect(trimmed.distanceMeters).toBeGreaterThan(90);
    expect(trimmed.distanceMeters).toBeLessThan(150);
  });

  it('recorrido 100 % urbano deja < 2 puntos tras trimUrbanTail', () => {
    const t0 = 1795000000000;
    const pts: RawGpsPoint[] = [
      pt(-35.3915, -62.4200, t0, 8),
      pt(-35.3920, -62.4205, t0 + 5000, 8),
    ];
    const trimmed = trimUrbanTail(pts, false);
    expect(trimmed.points).toHaveLength(0);
    expect(trimmed.distanceMeters).toBe(0);
  });

  it('exime al Modo Simulador tanto al inicio como en la cola', () => {
    const t0 = 1795000000000;
    const batch: RawGpsPoint[] = [
      pt(-35.3915, -62.4200, t0, 8),
      pt(-35.3925, -62.4200, t0 + 4000, 8),
    ];
    const res = reduceIncomingBatch(makeSession(), batch, { isSimulator: true });
    expect(res.session.points).toHaveLength(2);
    const trimmed = trimUrbanTail(res.session.points, true);
    expect(trimmed.points).toHaveLength(2);
  });

  it('mantiene paridad entre vivo y recuperación (solo inicio urbano)', () => {
    const t0 = 1795000000000;
    const batch: RawGpsPoint[] = [
      pt(-35.3915, -62.4200, t0, 8), // inicio urbano (omitido)
      pt(-35.3700, -62.3200, t0 + 60000, 8), // rural
      pt(-35.3710, -62.3200, t0 + 65000, 8), // rural
      pt(-35.3475, -62.2229, t0 + 800000, 8), // cola urbana (~9.2 km en 735s ~ 12.5 m/s)
    ];
    const live = reduceIncomingBatch(makeSession(), batch, { isSimulator: false });
    const recovered = reduceIncomingBatch(makeSession(), batch, { recoveryMode: true, isSimulator: false });
    expect(recovered.session.points).toEqual(live.session.points);
    expect(recovered.session.distanceMeters).toBeCloseTo(live.session.distanceMeters, 6);
    expect(live.session.points).toHaveLength(3);
  });
});
