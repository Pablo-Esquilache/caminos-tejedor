import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { CARLOS_TEJEDOR_CENTER } from '@shared';
import { getMapStyle } from '../lib/mapStyle';

interface OperatorLiveMapProps {
  coordinates: Array<[number, number]>; // [lon, lat]
  plannedGeojson?: any | null;
  workedGeojson?: any | null;
  height?: string;
}

const THROTTLE_MS = 3500;

function extendBoundsFromCoords(bounds: maplibregl.LngLatBounds, coords: any): boolean {
  let added = false;
  const walk = (c: any) => {
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
      bounds.extend([c[0], c[1]]);
      added = true;
    } else if (Array.isArray(c)) {
      c.forEach(walk);
    }
  };
  walk(coords);
  return added;
}

/**
 * Mapa en vivo exclusivo para el Operario durante la ejecución lineal.
 * Muestra la traza planificada (punteada), lo ya trabajado y el GPS en vivo encima,
 * con throttling de 3.5s y pausa de redibujo cuando la app está oculta.
 */
export const OperatorLiveMap: React.FC<OperatorLiveMapProps> = ({
  coordinates,
  plannedGeojson = null,
  workedGeojson = null,
  height = '250px',
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapStyle, setMapStyle] = useState<'hybrid' | 'streets'>('hybrid');

  const latestPropsRef = useRef({ coordinates, plannedGeojson, workedGeojson });
  latestPropsRef.current = { coordinates, plannedGeojson, workedGeojson };

  const lastDrawAtRef = useRef<number>(0);
  const throttleTimerRef = useRef<number | null>(null);
  const hasCenteredOnLiveRef = useRef<boolean>(false);

  const renderOverlaySources = (map: maplibregl.Map, planned: any, worked: any) => {
    const plannedFc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: planned ? [{ type: 'Feature', properties: {}, geometry: planned }] : [],
    };
    const plannedSrc = map.getSource('op-live-planned') as maplibregl.GeoJSONSource | undefined;
    if (plannedSrc) {
      plannedSrc.setData(plannedFc as any);
    } else {
      map.addSource('op-live-planned', { type: 'geojson', data: plannedFc as any });
      map.addLayer({
        id: 'op-live-planned-line',
        type: 'line',
        source: 'op-live-planned',
        filter: ['!=', '$type', 'Point'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f59e0b', 'line-width': 4, 'line-dasharray': [2, 2] },
      });
      map.addLayer({
        id: 'op-live-planned-pt',
        type: 'circle',
        source: 'op-live-planned',
        filter: ['==', '$type', 'Point'],
        paint: {
          'circle-radius': 7,
          'circle-color': '#f59e0b',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });
    }

    const workedFc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: worked ? [{ type: 'Feature', properties: {}, geometry: worked }] : [],
    };
    const workedSrc = map.getSource('op-live-worked') as maplibregl.GeoJSONSource | undefined;
    if (workedSrc) {
      workedSrc.setData(workedFc as any);
    } else {
      map.addSource('op-live-worked', { type: 'geojson', data: workedFc as any });
      map.addLayer({
        id: 'op-live-worked-line',
        type: 'line',
        source: 'op-live-worked',
        filter: ['!=', '$type', 'Point'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#16a34a', 'line-width': 5, 'line-opacity': 0.8 },
      });
    }
  };

  const renderLiveTrack = (map: maplibregl.Map, coords: Array<[number, number]>) => {
    const lineData: GeoJSON.FeatureCollection = {
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

    const lineSrc = map.getSource('op-live-trace') as maplibregl.GeoJSONSource | undefined;
    if (lineSrc) {
      lineSrc.setData(lineData as any);
    } else {
      map.addSource('op-live-trace', { type: 'geojson', data: lineData as any });
      map.addLayer({
        id: 'op-live-trace-line',
        type: 'line',
        source: 'op-live-trace',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2563eb', 'line-width': 5, 'line-opacity': 0.95 },
      });
    }

    const lastPt = coords.length > 0 ? coords[coords.length - 1] : null;
    const headData: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: lastPt
        ? [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'Point', coordinates: lastPt },
            },
          ]
        : [],
    };

    const headSrc = map.getSource('op-live-head') as maplibregl.GeoJSONSource | undefined;
    if (headSrc) {
      headSrc.setData(headData as any);
    } else {
      map.addSource('op-live-head', { type: 'geojson', data: headData as any });
      map.addLayer({
        id: 'op-live-head-halo',
        type: 'circle',
        source: 'op-live-head',
        paint: { 'circle-radius': 13, 'circle-color': '#2563eb', 'circle-opacity': 0.25 },
      });
      map.addLayer({
        id: 'op-live-head-dot',
        type: 'circle',
        source: 'op-live-head',
        paint: {
          'circle-radius': 7,
          'circle-color': '#2563eb',
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
        },
      });
    }
  };

  const applyUpdateNow = () => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    const { coordinates: coords, plannedGeojson: planned, workedGeojson: worked } =
      latestPropsRef.current;
    renderOverlaySources(map, planned, worked);
    renderLiveTrack(map, coords);
    lastDrawAtRef.current = Date.now();

    if (coords.length > 0) {
      const target = coords[coords.length - 1];
      map.easeTo({
        center: target,
        zoom: hasCenteredOnLiveRef.current ? Math.max(map.getZoom(), 14.5) : 15,
        duration: 450,
      });
      hasCenteredOnLiveRef.current = true;
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;
    hasCenteredOnLiveRef.current = false;

    const { coordinates: initCoords, plannedGeojson: initPlanned, workedGeojson: initWorked } =
      latestPropsRef.current;

    const initialCenter: [number, number] =
      initCoords.length > 0
        ? initCoords[initCoords.length - 1]
        : [CARLOS_TEJEDOR_CENTER.longitude, CARLOS_TEJEDOR_CENTER.latitude];

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: getMapStyle(mapStyle),
      center: initialCenter,
      zoom: initCoords.length > 0 ? 15 : CARLOS_TEJEDOR_CENTER.defaultZoom,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    map.on('load', () => {
      const { coordinates: c, plannedGeojson: p, workedGeojson: w } = latestPropsRef.current;
      renderOverlaySources(map, p, w);
      renderLiveTrack(map, c);
      lastDrawAtRef.current = Date.now();

      if (c.length > 0) {
        hasCenteredOnLiveRef.current = true;
      } else {
        const bounds = new maplibregl.LngLatBounds();
        const hasP = p?.coordinates ? extendBoundsFromCoords(bounds, p.coordinates) : false;
        const hasW = w?.coordinates ? extendBoundsFromCoords(bounds, w.coordinates) : false;
        if ((hasP || hasW) && !bounds.isEmpty()) {
          map.fitBounds(bounds, { padding: 40, maxZoom: 15, duration: 300 });
        }
      }
    });

    mapRef.current = map;
    return () => {
      if (throttleTimerRef.current !== null) {
        window.clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      map.remove();
      mapRef.current = null;
    };
  }, [mapStyle]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        applyUpdateNow();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }

    const elapsed = Date.now() - lastDrawAtRef.current;
    if (elapsed >= THROTTLE_MS) {
      applyUpdateNow();
      return;
    }

    if (throttleTimerRef.current === null) {
      throttleTimerRef.current = window.setTimeout(() => {
        throttleTimerRef.current = null;
        applyUpdateNow();
      }, THROTTLE_MS - elapsed);
    }
  }, [coordinates, plannedGeojson, workedGeojson]);

  return (
    <div className="map-wrapper" style={{ height }}>
      <div ref={containerRef} className="map-canvas" />
      <div className="map-style-toggle">
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
          Mapa Base
        </button>
      </div>
    </div>
  );
};
