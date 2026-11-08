import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Eye,
  FolderKanban,
  Mail,
  MapPin,
  Plus,
  RefreshCw,
  Send,
  Tag,
  UserCheck,
  X,
} from 'lucide-react';
import {
  CLAIM_PRIORITY_LABELS,
  CLAIM_STATUS_LABELS,
  type ClaimCategory,
  type ClaimDetail,
  type ClaimPriority,
  type ClaimStatus,
} from '@shared';
import { supabase } from '../lib/supabase';
import { AdminMap } from './AdminMap';
import { AdminCreateClaimModal } from './AdminCreateClaimModal';

const PAGE_SIZE = 20;

interface AdminClaimRow {
  id: string;
  title: string;
  description: string | null;
  category_id: string;
  category_name: string;
  category_icon: string | null;
  status: ClaimStatus;
  priority: ClaimPriority;
  lat: number;
  lon: number;
  user_id: string;
  user_name: string;
  user_email: string;
  thumb_path: string | null;
  photos_count: number;
  created_at: string;
  updated_at: string;
  total_count: number;
}

interface AdminClaimsSectionProps {
  selectedClaimIdFromMap?: string | null;
  onClearSelectedClaimFromMap?: () => void;
  onFeedback: (msg: string) => void;
  onClaimsUpdated?: () => void;
}

export const AdminClaimsSection: React.FC<AdminClaimsSectionProps> = ({
  selectedClaimIdFromMap,
  onClearSelectedClaimFromMap,
  onFeedback,
  onClaimsUpdated,
}) => {
  const [subTab, setSubTab] = useState<'inbox' | 'categories' | 'weekly'>('inbox');
  const [showCreateClaimModal, setShowCreateClaimModal] = useState(false);

  // Filtros de Bandeja de Reclamos
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [page, setPage] = useState(0);

  // Datos de reclamos y categorías
  const [claims, setClaims] = useState<AdminClaimRow[]>([]);
  const [totalClaims, setTotalClaims] = useState(0);
  const [loadingClaims, setLoadingClaims] = useState(false);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [categories, setCategories] = useState<ClaimCategory[]>([]);

  // Detalle de reclamo seleccionado y formulario de respuesta
  const [selectedDetail, setSelectedDetail] = useState<ClaimDetail | null>(null);
  const [detailPhotoUrls, setDetailPhotoUrls] = useState<Record<string, string>>({});
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [newStatus, setNewStatus] = useState<ClaimStatus>('evaluating');
  const [newPriority, setNewPriority] = useState<ClaimPriority>('medium');
  const [replyMessage, setReplyMessage] = useState('');
  const [savingClaim, setSavingClaim] = useState(false);

  // Formulario CRUD de Categorías
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [catName, setCatName] = useState('');
  const [catIcon, setCatIcon] = useState('alert-triangle');
  const [catOrder, setCatOrder] = useState(10);
  const [catActive, setCatActive] = useState(true);
  const [savingCat, setSavingCat] = useState(false);

  // Resumen semanal
  const [weeklyResult, setWeeklyResult] = useState<string | null>(null);
  const [runningWeekly, setRunningWeekly] = useState(false);

  useEffect(() => {
    loadCategories();
  }, []);

  useEffect(() => {
    loadClaims(0);
  }, [statusFilter, priorityFilter, categoryFilter, dateFrom, dateTo]);

  useEffect(() => {
    if (selectedClaimIdFromMap) {
      setSubTab('inbox');
      openClaimDetail(selectedClaimIdFromMap);
      if (onClearSelectedClaimFromMap) onClearSelectedClaimFromMap();
    }
  }, [selectedClaimIdFromMap]);

  const loadCategories = async () => {
    const { data, error } = await supabase
      .from('claim_categories')
      .select('id, name, icon, is_active, sort_order')
      .order('sort_order', { ascending: true });

    if (!error && data) {
      setCategories(data as ClaimCategory[]);
    }
  };

  const loadClaims = async (targetPage: number) => {
    setLoadingClaims(true);
    const { data, error } = await supabase.rpc('get_admin_claims_list', {
      p_status: statusFilter === 'all' ? null : statusFilter,
      p_priority: priorityFilter === 'all' ? null : priorityFilter,
      p_category_id: categoryFilter === 'all' ? null : categoryFilter,
      p_date_from: dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : null,
      p_date_to: dateTo ? new Date(`${dateTo}T23:59:59`).toISOString() : null,
      p_limit: PAGE_SIZE,
      p_offset: targetPage * PAGE_SIZE,
    });

    if (!error && Array.isArray(data)) {
      const rows = data as AdminClaimRow[];
      setClaims(rows);
      setTotalClaims(rows.length > 0 ? Number(rows[0].total_count) : 0);
      setPage(targetPage);

      const toSign = rows
        .map((r) => r.thumb_path)
        .filter((p): p is string => Boolean(p && !thumbUrls[p]));

      if (toSign.length > 0) {
        const { data: signed } = await supabase.storage
          .from('claim-photos')
          .createSignedUrls(toSign, 3600);
        if (signed) {
          const map: Record<string, string> = {};
          for (const s of signed) {
            if (s.path && s.signedUrl) map[s.path] = s.signedUrl;
          }
          setThumbUrls((prev) => ({ ...prev, ...map }));
        }
      }
    }
    setLoadingClaims(false);
    onClaimsUpdated?.();
  };

  const openClaimDetail = async (claimId: string) => {
    setLoadingDetail(true);
    setSelectedDetail(null);
    setDetailPhotoUrls({});

    const { data, error } = await supabase.rpc('get_claim_detail', {
      p_claim_id: claimId,
    });

    if (!error && data) {
      const d = data as ClaimDetail;
      setSelectedDetail(d);
      setNewStatus(d.status);
      setNewPriority(d.priority);
      setReplyMessage('');

      const fullPaths = (d.photos || []).map((p) => p.storage_path).filter(Boolean);
      if (fullPaths.length > 0) {
        const { data: signed } = await supabase.storage
          .from('claim-photos')
          .createSignedUrls(fullPaths, 3600);
        if (signed) {
          const map: Record<string, string> = {};
          for (const s of signed) {
            if (s.path && s.signedUrl) map[s.path] = s.signedUrl;
          }
          setDetailPhotoUrls(map);
        }
      }
    }
    setLoadingDetail(false);
  };

  const handleUpdateClaimSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDetail) return;

    setSavingClaim(true);
    const { error } = await supabase.rpc('update_claim', {
      p_claim_id: selectedDetail.id,
      p_new_status: newStatus,
      p_new_priority: newPriority,
      p_message: replyMessage.trim() || null,
    });
    setSavingClaim(false);

    if (!error) {
      onFeedback(
        `Reclamo actualizado a "${CLAIM_STATUS_LABELS[newStatus]}". Se envió notificación al vecino.`
      );
      setSelectedDetail(null);
      setReplyMessage('');
      onClearSelectedClaimFromMap?.();
      await loadClaims(page);
      onClaimsUpdated?.();
    }
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!catName.trim()) return;
    setSavingCat(true);
    const { error } = await supabase.rpc('upsert_claim_category', {
      p_id: editingCatId,
      p_name: catName.trim(),
      p_icon: catIcon.trim() || 'alert-triangle',
      p_is_active: catActive,
      p_sort_order: Number(catOrder) || 0,
    });
    setSavingCat(false);

    if (!error) {
      onFeedback(
        editingCatId
          ? `Categoría "${catName.trim()}" actualizada.`
          : `Categoría "${catName.trim()}" creada.`
      );
      setEditingCatId(null);
      setCatName('');
      setCatOrder((categories.length + 1) * 10);
      setCatActive(true);
      await loadCategories();
    }
  };

  const toggleCategoryActive = async (cat: ClaimCategory) => {
    const { error } = await supabase.rpc('upsert_claim_category', {
      p_id: cat.id,
      p_name: cat.name,
      p_icon: cat.icon || 'alert-triangle',
      p_is_active: !cat.is_active,
      p_sort_order: cat.sort_order,
    });
    if (!error) {
      onFeedback(
        !cat.is_active
          ? `Categoría "${cat.name}" activada para nuevos reclamos.`
          : `Categoría "${cat.name}" desactivada (se conserva todo el historial existente).`
      );
      await loadCategories();
    }
  };

  const handleRunWeeklySummary = async () => {
    setRunningWeekly(true);
    setWeeklyResult(null);
    const { data, error } = await supabase.rpc('generate_weekly_pending_summary');
    setRunningWeekly(false);

    if (!error && data) {
      if (data.sent) {
        setWeeklyResult(
          `✅ Resumen semanal generado y enviado a ${data.admins_notified} administrador(es): ${data.pending_trips} recorrido(s) pendiente(s) y ${data.pending_claims} reclamo(s) activo(s).`
        );
      } else {
        setWeeklyResult(`ℹ️ ${data.reason}`);
      }
    }
  };

  return (
    <div className="view-stack">
      <div className="subtab-bar">
        <button
          type="button"
          className={subTab === 'inbox' ? 'btn-primary' : 'btn-outline'}
          onClick={() => setSubTab('inbox')}
        >
          <AlertTriangle size={16} /> Bandeja de Reclamos ({totalClaims})
        </button>
        <button
          type="button"
          className={subTab === 'categories' ? 'btn-primary' : 'btn-outline'}
          onClick={() => setSubTab('categories')}
        >
          <FolderKanban size={16} /> Categorías Administrables ({categories.length})
        </button>
        <button
          type="button"
          className={subTab === 'weekly' ? 'btn-primary' : 'btn-outline'}
          onClick={() => setSubTab('weekly')}
        >
          <Mail size={16} /> Avisos y Resumen Semanal
        </button>
        <button
          type="button"
          className="btn-approve"
          style={{ marginLeft: 'auto' }}
          onClick={() => setShowCreateClaimModal(true)}
        >
          <Plus size={16} /> Generar reclamo
        </button>
      </div>
      {showCreateClaimModal && (
        <AdminCreateClaimModal
          categories={categories}
          onClose={() => setShowCreateClaimModal(false)}
          onClaimCreated={(msg) => {
            onFeedback(msg);
            loadClaims(0);
          }}
        />
      )}

      {/* SUB-PESTAÑA 1: BANDEJA DE RECLAMOS Y DETALLE */}
      {subTab === 'inbox' && (
        <>
          <div className="filters-toolbar">
            <div className="filter-group">
              <label>Estado:</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="all">Todos los estados</option>
                <option value="received">Recibido</option>
                <option value="evaluating">En evaluación</option>
                <option value="in_progress">En proceso</option>
                <option value="solved">Solucionado</option>
                <option value="dismissed">Desestimado</option>
              </select>

              <label>Prioridad:</label>
              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
              >
                <option value="all">Todas</option>
                <option value="high">Alta</option>
                <option value="medium">Media</option>
                <option value="low">Baja</option>
              </select>

              <label>Categoría:</label>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
              >
                <option value="all">Todas las categorías</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} {!c.is_active ? '(Inactiva)' : ''}
                  </option>
                ))}
              </select>

              <label>Desde:</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
              <label>Hasta:</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>

            <button
              type="button"
              className="btn-outline"
              onClick={() => loadClaims(page)}
            >
              <RefreshCw size={15} /> Actualizar
            </button>
          </div>

          <div className={`trips-split-layout ${selectedDetail || loadingDetail ? 'has-detail' : 'full-width'}`}>
            {/* Tabla de Reclamos */}
            <div className="panel-card table-card">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Foto</th>
                    <th>Reclamo / Categoría</th>
                    <th>Vecino (Dato Interno)</th>
                    <th>Prioridad</th>
                    <th>Estado</th>
                    <th>Fecha</th>
                    <th>Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {claims.length === 0 && !loadingClaims && (
                    <tr>
                      <td colSpan={7} className="empty-cell">
                        No hay reclamos que coincidan con los filtros seleccionados.
                      </td>
                    </tr>
                  )}
                  {claims.map((row) => {
                    const thumb = row.thumb_path ? thumbUrls[row.thumb_path] : null;
                    return (
                      <tr
                        key={row.id}
                        className={selectedDetail?.id === row.id ? 'selected-row' : ''}
                      >
                        <td>
                          {thumb ? (
                            <img
                              src={thumb}
                              alt=""
                              className="admin-claim-thumb"
                            />
                          ) : (
                            <div className="admin-claim-thumb placeholder">
                              <MapPin size={15} />
                            </div>
                          )}
                        </td>
                        <td>
                          <span className="admin-cat-tag">{row.category_name}</span>
                          <div className="fw-bold">{row.title}</div>
                        </td>
                        <td>
                          <div>{row.user_name}</div>
                          <small className="muted">{row.user_email}</small>
                        </td>
                        <td>
                          <span className={`prio-badge prio-${row.priority}`}>
                            {CLAIM_PRIORITY_LABELS[row.priority]}
                          </span>
                        </td>
                        <td>
                          <span className={`claim-badge status-${row.status}`}>
                            {CLAIM_STATUS_LABELS[row.status]}
                          </span>
                        </td>
                        <td>
                          {new Date(row.created_at).toLocaleDateString('es-AR')}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn-sm"
                            onClick={() => openClaimDetail(row.id)}
                          >
                            <Eye size={14} /> Gestionar
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div className="pagination-bar">
                <span>
                  Mostrando {claims.length} de {totalClaims} reclamo(s)
                </span>
                <div className="page-btns">
                  <button
                    type="button"
                    className="btn-outline"
                    disabled={page === 0 || loadingClaims}
                    onClick={() => loadClaims(page - 1)}
                  >
                    Anterior
                  </button>
                  <span>Página {page + 1}</span>
                  <button
                    type="button"
                    className="btn-outline"
                    disabled={(page + 1) * PAGE_SIZE >= totalClaims || loadingClaims}
                    onClick={() => loadClaims(page + 1)}
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            </div>

            {/* Panel Lateral de Detalle y Respuesta al Vecino */}
            {(selectedDetail || loadingDetail) && (
              <div className="panel-card detail-inspector">
                {loadingDetail && (
                  <div className="inspector-empty">Cargando reclamo...</div>
                )}

                {selectedDetail && !loadingDetail && (
                  <div className="inspector-content">
                    <div className="inspector-header">
                      <div>
                        <span className="admin-cat-tag">
                          {selectedDetail.category_name}
                        </span>
                        <h3>{selectedDetail.title}</h3>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className={`claim-badge status-${selectedDetail.status}`}>
                          {CLAIM_STATUS_LABELS[selectedDetail.status]}
                        </span>
                        <button
                          type="button"
                          className="btn-icon-close"
                          title="Cerrar detalle"
                          onClick={() => {
                            setSelectedDetail(null);
                            onClearSelectedClaimFromMap?.();
                          }}
                        >
                          <X size={18} />
                        </button>
                      </div>
                    </div>

                  <div className="inspector-meta-grid">
                    <div>
                      <span>Vecino:</span>
                      <strong>{selectedDetail.user_name || 'Usuario'}</strong>
                      <small>{selectedDetail.user_email}</small>
                    </div>
                    <div>
                      <span>Coordenadas GPS:</span>
                      <strong>
                        {selectedDetail.lat.toFixed(5)}, {selectedDetail.lon.toFixed(5)}
                      </strong>
                      <small>
                        {new Date(selectedDetail.created_at).toLocaleString('es-AR')}
                      </small>
                    </div>
                  </div>

                  {selectedDetail.description && (
                    <div className="note-box">
                      <strong>Descripción enviada por el vecino:</strong>{' '}
                      {selectedDetail.description}
                    </div>
                  )}

                  {selectedDetail.photos && selectedDetail.photos.length > 0 && (
                    <div className="admin-claim-photos">
                      {selectedDetail.photos.map((p) => {
                        const url = detailPhotoUrls[p.storage_path];
                        return url ? (
                          <a
                            key={p.id}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            title="Abrir foto en tamaño original"
                          >
                            <img
                              src={url}
                              alt={selectedDetail.title}
                              className="admin-claim-full-photo"
                            />
                          </a>
                        ) : (
                          <div key={p.id} className="muted">
                            Generando URL firmada de fotografía...
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <AdminMap
                    mode="single"
                    singlePointCoords={[selectedDetail.lon, selectedDetail.lat]}
                    height="210px"
                  />

                  {/* Formulario de actualización de estado, prioridad y respuesta */}
                  <form className="admin-claim-form" onSubmit={handleUpdateClaimSubmit}>
                    <h4>Actualizar estado y notificar al vecino</h4>
                    <div className="form-row-2">
                      <label className="note-label">
                        Nuevo estado
                        <select
                          value={newStatus}
                          onChange={(e) => setNewStatus(e.target.value as ClaimStatus)}
                        >
                          <option value="received">Recibido</option>
                          <option value="evaluating">En evaluación</option>
                          <option value="in_progress">En proceso</option>
                          <option value="solved">Solucionado</option>
                          <option value="dismissed">Desestimado</option>
                        </select>
                      </label>
                      <label className="note-label">
                        Prioridad vial
                        <select
                          value={newPriority}
                          onChange={(e) =>
                            setNewPriority(e.target.value as ClaimPriority)
                          }
                        >
                          <option value="low">Baja</option>
                          <option value="medium">Media</option>
                          <option value="high">Alta</option>
                        </select>
                      </label>
                    </div>

                    <label className="note-label">
                      Respuesta o comentario para el vecino (se envía a su bandeja de Avisos y queda en el historial)
                      <textarea
                        rows={2}
                        placeholder="Ej.: Enviamos la motoniveladora municipal para repasar el tramo esta semana."
                        value={replyMessage}
                        onChange={(e) => setReplyMessage(e.target.value)}
                      />
                    </label>

                    <button
                      type="submit"
                      className="btn-approve"
                      disabled={savingClaim}
                    >
                      <Send size={15} />
                      {savingClaim
                        ? 'Guardando y notificando...'
                        : 'Guardar cambios y notificar al vecino'}
                    </button>
                  </form>

                  {/* Historial auditable del reclamo */}
                  <div className="aliases-box">
                    <h4>Historial del reclamo ({selectedDetail.history.length})</h4>
                    <div className="admin-history-list">
                      {selectedDetail.history.map((h) => (
                        <div key={h.id} className="admin-history-item">
                          <div className="admin-history-head">
                            <strong>
                              {h.new_status
                                ? CLAIM_STATUS_LABELS[h.new_status]
                                : h.action}
                            </strong>
                            <span>
                              {new Date(h.created_at).toLocaleString('es-AR')}
                            </span>
                          </div>
                          {h.message && <p>{h.message}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            )}
          </div>
        </>
      )}

      {/* SUB-PESTAÑA 2: CRUD DE CATEGORÍAS DE RECLAMOS */}
      {subTab === 'categories' && (
        <div className="trips-split-layout">
          <div className="panel-card table-card">
            <div className="card-header-flex">
              <div>
                <h3>Categorías de Reclamos Viales</h3>
                <p className="muted">
                  Si desactivás una categoría, deja de ofrecerse para reclamos nuevos pero se conserva todo el historial de reclamos existentes.
                </p>
              </div>
            </div>

            <table className="admin-table">
              <thead>
                <tr>
                  <th>Orden</th>
                  <th>Nombre de Categoría</th>
                  <th>Ícono</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((cat) => (
                  <tr key={cat.id}>
                    <td>{cat.sort_order}</td>
                    <td className="fw-bold">{cat.name}</td>
                    <td>
                      <code>{cat.icon || 'alert-triangle'}</code>
                    </td>
                    <td>
                      <span
                        className={`status-tag ${
                          cat.is_active ? 'status-approved' : 'status-rejected'
                        }`}
                      >
                        {cat.is_active ? 'Activa' : 'Inactiva (Histórica)'}
                      </span>
                    </td>
                    <td>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className="btn-sm"
                          onClick={() => {
                            setEditingCatId(cat.id);
                            setCatName(cat.name);
                            setCatIcon(cat.icon || 'alert-triangle');
                            setCatOrder(cat.sort_order);
                            setCatActive(cat.is_active);
                          }}
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className="btn-sm"
                          onClick={() => toggleCategoryActive(cat)}
                        >
                          {cat.is_active ? 'Desactivar' : 'Activar'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel-card detail-inspector">
            <form className="inspector-content" onSubmit={handleSaveCategory}>
              <h3>
                {editingCatId ? 'Editar categoría' : 'Crear nueva categoría'}
              </h3>
              <label className="note-label">
                Nombre de la categoría *
                <input
                  type="text"
                  required
                  placeholder="Ej.: Guardaganado roto / Poste caído"
                  value={catName}
                  onChange={(e) => setCatName(e.target.value)}
                />
              </label>

              <label className="note-label">
                Identificador de ícono
                <input
                  type="text"
                  placeholder="alert-triangle, droplets, ban, wrench..."
                  value={catIcon}
                  onChange={(e) => setCatIcon(e.target.value)}
                />
              </label>

              <label className="note-label">
                Orden de aparición
                <input
                  type="number"
                  value={catOrder}
                  onChange={(e) => setCatOrder(Number(e.target.value))}
                />
              </label>

              <label className="layer-check">
                <input
                  type="checkbox"
                  checked={catActive}
                  onChange={(e) => setCatActive(e.target.checked)}
                />
                <span>Disponible para nuevos reclamos en la app móvil</span>
              </label>

              <div className="inspector-actions">
                {editingCatId && (
                  <button
                    type="button"
                    className="btn-outline"
                    onClick={() => {
                      setEditingCatId(null);
                      setCatName('');
                      setCatActive(true);
                    }}
                  >
                    Cancelar edición
                  </button>
                )}
                <button type="submit" className="btn-primary" disabled={savingCat}>
                  <Plus size={16} />
                  {savingCat
                    ? 'Guardando...'
                    : editingCatId
                      ? 'Guardar cambios'
                      : 'Crear categoría'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* SUB-PESTAÑA 3: RESUMEN SEMANAL Y NOTIFICACIONES */}
      {subTab === 'weekly' && (
        <div className="panel-card">
          <h3>Sistema de Avisos In-App y Resumen Semanal de Validación</h3>
          <p className="muted" style={{ marginTop: 6 }}>
            Cada cambio de estado en reclamos o recorridos genera en tiempo real un aviso en la bandeja del vecino. Además, el resumen semanal avisa a los administradores únicamente cuando existen recorridos pendientes de validar (si hay 0 pendientes, no genera ruido).
          </p>

          <div style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
            <button
              type="button"
              className="btn-primary"
              onClick={handleRunWeeklySummary}
              disabled={runningWeekly}
            >
              <Calendar size={16} />
              {runningWeekly
                ? 'Verificando recorridos pendientes...'
                : 'Ejecutar verificación de Resumen Semanal ahora'}
            </button>
          </div>

          {weeklyResult && (
            <div className="feedback-banner" style={{ marginTop: 16 }}>
              <CheckCircle2 size={18} />
              <span>{weeklyResult}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
