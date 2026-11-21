import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: {
    rpc: vi.fn(),
  },
}));

import { analyzeSegmentElevation } from './elevationDem';

// Generador determinístico LCG para tests reproducibles de ruido DEM
function deterministicNoise(seed: number, amplitude: number, length: number): number[] {
  let state = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    state = (1664525 * state + 1013904223) >>> 0;
    const u = state / 0xffffffff; // 0..1
    out.push((u * 2 - 1) * amplitude);
  }
  return out;
}

describe('Detector cóncavo bilateral MDE 90m (caracterización)', () => {
  const makeSamples = (n: number) =>
    Array.from({ length: n }, (_, idx) => ({
      dist_m: idx * 90,
      lat: -35.4 + idx * 0.0008,
      lon: -62.45,
    }));

  it('no produce falsos positivos en 3 pendientes suaves ni en terreno plano con ruido determinístico', () => {
    const n = 34;
    const samples = makeSamples(n);

    const slope09 = Array.from({ length: n }, (_, i) => 95 - (0.9 * i) / (n - 1));
    const slope15 = Array.from({ length: n }, (_, i) => 95 - (1.5 * i) / (n - 1));
    const slope30 = Array.from({ length: n }, (_, i) => 95 - (3.0 * i) / (n - 1));

    const noise025 = deterministicNoise(42, 0.25, n);
    const flatNoisy025 = noise025.map((d) => 94 + d);

    const alt15 = Array.from({ length: n }, (_, i) => 94 + (i % 2 === 0 ? 1.5 : -1.5));

    expect(analyzeSegmentElevation(samples, slope09).hasLowZone).toBe(false);
    expect(analyzeSegmentElevation(samples, slope15).hasLowZone).toBe(false);
    expect(analyzeSegmentElevation(samples, slope30).hasLowZone).toBe(false);
    expect(analyzeSegmentElevation(samples, flatNoisy025).hasLowZone).toBe(false);
    expect(analyzeSegmentElevation(samples, alt15).hasLowZone).toBe(false);
  });

  it('detecta una depresión real de 1 m (3 de 34 muestras)', () => {
    const n = 34;
    const samples = makeSamples(n);
    const realBasin = Array.from({ length: n }, (_, i) => (i >= 15 && i <= 17 ? 93.0 : 94.0));

    const res = analyzeSegmentElevation(samples, realBasin);
    expect(res.hasLowZone).toBe(true);
    expect(res.profilePoints.filter((p) => p.is_low_zone)).toHaveLength(3);
  });
});
