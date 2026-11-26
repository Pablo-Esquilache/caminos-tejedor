import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { CARLOS_TEJEDOR_CENTER } from '@shared';
import { AlertTriangle, Layers, RefreshCw, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { getMapStyle } from '../lib/mapStyle';

export interface PublicAlertItem {
  id: string;
  title: string;
  description: string | null;
  category_id: string | null;
  category_name: string;
  category_color: string;
  lat: number;
  lon: number;
  alert_published_at: string | null;
  created_at: string;
  is_mine: boolean;
  storage_path: string | null;
  thumb_path: string | null;
}

const DEFAULT_ALERT_COLOR = '#dc2626';
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

function safeHexColor(val: string | null | undefined): string {
  return val && HEX_COLOR_RE.test(val) ? val : DEFAULT_ALERT_COLOR;
}

export const PublicAlertsMap: React.FC = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const alertsByIdRef = useRef<Map<string, PublicAlertItem>>(new Map());
  const styleRef = useRef<'hybrid' | 'streets'>('hybrid');

  const [mapStyle, setMapStyle] = useState<'hybrid' | 'streets'>('hybrid');
  const [alertsCount, setAlertsCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedAlert, setSelectedAlert] = useState<PublicAlertItem | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoError, setPhotoError] = useState(false);

  const renderAlertsOnMap = (map: maplibregl.Map, items: PublicAlertItem[]) => {
    const mapById = new Map<string, PublicAlertItem>();
    const features = items.map((item) => {
      mapById.set(item.id, item);
      return {
        type: 'Feature' as const,
        properties: {
          id: item.id,
          category_color: safeHexColor(item.category_color),
        },
        geometry: {
          type: 'Point' as const,
          coordinates: [item.lon, item.lat],
        },
      };
    });
    alertsByIdRef.current = mapById;

    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features,
    };

    try {
      const existing = map.getSource('public-alerts-src') as maplibregl.GeoJSONSource | undefined;
      if (existing) {
        existing.setData(fc as any);
        return;
      }

      map.addSource('public-alerts-src', {
        type: 'geojson',
        data: fc as any,
      });

      map.addLayer({
        id: 'public-alerts-halo',
        type: 'circle',
        source: 'public-alerts-src',
        paint: {
          'circle-radius': 13,
          'circle-color': ['get', 'category_color'],
          'circle-opacity': 0.22,
        },
      });

      map.addLayer({
        id: 'public-alerts-dots',
        type: 'circle',
        source: 'public-alerts-src',
        paint: {
          'circle-radius': 8,
          'circle-color': ['get', 'category_color'],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
        },
      });

      map.on('click', 'public-alerts-dots', (e) => {
        const feat = e.features?.[0];
        const id = feat?.properties?.id ? String(feat.properties.id) : null;
        if (!id) return;
        const found = alertsByIdRef.current.get(id);
        if (found) {
          setSelectedAlert(found);
        }
      });

      map.on('mouseenter', 'public-alerts-dots', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'public-alerts-dots', () => {
        map.getCanvas().style.cursor = '';
      });
    } catch {
      // Ignorar si el mapa se desmontó mientras se actualizaba
    }
  };

  const loadAlertsInViewport = async (map: maplibregl.Map) => {
    setLoading(true);
    setLoadError(null);
    try {
      const b = map.getBounds();
      const { data, error } = await supabase.rpc('get_public_claim_alerts', {
        p_min_lon: Math.max(-180, b.getWest() - 0.05),
        p_min_lat: Math.max(-90, b.getSouth() - 0.05),
        p_max_lon: Math.min(180, b.getEast() + 0.05),
        p_max_lat: Math.min(90, b.getNorth() + 0.05),
      });

      if (error) {
        setLoadError('No se pudieron cargar las alertas del mapa. Revisá tu conexión.');
        return;
      }

      const items = Array.isArray(data?.items) ? (data.items as PublicAlertItem[]) : [];
      setAlertsCount(items.length);
      setTruncated(Boolean(data?.truncated));
      renderAlertsOnMap(map, items);
    } catch {
      setLoadError('Sin señal para actualizar el mapa de alertas.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: getMapStyle(styleRef.current),
      center: [CARLOS_TEJEDOR_CENTER.longitude, CARLOS_TEJEDOR_CENTER.latitude],
      zoom: CARLOS_TEJEDOR_CENTER.defaultZoom,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    const handleLoad = () => {
      void loadAlertsInViewport(map);
    };
    const handleMoveEnd = () => {
      void loadAlertsInViewport(map);
    };

    map.on('load', handleLoad);
    map.on('moveend', handleMoveEnd);
    mapRef.current = map;

    return () => {
      map.off('load', handleLoad);
      map.off('moveend', handleMoveEnd);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Carga diferida de foto bajo demanda al tocar un puntito (URL firmada corta 300s)
  useEffect(() => {
    setPhotoUrl(null);
    setPhotoError(false);
    setPhotoLoading(false);

    if (!selectedAlert) return;
    const path = selectedAlert.thumb_path || selectedAlert.storage_path;
    if (!path) return;

    let cancelled = false;
    setPhotoLoading(true);
    (async () => {
      try {
        const { data, error } = await supabase.storage
          .from('claim-photos')
          .createSignedUrl(path, 300);
        if (cancelled) return;
        if (error || !data?.signedUrl) {
          setPhotoError(true);
        } else {
          setPhotoUrl(data.signedUrl);
        }
      } catch {
        if (!cancelled) setPhotoError(true);
      } finally {
        if (!cancelled) setPhotoLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedAlert?.id]);

  const toggleMapStyle = () => {
    const next = mapStyle === 'hybrid' ? 'streets' : 'hybrid';
    setMapStyle(next);
    styleRef.current = next;
    const map = mapRef.current;
    if (map) {
      map.setStyle(getMapStyle(next));
      map.once('idle', () => {
        void loadAlertsInViewport(map);
      });
    }
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: 'calc(100vh - 140px)', minHeight: 380 }}>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', borderRadius: 12, overflow: 'hidden' }}
      />

      {/* Barra superior compacta */}
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          right: 54,
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          alignItems: 'center',
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            background: 'rgba(15, 23, 42, 0.86)',
            color: '#fff',
            padding: '6px 10px',
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 600,
            pointerEvents: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <AlertTriangle size={14} />
          {loading
            ? 'Actualizando alertas...'
            : `${alertsCount} alerta(s) activa(s)${truncated ? ' (acercá el mapa)' : ''}`}
        </div>

        <button
          type="button"
          className="btn-small"
          style={{ pointerEvents: 'auto', background: '#fff' }}
          onClick={toggleMapStyle}
        >
          <Layers size={14} /> {mapStyle === 'hybrid' ? 'Calles' : 'Satélite'}
        </button>

        <button
          type="button"
          className="btn-small"
          style={{ pointerEvents: 'auto', background: '#fff' }}
          onClick={() => mapRef.current && loadAlertsInViewport(mapRef.current)}
          disabled={loading}
          aria-label="Actualizar alertas"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {loadError && (
        <div
          style={{
            position: 'absolute',
            top: 54,
            left: 10,
            right: 10,
            background: '#fef2f2',
            color: '#991b1b',
            border: '1px solid #fecaca',
            borderRadius: 10,
            padding: '8px 12px',
            fontSize: 12,
          }}
        >
          {loadError}
        </div>
      )}

      {/* Tarjeta de detalle React al tocar un puntito (sin innerHTML) */}
      {selectedAlert && (
        <div
          style={{
            position: 'absolute',
            left: 10,
            right: 10,
            bottom: 10,
            background: '#ffffff',
            borderRadius: 14,
            boxShadow: '0 10px 30px rgba(15, 23, 42, 0.25)',
            border: '1px solid #e2e8f0',
            padding: 14,
            maxHeight: '55%',
            overflowY: 'auto',
            zIndex: 10,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: '50%',
                  background: safeHexColor(selectedAlert.category_color),
                  display: 'inline-block',
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>
                {selectedAlert.category_name}
              </span>
              {selectedAlert.is_mine && (
                <span
                  style={{
                    fontSize: 11,
                    background: '#e0f2fe',
                    color: '#0369a1',
                    padding: '2px 7px',
                    borderRadius: 999,
                    fontWeight: 600,
                  }}
                >
                  Tu aviso
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setSelectedAlert(null)}
              style={{
                background: '#f1f5f9',
                border: 'none',
                borderRadius: '50%',
                width: 28,
                height: 28,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
              aria-label="Cerrar detalle de alerta"
            >
              <X size={16} />
            </button>
          </div>

          <h4 style={{ margin: '6px 0 4px', fontSize: 15, color: '#0f172a' }}>
            {selectedAlert.title}
          </h4>

          {selectedAlert.description && (
            <p style={{ margin: '0 0 8px', fontSize: 13, color: '#334155', lineHeight: 1.45 }}>
              {selectedAlert.description}
            </p>
          )}

          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
            Publicado el{' '}
            {new Date(
              selectedAlert.alert_published_at || selectedAlert.created_at
            ).toLocaleString('es-AR', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>

          {/* Foto cargada aparte bajo demanda (no traba el texto si hay poca señal) */}
          {(selectedAlert.storage_path || selectedAlert.thumb_path) && (
            <div>
              {photoLoading && (
                <div
                  style={{
                    padding: '12px',
                    background: '#f8fafc',
                    borderRadius: 8,
                    fontSize: 12,
                    color: '#475569',
                    textAlign: 'center',
                  }}
                >
                  Cargando fotografía...
                </div>
              )}
              {!photoLoading && photoUrl && (
                <img
                  src={photoUrl}
                  alt="Fotografía de la alerta vial"
                  style={{
                    width: '100%',
                    maxHeight: 200,
                    objectFit: 'cover',
                    borderRadius: 10,
                    border: '1px solid #e2e8f0',
                  }}
                  onError={() => {
                    setPhotoUrl(null);
                    setPhotoError(true);
                  }}
                />
              )}
              {!photoLoading && photoError && (
                <div
                  style={{
                    padding: '8px 10px',
                    background: '#fffbeb',
                    border: '1px solid #fde68a',
                    borderRadius: 8,
                    fontSize: 12,
                    color: '#92400e',
                  }}
                >
                  No se pudo descargar la foto por señal débil; la ubicación y descripción siguen disponibles.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
