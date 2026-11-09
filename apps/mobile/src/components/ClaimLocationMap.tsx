import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { CARLOS_TEJEDOR_CENTER } from '@shared';
import { getMapStyle } from '../lib/mapStyle';

interface ClaimLocationMapProps {
  lat: number;
  lon: number;
  editable?: boolean;
  onChangeLocation?: (lat: number, lon: number) => void;
  height?: string;
}

export const ClaimLocationMap: React.FC<ClaimLocationMapProps> = ({
  lat,
  lon,
  editable = false,
  onChangeLocation,
  height = '220px',
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const [mapStyle, setMapStyle] = useState<'hybrid' | 'streets'>('hybrid');

  useEffect(() => {
    if (!containerRef.current) return;

    const initialLon = Number.isFinite(lon) ? lon : CARLOS_TEJEDOR_CENTER.longitude;
    const initialLat = Number.isFinite(lat) ? lat : CARLOS_TEJEDOR_CENTER.latitude;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: getMapStyle(mapStyle),
      center: [initialLon, initialLat],
      zoom: 13.5,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    const marker = new maplibregl.Marker({
      color: '#dc2626',
      draggable: editable,
    })
      .setLngLat([initialLon, initialLat])
      .addTo(map);

    if (editable && onChangeLocation) {
      marker.on('dragend', () => {
        const lngLat = marker.getLngLat();
        onChangeLocation(Number(lngLat.lat.toFixed(6)), Number(lngLat.lng.toFixed(6)));
      });

      map.on('click', (e) => {
        marker.setLngLat(e.lngLat);
        onChangeLocation(Number(e.lngLat.lat.toFixed(6)), Number(e.lngLat.lng.toFixed(6)));
      });
    }

    mapRef.current = map;
    markerRef.current = marker;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, [mapStyle, editable]);

  useEffect(() => {
    if (markerRef.current && mapRef.current && Number.isFinite(lat) && Number.isFinite(lon)) {
      markerRef.current.setLngLat([lon, lat]);
      mapRef.current.easeTo({ center: [lon, lat], duration: 350 });
    }
  }, [lat, lon]);

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
