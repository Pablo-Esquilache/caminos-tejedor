import type { ClaimCategory, RawGpsPoint } from '@shared';

const DB_NAME = 'caminos_tejedor_local_db';
const DB_VERSION = 2;

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

export interface PendingClaimOutboxItem {
  id: string; // UUID generated on device
  title: string;
  description: string;
  category_id: string;
  category_name: string;
  lat: number;
  lon: number;
  photo_blob: Blob | null;
  thumb_blob: Blob | null;
  thumb_data_url: string | null;
  uploaded_storage_path: string | null;
  uploaded_thumb_path: string | null;
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
      if (!db.objectStoreNames.contains('outbox_claims')) {
        db.createObjectStore('outbox_claims', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('cached_categories')) {
        db.createObjectStore('cached_categories', { keyPath: 'id' });
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
      reject(tx.error);
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

/**
 * Cola local de reclamos pendientes de sincronización (incluye foto y miniatura comprimidas en el celular)
 */
export async function saveClaimToOutbox(item: PendingClaimOutboxItem): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox_claims', 'readwrite');
    tx.objectStore('outbox_claims').put(item);
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

export async function listOutboxClaims(): Promise<PendingClaimOutboxItem[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox_claims', 'readonly');
    const req = tx.objectStore('outbox_claims').getAll();
    req.onsuccess = () => {
      db.close();
      const items = (req.result as PendingClaimOutboxItem[]) || [];
      items.sort((a, b) => b.created_at.localeCompare(a.created_at));
      resolve(items);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function removeClaimFromOutbox(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox_claims', 'readwrite');
    tx.objectStore('outbox_claims').delete(id);
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
 * Caché local de categorías de reclamos activas para poder crear reclamos sin señal
 */
export async function saveCachedCategories(categories: ClaimCategory[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cached_categories', 'readwrite');
    const store = tx.objectStore('cached_categories');
    store.clear();
    for (const cat of categories) {
      store.put(cat);
    }
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

export async function getCachedCategories(): Promise<ClaimCategory[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cached_categories', 'readonly');
    const req = tx.objectStore('cached_categories').getAll();
    req.onsuccess = () => {
      db.close();
      const items = (req.result as ClaimCategory[]) || [];
      items.sort((a, b) => a.sort_order - b.sort_order);
      resolve(items);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}
