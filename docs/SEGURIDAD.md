# Auditoría de Seguridad, Permisos (RLS) y Privacidad — Caminos Rurales de Carlos Tejedor

## 1. Principios de Seguridad Aplicados
1. **Separación estricta de claves**:
   - La aplicación móvil (`apps/mobile`) y el panel web (`apps/admin`) utilizan **exclusivamente** la clave pública (`SUPABASE_ANON_KEY` / `sb_publishable_...`).
   - La clave secreta de administración (`SUPABASE_SERVICE_ROLE_KEY` / `sb_secret_...`) y la cadena de conexión a PostgreSQL (`DATABASE_URL`) residen únicamente en `.env` local (ignorado en `.gitignore`) para migraciones y scripts de consola.
2. **Row Level Security (RLS) activado en las 15 tablas**:
   - Ninguna tabla del esquema `public` queda abierta. El rol `anon` tiene revocados todos los permisos directos (`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon`).
3. **Verificación de rol Administrador en Base de Datos (`public.is_admin()`)**:
   - El rol de administrador nunca se confía al frontend: toda función administrativa (`review_trip`, `review_trips_batch`, `update_claim`, `rename_road`, `merge_roads`, `reprocess_all_roads`, `upsert_claim_category`, `get_admin_statistics`) verifica `IF NOT public.is_admin() THEN RAISE EXCEPTION ...` dentro de PostgreSQL.
4. **Protección contra escalación de estados en el alta (Triggers)**:
   - `enforce_trip_insert_rules`: Si un vecino común envía un recorrido intentando forzar `status = 'approved'`, el trigger `BEFORE INSERT` lo sobrescribe automáticamente a `status = 'pending'`. Si quien graba pertenece a `public.admins`, ingresa automáticamente como `status = 'approved'` y `auto_approved = true`.
   - `enforce_claim_insert_rules`: Todo reclamo de vecino común ingresa obligatoriamente con `status = 'received'` y `priority = 'medium'`.
5. **Inmutabilidad de trazas GPS originales (`public.trip_tracks`)**:
   - El trigger `trg_prevent_trip_tracks_mutation` bloquea cualquier `UPDATE` o `DELETE` sobre `public.trip_tracks`, garantizando que la evidencia GPS cruda nunca pueda alterarse.
6. **Privacidad de los vecinos**:
   - Los nombres y correos electrónicos (`public.profiles`) son datos internos exclusivos para gestión municipal.
   - Los endpoints que consumen los vecinos para ver el mapa de caminos consolidados (`get_consolidated_roads_map`) devuelven únicamente geometrías consolidadas, nombres normalizados, jerarquía y longitud, sin exponer jamás `user_id`, nombre ni email de quién grabó cada tramo.
7. **Almacenamiento privado de fotografías (`claim-photos`)**:
   - El bucket `claim-photos` de Supabase Storage está configurado como **privado (`public = false`)** con límite de 5 MB por archivo y tipos MIME restringidos (`image/jpeg`, `image/png`, `image/webp`).
   - Las fotos solo pueden visualizarse mediante **URLs firmadas temporales (`createSignedUrls`)** con vencimiento de 1 hora, y las políticas RLS de `storage.objects` solo permiten a cada vecino acceder a su propia carpeta `{user_id}/*` (mientras que los administradores pueden auditar todas).

---

## 2. Matriz de Políticas RLS por Tabla

| Tabla | Rol Anónimo (`anon`) | Vecino Autenticado (`authenticated`) | Administrador (`public.is_admin()`) |
| :--- | :--- | :--- | :--- |
| `profiles` | Bloqueado | Lee y edita solo su propio perfil (`id = auth.uid()`) | Lee todos los perfiles |
| `admins` | Bloqueado | Solo puede consultar si su propio `user_id` está en `admins` | Lectura y gestión completa |
| `trips` | Bloqueado | Inserta y lee solo sus propios recorridos (`user_id = auth.uid()`). Sin `UPDATE`/`DELETE` | Lee todos y valida mediante RPCs auditados |
| `trip_tracks` | Bloqueado | Inserta y lee solo trazas de sus propios recorridos. Inmutable (` UPDATE`/`DELETE` prohibidos) | Lee todas las trazas completas |
| `roads` | Bloqueado | Solo lectura (`SELECT`) de caminos consolidados (sin datos personales) | Lectura y gestión completa |
| `road_segments` | Bloqueado | Solo lectura (`SELECT`) de tramos consolidados | Lectura y gestión completa |
| `trip_segment_usage` | Bloqueado | Bloqueado | Exclusivo administradores |
| `road_name_aliases` | Bloqueado | Bloqueado | Exclusivo administradores |
| `claim_categories` | Bloqueado | Lee categorías activas (o vinculadas a reclamos propios históricos) | CRUD completo |
| `claims` | Bloqueado | Inserta y lee solo sus propios reclamos (`user_id = auth.uid()`). Sin `UPDATE`/`DELETE` | Lee y actualiza todos |
| `claim_photos` | Bloqueado | Inserta y lee solo fotos de sus propios reclamos | Lee e inserta todas |
| `claim_history` | Bloqueado | Lee solo el historial de sus propios reclamos | Lee e inserta historial |
| `notifications` | Bloqueado | Lee sus propios avisos y los marca como leídos | Lee e inserta avisos |
| `audit_log` | Bloqueado | Bloqueado | Exclusivo administradores |
| `settings` | Bloqueado | Bloqueado | Exclusivo administradores |
