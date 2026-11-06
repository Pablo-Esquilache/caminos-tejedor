// Coordenadas centrales de Carlos Tejedor, Provincia de Buenos Aires (EPSG:4326)
export const CARLOS_TEJEDOR_CENTER = {
  latitude: -35.3928,
  longitude: -62.4208,
  defaultZoom: 11,
} as const;

// Sistema de referencia espacial en metros para Carlos Tejedor (UTM Zona 20 Sur)
export const SRID_WGS84 = 4326;
export const SRID_UTM_20S = 32720;

// Estados de recorridos (trips)
export type TripStatus = 'pending' | 'approved' | 'rejected';

export const TRIP_STATUS_USER_LABELS: Record<TripStatus, string> = {
  pending: 'En revisión',
  approved: 'Aprobado',
  rejected: 'No incluido en el mapa',
};

export const TRIP_STATUS_ADMIN_LABELS: Record<TripStatus, string> = {
  pending: 'Pendiente',
  approved: 'Aprobado',
  rejected: 'Rechazado',
};

// Clasificación jerárquica de caminos consolidados (roads)
export type RoadClass = 'troncal' | 'principal' | 'secundario' | 'vecinal';

export const ROAD_CLASS_LABELS: Record<RoadClass, string> = {
  troncal: 'Troncal',
  principal: 'Principal',
  secundario: 'Secundario',
  vecinal: 'Vecinal',
};

// Estados de reclamos (claims)
export type ClaimStatus =
  | 'received'
  | 'evaluating'
  | 'in_progress'
  | 'solved'
  | 'dismissed';

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  received: 'Recibido',
  evaluating: 'En evaluación',
  in_progress: 'En proceso',
  solved: 'Solucionado',
  dismissed: 'Desestimado',
};

// Prioridades de reclamos
export type ClaimPriority = 'low' | 'medium' | 'high';

export const CLAIM_PRIORITY_LABELS: Record<ClaimPriority, string> = {
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
};

// Interfaces principales del modelo
export interface RawGpsPoint {
  lat: number;
  lon: number;
  timestamp: number;
  accuracy: number;
  altitude?: number | null;
  speed?: number | null;
}

export interface TripSummary {
  id: string;
  original_name: string;
  started_at: string;
  ended_at: string;
  distance_m: number;
  duration_s: number;
  status: TripStatus;
  created_at: string;
}

export interface ClaimCategory {
  id: string;
  name: string;
  icon: string | null;
  is_active: boolean;
  sort_order: number;
}
