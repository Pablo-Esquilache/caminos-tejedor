import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  CARLOS_TEJEDOR_CENTER,
  INTERVENTION_STATUS_LABELS,
  MACHINE_TYPE_LABELS,
  type InterventionStatus,
  type InterventionSummary,
  type MachineItem,
  type MachineType,
  type OperatorItem,
  type WorkExecutionMode,
  type WorkTypeItem,
} from '@shared';
import {
  ArrowLeft,
  CheckCircle2,
  CheckSquare,
  Plus,
  RefreshCw,
  Settings,
  Truck,
  Users,
  Wrench,
  XCircle,
} from 'lucide-react';
import { getBaseMapStyle, supabase } from '../lib/supabase';
import { formatDateTime, formatDistance, formatDuration } from '../lib/format';
import { AdminInterventionPlannerModal } from './AdminInterventionPlannerModal';

interface RoadOption {
  id: string;
  normalized_name: string;
  total_length_m: number;
}

interface AdminInterventionsSectionProps {
  roads: RoadOption[];
  onPendingCountChange?: (cnt: number) => void;
  onToast: (msg: string) => void;
}

export const AdminInterventionsSection: React.FC<AdminInterventionsSectionProps> = ({
  roads,
  onPendingCountChange,
  onToast,
}) => {
  const [subTab, setSubTab] = useState<'list' | 'catalogs'>('list');
  const [catalogTab, setCatalogTab] = useState<'operators' | 'machines' | 'work_types'>('operators');

  // Catálogos (Fase 9)
  const [operators, setOperators] = useState<OperatorItem[]>([]);
  const [machines, setMachines] = useState<MachineItem[]>([]);
  const [workTypes, setWorkTypes] = useState<WorkTypeItem[]>([]);

  // Filtros y Lista de Intervenciones (Fases 10 y 13)
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterWorkTypeId, setFilterWorkTypeId] = useState<string>('');
  const [filterMachineId, setFilterMachineId] = useState<string>('');
  const [filterOperatorId, setFilterOperatorId] = useState<string>('');
  const [items, setItems] = useState<InterventionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);

  // Selección en lote
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);

  // Planner Modal
  const [showPlanner, setShowPlanner] = useState(false);

  // Vista Detalle
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailPhotoUrls, setDetailPhotoUrls] = useState<Record<string, string>>({});
  const [reviewNote, setReviewNote] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);

  const detailMapContainerRef = useRef<HTMLDivElement | null>(null);
  const detailMapRef = useRef<maplibregl.Map | null>(null);

  // Formularios de Catálogo (Operarios / Máquinas / Tipos)
  const [opEditId, setOpEditId] = useState<string | null>(null);
  const [opName, setOpName] = useState('');
  const [opEmail, setOpEmail] = useState('');
  const [opPassword, setOpPassword] = useState('');
  const [opLegajo, setOpLegajo] = useState('');
  const [opPhone, setOpPhone] = useState('');
  const [opNotes, setOpNotes] = useState('');
  const [opCreateAcct, setOpCreateAcct] = useState(true);
  const [opBusy, setOpBusy] = useState(false);

  const [machEditId, setMachEditId] = useState<string | null>(null);
  const [machName, setMachName] = useState('');
  const [machCode, setMachCode] = useState('');
  const [machType, setMachType] = useState<MachineType>('motoniveladora');
  const [machDesc, setMachDesc] = useState('');
  const [machBusy, setMachBusy] = useState(false);

  const [wtEditId, setWtEditId] = useState<string | null>(null);
  const [wtName, setWtName] = useState('');
  const [wtMode, setWtMode] = useState<WorkExecutionMode>('linear');
  const [wtColor, setWtColor] = useState('#0ea5e9');
  const [wtDesc, setWtDesc] = useState('');
  const [wtBusy, setWtBusy] = useState(false);

  const PAGE_SIZE = 25;

  const loadCatalogs = async () => {
    const { data, error } = await supabase.rpc('admin_list_catalogs');
    if (!error && data) {
      setOperators((data.operators || []) as OperatorItem[]);
      setMachines((data.machines || []) as MachineItem[]);
      setWorkTypes((data.work_types || []) as WorkTypeItem[]);
    }
  };

  const loadInterventions = async (targetPage = page) => {
    setLoading(true);
    const { data, error } = await supabase.rpc('admin_list_interventions', {
      p_status: filterStatus === 'all' ? null : filterStatus,
      p_work_type_id: filterWorkTypeId || null,
      p_machine_id: filterMachineId || null,
      p_operator_id: filterOperatorId || null,
      p_date_from: null,
      p_date_to: null,
      p_limit: PAGE_SIZE,
      p_offset: targetPage * PAGE_SIZE,
    });
    setLoading(false);
    if (!error && data) {
      setItems((data.items || []) as InterventionSummary[]);
      setTotal(Number(data.total || 0));
      const pend = Number(data.pending_approval_count || 0);
      setPendingCount(pend);
      onPendingCountChange?.(pend);
    }
  };

  useEffect(() => {
    loadCatalogs();

    // Suscripción en tiempo real para reflejar inmediatamente tareas enviadas por los operarios
    const channel = supabase
      .channel('realtime_interventions_section')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'interventions' }, () => {
        loadInterventions();
      })
      .subscribe();

    const pollTimer = window.setInterval(() => {
      loadInterventions();
    }, 15000);

    return () => {
      supabase.removeChannel(channel);
      window.clearInterval(pollTimer);
    };
  }, []);

  useEffect(() => {
    setPage(0);
    setSelectedIds([]);
    loadInterventions(0);
  }, [filterStatus, filterWorkTypeId, filterMachineId, filterOperatorId]);

  const openDetail = async (id: string) => {
    setDetailId(id);
    setDetailData(null);
    setDetailPhotoUrls({});
    setReviewNote('');
    setDetailLoading(true);

    const { data, error } = await supabase.rpc('admin_get_intervention_detail', {
      p_intervention_id: id,
    });
    setDetailLoading(false);
    if (error || !data) {
      onToast(`Error cargando detalle: ${error?.message || 'Desconocido'}`);
      setDetailId(null);
      return;
    }

    setDetailData(data);

    // Firmar URLs privadas de fotos si existen
    if (Array.isArray(data.photos) && data.photos.length > 0) {
      const signedMap: Record<string, string> = {};
      for (const ph of data.photos) {
        const { data: urlData } = await supabase.storage
          .from('claim-photos')
          .createSignedUrl(ph.storage_path, 3600);
        if (urlData?.signedUrl) {
          signedMap[ph.id] = urlData.signedUrl;
        }
      }
      setDetailPhotoUrls(signedMap);
    }
  };

  // Renderizar mapa de detalle (Planificado punteado vs Real trabajado verde)
  useEffect(() => {
    if (!detailId || !detailData || !detailMapContainerRef.current) return;
    if (detailMapRef.current) {
      detailMapRef.current.remove();
      detailMapRef.current = null;
    }

    const map = new maplibregl.Map({
      container: detailMapContainerRef.current,
      style: getBaseMapStyle() as any,
      center: [CARLOS_TEJEDOR_CENTER.longitude, CARLOS_TEJEDOR_CENTER.latitude],
      zoom: 12,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
      const bounds = new maplibregl.LngLatBounds();
      let hasCoords = false;

      const extendBounds = (geom: any) => {
        if (!geom || !geom.coordinates) return;
        const walk = (c: any) => {
          if (typeof c[0] === 'number' && typeof c[1] === 'number') {
            bounds.extend([c[0], c[1]]);
            hasCoords = true;
          } else if (Array.isArray(c)) {
            c.forEach(walk);
          }
        };
        walk(geom.coordinates);
      };

      if (detailData.planned_geojson) {
        extendBounds(detailData.planned_geojson);
        map.addSource('int-planned', {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: detailData.planned_geojson } as any,
        });
        map.addLayer({
          id: 'int-planned-line',
          type: 'line',
          source: 'int-planned',
          filter: ['!=', '$type', 'Point'],
          paint: { 'line-color': '#f59e0b', 'line-width': 4, 'line-dasharray': [2, 2] },
        });
        map.addLayer({
          id: 'int-planned-pt',
          type: 'circle',
          source: 'int-planned',
          filter: ['==', '$type', 'Point'],
          paint: {
            'circle-radius': 8,
            'circle-color': '#f59e0b',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          },
        });
      }

      if (detailData.worked_geojson) {
        extendBounds(detailData.worked_geojson);
        map.addSource('int-worked', {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: detailData.worked_geojson } as any,
        });
        map.addLayer({
          id: 'int-worked-line',
          type: 'line',
          source: 'int-worked',
          filter: ['!=', '$type', 'Point'],
          paint: { 'line-color': '#16a34a', 'line-width': 5 },
        });
        map.addLayer({
          id: 'int-worked-pt',
          type: 'circle',
          source: 'int-worked',
          filter: ['==', '$type', 'Point'],
          paint: {
            'circle-radius': 9,
            'circle-color': '#16a34a',
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#ffffff',
          },
        });
      }

      if (hasCoords && !bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 50, maxZoom: 15 });
      }
    });

    detailMapRef.current = map;
    return () => {
      map.remove();
      detailMapRef.current = null;
    };
  }, [detailId, detailData]);

  // Aprobar / Rechazar con RETORNO AUTOMÁTICO a la lista
  const handleReview = async (newStatus: 'approved' | 'rejected') => {
    if (!detailData) return;
    setReviewBusy(true);
    const { error } = await supabase.rpc('admin_review_intervention', {
      p_intervention_id: detailData.id,
      p_new_status: newStatus,
      p_note: reviewNote.trim() || null,
    });
    setReviewBusy(false);

    if (error) {
      alert(`Error al validar trabajo: ${error.message}`);
      return;
    }

    onToast(
      newStatus === 'approved'
        ? 'Trabajo aprobado, incorporado a la capa oficial y auditado.'
        : 'Trabajo rechazado / devuelto con observaciones.'
    );
    // Volver automáticamente al listado principal
    setDetailId(null);
    setDetailData(null);
    await loadInterventions(page);
  };

  const handleBatchApprove = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`¿Aprobar en lote los ${selectedIds.length} trabajos seleccionados?`)) return;
    setBatchBusy(true);
    const { data, error } = await supabase.rpc('admin_review_interventions_batch', {
      p_ids: selectedIds,
      p_new_status: 'approved',
      p_note: 'Aprobación en lote desde Panel Municipal',
    });
    setBatchBusy(false);
    if (error) {
      alert(`Error en aprobación en lote: ${error.message}`);
      return;
    }
    setSelectedIds([]);
    onToast(`Se aprobaron ${data} intervención(es) en lote.`);
    await loadInterventions(page);
  };

  // --- Handlers Catálogos ---
  const handleSaveOperator = async (e: React.FormEvent) => {
    e.preventDefault();
    setOpBusy(true);
    const { error } = await supabase.rpc('admin_upsert_operator', {
      p_id: opEditId,
      p_full_name: opName.trim(),
      p_email: opEmail.trim() || null,
      p_password: opPassword.trim() || null,
      p_legajo: opLegajo.trim() || null,
      p_phone: opPhone.trim() || null,
      p_role_notes: opNotes.trim() || null,
      p_create_account: opCreateAcct,
      p_is_active: true,
    });
    setOpBusy(false);
    if (error) {
      alert(error.message);
      return;
    }
    onToast(opEditId ? 'Operario actualizado.' : 'Operario registrado en el catálogo.');
    setOpEditId(null);
    setOpName('');
    setOpEmail('');
    setOpPassword('');
    setOpLegajo('');
    setOpPhone('');
    setOpNotes('');
    await loadCatalogs();
  };

  const toggleOperatorActive = async (op: OperatorItem) => {
    const { error } = await supabase.rpc('admin_upsert_operator', {
      p_id: op.id,
      p_full_name: op.full_name,
      p_email: op.email,
      p_password: null,
      p_legajo: op.legajo,
      p_phone: op.phone,
      p_role_notes: op.role_notes,
      p_create_account: false,
      p_is_active: !op.is_active,
    });
    if (error) {
      alert(error.message);
      return;
    }
    onToast(op.is_active ? 'Operario desactivado (preserva historial).' : 'Operario reactivado.');
    await loadCatalogs();
  };

  const handleSaveMachine = async (e: React.FormEvent) => {
    e.preventDefault();
    setMachBusy(true);
    const { error } = await supabase.rpc('admin_upsert_machine', {
      p_id: machEditId,
      p_name: machName.trim(),
      p_code: machCode.trim() || null,
      p_machine_type: machType,
      p_description: machDesc.trim() || null,
      p_is_active: true,
    });
    setMachBusy(false);
    if (error) {
      alert(error.message);
      return;
    }
    onToast(machEditId ? 'Maquinaria actualizada.' : 'Maquinaria agregada al inventario.');
    setMachEditId(null);
    setMachName('');
    setMachCode('');
    setMachDesc('');
    await loadCatalogs();
  };

  const toggleMachineActive = async (m: MachineItem) => {
    const { error } = await supabase.rpc('admin_upsert_machine', {
      p_id: m.id,
      p_name: m.name,
      p_code: m.code,
      p_machine_type: m.machine_type,
      p_description: m.description,
      p_is_active: !m.is_active,
    });
    if (error) {
      alert(error.message);
      return;
    }
    onToast(m.is_active ? 'Máquina desactivada (mantiene historial).' : 'Máquina reactivada.');
    await loadCatalogs();
  };

  const handleSaveWorkType = async (e: React.FormEvent) => {
    e.preventDefault();
    setWtBusy(true);
    const { error } = await supabase.rpc('admin_upsert_work_type', {
      p_id: wtEditId,
      p_name: wtName.trim(),
      p_execution_mode: wtMode,
      p_color: wtColor,
      p_description: wtDesc.trim() || null,
      p_sort_order: workTypes.length + 1,
      p_is_active: true,
    });
    setWtBusy(false);
    if (error) {
      alert(error.message);
      return;
    }
    onToast(wtEditId ? 'Tipo de trabajo actualizado.' : 'Tipo de trabajo agregado.');
    setWtEditId(null);
    setWtName('');
    setWtDesc('');
    await loadCatalogs();
  };

  const toggleWorkTypeActive = async (w: WorkTypeItem) => {
    const { error } = await supabase.rpc('admin_upsert_work_type', {
      p_id: w.id,
      p_name: w.name,
      p_execution_mode: w.execution_mode,
      p_color: w.color,
      p_description: w.description,
      p_sort_order: w.sort_order,
      p_is_active: !w.is_active,
    });
    if (error) {
      alert(error.message);
      return;
    }
    onToast(w.is_active ? 'Tipo de obra desactivado.' : 'Tipo de obra activado.');
    await loadCatalogs();
  };

  return (
    <section className="admin-section">
      {/* Subnavegación superior */}
      <div
        className="panel-card"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className={subTab === 'list' ? 'btn-approve' : 'btn-outline'}
            onClick={() => {
              setDetailId(null);
              setSubTab('list');
            }}
          >
            <Wrench size={16} /> Intervenciones y Planificación
            {pendingCount > 0 && <span className="side-badge">{pendingCount}</span>}
          </button>
          <button
            type="button"
            className={subTab === 'catalogs' ? 'btn-approve' : 'btn-outline'}
            onClick={() => {
              setDetailId(null);
              setSubTab('catalogs');
            }}
          >
            <Settings size={16} /> Catálogos (Operarios, Máquinas y Obras)
          </button>
        </div>
      </div>

      {/* =================================================================== */}
      {/* SUBVISTA 1: DETALLE DE INTERVENCIÓN PARA VALIDAR */}
      {/* =================================================================== */}
      {subTab === 'list' && detailId && (
        <div className="panel-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <button type="button" className="btn-outline" onClick={() => setDetailId(null)}>
              <ArrowLeft size={16} /> Volver al listado
            </button>
            {detailData && (
              <span className={`badge-status status-${detailData.status === 'approved' ? 'approved' : detailData.status === 'rejected' ? 'rejected' : 'pending'}`}>
                {INTERVENTION_STATUS_LABELS[detailData.status as InterventionStatus] || detailData.status}
              </span>
            )}
          </div>

          {detailLoading || !detailData ? (
            <div className="loading-pad">Cargando traza, jornadas y fotografías...</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 1.4fr) 1fr', gap: 18 }}>
              <div>
                <h2 style={{ marginTop: 0 }}>{detailData.title}</h2>
                {detailData.description && <p style={{ color: '#475569' }}>{detailData.description}</p>}

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                    gap: 10,
                    marginBottom: 14,
                    background: '#f8fafc',
                    padding: 12,
                    borderRadius: 10,
                  }}
                >
                  <div>
                    <small style={{ color: '#64748b' }}>Modalidad</small>
                    <div style={{ fontWeight: 700 }}>
                      {detailData.execution_mode === 'linear' ? 'Lineal (GPS)' : 'Puntual (Foto/Punto)'}
                    </div>
                  </div>
                  <div>
                    <small style={{ color: '#64748b' }}>Tramo Neto Trabajado</small>
                    <div style={{ fontWeight: 700, color: '#15803d' }}>
                      {detailData.execution_mode === 'linear'
                        ? formatDistance(Number(detailData.worked_length_m || 0))
                        : 'Punto georreferenciado'}
                    </div>
                  </div>
                  <div>
                    <small style={{ color: '#64748b' }}>GPS Bruto (Ida/Vuelta)</small>
                    <div style={{ fontWeight: 700 }}>
                      {formatDistance(Number(detailData.total_gps_distance_m || 0))}
                    </div>
                  </div>
                  <div>
                    <small style={{ color: '#64748b' }}>Jornadas / Duración</small>
                    <div style={{ fontWeight: 700 }}>
                      {detailData.sessions_count || 0} jornada(s) • {formatDuration(Number(detailData.duration_s || 0))}
                    </div>
                  </div>
                </div>

                <div
                  ref={detailMapContainerRef}
                  style={{
                    width: '100%',
                    height: 360,
                    borderRadius: 10,
                    overflow: 'hidden',
                    border: '1px solid #cbd5e1',
                    marginBottom: 10,
                  }}
                />
                <div style={{ fontSize: 12, color: '#64748b', display: 'flex', gap: 16 }}>
                  <span>🟡 Línea punteada: Tramo planificado</span>
                  <span>🟢 Línea sólida: Tramo consolidado real trabajado (deduplicado)</span>
                </div>

                {/* Fotos adjuntas (especialmente útiles en alcantarillas / tareas puntuales) */}
                {detailData.photos && detailData.photos.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <h4>Fotografías de respaldo ({detailData.photos.length})</h4>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      {detailData.photos.map((ph: any) => (
                        <a
                          key={ph.id}
                          href={detailPhotoUrls[ph.id] || '#'}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {detailPhotoUrls[ph.id] ? (
                            <img
                              src={detailPhotoUrls[ph.id]}
                              alt="Foto obra"
                              style={{ width: 120, height: 90, objectFit: 'cover', borderRadius: 8, border: '1px solid #cbd5e1' }}
                            />
                          ) : (
                            <div style={{ width: 120, height: 90, background: '#e2e8f0', borderRadius: 8 }} />
                          )}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Panel derecho: equipo, reclamo vinculado, acciones de validación e historial */}
              <div>
                <div style={{ background: '#f8fafc', padding: 14, borderRadius: 10, marginBottom: 14 }}>
                  <h4 style={{ marginTop: 0 }}>Datos de Obra y Equipo</h4>
                  <p style={{ fontSize: 13, margin: '4px 0' }}>
                    <strong>Camino:</strong> {detailData.road_name || 'Sin vínculo fijo'}
                  </p>
                  <p style={{ fontSize: 13, margin: '4px 0' }}>
                    <strong>Operario Responsable:</strong> {detailData.responsible_operator_name || 'Sin asignar'}
                  </p>
                  <p style={{ fontSize: 13, margin: '4px 0' }}>
                    <strong>Tipos de Obra:</strong>{' '}
                    {(detailData.work_types || []).map((w: any) => w.name).join(', ') || '-'}
                  </p>
                  <p style={{ fontSize: 13, margin: '4px 0' }}>
                    <strong>Maquinaria:</strong>{' '}
                    {(detailData.machines || []).map((m: any) => m.name).join(', ') || '-'}
                  </p>
                  {detailData.linked_claim && (
                    <div
                      style={{
                        marginTop: 10,
                        padding: 10,
                        background: '#ecfdf5',
                        border: '1px solid #6ee7b7',
                        borderRadius: 8,
                        fontSize: 13,
                      }}
                    >
                      <strong>🔗 Reclamo vecinal vinculado:</strong>
                      <div>{detailData.linked_claim.title}</div>
                      <small>Al aprobar esta obra, el reclamo se marcará automáticamente como Solucionado y se avisará al vecino.</small>
                    </div>
                  )}
                </div>

                {/* Caja de Aprobación / Rechazo */}
                <div style={{ border: '1px solid #cbd5e1', padding: 14, borderRadius: 10, marginBottom: 14 }}>
                  <h4 style={{ marginTop: 0 }}>Validación Municipal</h4>
                  <textarea
                    rows={2}
                    placeholder="Observaciones o motivo (opcional)..."
                    value={reviewNote}
                    onChange={(e) => setReviewNote(e.target.value)}
                    style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #cbd5e1', marginBottom: 10 }}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="btn-approve"
                      style={{ flex: 1 }}
                      disabled={reviewBusy}
                      onClick={() => handleReview('approved')}
                    >
                      <CheckCircle2 size={16} /> Aprobar Obra
                    </button>
                    <button
                      type="button"
                      className="btn-reject"
                      style={{ flex: 1 }}
                      disabled={reviewBusy}
                      onClick={() => handleReview('rejected')}
                    >
                      <XCircle size={16} /> Rechazar
                    </button>
                  </div>
                </div>

                {/* Jornadas diarias */}
                <div>
                  <h4>Jornadas registradas ({detailData.sessions?.length || 0})</h4>
                  <div style={{ maxHeight: 160, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {(detailData.sessions || []).map((s: any, idx: number) => (
                      <div key={s.id} style={{ padding: 8, background: '#f8fafc', borderRadius: 8, fontSize: 12 }}>
                        <strong>Jornada #{idx + 1}</strong> — {formatDateTime(s.started_at)}
                        <div>
                          GPS bruto: {formatDistance(Number(s.raw_distance_m))} • {formatDuration(Number(s.duration_s))}
                        </div>
                        {s.notes && <div style={{ color: '#475569', fontStyle: 'italic' }}>{s.notes}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* =================================================================== */}
      {/* SUBVISTA 2: LISTADO Y BANDEJA DE INTERVENCIONES */}
      {/* =================================================================== */}
      {subTab === 'list' && !detailId && (
        <div className="panel-card">
          <div className="filters-bar" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 14 }}>
            <select className="filter-select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="all">Todos los estados</option>
              <option value="pending_approval">Pendientes de aprobación ({pendingCount})</option>
              <option value="planned">Programadas</option>
              <option value="suspended">Suspendidas (En pausa)</option>
              <option value="approved">Aprobadas</option>
              <option value="rejected">Rechazadas</option>
            </select>

            <select className="filter-select" value={filterWorkTypeId} onChange={(e) => setFilterWorkTypeId(e.target.value)}>
              <option value="">Todos los tipos de obra</option>
              {workTypes.map((wt) => (
                <option key={wt.id} value={wt.id}>{wt.name}</option>
              ))}
            </select>

            <select className="filter-select" value={filterMachineId} onChange={(e) => setFilterMachineId(e.target.value)}>
              <option value="">Todas las maquinarias</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>

            <select className="filter-select" value={filterOperatorId} onChange={(e) => setFilterOperatorId(e.target.value)}>
              <option value="">Todos los operarios</option>
              {operators.map((o) => (
                <option key={o.id} value={o.id}>{o.full_name}</option>
              ))}
            </select>

            <button type="button" className="btn-outline" onClick={() => loadInterventions(page)}>
              <RefreshCw size={15} /> Actualizar
            </button>

            <button
              type="button"
              className="btn-approve"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}
              onClick={() => setShowPlanner(true)}
            >
              <Plus size={16} /> Programar Nueva Intervención
            </button>

            {selectedIds.length > 0 && (
              <button
                type="button"
                className="btn-approve"
                disabled={batchBusy}
                onClick={handleBatchApprove}
              >
                <CheckSquare size={16} /> Aprobar {selectedIds.length} seleccionados
              </button>
            )}
          </div>

          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      checked={items.length > 0 && selectedIds.length === items.length}
                      onChange={(e) =>
                        setSelectedIds(e.target.checked ? items.map((x) => x.id) : [])
                      }
                    />
                  </th>
                  <th>Título / Obra</th>
                  <th>Estado</th>
                  <th>Tipo</th>
                  <th>Maquinaria / Responsable</th>
                  <th>Planificado vs Real Neto</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={7} className="empty-cell">Cargando intervenciones...</td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="empty-cell">
                      No hay intervenciones para el filtro seleccionado. Usá "+ Programar Nueva Intervención" para asignar una tarea.
                    </td>
                  </tr>
                ) : (
                  items.map((row) => (
                    <tr
                      key={row.id}
                      className={row.status === 'pending_approval' ? 'row-awaiting-validation' : ''}
                    >
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(row.id)}
                          onChange={(e) =>
                            setSelectedIds((prev) =>
                              e.target.checked
                                ? [...prev, row.id]
                                : prev.filter((id) => id !== row.id)
                            )
                          }
                        />
                      </td>
                      <td>
                        <strong>{row.title}</strong>
                        <div style={{ fontSize: 12, color: '#64748b' }}>
                          {row.origin === 'spontaneous' ? 'Espontánea en campo' : 'Programada'}
                          {row.road_name ? ` • ${row.road_name}` : ''}
                        </div>
                      </td>
                      <td>
                        <span
                          className={`badge-status status-${
                            row.status === 'approved'
                              ? 'approved'
                              : row.status === 'rejected'
                                ? 'rejected'
                                : row.status === 'pending_approval'
                                  ? 'awaiting-validation'
                                  : 'pending'
                          }`}
                        >
                          {row.status === 'pending_approval' ? '🔔 Pendiente de Validación' : INTERVENTION_STATUS_LABELS[row.status]}
                        </span>
                      </td>
                      <td>
                        {(row.work_types || []).map((w) => (
                          <span
                            key={w.id}
                            style={{
                              display: 'inline-block',
                              background: `${w.color}22`,
                              color: w.color,
                              padding: '2px 7px',
                              borderRadius: 6,
                              fontSize: 11,
                              fontWeight: 600,
                              marginRight: 4,
                            }}
                          >
                            {w.name}
                          </span>
                        ))}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        <div>{(row.machines || []).map((m) => m.name).join(', ') || 'Sin máquina'}</div>
                        <div style={{ color: '#64748b' }}>
                          Resp: {row.responsible_operator_name || 'Abierta'}
                        </div>
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {row.execution_mode === 'punctual' ? (
                          <span>Puntual ({row.sessions_count} reg.)</span>
                        ) : (
                          <div>
                            <div>Plan: {formatDistance(Number(row.planned_length_m))}</div>
                            <strong style={{ color: '#15803d' }}>
                              Real neto: {formatDistance(Number(row.worked_length_m))}
                            </strong>
                          </div>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn-outline"
                          onClick={() => openDetail(row.id)}
                        >
                          Ver / Validar
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {total > PAGE_SIZE && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
              <button
                type="button"
                className="btn-outline"
                disabled={page === 0}
                onClick={() => {
                  const p = Math.max(0, page - 1);
                  setPage(p);
                  loadInterventions(p);
                }}
              >
                Anterior
              </button>
              <span style={{ fontSize: 13 }}>
                Página {page + 1} de {Math.ceil(total / PAGE_SIZE)}
              </span>
              <button
                type="button"
                className="btn-outline"
                disabled={(page + 1) * PAGE_SIZE >= total}
                onClick={() => {
                  const p = page + 1;
                  setPage(p);
                  loadInterventions(p);
                }}
              >
                Siguiente
              </button>
            </div>
          )}
        </div>
      )}

      {/* =================================================================== */}
      {/* SUBVISTA 3: CATÁLOGOS (FASE 9 - OPERARIOS, MÁQUINAS, TIPOS DE OBRA) */}
      {/* =================================================================== */}
      {subTab === 'catalogs' && (
        <div className="panel-card">
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid #e2e8f0', paddingBottom: 10 }}>
            <button
              type="button"
              className={catalogTab === 'operators' ? 'btn-approve' : 'btn-outline'}
              onClick={() => setCatalogTab('operators')}
            >
              <Users size={15} /> Operarios ({operators.length})
            </button>
            <button
              type="button"
              className={catalogTab === 'machines' ? 'btn-approve' : 'btn-outline'}
              onClick={() => setCatalogTab('machines')}
            >
              <Truck size={15} /> Maquinaria Vial ({machines.length})
            </button>
            <button
              type="button"
              className={catalogTab === 'work_types' ? 'btn-approve' : 'btn-outline'}
              onClick={() => setCatalogTab('work_types')}
            >
              <Wrench size={15} /> Tipos de Trabajo ({workTypes.length})
            </button>
          </div>

          {/* 1. OPERARIOS */}
          {catalogTab === 'operators' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) 1.5fr', gap: 18 }}>
              <form onSubmit={handleSaveOperator} style={{ background: '#f8fafc', padding: 14, borderRadius: 10 }}>
                <h4 style={{ marginTop: 0 }}>{opEditId ? 'Editar Operario' : 'Nuevo Operario'}</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <input
                    type="text"
                    required
                    placeholder="Nombre y Apellido *"
                    value={opName}
                    onChange={(e) => setOpName(e.target.value)}
                    style={{ padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' }}
                  />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <input
                      type="text"
                      placeholder="Legajo (opcional)"
                      value={opLegajo}
                      onChange={(e) => setOpLegajo(e.target.value)}
                      style={{ padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' }}
                    />
                    <input
                      type="text"
                      placeholder="Teléfono"
                      value={opPhone}
                      onChange={(e) => setOpPhone(e.target.value)}
                      style={{ padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' }}
                    />
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={opCreateAcct}
                      onChange={(e) => setOpCreateAcct(e.target.checked)}
                    />
                    <strong>Crear cuenta de acceso para App Móvil / PWA</strong>
                  </label>

                  {opCreateAcct && (
                    <>
                      <input
                        type="email"
                        required={!opEditId}
                        placeholder="Usuario / Correo (ej. juan@tejedor.gob.ar)"
                        value={opEmail}
                        onChange={(e) => setOpEmail(e.target.value)}
                        style={{ padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' }}
                      />
                      <input
                        type="password"
                        required={!opEditId}
                        placeholder={opEditId ? 'Nueva clave (dejar vacío para no cambiar)' : 'Clave inicial (mín. 6 caracteres) *'}
                        value={opPassword}
                        onChange={(e) => setOpPassword(e.target.value)}
                        style={{ padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' }}
                      />
                    </>
                  )}

                  <input
                    type="text"
                    placeholder="Notas (ej. Turno mañana, Zona Sur)"
                    value={opNotes}
                    onChange={(e) => setOpNotes(e.target.value)}
                    style={{ padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' }}
                  />

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="submit" className="btn-approve" disabled={opBusy} style={{ flex: 1 }}>
                      {opBusy ? 'Guardando...' : opEditId ? 'Actualizar' : 'Agregar Operario'}
                    </button>
                    {opEditId && (
                      <button
                        type="button"
                        className="btn-outline"
                        onClick={() => {
                          setOpEditId(null);
                          setOpName('');
                          setOpEmail('');
                          setOpPassword('');
                          setOpLegajo('');
                          setOpPhone('');
                          setOpNotes('');
                        }}
                      >
                        Cancelar
                      </button>
                    )}
                  </div>
                </div>
              </form>

              <div className="table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Nombre</th>
                      <th>Acceso App</th>
                      <th>Estado</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {operators.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <strong>{o.full_name}</strong>
                          <div style={{ fontSize: 11, color: '#64748b' }}>
                            {o.legajo ? `Legajo ${o.legajo} • ` : ''}{o.phone || o.role_notes || ''}
                          </div>
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {o.has_account ? (
                            <span className="badge-status status-approved">{o.email}</span>
                          ) : (
                            <span style={{ color: '#64748b' }}>Registro histórico (sin clave)</span>
                          )}
                        </td>
                        <td>
                          <span className={`badge-status ${o.is_active ? 'status-approved' : 'status-rejected'}`}>
                            {o.is_active ? 'Activo' : 'Inactivo'}
                          </span>
                        </td>
                        <td style={{ display: 'flex', gap: 6 }}>
                          <button
                            type="button"
                            className="btn-outline"
                            onClick={() => {
                              setOpEditId(o.id);
                              setOpName(o.full_name);
                              setOpEmail(o.email || '');
                              setOpPassword('');
                              setOpLegajo(o.legajo || '');
                              setOpPhone(o.phone || '');
                              setOpNotes(o.role_notes || '');
                              setOpCreateAcct(o.has_account);
                            }}
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            className={o.is_active ? 'btn-reject' : 'btn-approve'}
                            onClick={() => toggleOperatorActive(o)}
                          >
                            {o.is_active ? 'Desactivar' : 'Activar'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 2. MAQUINARIA */}
          {catalogTab === 'machines' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) 1.5fr', gap: 18 }}>
              <form onSubmit={handleSaveMachine} style={{ background: '#f8fafc', padding: 14, borderRadius: 10 }}>
                <h4 style={{ marginTop: 0 }}>{machEditId ? 'Editar Maquinaria' : 'Nueva Maquinaria'}</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <input
                    type="text"
                    required
                    placeholder="Nombre (ej. Motoniveladora CAT 120K) *"
                    value={machName}
                    onChange={(e) => setMachName(e.target.value)}
                    style={{ padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' }}
                  />
                  <input
                    type="text"
                    placeholder="Interno / Patente (ej. MV-02)"
                    value={machCode}
                    onChange={(e) => setMachCode(e.target.value)}
                    style={{ padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' }}
                  />
                  <select
                    value={machType}
                    onChange={(e) => setMachType(e.target.value as MachineType)}
                    style={{ padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' }}
                  >
                    {Object.entries(MACHINE_TYPE_LABELS).map(([k, lbl]) => (
                      <option key={k} value={k}>{lbl}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="Descripción / Zona habitual"
                    value={machDesc}
                    onChange={(e) => setMachDesc(e.target.value)}
                    style={{ padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' }}
                  />
                  <button type="submit" className="btn-approve" disabled={machBusy}>
                    {machBusy ? 'Guardando...' : machEditId ? 'Actualizar Máquina' : 'Agregar Máquina'}
                  </button>
                </div>
              </form>

              <div className="table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Equipo</th>
                      <th>Tipo</th>
                      <th>Estado</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {machines.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <strong>{m.name}</strong> {m.code && <small>({m.code})</small>}
                          {m.description && <div style={{ fontSize: 11, color: '#64748b' }}>{m.description}</div>}
                        </td>
                        <td>{MACHINE_TYPE_LABELS[m.machine_type]}</td>
                        <td>
                          <span className={`badge-status ${m.is_active ? 'status-approved' : 'status-rejected'}`}>
                            {m.is_active ? 'Activa' : 'Inactiva'}
                          </span>
                        </td>
                        <td style={{ display: 'flex', gap: 6 }}>
                          <button
                            type="button"
                            className="btn-outline"
                            onClick={() => {
                              setMachEditId(m.id);
                              setMachName(m.name);
                              setMachCode(m.code || '');
                              setMachType(m.machine_type);
                              setMachDesc(m.description || '');
                            }}
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            className={m.is_active ? 'btn-reject' : 'btn-approve'}
                            onClick={() => toggleMachineActive(m)}
                          >
                            {m.is_active ? 'Desactivar' : 'Activar'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 3. TIPOS DE TRABAJO */}
          {catalogTab === 'work_types' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) 1.5fr', gap: 18 }}>
              <form onSubmit={handleSaveWorkType} style={{ background: '#f8fafc', padding: 14, borderRadius: 10 }}>
                <h4 style={{ marginTop: 0 }}>{wtEditId ? 'Editar Tipo de Obra' : 'Nuevo Tipo de Obra'}</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <input
                    type="text"
                    required
                    placeholder="Nombre del trabajo *"
                    value={wtName}
                    onChange={(e) => setWtName(e.target.value)}
                    style={{ padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' }}
                  />
                  <select
                    value={wtMode}
                    onChange={(e) => setWtMode(e.target.value as WorkExecutionMode)}
                    style={{ padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' }}
                  >
                    <option value="linear">Lineal (Trackeo GPS continuo en tramo)</option>
                    <option value="punctual">Puntual (Ubicación + fotos, sin trackeo)</option>
                  </select>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                    Color en mapa:
                    <input type="color" value={wtColor} onChange={(e) => setWtColor(e.target.value)} />
                  </label>
                  <input
                    type="text"
                    placeholder="Descripción breve"
                    value={wtDesc}
                    onChange={(e) => setWtDesc(e.target.value)}
                    style={{ padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' }}
                  />
                  <button type="submit" className="btn-approve" disabled={wtBusy}>
                    {wtBusy ? 'Guardando...' : wtEditId ? 'Actualizar' : 'Agregar Tipo de Trabajo'}
                  </button>
                </div>
              </form>

              <div className="table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Trabajo</th>
                      <th>Modalidad</th>
                      <th>Estado</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workTypes.map((w) => (
                      <tr key={w.id}>
                        <td>
                          <span
                            style={{
                              display: 'inline-block',
                              width: 10,
                              height: 10,
                              borderRadius: '50%',
                              background: w.color,
                              marginRight: 6,
                            }}
                          />
                          <strong>{w.name}</strong>
                          {w.description && <div style={{ fontSize: 11, color: '#64748b' }}>{w.description}</div>}
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {w.execution_mode === 'linear' ? 'Lineal (GPS)' : 'Puntual (Foto/Punto)'}
                        </td>
                        <td>
                          <span className={`badge-status ${w.is_active ? 'status-approved' : 'status-rejected'}`}>
                            {w.is_active ? 'Activo' : 'Inactivo'}
                          </span>
                        </td>
                        <td style={{ display: 'flex', gap: 6 }}>
                          <button
                            type="button"
                            className="btn-outline"
                            onClick={() => {
                              setWtEditId(w.id);
                              setWtName(w.name);
                              setWtMode(w.execution_mode);
                              setWtColor(w.color);
                              setWtDesc(w.description || '');
                            }}
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            className={w.is_active ? 'btn-reject' : 'btn-approve'}
                            onClick={() => toggleWorkTypeActive(w)}
                          >
                            {w.is_active ? 'Desactivar' : 'Activar'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {showPlanner && (
        <AdminInterventionPlannerModal
          workTypes={workTypes}
          machines={machines}
          operators={operators}
          roads={roads}
          onClose={() => setShowPlanner(false)}
          onSaved={async (msg) => {
            setShowPlanner(false);
            onToast(msg);
            await loadInterventions(0);
          }}
        />
      )}
    </section>
  );
};
