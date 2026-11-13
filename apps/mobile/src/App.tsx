import React, { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { App as CapApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import {
  MapPin,
  Navigation,
  Pause,
  Play,
  Square,
  CheckCircle2,
  Clock,
  WifiOff,
  RefreshCw,
  LogOut,
  ShieldCheck,
  ChevronRight,
  ArrowLeft,
  Compass,
  AlertTriangle, Map as MapIcon, Bell, MessageSquareWarning, Wrench,
} from 'lucide-react';
import {
  isPointInsideCarlosTejedor,
  TRIP_STATUS_USER_LABELS,
  type AppUserRole,
  type RawGpsPoint,
  type TripStatus,
  type TripSummary, type NotificationItem,
} from '@shared';
import { supabase } from './lib/supabase';
import {
  calculateDistanceMeters,
  DEFAULT_MAX_GPS_ACCURACY_M,
  formatDistance,
  formatDuration,
  SAMPLE_TEJEDOR_ROUTES,
  buildSimulatedPoint,
  isGpsJitterOrReverse,
  cleanTrackLoopsAndJitter,
} from './lib/geo';
import {
  clearActiveRecordingSession,
  getActiveRecordingSession,
  listOutboxTrips, listOutboxClaims,
  removeTripFromOutbox,
  saveActiveRecordingSession,
  saveTripToOutbox,
  type ActiveRecordingSession,
  type PendingTripOutboxItem,
} from './lib/localDb';
import { RouteMap } from './components/RouteMap';
import { ConsolidatedRoadsMap } from './components/ConsolidatedRoadsMap';
import { ClaimsSection, syncSingleClaimOutboxItem } from './components/ClaimsSection';
import { NotificationsView } from './components/NotificationsView';
import { OperatorWorkspace } from './components/OperatorWorkspace';

// Interfaz para el plugin nativo de Servicio en Primer Plano (Foreground Service)
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

function playAlertTone() {
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
    // Audio no soportado o bloqueado
  }
}

const PAGE_SIZE = 20;
const PERMISSION_EXPLAINED_KEY = 'caminos_tejedor_gps_explained_v1';

export const App: React.FC = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [userRole, setUserRole] = useState<AppUserRole>('user');
  const [pendingInterventionsCount, setPendingInterventionsCount] = useState(0);

  const [loginError, setLoginError] = useState<string | null>(null);
  const [showMunicipalLogin, setShowMunicipalLogin] = useState(false);
  const [municipalEmail, setMunicipalEmail] = useState("");
  const [municipalPassword, setMunicipalPassword] = useState("");
  const [loggingInPassword, setLoggingInPassword] = useState(false);

  // Navegación principal
  const [activeTab, setActiveTab] = useState<'record' | 'trips' | 'map' | 'claims' | 'notifications' | 'tasks'>('record');
  const [claimIdToOpen, setClaimIdToOpen] = useState<string | null>(null);
  const [outboxClaimsCount, setOutboxClaimsCount] = useState(0);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(false);

  // Estado de red y cola offline (outbox)
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [outboxItems, setOutboxItems] = useState<PendingTripOutboxItem[]>([]);
  const [syncingOutbox, setSyncingOutbox] = useState(false);
  const [syncBannerMsg, setSyncBannerMsg] = useState<string | null>(null);

  // Explicación previa de permisos GPS
  const [gpsExplained, setGpsExplained] = useState<boolean>(
    () => localStorage.getItem(PERMISSION_EXPLAINED_KEY) === 'true'
  );
  const [showPermissionModal, setShowPermissionModal] = useState(false);

  // Temporizador de seguridad de 1 hora (60 minutos)
  const [showHourlyPrompt, setShowHourlyPrompt] = useState(false);
  const hourlyPromptDoneForHourRef = useRef<number>(0);

  // Filtro de velocidad sostenida en ruta (30 minutos a > 100 km/h)
  const highSpeedStartRef = useRef<number | null>(null);
  const nativeBgListenerRef = useRef<any>(null);

  // Estado de grabación de recorrido
  const [recordingSession, setRecordingSession] = useState<ActiveRecordingSession | null>(null);
  const [recoveredNotice, setRecoveredNotice] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [lastAccuracy, setLastAccuracy] = useState<number | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [roadNameInput, setRoadNameInput] = useState('');
  const [submittingTrip, setSubmittingTrip] = useState(false);

  // Modo simulador para pruebas en escritorio o bajo techo
  const [useSimulator, setUseSimulator] = useState(false);
  const [selectedSampleIdx, setSelectedSampleIdx] = useState(0);
  const simStepRef = useRef(0);
  const watchIdRef = useRef<number | null>(null);
  const nativeWatchIdRef = useRef<string | null>(null);
  const nativeIntervalRef = useRef<number | null>(null);
  const simIntervalRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const sessionRef = useRef<ActiveRecordingSession | null>(null);
  sessionRef.current = recordingSession;

  // Listado paginado de Mis Recorridos y Detalle
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [tripsLoading, setTripsLoading] = useState(false);
  const [tripsPage, setTripsPage] = useState(0);
  const [hasMoreTrips, setHasMoreTrips] = useState(false);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [selectedTripDetail, setSelectedTripDetail] = useState<{
    trip: TripSummary;
    coords: Array<[number, number]>;
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // 1. Inicializar sesión de Supabase y escuchar cambios
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setAuthLoading(false);
    });

    // Escuchar Deep Links en Capacitor Android (com.caminosrurales.tejedor://login-callback)
    let appUrlListener: any = null;
    if (Capacitor.isNativePlatform()) {
      appUrlListener = CapApp.addListener('appUrlOpen', async (event) => {
        const url = event.url;
        if (!url) return;

        // Cerrar inmediatamente la ventana del navegador Custom Tab
        try {
          await Browser.close();
        } catch {
          // Ya cerrado
        }

        // Caso 1: Supabase PKCE flow (?code=... o #code=...)
        const codeMatch = url.match(/[?&#]code=([^&#]+)/);
        if (codeMatch) {
          try {
            await supabase.auth.exchangeCodeForSession(decodeURIComponent(codeMatch[1]));
          } catch (err) {
            console.error('Error al intercambiar código:', err);
          }
          return;
        }

        // Caso 2: Supabase Implicit flow (#access_token=...&refresh_token=...)
        const hashIdx = url.indexOf('#');
        if (hashIdx !== -1) {
          const params = new URLSearchParams(url.substring(hashIdx + 1));
          const access_token = params.get('access_token');
          const refresh_token = params.get('refresh_token');
          if (access_token && refresh_token) {
            try {
              await supabase.auth.setSession({ access_token, refresh_token });
            } catch (err) {
              console.error('Error al restaurar sesión:', err);
            }
          }
        }
      });
    }

    return () => {
      sub.subscription.unsubscribe();
      if (appUrlListener) {
        appUrlListener.then((l: any) => l?.remove?.());
      }
    };
  }, []);

  // Detectar rol del usuario autenticado (admin / operator / user) y recuperar sesión local
  useEffect(() => {
    if (!session?.user) {
      setIsAdmin(false);
      setUserRole('user');
      return;
    }

    const roleCacheKey = `caminos_role_${session.user.id}`;
    const cachedRole = localStorage.getItem(roleCacheKey) as AppUserRole | null;
    if (cachedRole) {
      setUserRole(cachedRole);
      setIsAdmin(cachedRole === 'admin');
      if (cachedRole === 'operator') setActiveTab('tasks');
    }

    supabase.rpc('get_my_role').then(({ data, error }) => {
      if (!error && data) {
        const resolvedRole = data as AppUserRole;
        localStorage.setItem(roleCacheKey, resolvedRole);
        setUserRole(resolvedRole);
        setIsAdmin(resolvedRole === 'admin');
        if (resolvedRole === 'operator') {
          setActiveTab('tasks');
        } else if (activeTab === 'tasks') {
          setActiveTab('record');
        }
      }
    });

    // Recuperar grabación activa si la app se cerró a mitad del camino
    getActiveRecordingSession().then((saved) => {
      if (saved && saved.points.length > 0) {
        // Si estaba grabando cuando se cerró, lo dejamos en pausa para que el usuario decida reanudar o finalizar
        const recovered: ActiveRecordingSession =
          saved.status === 'recording'
            ? {
                ...saved,
                status: 'paused',
                accumulatedDurationMs:
                  saved.accumulatedDurationMs +
                  (saved.lastResumedAt ? Date.now() - saved.lastResumedAt : 0),
                lastResumedAt: null,
              }
            : saved;
        setRecordingSession(recovered);
        saveActiveRecordingSession(recovered);
        setRecoveredNotice(true);
      }
    });

    refreshOutbox();
    refreshOutbox();
    loadMyTrips(0, true);
    loadNotifications();
  }, [session?.user?.id]);

  // 2. Escuchar estado de conexión (Online / Offline) y sincronizar al volver la señal
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      syncPendingOutbox();
    };
    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [session?.user?.id]);

  // 3. Reloj de duración efectiva (ignora el tiempo en pausa) y temporizador de seguridad de 1 hora
  useEffect(() => {
    const timer = window.setInterval(() => {
      const cur = sessionRef.current;
      if (!cur) {
        setElapsedSeconds(0);
        return;
      }
      let totalSec = 0;
      if (cur.status === 'recording' && cur.lastResumedAt) {
        const totalMs = cur.accumulatedDurationMs + (Date.now() - cur.lastResumedAt);
        totalSec = Math.floor(totalMs / 1000);
        setElapsedSeconds(totalSec);
      } else {
        totalSec = Math.floor(cur.accumulatedDurationMs / 1000);
        setElapsedSeconds(totalSec);
      }

      // Temporizador de seguridad: cada 1 hora continua (3600 seg)
      if (cur.status === 'recording' && totalSec >= 3600) {
        const hourCount = Math.floor(totalSec / 3600);
        if (hourCount > hourlyPromptDoneForHourRef.current) {
          hourlyPromptDoneForHourRef.current = hourCount;
          pauseRecording();
          setShowHourlyPrompt(true);
          playAlertTone();
          if (navigator.vibrate) {
            navigator.vibrate([400, 200, 400]);
          }
        }
      }
    }, 500);

    return () => window.clearInterval(timer);
  }, []);

  const refreshOutbox = async () => {
    const items = await listOutboxTrips();
    const claimItems = await listOutboxClaims();
    setOutboxItems(items);
    setOutboxClaimsCount(claimItems.length);
    return items;
  };

  // Envía un elemento de la cola local a Supabase de forma idempotente
  const sendOutboxItemToSupabase = async (item: PendingTripOutboxItem): Promise<boolean> => {
    const { error } = await supabase.rpc('submit_trip_with_track', {
      p_trip_id: item.id,
      p_original_name: item.original_name,
      p_started_at: item.started_at,
      p_ended_at: item.ended_at,
      p_distance_m: item.distance_m,
      p_duration_s: item.duration_s,
      p_raw_points: item.raw_points,
      p_initial_road_class: null,
    });

    if (error) {
      await saveTripToOutbox({
        ...item,
        status: 'error',
        attempts: item.attempts + 1,
        last_error: error.message,
      });
      return false;
    }

    await removeTripFromOutbox(item.id);
    return true;
  };

  const syncPendingOutbox = async () => {
    if (!navigator.onLine || syncingOutbox) return;
    const items = await listOutboxTrips();
    if (items.length === 0 && (await listOutboxClaims()).length === 0) return;

    setSyncingOutbox(true);
    let sentCount = 0;
    for (const item of items) {
      const ok = await sendOutboxItemToSupabase(item);
      if (ok) sentCount++;
    }
    await refreshOutbox();
    if (session?.user?.id) {
      const claimItems = await listOutboxClaims();
      for (const cItem of claimItems) {
        const ok = await syncSingleClaimOutboxItem(session.user.id, cItem);
        if (ok) sentCount++;
      }
    }
    await refreshOutbox();
    setSyncingOutbox(false);

    if (sentCount > 0) {
      setSyncBannerMsg(
        `Se sincronizaron ${sentCount} recorrido(s) guardado(s) en el dispositivo.`
      );
      refreshOutbox();
      loadMyTrips(0, true);
      loadNotifications();
      window.setTimeout(() => setSyncBannerMsg(null), 5000);
    } else if (items.length > 0) {
      const freshItems = await listOutboxTrips();
      const firstErr = freshItems.find((i) => i.last_error)?.last_error || 'Error al conectar con el servidor';
      setSyncBannerMsg(`No se pudo sincronizar: ${firstErr}`);
      window.setTimeout(() => setSyncBannerMsg(null), 8000);
    }
  };

  // Activar WakeLock en móviles (especialmente iPhone PWA) para evitar que se apague el GPS
  const requestWakeLock = async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      }
    } catch {
      // Ignorar si el navegador no lo soporta
    }
  };

  const releaseWakeLock = async () => {
    try {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    } catch {
      // Ignorar
    }
  };

  const stopGpsWatchers = () => {
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
    if (nativeWatchIdRef.current !== null) {
      Geolocation.clearWatch({ id: nativeWatchIdRef.current });
      nativeWatchIdRef.current = null;
    }
    if (nativeIntervalRef.current !== null) {
      window.clearInterval(nativeIntervalRef.current);
      nativeIntervalRef.current = null;
    }
    if (simIntervalRef.current !== null) {
      window.clearInterval(simIntervalRef.current);
      simIntervalRef.current = null;
    }
    releaseWakeLock();
  };

  // Procesa cada punto GPS entrante y lo guarda de inmediato en IndexedDB/SQLite local
  const handleIncomingPoint = async (pt: RawGpsPoint) => {
    const cur = sessionRef.current;
    if (!cur || cur.status !== 'recording') return;

    setLastAccuracy(Math.round(pt.accuracy));

    // 1. Filtro geográfico oficial del Partido de Carlos Tejedor (con margen de 3 km)
    if (!isPointInsideCarlosTejedor(pt.lat, pt.lon, 3)) {
      pauseRecording();
      setGpsError(
        'Saliste del Partido de Carlos Tejedor (límite municipal con tolerancia de 3 km). Grabación pausada preventivamente.'
      );
      return;
    }

    // 2. Filtro de velocidad sostenida en ruta (30 minutos continuos a > 100 km/h)
    const speedKmH = pt.speed != null ? pt.speed * 3.6 : null;
    if (speedKmH != null && speedKmH > 100) {
      if (highSpeedStartRef.current === null) {
        highSpeedStartRef.current = Date.now();
      } else if (Date.now() - highSpeedStartRef.current >= 30 * 60 * 1000) {
        pauseRecording();
        setGpsError(
          'Se detectó velocidad de ruta sostenida (> 100 km/h por más de 30 minutos). Grabación pausada preventivamente.'
        );
        highSpeedStartRef.current = null;
        return;
      }
    } else if (speedKmH != null && speedKmH < 90) {
      highSpeedStartRef.current = null;
    }

    // 3. Filtrar puntos con precisión muy mala (> umbral configurable)
    if (pt.accuracy > DEFAULT_MAX_GPS_ACCURACY_M) {
      const updatedDiscarded: ActiveRecordingSession = {
        ...cur,
        discardedPointsCount: cur.discardedPointsCount + 1,
      };
      setRecordingSession(updatedDiscarded);
      await saveActiveRecordingSession(updatedDiscarded);
      return;
    }

    const prevPoint = cur.points.length > 0 ? cur.points[cur.points.length - 1] : null;
    let deltaMeters = 0;

    if (prevPoint) {
      deltaMeters = calculateDistanceMeters(prevPoint.lat, prevPoint.lon, pt.lat, pt.lon);
      // Filtro Anti-Jitter y Anti-Retroceso (evita idas y vueltas artificiales en esquinas o paradas)
      if (isGpsJitterOrReverse(cur.points, pt, deltaMeters)) {
        return;
      }
    }

    const updated: ActiveRecordingSession = {
      ...cur,
      distanceMeters: cur.distanceMeters + deltaMeters,
      points: [...cur.points, pt],
    };

    setRecordingSession(updated);
    await saveActiveRecordingSession(updated);
  };

  // Drena los puntos acumulados por el Foreground Service nativo de Android mientras la pantalla estuvo bloqueada
  const drainNativeLocationBuffer = async () => {
    if (!Capacitor.isNativePlatform() || !BackgroundGps.getBufferedLocations) return;
    try {
      const res = await BackgroundGps.getBufferedLocations();
      if (res && res.locations && res.locations.length > 0) {
        for (const loc of res.locations) {
          await handleIncomingPoint({
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
      console.warn('Error drenando buffer nativo GPS:', err);
    }
  };

  // Escuchar desbloqueo de pantalla y cambios de visibilidad para recuperar puntos acumulados
  useEffect(() => {
    const handleScreenWake = () => {
      if (document.visibilityState === 'visible' && sessionRef.current?.status === 'recording') {
        drainNativeLocationBuffer();
      }
    };

    document.addEventListener('visibilitychange', handleScreenWake);
    window.addEventListener('focus', handleScreenWake);

    const appStateSub = CapApp.addListener('appStateChange', (state: { isActive: boolean }) => {
      if (state.isActive && sessionRef.current?.status === 'recording') {
        drainNativeLocationBuffer();
      }
    });

    const drainTimer = window.setInterval(() => {
      if (sessionRef.current?.status === 'recording') {
        drainNativeLocationBuffer();
      }
    }, 2500);

    return () => {
      document.removeEventListener('visibilitychange', handleScreenWake);
      window.removeEventListener('focus', handleScreenWake);
      appStateSub.then((s: any) => s?.remove?.()).catch(() => {});
      window.clearInterval(drainTimer);
    };
  }, []);

  const startGpsCapture = (isSimulatorMode: boolean) => {
    stopGpsWatchers();
    setGpsError(null);
    requestWakeLock();

    if (isSimulatorMode) {
      const route = SAMPLE_TEJEDOR_ROUTES[selectedSampleIdx] || SAMPLE_TEJEDOR_ROUTES[0];
      // Emitir primer punto de inmediato y luego avanzar cada 1.2 segundos
      const firstCoord = route.coords[simStepRef.current % route.coords.length];
      handleIncomingPoint(buildSimulatedPoint(firstCoord[0], firstCoord[1], 5));

      simIntervalRef.current = window.setInterval(() => {
        const cur = sessionRef.current;
        if (!cur || cur.status !== 'recording') return;
        simStepRef.current = simStepRef.current + 1;
        const idx = simStepRef.current;
        if (idx < route.coords.length) {
          const [lon, lat] = route.coords[idx];
          handleIncomingPoint(buildSimulatedPoint(lon, lat, 5));
        } else {
          // Si llegó al final del camino real, recorre el camino de regreso sin salirse de la traza
          const bounceIdx =
            route.coords.length - 1 - ((idx - route.coords.length + 1) % route.coords.length);
          const [lon, lat] = route.coords[Math.max(0, bounceIdx)];
          handleIncomingPoint(buildSimulatedPoint(lon, lat, 5));
        }
      }, 900);
      return;
    }

    // Modo nativo en Android (Capacitor) con Foreground Service persistente para pantalla bloqueada
    if (Capacitor.isNativePlatform()) {
      Geolocation.requestPermissions().then(async (perm) => {
        if (perm.location === 'granted' || perm.coarseLocation === 'granted') {
          // 1. Iniciar Servicio en Primer Plano nativo de Android (Foreground Service)
          try {
            await BackgroundGps.start();
            nativeBgListenerRef.current = await BackgroundGps.addListener('onLocation', (loc) => {
              handleIncomingPoint({
                lat: loc.latitude,
                lon: loc.longitude,
                timestamp: loc.timestamp || Date.now(),
                accuracy: loc.accuracy || 5,
                altitude: loc.altitude ?? undefined,
                speed: loc.speed ?? undefined,
              });
            });
          } catch (err) {
            console.warn('Servicio nativo BackgroundGps no disponible, usando fallback:', err);
          }

          // 2. Watcher nativo de respaldo
          Geolocation.watchPosition(
            {
              enableHighAccuracy: true,
              timeout: 10000,
              maximumAge: 1000,
            },
            (pos, err) => {
              if (err) return;
              if (pos) {
                handleIncomingPoint({
                  lat: pos.coords.latitude,
                  lon: pos.coords.longitude,
                  timestamp: pos.timestamp || Date.now(),
                  accuracy: pos.coords.accuracy || 5,
                  altitude: pos.coords.altitude ?? undefined,
                  speed: pos.coords.speed ?? undefined,
                });
              }
            }
          ).then((id) => {
            nativeWatchIdRef.current = id;
          });
        } else {
          setGpsError('Permisos de GPS denegados en el dispositivo.');
        }
      });
      return;
    }

    if (!('geolocation' in navigator)) {
      setGpsError('Tu navegador o dispositivo no tiene soporte de geolocalización GPS.');
      return;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        handleIncomingPoint({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          timestamp: pos.timestamp || Date.now(),
          accuracy: pos.coords.accuracy || 10,
          altitude: pos.coords.altitude,
          speed: pos.coords.speed,
        });
      },
      (err) => {
        setGpsError(
          `No pudimos leer el GPS (${err.message}). Verificá que la ubicación esté encendida o probá con el Simulador.`
        );
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 15000,
      }
    );
  };

  const handleStartButtonClick = () => {
    if (!gpsExplained) {
      setShowPermissionModal(true);
      return;
    }
    beginNewRecording();
  };

  const acceptPermissionExplanation = () => {
    localStorage.setItem(PERMISSION_EXPLAINED_KEY, 'true');
    setGpsExplained(true);
    setShowPermissionModal(false);
    beginNewRecording();
  };

  const beginNewRecording = async () => {
    simStepRef.current = 0;
    hourlyPromptDoneForHourRef.current = 0;
    highSpeedStartRef.current = null;
    setShowHourlyPrompt(false);
    const newSession: ActiveRecordingSession = {
      id: 'current',
      tripUuid: crypto.randomUUID(),
      status: 'recording',
      startedAt: new Date().toISOString(),
      lastResumedAt: Date.now(),
      accumulatedDurationMs: 0,
      distanceMeters: 0,
      points: [],
      discardedPointsCount: 0,
    };

    if (useSimulator) {
      const sample = SAMPLE_TEJEDOR_ROUTES[selectedSampleIdx];
      if (sample) setRoadNameInput(sample.name);
    } else {
      setRoadNameInput('');
    }

    setRecoveredNotice(false);
    setRecordingSession(newSession);
    await saveActiveRecordingSession(newSession);
    startGpsCapture(useSimulator);
  };

  const pauseRecording = async () => {
    if (!recordingSession || recordingSession.status !== 'recording') return;
    await drainNativeLocationBuffer();
    stopGpsWatchers();
    const additionalMs = recordingSession.lastResumedAt
      ? Date.now() - recordingSession.lastResumedAt
      : 0;
    const paused: ActiveRecordingSession = {
      ...recordingSession,
      status: 'paused',
      accumulatedDurationMs: recordingSession.accumulatedDurationMs + additionalMs,
      lastResumedAt: null,
    };
    setRecordingSession(paused);
    await saveActiveRecordingSession(paused);
  };

  const resumeRecording = async () => {
    if (!recordingSession || recordingSession.status !== 'paused') return;
    const resumed: ActiveRecordingSession = {
      ...recordingSession,
      status: 'recording',
      lastResumedAt: Date.now(),
    };
    setRecoveredNotice(false);
    setRecordingSession(resumed);
    await saveActiveRecordingSession(resumed);
    startGpsCapture(useSimulator);
  };

  const finishToConfirmation = async () => {
    if (!recordingSession) return;
    await drainNativeLocationBuffer();
    stopGpsWatchers();
    const additionalMs =
      recordingSession.status === 'recording' && recordingSession.lastResumedAt
        ? Date.now() - recordingSession.lastResumedAt
        : 0;

    // Limpieza geométrica de lazos, rebotes y micro-ruido de esquinas antes de confirmar
    const cleaned = cleanTrackLoopsAndJitter(recordingSession.points);
    let cleanedDistance = 0;
    for (let i = 1; i < cleaned.length; i++) {
      cleanedDistance += calculateDistanceMeters(
        cleaned[i - 1].lat,
        cleaned[i - 1].lon,
        cleaned[i].lat,
        cleaned[i].lon
      );
    }

    const confirming: ActiveRecordingSession = {
      ...recordingSession,
      status: 'confirming',
      accumulatedDurationMs: recordingSession.accumulatedDurationMs + additionalMs,
      lastResumedAt: null,
      points: cleaned,
      distanceMeters: cleanedDistance > 0 ? cleanedDistance : recordingSession.distanceMeters,
    };
    setRecordingSession(confirming);
    await saveActiveRecordingSession(confirming);
  };

  const cancelAndDiscardRecording = async () => {
    stopGpsWatchers();
    await clearActiveRecordingSession();
    setRecordingSession(null);
    setRecoveredNotice(false);
    setGpsError(null);
    setShowHourlyPrompt(false);
    hourlyPromptDoneForHourRef.current = 0;
    highSpeedStartRef.current = null;
  };

  const confirmAndSaveTrip = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recordingSession) return;
    if (recordingSession.points.length < 2) {
      setGpsError('Necesitás al menos 2 puntos GPS grabados para guardar el camino.');
      return;
    }

    setSubmittingTrip(true);
    const endedAt = new Date().toISOString();
    const durationSec = Math.max(1, Math.round(recordingSession.accumulatedDurationMs / 1000));
    const cleanName = roadNameInput.trim() || 'Camino rural sin nombre';

    const outboxItem: PendingTripOutboxItem = {
      id: recordingSession.tripUuid,
      original_name: cleanName,
      started_at: recordingSession.startedAt,
      ended_at: endedAt,
      distance_m: Number(recordingSession.distanceMeters.toFixed(2)),
      duration_s: durationSec,
      raw_points: recordingSession.points,
      status: 'pending_sync',
      attempts: 0,
      last_error: null,
      created_at: endedAt,
    };

    // 1. Primero guardar en el dispositivo (para no perder jamás el recorrido si se corta internet)
    await saveTripToOutbox(outboxItem);
    await clearActiveRecordingSession();
    setRecordingSession(null);

    // 2. Si hay señal, intentar enviarlo ahora mismo a Supabase
    if (navigator.onLine) {
      const sent = await sendOutboxItemToSupabase(outboxItem);
      if (sent) {
        setSyncBannerMsg(
          isAdmin
            ? '¡Recorrido guardado y aprobado automáticamente (cuenta Administrador)!'
            : '¡Recorrido enviado correctamente! Quedó en estado "En revisión".'
        );
      } else {
        setSyncBannerMsg(
          'Sin respuesta del servidor: el recorrido quedó guardado en tu teléfono y se enviará al recuperar señal.'
        );
      }
    } else {
      setSyncBannerMsg(
        'Estás sin señal: el recorrido quedó guardado en tu teléfono y se enviará automáticamente al recuperar conexión.'
      );
    }

    await refreshOutbox();
    await loadMyTrips(0, true);
    setSubmittingTrip(false);
    setActiveTab('trips');
    window.setTimeout(() => setSyncBannerMsg(null), 7000);
  };

  const loadNotifications = async () => {
    if (!session?.user) return;
    setNotificationsLoading(true);
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
      .limit(40);
    if (!error && data) {
      setNotifications(data as NotificationItem[]);
    }
    setNotificationsLoading(false);
  };

  const handleMarkOneRead = async (notifId: string, claimId: string | null) => {
    await supabase.rpc('mark_notifications_read', {
      p_notification_id: notifId,
      p_mark_all: false,
    });
    setNotifications((prev) =>
      prev.map((n) => (n.id === notifId ? { ...n, is_read: true } : n))
    );
    if (claimId) {
      setClaimIdToOpen(claimId);
      setActiveTab('claims');
    }
  };

  const handleMarkAllRead = async () => {
    await supabase.rpc('mark_notifications_read', {
      p_notification_id: null,
      p_mark_all: true,
    });
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
  };

  // Cargar listado liviano de "Mis recorridos" (paginado de a 20, sin descargar trazas)
  const loadMyTrips = async (pageIndex: number, replace = false) => {
    if (!session?.user) return;
    setTripsLoading(true);
    const from = pageIndex * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data, error } = await supabase
      .from('trips')
      .select('id, original_name, started_at, ended_at, distance_m, duration_s, status, created_at')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
      .range(from, to);

    if (!error && data) {
      const typed = data as TripSummary[];
      setTrips((prev) => (replace ? typed : [...prev, ...typed]));
      setTripsPage(pageIndex);
      setHasMoreTrips(typed.length === PAGE_SIZE);
    }
    setTripsLoading(false);
  };

  // Cargar detalle de un recorrido y su traza simplificada desde el servidor
  const openTripDetail = async (trip: TripSummary) => {
    setSelectedTripId(trip.id);
    setDetailLoading(true);
    const { data, error } = await supabase.rpc('get_trip_detail_geojson', {
      p_trip_id: trip.id,
      p_include_full_track: false,
    });

    if (!error && data?.simplified_geojson?.coordinates) {
      setSelectedTripDetail({
        trip,
        coords: data.simplified_geojson.coordinates as Array<[number, number]>,
      });
    } else {
      setSelectedTripDetail({ trip, coords: [] });
    }
    setDetailLoading(false);
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!municipalEmail.trim() || !municipalPassword) return;
    setLoggingInPassword(true);
    setLoginError(null);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: municipalEmail.trim(),
      password: municipalPassword,
    });
    setLoggingInPassword(false);
    if (error) {
      setLoginError('Credenciales incorrectas: verifique correo y contraseña.');
    } else if (data?.session) {
      setSession(data.session);
    }
  };

  const handleGoogleLogin = async () => {
    setLoginError(null);
    try {
      if (Capacitor.isNativePlatform()) {
        const { data, error } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: 'https://caminosruralestejedor.netlify.app/auth-callback.html',
            skipBrowserRedirect: true,
          },
        });
        if (error) {
          setLoginError(error.message);
          return;
        }
        if (data?.url) {
          try {
            await Browser.open({ url: data.url, windowName: '_self' });
          } catch {
            window.location.href = data.url;
          }
        }
      } else {
        const { error } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: window.location.origin,
          },
        });
        if (error) setLoginError(error.message);
      }
    } catch (err: any) {
      setLoginError(err?.message || 'Error al conectar con Google');
    }
  };

  const handleLogout = async () => {
    stopGpsWatchers();
    await supabase.auth.signOut();
  };

  const openAdminPanel = async () => {
    let adminUrl = 'https://caminosruralestejedor.netlify.app/admin';
    if (session?.access_token && session?.refresh_token) {
      adminUrl += `#access_token=${encodeURIComponent(session.access_token)}&refresh_token=${encodeURIComponent(session.refresh_token)}&type=sso`;
    }
    try {
      if (Capacitor.isNativePlatform()) {
        await Browser.open({ url: adminUrl, windowName: '_system' });
      } else {
        window.open(adminUrl, '_blank');
      }
    } catch {
      window.open(adminUrl, '_system');
    }
  };

  if (authLoading) {
    return (
      <div className="app-shell centered">
        <div className="spinner" />
        <p>Cargando Caminos Rurales...</p>
      </div>
    );
  }

  // PANTALLA DE LOGIN
  if (!session) {
    return (
      <div className="app-shell login-screen">
        <div className="login-card">
          <div className="brand-badge" style={{ background: 'transparent', padding: 0 }}>
            <img src="/favicon.svg" alt="Caminos Rurales Carlos Tejedor" style={{ width: 68, height: 68, borderRadius: 15 }} />
          </div>
          <h1>Caminos Rurales</h1>
          <p className="subtitle">Partido de Carlos Tejedor</p>
          <p className="login-desc">
            Relevamiento colaborativo de la red vial rural. Grabá tus recorridos en el campo aún sin señal y ayudá a mantener actualizado el mapa del partido.
          </p>

          {loginError && <div className="alert-box error">{loginError}</div>}

          <button type="button" className="btn-google" onClick={handleGoogleLogin}>
            <svg width="20" height="20" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z"
              />
              <path
                fill="#FBBC05"
                d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z"
              />
              <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z"
              />
            </svg>
            Continuar con Google
          </button>

          <div style={{ marginTop: 24, textAlign: 'center' }}>
            {!showMunicipalLogin ? (
              <button
                type="button"
                onClick={() => setShowMunicipalLogin(true)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--primary, #047857)',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  padding: '8px 12px',
                }}
              >
                ¿Sos personal municipal? Ingresar con usuario y clave
              </button>
            ) : (
              <form
                onSubmit={handlePasswordLogin}
                style={{
                  marginTop: 12,
                  padding: '16px',
                  background: '#f8fafc',
                  borderRadius: '12px',
                  border: '1px solid #e2e8f0',
                  textAlign: 'left',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                }}
              >
                <div style={{ fontSize: '0.84rem', fontWeight: 700, color: '#334155' }}>
                  Ingreso de Personal Municipal (Admin y Operarios)
                </div>
                <input
                  type="email"
                  required
                  placeholder="Correo institucional"
                  value={municipalEmail}
                  onChange={(e) => setMunicipalEmail(e.target.value)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.9rem',
                    background: '#ffffff',
                  }}
                />
                <input
                  type="password"
                  required
                  placeholder="Contraseña"
                  value={municipalPassword}
                  onChange={(e) => setMunicipalPassword(e.target.value)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.9rem',
                    background: '#ffffff',
                  }}
                />
                <button
                  type="submit"
                  disabled={loggingInPassword}
                  className="btn-primary"
                  style={{ padding: '10px', fontSize: '0.9rem', fontWeight: 700 }}
                >
                  {loggingInPassword ? 'Ingresando...' : 'Iniciar Sesión'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowMunicipalLogin(false)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#64748b',
                    fontSize: '0.78rem',
                    cursor: 'pointer',
                    textAlign: 'center',
                    marginTop: 4,
                  }}
                >
                  Volver al ingreso para vecinos
                </button>
              </form>
            )}
          </div>

        </div>
      </div>
    );
  }

  const liveCoords: Array<[number, number]> = recordingSession
    ? recordingSession.points.map((p) => [p.lon, p.lat])
    : [];

  return (
    <div className="app-shell">
      {/* Encabezado Superior */}
      <header className="top-bar">
        <div>
          <div className="top-bar-title">
            <img src="/favicon.svg" alt="" style={{ width: 24, height: 24, borderRadius: 6 }} />
            <span>Caminos Tejedor</span>
          </div>
          <span className="user-email-sub">{session.user.email}</span>
            {isAdmin && (
              <>
                <span
                  style={{
                    marginLeft: 6,
                    background: '#10b981',
                    color: '#ffffff',
                    fontSize: '10px',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    fontWeight: 700,
                  }}
                >
                  ADMIN
                </span>
                <button
                  type="button"
                  onClick={openAdminPanel}
                  style={{
                    marginLeft: 6,
                    background: '#f59e0b',
                    color: '#1f2937',
                    border: 'none',
                    borderRadius: '4px',
                    padding: '2px 8px',
                    fontSize: '10px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                  }}
                  title="Abrir Panel de Control Web en el navegador"
                >
                  Panel Web ↗
                </button>
              </>
            )}
            {userRole === 'operator' && (
              <span
                style={{
                  marginLeft: 6,
                  background: '#2563eb',
                  color: '#ffffff',
                  fontSize: '10px',
                  padding: '2px 7px',
                  borderRadius: '4px',
                  fontWeight: 700,
                }}
              >
                OPERARIO
              </span>
            )}
        </div>
        <div className="inline-btns">
          <button
            type="button"
            className="icon-btn notif-top-btn"
            onClick={() => {
              loadNotifications();
              setActiveTab('notifications');
            }}
            title="Avisos"
          >
            <Bell size={18} />
            {notifications.filter((n) => !n.is_read).length > 0 && (
              <span className="notif-badge">
                {notifications.filter((n) => !n.is_read).length}
              </span>
            )}
          </button>
          <button type="button" className="icon-btn" onClick={handleLogout} title="Cerrar sesión">
          <LogOut size={18} />
        </button>
        </div>
      </header>

      {/* Banner de Modo Sin Señal (Offline) y Cola de Envío */}
      {!isOnline && (
        <div className="offline-banner">
          <WifiOff size={18} />
          <div>
            <strong>Sin señal de internet</strong>
            <p>
              Podés seguir grabando tranquilo: todo se guarda en tu teléfono y se subirá cuando recuperes conexión.
            </p>
          </div>
        </div>
      )}

      {(outboxItems.length > 0 || outboxClaimsCount > 0) && (
        <div className="outbox-banner">
          <div>
            <strong>
              {outboxItems.length + outboxClaimsCount} elemento(s) guardado(s) en el teléfono esperando señal
            </strong>
            <p>No se pierde ningún dato aunque cierres la aplicación.</p>
            {outboxItems.map(
              (item) =>
                item.last_error && (
                  <p key={item.id} style={{ color: '#dc2626', fontSize: '13px', marginTop: '6px', fontWeight: 600 }}>
                    ⚠️ {item.original_name} ({item.raw_points?.length || 0} pts): {item.last_error}
                  </p>
                )
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-small"
              disabled={!isOnline || syncingOutbox}
              onClick={syncPendingOutbox}
            >
              <RefreshCw size={14} className={syncingOutbox ? 'spin' : ''} />
              {syncingOutbox ? 'Enviando...' : 'Reintentar'}
            </button>
            {outboxItems.some((i) => i.status === 'error' || i.last_error) && (
              <button
                type="button"
                className="btn-small"
                style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}
                onClick={async () => {
                  if (window.confirm('¿Deseás descartar los recorridos con error guardados en el teléfono?')) {
                    for (const i of outboxItems) {
                      await removeTripFromOutbox(i.id);
                    }
                    await refreshOutbox();
                  }
                }}
              >
                Descartar
              </button>
            )}
          </div>
        </div>
      )}

      {syncBannerMsg && (
        <div className="sync-toast">
          <CheckCircle2 size={18} />
          <span>{syncBannerMsg}</span>
        </div>
      )}

      {/* Modal explicativo ANTES de pedir permisos de GPS */}
      {showPermissionModal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-icon">
              <MapPin size={28} />
            </div>
            <h2>Permiso de ubicación GPS</h2>
            <p>
              Antes de activar el GPS de tu teléfono, te explicamos claramente cómo se utiliza:
            </p>
            <ul className="permission-list">
              <li>
                <strong>¿Para qué se usa?</strong> Únicamente para dibujar la traza del camino rural mientras grabás un recorrido.
              </li>
              <li>
                <strong>Segundo plano y pantalla:</strong> Funciona solo mientras tenés una grabación en curso. Podés pausarla o finalizarla cuando quieras.
              </li>
              <li>
                <strong>Privacidad:</strong> Tu nombre y correo son datos internos y nunca se muestran públicamente en el mapa.
              </li>
            </ul>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowPermissionModal(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={acceptPermissionExplanation}
              >
                Entendido, activar GPS
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de confirmación tras 1 hora continua de grabación (Temporizador de seguridad) */}
      {showHourlyPrompt && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-icon" style={{ background: '#fef3c7', color: '#d97706' }}>
              <Clock size={28} />
            </div>
            <h2>¿Seguís en el camino?</h2>
            <p>
              Llevás <strong>1 hora continua</strong> grabando el recorrido. Pausamos el GPS de forma preventiva para cuidar la batería de tu teléfono.
            </p>
            <p style={{ marginTop: -6, fontSize: 13, color: '#64748b' }}>
              ¿Querés continuar grabando o guardar lo recorrido hasta este punto?
            </p>
            <div className="modal-actions" style={{ flexDirection: 'column', gap: 10 }}>
              <button
                type="button"
                className="btn-primary"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => {
                  setShowHourlyPrompt(false);
                  resumeRecording();
                }}
              >
                <Play size={18} /> Sí, seguir grabando
              </button>
              <button
                type="button"
                className="btn-danger"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => {
                  setShowHourlyPrompt(false);
                  finishToConfirmation();
                }}
              >
                <Square size={18} /> No, guardar recorrido
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Contenido Principal */}
      <main className="main-content">
        {activeTab === 'record' && (
          <div className="tab-pane">
            {recoveredNotice && recordingSession && (
              <div className="alert-box warning">
                <AlertTriangle size={18} />
                <span>
                  Recuperamos tu recorrido en curso con{' '}
                  <strong>{recordingSession.points.length} puntos</strong> guardados en el teléfono antes de que se cerrara la app.
                </span>
              </div>
            )}

            {gpsError && (
              <div className="alert-box error">
                <AlertTriangle size={18} />
                <span>{gpsError}</span>
              </div>
            )}

            {/* ESTADO 1: Sin grabación activa */}
            {!recordingSession && (
              <div className="card start-recording-card">
                <h2>Registrar un camino rural</h2>
                <p className="muted-text">
                  Iniciá la grabación al entrar al camino rural. Cada punto GPS se guarda en el acto en la memoria de tu teléfono.
                </p>

                <RouteMap coordinates={[]} height="230px" />

                <button
                  type="button"
                  className="btn-record-start"
                  onClick={handleStartButtonClick}
                >
                  <Play size={22} fill="currentColor" />
                  Iniciar grabación de recorrido
                </button>
              </div>
            )}

            {/* ESTADO 2: Grabando o En Pausa */}
            {recordingSession && recordingSession.status !== 'confirming' && (
              <div className="card active-recording-card">
                <div className="status-header">
                  <span
                    className={`rec-badge ${
                      recordingSession.status === 'recording' ? 'live' : 'paused'
                    }`}
                  >
                    {recordingSession.status === 'recording'
                      ? '● GRABANDO CAMINO'
                      : '❚❚ EN PAUSA (no suma distancia ni tiempo)'}
                  </span>
                  {lastAccuracy !== null && (
                    <span className="accuracy-chip">Precisión GPS: ±{lastAccuracy} m</span>
                  )}
                </div>

                <div className="metrics-grid">
                  <div className="metric-box">
                    <span className="metric-label">Distancia</span>
                    <span className="metric-value">
                      {formatDistance(recordingSession.distanceMeters)}
                    </span>
                  </div>
                  <div className="metric-box">
                    <span className="metric-label">Duración efectiva</span>
                    <span className="metric-value">{formatDuration(elapsedSeconds)}</span>
                  </div>
                  <div className="metric-box">
                    <span className="metric-label">Puntos guardados</span>
                    <span className="metric-value">{recordingSession.points.length}</span>
                  </div>
                </div>

                <RouteMap coordinates={liveCoords} height="250px" followLastPoint />

                <div className="recording-controls">
                  {recordingSession.status === 'recording' ? (
                    <button
                      type="button"
                      className="btn-warning"
                      onClick={pauseRecording}
                    >
                      <Pause size={20} />
                      Pausar
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={resumeRecording}
                    >
                      <Play size={20} />
                      Reanudar
                    </button>
                  )}

                  <button
                    type="button"
                    className="btn-danger"
                    onClick={finishToConfirmation}
                    disabled={recordingSession.points.length < 2}
                  >
                    <Square size={20} fill="currentColor" />
                    Finalizar
                  </button>
                </div>

                {recordingSession.points.length < 2 && (
                  <p className="hint-center">
                    Esperando al menos 2 puntos GPS para habilitar Finalizar...
                  </p>
                )}

                <button
                  type="button"
                  className="btn-text-cancel"
                  onClick={cancelAndDiscardRecording}
                >
                  Descartar esta grabación
                </button>
              </div>
            )}

            {/* ESTADO 3: Pantalla de Confirmación al finalizar */}
            {recordingSession && recordingSession.status === 'confirming' && (
              <form className="card confirm-card" onSubmit={confirmAndSaveTrip}>
                <h2>Confirmar recorrido</h2>
                <p className="muted-text">
                  Revisá los datos del tramo grabado y ponele el nombre con el que conocés este camino.
                </p>

                <div className="metrics-grid">
                  <div className="metric-box">
                    <span className="metric-label">Distancia total</span>
                    <span className="metric-value">
                      {formatDistance(recordingSession.distanceMeters)}
                    </span>
                  </div>
                  <div className="metric-box">
                    <span className="metric-label">Duración</span>
                    <span className="metric-value">
                      {formatDuration(Math.round(recordingSession.accumulatedDurationMs / 1000))}
                    </span>
                  </div>
                  <div className="metric-box">
                    <span className="metric-label">Fecha y hora</span>
                    <span className="metric-value-sm">
                      {new Date(recordingSession.startedAt).toLocaleString('es-AR', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                </div>

                <RouteMap coordinates={liveCoords} height="220px" />

                <label className="field-label">
                  Nombre del camino rural
                  <input
                    type="text"
                    required
                    placeholder="Ej.: Camino Real a Timote / Bajada La Larga"
                    value={roadNameInput}
                    onChange={(e) => setRoadNameInput(e.target.value)}
                  />
                </label>

                <div className="confirm-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={resumeRecording}
                    disabled={submittingTrip}
                  >
                    Seguir grabando
                  </button>
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={submittingTrip}
                  >
                    {submittingTrip ? 'Guardando...' : 'Confirmar y Enviar'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* PESTAÑA 2: MIS RECORRIDOS Y DETALLE */}
        {activeTab === 'trips' && (
          <div className="tab-pane">
            {selectedTripId && selectedTripDetail ? (
              <div className="card detail-card">
                <button
                  type="button"
                  className="btn-back"
                  onClick={() => {
                    setSelectedTripId(null);
                    setSelectedTripDetail(null);
                  }}
                >
                  <ArrowLeft size={18} /> Volver a Mis recorridos
                </button>

                <div className="trip-detail-header">
                  <h2>{selectedTripDetail.trip.original_name}</h2>
                  <span className={`status-pill status-${selectedTripDetail.trip.status}`}>
                    {TRIP_STATUS_USER_LABELS[selectedTripDetail.trip.status as TripStatus]}
                  </span>
                </div>

                <div className="metrics-grid">
                  <div className="metric-box">
                    <span className="metric-label">Distancia</span>
                    <span className="metric-value">
                      {formatDistance(Number(selectedTripDetail.trip.distance_m))}
                    </span>
                  </div>
                  <div className="metric-box">
                    <span className="metric-label">Duración</span>
                    <span className="metric-value">
                      {formatDuration(selectedTripDetail.trip.duration_s)}
                    </span>
                  </div>
                  <div className="metric-box">
                    <span className="metric-label">Fecha</span>
                    <span className="metric-value-sm">
                      {new Date(selectedTripDetail.trip.started_at).toLocaleDateString('es-AR')}
                    </span>
                  </div>
                </div>

                {detailLoading ? (
                  <div className="centered-pad">Cargando traza simplificada en el mapa...</div>
                ) : (
                  <RouteMap coordinates={selectedTripDetail.coords} height="320px" />
                )}
              </div>
            ) : (
              <div className="trips-list-container">
                <div className="section-header">
                  <h2>Mis recorridos</h2>
                  <button
                    type="button"
                    className="btn-small"
                    onClick={() => loadMyTrips(0, true)}
                  >
                    <RefreshCw size={14} /> Actualizar
                  </button>
                </div>

                {/* Recorridos guardados localmente sin señal */}
                {outboxItems.map((item) => (
                  <div key={item.id} className="trip-row outbox-row">
                    <div>
                      <h4>{item.original_name}</h4>
                      <span className="trip-meta">
                        {formatDistance(item.distance_m)} • {formatDuration(item.duration_s)} •{' '}
                        {new Date(item.started_at).toLocaleString('es-AR', {
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <span className="status-pill status-offline">
                      Guardado en el celular (sin señal)
                    </span>
                  </div>
                ))}

                {/* Recorridos sincronizados en Supabase */}
                {trips.length === 0 && outboxItems.length === 0 && !tripsLoading && (
                  <div className="card empty-state">
                    <Clock size={32} />
                    <p>Todavía no tenés recorridos registrados.</p>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => setActiveTab('record')}
                    >
                      Grabar mi primer recorrido
                    </button>
                  </div>
                )}

                {trips.map((trip) => (
                  <button
                    key={trip.id}
                    type="button"
                    className="trip-row"
                    onClick={() => openTripDetail(trip)}
                  >
                    <div className="trip-row-left">
                      <h4>{trip.original_name}</h4>
                      <span className="trip-meta">
                        {formatDistance(Number(trip.distance_m))} •{' '}
                        {formatDuration(trip.duration_s)} •{' '}
                        {new Date(trip.started_at).toLocaleDateString('es-AR')}
                      </span>
                    </div>
                    <div className="trip-row-right">
                      <span className={`status-pill status-${trip.status}`}>
                        {TRIP_STATUS_USER_LABELS[trip.status]}
                      </span>
                      <ChevronRight size={18} />
                    </div>
                  </button>
                ))}

                {hasMoreTrips && (
                  <button
                    type="button"
                    className="btn-secondary full-width"
                    disabled={tripsLoading}
                    onClick={() => loadMyTrips(tripsPage + 1, false)}
                  >
                    {tripsLoading ? 'Cargando...' : 'Cargar más recorridos'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {activeTab === 'map' && (
          <div className="tab-pane">
            <ConsolidatedRoadsMap />
          </div>
        )}
        {activeTab === 'claims' && (
          <div className="tab-pane">
            <ClaimsSection
              userId={session.user.id}
              isOnline={isOnline}
              onOutboxChange={refreshOutbox}
              onNotifyToast={(msg) => {
                setSyncBannerMsg(msg);
                loadNotifications();
                window.setTimeout(() => setSyncBannerMsg(null), 6500);
              }}
              initialClaimIdToOpen={claimIdToOpen}
              onClearInitialClaimId={() => setClaimIdToOpen(null)}
            />
          </div>
        )}
        {activeTab === 'tasks' && (
          <OperatorWorkspace
            userId={session.user.id}
            isOnline={isOnline}
            onSyncPendingChange={(cnt) => setPendingInterventionsCount(cnt)}
          />
        )}
        {activeTab === 'notifications' && (
          <div className="tab-pane">
            <NotificationsView
              notifications={notifications}
              loading={notificationsLoading}
              onRefresh={loadNotifications}
              onMarkOneRead={handleMarkOneRead}
              onMarkAllRead={handleMarkAllRead}
            />
          </div>
        )}
      </main>

      {/* Barra de Navegación Inferior */}
      <nav className="bottom-nav">
        {userRole === 'operator' ? (
          <>
            <button
              type="button"
              className={activeTab === 'tasks' ? 'nav-item active' : 'nav-item'}
              onClick={() => setActiveTab('tasks')}
            >
              <div className="nav-icon-wrap">
                <Wrench size={20} />
                {pendingInterventionsCount > 0 && (
                  <span className="nav-unread-badge">{pendingInterventionsCount}</span>
                )}
              </div>
              <span>Mis Tareas</span>
            </button>
            <button
              type="button"
              className={activeTab === 'map' ? 'nav-item active' : 'nav-item'}
              onClick={() => setActiveTab('map')}
            >
              <MapIcon size={20} />
              <span>Mapa</span>
            </button>
            <button
              type="button"
              className={activeTab === 'notifications' ? 'nav-item active' : 'nav-item'}
              onClick={() => {
                loadNotifications();
                setActiveTab('notifications');
              }}
            >
              <div className="nav-icon-wrap">
                <Bell size={20} />
                {notifications.filter((n) => !n.is_read).length > 0 && (
                  <span className="nav-unread-badge">
                    {notifications.filter((n) => !n.is_read).length}
                  </span>
                )}
              </div>
              <span>Avisos</span>
            </button>
          </>
        ) : (
          <>
        <button
          type="button"
          className={activeTab === 'record' ? 'nav-item active' : 'nav-item'}
          onClick={() => setActiveTab('record')}
        >
          <Navigation size={20} />
          <span>Grabar camino</span>
        </button>
        <button
          type="button"
          className={activeTab === 'trips' ? 'nav-item active' : 'nav-item'}
          onClick={() => {
            setSelectedTripId(null);
            setActiveTab('trips');
          }}
        >
          <Clock size={20} />
          <span>Mis recorridos</span>
        </button>
        <button
          type="button"
          className={activeTab === 'map' ? 'nav-item active' : 'nav-item'}
          onClick={() => setActiveTab('map')}
        >
          <MapIcon size={20} />
          <span>Mapa</span>
        </button>
        <button
          type="button"
          className={activeTab === 'claims' ? 'nav-item active' : 'nav-item'}
          onClick={() => setActiveTab('claims')}
        >
          <MessageSquareWarning size={20} />
          <span>Reclamos</span>
        </button>
        <button
          type="button"
          className={activeTab === 'notifications' ? 'nav-item active' : 'nav-item'}
          onClick={() => {
            loadNotifications();
            setActiveTab('notifications');
          }}
        >
          <div className="nav-icon-wrap">
            <Bell size={20} />
            {notifications.filter((n) => !n.is_read).length > 0 && (
              <span className="nav-unread-badge">
                {notifications.filter((n) => !n.is_read).length}
              </span>
            )}
          </div>
          <span>Avisos</span>
        </button>
          </>
        )}
      </nav>
    </div>
  );
};
