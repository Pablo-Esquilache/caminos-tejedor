import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
export const maptilerApiKey = (import.meta.env.VITE_MAPTILER_API_KEY as string) || '';

export function getBaseMapStyle(): string | Record<string, unknown> {
  if (maptilerApiKey && !maptilerApiKey.includes('PENDIENTE')) {
    return `https://api.maptiler.com/maps/streets-v2/style.json?key=${maptilerApiKey}`;
  }
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [
      {
        id: 'osm-layer',
        type: 'raster',
        source: 'osm',
      },
    ],
  };
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'caminos_tejedor_admin_auth_session',
  },
});
