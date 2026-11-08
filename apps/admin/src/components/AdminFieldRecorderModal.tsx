import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Navigation, Pause, Play, ShieldCheck, Square, X } from 'lucide-react';
import { CARLOS_TEJEDOR_CENTER, type RawGpsPoint, type RoadClass, ROAD_CLASS_LABELS } from '@shared';
import {
  DEFAULT_MAX_GPS_ACCURACY_M,
  SAMPLE_TEJEDOR_ROUTES,
  buildSimulatedPoint,
  calculateDistanceMeters,
  formatDistance,
  formatDuration,
} from '../lib/geo';
import { getBaseMapStyle, supabase } from '../lib/supabase';

interface AdminFieldRecorderModalProps {
  onClose: () => void;
  onTripCreated: (msg: string) => void;
}

export const AdminFieldRecorderModal: React.FC<AdminFieldRecorderModalProps> = ({
  onClose,
  onTripCreated,
}) => {
  const [useSimulator, setUseSimulator] = useState(true);
  const [selectedSampleIdx, setSelectedSampleIdx] = useState(0);
  const [status, setStatus] = useState<'idle' | 'recording' | 'paused' | 'confirming'>('idle');
  const [points, setPoints] = useState<RawGpsPoint[]>([]);
  const [distanceMeters, setDistanceMeters] = useState(0);
  const [startedAt, setStartedAt] = useState<string>('');
  const [accumulatedMs, setAccumulatedMs] = useState(0);
  const [lastResumedAt, setLastResumedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [roadName, setRoadName] = useState('');
  const [roadClass, setRoadClass] = useState<RoadClass>('troncal');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const simStepRef = useRef(0);
  const simTimerRef = useRef<number | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const pointsRef = useRef<RawGpsPoint[]>(points);
  pointsRef.current = points;
  const distRef = useRef(distanceMeters);
  distRef.current = distanceMeters;

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (status === 'recording' && lastResumedAt !== null) {
        const totalMs = accumulatedMs + (Date.now() - lastResumedAt);
        setElapsedSeconds(Math.floor(totalMs / 1000));
      } else {
        setElapsedSeconds(Math.floor(accumulatedMs / 1000));
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [status, accumulatedMs, lastResumedAt]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: getBaseMapStyle() as string | maplibregl.StyleSpecification,
      center: [CARLOS_TEJEDOR_CENTER.longitude, CARLOS_TEJEDOR_CENTER.latitude],
      zoom: 12,
      attributionControl: false,
    });

    map.on('load', () => {
      map.addSource('live-trace', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: [] },
        },
      });
      map.addLayer({
        id: 'live-trace-line',
        type: 'line',
        source: 'live-trace',
        paint: {
          'line-color': '#16a34a',
          'line-width': 4,
        },
      });
    });

    mapRef.current = map;
    return () => {
      stopWatchers();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const src = map.getSource('live-trace') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const coords = points.map((p) => [p.lon, p.lat]);
    src.setData({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: coords,
      },
    });
    if (coords.length > 0) {
      const last = coords[coords.length - 1];
      map.easeTo({ center: [last[0], last[1]], zoom: Math.max(map.getZoom(), 13) });
    }
  }, [points]);

  const stopWatchers = () => {
    if (simTimerRef.current !== null) {
      window.clearInterval(simTimerRef.current);
      simTimerRef.current = null;
    }
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  };

  const pushPoint = (pt: RawGpsPoint) => {
    if (statusRef.current !== 'recording') return;
    if (pt.accuracy !== null && pt.accuracy > DEFAULT_MAX_GPS_ACCURACY_M) return;

    const prevPts = pointsRef.current;
    let delta = 0;
    if (prevPts.length > 0) {
      const prev = prevPts[prevPts.length - 1];
      delta = calculateDistanceMeters(prev.lat, prev.lon, pt.lat, pt.lon);
      if (delta < 2) return;
    }

    const nextPts = [...prevPts, pt];
    pointsRef.current = nextPts;
    distRef.current = distRef.current + delta;
    setPoints(nextPts);
    setDistanceMeters(distRef.current);
  };

  const attachWatchers = () => {
    stopWatchers();
    if (useSimulator) {
      const route = SAMPLE_TEJEDOR_ROUTES[selectedSampleIdx] || SAMPLE_TEJEDOR_ROUTES[0];
      const firstCoord = route.coords[simStepRef.current % route.coords.length];
      pushPoint(buildSimulatedPoint(firstCoord[0], firstCoord[1], 5));

      simTimerRef.current = window.setInterval(() => {
        if (statusRef.current !== 'recording') return;
        simStepRef.current += 1;
        const idx = simStepRef.current;
        if (idx < route.coords.length) {
          const [lon, lat] = route.coords[idx];
          pushPoint(buildSimulatedPoint(lon, lat, 5));
        } else {
          const bounceIdx =
            route.coords.length - 1 - ((idx - route.coords.length + 1) % route.coords.length);
          const [lon, lat] = route.coords[Math.max(0, bounceIdx)];
          pushPoint(buildSimulatedPoint(lon, lat, 5));
        }
      }, 900);
      return;
    }

    if (!('geolocation' in navigator)) {
      setErrorMsg('Este navegador no soporta geolocalización GPS.');
      return;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setErrorMsg(null);
        pushPoint({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          timestamp: pos.timestamp || Date.now(),
          accuracy: pos.coords.accuracy || 10,
          altitude: pos.coords.altitude,
          speed: pos.coords.speed,
        });
      },
      (err) => {
        setErrorMsg(`Error de GPS (${err.code}): ${err.message}`);
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  };

  const handleStart = () => {
    setErrorMsg(null);
    simStepRef.current = 0;
    pointsRef.current = [];
    distRef.current = 0;
    setPoints([]);
    setDistanceMeters(0);
    setStartedAt(new Date().toISOString());
    setAccumulatedMs(0);
    setLastResumedAt(Date.now());
    setRoadName(useSimulator ? SAMPLE_TEJEDOR_ROUTES[selectedSampleIdx]?.name || '' : '');
    setStatus('recording');
    statusRef.current = 'recording';
    attachWatchers();
  };

  const handlePause = () => {
    stopWatchers();
    const extra = lastResumedAt ? Date.now() - lastResumedAt : 0;
    setAccumulatedMs((prev) => prev + extra);
    setLastResumedAt(null);
    setStatus('paused');
    statusRef.current = 'paused';
  };

  const handleResume = () => {
    setLastResumedAt(Date.now());
    setStatus('recording');
    statusRef.current = 'recording';
    attachWatchers();
  };

  const handleFinishToConfirm = () => {
    stopWatchers();
    const extra = status === 'recording' && lastResumedAt ? Date.now() - lastResumedAt : 0;
    setAccumulatedMs((prev) => prev + extra);
    setLastResumedAt(null);
    setStatus('confirming');
    statusRef.current = 'confirming';
  };

  const handleSubmitTrip = async (e: React.FormEvent) => {
    e.preventDefault();
    if (points.length < 2 || !roadName.trim()) return;

    setSubmitting(true);
    setErrorMsg(null);
    const durationSec = Math.max(1, Math.round(accumulatedMs / 1000));
    const tripId = crypto.randomUUID();

    const { error } = await supabase.rpc('submit_trip_with_track', {
      p_trip_id: tripId,
      p_original_name: roadName.trim(),
      p_started_at: startedAt || new Date().toISOString(),
      p_ended_at: new Date().toISOString(),
      p_distance_m: Math.round(distanceMeters),
      p_duration_s: durationSec,
      p_raw_points: points,
      p_initial_road_class: roadClass,
    });

    setSubmitting(false);
    if (error) {
      setErrorMsg(error.message);
      return;
    }

    onTripCreated(
      `Recorrido "${roadName.trim()}" (${formatDistance(distanceMeters)}) clasificado como ${ROAD_CLASS_LABELS[roadClass]}, aprobado automáticamente y consolidado.`
    );
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.65)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        className="panel-card"
        style={{
          width: '100%',
          maxWidth: 680,
          maxHeight: '92dvh',
          overflowY: 'auto',
          margin: 0,
        }}
      >
        <div className="card-header-row">
          <div>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Navigation size={20} /> Grabar / Simular Recorrido (Modo Administrador)
            </h2>
            <p>
              <ShieldCheck size={14} style={{ verticalAlign: 'middle', color: '#16a34a' }} /> Como
              sos Administrador, este recorrido se <strong>aprueba y consolida automáticamente</strong> al finalizar.
            </p>
          </div>
          <button type="button" className="btn-outline" onClick={onClose}>
            <X size={16} /> Cerrar
          </button>
        </div>

        {errorMsg && (
          <div
            style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              padding: '10px 12px',
              borderRadius: 8,
              marginBottom: 12,
            }}
          >
            {errorMsg}
          </div>
        )}

        {status === 'idle' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }}>
            <div
              style={{
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: 10,
                padding: 12,
              }}
            >
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={useSimulator}
                  onChange={(e) => setUseSimulator(e.target.checked)}
                />
                Usar Simulador de Campo (trazas viales de Carlos Tejedor)
              </label>
              <p style={{ margin: '4px 0 0 24px', fontSize: 13, color: '#64748b' }}>
                Desmarcá esta opción si abriste el panel desde tu celular en el campo y querés usar el GPS real.
              </p>

              {useSimulator && (
                <div style={{ marginTop: 10, marginLeft: 24 }}>
                  <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
                    Camino de Carlos Tejedor a simular:
                  </label>
                  <select
                    value={selectedSampleIdx}
                    onChange={(e) => setSelectedSampleIdx(Number(e.target.value))}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8 }}
                  >
                    {SAMPLE_TEJEDOR_ROUTES.map((r, idx) => (
                      <option key={r.name} value={idx}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>
        )}

        {(status === 'recording' || status === 'paused' || status === 'confirming') && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 10,
              marginBottom: 12,
            }}
          >
            <div className="kpi-card" style={{ padding: 10 }}>
              <span className="kpi-title">Distancia</span>
              <strong style={{ fontSize: 20 }}>{formatDistance(distanceMeters)}</strong>
            </div>
            <div className="kpi-card" style={{ padding: 10 }}>
              <span className="kpi-title">Duración activa</span>
              <strong style={{ fontSize: 20 }}>{formatDuration(elapsedSeconds)}</strong>
            </div>
            <div className="kpi-card" style={{ padding: 10 }}>
              <span className="kpi-title">Puntos GPS</span>
              <strong style={{ fontSize: 20 }}>{points.length}</strong>
            </div>
          </div>
        )}

        <div
          ref={mapContainerRef}
          style={{
            width: '100%',
            height: 260,
            borderRadius: 10,
            overflow: 'hidden',
            border: '1px solid #cbd5e1',
            marginBottom: 14,
          }}
        />

        {status === 'idle' && (
          <button
            type="button"
            className="btn-approve"
            style={{ width: '100%', justifyContent: 'center', padding: '12px 16px' }}
            onClick={handleStart}
          >
            <Play size={18} /> Iniciar Grabación de Recorrido
          </button>
        )}

        {(status === 'recording' || status === 'paused') && (
          <div style={{ display: 'flex', gap: 10 }}>
            {status === 'recording' ? (
              <button
                type="button"
                className="btn-outline"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={handlePause}
              >
                <Pause size={17} /> Pausar
              </button>
            ) : (
              <button
                type="button"
                className="btn-primary"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={handleResume}
              >
                <Play size={17} /> Reanudar
              </button>
            )}

            <button
              type="button"
              className="btn-reject"
              style={{ flex: 1, justifyContent: 'center' }}
              disabled={points.length < 2}
              onClick={handleFinishToConfirm}
            >
              <Square size={17} /> Finalizar ({points.length} pts)
            </button>
          </div>
        )}

        {status === 'confirming' && (
          <form onSubmit={handleSubmitTrip} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label style={{ fontWeight: 600, fontSize: 14 }}>
              Nombre del camino rural:
              <input
                type="text"
                required
                placeholder="Ej.: Camino Rural Carlos Tejedor → Timote"
                value={roadName}
                onChange={(e) => setRoadName(e.target.value)}
                style={{
                  width: '100%',
                  marginTop: 6,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid #cbd5e1',
                }}
              />
            </label>
            <label style={{ fontWeight: 600, fontSize: 14 }}>
              Jerarquía asignada por el Municipio:
              <select
                value={roadClass}
                onChange={(e) => setRoadClass(e.target.value as RoadClass)}
                style={{
                  width: '100%',
                  marginTop: 6,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid #cbd5e1',
                }}
              >
                <option value="troncal">Troncal (Estratégico / Tránsito clave)</option>
                <option value="principal">Principal (Alto tránsito)</option>
                <option value="secundario">Secundario (Tránsito medio)</option>
                <option value="vecinal">Vecinal (Poco tránsito / Acceso a campos)</option>
              </select>
            </label>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn-outline"
                onClick={handleResume}
                disabled={submitting}
              >
                Seguir grabando
              </button>
              <button type="submit" className="btn-approve" disabled={submitting}>
                {submitting ? 'Consolidando en la red...' : 'Confirmar y Aprobar Recorrido'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
