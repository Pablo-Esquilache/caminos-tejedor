import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  ChevronRight,
  Clock,
  Image as ImageIcon,
  MapPin,
  PlusCircle,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  CARLOS_TEJEDOR_CENTER,
  CLAIM_PRIORITY_LABELS,
  CLAIM_STATUS_LABELS,
  type ClaimCategory,
  type ClaimDetail,
  type ClaimPriority,
  type ClaimStatus,
  type ClaimSummary,
} from '@shared';
import { supabase } from '../lib/supabase';
import { SAMPLE_TEJEDOR_ROUTES } from '../lib/geo';
import {
  compressClaimPhoto,
  generateSimulatedClaimPhoto,
  type CompressedPhotoResult,
} from '../lib/imageCompression';
import {
  getCachedCategories,
  listOutboxClaims,
  removeClaimFromOutbox,
  saveCachedCategories,
  saveClaimToOutbox,
  type PendingClaimOutboxItem,
} from '../lib/localDb';
import { ClaimLocationMap } from './ClaimLocationMap';

const PAGE_SIZE = 20;

interface ClaimsSectionProps {
  userId: string;
  isOnline: boolean;
  onOutboxChange: () => void;
  onNotifyToast: (msg: string) => void;
  initialClaimIdToOpen?: string | null;
  onClearInitialClaimId?: () => void;
}

export async function syncSingleClaimOutboxItem(
  userId: string,
  item: PendingClaimOutboxItem
): Promise<boolean> {
  try {
    let storagePath = item.uploaded_storage_path;
    let thumbPath = item.uploaded_thumb_path;

    if (item.photo_blob && !storagePath) {
      const targetMain = `${userId}/${item.id}/photo.jpg`;
      const { error: upErr } = await supabase.storage
        .from('claim-photos')
        .upload(targetMain, item.photo_blob, {
          contentType: 'image/jpeg',
          upsert: true,
        });
      if (upErr) throw upErr;
      storagePath = targetMain;
    }

    if (item.thumb_blob && !thumbPath) {
      const targetThumb = `${userId}/${item.id}/thumb.jpg`;
      const { error: thumbErr } = await supabase.storage
        .from('claim-photos')
        .upload(targetThumb, item.thumb_blob, {
          contentType: 'image/jpeg',
          upsert: true,
        });
      if (!thumbErr) {
        thumbPath = targetThumb;
      }
    }

    const { error: rpcError } = await supabase.rpc('submit_claim_with_photo', {
      p_claim_id: item.id,
      p_title: item.title,
      p_description: item.description,
      p_category_id: item.category_id,
      p_lat: item.lat,
      p_lon: item.lon,
      p_storage_path: storagePath,
      p_thumb_path: thumbPath,
      p_created_at: item.created_at,
    });

    if (rpcError) throw rpcError;

    await removeClaimFromOutbox(item.id);
    return true;
  } catch (err: any) {
    await saveClaimToOutbox({
      ...item,
      status: 'error',
      attempts: item.attempts + 1,
      last_error: err?.message || 'Error de conexión al sincronizar reclamo',
    });
    return false;
  }
}

export const ClaimsSection: React.FC<ClaimsSectionProps> = ({
  userId,
  isOnline,
  onOutboxChange,
  onNotifyToast,
  initialClaimIdToOpen,
  onClearInitialClaimId,
}) => {
  const [subView, setSubView] = useState<'list' | 'new' | 'detail'>('list');

  // Categorías activas
  const [categories, setCategories] = useState<ClaimCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('');

  // Formulario de Nuevo Reclamo
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [lat, setLat] = useState<number>(CARLOS_TEJEDOR_CENTER.latitude);
  const [lon, setLon] = useState<number>(CARLOS_TEJEDOR_CENTER.longitude);
  const [locLoading, setLocLoading] = useState(false);
  const [compressedPhoto, setCompressedPhoto] = useState<CompressedPhotoResult | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Listado paginado de Mis Reclamos + Cola Offline
  const [claims, setClaims] = useState<ClaimSummary[]>([]);
  const [outboxClaims, setOutboxClaims] = useState<PendingClaimOutboxItem[]>([]);
  const [thumbSignedUrls, setThumbSignedUrls] = useState<Record<string, string>>({});
  const [loadingList, setLoadingList] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  // Vista de Detalle de Reclamo
  const [claimDetail, setClaimDetail] = useState<ClaimDetail | null>(null);
  const [detailPhotoUrls, setDetailPhotoUrls] = useState<Record<string, string>>({});
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    loadCategories();
    loadClaimsList(0, true);
  }, [userId]);

  useEffect(() => {
    if (initialClaimIdToOpen) {
      openClaimDetailById(initialClaimIdToOpen);
      if (onClearInitialClaimId) onClearInitialClaimId();
    }
  }, [initialClaimIdToOpen]);

  const loadCategories = async () => {
    const cached = await getCachedCategories();
    if (cached.length > 0) {
      setCategories(cached);
      setSelectedCategoryId((prev) => prev || cached[0].id);
    }

    if (navigator.onLine) {
      const { data, error } = await supabase
        .from('claim_categories')
        .select('id, name, icon, is_active, sort_order')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      if (!error && data && data.length > 0) {
        const typed = data as ClaimCategory[];
        setCategories(typed);
        setSelectedCategoryId((prev) => prev || typed[0].id);
        await saveCachedCategories(typed);
      }
    }
  };

  const loadClaimsList = async (pageIdx: number, replace = false) => {
    setLoadingList(true);
    const localPending = await listOutboxClaims();
    setOutboxClaims(localPending);

    if (navigator.onLine) {
      const { data, error } = await supabase.rpc('get_my_claims_list', {
        p_limit: PAGE_SIZE,
        p_offset: pageIdx * PAGE_SIZE,
      });

      if (!error && Array.isArray(data)) {
        const rows = data as ClaimSummary[];
        setClaims((prev) => (replace ? rows : [...prev, ...rows]));
        setPage(pageIdx);
        setHasMore(rows.length === PAGE_SIZE);

        // Generar URLs firmadas temporales solo para las miniaturas (320px) del listado
        const pathsToSign = rows
          .map((r) => r.thumb_path)
          .filter((p): p is string => Boolean(p && !thumbSignedUrls[p]));

        if (pathsToSign.length > 0) {
          const { data: signedData } = await supabase.storage
            .from('claim-photos')
            .createSignedUrls(pathsToSign, 3600);

          if (signedData) {
            const nextMap: Record<string, string> = {};
            for (const item of signedData) {
              if (item.path && item.signedUrl) {
                nextMap[item.path] = item.signedUrl;
              }
            }
            setThumbSignedUrls((prev) => ({ ...prev, ...nextMap }));
          }
        }
      }
    }
    setLoadingList(false);
  };

  const openClaimDetailById = async (claimId: string) => {
    setSubView('detail');
    setLoadingDetail(true);
    setClaimDetail(null);
    setDetailPhotoUrls({});

    const { data, error } = await supabase.rpc('get_claim_detail', {
      p_claim_id: claimId,
    });

    if (!error && data) {
      const detail = data as ClaimDetail;
      setClaimDetail(detail);

      // Generar URL firmada de la foto completa (1600px) únicamente al abrir el detalle
      const fullPaths = (detail.photos || [])
        .map((p) => p.storage_path)
        .filter(Boolean);

      if (fullPaths.length > 0) {
        const { data: signed } = await supabase.storage
          .from('claim-photos')
          .createSignedUrls(fullPaths, 3600);

        if (signed) {
          const urls: Record<string, string> = {};
          for (const s of signed) {
            if (s.path && s.signedUrl) urls[s.path] = s.signedUrl;
          }
          setDetailPhotoUrls(urls);
        }
      }
    }
    setLoadingDetail(false);
  };

  const captureCurrentGpsLocation = () => {
    if (!('geolocation' in navigator)) {
      setFormError('Tu navegador no tiene GPS disponible; podés mover el marcador en el mapa.');
      return;
    }
    setLocLoading(true);
    setFormError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(Number(pos.coords.latitude.toFixed(6)));
        setLon(Number(pos.coords.longitude.toFixed(6)));
        setLocLoading(false);
      },
      () => {
        setLocLoading(false);
        setFormError(
          'No pudimos leer el GPS actual. Podés tocar cualquier punto del mapa o usar una ubicación de prueba en Carlos Tejedor.'
        );
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const pickSimulatedRoadLocation = () => {
    const sampleRoute =
      SAMPLE_TEJEDOR_ROUTES[Math.floor(Math.random() * SAMPLE_TEJEDOR_ROUTES.length)];
    const pt =
      sampleRoute.coords[Math.floor(Math.random() * sampleRoute.coords.length)];
    setLon(Number(pt[0].toFixed(6)));
    setLat(Number(pt[1].toFixed(6)));
    if (!title.trim()) {
      const cat = categories.find((c) => c.id === selectedCategoryId);
      setTitle(`${cat?.name || 'Problema'} en ${sampleRoute.name}`);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCompressing(true);
    setFormError(null);
    try {
      const result = await compressClaimPhoto(file);
      setCompressedPhoto(result);
    } catch (err: any) {
      setFormError(err?.message || 'No se pudo procesar la imagen seleccionada.');
    } finally {
      setCompressing(false);
    }
  };

  const handleGenerateSimulatedPhoto = async () => {
    setCompressing(true);
    setFormError(null);
    try {
      const cat = categories.find((c) => c.id === selectedCategoryId);
      const result = await generateSimulatedClaimPhoto(
        cat?.name || 'Bache / Pozo',
        lat,
        lon
      );
      setCompressedPhoto(result);
    } catch (err: any) {
      setFormError(err?.message || 'No se pudo generar la foto de prueba.');
    } finally {
      setCompressing(false);
    }
  };

  const handleSubmitClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!selectedCategoryId) {
      setFormError('Seleccioná una categoría para el reclamo.');
      return;
    }

    const cat = categories.find((c) => c.id === selectedCategoryId);
    const cleanTitle =
      title.trim() || `${cat?.name || 'Reclamo'} en camino rural`;

    setSubmitting(true);
    const claimUuid = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    const outboxItem: PendingClaimOutboxItem = {
      id: claimUuid,
      title: cleanTitle,
      description: description.trim(),
      category_id: selectedCategoryId,
      category_name: cat?.name || 'Reclamo vial',
      lat,
      lon,
      photo_blob: compressedPhoto ? compressedPhoto.photoBlob : null,
      thumb_blob: compressedPhoto ? compressedPhoto.thumbBlob : null,
      thumb_data_url: compressedPhoto ? compressedPhoto.thumbDataUrl : null,
      uploaded_storage_path: null,
      uploaded_thumb_path: null,
      status: 'pending_sync',
      attempts: 0,
      last_error: null,
      created_at: nowIso,
    };

    // 1. Guardar primero en IndexedDB para no perder el reclamo ni la foto si se corta la señal
    await saveClaimToOutbox(outboxItem);
    onOutboxChange();

    // 2. Si hay conexión, subir fotos comprimidas al bucket privado y crear reclamo en el acto
    if (navigator.onLine) {
      const ok = await syncSingleClaimOutboxItem(userId, outboxItem);
      onOutboxChange();
      if (ok) {
        onNotifyToast('¡Reclamo enviado correctamente! Quedó registrado con estado "Recibido".');
      } else {
        onNotifyToast(
          'Reclamo guardado en tu teléfono: se enviará automáticamente al recuperar señal estable.'
        );
      }
    } else {
      onNotifyToast(
        'Estás sin señal: el reclamo y su foto comprimida quedaron guardados en tu teléfono.'
      );
    }

    setTitle('');
    setDescription('');
    setCompressedPhoto(null);
    setSubmitting(false);
    setSubView('list');
    await loadClaimsList(0, true);
  };

  // SUB-VISTA 1: DETALLE DE UN RECLAMO
  if (subView === 'detail') {
    return (
      <div className="card detail-card">
        <button
          type="button"
          className="btn-back"
          onClick={() => {
            setSubView('list');
            setClaimDetail(null);
          }}
        >
          <ArrowLeft size={18} /> Volver a Mis reclamos
        </button>

        {loadingDetail || !claimDetail ? (
          <div className="centered-pad">Cargando detalle del reclamo...</div>
        ) : (
          <>
            <div className="trip-detail-header">
              <div>
                <span className="category-chip">{claimDetail.category_name}</span>
                <h2>{claimDetail.title}</h2>
              </div>
              <span className={`status-pill claim-status-${claimDetail.status}`}>
                {CLAIM_STATUS_LABELS[claimDetail.status]}
              </span>
            </div>

            {claimDetail.description && (
              <p className="claim-desc-box">{claimDetail.description}</p>
            )}

            <div className="metrics-grid">
              <div className="metric-box">
                <span className="metric-label">Estado</span>
                <span className="metric-value-sm">
                  {CLAIM_STATUS_LABELS[claimDetail.status]}
                </span>
              </div>
              <div className="metric-box">
                <span className="metric-label">Prioridad</span>
                <span className="metric-value-sm">
                  {CLAIM_PRIORITY_LABELS[claimDetail.priority as ClaimPriority]}
                </span>
              </div>
              <div className="metric-box">
                <span className="metric-label">Fecha</span>
                <span className="metric-value-sm">
                  {new Date(claimDetail.created_at).toLocaleDateString('es-AR')}
                </span>
              </div>
            </div>

            {claimDetail.photos && claimDetail.photos.length > 0 && (
              <div className="claim-photo-full-box">
                <span className="metric-label">Fotografía registrada (acceso seguro firmado)</span>
                {claimDetail.photos.map((p) => {
                  const signedUrl = detailPhotoUrls[p.storage_path];
                  return signedUrl ? (
                    <img
                      key={p.id}
                      src={signedUrl}
                      alt={claimDetail.title}
                      className="claim-full-img"
                    />
                  ) : (
                    <div key={p.id} className="centered-pad">
                      Cargando imagen desde el bucket privado...
                    </div>
                  );
                })}
              </div>
            )}

            <div>
              <span className="metric-label">
                Ubicación exacta ({claimDetail.lat.toFixed(5)}, {claimDetail.lon.toFixed(5)})
              </span>
              <ClaimLocationMap
                lat={claimDetail.lat}
                lon={claimDetail.lon}
                editable={false}
                height="220px"
              />
            </div>

            <div className="claim-history-section">
              <h3>Seguimiento y respuestas del Municipio</h3>
              <div className="history-timeline">
                {claimDetail.history.map((h) => (
                  <div key={h.id} className="history-item">
                    <div className="history-item-top">
                      <strong>
                        {h.new_status
                          ? CLAIM_STATUS_LABELS[h.new_status]
                          : 'Actualización'}
                      </strong>
                      <span>
                        {new Date(h.created_at).toLocaleString('es-AR', {
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    {h.message && <p>{h.message}</p>}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  // SUB-VISTA 2: FORMULARIO DE NUEVO RECLAMO
  if (subView === 'new') {
    return (
      <form className="card" onSubmit={handleSubmitClaim}>
        <div className="section-header">
          <h2>Nuevo reclamo vial</h2>
          <button
            type="button"
            className="btn-small"
            onClick={() => setSubView('list')}
          >
            Cancelar
          </button>
        </div>

        <p className="muted-text">
          Marcá el punto del problema en el mapa, elegí el tipo de inconveniente y adjuntá una foto. Si estás sin señal en el campo, se guarda en tu teléfono y se sube solo al volver internet.
        </p>

        {formError && (
          <div className="alert-box error">
            <AlertTriangle size={18} />
            <span>{formError}</span>
          </div>
        )}

        <label className="field-label">
          Categoría del problema *
          <select
            value={selectedCategoryId}
            onChange={(e) => setSelectedCategoryId(e.target.value)}
            required
          >
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field-label">
          Título o referencia del lugar *
          <input
            type="text"
            required
            placeholder="Ej.: Alcantarilla rota en Camino Real a Timote"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="field-label">
          Descripción adicional (opcional)
          <textarea
            rows={3}
            placeholder="Contanos detalles útiles (ej. ocupa toda la calzada, agua acumulada tras la lluvia, etc.)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        {/* Ubicación GPS / Mapa interactivo */}
        <div className="location-picker-block">
          <div className="section-header">
            <span className="field-label">
              Ubicación GPS ({lat.toFixed(4)}, {lon.toFixed(4)})
            </span>
            <div className="inline-btns">
              <button
                type="button"
                className="btn-small"
                onClick={captureCurrentGpsLocation}
                disabled={locLoading}
              >
                <MapPin size={14} /> {locLoading ? 'Buscando...' : 'Mi GPS'}
              </button>
              <button
                type="button"
                className="btn-small"
                onClick={pickSimulatedRoadLocation}
              >
                <Sparkles size={14} /> Punto de prueba
              </button>
            </div>
          </div>
          <small className="muted-text">
            Podés tocar el mapa o arrastrar el marcador rojo hasta el punto exacto del camino.
          </small>
          <ClaimLocationMap
            lat={lat}
            lon={lon}
            editable
            onChangeLocation={(newLat, newLon) => {
              setLat(newLat);
              setLon(newLon);
            }}
            height="210px"
          />
        </div>

        {/* Fotografía con compresión en el cliente */}
        <div className="photo-picker-block">
          <span className="field-label">Fotografía del lugar (comprimida antes de subir)</span>
          {!compressedPhoto ? (
            <div className="photo-upload-actions">
              <label className="btn-secondary photo-upload-label">
                <Camera size={18} />
                <span>{compressing ? 'Comprimiendo...' : 'Sacar foto o elegir imagen'}</span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleFileChange}
                  disabled={compressing}
                  hidden
                />
              </label>
              <button
                type="button"
                className="btn-small full-width"
                onClick={handleGenerateSimulatedPhoto}
                disabled={compressing}
              >
                <ImageIcon size={15} /> Generar foto de prueba (Simulador PC)
              </button>
            </div>
          ) : (
            <div className="photo-preview-card">
              <img
                src={compressedPhoto.thumbDataUrl}
                alt="Vista previa comprimida"
                className="photo-preview-thumb"
              />
              <div className="photo-preview-info">
                <strong>Foto lista y optimizada</strong>
                <span>
                  Tamaño reducido a {(compressedPhoto.compressedSizeBytes / 1024).toFixed(0)} KB + miniatura liviana
                </span>
                <button
                  type="button"
                  className="btn-text-cancel"
                  onClick={() => setCompressedPhoto(null)}
                >
                  <Trash2 size={13} /> Quitar foto
                </button>
              </div>
            </div>
          )}
        </div>

        <button type="submit" className="btn-primary full-width" disabled={submitting || compressing}>
          <CheckCircle2 size={18} />
          {submitting ? 'Guardando reclamo...' : 'Enviar reclamo vial'}
        </button>
      </form>
    );
  }

  // SUB-VISTA 3: LISTADO PAGINADO DE MIS RECLAMOS
  return (
    <div className="trips-list-container">
      <div className="section-header">
        <h2>Mis reclamos</h2>
        <div className="inline-btns">
          <button
            type="button"
            className="btn-small"
            onClick={() => loadClaimsList(0, true)}
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className="btn-primary btn-sm-primary"
            onClick={() => {
              pickSimulatedRoadLocation();
              setSubView('new');
            }}
          >
            <PlusCircle size={16} /> Nuevo reclamo
          </button>
        </div>
      </div>

      {/* Reclamos en cola local esperando señal */}
      {outboxClaims.map((item) => (
        <div key={item.id} className="trip-row outbox-row">
          <div className="claim-row-left">
            {item.thumb_data_url && (
              <img src={item.thumb_data_url} alt="" className="claim-list-thumb" />
            )}
            <div>
              <span className="category-chip">{item.category_name}</span>
              <h4>{item.title}</h4>
              <span className="trip-meta">
                {new Date(item.created_at).toLocaleString('es-AR', {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
          </div>
          <span className="status-pill status-offline">
            Guardado en el celular (sin señal)
          </span>
        </div>
      ))}

      {claims.length === 0 && outboxClaims.length === 0 && !loadingList && (
        <div className="card empty-state">
          <AlertTriangle size={32} />
          <p>Todavía no registraste ningún reclamo vial.</p>
          <p className="muted-text">
            Podés reportar pozos, caminos cortados, agua acumulada o alcantarillas dañadas adjuntando ubicación GPS y foto.
          </p>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              pickSimulatedRoadLocation();
              setSubView('new');
            }}
          >
            <PlusCircle size={18} /> Crear mi primer reclamo
          </button>
        </div>
      )}

      {claims.map((claim) => {
        const thumbUrl = claim.thumb_path ? thumbSignedUrls[claim.thumb_path] : null;
        return (
          <button
            key={claim.id}
            type="button"
            className="trip-row"
            onClick={() => openClaimDetailById(claim.id)}
          >
            <div className="claim-row-left">
              {thumbUrl ? (
                <img src={thumbUrl} alt="" className="claim-list-thumb" />
              ) : (
                <div className="claim-list-thumb placeholder">
                  <MapPin size={18} />
                </div>
              )}
              <div>
                <span className="category-chip">{claim.category_name}</span>
                <h4>{claim.title}</h4>
                <span className="trip-meta">
                  {new Date(claim.created_at).toLocaleDateString('es-AR')}
                  {claim.latest_reply ? ` • Respuesta: "${claim.latest_reply}"` : ''}
                </span>
              </div>
            </div>
            <div className="trip-row-right">
              <span className={`status-pill claim-status-${claim.status}`}>
                {CLAIM_STATUS_LABELS[claim.status as ClaimStatus] || claim.status}
              </span>
              <ChevronRight size={18} />
            </div>
          </button>
        );
      })}

      {hasMore && (
        <button
          type="button"
          className="btn-secondary full-width"
          disabled={loadingList}
          onClick={() => loadClaimsList(page + 1, false)}
        >
          {loadingList ? 'Cargando...' : 'Cargar más reclamos'}
        </button>
      )}
    </div>
  );
};
