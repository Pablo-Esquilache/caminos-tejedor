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
  Edit3,
  Merge,
  Sliders,
  Wrench,
} from 'lucide-react';
import {
  ROAD_CLASS_LABELS,
  TRIP_STATUS_ADMIN_LABELS,
  type RoadClass,
  type TripStatus,
} from '@shared';
import { supabase } from './lib/supabase';
import { formatDateTime, formatDistance, formatDuration } from './lib/format';
import { AdminMap } from './components/AdminMap';
import { AdminClaimsSection } from './components/AdminClaimsSection';
import { AdminStatsSection } from './components/AdminStatsSection';
import { AdminFieldRecorderModal } from './components/AdminFieldRecorderModal';
import { AdminInterventionsSection } from './components/AdminInterventionsSection';

type AdminSection =
  | 'dashboard'
  | 'map'
  | 'trips'
  | 'roads'
  | 'claims'
  | 'interventions'
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

interface AdminRoadRow {
  id: string;
  normalized_name: string;
  road_class: RoadClass;
  is_manual_class?: boolean;
  total_length_m: number;
  approved_trips_count: number;
  unique_users_count: number;
  updated_at: string;
  aliases: string[];
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
  const [selectedClaimIdFromMap, setSelectedClaimIdFromMap] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [showRecorderModal, setShowRecorderModal] = useState(false);
  const [newClaimsCount, setNewClaimsCount] = useState(0);
  const [pendingInterventionsCount, setPendingInterventionsCount] = useState(0);

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

  // Selección en lote de recorridos
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);

  // Detalle de recorrido
  const [detailTripId, setDetailTripId] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<AdminTripDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);

  // Caminos Consolidados (Fase 4)
  const [roadsList, setRoadsList] = useState<AdminRoadRow[]>([]);
  const [roadsTotal, setRoadsTotal] = useState(0);
  const [roadsPage, setRoadsPage] = useState(0);
  const [roadsLoading, setRoadsLoading] = useState(false);
  const [selectedRoadIds, setSelectedRoadIds] = useState<string[]>([]);
  const [editingRoadId, setEditingRoadId] = useState<string | null>(null);
  const [editingRoadName, setEditingRoadName] = useState('');
  const [troncalMin, setTroncalMin] = useState(25);
  const [principalMin, setPrincipalMin] = useState(10);
  const [secundarioMin, setSecundarioMin] = useState(3);
  const [classificationMode, setClassificationMode] = useState<'manual_thresholds' | 'auto_percentiles'>('manual_thresholds');
  const [proposedPercentiles, setProposedPercentiles] = useState<{
    p90_troncal: number;
    p70_principal: number;
    p40_secundario: number;
  }>({ p90_troncal: 5, p70_principal: 3, p40_secundario: 2 });
  const [reprocessingBusy, setReprocessingBusy] = useState(false);

  // Usuarios
  const [usersList, setUsersList] = useState<AdminUserRow[]>([]);
  const [usersTotal, setUsersTotal] = useState(0);
  const [usersPage, setUsersPage] = useState(0);
  const [usersLoading, setUsersLoading] = useState(false);
  const [operatorUserIds, setOperatorUserIds] = useState<Set<string>>(new Set());
  const [operatorEmails, setOperatorEmails] = useState<Set<string>>(new Set());

  const showToast = (msg: string) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(null), 5000);
  };

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
    // 1. Detectar tokens pasados en el hash de la URL (handoff automático desde la app móvil)
    const hash = window.location.hash;
    if (hash && hash.includes('access_token=')) {
      const cleanHash = hash.replace(/^#/, '');
      const params = new URLSearchParams(cleanHash);
      const access_token = params.get('access_token');
      const refresh_token = params.get('refresh_token');
      if (access_token && refresh_token) {
        supabase.auth.setSession({ access_token, refresh_token }).then(({ data, error }) => {
          // Limpiar hash de la barra de direcciones para no exponer tokens
          try {
            window.history.replaceState(null, '', window.location.pathname + window.location.search);
          } catch {
            // Noop
          }
          if (!error && data?.session) {
            verifySessionAndAdmin(data.session);
          } else {
            verifySessionAndAdmin(null);
          }
        });
        return;
      }
    }

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
    loadRoads(0);
    loadUsers(0);

    // Canal en tiempo real para reflejar nuevas intervenciones de operarios y reclamos vecinales
    const shellChannel = supabase
      .channel('realtime_admin_shell')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'interventions' }, () => {
        loadDashboardSummary();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'claims' }, () => {
        loadNewClaimsCount();
      })
      .subscribe();

    const shellPoll = window.setInterval(() => {
      loadDashboardSummary();
    }, 20000);

    return () => {
      supabase.removeChannel(shellChannel);
      window.clearInterval(shellPoll);
    };
  }, [isAdminVerified]);

  useEffect(() => {
    if (!isAdminVerified) return;
    setSelectedIds([]);
    loadTrips(0);
  }, [tripsFilterStatus, dateFrom, dateTo]);

  const loadNewClaimsCount = async () => {
    const { count, error } = await supabase
      .from('claims')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'received');
    if (!error && typeof count === 'number') {
      setNewClaimsCount(count);
    }
  };

  const loadDashboardSummary = async () => {
    const { data, error } = await supabase.rpc('get_admin_dashboard_summary');
    if (!error && data) {
      setSummary(data as DashboardSummary);
    }
    const { count: pendInt } = await supabase
      .from('interventions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending_approval');
    if (typeof pendInt === 'number') {
      setPendingInterventionsCount(pendInt);
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

  const loadRoads = async (pageIdx: number) => {
    setRoadsLoading(true);
    const { data, error } = await supabase.rpc('get_admin_roads_list', {
      p_limit: PAGE_SIZE,
      p_offset: pageIdx * PAGE_SIZE,
    });

    if (!error && data) {
      setRoadsList((data.items || []) as AdminRoadRow[]);
      setRoadsTotal(Number(data.total || 0));
      setRoadsPage(pageIdx);
      if (data.current_thresholds) {
        setTroncalMin(Number(data.current_thresholds.troncal_min_trips || 25));
        setPrincipalMin(Number(data.current_thresholds.principal_min_trips || 10));
        setSecundarioMin(Number(data.current_thresholds.secundario_min_trips || 3));
      }
      if (data.proposed_percentiles) {
        setProposedPercentiles(data.proposed_percentiles);
      }
      if (data.classification_mode) {
        setClassificationMode(data.classification_mode);
      }
    }
    setRoadsLoading(false);
  };

  const loadUsers = async (pageIdx: number) => {
    setUsersLoading(true);
    const [usersRes, catalogsRes] = await Promise.all([
      supabase.rpc('get_admin_users_list', {
        p_limit: PAGE_SIZE,
        p_offset: pageIdx * PAGE_SIZE,
      }),
      supabase.rpc('admin_list_catalogs'),
    ]);
    if (!catalogsRes.error && catalogsRes.data) {
      const ops = (
        (catalogsRes.data as { operators?: Array<{ user_id?: string | null; email?: string | null }> }).operators || []
      );
      setOperatorUserIds(new Set(ops.map((o) => o.user_id).filter((id): id is string => Boolean(id))));
      setOperatorEmails(
        new Set(ops.map((o) => o.email?.trim().toLowerCase()).filter((em): em is string => Boolean(em)))
      );
    }
    if (!usersRes.error && usersRes.data) {
      setUsersList((usersRes.data.items || []) as AdminUserRow[]);
      setUsersTotal(Number(usersRes.data.total || 0));
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
      approved:
        'Recorrido aprobado, consolidado en la red de caminos y auditado en audit_log.',
      rejected: 'Recorrido rechazado y auditado en audit_log.',
      pending:
        'Aprobación revocada: se desconsolidó de la red y volvió a estado Pendiente.',
    };
    showToast(actionLabels[newStatus]);
    setDetailTripId(null);
    setDetailData(null);
    setReviewNote('');
    await loadDashboardSummary();
    await loadTrips(tripsPage);
    await loadRoads(roadsPage);
  };

  const handleBatchApprove = async () => {
    if (selectedIds.length === 0) return;
    const confirmed = window.confirm(
      `¿Confirmás aprobar y consolidar en lote los ${selectedIds.length} recorridos seleccionados?`
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

    showToast(`Se aprobaron y consolidaron ${data} recorrido(s) en lote.`);
    setSelectedIds([]);
    await loadDashboardSummary();
    await loadTrips(tripsPage);
    await loadRoads(roadsPage);
  };

  // Acciones de Fase 4: Renombrar, Unificar, Clasificar y Reprocesar Caminos
  const handleSaveRoadName = async (roadId: string) => {
    if (!editingRoadName.trim()) return;
    const { error } = await supabase.rpc('rename_road', {
      p_road_id: roadId,
      p_new_name: editingRoadName.trim(),
    });
    if (error) {
      alert(`Error al renombrar camino: ${error.message}`);
      return;
    }
    setEditingRoadId(null);
    showToast('Nombre normalizado actualizado y registrado en audit_log.');
    await loadRoads(roadsPage);
  };

  const handleMergeSelectedRoads = async () => {
    if (selectedRoadIds.length < 2) return;
    const targetId = selectedRoadIds[0];
    const targetRoad = roadsList.find((r) => r.id === targetId);
    const newName = window.prompt(
      `Vas a unificar ${selectedRoadIds.length} caminos en uno solo (se conservan todos los tramos y alias originales). Ingresá el nombre normalizado definitivo:`,
      targetRoad?.normalized_name || ''
    );
    if (!newName) return;

    const { error } = await supabase.rpc('merge_roads', {
      p_target_road_id: targetId,
      p_source_road_ids: selectedRoadIds,
      p_new_normalized_name: newName.trim(),
    });
    if (error) {
      alert(`Error al unificar caminos: ${error.message}`);
      return;
    }

    setSelectedRoadIds([]);
    showToast('Caminos unificados exitosamente. Todos los alias originales fueron conservados.');
    await loadRoads(0);
  };

  const handleApplyThresholds = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.rpc('update_classification_thresholds', {
      p_troncal: troncalMin,
      p_principal: principalMin,
      p_secundario: secundarioMin,
    });
    if (error) {
      alert(`Error al actualizar umbrales: ${error.message}`);
      return;
    }
    showToast('Umbrales guardados y clasificación de caminos recalculada.');
    await loadRoads(roadsPage);
  };

  const handleToggleClassificationMode = async (mode: 'manual_thresholds' | 'auto_percentiles') => {
    setClassificationMode(mode);
    const { error } = await supabase.rpc('set_road_classification_mode', { p_mode: mode });
    if (error) {
      alert(`Error al cambiar modo de clasificación: ${error.message}`);
      return;
    }
    showToast(
      mode === 'auto_percentiles'
        ? 'Modo automático inteligente activado: la red se clasifica por distribución de uso.'
        : 'Modo estándar activado: la red se clasifica por los umbrales mínimos definidos.'
    );
    await loadRoads(roadsPage);
  };

  const handleSetRoadClass = async (roadId: string, newClass: RoadClass, isManual: boolean) => {
    const { error } = await supabase.rpc('set_road_class', {
      p_road_id: roadId,
      p_road_class: newClass,
      p_is_manual: isManual,
    });
    if (error) {
      alert(`Error al modificar categoría del camino: ${error.message}`);
      return;
    }
    showToast(
      isManual
        ? `Jerarquía fijada manualmente como "${ROAD_CLASS_LABELS[newClass]}".`
        : 'El camino volvió a clasificarse automáticamente.'
    );
    await loadRoads(roadsPage);
  };

  const handleReprocessAllRoads = async () => {
    const ok = window.confirm(
      '¿Confirmás reconstruir toda la red de caminos desde cero a partir de los recorridos aprobados y las trazas originales inmutables (trip_tracks)?'
    );
    if (!ok) return;
    setReprocessingBusy(true);
    const { data, error } = await supabase.rpc('reprocess_all_roads');
    setReprocessingBusy(false);

    if (error) {
      alert(`Error al reprocesar: ${error.message}`);
      return;
    }
    showToast(
      `Red reconstruida: ${data?.trips_processed || 0} recorrido(s) procesados → ${
        data?.resulting_roads || 0
      } camino(s) consolidados.`
    );
    await loadRoads(0);
  };

  const toggleSelectRow = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const toggleSelectRoadRow = (id: string) => {
    setSelectedRoadIds((prev) =>
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

  if (!session || !isAdminVerified) {
    return (
      <div className="admin-login-page">
        <form className="admin-login-box" onSubmit={handleLogin}>
          <div className="admin-login-badge">
            <img
              src={`${import.meta.env.BASE_URL}favicon.svg`}
              alt="Caminos Rurales Carlos Tejedor"
              style={{ width: 64, height: 64, borderRadius: 14 }}
            />
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
          <img
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt="Caminos Rurales Carlos Tejedor"
            style={{ width: 34, height: 34, borderRadius: 8, flexShrink: 0 }}
          />
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
              loadRoads(roadsPage);
              setSection('roads');
            }}
          >
            <GitBranch size={18} />
            <span>Caminos ({roadsTotal})</span>
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
            className={section === 'interventions' ? 'side-link active' : 'side-link'}
            onClick={() => {
              setDetailTripId(null);
              setSection('interventions');
            }}
          >
            <Wrench size={18} />
            <span>Intervenciones</span>
            {pendingInterventionsCount > 0 && (
              <span className="side-badge">{pendingInterventionsCount}</span>
            )}
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
        {showRecorderModal && (
          <AdminFieldRecorderModal
            onClose={() => setShowRecorderModal(false)}
            onTripCreated={(msg) => {
              showToast(msg);
              loadDashboardSummary();
              loadTrips(tripsPage);
              loadRoads(roadsPage);
            }}
          />
        )}
        {toastMsg && (
          <div className="admin-toast">
            <CheckCircle2 size={18} />
            <span>{toastMsg}</span>
          </div>
        )}

        {/* SECCIÓN 1: PORTADA */}
        {section === 'dashboard' && (
          <div className="admin-page">
            <div className="page-header">
              <div>
                <h1>Resumen Operativo — Partido de Carlos Tejedor</h1>
                <p>Estado actual de relevamiento, validación y red consolidada de caminos</p>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  className="btn-approve"
                  onClick={() => setShowRecorderModal(true)}
                >
                  <Navigation size={15} /> Grabar / Simular Recorrido
                </button>
                <button
                  type="button"
                  className="btn-outline"
                  onClick={() => {
                    loadDashboardSummary();
                    loadTrips(tripsPage);
                    loadRoads(roadsPage);
                  }}
                >
                  <RefreshCw size={15} /> Actualizar indicadores
                </button>
              </div>
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
                <span className="kpi-sub">Validados e integrados a la red consolidada</span>
              </div>

              <div
                className="kpi-card"
                onClick={() => setSection('roads')}
              >
                <span className="kpi-title">Kilómetros aprobados ({roadsTotal} caminos)</span>
                <strong className="kpi-number">
                  {Number(summary.approved_km).toLocaleString('es-AR')} km
                </strong>
                <span className="kpi-sub">Ver red consolidada y clasificación →</span>
              </div>

              <div
                className="kpi-card"
                onClick={() => setSection('interventions')}
              >
                <span className="kpi-title">Trabajos viales por validar</span>
                <strong className="kpi-number">{pendingInterventionsCount}</strong>
                <span className="kpi-sub">Programar obras, catálogos y aprobar trabajos →</span>
              </div>
            </div>

            <div className="panel-card">
              <div className="card-header-row">
                <h2>Mapa Operativo de Caminos Consolidados y Recorridos</h2>
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
                onSelectClaimId={(id) => {
                  setSelectedClaimIdFromMap(id);
                  setSection('claims');
                }}
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
                  Muestra la Red Consolidada de Caminos (con grosor y color según intensidad de uso y etiquetas de nombre) más los recorridos pendientes.
                </p>
              </div>
              <button
                type="button"
                className="btn-approve"
                onClick={() => setShowRecorderModal(true)}
              >
                <Navigation size={15} /> Grabar / Simular Recorrido
              </button>
            </div>
            <AdminMap
              mode="general"
              height="calc(100dvh - 150px)"
              onSelectTripId={(id) => openTripDetail(id)}
              onSelectClaimId={(id) => {
                setSelectedClaimIdFromMap(id);
                setSection('claims');
              }}
            />
          </div>
        )}

        {/* SECCIÓN 3: BANDEJA DE VALIDACIÓN DE RECORRIDOS */}
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

                      <div className="approval-audit-box">
                        {detailData.status === 'approved' && detailData.auto_approved && (
                          <p>
                            <ShieldCheck size={16} />{' '}
                            <strong>Aprobado automáticamente:</strong> Registrado por un usuario Administrador ({detailData.user_info?.email}).
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
                            <strong>Pendiente de validación municipal.</strong> Al aprobarlo se consolida automáticamente en la red de caminos.
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
                              <CheckCircle2 size={18} /> Aprobar y Consolidar
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

        {/* SECCIÓN 4: CAMINOS CONSOLIDADOS, NOMBRES Y CLASIFICACIÓN (Fase 4) */}
        {section === 'roads' && (
          <div className="admin-page">
            {/* Bloque de Clasificación por Uso y Reprocesamiento */}
            <div className="panel-card">
              <div className="card-header-row">
                <div>
                  <h2>
                    <Sliders size={18} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                    Clasificación Jerárquica por Frecuencia de Uso
                  </h2>
                </div>
                <button
                  type="button"
                  className="btn-outline"
                  disabled={reprocessingBusy}
                  onClick={handleReprocessAllRoads}
                >
                  <RefreshCw size={15} />
                  {reprocessingBusy
                    ? 'Reprocesando red...'
                    : 'Reprocesar toda la red desde cero'}
                </button>
              </div>

              {/* Selector de Modo de Clasificación */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 16, borderBottom: '1px solid #e2e8f0', paddingBottom: 12 }}>
                <button
                  type="button"
                  className={classificationMode === 'manual_thresholds' ? 'btn-primary' : 'btn-outline'}
                  onClick={() => handleToggleClassificationMode('manual_thresholds')}
                >
                  Modo por Umbrales Fijos (Personalizado)
                </button>
                <button
                  type="button"
                  className={classificationMode === 'auto_percentiles' ? 'btn-primary' : 'btn-outline'}
                  onClick={() => handleToggleClassificationMode('auto_percentiles')}
                >
                  Modo Automático Inteligente (Por Tránsito Relativo)
                </button>
              </div>

              {classificationMode === 'manual_thresholds' ? (
                <form className="thresholds-form" onSubmit={handleApplyThresholds}>
                  <label>
                    Troncal (mín. recorridos)
                    <input
                      type="number"
                      min={1}
                      value={troncalMin}
                      onChange={(e) => setTroncalMin(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    Principal (mín. recorridos)
                    <input
                      type="number"
                      min={1}
                      value={principalMin}
                      onChange={(e) => setPrincipalMin(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    Secundario (mín. recorridos)
                    <input
                      type="number"
                      min={1}
                      value={secundarioMin}
                      onChange={(e) => setSecundarioMin(Number(e.target.value))}
                    />
                  </label>
                  <div className="thresholds-btns">
                    <button
                      type="button"
                      className="btn-outline"
                      onClick={() => {
                        setTroncalMin(proposedPercentiles.p90_troncal);
                        setPrincipalMin(proposedPercentiles.p70_principal);
                        setSecundarioMin(proposedPercentiles.p40_secundario);
                      }}
                    >
                      Cargar percentiles sugeridos
                    </button>
                    <button type="submit" className="btn-approve">
                      Confirmar y Recalcular clasificación
                    </button>
                  </div>
                </form>
              ) : (
                <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
                  <p style={{ margin: 0, fontSize: '14px', color: '#334155', lineHeight: 1.6 }}>
                    <strong>Clasificación automática activada:</strong> El sistema analiza el tránsito de todos los caminos y distribuye los niveles automáticamente sin que tengas que fijar números manuales. Los caminos con mayor cantidad de pasadas se clasifican como <b>Troncales</b>, el grupo siguiente como <b>Principales</b>, luego <b>Secundarios</b> y los accesos o de poco uso como <b>Vecinales</b>. Los caminos que fijes a mano se mantienen siempre con tu categoría elegida.
                  </p>
                  <button
                    type="button"
                    className="btn-approve"
                    style={{ marginTop: 12 }}
                    onClick={() => handleToggleClassificationMode('auto_percentiles')}
                  >
                    <RefreshCw size={14} /> Recalcular distribución de tránsito ahora
                  </button>
                </div>
              )}
            </div>

            {/* Listado de Caminos Consolidados */}
            <div className="panel-card">
              <div className="card-header-row">
                <div>
                  <h1>Red de Caminos Consolidados ({roadsTotal})</h1>
                  <p>
                    Podés renombrar el nombre normalizado o seleccionar dos o más caminos que correspondan al mismo trazado para unificarlos conservando todos sus alias.
                  </p>
                </div>

                {selectedRoadIds.length >= 2 && (
                  <button
                    type="button"
                    className="btn-approve"
                    onClick={handleMergeSelectedRoads}
                  >
                    <Merge size={17} />
                    Unificar caminos seleccionados ({selectedRoadIds.length})
                  </button>
                )}
              </div>

              <div className="table-responsive">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th style={{ width: 42 }} />
                      <th>Nombre normalizado</th>
                      <th>Clasificación</th>
                      <th>Kilómetros</th>
                      <th>Recorridos aprobados</th>
                      <th>Usuarios distintos</th>
                      <th>Alias originales (nombres de vecinos)</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {roadsLoading ? (
                      <tr>
                        <td colSpan={8} className="empty-cell">
                          Cargando red de caminos...
                        </td>
                      </tr>
                    ) : roadsList.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="empty-cell">
                          Todavía no hay caminos consolidados. Hacé clic arriba en{' '}
                          <b>"Reprocesar toda la red desde cero"</b> o aprobá un recorrido.
                        </td>
                      </tr>
                    ) : (
                      roadsList.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selectedRoadIds.includes(r.id)}
                              onChange={() => toggleSelectRoadRow(r.id)}
                            />
                          </td>
                          <td>
                            {editingRoadId === r.id ? (
                              <div className="inline-edit-row">
                                <input
                                  type="text"
                                  value={editingRoadName}
                                  onChange={(e) => setEditingRoadName(e.target.value)}
                                />
                                <button
                                  type="button"
                                  className="btn-approve"
                                  onClick={() => handleSaveRoadName(r.id)}
                                >
                                  Guardar
                                </button>
                                <button
                                  type="button"
                                  className="btn-outline"
                                  onClick={() => setEditingRoadId(null)}
                                >
                                  Cancelar
                                </button>
                              </div>
                            ) : (
                              <strong>{r.normalized_name}</strong>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <select
                                  value={r.road_class}
                                  onChange={(e) => handleSetRoadClass(r.id, e.target.value as RoadClass, true)}
                                  style={{
                                    fontSize: '12px',
                                    fontWeight: 600,
                                    padding: '4px 8px',
                                    borderRadius: '6px',
                                    border: '1px solid #cbd5e1',
                                    background: '#ffffff',
                                    cursor: 'pointer',
                                  }}
                                >
                                  <option value="troncal">Troncal</option>
                                  <option value="principal">Principal</option>
                                  <option value="secundario">Secundario</option>
                                  <option value="vecinal">Vecinal</option>
                                </select>
                                {r.is_manual_class && (
                                  <span
                                    title="Categoría fijada manualmente por el Municipio"
                                    style={{
                                      fontSize: '11px',
                                      background: '#fef3c7',
                                      color: '#92400e',
                                      padding: '2px 6px',
                                      borderRadius: '4px',
                                      fontWeight: 600,
                                      whiteSpace: 'nowrap',
                                    }}
                                  >
                                    Fijado Admin
                                  </span>
                                )}
                              </div>
                              {r.is_manual_class && (
                                <button
                                  type="button"
                                  onClick={() => handleSetRoadClass(r.id, r.road_class, false)}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    color: '#0284c7',
                                    fontSize: '11px',
                                    cursor: 'pointer',
                                    padding: 0,
                                    textAlign: 'left',
                                    textDecoration: 'underline',
                                  }}
                                >
                                  Restablecer a automático
                                </button>
                              )}
                            </div>
                          </td>
                          <td>{formatDistance(Number(r.total_length_m))}</td>
                          <td>
                            <strong>{r.approved_trips_count}</strong>
                          </td>
                          <td>{r.unique_users_count}</td>
                          <td>
                            <div className="aliases-wrap">
                              {(r.aliases || []).map((al) => (
                                <span key={al} className="alias-chip">
                                  {al}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              type="button"
                              className="btn-table-action"
                              onClick={() => {
                                setEditingRoadId(r.id);
                                setEditingRoadName(r.normalized_name);
                              }}
                            >
                              <Edit3 size={14} style={{ marginRight: 4 }} />
                              Renombrar
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* SECCIÓN 5: RECLAMOS (Se completa en Fase 5) */}
        {section === 'claims' && (
          <div className="admin-page">
            <AdminClaimsSection
              selectedClaimIdFromMap={selectedClaimIdFromMap}
              onClearSelectedClaimFromMap={() => setSelectedClaimIdFromMap(null)}
              onFeedback={(msg) => {
                showToast(msg);
                loadDashboardSummary();
              }}
            />
          </div>
        )}
        {false && (
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

        {/* SECCIÓN INTERVENCIONES VIALES Y CATÁLOGOS (FASES 9, 10 Y 13) */}
        {section === 'interventions' && (
          <div className="admin-page">
            <div className="page-header">
              <div>
                <h1>Intervenciones Viales, Flota y Operarios</h1>
                <p>Programación de obras, catálogos municipales y validación de trabajos en campo</p>
              </div>
            </div>
            <AdminInterventionsSection
              roads={roadsList}
              onPendingCountChange={(cnt) => setPendingInterventionsCount(cnt)}
              onToast={(msg) => showToast(msg)}
            />
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
                            ) : operatorUserIds.has(u.id) ||
                              (u.email && operatorEmails.has(u.email.trim().toLowerCase())) ? (
                              <span className="badge-status status-pending">Operario</span>
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
            <div className="page-header">
              <div>
                <h1>Estadísticas e Indicadores Municipales</h1>
                <p>
                  Rankings de uso de la red vial, distribución por jerarquía y concentración geográfica de reclamos (PostGIS)
                </p>
              </div>
            </div>
            <AdminStatsSection />
          </div>
        )}
        {false && (
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
