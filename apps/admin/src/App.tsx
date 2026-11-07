import React, { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  Map,
  Route,
  GitBranch,
  AlertOctagon,
  Users,
  BarChart3,
  LayoutDashboard,
  LogOut,
  CheckCircle2,
  XCircle,
  RotateCcw,
  CheckSquare,
  RefreshCw,
  ArrowLeft,
  ShieldAlert,
  ShieldCheck,
  Clock,
  Navigation,
} from 'lucide-react';
import { TRIP_STATUS_ADMIN_LABELS, type TripStatus } from '@shared';
import { supabase } from './lib/supabase';
import { formatDateTime, formatDistance, formatDuration } from './lib/format';
import { AdminMap } from './components/AdminMap';

type AdminSection =
  | 'dashboard'
  | 'map'
  | 'trips'
  | 'roads'
  | 'claims'
  | 'users'
  | 'stats';

interface DashboardSummary {
  pending_trips_count: number;
  approved_trips_count: number;
  rejected_trips_count: number;
  approved_km: number;
  total_users_count: number;
  total_claims_count: number;
}

interface AdminTripRow {
  id: string;
  original_name: string;
  started_at: string;
  ended_at: string;
  distance_m: number;
  duration_s: number;
  status: TripStatus;
  auto_approved: boolean;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  user_name: string | null;
  user_email: string | null;
  reviewer_name: string | null;
  reviewer_email: string | null;
}

interface AdminTripDetail {
  id: string;
  original_name: string;
  started_at: string;
  ended_at: string;
  distance_m: number;
  duration_s: number;
  status: TripStatus;
  auto_approved: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  simplified_geojson: { type: 'LineString'; coordinates: Array<[number, number]> } | null;
  full_geojson: { type: 'LineString'; coordinates: Array<[number, number]> } | null;
  raw_points: Array<{ lat: number; lon: number; timestamp: number; accuracy: number }> | null;
  user_info: { full_name: string | null; email: string | null } | null;
  reviewer_info: { full_name: string | null; email: string | null } | null;
}

interface AdminUserRow {
  id: string;
  full_name: string | null;
  email: string | null;
  created_at: string;
  is_admin: boolean;
  trips_count: number;
  approved_trips_count: number;
  claims_count: number;
}

const PAGE_SIZE = 25;

export const App: React.FC = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isAdminVerified, setIsAdminVerified] = useState(false);

  // Login form
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  // Navegación
  const [section, setSection] = useState<AdminSection>('dashboard');
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Portada / Indicadores
  const [summary, setSummary] = useState<DashboardSummary>({
    pending_trips_count: 0,
    approved_trips_count: 0,
    rejected_trips_count: 0,
    approved_km: 0,
    total_users_count: 0,
    total_claims_count: 0,
  });

  // Bandeja de validación de recorridos
  const [tripsFilterStatus, setTripsFilterStatus] = useState<string>('pending');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [tripsList, setTripsList] = useState<AdminTripRow[]>([]);
  const [tripsTotal, setTripsTotal] = useState(0);
  const [tripsPage, setTripsPage] = useState(0);
  const [tripsLoading, setTripsLoading] = useState(false);

  // Selección en lote
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);

  // Detalle de recorrido
  const [detailTripId, setDetailTripId] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<AdminTripDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);

  // Usuarios
  const [usersList, setUsersList] = useState<AdminUserRow[]>([]);
  const [usersTotal, setUsersTotal] = useState(0);
  const [usersPage, setUsersPage] = useState(0);
  const [usersLoading, setUsersLoading] = useState(false);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(null), 5000);
  };

  // Verificar sesión y rol administrador mediante is_admin()
  const verifySessionAndAdmin = async (currentSession: Session | null) => {
    if (!currentSession?.user) {
      setSession(null);
      setIsAdminVerified(false);
      setCheckingAuth(false);
      return;
    }

    const { data, error } = await supabase.rpc('is_admin');
    if (error || !data) {
      await supabase.auth.signOut();
      setSession(null);
      setIsAdminVerified(false);
      setAuthError(
        'Acceso denegado: tu cuenta no tiene permisos de Administrador Municipal (no figura en la tabla admins).'
      );
      setCheckingAuth(false);
      return;
    }

    setSession(currentSession);
    setIsAdminVerified(true);
    setCheckingAuth(false);
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      verifySessionAndAdmin(data.session);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_ev, newSession) => {
      verifySessionAndAdmin(newSession);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!isAdminVerified) return;
    loadDashboardSummary();
    loadTrips(0);
    loadUsers(0);
  }, [isAdminVerified]);

  useEffect(() => {
    if (!isAdminVerified) return;
    setSelectedIds([]);
    loadTrips(0);
  }, [tripsFilterStatus, dateFrom, dateTo]);

  const loadDashboardSummary = async () => {
    const { data, error } = await supabase.rpc('get_admin_dashboard_summary');
    if (!error && data) {
      setSummary(data as DashboardSummary);
    }
  };

  const loadTrips = async (pageIdx: number) => {
    setTripsLoading(true);
    const fromIso = dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : null;
    const toIso = dateTo ? new Date(`${dateTo}T23:59:59`).toISOString() : null;

    const { data, error } = await supabase.rpc('get_admin_trips_list', {
      p_status: tripsFilterStatus,
      p_date_from: fromIso,
      p_date_to: toIso,
      p_limit: PAGE_SIZE,
      p_offset: pageIdx * PAGE_SIZE,
    });

    if (!error && data) {
      setTripsList((data.items || []) as AdminTripRow[]);
      setTripsTotal(Number(data.total || 0));
      setTripsPage(pageIdx);
    }
    setTripsLoading(false);
  };

  const loadUsers = async (pageIdx: number) => {
    setUsersLoading(true);
    const { data, error } = await supabase.rpc('get_admin_users_list', {
      p_limit: PAGE_SIZE,
      p_offset: pageIdx * PAGE_SIZE,
    });
    if (!error && data) {
      setUsersList((data.items || []) as AdminUserRow[]);
      setUsersTotal(Number(data.total || 0));
      setUsersPage(pageIdx);
    }
    setUsersLoading(false);
  };

  const openTripDetail = async (tripId: string) => {
    setSection('trips');
    setDetailTripId(tripId);
    setDetailLoading(true);
    setReviewNote('');

    const { data, error } = await supabase.rpc('get_trip_detail_geojson', {
      p_trip_id: tripId,
      p_include_full_track: true,
    });

    if (!error && data) {
      const detail = data as AdminTripDetail;
      setDetailData(detail);
      setReviewNote(detail.review_note || '');
    }
    setDetailLoading(false);
  };

  const handleReviewAction = async (newStatus: TripStatus) => {
    if (!detailData) return;
    setReviewBusy(true);
    const { error } = await supabase.rpc('review_trip', {
      p_trip_id: detailData.id,
      p_new_status: newStatus,
      p_note: reviewNote.trim() || null,
    });
    setReviewBusy(false);

    if (error) {
      alert(`Error al actualizar el recorrido: ${error.message}`);
      return;
    }

    const actionLabels: Record<TripStatus, string> = {
      approved: 'Recorrido aprobado y auditado en audit_log.',
      rejected: 'Recorrido rechazado y auditado en audit_log.',
      pending: 'Aprobación revocada: el recorrido volvió a estado Pendiente.',
    };
    showToast(actionLabels[newStatus]);
    await openTripDetail(detailData.id);
    await loadDashboardSummary();
    await loadTrips(tripsPage);
  };

  const handleBatchApprove = async () => {
    if (selectedIds.length === 0) return;
    const confirmed = window.confirm(
      `¿Confirmás aprobar en lote los ${selectedIds.length} recorridos seleccionados? Todos los cambios quedarán registrados en audit_log.`
    );
    if (!confirmed) return;

    setBatchBusy(true);
    const { data, error } = await supabase.rpc('review_trips_batch', {
      p_trip_ids: selectedIds,
      p_new_status: 'approved',
      p_note: 'Aprobación en lote desde bandeja de validación',
    });
    setBatchBusy(false);

    if (error) {
      alert(`Error en aprobación en lote: ${error.message}`);
      return;
    }

    showToast(`Se aprobaron ${data} recorrido(s) en lote correctamente.`);
    setSelectedIds([]);
    await loadDashboardSummary();
    await loadTrips(tripsPage);
  };

  const toggleSelectRow = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const toggleSelectAllPendingOnPage = () => {
    const pendingOnPage = tripsList.filter((t) => t.status === 'pending').map((t) => t.id);
    if (pendingOnPage.every((id) => selectedIds.includes(id)) && pendingOnPage.length > 0) {
      setSelectedIds([]);
    } else {
      setSelectedIds(pendingOnPage);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setLoginBusy(true);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setLoginBusy(false);

    if (error) {
      setAuthError('Correo o contraseña inválidos.');
      return;
    }

    await verifySessionAndAdmin(data.session);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  // Calcular estadísticas de precisión GPS del recorrido abierto
  const computeGpsStats = (
    pts: Array<{ lat: number; lon: number; accuracy: number }> | null | undefined
  ) => {
    if (!pts || pts.length === 0) return null;
    const accuracies = pts.map((p) => Number(p.accuracy || 0)).filter((n) => n > 0);
    if (accuracies.length === 0) return { count: pts.length, avg: 0, min: 0, max: 0 };
    const sum = accuracies.reduce((a, b) => a + b, 0);
    return {
      count: pts.length,
      avg: Math.round(sum / accuracies.length),
      min: Math.round(Math.min(...accuracies)),
      max: Math.round(Math.max(...accuracies)),
    };
  };

  if (checkingAuth) {
    return (
      <div className="admin-loading-screen">
        <div className="spinner" />
        <p>Verificando credenciales administrativas...</p>
      </div>
    );
  }

  // LOGIN DE ADMINISTRADOR (Sin registro público)
  if (!session || !isAdminVerified) {
    return (
      <div className="admin-login-page">
        <form className="admin-login-box" onSubmit={handleLogin}>
          <div className="admin-login-badge">
            <ShieldCheck size={32} />
          </div>
          <h1>Panel Municipal</h1>
          <p className="admin-login-sub">Caminos Rurales — Partido de Carlos Tejedor</p>

          {authError && (
            <div className="admin-alert-error">
              <ShieldAlert size={18} />
              <span>{authError}</span>
            </div>
          )}

          <label>
            Correo electrónico de administrador
            <input
              type="email"
              required
              placeholder="admin@municipio.gob.ar"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          <label>
            Contraseña
            <input
              type="password"
              required
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          <button type="submit" className="btn-admin-primary" disabled={loginBusy}>
            {loginBusy ? 'Verificando permisos...' : 'Ingresar al Panel'}
          </button>

          <small className="login-footer-note">
            Acceso exclusivo para cuentas autorizadas en la tabla <code>admins</code>.
          </small>
        </form>
      </div>
    );
  }

  const detailCoords: Array<[number, number]> =
    detailData?.full_geojson?.coordinates ||
    detailData?.simplified_geojson?.coordinates ||
    [];
  const gpsStats = computeGpsStats(detailData?.raw_points);

  return (
    <div className="admin-layout">
      {/* Menú Lateral */}
      <aside className="admin-sidebar">
        <div className="sidebar-brand">
          <Navigation size={22} />
          <div>
            <strong>Carlos Tejedor</strong>
            <span>Gestión Vial Rural</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <button
            type="button"
            className={section === 'dashboard' ? 'side-link active' : 'side-link'}
            onClick={() => {
              setDetailTripId(null);
              setSection('dashboard');
            }}
          >
            <LayoutDashboard size={18} />
            <span>Portada</span>
          </button>

          <button
            type="button"
            className={section === 'map' ? 'side-link active' : 'side-link'}
            onClick={() => {
              setDetailTripId(null);
              setSection('map');
            }}
          >
            <Map size={18} />
            <span>Mapa</span>
          </button>

          <button
            type="button"
            className={section === 'trips' ? 'side-link active' : 'side-link'}
            onClick={() => {
              setDetailTripId(null);
              setSection('trips');
            }}
          >
            <Route size={18} />
            <span>Recorridos</span>
            {summary.pending_trips_count > 0 && (
              <span className="side-badge">{summary.pending_trips_count}</span>
            )}
          </button>

          <button
            type="button"
            className={section === 'roads' ? 'side-link active' : 'side-link'}
            onClick={() => {
              setDetailTripId(null);
              setSection('roads');
            }}
          >
            <GitBranch size={18} />
            <span>Caminos</span>
          </button>

          <button
            type="button"
            className={section === 'claims' ? 'side-link active' : 'side-link'}
            onClick={() => {
              setDetailTripId(null);
              setSection('claims');
            }}
          >
            <AlertOctagon size={18} />
            <span>Reclamos</span>
          </button>

          <button
            type="button"
            className={section === 'users' ? 'side-link active' : 'side-link'}
            onClick={() => {
              setDetailTripId(null);
              setSection('users');
            }}
          >
            <Users size={18} />
            <span>Usuarios</span>
          </button>

          <button
            type="button"
            className={section === 'stats' ? 'side-link active' : 'side-link'}
            onClick={() => {
              setDetailTripId(null);
              setSection('stats');
            }}
          >
            <BarChart3 size={18} />
            <span>Estadísticas</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="admin-user-chip">
            <ShieldCheck size={16} />
            <span>{session.user.email}</span>
          </div>
          <button type="button" className="btn-logout" onClick={handleLogout}>
            <LogOut size={16} /> Salir
          </button>
        </div>
      </aside>

      {/* Área Principal */}
      <div className="admin-main">
        {toastMsg && (
          <div className="admin-toast">
            <CheckCircle2 size={18} />
            <span>{toastMsg}</span>
          </div>
        )}

        {/* SECCIÓN 1: PORTADA CON INDICADORES SIMPLES */}
        {section === 'dashboard' && (
          <div className="admin-page">
            <div className="page-header">
              <div>
                <h1>Resumen Operativo — Partido de Carlos Tejedor</h1>
                <p>Estado actual de relevamiento y validación de recorridos viales</p>
              </div>
              <button
                type="button"
                className="btn-outline"
                onClick={() => {
                  loadDashboardSummary();
                  loadTrips(tripsPage);
                }}
              >
                <RefreshCw size={15} /> Actualizar indicadores
              </button>
            </div>

            <div className="kpi-grid">
              <div
                className="kpi-card highlight-pending"
                onClick={() => {
                  setTripsFilterStatus('pending');
                  setSection('trips');
                }}
              >
                <span className="kpi-title">Recorridos pendientes de revisión</span>
                <strong className="kpi-number">{summary.pending_trips_count}</strong>
                <span className="kpi-sub">Hacé clic para ir a la bandeja de validación →</span>
              </div>

              <div
                className="kpi-card highlight-approved"
                onClick={() => {
                  setTripsFilterStatus('approved');
                  setSection('trips');
                }}
              >
                <span className="kpi-title">Recorridos aprobados</span>
                <strong className="kpi-number">{summary.approved_trips_count}</strong>
                <span className="kpi-sub">Validados e incluidos en el mapa operativo</span>
              </div>

              <div className="kpi-card">
                <span className="kpi-title">Kilómetros aprobados</span>
                <strong className="kpi-number">
                  {Number(summary.approved_km).toLocaleString('es-AR')} km
                </strong>
                <span className="kpi-sub">Total acumulado de recorridos aprobados</span>
              </div>
            </div>

            <div className="panel-card">
              <div className="card-header-row">
                <h2>Vista rápida del Mapa del Partido</h2>
                <button
                  type="button"
                  className="btn-outline"
                  onClick={() => setSection('map')}
                >
                  Abrir mapa en pantalla completa
                </button>
              </div>
              <AdminMap
                mode="general"
                height="440px"
                onSelectTripId={(id) => openTripDetail(id)}
              />
            </div>
          </div>
        )}

        {/* SECCIÓN 2: MAPA GENERAL DEL PARTIDO */}
        {section === 'map' && (
          <div className="admin-page">
            <div className="page-header">
              <div>
                <h1>Mapa General del Partido de Carlos Tejedor</h1>
                <p>
                  Carga dinámica por área visible (Bounding Box) usando geometrías simplificadas. Hacé clic sobre cualquier traza para abrir su validación.
                </p>
              </div>
            </div>
            <AdminMap
              mode="general"
              height="calc(100dvh - 150px)"
              onSelectTripId={(id) => openTripDetail(id)}
            />
          </div>
        )}

        {/* SECCIÓN 3: BANDEJA DE VALIDACIÓN DE RECORRIDOS Y DETALLE */}
        {section === 'trips' && (
          <div className="admin-page">
            {detailTripId ? (
              <div className="panel-card">
                <div className="card-header-row">
                  <button
                    type="button"
                    className="btn-back-link"
                    onClick={() => {
                      setDetailTripId(null);
                      setDetailData(null);
                    }}
                  >
                    <ArrowLeft size={18} /> Volver a la bandeja de recorridos
                  </button>
                </div>

                {detailLoading || !detailData ? (
                  <div className="loading-pad">Cargando traza completa y metadatos...</div>
                ) : (
                  <div className="trip-detail-grid">
                    <div className="trip-detail-left">
                      <div className="detail-title-row">
                        <h2>{detailData.original_name}</h2>
                        <span className={`badge-status status-${detailData.status}`}>
                          {TRIP_STATUS_ADMIN_LABELS[detailData.status]}
                        </span>
                      </div>

                      {/* Origen de aprobación (Automática por Admin vs Manual) */}
                      <div className="approval-audit-box">
                        {detailData.status === 'approved' && detailData.auto_approved && (
                          <p>
                            <ShieldCheck size={16} />{' '}
                            <strong>Aprobado automáticamente:</strong> Este recorrido fue registrado por un usuario Administrador ({detailData.user_info?.email}).
                          </p>
                        )}
                        {detailData.status === 'approved' && !detailData.auto_approved && (
                          <p>
                            <CheckCircle2 size={16} />{' '}
                            <strong>Aprobado manualmente</strong> por{' '}
                            <b>{detailData.reviewer_info?.email || 'Administrador'}</b> el{' '}
                            {formatDateTime(detailData.reviewed_at)}.
                          </p>
                        )}
                        {detailData.status === 'rejected' && (
                          <p>
                            <XCircle size={16} /> <strong>Rechazado manualmente</strong> por{' '}
                            <b>{detailData.reviewer_info?.email || 'Administrador'}</b> el{' '}
                            {formatDateTime(detailData.reviewed_at)}.
                          </p>
                        )}
                        {detailData.status === 'pending' && (
                          <p>
                            <Clock size={16} />{' '}
                            <strong>Pendiente de validación municipal.</strong> No suma a la red consolidada ni a las estadísticas hasta ser aprobado.
                          </p>
                        )}
                      </div>

                      <div className="meta-table">
                        <div>
                          <span>Distancia</span>
                          <strong>{formatDistance(Number(detailData.distance_m))}</strong>
                        </div>
                        <div>
                          <span>Duración activa</span>
                          <strong>{formatDuration(detailData.duration_s)}</strong>
                        </div>
                        <div>
                          <span>Inicio</span>
                          <strong>{formatDateTime(detailData.started_at)}</strong>
                        </div>
                        <div>
                          <span>Fin</span>
                          <strong>{formatDateTime(detailData.ended_at)}</strong>
                        </div>
                        {detailCoords.length >= 2 && (
                          <>
                            <div>
                              <span>Coordenada inicial</span>
                              <code>
                                {detailCoords[0][1].toFixed(5)}, {detailCoords[0][0].toFixed(5)}
                              </code>
                            </div>
                            <div>
                              <span>Coordenada final</span>
                              <code>
                                {detailCoords[detailCoords.length - 1][1].toFixed(5)},{' '}
                                {detailCoords[detailCoords.length - 1][0].toFixed(5)}
                              </code>
                            </div>
                          </>
                        )}
                        {gpsStats && (
                          <>
                            <div>
                              <span>Puntos GPS (traza completa)</span>
                              <strong>{gpsStats.count} puntos</strong>
                            </div>
                            <div>
                              <span>Precisión GPS (prom / mín / máx)</span>
                              <strong>
                                ±{gpsStats.avg}m (±{gpsStats.min}m a ±{gpsStats.max}m)
                              </strong>
                            </div>
                          </>
                        )}
                        <div className="secondary-user-meta">
                          <span>Usuario (dato interno secundario)</span>
                          <span className="muted-user">
                            {detailData.user_info?.full_name || 'Vecino'} (
                            {detailData.user_info?.email || 'sin correo'})
                          </span>
                        </div>
                      </div>

                      {/* Acciones de Validación con Auditoría */}
                      <div className="review-actions-box">
                        <label>
                          Nota de revisión (opcional, queda en <code>audit_log</code>):
                          <textarea
                            rows={2}
                            placeholder="Ej.: Verificado con imagen satelital / Rechazado por ser lote privado..."
                            value={reviewNote}
                            onChange={(e) => setReviewNote(e.target.value)}
                          />
                        </label>

                        <div className="review-buttons-row">
                          {detailData.status !== 'approved' && (
                            <button
                              type="button"
                              className="btn-approve"
                              disabled={reviewBusy}
                              onClick={() => handleReviewAction('approved')}
                            >
                              <CheckCircle2 size={18} /> Aprobar recorrido
                            </button>
                          )}

                          {detailData.status !== 'rejected' && (
                            <button
                              type="button"
                              className="btn-reject"
                              disabled={reviewBusy}
                              onClick={() => handleReviewAction('rejected')}
                            >
                              <XCircle size={18} /> Rechazar
                            </button>
                          )}

                          {detailData.status !== 'pending' && (
                            <button
                              type="button"
                              className="btn-revoke"
                              disabled={reviewBusy}
                              onClick={() => handleReviewAction('pending')}
                            >
                              <RotateCcw size={18} /> Revocar y volver a Pendiente
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="trip-detail-right">
                      <AdminMap
                        mode="single"
                        singleRouteCoords={detailCoords}
                        height="520px"
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="panel-card">
                <div className="card-header-row">
                  <div>
                    <h1>Bandeja de Validación de Recorridos</h1>
                    <p>
                      Mostrando {tripsList.length} de {tripsTotal} recorrido(s). Las trazas completas solo se descargan al abrir el detalle.
                    </p>
                  </div>

                  {selectedIds.length > 0 && (
                    <button
                      type="button"
                      className="btn-approve"
                      disabled={batchBusy}
                      onClick={handleBatchApprove}
                    >
                      <CheckSquare size={17} />
                      {batchBusy
                        ? 'Aprobando lote...'
                        : `Aprobar seleccionados (${selectedIds.length})`}
                    </button>
                  )}
                </div>

                {/* Filtros por Estado y Fecha */}
                <div className="filters-bar">
                  <div className="status-tabs">
                    {[
                      { key: 'pending', label: `Pendientes (${summary.pending_trips_count})` },
                      { key: 'approved', label: `Aprobados (${summary.approved_trips_count})` },
                      { key: 'rejected', label: `Rechazados (${summary.rejected_trips_count})` },
                      { key: 'all', label: 'Todos' },
                    ].map((st) => (
                      <button
                        key={st.key}
                        type="button"
                        className={tripsFilterStatus === st.key ? 'tab-btn active' : 'tab-btn'}
                        onClick={() => setTripsFilterStatus(st.key)}
                      >
                        {st.label}
                      </button>
                    ))}
                  </div>

                  <div className="date-filters">
                    <label>
                      Desde:
                      <input
                        type="date"
                        value={dateFrom}
                        onChange={(e) => setDateFrom(e.target.value)}
                      />
                    </label>
                    <label>
                      Hasta:
                      <input
                        type="date"
                        value={dateTo}
                        onChange={(e) => setDateTo(e.target.value)}
                      />
                    </label>
                    {(dateFrom || dateTo) && (
                      <button
                        type="button"
                        className="btn-outline"
                        onClick={() => {
                          setDateFrom('');
                          setDateTo('');
                        }}
                      >
                        Limpiar fechas
                      </button>
                    )}
                  </div>
                </div>

                {/* Tabla Paginada (25 por página) */}
                <div className="table-responsive">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th style={{ width: 42 }}>
                          <input
                            type="checkbox"
                            title="Seleccionar todos los pendientes de esta página"
                            onChange={toggleSelectAllPendingOnPage}
                            checked={
                              tripsList.some((t) => t.status === 'pending') &&
                              tripsList
                                .filter((t) => t.status === 'pending')
                                .every((t) => selectedIds.includes(t.id))
                            }
                          />
                        </th>
                        <th>Fecha y hora</th>
                        <th>Nombre original del camino</th>
                        <th>Distancia</th>
                        <th>Estado</th>
                        <th>Usuario (secundario)</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {tripsLoading ? (
                        <tr>
                          <td colSpan={7} className="empty-cell">
                            Cargando recorridos...
                          </td>
                        </tr>
                      ) : tripsList.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="empty-cell">
                            No hay recorridos para los filtros seleccionados.
                          </td>
                        </tr>
                      ) : (
                        tripsList.map((row) => (
                          <tr key={row.id}>
                            <td>
                              {row.status === 'pending' && (
                                <input
                                  type="checkbox"
                                  checked={selectedIds.includes(row.id)}
                                  onChange={() => toggleSelectRow(row.id)}
                                />
                              )}
                            </td>
                            <td>{formatDateTime(row.started_at)}</td>
                            <td>
                              <strong>{row.original_name}</strong>
                            </td>
                            <td>{formatDistance(Number(row.distance_m))}</td>
                            <td>
                              <span className={`badge-status status-${row.status}`}>
                                {TRIP_STATUS_ADMIN_LABELS[row.status]}
                              </span>
                              {row.status === 'approved' && row.auto_approved && (
                                <span className="auto-tag" title="Grabado por Administrador">
                                  Auto (Admin)
                                </span>
                              )}
                            </td>
                            <td className="secondary-user-col">
                              {row.user_email || row.user_name || '—'}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <button
                                type="button"
                                className="btn-table-action"
                                onClick={() => openTripDetail(row.id)}
                              >
                                Ver detalle / Validar
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Paginación */}
                {tripsTotal > PAGE_SIZE && (
                  <div className="pagination-row">
                    <span>
                      Página {tripsPage + 1} de {Math.ceil(tripsTotal / PAGE_SIZE)}
                    </span>
                    <div className="pagination-btns">
                      <button
                        type="button"
                        className="btn-outline"
                        disabled={tripsPage === 0}
                        onClick={() => loadTrips(tripsPage - 1)}
                      >
                        Anterior
                      </button>
                      <button
                        type="button"
                        className="btn-outline"
                        disabled={(tripsPage + 1) * PAGE_SIZE >= tripsTotal}
                        onClick={() => loadTrips(tripsPage + 1)}
                      >
                        Siguiente
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* SECCIÓN 4: CAMINOS (Se completa en Fase 4) */}
        {section === 'roads' && (
          <div className="admin-page">
            <div className="panel-card empty-module">
              <GitBranch size={38} />
              <h2>Red Consolidada de Caminos Rurales (Fase 4)</h2>
              <p>
                En la Fase 4 activamos el algoritmo espacial en PostGIS (<code>consolidate_trip</code>), la normalización de nombres y la clasificación por uso (troncal, principal, secundario y vecinal).
              </p>
            </div>
          </div>
        )}

        {/* SECCIÓN 5: RECLAMOS (Se completa en Fase 5) */}
        {section === 'claims' && (
          <div className="admin-page">
            <div className="panel-card empty-module">
              <AlertOctagon size={38} />
              <h2>Gestión de Reclamos Viales y Notificaciones (Fase 5)</h2>
              <p>
                En la Fase 5 se habilita el alta y gestión de reclamos con fotos privadas, prioridades y avisos por email vía Brevo.
              </p>
            </div>
          </div>
        )}

        {/* SECCIÓN 6: LISTADO DE USUARIOS */}
        {section === 'users' && (
          <div className="admin-page">
            <div className="panel-card">
              <div className="card-header-row">
                <div>
                  <h1>Usuarios Registrados ({usersTotal})</h1>
                  <p>Datos básicos y cantidad de recorridos y reclamos registrados</p>
                </div>
                <button
                  type="button"
                  className="btn-outline"
                  onClick={() => loadUsers(usersPage)}
                >
                  <RefreshCw size={15} /> Actualizar
                </button>
              </div>

              <div className="table-responsive">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Nombre</th>
                      <th>Correo electrónico</th>
                      <th>Rol</th>
                      <th>Fecha de alta</th>
                      <th>Recorridos totales</th>
                      <th>Recorridos aprobados</th>
                      <th>Reclamos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usersLoading ? (
                      <tr>
                        <td colSpan={7} className="empty-cell">
                          Cargando usuarios...
                        </td>
                      </tr>
                    ) : (
                      usersList.map((u) => (
                        <tr key={u.id}>
                          <td>
                            <strong>{u.full_name || 'Sin nombre'}</strong>
                          </td>
                          <td>{u.email}</td>
                          <td>
                            {u.is_admin ? (
                              <span className="badge-status status-approved">Administrador</span>
                            ) : (
                              <span className="badge-status status-rejected">Vecino</span>
                            )}
                          </td>
                          <td>{formatDateTime(u.created_at)}</td>
                          <td>{u.trips_count}</td>
                          <td>{u.approved_trips_count}</td>
                          <td>{u.claims_count}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* SECCIÓN 7: ESTADÍSTICAS (Se completa en Fase 6) */}
        {section === 'stats' && (
          <div className="admin-page">
            <div className="panel-card empty-module">
              <BarChart3 size={38} />
              <h2>Estadísticas e Indicadores Municipales (Fase 6)</h2>
              <p>
                En la Fase 6 se incorporan los rankings de caminos más utilizados, distribución por jerarquía y concentración geográfica de reclamos.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
