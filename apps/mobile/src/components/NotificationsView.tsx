import React from 'react';
import { Bell, CheckCheck, ChevronRight, RefreshCw } from 'lucide-react';
import type { NotificationItem } from '@shared';

interface NotificationsViewProps {
  notifications: NotificationItem[];
  loading: boolean;
  onRefresh: () => void;
  onMarkOneRead: (id: string, claimId: string | null) => void;
  onMarkAllRead: () => void;
}

export const NotificationsView: React.FC<NotificationsViewProps> = ({
  notifications,
  loading,
  onRefresh,
  onMarkOneRead,
  onMarkAllRead,
}) => {
  const unreadCount = notifications.filter((n) => !n.is_read).length;

  return (
    <div className="trips-list-container">
      <div className="section-header">
        <div>
          <h2>Avisos y Notificaciones</h2>
          <p className="muted-text">
            {unreadCount > 0
              ? `Tenés ${unreadCount} aviso(s) sin leer`
              : 'Estás al día con tus notificaciones'}
          </p>
        </div>
        <div className="inline-btns">
          <button type="button" className="btn-small" onClick={onRefresh}>
            <RefreshCw size={14} />
          </button>
          {unreadCount > 0 && (
            <button type="button" className="btn-small" onClick={onMarkAllRead}>
              <CheckCheck size={14} /> Marcar leídos
            </button>
          )}
        </div>
      </div>

      {notifications.length === 0 && !loading && (
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
