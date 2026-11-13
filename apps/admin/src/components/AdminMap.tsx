import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  CARLOS_TEJEDOR_CENTER,
  CLAIM_PRIORITY_LABELS,
  CLAIM_STATUS_LABELS,
  ROAD_CLASS_LABELS,
  type ClaimPriority,
  type ClaimStatus,
  INTERVENTION_STATUS_LABELS,
  type InterventionStatus,
  type MapInterventionFeature,
  type RoadClass,
} from '@shared';
import { supabase } from '../lib/supabase';
import { getMapStyle } from '../lib/mapStyle';
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

interface MapRoadSegmentFeature {
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

interface MapClaimPointFeature {
  id: string;
  title: string;
  status: ClaimStatus;
  priority: ClaimPriority;
  category_id: string;
  category_name: string;
  category_icon: string | null;
  lat: number;
  lon: number;
  created_at: string;
}

interface AdminMapProps {
  mode: 'general' | 'single';
  singleRouteCoords?: Array<[number, number]>;
  singlePointCoords?: [number, number] | null;
  onSelectTripId?: (tripId: string) => void;
  onSelectClaimId?: (claimId: string) => void;
  height?: string;
}

export const AdminMap: React.FC<AdminMapProps> = ({
  mode,
  singleRouteCoords = [],
  singlePointCoords = null,
  onSelectTripId,
  onSelectClaimId,
  height = '600px',
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapStyle, setMapStyle] = useState<'hybrid' | 'streets'>('hybrid');
  const [showConsolidatedRoads, setShowConsolidatedRoads] = useState(true);
  const [showClaimsLayer, setShowClaimsLayer] = useState(true);
  const [showInterventionsLayer, setShowInterventionsLayer] = useState(true);
  const [visibleInterventionsCount, setVisibleInterventionsCount] = useState(0);
  const [showApproved, setShowApproved] = useState(false);
  const [showPending, setShowPending] = useState(true);
  const [visibleCount, setVisibleCount] = useState(0);
  const [visibleRoadsCount, setVisibleRoadsCount] = useState(0);
  const [visibleClaimsCount, setVisibleClaimsCount] = useState(0);
  const [loadingBbox, setLoadingBbox] = useState(false);

  const layersStateRef = useRef({
    showConsolidatedRoads,
    showClaimsLayer,
    showInterventionsLayer,
    showApproved,
    showPending,
  });
  layersStateRef.current = {
    showConsolidatedRoads,
    showClaimsLayer,
    showInterventionsLayer,
    showApproved,
    showPending,
  };

  const viewportCacheRef = useRef<{
    key: string;
    roads: MapRoadSegmentFeature[] | null;
    claims: MapClaimPointFeature[] | null;
    interventions: MapInterventionFeature[] | null;
    trips: MapTripFeature[] | null;
  }>({
    key: '',
    roads: null,
    claims: null,
    interventions: null,
    trips: null,
  });

  const setLayerGroupVisibility = (map: maplibregl.Map, layerIds: string[], visible: boolean) => {
    const val = visible ? 'visible' : 'none';
    for (const id of layerIds) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', val);
      }
    }
  };

  const fetchViewportData = async (map: maplibregl.Map) => {
    if (mode !== 'general') return;
    const bounds = map.getBounds();
    const zoom = map.getZoom();
    const viewportKey = `${bounds.getWest().toFixed(5)},${bounds.getSouth().toFixed(5)},${bounds.getEast().toFixed(5)},${bounds.getNorth().toFixed(5)}@${zoom.toFixed(2)}`;

    if (viewportCacheRef.current.key !== viewportKey) {
      viewportCacheRef.current = {
        key: viewportKey,
        roads: null,
        claims: null,
        interventions: null,
        trips: null,
      };
    }

    const {
      showConsolidatedRoads: wantRoads,
      showClaimsLayer: wantClaims,
      showInterventionsLayer: wantInterventions,
      showApproved: wantApproved,
      showPending: wantPending,
    } = layersStateRef.current;

    const cache = viewportCacheRef.current;
    const pendingRequests: Promise<void>[] = [];

    // 1. Red de Caminos Consolidados
    const roadLayerIds = ['consolidated-roads-casing', 'consolidated-roads-line', 'consolidated-roads-label'];
    if (!wantRoads) {
      setVisibleRoadsCount(0);
      setLayerGroupVisibility(map, roadLayerIds, false);
    } else if (cache.roads !== null) {
      setVisibleRoadsCount(cache.roads.length);
      setLayerGroupVisibility(map, roadLayerIds, true);
    } else {
      pendingRequests.push(
        (async () => {
          const { data: roadData } = await supabase.rpc('get_consolidated_roads_map', {
            p_min_lon: bounds.getWest(),
            p_min_lat: bounds.getSouth(),
            p_max_lon: bounds.getEast(),
            p_max_lat: bounds.getNorth(),
            p_zoom: zoom,
          });
          if (Array.isArray(roadData)) {
            const segs = roadData as MapRoadSegmentFeature[];
            cache.roads = segs;
            if (layersStateRef.current.showConsolidatedRoads) {
              setVisibleRoadsCount(segs.length);
              updateConsolidatedRoadsLayer(map, segs);
              setLayerGroupVisibility(map, roadLayerIds, true);
            }
          }
        })()
      );
    }

    // 2. Reclamos Georreferenciados con Clustering
    const claimLayerIds = ['admin-claims-clusters', 'admin-claims-cluster-count', 'admin-claims-unclustered', 'admin-claims-label'];
    if (!wantClaims) {
      setVisibleClaimsCount(0);
      setLayerGroupVisibility(map, claimLayerIds, false);
    } else if (cache.claims !== null) {
      setVisibleClaimsCount(cache.claims.length);
      setLayerGroupVisibility(map, claimLayerIds, true);
    } else {
      pendingRequests.push(
        (async () => {
          const { data: claimData } = await supabase.rpc('get_admin_map_claims', {
            p_min_lon: bounds.getWest(),
            p_min_lat: bounds.getSouth(),
            p_max_lon: bounds.getEast(),
            p_max_lat: bounds.getNorth(),
            p_status: null,
            p_category_id: null,
          });
          if (Array.isArray(claimData)) {
            const claims = claimData as MapClaimPointFeature[];
            cache.claims = claims;
            if (layersStateRef.current.showClaimsLayer) {
              setVisibleClaimsCount(claims.length);
              updateClaimsClusterLayer(map, claims);
              setLayerGroupVisibility(map, claimLayerIds, true);
            }
          }
        })()
      );
    }

    // 3. Intervenciones Viales
    const intLayerIds = ['interventions-linear-approved', 'interventions-linear-active', 'interventions-punctual-pts'];
    if (!wantInterventions) {
      setVisibleInterventionsCount(0);
      setLayerGroupVisibility(map, intLayerIds, false);
    } else if (cache.interventions !== null) {
      setVisibleInterventionsCount(cache.interventions.length);
      setLayerGroupVisibility(map, intLayerIds, true);
    } else {
      pendingRequests.push(
        (async () => {
          const { data: intData } = await supabase.rpc('get_map_interventions_geojson', {
            p_min_lon: bounds.getWest(),
            p_min_lat: bounds.getSouth(),
            p_max_lon: bounds.getEast(),
            p_max_lat: bounds.getNorth(),
            p_include_planned: true,
          });
          if (Array.isArray(intData)) {
            const list = intData as MapInterventionFeature[];
            cache.interventions = list;
            if (layersStateRef.current.showInterventionsLayer) {
              setVisibleInterventionsCount(list.length);
              updateInterventionsLayer(map, list);
              setLayerGroupVisibility(map, intLayerIds, true);
            }
          }
        })()
      );
    }

    // 4. Recorridos individuales (aprobados / pendientes)
    const tripLayerIds = ['admin-trips-casing', 'admin-trips-line'];
    if (!wantApproved && !wantPending) {
      setVisibleCount(0);
      setLayerGroupVisibility(map, tripLayerIds, false);
    } else if (cache.trips !== null) {
      const filtered = cache.trips.filter(
        (it) => (wantApproved && it.status === 'approved') || (wantPending && it.status === 'pending')
      );
      setVisibleCount(filtered.length);
      updateGeneralLayers(map, filtered);
      setLayerGroupVisibility(map, tripLayerIds, filtered.length > 0);
    } else {
      pendingRequests.push(
        (async () => {
          const { data, error } = await supabase.rpc('get_admin_map_trips', {
            p_min_lon: bounds.getWest(),
            p_min_lat: bounds.getSouth(),
            p_max_lon: bounds.getEast(),
            p_max_lat: bounds.getNorth(),
            p_statuses: ['approved', 'pending'],
          });
          if (!error && Array.isArray(data)) {
            const items = data as MapTripFeature[];
            cache.trips = items;
            const cur = layersStateRef.current;
            const filtered = items.filter(
              (it) => (cur.showApproved && it.status === 'approved') || (cur.showPending && it.status === 'pending')
            );
            setVisibleCount(filtered.length);
            updateGeneralLayers(map, filtered);
            setLayerGroupVisibility(map, tripLayerIds, filtered.length > 0);
          }
        })()
      );
    }

    if (pendingRequests.length > 0) {
      setLoadingBbox(true);
      try {
        await Promise.all(pendingRequests);
      } finally {
        setLoadingBbox(false);
      }
    } else {
      setLoadingBbox(false);
    }
  };

  const updateInterventionsLayer = (
    map: maplibregl.Map,
    interventions: MapInterventionFeature[]
  ) => {
    if (!map.isStyleLoaded()) return;

    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: interventions
        .filter((i) => i.geojson)
        .map((i) => {
          const wtColor = i.work_types?.[0]?.color || '#7c3aed';
          return {
            type: 'Feature',
            properties: {
              id: i.id,
              title: i.title,
              status: i.status,
              execution_mode: i.execution_mode,
              worked_length_m: i.worked_length_m,
              planned_length_m: i.planned_length_m,
              color: wtColor,
              work_types_text: (i.work_types || []).map((w) => w.name).join(', '),
              machines_text: (i.machines || []).map((m) => m.name).join(', '),
              road_name: i.road_name || '',
            },
            geometry: i.geojson,
          };
        }),
    };

    const existing = map.getSource('interventions-layer') as maplibregl.GeoJSONSource | undefined;
    if (existing) {
      existing.setData(fc);
    } else {
      map.addSource('interventions-layer', { type: 'geojson', data: fc });

      // Trabajos lineales aprobados (sólido)
      map.addLayer({
        id: 'interventions-linear-approved',
        type: 'line',
        source: 'interventions-layer',
        filter: ['all', ['!=', '$type', 'Point'], ['==', 'status', 'approved']],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 5,
          'line-opacity': 0.9,
        },
      });

      // Trabajos lineales programados / en ejecución / por aprobar (punteado)
      map.addLayer({
        id: 'interventions-linear-active',
        type: 'line',
        source: 'interventions-layer',
        filter: ['all', ['!=', '$type', 'Point'], ['!=', 'status', 'approved']],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#f59e0b',
          'line-width': 4,
          'line-dasharray': [2, 2],
        },
      });

      // Trabajos puntuales (alcantarillas / bacheo)
      map.addLayer({
        id: 'interventions-punctual-pts',
        type: 'circle',
        source: 'interventions-layer',
        filter: ['==', '$type', 'Point'],
        paint: {
          'circle-radius': 8,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
        },
      });

      const showIntPopup = (e: maplibregl.MapLayerMouseEvent) => {
        const feat = e.features?.[0];
        if (!feat || !feat.properties) return;
        const p = feat.properties;
        const stLabel =
          INTERVENTION_STATUS_LABELS[p.status as InterventionStatus] || String(p.status);
        const lenStr =
          p.execution_mode === 'punctual'
            ? 'Obra puntual georreferenciada'
            : Number(p.worked_length_m) > 0
              ? `Trabajado neto: ${formatDistance(Number(p.worked_length_m))}`
              : `Planificado: ${formatDistance(Number(p.planned_length_m || 0))}`;

        const popupNode = document.createElement('div');
        popupNode.className = 'map-popup-box';
        popupNode.innerHTML = `
          <strong>🚧 ${p.title}</strong>
          <div>Estado: <b>${stLabel}</b></div>
          ${p.work_types_text ? `<div>Obra: ${p.work_types_text}</div>` : ''}
          ${p.machines_text ? `<div>Equipo: ${p.machines_text}</div>` : ''}
          <div>${lenStr}</div>
        `;
        new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setDOMContent(popupNode)
          .addTo(map);
      };

      map.on('click', 'interventions-linear-approved', showIntPopup);
      map.on('click', 'interventions-linear-active', showIntPopup);
      map.on('click', 'interventions-punctual-pts', showIntPopup);
    }
  };

  const updateConsolidatedRoadsLayer = (
    map: maplibregl.Map,
    segs: MapRoadSegmentFeature[]
  ) => {
    if (!map.isStyleLoaded()) return;

    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: segs
        .filter((s) => s.geojson && Array.isArray(s.geojson.coordinates))
        .map((s) => ({
          type: 'Feature',
          properties: {
            segment_id: s.segment_id,
            road_id: s.road_id,
            normalized_name: s.normalized_name,
            road_class: s.road_class,
            total_length_m: s.total_length_m,
            approved_trips_count: s.approved_trips_count,
          },
          geometry: s.geojson,
        })),
    };

    const existing = map.getSource('consolidated-roads') as
      | maplibregl.GeoJSONSource
      | undefined;
    if (existing) {
      existing.setData(fc);
    } else {
      map.addSource('consolidated-roads', {
        type: 'geojson',
        data: fc,
      });

      map.addLayer({
        id: 'consolidated-roads-casing',
        type: 'line',
        source: 'consolidated-roads',
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
          'line-opacity': 0.75,
        },
      });

      map.addLayer({
        id: 'consolidated-roads-line',
        type: 'line',
        source: 'consolidated-roads',
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
        id: 'consolidated-roads-label',
        type: 'symbol',
        source: 'consolidated-roads',
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'normalized_name'],
          'text-size': 12,
          'text-offset': [0, -0.8],
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#0f172a',
          'text-halo-width': 2,
        },
      });

      map.on('click', 'consolidated-roads-line', (e) => {
        const feat = e.features?.[0];
        if (!feat || !feat.properties) return;
        const { normalized_name, road_class, total_length_m, approved_trips_count } =
          feat.properties;
        const classLabel =
          ROAD_CLASS_LABELS[road_class as RoadClass] || String(road_class);

        const popupNode = document.createElement('div');
        popupNode.className = 'map-popup-box';
        popupNode.innerHTML = `
          <strong>${normalized_name}</strong>
          <div>Jerarquía: <b>${classLabel}</b></div>
          <div>Longitud: ${formatDistance(Number(total_length_m))}</div>
          <div>Recorridos aprobados: <b>${approved_trips_count}</b></div>
        `;

        new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setDOMContent(popupNode)
          .addTo(map);
      });
    }
  };

  const updateClaimsClusterLayer = (
    map: maplibregl.Map,
    claims: MapClaimPointFeature[]
  ) => {
    if (!map.isStyleLoaded()) return;

    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: claims.map((c) => ({
        type: 'Feature',
        properties: {
          id: c.id,
          title: c.title,
          status: c.status,
          priority: c.priority,
          category_name: c.category_name,
        },
        geometry: {
          type: 'Point',
          coordinates: [c.lon, c.lat],
        },
      })),
    };

    const existing = map.getSource('admin-claims') as
      | maplibregl.GeoJSONSource
      | undefined;
    if (existing) {
      existing.setData(fc);
    } else {
      map.addSource('admin-claims', {
        type: 'geojson',
        data: fc,
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 45,
      });

      // Círculos de clusters de reclamos cercanos
      map.addLayer({
        id: 'admin-claims-clusters',
        type: 'circle',
        source: 'admin-claims',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': [
            'step',
            ['get', 'point_count'],
            '#dc2626',
            5,
            '#b91c1c',
            15,
            '#7f1d1d',
          ],
          'circle-radius': ['step', ['get', 'point_count'], 18, 5, 22, 15, 26],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
        },
      });

      // Cantidad dentro de cada cluster
      map.addLayer({
        id: 'admin-claims-cluster-count',
        type: 'symbol',
        source: 'admin-claims',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': '{point_count_abbreviated}',
          'text-size': 12,
        },
        paint: {
          'text-color': '#ffffff',
        },
      });

      // Marcadores individuales de reclamos cuando no están agrupados
      map.addLayer({
        id: 'admin-claims-unclustered',
        type: 'circle',
        source: 'admin-claims',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': [
            'match',
            ['get', 'status'],
            'solved',
            '#16a34a',
            'in_progress',
            '#ea580c',
            'evaluating',
            '#d97706',
            'dismissed',
            '#6b7280',
            '#dc2626',
          ],
          'circle-radius': [
            'match',
            ['get', 'priority'],
            'high',
            10,
            'medium',
            8,
            7,
          ],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
        },
      });

      map.addLayer({
        id: 'admin-claims-label',
        type: 'symbol',
        source: 'admin-claims',
        filter: ['!', ['has', 'point_count']],
        layout: {
          'text-field': ['get', 'category_name'],
          'text-size': 11,
          'text-offset': [0, 1.3],
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#0f172a',
          'text-halo-width': 1.8,
        },
      });

      // Al hacer clic en un cluster, hacer zoom para expandir
      map.on('click', 'admin-claims-clusters', async (e) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: ['admin-claims-clusters'],
        });
        const clusterId = features[0]?.properties?.cluster_id;
        const source = map.getSource('admin-claims') as maplibregl.GeoJSONSource;
        if (clusterId !== undefined && source) {
          const zoom = await source.getClusterExpansionZoom(clusterId);
          const geom = features[0].geometry as GeoJSON.Point;
          map.easeTo({
            center: geom.coordinates as [number, number],
            zoom,
          });
        }
      });

      // Al hacer clic en un reclamo individual, mostrar popup y botón para abrir detalle
      map.on('click', 'admin-claims-unclustered', (e) => {
        const feat = e.features?.[0];
        if (!feat || !feat.properties) return;
        const { id, title, status, priority, category_name } = feat.properties;

        const statusLabel =
          CLAIM_STATUS_LABELS[status as ClaimStatus] || String(status);
        const prioLabel =
          CLAIM_PRIORITY_LABELS[priority as ClaimPriority] || String(priority);

        const popupNode = document.createElement('div');
        popupNode.className = 'map-popup-box';
        popupNode.innerHTML = `
          <strong>Reclamo: ${title}</strong>
          <div>Categoría: <b>${category_name}</b></div>
          <div>Estado: <b>${statusLabel}</b> • Prioridad: <b>${prioLabel}</b></div>
        `;

        if (onSelectClaimId) {
          const btn = document.createElement('button');
          btn.className = 'popup-open-btn';
          btn.textContent = 'Gestionar este reclamo';
          btn.onclick = () => onSelectClaimId(String(id));
          popupNode.appendChild(btn);
        }

        new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setDOMContent(popupNode)
          .addTo(map);
      });
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
          'line-width': 6,
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
          'line-width': 4,
          'line-dasharray': [2, 1],
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
          <strong>Recorrido: ${original_name}</strong>
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

  const updateSingleLayer = (
    map: maplibregl.Map,
    coords: Array<[number, number]>,
    pointCoords: [number, number] | null
  ) => {
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
          : pointCoords
            ? [
                {
                  type: 'Feature',
                  properties: { role: 'end' },
                  geometry: { type: 'Point', coordinates: pointCoords },
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
          'circle-radius': 8,
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
    } else if (pointCoords) {
      map.easeTo({ center: pointCoords, zoom: 14, duration: 400 });
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

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
      if (mode === 'general') {
        fetchViewportData(map);
      } else {
        updateSingleLayer(map, singleRouteCoords, singlePointCoords);
      }
    });

    map.on('moveend', () => {
      if (mode === 'general') {
        fetchViewportData(map);
      }
    });

    mapRef.current = map;

    return () => {
      viewportCacheRef.current = { key: '', roads: null, claims: null, interventions: null, trips: null };
      map.remove();
      mapRef.current = null;
    };
  }, [mapStyle, mode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    if (mode === 'general') {
      fetchViewportData(map);
    } else {
      updateSingleLayer(map, singleRouteCoords, singlePointCoords);
    }
  }, [
    showConsolidatedRoads,
    showClaimsLayer,
    showInterventionsLayer,
    showApproved,
    showPending,
    singleRouteCoords,
    singlePointCoords,
  ]);

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
              checked={showConsolidatedRoads}
              onChange={(e) => setShowConsolidatedRoads(e.target.checked)}
            />
            <span className="legend-dot consolidated" />
            <span>
              <strong>Red Consolidada de Caminos</strong> ({visibleRoadsCount} tramos)
            </span>
          </label>
          <label className="layer-check">
            <input
              type="checkbox"
              checked={showClaimsLayer}
              onChange={(e) => setShowClaimsLayer(e.target.checked)}
            />
            <span className="legend-dot claim-dot" />
            <span>
              <strong>Reclamos Viales (Cluster)</strong> ({visibleClaimsCount} en vista)
            </span>
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
          <label className="layer-check">
            <input
              type="checkbox"
              checked={showInterventionsLayer}
              onChange={(e) => setShowInterventionsLayer(e.target.checked)}
            />
            <span className="legend-dot" style={{ background: '#7c3aed' }} />
            <span>
              <strong>Intervenciones Viales</strong> ({visibleInterventionsCount} en vista)
            </span>
          </label>
          <label className="layer-check">
            <input
              type="checkbox"
              checked={showApproved}
              onChange={(e) => setShowApproved(e.target.checked)}
            />
            <span className="legend-dot approved" />
            <span>Trazas individuales aprobadas</span>
          </label>
          <div className="layer-meta">
            {loadingBbox
              ? 'Consultando área visible...'
              : `${visibleRoadsCount} tramo(s) • ${visibleClaimsCount} reclamo(s) • ${visibleCount} recorrido(s)`}
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
