import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { CARLOS_TEJEDOR_CENTER, ROAD_CLASS_LABELS, type RoadClass } from '@shared';
import { supabase } from '../lib/supabase';
import { getMapStyle } from '../lib/mapStyle';
import { formatDistance } from '../lib/geo';

interface ConsolidatedSegment {
  segment_id: string;
  road_id: string;
  normalized_name: string;
  road_class: RoadClass;
  total_length_m: number;
  approved_trips_count: number;
  geojson: {
    type: 'LineString';
    coordinates: Array<[number, number]>;
  };
}

export const ConsolidatedRoadsMap: React.FC = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapStyle, setMapStyle] = useState<'hybrid' | 'streets'>('hybrid');
  const [segmentsCount, setSegmentsCount] = useState(0);

  const loadRoadsInViewport = async (map: maplibregl.Map) => {
    const bounds = map.getBounds();
    const { data, error } = await supabase.rpc('get_consolidated_roads_map', {
      p_min_lon: bounds.getWest(),
      p_min_lat: bounds.getSouth(),
      p_max_lon: bounds.getEast(),
      p_max_lat: bounds.getNorth(),
      p_zoom: map.getZoom(),
    });

    if (!error && Array.isArray(data)) {
      const segs = data as ConsolidatedSegment[];
      setSegmentsCount(segs.length);
      renderConsolidatedLayer(map, segs);
    }
  };

  const renderConsolidatedLayer = (
    map: maplibregl.Map,
    segs: ConsolidatedSegment[]
  ) => {
    if (!map.isStyleLoaded()) return;

    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: segs
        .filter((s) => s.geojson && Array.isArray(s.geojson.coordinates))
        .map((s) => ({
          type: 'Feature',
          properties: {
            normalized_name: s.normalized_name,
            road_class: s.road_class,
            total_length_m: s.total_length_m,
            approved_trips_count: s.approved_trips_count,
          },
          geometry: s.geojson,
        })),
    };

    const existing = map.getSource('mobile-consolidated-roads') as
      | maplibregl.GeoJSONSource
      | undefined;

    if (existing) {
      existing.setData(fc);
    } else {
      map.addSource('mobile-consolidated-roads', {
        type: 'geojson',
        data: fc,
      });

      map.addLayer({
        id: 'mobile-roads-casing',
        type: 'line',
        source: 'mobile-consolidated-roads',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#0f172a',
          'line-width': [
            'match',
            ['get', 'road_class'],
            'troncal',
            9,
            'principal',
            7,
            'secundario',
            6,
            5,
          ],
          'line-opacity': 0.78,
        },
      });

      map.addLayer({
        id: 'mobile-roads-line',
        type: 'line',
        source: 'mobile-consolidated-roads',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': [
            'match',
            ['get', 'road_class'],
            'troncal',
            '#dc2626',
            'principal',
            '#ea580c',
            'secundario',
            '#2563eb',
            '#10b981',
          ],
          'line-width': [
            'match',
            ['get', 'road_class'],
            'troncal',
            6,
            'principal',
            4.5,
            'secundario',
            3.5,
            3,
          ],
        },
      });

      map.addLayer({
        id: 'mobile-roads-label',
        type: 'symbol',
        source: 'mobile-consolidated-roads',
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'normalized_name'],
          'text-size': 12,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#0f172a',
          'text-halo-width': 2,
        },
      });

      map.on('click', 'mobile-roads-line', (e) => {
        const feat = e.features?.[0];
        if (!feat || !feat.properties) return;
        const { normalized_name, road_class, total_length_m } = feat.properties;
        const label =
          ROAD_CLASS_LABELS[road_class as RoadClass] || String(road_class);

        new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(
            `<div style="font-size:13px;padding:4px">
              <strong>${normalized_name}</strong><br/>
              Categoría: <b>${label}</b><br/>
              Longitud: ${formatDistance(Number(total_length_m))}
            </div>`
          )
          .addTo(map);
      });
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: getMapStyle(mapStyle),
      center: [CARLOS_TEJEDOR_CENTER.longitude, CARLOS_TEJEDOR_CENTER.latitude],
      zoom: CARLOS_TEJEDOR_CENTER.defaultZoom,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    map.on('load', () => loadRoadsInViewport(map));
    map.on('moveend', () => loadRoadsInViewport(map));

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [mapStyle]);

  return (
    <div className="card">
      <div>
        <h2>Mapa de Caminos Consolidados</h2>
        <p className="muted-text">
          Red vial rural consolidada del Partido de Carlos Tejedor ({segmentsCount} tramo(s) en vista). Tocá un camino para ver su nombre y categoría.
        </p>
      </div>

      <div className="road-legend-bar">
        <span><i className="dot-class troncal" /> Troncal</span>
        <span><i className="dot-class principal" /> Principal</span>
        <span><i className="dot-class secundario" /> Secundario</span>
        <span><i className="dot-class vecinal" /> Vecinal</span>
      </div>

      <div className="map-wrapper" style={{ height: '410px' }}>
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
    </div>
  );
};
