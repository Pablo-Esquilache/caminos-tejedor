import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { CARLOS_TEJEDOR_CENTER } from '@shared';
import { getMapStyle } from '../lib/mapStyle';

interface RouteMapProps {
  coordinates: Array<[number, number]>; // [lon, lat]
  height?: string;
  followLastPoint?: boolean;
}

export const RouteMap: React.FC<RouteMapProps> = ({
  coordinates,
  height = '280px',
  followLastPoint = false,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapStyle, setMapStyle] = useState<'streets' | 'hybrid'>('hybrid');

  const renderRouteLayer = (map: maplibregl.Map, coords: Array<[number, number]>) => {
    const geojsonData: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features:
        coords.length >= 2
          ? [
              {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates: coords,
                },
              },
            ]
          : [],
    };

    const pointsData: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features:
        coords.length >= 1
          ? [
              {
                type: 'Feature',
                properties: { role: 'start', label: 'Inicio' },
                geometry: { type: 'Point', coordinates: coords[0] },
              },
              ...(coords.length >= 2
                ? [
                    {
                      type: 'Feature' as const,
                      properties: { role: 'end', label: 'Actual / Fin' },
                      geometry: {
                        type: 'Point' as const,
                        coordinates: coords[coords.length - 1],
                      },
                    },
                  ]
                : []),
            ]
          : [],
    };

    const existingRouteSource = map.getSource('route-line') as maplibregl.GeoJSONSource | undefined;
    if (existingRouteSource) {
      existingRouteSource.setData(geojsonData);
    } else {
      map.addSource('route-line', {
        type: 'geojson',
        data: geojsonData,
      });

      map.addLayer({
        id: 'route-line-casing',
        type: 'line',
        source: 'route-line',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': 8,
          'line-opacity': 0.85,
        },
      });

      map.addLayer({
        id: 'route-line-main',
        type: 'line',
        source: 'route-line',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#f59e0b',
          'line-width': 5,
        },
      });
    }

    const existingPtsSource = map.getSource('route-endpoints') as maplibregl.GeoJSONSource | undefined;
    if (existingPtsSource) {
      existingPtsSource.setData(pointsData);
    } else {
      map.addSource('route-endpoints', {
        type: 'geojson',
        data: pointsData,
      });

      map.addLayer({
        id: 'route-endpoints-circle',
        type: 'circle',
        source: 'route-endpoints',
        paint: {
          'circle-radius': 7,
          'circle-color': [
            'match',
            ['get', 'role'],
            'start',
            '#16a34a',
            '#ef4444',
          ],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
        },
      });
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const initialCenter: [number, number] =
      coordinates.length > 0
        ? coordinates[coordinates.length - 1]
        : [CARLOS_TEJEDOR_CENTER.longitude, CARLOS_TEJEDOR_CENTER.latitude];

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: getMapStyle(mapStyle),
      center: initialCenter,
      zoom: coordinates.length > 0 ? 13 : CARLOS_TEJEDOR_CENTER.defaultZoom,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    map.on('load', () => {
      renderRouteLayer(map, coordinates);
      if (coordinates.length >= 2 && !followLastPoint) {
        const bounds = coordinates.reduce(
          (b, coord) => b.extend(coord as [number, number]),
          new maplibregl.LngLatBounds(coordinates[0], coordinates[0])
        );
        map.fitBounds(bounds, { padding: 45, maxZoom: 15, duration: 400 });
      }
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [mapStyle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    renderRouteLayer(map, coordinates);

    if (coordinates.length > 0 && followLastPoint) {
      map.easeTo({
        center: coordinates[coordinates.length - 1],
        zoom: Math.max(map.getZoom(), 14),
        duration: 500,
      });
    } else if (coordinates.length >= 2 && !followLastPoint) {
      const bounds = coordinates.reduce(
        (b, coord) => b.extend(coord as [number, number]),
        new maplibregl.LngLatBounds(coordinates[0], coordinates[0])
      );
      map.fitBounds(bounds, { padding: 45, maxZoom: 15, duration: 400 });
    }
  }, [coordinates, followLastPoint]);

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
          Mapa Vial
        </button>
      </div>
    </div>
  );
};
