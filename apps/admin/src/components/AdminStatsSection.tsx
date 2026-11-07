import React, { useEffect, useState } from 'react';
import {
  AlertOctagon,
  BarChart3,
  Calendar,
  CheckCircle2,
  GitBranch,
  RefreshCw,
  Route,
  Users,
} from 'lucide-react';
import {
  CLAIM_PRIORITY_LABELS,
  CLAIM_STATUS_LABELS,
  ROAD_CLASS_LABELS,
  type ClaimPriority,
  type ClaimStatus,
  type RoadClass,
} from '@shared';
import { supabase } from '../lib/supabase';

interface StatsData {
  kpis: {
    total_roads: number;
    total_consolidated_km: number;
    total_trips: number;
    approved_trips: number;
    pending_trips: number;
    rejected_trips: number;
    active_users_count: number;
    total_claims: number;
    solved_claims: number;
    open_claims: number;
    dismissed_claims: number;
    resolution_rate_pct: number;
    claim_road_match_distance_m: number;
  };
  top_used_roads: Array<{
    id: string;
    normalized_name: string;
    road_class: RoadClass;
    length_km: number;
    period_approved_trips: number;
    period_unique_users: number;
  }>;
  roads_by_class: Array<{
    road_class: RoadClass;
    roads_count: number;
    total_km: number;
  }>;
  claims_by_status: Array<{
    status: ClaimStatus;
    count: number;
  }>;
  claims_by_category: Array<{
    category_id: string;
    category_name: string;
    is_active: boolean;
    count: number;
  }>;
  claims_by_priority: Array<{
    priority: ClaimPriority;
    count: number;
  }>;
  claims_monthly: Array<{
    month: string;
    total_created: number;
    solved_count: number;
  }>;
  top_claimed_roads: Array<{
    id: string;
    normalized_name: string;
    road_class: RoadClass;
    length_km: number;
    claims_count: number;
    open_claims_count: number;
    solved_claims_count: number;
  }>;
}

export const AdminStatsSection: React.FC = () => {
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const loadStatistics = async (fromVal = dateFrom, toVal = dateTo) => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_admin_statistics', {
      p_date_from: fromVal ? new Date(`${fromVal}T00:00:00`).toISOString() : null,
      p_date_to: toVal ? new Date(`${toVal}T23:59:59`).toISOString() : null,
    });
    if (!error && data) {
      setStats(data as StatsData);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadStatistics();
  }, [dateFrom, dateTo]);

  const setLast30Days = () => {
    const end = new Date();
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    setDateFrom(start.toISOString().slice(0, 10));
    setDateTo(end.toISOString().slice(0, 10));
  };

  const clearPeriod = () => {
    setDateFrom('');
    setDateTo('');
  };

  if (loading && !stats) {
    return (
      <div className="panel-card loading-pad">
        Calculando indicadores espaciales y estadísticas municipales...
      </div>
    );
  }

  if (!stats) return null;

  const { kpis } = stats;
  const maxClassKm = Math.max(
    1,
    ...stats.roads_by_class.map((r) => Number(r.total_km || 0))
  );
  const maxCatClaims = Math.max(
    1,
    ...stats.claims_by_category.map((c) => Number(c.count || 0))
  );
  const maxStatusClaims = Math.max(
    1,
    ...stats.claims_by_status.map((s) => Number(s.count || 0))
  );

  return (
    <div className="view-stack">
      {/* Barra de Filtro por Período */}
      <div className="filters-toolbar">
        <div className="filter-group">
          <Calendar size={16} />
          <strong>Período de análisis:</strong>
          <label>
            Desde:{' '}
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </label>
          <label>
            Hasta:{' '}
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </label>
          <button type="button" className="btn-sm" onClick={setLast30Days}>
            Últimos 30 días
          </button>
          <button type="button" className="btn-sm" onClick={clearPeriod}>
            Todo el historial
          </button>
        </div>

        <button
          type="button"
          className="btn-outline"
          onClick={() => loadStatistics()}
          disabled={loading}
        >
          <RefreshCw size={15} /> Actualizar
        </button>
      </div>

      {/* 1. KPIs Generales */}
      <div className="stats-kpi-grid-4">
        <div className="kpi-card highlight-approved">
          <span className="kpi-title">
            <GitBranch size={14} /> Red Vial Consolidada
          </span>
          <strong className="kpi-number">
            {Number(kpis.total_consolidated_km).toLocaleString('es-AR')} km
          </strong>
          <span className="kpi-sub">
            Distribuida en {kpis.total_roads} camino(s) consolidado(s)
          </span>
        </div>

        <div className="kpi-card">
          <span className="kpi-title">
            <Route size={14} /> Recorridos en el período
          </span>
          <strong className="kpi-number">{kpis.total_trips}</strong>
          <span className="kpi-sub">
            {kpis.approved_trips} aprobados • {kpis.pending_trips} pendientes •{' '}
            {kpis.rejected_trips} rechazados
          </span>
        </div>

        <div className="kpi-card">
          <span className="kpi-title">
            <Users size={14} /> Usuarios activos
          </span>
          <strong className="kpi-number">{kpis.active_users_count}</strong>
          <span className="kpi-sub">
            Vecinos/admins con aportes en el período seleccionado
          </span>
        </div>

        <div className="kpi-card highlight-pending">
          <span className="kpi-title">
            <CheckCircle2 size={14} /> Reclamos y Tasa de Resolución
          </span>
          <strong className="kpi-number">
            {kpis.total_claims} ({kpis.resolution_rate_pct}%)
          </strong>
          <span className="kpi-sub">
            {kpis.solved_claims} solucionados • {kpis.open_claims} en gestión •{' '}
            {kpis.dismissed_claims} desestimados
          </span>
        </div>
      </div>

      {/* 2. Distribución por Jerarquía y Top 10 Caminos Más Utilizados */}
      <div className="stats-two-cols">
        <div className="panel-card">
          <div>
            <h3>Distribución de Caminos por Jerarquía</h3>
            <p className="muted">
              Cantidad de caminos y kilómetros según clasificación de uso
            </p>
          </div>

          <div className="bar-chart-list">
            {stats.roads_by_class.map((item) => {
              const pct = Math.round((Number(item.total_km) / maxClassKm) * 100);
              return (
                <div key={item.road_class} className="bar-row">
                  <div className="bar-row-head">
                    <span className={`road-class-badge class-${item.road_class}`}>
                      {ROAD_CLASS_LABELS[item.road_class]}
                    </span>
                    <span>
                      <strong>{item.roads_count}</strong> camino(s) —{' '}
                      <b>{Number(item.total_km).toLocaleString('es-AR')} km</b>
                    </span>
                  </div>
                  <div className="bar-track">
                    <div
                      className={`bar-fill fill-${item.road_class}`}
                      style={{ width: `${Math.max(pct, item.roads_count > 0 ? 6 : 0)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel-card">
          <div>
            <h3>Top 10 Caminos Más Utilizados</h3>
            <p className="muted">
              Ordenados por cantidad de recorridos aprobados y longitud
            </p>
          </div>

          <div className="table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Camino</th>
                  <th>Jerarquía</th>
                  <th>Longitud</th>
                  <th>Recorridos</th>
                  <th>Usuarios</th>
                </tr>
              </thead>
              <tbody>
                {stats.top_used_roads.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="empty-cell">
                      Aún no hay caminos consolidados para mostrar en el ranking.
                    </td>
                  </tr>
                ) : (
                  stats.top_used_roads.map((r, idx) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{idx + 1}</strong>
                      </td>
                      <td>
                        <strong>{r.normalized_name}</strong>
                      </td>
                      <td>
                        <span className={`road-class-badge class-${r.road_class}`}>
                          {ROAD_CLASS_LABELS[r.road_class]}
                        </span>
                      </td>
                      <td>{Number(r.length_km).toLocaleString('es-AR')} km</td>
                      <td>
                        <strong>{r.period_approved_trips}</strong>
                      </td>
                      <td>{r.period_unique_users}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 3. Estadísticas de Reclamos por Estado, Categoría y Prioridad */}
      <div className="stats-two-cols">
        <div className="panel-card">
          <div>
            <h3>Reclamos por Estado y Prioridad</h3>
            <p className="muted">Desglose operativo de los reclamos del período</p>
          </div>

          <div className="bar-chart-list">
            {stats.claims_by_status.map((st) => {
              const pct = Math.round((st.count / maxStatusClaims) * 100);
              return (
                <div key={st.status} className="bar-row">
                  <div className="bar-row-head">
                    <span className={`claim-badge status-${st.status}`}>
                      {CLAIM_STATUS_LABELS[st.status]}
                    </span>
                    <strong>{st.count} reclamo(s)</strong>
                  </div>
                  <div className="bar-track">
                    <div
                      className="bar-fill fill-primary"
                      style={{ width: `${Math.max(pct, st.count > 0 ? 6 : 0)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="prio-summary-strip">
            {stats.claims_by_priority.map((p) => (
              <div key={p.priority} className="prio-stat-chip">
                <span className={`prio-badge prio-${p.priority}`}>
                  Prioridad {CLAIM_PRIORITY_LABELS[p.priority]}
                </span>
                <strong>{p.count}</strong>
              </div>
            ))}
          </div>
        </div>

        <div className="panel-card">
          <div>
            <h3>Reclamos por Categoría Vial</h3>
            <p className="muted">Tipos de inconvenientes más reportados en el partido</p>
          </div>

          <div className="bar-chart-list">
            {stats.claims_by_category.map((cat) => {
              const pct = Math.round((cat.count / maxCatClaims) * 100);
              return (
                <div key={cat.category_id} className="bar-row">
                  <div className="bar-row-head">
                    <span>
                      <strong>{cat.category_name}</strong>{' '}
                      {!cat.is_active && <small className="muted">(Inactiva)</small>}
                    </span>
                    <strong>{cat.count}</strong>
                  </div>
                  <div className="bar-track">
                    <div
                      className="bar-fill fill-accent"
                      style={{ width: `${Math.max(pct, cat.count > 0 ? 6 : 0)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 4. Top 10 Caminos con más Reclamos (Asociación Espacial PostGIS) y Evolución Mensual */}
      <div className="stats-two-cols">
        <div className="panel-card">
          <div>
            <h3>
              <AlertOctagon size={17} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              Top 10 Caminos con Más Reclamos (Cercanía PostGIS)
            </h3>
            <p className="muted">
              Asociación espacial automática (<code>ST_DWithin</code> en UTM 20S dentro de{' '}
              <b>{kpis.claim_road_match_distance_m} m</b> de la traza consolidada)
            </p>
          </div>

          <div className="table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Camino Consolidado</th>
                  <th>Jerarquía</th>
                  <th>Reclamos Totales</th>
                  <th>Activos</th>
                  <th>Solucionados</th>
                </tr>
              </thead>
              <tbody>
                {stats.top_claimed_roads.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="empty-cell">
                      No hay reclamos ubicados dentro de {kpis.claim_road_match_distance_m} m de un camino consolidado en este período.
                    </td>
                  </tr>
                ) : (
                  stats.top_claimed_roads.map((r, idx) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{idx + 1}</strong>
                      </td>
                      <td>
                        <strong>{r.normalized_name}</strong>
                      </td>
                      <td>
                        <span className={`road-class-badge class-${r.road_class}`}>
                          {ROAD_CLASS_LABELS[r.road_class]}
                        </span>
                      </td>
                      <td>
                        <strong>{r.claims_count}</strong>
                      </td>
                      <td>{r.open_claims_count}</td>
                      <td>{r.solved_claims_count}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel-card">
          <div>
            <h3>
              <BarChart3 size={17} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              Evolución Mensual de Reclamos
            </h3>
            <p className="muted">Reclamos ingresados vs solucionados por mes</p>
          </div>

          <div className="table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Mes (AAAA-MM)</th>
                  <th>Reclamos Ingresados</th>
                  <th>Solucionados</th>
                </tr>
              </thead>
              <tbody>
                {stats.claims_monthly.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="empty-cell">
                      Sin reclamos registrados en el período seleccionado.
                    </td>
                  </tr>
                ) : (
                  stats.claims_monthly.map((m) => (
                    <tr key={m.month}>
                      <td>
                        <strong>{m.month}</strong>
                      </td>
                      <td>{m.total_created}</td>
                      <td>{m.solved_count}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
