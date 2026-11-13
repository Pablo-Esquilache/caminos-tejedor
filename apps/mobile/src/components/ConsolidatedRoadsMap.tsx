import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  CARLOS_TEJEDOR_CENTER,
  INTERVENTION_STATUS_LABELS,
  ROAD_CLASS_LABELS,
  type InterventionStatus,
  type MapInterventionFeature,
  type RoadClass,
} from '@shared';
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
  const [showInterventions, setShowInterventions] = useState(false);
  const [interventionsCount, setInterventionsCount] = useState(0);

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

    if (showInterventions) {
      const { data: intData } = await supabase.rpc('get_map_interventions_geojson', {
        p_min_lon: bounds.getWest(),
        p_min_lat: bounds.getSouth(),
        p_max_lon: bounds.getEast(),
        p_max_lat: bounds.getNorth(),
        p_include_planned: false,
      });
      if (Array.isArray(intData)) {
        const list = intData as MapInterventionFeature[];
        setInterventionsCount(list.length);
        renderInterventionsLayer(map, list);
      }
    } else {
      setInterventionsCount(0);
      renderInterventionsLayer(map, []);
    }
  };

  const renderInterventionsLayer = (
    map: maplibregl.Map,
    items: MapInterventionFeature[]
  ) => {
    if (!map.isStyleLoaded()) return;

    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: items
        .filter((i) => i.geojson)
        .map((i) => ({
          type: 'Feature',
          properties: {
            title: i.title,
            status: i.status,
            execution_mode: i.execution_mode,
            worked_length_m: i.worked_length_m,
            color: i.work_types?.[0]?.color || '#7c3aed',
            work_types_text: (i.work_types || []).map((w) => w.name).join(', '),
          },
          geometry: i.geojson,
        })),
    };

    const src = map.getSource('mobile-interventions-layer') as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(fc);
    } else {
      map.addSource('mobile-interventions-layer', { type: 'geojson', data: fc });
      map.addLayer({
        id: 'mobile-interventions-line',
        type: 'line',
        source: 'mobile-interventions-layer',
        filter: ['!=', '$type', 'Point'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 5,
          'line-opacity': 0.9,
        },
      });
      map.addLayer({
        id: 'mobile-interventions-point',
        type: 'circle',
        source: 'mobile-interventions-layer',
        filter: ['==', '$type', 'Point'],
        paint: {
          'circle-radius': 8,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
        },
      });

      const showPopup = (e: maplibregl.MapLayerMouseEvent) => {
        const feat = e.features?.[0];
        if (!feat || !feat.properties) return;
        const p = feat.properties;
        const stLabel =
          INTERVENTION_STATUS_LABELS[p.status as InterventionStatus] || String(p.status);
        new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(
            `<div style="font-size:13px;padding:4px">
              <strong>🚧 ${p.title}</strong><br/>
              Estado: <b>${stLabel}</b><br/>
              ${p.work_types_text ? `Obra: ${p.work_types_text}<br/>` : ''}
              ${p.execution_mode === 'punctual' ? 'Obra puntual georreferenciada' : `Tramo trabajado: ${formatDistance(Number(p.worked_length_m || 0))}`}
            </div>`
          )
          .addTo(map);
      };

      map.on('click', 'mobile-interventions-line', showPopup);
      map.on('click', 'mobile-interventions-point', showPopup);
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

  useEffect(() => {
    const map = mapRef.current;
    if (map && map.isStyleLoaded()) {
      loadRoadsInViewport(map);
    }
  }, [showInterventions]);

  return (
    <div className="card">
      <div>
        <h2>Mapa de Caminos e Intervenciones</h2>
        <p className="muted-text">
          Red vial rural consolidada ({segmentsCount} tramo(s)) y obras municipales aprobadas ({interventionsCount} en vista).
        </p>
      </div>

      <div className="road-legend-bar" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span><i className="dot-class troncal" /> Troncal</span>
          <span><i className="dot-class principal" /> Principal</span>
          <span><i className="dot-class secundario" /> Secundario</span>
          <span><i className="dot-class vecinal" /> Vecinal</span>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600 }}>
          <input
            type="checkbox"
            checked={showInterventions}
            onChange={(e) => setShowInterventions(e.target.checked)}
          />
          🚧 Obras ({interventionsCount})
        </label>
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
