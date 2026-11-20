import { describe, expect, it } from 'vitest';
import type { RawGpsPoint } from '@shared';
import { DEFAULT_MAX_GPS_ACCURACY_M } from './geo';
import type { ActiveRecordingSession } from './localDb';
import { reduceIncomingBatch, reduceIncomingPoint } from './recordingReducer';
import { analyzeSegmentElevation } from '../../../admin/src/lib/elevationDem';

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

describe('Fase 1: Detector cóncavo bilateral MDE 90m (6 perfiles sintéticos de 3 km)', () => {
  const makeSamples = (n: number) =>
    Array.from({ length: n }, (_, idx) => ({
      dist_m: idx * 90,
      lat: -35.4 + idx * 0.0008,
      lon: -62.45,
    }));

  it('marca 0 % en 3 pendientes suaves y 2 planos con ruido, y marca depresión real de 1 m', () => {
    const n = 34;
    const samples = makeSamples(n);
    const slope09 = Array.from({ length: n }, (_, i) => 95 - (0.9 * i) / (n - 1));
    const slope15 = Array.from({ length: n }, (_, i) => 95 - (1.5 * i) / (n - 1));
    const slope30 = Array.from({ length: n }, (_, i) => 95 - (3.0 * i) / (n - 1));
    const flat03 = Array.from({ length: n }, (_, i) => 94 + (i % 2 === 0 ? 0.3 : -0.3));
    const flat15 = Array.from({ length: n }, (_, i) => 94 + (i % 2 === 0 ? 1.5 : -1.5));
    const realBasin = Array.from({ length: n }, (_, i) => (i >= 15 && i <= 17 ? 93.0 : 94.0));

    expect(analyzeSegmentElevation(samples, slope09).hasLowZone).toBe(false);
    expect(analyzeSegmentElevation(samples, slope15).hasLowZone).toBe(false);
    expect(analyzeSegmentElevation(samples, slope30).hasLowZone).toBe(false);
    expect(analyzeSegmentElevation(samples, flat03).hasLowZone).toBe(false);
    expect(analyzeSegmentElevation(samples, flat15).hasLowZone).toBe(false);

    const basinRes = analyzeSegmentElevation(samples, realBasin);
    expect(basinRes.hasLowZone).toBe(true);
    expect(basinRes.profilePoints.filter((p) => p.is_low_zone).length).toBe(3);
  });
});
