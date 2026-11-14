import { Capacitor, registerPlugin } from '@capacitor/core';
import type { RawGpsPoint } from '@shared';

export interface NativeFix {
  seq: number;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude: number | null;
  speed: number | null;
  timestamp: number;
}

export interface BackgroundGpsPlugin {
  start(o: { sessionId: string }): Promise<void>;
  stop(): Promise<void>;
  getSince(o: {
    sessionId: string;
    afterSeq: number;
    limit?: number;
  }): Promise<{ fixes: NativeFix[]; lastSeq: number }>;
  status(): Promise<{
    running: boolean;
    sessionId: string | null;
    lastSeq: number;
    lastFixAt: number | null;
  }>;
  clear(o: { sessionId: string }): Promise<void>;
  addListener(
    eventName: 'onLocation',
    listenerFunc: (loc: NativeFix) => void
  ): Promise<{ remove: () => Promise<void> }>;
}

export const BackgroundGps = registerPlugin<BackgroundGpsPlugin>('BackgroundGps');

export const isNativeGps = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

export const toRawPoint = (f: NativeFix): RawGpsPoint => ({
  lat: f.latitude,
  lon: f.longitude,
  timestamp: f.timestamp || Date.now(),
  accuracy: f.accuracy ?? 999,
  altitude: f.altitude ?? undefined,
  speed: f.speed ?? undefined,
});

/**
 * Lee el diario nativo desde `afterSeq` en lotes no destructivos.
 * Devuelve todos los puntos nuevos y el último cursor `lastSeq` leído.
 */
export async function drainNative(
  sessionId: string,
  afterSeq: number
): Promise<{ points: RawGpsPoint[]; lastSeq: number }> {
  let cursor = afterSeq;
  const points: RawGpsPoint[] = [];
  try {
    for (;;) {
      const res = await BackgroundGps.getSince({
        sessionId,
        afterSeq: cursor,
        limit: 500,
      });
      const fixes = res?.fixes || [];
      if (!Array.isArray(fixes) || fixes.length === 0) {
        if (typeof res?.lastSeq === 'number' && res.lastSeq > cursor) {
          cursor = res.lastSeq;
        }
        break;
      }
      for (const f of fixes) {
        points.push(toRawPoint(f));
        if (typeof f.seq === 'number' && f.seq > cursor) {
          cursor = f.seq;
        }
      }
      if (fixes.length < 500) {
        break;
      }
    }
  } catch (err) {
    console.warn('Error leyendo diario nativo GpsJournal:', err);
  }
  return { points, lastSeq: cursor };
}
