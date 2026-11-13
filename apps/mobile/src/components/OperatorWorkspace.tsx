import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  CARLOS_TEJEDOR_CENTER,
  INTERVENTION_STATUS_LABELS,
  isPointInsideCarlosTejedor,
  type InterventionStatus,
  type InterventionSummary,
  type MachineItem,
  type NearbyClaimOption,
  type OperatorItem,
  type RawGpsPoint,
  type WorkExecutionMode,
  type WorkTypeItem,
} from '@shared';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clock,
  MapPin,
  Navigation,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  Square,
  Truck,
  WifiOff,
  Wrench,
} from 'lucide-react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { Geolocation } from '@capacitor/geolocation';
import { supabase } from '../lib/supabase';
import {
  buildSimulatedPoint,
  calculateDistanceMeters,
  DEFAULT_MAX_GPS_ACCURACY_M,
  formatDistance,
  formatDuration,
  SAMPLE_TEJEDOR_ROUTES,
  isGpsJitterOrReverse,
  cleanTrackLoopsAndJitter,
} from '../lib/geo';
import { getMapStyle } from '../lib/mapStyle';
import { compressClaimPhoto } from '../lib/imageCompression';
import {
  getCachedOperatorTasks,
  getCachedStaffCatalogs,
  listOutboxInterventions,
  removeInterventionFromOutbox,
  saveCachedOperatorTasks,
  saveCachedStaffCatalogs,
  saveInterventionToOutbox,
  type PendingInterventionOutboxItem,
} from '../lib/localDb';

interface BackgroundGpsPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
  getBufferedLocations?(): Promise<{
    locations: Array<{
      latitude: number;
      longitude: number;
      accuracy: number;
      altitude?: number | null;
      speed?: number | null;
      timestamp: number;
    }>;
  }>;
  addListener(
    eventName: 'onLocation',
    listenerFunc: (loc: {
      latitude: number;
      longitude: number;
      accuracy: number;
      altitude?: number | null;
      speed?: number | null;
      timestamp: number;
    }) => void
  ): Promise<any>;
}

const BackgroundGps = registerPlugin<BackgroundGpsPlugin>('BackgroundGps');

function playWorkAlertTone() {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch {
    // Noop
  }
}

interface OperatorWorkspaceProps {
  userId: string;
  isOnline: boolean;
  onSyncPendingChange?: (count: number) => void;
}

export const OperatorWorkspace: React.FC<OperatorWorkspaceProps> = ({
  userId,
  isOnline,
  onSyncPendingChange,
}) => {
  const [tasks, setTasks] = useState<InterventionSummary[]>([]);
  const [workTypes, setWorkTypes] = useState<WorkTypeItem[]>([]);
  const [machines, setMachines] = useState<MachineItem[]>([]);
  const [operators, setOperators] = useState<OperatorItem[]>([]);
  const [outboxList, setOutboxList] = useState<PendingInterventionOutboxItem[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [syncingOutbox, setSyncingOutbox] = useState(false);
  const [bannerMsg, setBannerMsg] = useState<string | null>(null);

  // Vista de tarea seleccionada en mapa de detalle
  const [previewTaskId, setPreviewTaskId] = useState<string | null>(null);
  const previewMapRef = useRef<maplibregl.Map | null>(null);
  const previewContainerRef = useRef<HTMLDivElement | null>(null);

  // Flujo de ejecución en campo (Lineal GPS o Puntual o Espontáneo)
  const [activeWork, setActiveWork] = useState<{
    interventionId: string | null;
    isSpontaneous: boolean;
    title: string;
    executionMode: WorkExecutionMode;
    workTypeIds: string[];
    machineIds: string[];
    participantOperatorIds: string[];
    linkedClaimId: string | null;
  } | null>(null);

  // Estado para Nueva Tarea Espontánea (modal de inicio)
  const [showSpontaneousModal, setShowSpontaneousModal] = useState(false);
  const [spontTitle, setSpontTitle] = useState('');
  const [spontMode, setSpontMode] = useState<WorkExecutionMode>('linear');
  const [spontWtId, setSpontWtId] = useState('');
  const [spontMachId, setSpontMachId] = useState('');

  // Grabación lineal (Fase 13 + Geofence + Temporizador 1h + Velocidad)
  const [recStatus, setRecStatus] = useState<'idle' | 'recording' | 'paused' | 'finishing'>('idle');
  const [finishAction, setFinishAction] = useState<'suspend' | 'submit'>('submit');
  const [points, setPoints] = useState<RawGpsPoint[]>([]);
  const [distanceM, setDistanceM] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [startedAtIso, setStartedAtIso] = useState<string>('');
  const [accumulatedMs, setAccumulatedMs] = useState(0);
  const [lastResumedAt, setLastResumedAt] = useState<number | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [useSimulator, setUseSimulator] = useState(false);
  const [showHourlyPrompt, setShowHourlyPrompt] = useState(false);

  // Ejecución puntual & Confirmación final (reclamos cercanos + fotos + notas)
  const [punctualLat, setPunctualLat] = useState<number | null>(null);
  const [punctualLon, setPunctualLon] = useState<number | null>(null);
  const [nearbyClaims, setNearbyClaims] = useState<NearbyClaimOption[]>([]);
  const [photos, setPhotos] = useState<
    Array<{ photoBlob: Blob; thumbBlob: Blob; previewUrl: string }>
  >([]);
  const [notes, setNotes] = useState('');
  const [submittingWork, setSubmittingWork] = useState(false);

  const watchIdRef = useRef<number | null>(null);
  const nativeWatchRef = useRef<string | null>(null);
  const nativeBgListenerRef = useRef<any>(null);
  const simTimerRef = useRef<number | null>(null);
  const simStepRef = useRef(0);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const recStatusRef = useRef(recStatus);
  recStatusRef.current = recStatus;
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const distRef = useRef(distanceM);
  distRef.current = distanceM;
  const highSpeedStartRef = useRef<number | null>(null);
  const hourlyPromptHourRef = useRef<number>(0);

  const loadDataAndCache = async () => {
    setLoadingTasks(true);
    if (isOnline) {
      const [{ data: tasksData }, { data: catData }] = await Promise.all([
        supabase.rpc('operator_list_my_tasks'),
        supabase.rpc('list_active_staff_catalogs'),
      ]);

      if (Array.isArray(tasksData)) {
        const list = tasksData as InterventionSummary[];
        setTasks(list);
        saveCachedOperatorTasks(list).catch(() => {});
      }
      if (catData) {
        const cats = {
          work_types: (catData.work_types || []) as WorkTypeItem[],
          machines: (catData.machines || []) as MachineItem[],
          operators: (catData.operators || []) as OperatorItem[],
        };
        setWorkTypes(cats.work_types);
        setMachines(cats.machines);
        setOperators(cats.operators);
        saveCachedStaffCatalogs(cats).catch(() => {});
      }
    } else {
      const [cachedTasks, cachedCats] = await Promise.all([
        getCachedOperatorTasks(),
        getCachedStaffCatalogs(),
      ]);
      setTasks(cachedTasks);
      if (cachedCats) {
        setWorkTypes(cachedCats.work_types);
        setMachines(cachedCats.machines);
        setOperators(cachedCats.operators);
      }
    }
    await refreshOutbox();
    setLoadingTasks(false);
  };

  const refreshOutbox = async () => {
    const pending = await listOutboxInterventions();
    setOutboxList(pending);
    onSyncPendingChange?.(pending.length);
    return pending;
  };

  const syncSingleOutboxItem = async (item: PendingInterventionOutboxItem): Promise<boolean> => {
    const uploadedPhotos: Array<{ storage_path: string; thumb_path: string }> = [];
    const targetFolderId = item.intervention_id || item.session_id;

    try {
      for (let idx = 0; idx < (item.photo_blobs || []).length; idx++) {
        const ph = item.photo_blobs[idx];
        const mainPath = `${userId}/interventions/${targetFolderId}/${item.session_id}_${idx}.jpg`;
        const thumbPath = `${userId}/interventions/${targetFolderId}/${item.session_id}_${idx}_thumb.jpg`;

        const { error: upErr } = await supabase.storage
          .from('claim-photos')
          .upload(mainPath, ph.photoBlob, { contentType: 'image/jpeg', upsert: true });
        if (upErr) throw new Error(upErr.message);

        await supabase.storage
          .from('claim-photos')
          .upload(thumbPath, ph.thumbBlob, { contentType: 'image/jpeg', upsert: true });

        uploadedPhotos.push({ storage_path: mainPath, thumb_path: thumbPath });
      }

      const { error } = await supabase.rpc('operator_submit_session', {
        p_session_id: item.session_id,
        p_intervention_id: item.intervention_id,
        p_action: item.action,
        p_execution_mode: item.execution_mode,
        p_title: item.title,
        p_description: item.description,
        p_started_at: item.started_at,
        p_ended_at: item.ended_at,
        p_raw_points: item.raw_points,
        p_raw_distance_m: item.raw_distance_m,
        p_duration_s: item.duration_s,
        p_punctual_lat: item.punctual_lat,
        p_punctual_lon: item.punctual_lon,
        p_work_type_ids: item.work_type_ids,
        p_machine_ids: item.machine_ids,
        p_participant_operator_ids: item.participant_operator_ids,
        p_linked_claim_id: item.linked_claim_id,
        p_photo_paths: uploadedPhotos,
        p_notes: item.notes,
      });

      if (error) throw new Error(error.message);

      await removeInterventionFromOutbox(item.session_id);
      return true;
    } catch (err: any) {
      await saveInterventionToOutbox({
        ...item,
        status: 'error',
        last_error: err?.message || 'Error al sincronizar trabajo',
      });
      return false;
    }
  };

  const syncPendingInterventions = async () => {
    if (!isOnline || syncingOutbox) return;
    const pending = await refreshOutbox();
    if (pending.length === 0) return;

    setSyncingOutbox(true);
    let okCount = 0;
    for (const item of pending) {
      if (await syncSingleOutboxItem(item)) okCount++;
    }
    setSyncingOutbox(false);
    await loadDataAndCache();
    if (okCount > 0) {
      setBannerMsg(`Se sincronizaron ${okCount} parte(s) de trabajo con el Municipio.`);
      window.setTimeout(() => setBannerMsg(null), 5000);
    }
  };

  useEffect(() => {
    loadDataAndCache();
  }, [userId, isOnline]);

  useEffect(() => {
    if (isOnline) {
      syncPendingInterventions();
    }
  }, [isOnline]);

  // Reloj de duración efectiva + Temporizador de seguridad de 1 hora (60 min)
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (recStatusRef.current === 'recording' && lastResumedAt !== null) {
        const totalSec = Math.floor((accumulatedMs + (Date.now() - lastResumedAt)) / 1000);
        setElapsedSec(totalSec);

        if (totalSec >= 3600) {
          const hr = Math.floor(totalSec / 3600);
          if (hr > hourlyPromptHourRef.current) {
            hourlyPromptHourRef.current = hr;
            pauseLinearGps();
            setShowHourlyPrompt(true);
            playWorkAlertTone();
            navigator.vibrate?.([400, 200, 400]);
          }
        }
      } else {
        setElapsedSec(Math.floor(accumulatedMs / 1000));
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [accumulatedMs, lastResumedAt]);

  // Mapa de vista previa de tarea planificada/suspendida
  useEffect(() => {
    if (!previewTaskId || !previewContainerRef.current) return;
    const task = tasks.find((t) => t.id === previewTaskId);
    if (!task) return;

    if (previewMapRef.current) {
      previewMapRef.current.remove();
      previewMapRef.current = null;
    }

    const map = new maplibregl.Map({
      container: previewContainerRef.current,
      style: getMapStyle('hybrid'),
      center: [CARLOS_TEJEDOR_CENTER.longitude, CARLOS_TEJEDOR_CENTER.latitude],
      zoom: 12,
      attributionControl: false,
    });

    map.on('load', () => {
      const bounds = new maplibregl.LngLatBounds();
      let hasCoords = false;
      const walk = (c: any) => {
        if (typeof c[0] === 'number' && typeof c[1] === 'number') {
          bounds.extend([c[0], c[1]]);
          hasCoords = true;
        } else if (Array.isArray(c)) {
          c.forEach(walk);
        }
      };

      if (task.planned_geojson) {
        walk(task.planned_geojson.coordinates);
        map.addSource('op-planned', {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: task.planned_geojson } as any,
        });
        map.addLayer({
          id: 'op-planned-line',
          type: 'line',
          source: 'op-planned',
          filter: ['!=', '$type', 'Point'],
          paint: { 'line-color': '#f59e0b', 'line-width': 4, 'line-dasharray': [2, 2] },
        });
        map.addLayer({
          id: 'op-planned-pt',
          type: 'circle',
          source: 'op-planned',
          filter: ['==', '$type', 'Point'],
          paint: { 'circle-radius': 8, 'circle-color': '#f59e0b', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' },
        });
      }

      if (task.worked_geojson) {
        walk(task.worked_geojson.coordinates);
        map.addSource('op-worked', {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: task.worked_geojson } as any,
        });
        map.addLayer({
          id: 'op-worked-line',
          type: 'line',
          source: 'op-worked',
          filter: ['!=', '$type', 'Point'],
          paint: { 'line-color': '#16a34a', 'line-width': 5 },
        });
      }

      if (hasCoords && !bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 40, maxZoom: 15 });
      }
    });

    previewMapRef.current = map;
    return () => {
      map.remove();
      previewMapRef.current = null;
    };
  }, [previewTaskId]);

  const stopAllGps = () => {
    if (Capacitor.isNativePlatform()) {
      try {
        BackgroundGps.stop();
      } catch {}
      if (nativeBgListenerRef.current?.remove) {
        nativeBgListenerRef.current.remove();
        nativeBgListenerRef.current = null;
      }
    }
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (nativeWatchRef.current !== null) {
      Geolocation.clearWatch({ id: nativeWatchRef.current });
      nativeWatchRef.current = null;
    }
    if (simTimerRef.current !== null) {
      window.clearInterval(simTimerRef.current);
      simTimerRef.current = null;
    }
    try {
      wakeLockRef.current?.release();
      wakeLockRef.current = null;
    } catch {}
  };

  useEffect(() => {
    return () => stopAllGps();
  }, []);

  const pushIncomingPoint = (pt: RawGpsPoint) => {
    if (recStatusRef.current !== 'recording') return;
    setGpsAccuracy(Math.round(pt.accuracy));

    // Regla unificada: Límite del Partido de Carlos Tejedor (buffer 3 km)
    if (!isPointInsideCarlosTejedor(pt.lat, pt.lon, 3)) {
      pauseLinearGps();
      setGpsError(
        'Saliste del Partido de Carlos Tejedor (límite municipal con tolerancia de 3 km). Trabajo pausado preventivamente.'
      );
      return;
    }

    // Regla unificada: Filtro de velocidad sostenida (>100 km/h durante 30 minutos)
    const speedKmH = pt.speed != null ? pt.speed * 3.6 : null;
    if (speedKmH != null && speedKmH > 100) {
      if (highSpeedStartRef.current === null) {
        highSpeedStartRef.current = Date.now();
      } else if (Date.now() - highSpeedStartRef.current >= 30 * 60 * 1000) {
        pauseLinearGps();
        setGpsError(
          'Se detectó velocidad de ruta sostenida (> 100 km/h por 30 min). Trabajo pausado preventivamente.'
        );
        highSpeedStartRef.current = null;
        return;
      }
    } else if (speedKmH != null && speedKmH < 90) {
      highSpeedStartRef.current = null;
    }

    if (pt.accuracy > DEFAULT_MAX_GPS_ACCURACY_M) return;

    const prevPts = pointsRef.current;
    let delta = 0;
    if (prevPts.length > 0) {
      const prev = prevPts[prevPts.length - 1];
      delta = calculateDistanceMeters(prev.lat, prev.lon, pt.lat, pt.lon);
      // Filtro Anti-Jitter y Anti-Retroceso (evita idas y vueltas artificiales en esquinas o paradas)
      if (isGpsJitterOrReverse(prevPts, pt, delta)) return;
    }

    const nextPts = [...prevPts, pt];
    pointsRef.current = nextPts;
    distRef.current = distRef.current + delta;
    setPoints(nextPts);
    setDistanceM(distRef.current);
  };

  // Drena los puntos acumulados por el Foreground Service nativo mientras la pantalla estuvo apagada
  const drainNativeLocationBuffer = async () => {
    if (!Capacitor.isNativePlatform() || !BackgroundGps.getBufferedLocations) return;
    try {
      const res = await BackgroundGps.getBufferedLocations();
      if (res && res.locations && res.locations.length > 0) {
        for (const loc of res.locations) {
          pushIncomingPoint({
            lat: loc.latitude,
            lon: loc.longitude,
            timestamp: loc.timestamp || Date.now(),
            accuracy: loc.accuracy || 5,
            altitude: loc.altitude ?? undefined,
            speed: loc.speed ?? undefined,
          });
        }
      }
    } catch (err) {
      console.warn('Error drenando buffer nativo en Operario:', err);
    }
  };

  // Escuchar desbloqueo de pantalla y cambios de foco para volcar el buffer nativo
  useEffect(() => {
    const handleWake = () => {
      if (document.visibilityState === 'visible' && recStatus === 'recording') {
        drainNativeLocationBuffer();
      }
    };

    document.addEventListener('visibilitychange', handleWake);
    window.addEventListener('focus', handleWake);

    const appStateSub = CapApp.addListener('appStateChange', (state: { isActive: boolean }) => {
      if (state.isActive && recStatus === 'recording') {
        drainNativeLocationBuffer();
      }
    });

    const drainTimer = window.setInterval(() => {
      if (recStatus === 'recording') {
        drainNativeLocationBuffer();
      }
    }, 2500);

    return () => {
      document.removeEventListener('visibilitychange', handleWake);
      window.removeEventListener('focus', handleWake);
      appStateSub.then((s: any) => s?.remove?.()).catch(() => {});
      window.clearInterval(drainTimer);
    };
  }, [recStatus]);

  const attachLinearGps = async () => {
    stopAllGps();
    setGpsError(null);
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      }
    } catch {}

    if (useSimulator) {
      const route = SAMPLE_TEJEDOR_ROUTES[0];
      const first = route.coords[simStepRef.current % route.coords.length];
      pushIncomingPoint(buildSimulatedPoint(first[0], first[1], 5));
      simTimerRef.current = window.setInterval(() => {
        simStepRef.current += 1;
        const idx = simStepRef.current % route.coords.length;
        const [lon, lat] = route.coords[idx];
        pushIncomingPoint(buildSimulatedPoint(lon, lat, 5));
      }, 900);
      return;
    }

    if (Capacitor.isNativePlatform()) {
      const perm = await Geolocation.requestPermissions();
      if (perm.location === 'granted' || perm.coarseLocation === 'granted') {
        try {
          await BackgroundGps.start();
          nativeBgListenerRef.current = await BackgroundGps.addListener('onLocation', (loc) => {
            pushIncomingPoint({
              lat: loc.latitude,
              lon: loc.longitude,
              timestamp: loc.timestamp || Date.now(),
              accuracy: loc.accuracy || 5,
              altitude: loc.altitude ?? undefined,
              speed: loc.speed ?? undefined,
            });
          });
        } catch {}

        nativeWatchRef.current = await Geolocation.watchPosition(
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 },
          (pos) => {
            if (pos) {
              pushIncomingPoint({
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                timestamp: pos.timestamp || Date.now(),
                accuracy: pos.coords.accuracy || 5,
                altitude: pos.coords.altitude ?? undefined,
                speed: pos.coords.speed ?? undefined,
              });
            }
          }
        );
      } else {
        setGpsError('Permiso de ubicación GPS requerido para grabar el tramo.');
      }
      return;
    }

    if (!('geolocation' in navigator)) {
      setGpsError('Tu navegador no soporta geolocalización GPS.');
      return;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        pushIncomingPoint({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          timestamp: pos.timestamp || Date.now(),
          accuracy: pos.coords.accuracy || 10,
          altitude: pos.coords.altitude,
          speed: pos.coords.speed,
        });
      },
      (err) => {
        setGpsError(`Error GPS (${err.message}).`);
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  };

  const pauseLinearGps = () => {
    stopAllGps();
    if (lastResumedAt !== null) {
      setAccumulatedMs((prev) => prev + (Date.now() - lastResumedAt));
    }
    setLastResumedAt(null);
    setRecStatus('paused');
    recStatusRef.current = 'paused';
  };

  const resumeLinearGps = () => {
    setLastResumedAt(Date.now());
    setRecStatus('recording');
    recStatusRef.current = 'recording';
    attachLinearGps();
  };

  const startExecution = async (
    task: InterventionSummary | null,
    spontaneousConfig?: { title: string; mode: WorkExecutionMode; wtId: string; machId: string }
  ) => {
    setPreviewTaskId(null);
    setGpsError(null);
    setPhotos([]);
    setNotes('');
    setNearbyClaims([]);
    setPoints([]);
    pointsRef.current = [];
    setDistanceM(0);
    distRef.current = 0;
    setAccumulatedMs(0);
    hourlyPromptHourRef.current = 0;
    highSpeedStartRef.current = null;
    simStepRef.current = 0;
    setShowHourlyPrompt(false);

    const execMode = task ? task.execution_mode : spontaneousConfig!.mode;
    const workObj = {
      interventionId: task ? task.id : null,
      isSpontaneous: !task,
      title: task ? task.title : spontaneousConfig!.title,
      executionMode: execMode,
      workTypeIds: task
        ? (task.work_types || []).map((w) => w.id)
        : spontaneousConfig?.wtId
          ? [spontaneousConfig.wtId]
          : [],
      machineIds: task
        ? (task.machines || []).map((m) => m.id)
        : spontaneousConfig?.machId
          ? [spontaneousConfig.machId]
          : [],
      participantOperatorIds: task
        ? (task.operators || []).filter((o) => !o.is_responsible).map((o) => o.id)
        : [],
      linkedClaimId: task?.linked_claim_id || null,
    };

    setActiveWork(workObj);
    setStartedAtIso(new Date().toISOString());

    if (execMode === 'linear') {
      setRecStatus('recording');
      recStatusRef.current = 'recording';
      setLastResumedAt(Date.now());
      attachLinearGps();
    } else {
      // Tarea Puntual: capturar ubicación única al abrir (sin trackeo continuo)
      setRecStatus('finishing');
      setFinishAction('submit');
      capturePunctualPoint();
    }
  };

  const capturePunctualPoint = () => {
    setGpsError(null);
    if (!('geolocation' in navigator)) {
      setPunctualLat(CARLOS_TEJEDOR_CENTER.latitude);
      setPunctualLon(CARLOS_TEJEDOR_CENTER.longitude);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        setPunctualLat(lat);
        setPunctualLon(lon);
        loadNearbyClaims(lat, lon);
      },
      () => {
        // Fallback para pruebas de escritorio bajo techo
        setPunctualLat(CARLOS_TEJEDOR_CENTER.latitude);
        setPunctualLon(CARLOS_TEJEDOR_CENTER.longitude);
        loadNearbyClaims(CARLOS_TEJEDOR_CENTER.latitude, CARLOS_TEJEDOR_CENTER.longitude);
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  const loadNearbyClaims = async (lat: number, lon: number) => {
    if (!isOnline) return;
    const { data } = await supabase.rpc('operator_list_nearby_claims', {
      p_lat: lat,
      p_lon: lon,
      p_radius_m: 3000,
    });
    if (Array.isArray(data)) {
      setNearbyClaims(data as NearbyClaimOption[]);
    }
  };

  const openLinearFinishSheet = async (action: 'suspend' | 'submit') => {
    await drainNativeLocationBuffer();
    pauseLinearGps();

    // Limpieza geométrica de lazos, retrocesos espurios y micro-ruido de esquinas
    const cleaned = cleanTrackLoopsAndJitter(pointsRef.current);
    let cleanedDist = 0;
    for (let i = 1; i < cleaned.length; i++) {
      cleanedDist += calculateDistanceMeters(
        cleaned[i - 1].lat,
        cleaned[i - 1].lon,
        cleaned[i].lat,
        cleaned[i].lon
      );
    }
    pointsRef.current = cleaned;
    distRef.current = cleanedDist > 0 ? cleanedDist : distRef.current;
    setPoints(cleaned);
    setDistanceM(distRef.current);

    setFinishAction(action);
    setRecStatus('finishing');
    if (action === 'submit' && pointsRef.current.length > 0) {
      const lastPt = pointsRef.current[pointsRef.current.length - 1];
      loadNearbyClaims(lastPt.lat, lastPt.lon);
    }
  };

  const handlePhotoPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setGpsError(null);
    try {
      const added: Array<{ photoBlob: Blob; thumbBlob: Blob; previewUrl: string }> = [];
      for (let i = 0; i < Math.min(files.length, 3 - photos.length); i++) {
        const comp = await compressClaimPhoto(files[i]);
        added.push({
          photoBlob: comp.photoBlob,
          thumbBlob: comp.thumbBlob,
          previewUrl: comp.thumbDataUrl,
        });
      }
      setPhotos((prev) => [...prev, ...added]);
    } catch (err: any) {
      console.error('Error procesando fotografía:', err);
      setGpsError(
        `No se pudo procesar la fotografía: ${err.message || 'Error de memoria'}. Probá seleccionando otra foto o con menor resolución.`
      );
    } finally {
      e.target.value = '';
    }
  };

  const submitCurrentWork = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeWork) return;

    if (activeWork.executionMode === 'linear' && points.length < 2) {
      setGpsError('Necesitás al menos 2 puntos GPS grabados en el tramo para guardar la jornada.');
      return;
    }
    if (activeWork.executionMode === 'punctual' && (punctualLat === null || punctualLon === null)) {
      setGpsError('Necesitás capturar las coordenadas GPS del punto trabajado.');
      return;
    }

    setSubmittingWork(true);
    const sessionId = crypto.randomUUID();
    const finalInterventionId = activeWork.interventionId || crypto.randomUUID();
    const totalDuration = Math.max(1, elapsedSec);

    const outboxItem: PendingInterventionOutboxItem = {
      session_id: sessionId,
      intervention_id: finalInterventionId,
      action: activeWork.executionMode === 'punctual' ? 'submit' : finishAction,
      execution_mode: activeWork.executionMode,
      title: activeWork.isSpontaneous ? activeWork.title : null,
      description: null,
      started_at: startedAtIso || new Date().toISOString(),
      ended_at: new Date().toISOString(),
      raw_points: activeWork.executionMode === 'linear' ? points : [],
      raw_distance_m: Math.round(distanceM),
      duration_s: totalDuration,
      punctual_lat: activeWork.executionMode === 'punctual' ? punctualLat : null,
      punctual_lon: activeWork.executionMode === 'punctual' ? punctualLon : null,
      work_type_ids: activeWork.workTypeIds.length > 0 ? activeWork.workTypeIds : null,
      machine_ids: activeWork.machineIds.length > 0 ? activeWork.machineIds : null,
      participant_operator_ids:
        activeWork.participantOperatorIds.length > 0
          ? activeWork.participantOperatorIds
          : null,
      linked_claim_id: activeWork.linkedClaimId,
      photo_blobs: photos.map((p) => ({ photoBlob: p.photoBlob, thumbBlob: p.thumbBlob })),
      notes: notes.trim() || null,
      status: 'pending_sync',
      last_error: null,
      created_at: new Date().toISOString(),
    };

    await saveInterventionToOutbox(outboxItem);
    let syncedNow = false;
    if (isOnline) {
      syncedNow = await syncSingleOutboxItem(outboxItem);
    }

    setSubmittingWork(false);
    setActiveWork(null);
    setRecStatus('idle');
    await loadDataAndCache();

    setBannerMsg(
      syncedNow
        ? finishAction === 'suspend'
          ? 'Jornada guardada ("Terminar por hoy"). Quedó lista para reanudar mañana sin duplicar la tarea.'
          : '¡Trabajo enviado a validación municipal exitosamente!'
        : 'Sin señal en el campo: el parte de trabajo y sus fotos quedaron guardados en el dispositivo y se enviarán automáticamente al volver la señal.'
    );
    window.setTimeout(() => setBannerMsg(null), 6000);
  };

  // ===========================================================================
  // RENDERIZADO: MODO EJECUCIÓN EN CAMPO (ACTIVO)
  // ===========================================================================
  if (activeWork) {
    return (
      <div className="tab-pane">
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="pill-badge" style={{ background: '#fef3c7', color: '#92400e' }}>
              {activeWork.executionMode === 'linear' ? '🚜 Obra Lineal (GPS)' : '📍 Obra Puntual'}
            </span>
            {recStatus !== 'finishing' && (
              <button
                type="button"
                className="btn-outline"
                onClick={() => {
                  if (window.confirm('¿Descartar esta sesión en curso sin guardar?')) {
                    stopAllGps();
                    setActiveWork(null);
                    setRecStatus('idle');
                  }
                }}
              >
                Cancelar
              </button>
            )}
          </div>

          <h2 style={{ marginTop: 8 }}>{activeWork.title}</h2>

          {gpsError && (
            <div className="alert-box error">
              <AlertTriangle size={16} />
              <span>{gpsError}</span>
            </div>
          )}

          {/* MODO LINEAL: Grabando / Pausado */}
          {activeWork.executionMode === 'linear' && recStatus !== 'finishing' && (
            <div>
              <p className="muted-text" style={{ fontSize: 13 }}>
                Recordá activar la grabación al llegar al tramo real de trabajo (sin grabar el traslado desde el corralón). Las pasadas repetidas ida y vuelta se consolidan automáticamente sin duplicar km.
              </p>

              <div className="metrics-grid">
                <div className="metric-box">
                  <span className="metric-label">Recorrido GPS</span>
                  <strong className="metric-value">{formatDistance(distanceM)}</strong>
                </div>
                <div className="metric-box">
                  <span className="metric-label">Tiempo trabajado</span>
                  <strong className="metric-value">{formatDuration(elapsedSec)}</strong>
                </div>
                <div className="metric-box">
                  <span className="metric-label">Puntos / Precisión</span>
                  <strong className="metric-value">
                    {points.length} ({gpsAccuracy ? `${gpsAccuracy}m` : '-'})
                  </strong>
                </div>
              </div>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color: '#475569',
                  margin: '8px 0 12px',
                }}
              >
                <input
                  type="checkbox"
                  checked={useSimulator}
                  onChange={(e) => {
                    setUseSimulator(e.target.checked);
                  }}
                />
                Usar simulador de prueba (escritorio / sin movimiento real)
              </label>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  {recStatus === 'recording' ? (
                    <button type="button" className="btn-secondary" style={{ flex: 1 }} onClick={pauseLinearGps}>
                      <Pause size={18} /> Pausar GPS
                    </button>
                  ) : (
                    <button type="button" className="btn-primary" style={{ flex: 1 }} onClick={resumeLinearGps}>
                      <Play size={18} /> Reanudar GPS
                    </button>
                  )}
                </div>

                {/* Botón multi-jornada: Terminar por hoy */}
                <button
                  type="button"
                  className="btn-outline"
                  style={{ width: '100%', padding: '12px', borderColor: '#f59e0b', color: '#b45309', fontWeight: 700 }}
                  onClick={() => openLinearFinishSheet('suspend')}
                >
                  <Clock size={18} /> Terminar por hoy (Suspender y seguir otro día)
                </button>

                {/* Botón de finalización definitiva */}
                <button
                  type="button"
                  className="btn-primary"
                  style={{ width: '100%', background: '#15803d' }}
                  onClick={() => openLinearFinishSheet('submit')}
                >
                  <Square size={18} /> Finalizar Trabajo Completo
                </button>
              </div>
            </div>
          )}

          {/* FORMULARIO FINAL / PUNTUAL */}
          {recStatus === 'finishing' && (
            <form onSubmit={submitCurrentWork} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="alert-box" style={{ background: '#f8fafc', border: '1px solid #cbd5e1', color: '#0f172a' }}>
                {activeWork.executionMode === 'punctual' ? (
                  <div>
                    <strong>Ubicación puntual capturada:</strong>{' '}
                    {punctualLat && punctualLon
                      ? `${punctualLat.toFixed(5)}, ${punctualLon.toFixed(5)}`
                      : 'Obteniendo GPS...'}
                    <button
                      type="button"
                      className="btn-outline"
                      style={{ marginLeft: 8, padding: '4px 8px', fontSize: 12 }}
                      onClick={capturePunctualPoint}
                    >
                      Recapturar punto
                    </button>
                  </div>
                ) : (
                  <div>
                    <strong>
                      {finishAction === 'suspend'
                        ? '⏸️ Cierre de jornada ("Terminar por hoy")'
                        : '✅ Cierre final de intervención'}
                    </strong>
                    <div style={{ fontSize: 13 }}>
                      Puntos registrados: {points.length} • Distancia bruta: {formatDistance(distanceM)} • Duración: {formatDuration(elapsedSec)}
                    </div>
                  </div>
                )}
              </div>

              {/* Maquinaria utilizada */}
              <div>
                <label style={{ fontWeight: 600, fontSize: 13, display: 'block', marginBottom: 4 }}>
                  Maquinaria utilizada:
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {machines.map((m) => (
                    <label
                      key={m.id}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '6px 10px',
                        borderRadius: 8,
                        border: '1px solid #cbd5e1',
                        fontSize: 12,
                        background: activeWork.machineIds.includes(m.id) ? '#dcfce7' : '#fff',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={activeWork.machineIds.includes(m.id)}
                        onChange={(ev) =>
                          setActiveWork((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  machineIds: ev.target.checked
                                    ? [...prev.machineIds, m.id]
                                    : prev.machineIds.filter((id) => id !== m.id),
                                }
                              : null
                          )
                        }
                      />
                      {m.name}
                    </label>
                  ))}
                </div>
              </div>

              {/* Compañeros participantes */}
              {operators.filter((o) => !o.is_me).length > 0 && (
                <div>
                  <label style={{ fontWeight: 600, fontSize: 13, display: 'block', marginBottom: 4 }}>
                    Compañeros participantes (trabajo compartido):
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {operators
                      .filter((o) => !o.is_me)
                      .map((o) => (
                        <label
                          key={o.id}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '5px 8px',
                            borderRadius: 8,
                            border: '1px solid #cbd5e1',
                            fontSize: 12,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={activeWork.participantOperatorIds.includes(o.id)}
                            onChange={(ev) =>
                              setActiveWork((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      participantOperatorIds: ev.target.checked
                                        ? [...prev.participantOperatorIds, o.id]
                                        : prev.participantOperatorIds.filter((id) => id !== o.id),
                                    }
                                  : null
                              )
                            }
                          />
                          {o.full_name}
                        </label>
                      ))}
                  </div>
                </div>
              )}

              {/* Fotos (alcantarillas / obras puntuales o comprobantes) */}
              <div>
                <label style={{ fontWeight: 600, fontSize: 13, display: 'block', marginBottom: 4 }}>
                  Fotografías del trabajo (hasta 3, comprimidas automáticamente):
                </label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  {photos.map((ph, idx) => (
                    <div key={idx} style={{ position: 'relative' }}>
                      <img
                        src={ph.previewUrl}
                        alt="Foto obra"
                        style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8 }}
                      />
                      <button
                        type="button"
                        onClick={() => setPhotos((prev) => prev.filter((_, i) => i !== idx))}
                        style={{
                          position: 'absolute',
                          top: -4,
                          right: -4,
                          background: '#ef4444',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '50%',
                          width: 20,
                          height: 20,
                          fontSize: 12,
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {photos.length < 3 && (
                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '10px 14px',
                        borderRadius: 8,
                        border: '1px dashed #64748b',
                        cursor: 'pointer',
                        fontSize: 13,
                      }}
                    >
                      <Camera size={16} /> Sacar / Elegir Foto
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        style={{ display: 'none' }}
                        onChange={handlePhotoPick}
                      />
                    </label>
                  )}
                </div>
              </div>

              {/* Vinculación opcional con reclamo cercano */}
              {(activeWork.executionMode === 'punctual' || finishAction === 'submit') &&
                nearbyClaims.length > 0 && (
                  <div>
                    <label style={{ fontWeight: 600, fontSize: 13, display: 'block', marginBottom: 4 }}>
                      🔗 ¿Este trabajo resuelve algún reclamo cercano? (opcional)
                    </label>
                    <select
                      value={activeWork.linkedClaimId || ''}
                      onChange={(e) =>
                        setActiveWork((prev) =>
                          prev ? { ...prev, linkedClaimId: e.target.value || null } : null
                        )
                      }
                      style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #cbd5e1' }}
                    >
                      <option value="">-- Ninguno / No vincular --</option>
                      {nearbyClaims.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title} ({c.category_name} a {c.distance_m}m)
                        </option>
                      ))}
                    </select>
                  </div>
                )}

              <textarea
                rows={2}
                placeholder="Observaciones de campo (ej. lluvia, tubos colocados, material utilizado...)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #cbd5e1' }}
              />

              <div style={{ display: 'flex', gap: 8 }}>
                {activeWork.executionMode === 'linear' ? (
                  <button
                    type="button"
                    className="btn-outline"
                    onClick={() => {
                      setRecStatus('paused');
                      recStatusRef.current = 'paused';
                    }}
                    disabled={submittingWork}
                  >
                    Volver atrás
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-outline"
                    onClick={() => {
                      setActiveWork(null);
                      setRecStatus('idle');
                    }}
                    disabled={submittingWork}
                  >
                    Cancelar
                  </button>
                )}

                <button type="submit" className="btn-primary" style={{ flex: 1 }} disabled={submittingWork}>
                  <CheckCircle2 size={18} />
                  {submittingWork
                    ? 'Guardando...'
                    : finishAction === 'suspend'
                      ? 'Confirmar Pausa hasta mañana'
                      : 'Enviar Trabajo Terminado'}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Modal Temporizador de seguridad de 1 hora */}
        {showHourlyPrompt && (
          <div className="modal-backdrop">
            <div className="modal-card">
              <div className="modal-icon" style={{ background: '#fef3c7', color: '#d97706' }}>
                <Clock size={28} />
              </div>
              <h2>¿Seguís trabajando en el tramo?</h2>
              <p>
                Llevás <strong>1 hora continua</strong> grabando. Pausamos el GPS preventivamente para cuidar la batería.
              </p>
              <div className="modal-actions" style={{ flexDirection: 'column', gap: 10 }}>
                <button
                  type="button"
                  className="btn-primary"
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={() => {
                    setShowHourlyPrompt(false);
                    resumeLinearGps();
                  }}
                >
                  <Play size={18} /> Sí, seguir grabando
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={() => {
                    setShowHourlyPrompt(false);
                    openLinearFinishSheet('suspend');
                  }}
                >
                  <Pause size={18} /> Terminar por hoy (Suspender)
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ===========================================================================
  // RENDERIZADO: LISTA DE TAREAS DEL OPERARIO (FASE 11)
  // ===========================================================================
  return (
    <div className="tab-pane">
      {bannerMsg && (
        <div className="alert-box" style={{ background: '#dcfce7', color: '#166534', border: '1px solid #86efac' }}>
          <CheckCircle2 size={18} />
          <span>{bannerMsg}</span>
        </div>
      )}

      {outboxList.length > 0 && (
        <div className="alert-box warning">
          <WifiOff size={18} />
          <div style={{ flex: 1 }}>
            <strong>{outboxList.length} parte(s) pendiente(s) de envío</strong>
            <div style={{ fontSize: 12 }}>
              {isOnline ? 'Listo para sincronizar.' : 'Se enviarán al recuperar señal.'}
            </div>
          </div>
          {isOnline && (
            <button
              type="button"
              className="btn-outline"
              onClick={syncPendingInterventions}
              disabled={syncingOutbox}
            >
              {syncingOutbox ? 'Enviando...' : 'Enviar'}
            </button>
          )}
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div>
            <h2 style={{ margin: 0 }}>Lista de Tareas Viales</h2>
            <p className="muted-text" style={{ margin: 0, fontSize: 13 }}>
              Órdenes asignadas por el Municipio {isOnline ? '• En línea' : '• Modo Offline (Caché local)'}
            </p>
          </div>
          <button
            type="button"
            className="btn-outline"
            onClick={loadDataAndCache}
            disabled={loadingTasks}
          >
            <RefreshCw size={15} />
          </button>
        </div>

        <button
          type="button"
          className="btn-primary"
          style={{ width: '100%', justifyContent: 'center', marginBottom: 12 }}
          onClick={() => setShowSpontaneousModal(true)}
        >
          <Plus size={18} /> Registrar Trabajo Espontáneo (Sin orden previa)
        </button>

        {loadingTasks && tasks.length === 0 ? (
          <p className="muted-text">Cargando tus tareas asignadas...</p>
        ) : tasks.length === 0 ? (
          <p className="muted-text">
            No tenés órdenes asignadas pendientes en este momento. Podés iniciar un trabajo espontáneo con el botón de arriba.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {tasks.map((t) => {
              const isActionable = ['planned', 'suspended', 'in_progress', 'rejected'].includes(
                t.status
              );
              const isExpanded = previewTaskId === t.id;

              return (
                <div
                  key={t.id}
                  style={{
                    border: '1px solid #cbd5e1',
                    borderRadius: 12,
                    padding: 12,
                    background: t.status === 'suspended' ? '#fffbeb' : '#ffffff',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                    <div>
                      <strong style={{ fontSize: 15 }}>{t.title}</strong>
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                        {t.road_name ? `Camino: ${t.road_name}` : 'Traza en mapa'} •{' '}
                        {t.execution_mode === 'linear' ? 'Lineal (GPS)' : 'Puntual (Foto/Punto)'}
                      </div>
                    </div>
                    <span
                      className={`pill-badge`}
                      style={{
                        background:
                          t.status === 'approved'
                            ? '#dcfce7'
                            : t.status === 'suspended'
                              ? '#fef3c7'
                              : t.status === 'rejected'
                                ? '#fee2e2'
                                : '#e0f2fe',
                        color:
                          t.status === 'approved'
                            ? '#166534'
                            : t.status === 'suspended'
                              ? '#92400e'
                              : t.status === 'rejected'
                                ? '#991b1b'
                                : '#075985',
                        fontSize: 11,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {INTERVENTION_STATUS_LABELS[t.status as InterventionStatus] || t.status}
                    </span>
                  </div>

                  {t.description && (
                    <p style={{ fontSize: 13, color: '#475569', margin: '6px 0' }}>{t.description}</p>
                  )}

                  {t.review_note && t.status === 'rejected' && (
                    <div className="alert-box error" style={{ fontSize: 12, padding: '6px 10px', margin: '6px 0' }}>
                      Observación Admin: {t.review_note}
                    </div>
                  )}

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0', fontSize: 12 }}>
                    {(t.work_types || []).map((w) => (
                      <span
                        key={w.id}
                        style={{
                          background: `${w.color}22`,
                          color: w.color,
                          padding: '2px 8px',
                          borderRadius: 6,
                          fontWeight: 600,
                        }}
                      >
                        <Wrench size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} />
                        {w.name}
                      </span>
                    ))}
                    {(t.machines || []).map((m) => (
                      <span
                        key={m.id}
                        style={{
                          background: '#f1f5f9',
                          color: '#334155',
                          padding: '2px 8px',
                          borderRadius: 6,
                        }}
                      >
                        <Truck size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} />
                        {m.name}
                      </span>
                    ))}
                  </div>

                  <div style={{ fontSize: 12, color: '#475569', marginBottom: 8 }}>
                    {t.execution_mode === 'linear' && (
                      <>
                        {t.planned_length_m > 0 && (
                          <span>Planificado: {formatDistance(Number(t.planned_length_m))} • </span>
                        )}
                        <strong>
                          Trabajado ({t.sessions_count || 0} jornadas):{' '}
                          {formatDistance(Number(t.worked_length_m || 0))}
                        </strong>
                      </>
                    )}
                  </div>

                  {/* Mapa colapsable de la tarea */}
                  {(t.planned_geojson || t.worked_geojson) && (
                    <div style={{ marginBottom: 8 }}>
                      <button
                        type="button"
                        className="btn-outline"
                        style={{ width: '100%', fontSize: 12, padding: '6px' }}
                        onClick={() => setPreviewTaskId(isExpanded ? null : t.id)}
                      >
                        <MapPin size={14} /> {isExpanded ? 'Ocultar mapa del tramo' : 'Ver tramo en mapa'}
                      </button>
                      {isExpanded && (
                        <div
                          ref={previewContainerRef}
                          style={{
                            width: '100%',
                            height: 220,
                            borderRadius: 8,
                            marginTop: 6,
                            overflow: 'hidden',
                            border: '1px solid #cbd5e1',
                          }}
                        />
                      )}
                    </div>
                  )}

                  {isActionable && (
                    <button
                      type="button"
                      className="btn-primary"
                      style={{ width: '100%', justifyContent: 'center' }}
                      onClick={() => startExecution(t)}
                    >
                      {t.execution_mode === 'linear' ? (
                        <>
                          <Navigation size={16} />{' '}
                          {t.status === 'suspended' ? 'Reanudar Trabajo con GPS' : 'Ejecutar Trabajo con GPS'}
                        </>
                      ) : (
                        <>
                          <MapPin size={16} /> Registrar Punto y Fotos
                        </>
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal para Nueva Tarea Espontánea */}
      {showSpontaneousModal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h2 style={{ marginTop: 0 }}>Nuevo Trabajo Espontáneo</h2>
            <p style={{ fontSize: 13, color: '#475569' }}>
              Para trabajos urgentes o imprevistos sin orden previa.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
              <input
                type="text"
                placeholder="Título / Lugar (ej. Limpieza cruce Escuela 12)"
                value={spontTitle}
                onChange={(e) => setSpontTitle(e.target.value)}
                style={{ padding: 10, borderRadius: 8, border: '1px solid #cbd5e1' }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className={spontMode === 'linear' ? 'btn-primary' : 'btn-outline'}
                  style={{ flex: 1, fontSize: 12 }}
                  onClick={() => {
                    setSpontMode('linear');
                    setSpontWtId('');
                  }}
                >
                  <RouteIcon size={14} /> Lineal (GPS)
                </button>
                <button
                  type="button"
                  className={spontMode === 'punctual' ? 'btn-primary' : 'btn-outline'}
                  style={{ flex: 1, fontSize: 12 }}
                  onClick={() => {
                    setSpontMode('punctual');
                    setSpontWtId('');
                  }}
                >
                  <MapPin size={14} /> Puntual (Foto)
                </button>
              </div>
              <select
                value={spontWtId}
                onChange={(e) => setSpontWtId(e.target.value)}
                style={{ padding: 10, borderRadius: 8, border: '1px solid #cbd5e1' }}
              >
                <option value="">-- Tipo de trabajo --</option>
                {workTypes
                  .filter((w) => w.execution_mode === spontMode)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
              </select>
              <select
                value={spontMachId}
                onChange={(e) => setSpontMachId(e.target.value)}
                style={{ padding: 10, borderRadius: 8, border: '1px solid #cbd5e1' }}
              >
                <option value="">-- Maquinaria utilizada (opcional) --</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} {m.code ? `(${m.code})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowSpontaneousModal(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  if (!spontTitle.trim()) {
                    alert('Ingresá un nombre o referencia del lugar.');
                    return;
                  }
                  setShowSpontaneousModal(false);
                  startExecution(null, {
                    title: spontTitle.trim(),
                    mode: spontMode,
                    wtId: spontWtId,
                    machId: spontMachId,
                  });
                }}
              >
                Comenzar ahora
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
