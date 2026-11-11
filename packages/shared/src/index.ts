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

export interface ClaimSummary {
  id: string;
  title: string;
  description: string | null;
  category_id: string;
  category_name: string;
  category_icon: string | null;
  status: ClaimStatus;
  priority: ClaimPriority;
  lat: number;
  lon: number;
  thumb_path: string | null;
  photos_count: number;
  latest_reply?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClaimPhotoItem {
  id: string;
  storage_path: string;
  thumb_path: string | null;
  created_at: string;
}

export interface ClaimHistoryItem {
  id: string;
  action: string;
  old_status: ClaimStatus | null;
  new_status: ClaimStatus | null;
  old_priority: ClaimPriority | null;
  new_priority: ClaimPriority | null;
  message: string | null;
  created_at: string;
}

export interface ClaimDetail {
  id: string;
  title: string;
  description: string | null;
  category_id: string;
  category_name: string;
  category_icon: string | null;
  status: ClaimStatus;
  priority: ClaimPriority;
  lat: number;
  lon: number;
  created_at: string;
  updated_at: string;
  user_name?: string | null;
  user_email?: string | null;
  photos: ClaimPhotoItem[];
  history: ClaimHistoryItem[];
}

export interface NotificationItem {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  claim_id: string | null;
  is_read: boolean;
  email_sent_at: string | null;
  email_error: string | null;
  created_at: string;
}

// =============================================================================
// Fases 9 a 14: Módulo de Operarios, Maquinarias e Intervenciones Viales
// =============================================================================

export type AppUserRole = 'admin' | 'operator' | 'user' | 'anon';

export type WorkExecutionMode = 'linear' | 'punctual';

export const WORK_EXECUTION_MODE_LABELS: Record<WorkExecutionMode, string> = {
  linear: 'Lineal (Trackeo GPS en tramo)',
  punctual: 'Puntual (Ubicación + fotos)',
};

export type MachineType =
  | 'motoniveladora'
  | 'retroexcavadora'
  | 'pala_cargadora'
  | 'camion_volcador'
  | 'tractor'
  | 'desmalezadora'
  | 'otra';

export const MACHINE_TYPE_LABELS: Record<MachineType, string> = {
  motoniveladora: 'Motoniveladora',
  retroexcavadora: 'Retroexcavadora',
  pala_cargadora: 'Pala Cargadora',
  camion_volcador: 'Camión Volcador',
  tractor: 'Tractor',
  desmalezadora: 'Desmalezadora',
  otra: 'Otra Maquinaria',
};

export type InterventionStatus =
  | 'planned'
  | 'in_progress'
  | 'suspended'
  | 'pending_approval'
  | 'approved'
  | 'rejected';

export const INTERVENTION_STATUS_LABELS: Record<InterventionStatus, string> = {
  planned: 'Programada',
  in_progress: 'En ejecución',
  suspended: 'Suspendida (En pausa)',
  pending_approval: 'Pendiente de aprobación',
  approved: 'Aprobada / Completada',
  rejected: 'Rechazada',
};

export type InterventionDefinitionMode =
  | 'consolidated_road'
  | 'points_along_road'
  | 'freehand_draw'
  | 'gps_field'
  | 'punctual_point';

export interface OperatorItem {
  id: string;
  user_id: string | null;
  full_name: string;
  email: string | null;
  legajo: string | null;
  phone: string | null;
  role_notes: string | null;
  has_account: boolean;
  is_active: boolean;
  is_me?: boolean;
  created_at?: string;
}

export interface MachineItem {
  id: string;
  name: string;
  code: string | null;
  machine_type: MachineType;
  description: string | null;
  is_active: boolean;
  created_at?: string;
}

export interface WorkTypeItem {
  id: string;
  name: string;
  execution_mode: WorkExecutionMode;
  color: string;
  description: string | null;
  is_active: boolean;
  sort_order: number;
}

export interface InterventionSummary {
  id: string;
  title: string;
  description: string | null;
  execution_mode: WorkExecutionMode;
  origin: 'planned' | 'spontaneous';
  status: InterventionStatus;
  priority: ClaimPriority;
  road_id: string | null;
  road_name: string | null;
  definition_mode?: InterventionDefinitionMode | null;
  planned_length_m: number;
  worked_length_m: number;
  total_gps_distance_m: number;
  duration_s: number;
  sessions_count: number;
  scheduled_date: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  linked_claim_id?: string | null;
  reviewed_at?: string | null;
  review_note?: string | null;
  created_at: string;
  responsible_operator_name?: string | null;
  am_i_responsible?: boolean;
  planned_geojson?: any;
  worked_geojson?: any;
  work_types: Array<{ id: string; name: string; color: string; execution_mode: WorkExecutionMode }>;
  machines: Array<{ id: string; name: string; code: string | null; machine_type: MachineType }>;
  operators: Array<{ id: string; full_name: string; is_responsible: boolean }>;
}

export interface MapInterventionFeature {
  id: string;
  title: string;
  execution_mode: WorkExecutionMode;
  status: InterventionStatus;
  priority: ClaimPriority;
  road_name: string | null;
  planned_length_m: number;
  worked_length_m: number;
  scheduled_date: string | null;
  completed_at: string | null;
  geojson: any;
  work_types: Array<{ name: string; color: string }>;
  machines: Array<{ name: string; machine_type: MachineType }>;
}

export interface NearbyClaimOption {
  id: string;
  title: string;
  status: ClaimStatus;
  priority: ClaimPriority;
  category_name: string;
  distance_m: number;
  lat: number;
  lon: number;
}

// Delimitación geográfica oficial y validación espacial del Partido de Carlos Tejedor
export * from './boundary';
