import React from 'react';
import { AlertTriangle, Bell, CheckCheck, ChevronRight, RefreshCw } from 'lucide-react';
import type { NotificationItem } from '@shared';
import type { PublicAlertItem } from './PublicAlertsMap';

interface NotificationsViewProps {
  notifications: NotificationItem[];
  communityAlerts?: PublicAlertItem[];
  communityAlertsSeenAt?: number;
  loading: boolean;
  onRefresh: () => void;
  onMarkOneRead: (id: string, claimId: string | null) => void;
  onMarkAllRead: () => void;
  onOpenAlertsMap?: () => void;
}

export const NotificationsView: React.FC<NotificationsViewProps> = ({
  notifications,
  communityAlerts = [],
  communityAlertsSeenAt = 0,
  loading,
  onRefresh,
  onMarkOneRead,
  onMarkAllRead,
  onOpenAlertsMap,
}) => {
  const unreadCount = notifications.filter((n) => !n.is_read).length;
  const unreadCommunityCount = communityAlerts.filter(
    (a) => new Date(a.alert_published_at || a.created_at).getTime() > communityAlertsSeenAt
  ).length;
  const totalUnread = unreadCount + unreadCommunityCount;

  return (
    <div className="trips-list-container">
      <div className="section-header">
        <div>
          <h2>Avisos y Notificaciones</h2>
          <p className="muted-text">
            {totalUnread > 0
              ? `Tenés ${totalUnread} aviso(s) sin leer`
              : 'Estás al día con tus notificaciones'}
          </p>
        </div>
        <div className="inline-btns">
          <button type="button" className="btn-small" onClick={onRefresh}>
            <RefreshCw size={14} />
          </button>
          {totalUnread > 0 && (
            <button type="button" className="btn-small" onClick={onMarkAllRead}>
              <CheckCheck size={14} /> Marcar leídos
            </button>
          )}
        </div>
      </div>

      {communityAlerts.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
              fontWeight: 700,
              color: '#0f172a',
              marginBottom: 8,
            }}
          >
            <AlertTriangle size={15} color="#d97706" />
            <span>Alertas vecinales activas ({communityAlerts.length})</span>
          </div>
          {communityAlerts.map((alert) => {
            const pubTime = new Date(alert.alert_published_at || alert.created_at).getTime();
            const isNew = pubTime > communityAlertsSeenAt;
            return (
              <button
                key={`pub-${alert.id}`}
                type="button"
                className={`trip-row notification-row ${isNew ? 'unread' : ''}`}
                onClick={() => onOpenAlertsMap?.()}
              >
                <div className="trip-row-left">
                  <div className="notif-header-line">
                    {isNew && <span className="unread-dot" />}
                    <span
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: '50%',
                        background: /^#[0-9A-Fa-f]{6}$/.test(alert.category_color || '')
                          ? alert.category_color
                          : '#dc2626',
                        display: 'inline-block',
                        flexShrink: 0,
                      }}
                    />
                    <h4>
                      {alert.category_name}: {alert.title}
                    </h4>
                  </div>
                  {alert.description && <p className="notif-body">{alert.description}</p>}
                  <span className="trip-meta">
                    {new Date(alert.alert_published_at || alert.created_at).toLocaleString('es-AR', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    • Ver en el mapa
                  </span>
                </div>
                <div className="trip-row-right">
                  <ChevronRight size={18} />
                </div>
              </button>
            );
          })}
        </div>
      )}

      {notifications.length === 0 && communityAlerts.length === 0 && !loading && (
        <div className="card empty-state">
          <Bell size={32} />
          <p>Todavía no tenés avisos.</p>
          <p className="muted-text">
            Acá vas a recibir las actualizaciones sobre el estado de tus reclamos y la validación de tus recorridos.
          </p>
        </div>
      )}

      {notifications.map((n) => (
        <button
          key={n.id}
          type="button"
          className={`trip-row notification-row ${n.is_read ? '' : 'unread'}`}
          onClick={() => onMarkOneRead(n.id, n.claim_id)}
        >
          <div className="trip-row-left">
            <div className="notif-header-line">
              {!n.is_read && <span className="unread-dot" />}
              <h4>{n.title}</h4>
            </div>
            <p className="notif-body">{n.body}</p>
            <span className="trip-meta">
              {new Date(n.created_at).toLocaleString('es-AR', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
          {n.claim_id && (
            <div className="trip-row-right">
              <ChevronRight size={18} />
            </div>
          )}
        </button>
      ))}
    </div>
  );
};
