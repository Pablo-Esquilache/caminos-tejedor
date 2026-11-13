import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  CARLOS_TEJEDOR_CENTER,
  type ClaimPriority,
  type MachineItem,
  type OperatorItem,
  type WorkExecutionMode,
  type WorkTypeItem,
} from '@shared';
import { X, MapPin, Route as RouteIcon, Edit3, CheckCircle2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { getMapStyle } from '../lib/mapStyle';
import { formatDistance } from '../lib/format';

interface RoadOption {
  id: string;
  normalized_name: string;
  total_length_m: number;
}

interface ClaimOption {
  id: string;
  title: string;
  status: string;
}

interface AdminInterventionPlannerModalProps {
  workTypes: WorkTypeItem[];
  machines: MachineItem[];
  operators: OperatorItem[];
  roads: RoadOption[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}

export const AdminInterventionPlannerModal: React.FC<AdminInterventionPlannerModalProps> = ({
  workTypes,
  machines,
  operators,
  roads,
  onClose,
  onSaved,
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [executionMode, setExecutionMode] = useState<WorkExecutionMode>('linear');
  const [priority, setPriority] = useState<ClaimPriority>('medium');
  const [scheduledDate, setScheduledDate] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );
  const [selectedRoadId, setSelectedRoadId] = useState<string>('');
  const [definitionMode, setDefinitionMode] = useState<
    'consolidated_road' | 'points_along_road' | 'freehand_draw' | 'punctual_point'
  >('points_along_road');
  const [mapStyle, setMapStyle] = useState<'hybrid' | 'streets'>('hybrid');

  const [selectedWorkTypeIds, setSelectedWorkTypeIds] = useState<string[]>([]);
  const [selectedMachineIds, setSelectedMachineIds] = useState<string[]>([]);
  const [responsibleOperatorId, setResponsibleOperatorId] = useState<string>('');
  const [participantOperatorIds, setParticipantOperatorIds] = useState<string[]>([]);
  const [linkedClaimId, setLinkedClaimId] = useState<string>('');
  const [openClaims, setOpenClaims] = useState<ClaimOption[]>([]);

  const [clickedPoints, setClickedPoints] = useState<Array<[number, number]>>([]);
  const [plannedGeojson, setPlannedGeojson] = useState<any>(null);
  const [plannedLengthM, setPlannedLengthM] = useState<number>(0);
  const [computingGeom, setComputingGeom] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const defModeRef = useRef(definitionMode);
  defModeRef.current = definitionMode;
  const execModeRef = useRef(executionMode);
  execModeRef.current = executionMode;
  const roadIdRef = useRef(selectedRoadId);
  roadIdRef.current = selectedRoadId;

  useEffect(() => {
    supabase
      .from('claims')
      .select('id, title, status')
      .in('status', ['received', 'evaluating', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => {
        if (Array.isArray(data)) setOpenClaims(data as ClaimOption[]);
      });
  }, []);

  // Cuando cambia el modo de ejecución (Lineal <-> Puntual), ajustar modo de traza
  useEffect(() => {
    if (executionMode === 'punctual') {
      setDefinitionMode('punctual_point');
      setClickedPoints([]);
      setPlannedGeojson(null);
      setPlannedLengthM(0);
    } else if (definitionMode === 'punctual_point') {
      setDefinitionMode('points_along_road');
      setClickedPoints([]);
      setPlannedGeojson(null);
      setPlannedLengthM(0);
    }
  }, [executionMode]);

  useEffect(() => {
    if (!mapContainerRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: getMapStyle(mapStyle) as any,
      center: [CARLOS_TEJEDOR_CENTER.longitude, CARLOS_TEJEDOR_CENTER.latitude],
      zoom: 11.5,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', async () => {
      // Cargar capa de caminos consolidados de referencia
      const { data: roadSegs } = await supabase.rpc('get_consolidated_roads_map', {
        p_min_lon: -63.1,
        p_min_lat: -35.9,
        p_max_lon: -61.8,
        p_max_lat: -34.9,
        p_zoom: 12,
      });

      const roadFeatures = Array.isArray(roadSegs)
        ? roadSegs.map((s: any) => ({
            type: 'Feature',
            properties: { road_id: s.road_id, name: s.normalized_name },
            geometry: s.geojson,
          }))
        : [];

      map.addSource('ref-roads', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: roadFeatures } as any,
      });
      map.addLayer({
        id: 'ref-roads-line',
        type: 'line',
        source: 'ref-roads',
        paint: { 'line-color': '#38bdf8', 'line-width': 3.5, 'line-opacity': 0.85 },
      });

      map.addSource('planned-geom', {
        type: 'geojson',
        data: plannedGeojson
          ? ({ type: 'Feature', properties: {}, geometry: plannedGeojson } as any)
          : ({ type: 'FeatureCollection', features: [] } as any),
      });
      map.addLayer({
        id: 'planned-line',
        type: 'line',
        source: 'planned-geom',
        paint: { 'line-color': '#f59e0b', 'line-width': 5 },
      });
      map.addLayer({
        id: 'planned-point',
        type: 'circle',
        source: 'planned-geom',
        filter: ['==', '$type', 'Point'],
        paint: {
          'circle-radius': 8,
          'circle-color': '#f59e0b',
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
        },
      });

      map.addSource('click-pts', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: clickedPoints.map((c) => ({
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: c },
          })),
        } as any,
      });
      map.addLayer({
        id: 'click-pts-circle',
        type: 'circle',
        source: 'click-pts',
        paint: {
          'circle-radius': 6,
          'circle-color': '#ef4444',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });
    });

    map.on('click', (e) => {
      const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      const curExec = execModeRef.current;
      const curDef = defModeRef.current;

      if (curExec === 'punctual' || curDef === 'punctual_point') {
        setClickedPoints([lngLat]);
        setPlannedGeojson({ type: 'Point', coordinates: lngLat });
        setPlannedLengthM(0);
        return;
      }

      if (curDef === 'points_along_road') {
        if (!roadIdRef.current) {
          setErrorMsg('Primero seleccioná un camino consolidado arriba para marcar los 2 puntos sobre él.');
          return;
        }
        setErrorMsg(null);
        setClickedPoints((prev) => {
          const next = prev.length >= 2 ? [lngLat] : [...prev, lngLat];
          if (next.length === 2) {
            computeRoadSubstring(roadIdRef.current, next[0], next[1]);
          }
          return next;
        });
        return;
      }

      if (curDef === 'freehand_draw') {
        setErrorMsg(null);
        setClickedPoints((prev) => {
          const next = [...prev, lngLat];
          if (next.length >= 2) {
            setPlannedGeojson({ type: 'LineString', coordinates: next });
            setPlannedLengthM(estimatePolylineMeters(next));
          }
          return next;
        });
      }
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [mapStyle]);

  // Sincronizar capas visuales en MapLibre cuando cambia geometría o puntos marcados
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    const plannedSrc = map.getSource('planned-geom') as maplibregl.GeoJSONSource | undefined;
    if (plannedSrc) {
      plannedSrc.setData(
        plannedGeojson
          ? ({ type: 'Feature', properties: {}, geometry: plannedGeojson } as any)
          : ({ type: 'FeatureCollection', features: [] } as any)
      );
    }

    const clickSrc = map.getSource('click-pts') as maplibregl.GeoJSONSource | undefined;
    if (clickSrc) {
      clickSrc.setData({
        type: 'FeatureCollection',
        features: clickedPoints.map((c) => ({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: c },
        })),
      } as any);
    }
  }, [plannedGeojson, clickedPoints]);

  const estimatePolylineMeters = (coords: Array<[number, number]>) => {
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      const [lon1, lat1] = coords[i - 1];
      const [lon2, lat2] = coords[i];
      const dLat = (lat2 - lat1) * 111000;
      const dLon = (lon2 - lon1) * 111000 * Math.cos((-35.39 * Math.PI) / 180);
      total += Math.sqrt(dLat * dLat + dLon * dLon);
    }
    return Math.round(total);
  };

  const computeRoadSubstring = async (
    roadId: string,
    ptA: [number, number],
    ptB: [number, number]
  ) => {
    setComputingGeom(true);
    const { data, error } = await supabase.rpc('admin_compute_road_substring_geojson', {
      p_road_id: roadId,
      p_start_lon: ptA[0],
      p_start_lat: ptA[1],
      p_end_lon: ptB[0],
      p_end_lat: ptB[1],
    });
    setComputingGeom(false);
    if (error) {
      setErrorMsg(`Error calculando subtramo: ${error.message}`);
      return;
    }
    if (data?.geojson) {
      setPlannedGeojson(data.geojson);
      setPlannedLengthM(Number(data.length_m || 0));
    }
  };

  const loadFullConsolidatedRoad = async (roadId: string) => {
    setSelectedRoadId(roadId);
    setClickedPoints([]);
    if (!roadId) {
      setPlannedGeojson(null);
      setPlannedLengthM(0);
      return;
    }
    const { data } = await supabase
      .from('road_segments')
      .select('geom')
      .eq('road_id', roadId);

    const roadObj = roads.find((r) => r.id === roadId);
    if (roadObj) {
      setPlannedLengthM(Number(roadObj.total_length_m || 0));
    }

    // Obtener GeoJSON completo vía get_consolidated_roads_map o admin_compute
    const { data: roadMap } = await supabase.rpc('get_consolidated_roads_map', {
      p_min_lon: -63.1,
      p_min_lat: -35.9,
      p_max_lon: -61.8,
      p_max_lat: -34.9,
      p_zoom: 14,
    });
    if (Array.isArray(roadMap)) {
      const segs = roadMap.filter((s: any) => s.road_id === roadId);
      if (segs.length > 0 && mapRef.current) {
        const coordsAll: Array<[number, number]> = [];
        const multiCoords: Array<Array<[number, number]>> = [];
        segs.forEach((s: any) => {
          if (s.geojson?.coordinates) {
            multiCoords.push(s.geojson.coordinates);
            coordsAll.push(...s.geojson.coordinates);
          }
        });
        if (coordsAll.length > 0) {
          const bounds = new maplibregl.LngLatBounds(coordsAll[0], coordsAll[0]);
          coordsAll.forEach((c) => bounds.extend(c));
          mapRef.current.fitBounds(bounds, { padding: 40 });
          if (definitionMode === 'consolidated_road') {
            setPlannedGeojson(
              multiCoords.length === 1
                ? { type: 'LineString', coordinates: multiCoords[0] }
                : { type: 'MultiLineString', coordinates: multiCoords }
            );
          }
        }
      }
    }
    void data;
  };

  const toggleArr = (arr: string[], id: string, setter: (v: string[]) => void) => {
    setter(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!title.trim()) {
      setErrorMsg('Ingresá un título para la intervención.');
      return;
    }

    if (selectedWorkTypeIds.length === 0) {
      setErrorMsg('Seleccioná al menos un Tipo de Trabajo.');
      return;
    }

    setSaving(true);
    const { error } = await supabase.rpc('admin_upsert_intervention', {
      p_id: null,
      p_title: title.trim(),
      p_description: description.trim() || null,
      p_execution_mode: executionMode,
      p_priority: priority,
      p_road_id: selectedRoadId || null,
      p_definition_mode: definitionMode,
      p_planned_geojson: plannedGeojson,
      p_work_type_ids: selectedWorkTypeIds,
      p_machine_ids: selectedMachineIds,
      p_operator_ids: participantOperatorIds,
      p_responsible_operator_id: responsibleOperatorId || null,
      p_scheduled_date: scheduledDate || null,
      p_linked_claim_id: linkedClaimId || null,
    });
    setSaving(false);

    if (error) {
      setErrorMsg(error.message);
      return;
    }

    onSaved(`Intervención "${title.trim()}" programada exitosamente.`);
  };

  const activeWorkTypes = workTypes.filter(
    (w) => w.is_active && w.execution_mode === executionMode
  );
  const activeMachines = machines.filter((m) => m.is_active);
  const activeOperators = operators.filter((o) => o.is_active);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.72)',
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
          maxWidth: 980,
          width: '100%',
          maxHeight: '92vh',
          overflowY: 'auto',
          margin: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 14,
            borderBottom: '1px solid #e2e8f0',
            paddingBottom: 10,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 19 }}>Programar Nueva Intervención Vial</h2>
          <button type="button" className="btn-outline" onClick={onClose}>
            <X size={16} /> Cerrar
          </button>
        </div>

        {errorMsg && (
          <div
            style={{
              background: '#fee2e2',
              color: '#991b1b',
              padding: '10px 14px',
              borderRadius: 8,
              marginBottom: 12,
              fontSize: 13,
            }}
          >
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: 14,
              marginBottom: 14,
            }}
          >
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                Título de la tarea *
              </label>
              <input
                type="text"
                required
                placeholder="Ej. Perfilado Camino a Timote (Km 4 a 9)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #cbd5e1' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                Modalidad de Ejecución *
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className={executionMode === 'linear' ? 'btn-approve' : 'btn-outline'}
                  style={{ flex: 1 }}
                  onClick={() => {
                    setExecutionMode('linear');
                    setSelectedWorkTypeIds([]);
                  }}
                >
                  <RouteIcon size={15} /> Lineal (Tramo GPS)
                </button>
                <button
                  type="button"
                  className={executionMode === 'punctual' ? 'btn-approve' : 'btn-outline'}
                  style={{ flex: 1 }}
                  onClick={() => {
                    setExecutionMode('punctual');
                    setSelectedWorkTypeIds([]);
                  }}
                >
                  <MapPin size={15} /> Puntual (Alcantarilla/Pozo)
                </button>
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                Fecha Programada
              </label>
              <input
                type="date"
                value={scheduledDate}
                onChange={(e) => setScheduledDate(e.target.value)}
                style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #cbd5e1' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                Prioridad
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as ClaimPriority)}
                style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #cbd5e1' }}
              >
                <option value="low">Baja</option>
                <option value="medium">Media</option>
                <option value="high">Alta (Urgente)</option>
              </select>
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
              Descripción / Instrucciones para el operario
            </label>
            <textarea
              rows={2}
              placeholder="Detalles de la obra, cruces o alcantarillas a revisar..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #cbd5e1' }}
            />
          </div>

          {/* Tipos de trabajo, Máquinas y Operarios */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 14,
              marginBottom: 16,
              background: '#f8fafc',
              padding: 12,
              borderRadius: 10,
              border: '1px solid #e2e8f0',
            }}
          >
            <div>
              <strong style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>
                Tipos de Trabajo ({executionMode === 'linear' ? 'Lineales' : 'Puntuales'}) *
              </strong>
              <div style={{ maxHeight: 155, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {activeWorkTypes.map((wt) => (
                  <label key={wt.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={selectedWorkTypeIds.includes(wt.id)}
                      onChange={() =>
                        toggleArr(selectedWorkTypeIds, wt.id, setSelectedWorkTypeIds)
                      }
                    />
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: wt.color,
                        display: 'inline-block',
                      }}
                    />
                    {wt.name}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <strong style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>
                Maquinaria Asignada
              </strong>
              <div style={{ maxHeight: 155, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {activeMachines.length === 0 ? (
                  <small style={{ color: '#64748b' }}>Cargá máquinas en la pestaña Catálogos.</small>
                ) : (
                  activeMachines.map((m) => (
                    <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={selectedMachineIds.includes(m.id)}
                        onChange={() => toggleArr(selectedMachineIds, m.id, setSelectedMachineIds)}
                      />
                      {m.name} {m.code ? `(${m.code})` : ''}
                    </label>
                  ))
                )}
              </div>
            </div>

            <div>
              <strong style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>
                Operario Responsable (Rastreo)
              </strong>
              <select
                value={responsibleOperatorId}
                onChange={(e) => setResponsibleOperatorId(e.target.value)}
                style={{ width: '100%', padding: 7, borderRadius: 6, border: '1px solid #cbd5e1', marginBottom: 8 }}
              >
                <option value="">-- Tarea abierta (cualquier operario) --</option>
                {activeOperators.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.full_name} {o.has_account ? '📱' : '(Sin cuenta app)'}
                  </option>
                ))}
              </select>

              <strong style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                Participantes adicionales:
              </strong>
              <div style={{ maxHeight: 75, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
                {activeOperators
                  .filter((o) => o.id !== responsibleOperatorId)
                  .map((o) => (
                    <label key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={participantOperatorIds.includes(o.id)}
                        onChange={() =>
                          toggleArr(participantOperatorIds, o.id, setParticipantOperatorIds)
                        }
                      />
                      {o.full_name}
                    </label>
                  ))}
              </div>
            </div>
          </div>

          {/* Definición Geométrica en Mapa (3 modos Fase 10) */}
          <div style={{ marginBottom: 16 }}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
              }}
            >
              <strong style={{ fontSize: 14 }}>Definición del Tramo / Punto en el Mapa</strong>
              {executionMode === 'linear' && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={definitionMode === 'points_along_road' ? 'btn-approve' : 'btn-outline'}
                    onClick={() => {
                      setDefinitionMode('points_along_road');
                      setClickedPoints([]);
                    }}
                  >
                    2 clics sobre camino (curvas exactas)
                  </button>
                  <button
                    type="button"
                    className={definitionMode === 'consolidated_road' ? 'btn-approve' : 'btn-outline'}
                    onClick={() => {
                      setDefinitionMode('consolidated_road');
                      if (selectedRoadId) loadFullConsolidatedRoad(selectedRoadId);
                    }}
                  >
                    Camino completo
                  </button>
                  <button
                    type="button"
                    className={definitionMode === 'freehand_draw' ? 'btn-approve' : 'btn-outline'}
                    onClick={() => {
                      setDefinitionMode('freehand_draw');
                      setClickedPoints([]);
                      setPlannedGeojson(null);
                      setPlannedLengthM(0);
                    }}
                  >
                    <Edit3 size={14} /> Dibujo libre
                  </button>
                </div>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 8 }}>
              <select
                value={selectedRoadId}
                onChange={(e) => loadFullConsolidatedRoad(e.target.value)}
                style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #cbd5e1' }}
              >
                <option value="">-- Vincular camino consolidado (opcional) --</option>
                {roads.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.normalized_name} ({formatDistance(Number(r.total_length_m))})
                  </option>
                ))}
              </select>

              <select
                value={linkedClaimId}
                onChange={(e) => setLinkedClaimId(e.target.value)}
                style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #cbd5e1' }}
              >
                <option value="">-- Vincular reclamo abierto para resolver (opcional) --</option>
                {openClaims.map((c) => (
                  <option key={c.id} value={c.id}>
                    Reclamo: {c.title}
                  </option>
                ))}
              </select>
            </div>

            <div
              style={{
                fontSize: 12,
                color: '#475569',
                marginBottom: 8,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <span>
                {executionMode === 'punctual'
                  ? 'Hacé clic en el mapa para marcar la ubicación exacta (alcantarilla / bache).'
                  : definitionMode === 'points_along_road'
                    ? 'Elegí un camino y hacé 2 clics sobre el mapa (inicio y fin): PostGIS traza las curvas reales.'
                    : definitionMode === 'freehand_draw'
                      ? 'Hacé clics sucesivos sobre el mapa para dibujar la polilínea.'
                      : 'Se asigna el recorrido completo del camino consolidado seleccionado.'}
              </span>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {plannedLengthM > 0 && (
                  <span style={{ fontWeight: 700, color: '#15803d', fontSize: 13 }}>
                    Longitud estimada: {formatDistance(plannedLengthM)}
                  </span>
                )}
                {computingGeom && (
                  <span style={{ fontWeight: 600, color: '#f59e0b', fontSize: 12 }}>
                    Calculando traza en PostGIS...
                  </span>
                )}
                {/* Selector de capa Satélite HD / Vial */}
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    className={mapStyle === 'hybrid' ? 'btn-approve' : 'btn-outline'}
                    style={{ fontSize: 11, padding: '3px 8px' }}
                    onClick={() => setMapStyle('hybrid')}
                  >
                    Satélite + Caminos (HD)
                  </button>
                  <button
                    type="button"
                    className={mapStyle === 'streets' ? 'btn-approve' : 'btn-outline'}
                    style={{ fontSize: 11, padding: '3px 8px' }}
                    onClick={() => setMapStyle('streets')}
                  >
                    Mapa Vial
                  </button>
                </div>
              </div>
            </div>

            <div
              ref={mapContainerRef}
              style={{
                width: '100%',
                height: 360,
                borderRadius: 10,
                overflow: 'hidden',
                border: '1px solid #cbd5e1',
              }}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" className="btn-outline" onClick={onClose} disabled={saving}>
              Cancelar
            </button>
            <button type="submit" className="btn-approve" disabled={saving}>
              <CheckCircle2 size={16} />
              {saving ? 'Guardando...' : 'Programar Intervención'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
