import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { CARLOS_TEJEDOR_CENTER } from '@shared';
import { maptilerApiKey, supabase } from '../lib/supabase';
import { formatDistance } from '../lib/format';

interface MapTripFeature {
  id: string;
  original_name: string;
  status: 'pending' | 'approved' | 'rejected';
  distance_m: number;
  duration_s: number;
  started_at: string;
  auto_approved: boolean;
  geojson: {
    type: 'LineString';
    coordinates: Array<[number, number]>;
  };
}

interface AdminMapProps {
  mode: 'general' | 'single';
  singleRouteCoords?: Array<[number, number]>;
  onSelectTripId?: (tripId: string) => void;
  height?: string;
}

export const AdminMap: React.FC<AdminMapProps> = ({
  mode,
  singleRouteCoords = [],
  onSelectTripId,
  height = '600px',
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapStyle, setMapStyle] = useState<'hybrid' | 'streets'>('hybrid');
  const [showApproved, setShowApproved] = useState(true);
  const [showPending, setShowPending] = useState(true);
  const [visibleCount, setVisibleCount] = useState(0);
  const [loadingBbox, setLoadingBbox] = useState(false);

  const getStyleUrl = (s: 'hybrid' | 'streets') => {
    const styleName = s === 'hybrid' ? 'hybrid' : 'streets-v2';
    return `https://api.maptiler.com/maps/${styleName}/style.json?key=${maptilerApiKey}`;
  };

  const fetchViewportTrips = async (map: maplibregl.Map) => {
    if (mode !== 'general') return;
    const statuses: string[] = [];
    if (showApproved) statuses.push('approved');
    if (showPending) statuses.push('pending');

    if (statuses.length === 0) {
      updateGeneralLayers(map, []);
      setVisibleCount(0);
      return;
    }

    const bounds = map.getBounds();
    setLoadingBbox(true);
    const { data, error } = await supabase.rpc('get_admin_map_trips', {
      p_min_lon: bounds.getWest(),
      p_min_lat: bounds.getSouth(),
      p_max_lon: bounds.getEast(),
      p_max_lat: bounds.getNorth(),
      p_statuses: statuses,
    });
    setLoadingBbox(false);

    if (!error && Array.isArray(data)) {
      const items = data as MapTripFeature[];
      setVisibleCount(items.length);
      updateGeneralLayers(map, items);
    }
  };

  const updateGeneralLayers = (map: maplibregl.Map, items: MapTripFeature[]) => {
    if (!map.isStyleLoaded()) return;

    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: items
        .filter((it) => it.geojson && Array.isArray(it.geojson.coordinates))
        .map((it) => ({
          type: 'Feature',
          properties: {
            id: it.id,
            original_name: it.original_name,
            status: it.status,
            distance_m: it.distance_m,
          },
          geometry: it.geojson,
        })),
    };

    const existing = map.getSource('admin-trips') as maplibregl.GeoJSONSource | undefined;
    if (existing) {
      existing.setData(fc);
    } else {
      map.addSource('admin-trips', {
        type: 'geojson',
        data: fc,
      });

      map.addLayer({
        id: 'admin-trips-casing',
        type: 'line',
        source: 'admin-trips',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': 7,
          'line-opacity': 0.8,
        },
      });

      map.addLayer({
        id: 'admin-trips-line',
        type: 'line',
        source: 'admin-trips',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': [
            'match',
            ['get', 'status'],
            'approved',
            '#16a34a',
            'pending',
            '#f59e0b',
            '#6b7280',
          ],
          'line-width': 4.5,
        },
      });

      map.on('mouseenter', 'admin-trips-line', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'admin-trips-line', () => {
        map.getCanvas().style.cursor = '';
      });

      map.on('click', 'admin-trips-line', (e) => {
        const feat = e.features?.[0];
        if (!feat || !feat.properties) return;
        const { id, original_name, status, distance_m } = feat.properties;

        const popupNode = document.createElement('div');
        popupNode.className = 'map-popup-box';
        popupNode.innerHTML = `
          <strong>${original_name}</strong>
          <div>Estado: <b>${status === 'approved' ? 'Aprobado' : 'Pendiente'}</b></div>
          <div>Distancia: ${formatDistance(Number(distance_m))}</div>
        `;
        if (onSelectTripId) {
          const btn = document.createElement('button');
          btn.className = 'popup-open-btn';
          btn.textContent = 'Abrir detalle del recorrido';
          btn.onclick = () => onSelectTripId(String(id));
          popupNode.appendChild(btn);
        }

        new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setDOMContent(popupNode)
          .addTo(map);
      });
    }
  };

  const updateSingleLayer = (map: maplibregl.Map, coords: Array<[number, number]>) => {
    if (!map.isStyleLoaded()) return;

    const lineFc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features:
        coords.length >= 2
          ? [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: coords },
              },
            ]
          : [],
    };

    const endpointsFc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features:
        coords.length >= 2
          ? [
              {
                type: 'Feature',
                properties: { role: 'start' },
                geometry: { type: 'Point', coordinates: coords[0] },
              },
              {
                type: 'Feature',
                properties: { role: 'end' },
                geometry: { type: 'Point', coordinates: coords[coords.length - 1] },
              },
            ]
          : [],
    };

    const src = map.getSource('single-trip') as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(lineFc);
    } else {
      map.addSource('single-trip', { type: 'geojson', data: lineFc });
      map.addLayer({
        id: 'single-trip-casing',
        type: 'line',
        source: 'single-trip',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 8 },
      });
      map.addLayer({
        id: 'single-trip-line',
        type: 'line',
        source: 'single-trip',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#f59e0b', 'line-width': 5 },
      });
    }

    const ptSrc = map.getSource('single-trip-pts') as maplibregl.GeoJSONSource | undefined;
    if (ptSrc) {
      ptSrc.setData(endpointsFc);
    } else {
      map.addSource('single-trip-pts', { type: 'geojson', data: endpointsFc });
      map.addLayer({
        id: 'single-trip-pts-circle',
        type: 'circle',
        source: 'single-trip-pts',
        paint: {
          'circle-radius': 7,
          'circle-color': ['match', ['get', 'role'], 'start', '#16a34a', '#dc2626'],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
        },
      });
    }

    if (coords.length >= 2) {
      const bounds = coords.reduce(
        (b, c) => b.extend(c as [number, number]),
        new maplibregl.LngLatBounds(coords[0], coords[0])
      );
      map.fitBounds(bounds, { padding: 55, maxZoom: 15, duration: 400 });
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: getStyleUrl(mapStyle),
      center: [CARLOS_TEJEDOR_CENTER.longitude, CARLOS_TEJEDOR_CENTER.latitude],
      zoom: CARLOS_TEJEDOR_CENTER.defaultZoom,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
      if (mode === 'general') {
        fetchViewportTrips(map);
      } else {
        updateSingleLayer(map, singleRouteCoords);
      }
    });

    map.on('moveend', () => {
      if (mode === 'general') {
        fetchViewportTrips(map);
      }
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [mapStyle, mode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    if (mode === 'general') {
      fetchViewportTrips(map);
    } else {
      updateSingleLayer(map, singleRouteCoords);
    }
  }, [showApproved, showPending, singleRouteCoords]);

  return (
    <div className="admin-map-wrapper" style={{ height }}>
      <div ref={containerRef} className="admin-map-canvas" />

      {/* Controles de Capas en Modo Mapa General */}
      {mode === 'general' && (
        <div className="map-layer-panel">
          <div className="layer-panel-title">Capas del Partido de Carlos Tejedor</div>
          <label className="layer-check">
            <input
              type="checkbox"
              checked={showApproved}
              onChange={(e) => setShowApproved(e.target.checked)}
            />
            <span className="legend-dot approved" />
            <span>Recorridos aprobados</span>
          </label>
          <label className="layer-check">
            <input
              type="checkbox"
              checked={showPending}
              onChange={(e) => setShowPending(e.target.checked)}
            />
            <span className="legend-dot pending" />
            <span>Recorridos pendientes de revisión</span>
          </label>
          <div className="layer-meta">
            {loadingBbox
              ? 'Consultando área visible...'
              : `${visibleCount} recorrido(s) en pantalla`}
          </div>
        </div>
      )}

      {/* Selector de estilo de mapa */}
      <div className="admin-map-style-switch">
        <button
          type="button"
          className={mapStyle === 'hybrid' ? 'active' : ''}
          onClick={() => setMapStyle('hybrid')}
        >
          Satélite + Caminos
        </button>
        <button
          type="button"
          className={mapStyle === 'streets' ? 'active' : ''}
          onClick={() => setMapStyle('streets')}
        >
          Mapa Vial
        </button>
      </div>
    </div>
  );
};
