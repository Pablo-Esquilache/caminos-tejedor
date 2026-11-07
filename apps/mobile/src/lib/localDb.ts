import type { RawGpsPoint } from '@shared';

const DB_NAME = 'caminos_tejedor_local_db';
const DB_VERSION = 1;

export interface ActiveRecordingSession {
  id: string; // 'current'
  tripUuid: string;
  status: 'recording' | 'paused' | 'confirming';
  startedAt: string; // ISO
  lastResumedAt: number | null; // epoch ms when last resumed
  accumulatedDurationMs: number; // duration accumulated before current active segment
  distanceMeters: number;
  points: RawGpsPoint[];
  discardedPointsCount: number;
}

export interface PendingTripOutboxItem {
  id: string; // UUID generated on device
  original_name: string;
  started_at: string;
  ended_at: string;
  distance_m: number;
  duration_s: number;
  raw_points: RawGpsPoint[];
  status: 'pending_sync' | 'syncing' | 'error';
  attempts: number;
  last_error: string | null;
  created_at: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('active_session')) {
        db.createObjectStore('active_session', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('outbox_trips')) {
        db.createObjectStore('outbox_trips', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Guarda inmediatamente el estado y puntos de la grabación activa en el dispositivo.
 * Si la app se cierra a mitad del camino, al reabrir recupera todos los puntos.
 */
export async function saveActiveRecordingSession(
  session: ActiveRecordingSession
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('active_session', 'readwrite');
    tx.objectStore('active_session').put(session);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getActiveRecordingSession(): Promise<ActiveRecordingSession | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('active_session', 'readonly');
    const req = tx.objectStore('active_session').get('current');
    req.onsuccess = () => {
      db.close();
      resolve((req.result as ActiveRecordingSession) || null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function clearActiveRecordingSession(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('active_session', 'readwrite');
    tx.objectStore('active_session').delete('current');
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Cola local de recorridos pendientes de sincronización (cuando no hay señal en el campo)
 */
export async function saveTripToOutbox(item: PendingTripOutboxItem): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox_trips', 'readwrite');
    tx.objectStore('outbox_trips').put(item);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function listOutboxTrips(): Promise<PendingTripOutboxItem[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox_trips', 'readonly');
    const req = tx.objectStore('outbox_trips').getAll();
    req.onsuccess = () => {
      db.close();
      const items = (req.result as PendingTripOutboxItem[]) || [];
      items.sort((a, b) => b.created_at.localeCompare(a.created_at));
      resolve(items);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function removeTripFromOutbox(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox_trips', 'readwrite');
    tx.objectStore('outbox_trips').delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
