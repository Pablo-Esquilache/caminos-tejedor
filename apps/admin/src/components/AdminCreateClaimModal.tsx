import React, { useState } from 'react';
import { Camera, MapPin, Plus, Sparkles, X } from 'lucide-react';
import { CARLOS_TEJEDOR_CENTER, type ClaimCategory } from '@shared';
import {
  compressClaimPhoto,
  generateSimulatedClaimPhoto,
  type CompressedPhotoResult,
} from '../lib/imageCompression';
import { supabase } from '../lib/supabase';

interface AdminCreateClaimModalProps {
  categories: ClaimCategory[];
  onClose: () => void;
  onClaimCreated: (msg: string) => void;
}

export const AdminCreateClaimModal: React.FC<AdminCreateClaimModalProps> = ({
  categories,
  onClose,
  onClaimCreated,
}) => {
  const activeCategories = categories.filter((c) => c.is_active);
  const [categoryId, setCategoryId] = useState<string>(activeCategories[0]?.id || '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [lat, setLat] = useState<number>(CARLOS_TEJEDOR_CENTER.latitude - 0.004);
  const [lon, setLon] = useState<number>(CARLOS_TEJEDOR_CENTER.longitude - 0.008);
  const [compressedPhoto, setCompressedPhoto] = useState<CompressedPhotoResult | null>(null);
  const [locating, setLocating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setErrorMsg(null);
      const res = await compressClaimPhoto(file);
      setCompressedPhoto(res);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Error al procesar la imagen.');
    }
  };

  const handleGenerateSamplePhoto = async () => {
    try {
      setErrorMsg(null);
      const catName =
        activeCategories.find((c) => c.id === categoryId)?.name || 'Relevamiento Municipal';
      const res = await generateSimulatedClaimPhoto(catName, lat, lon);
      setCompressedPhoto(res);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Error generando foto de prueba.');
    }
  };

  const handleUseCurrentGps = () => {
    if (!('geolocation' in navigator)) {
      setErrorMsg('Este navegador no soporta geolocalización GPS.');
      return;
    }
    setLocating(true);
    setErrorMsg(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(Number(pos.coords.latitude.toFixed(6)));
        setLon(Number(pos.coords.longitude.toFixed(6)));
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setErrorMsg(`No se pudo obtener el GPS (${err.message}). Podés ingresar la coordenada abajo.`);
      },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!categoryId || !title.trim()) return;
    if (!compressedPhoto) {
      setErrorMsg('Seleccioná una foto o tocá "Generar foto de prueba".');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error('Sesión no encontrada.');

      const claimId = crypto.randomUUID();
      const mainPath = `${userId}/${claimId}/photo.jpg`;
      const thumbPath = `${userId}/${claimId}/thumb.jpg`;

      const { error: upMainErr } = await supabase.storage
        .from('claim-photos')
        .upload(mainPath, compressedPhoto.photoBlob, {
          contentType: 'image/jpeg',
          upsert: true,
        });
      if (upMainErr) throw upMainErr;

      const { error: upThumbErr } = await supabase.storage
        .from('claim-photos')
        .upload(thumbPath, compressedPhoto.thumbBlob, {
          contentType: 'image/jpeg',
          upsert: true,
        });
      if (upThumbErr) throw upThumbErr;

      const { error: rpcErr } = await supabase.rpc('submit_claim_with_photo', {
        p_claim_id: claimId,
        p_title: title.trim(),
        p_description: description.trim() || null,
        p_category_id: categoryId,
        p_lat: Number(lat),
        p_lon: Number(lon),
        p_storage_path: mainPath,
        p_thumb_path: thumbPath,
        p_created_at: new Date().toISOString(),
      });
      if (rpcErr) throw rpcErr;

      onClaimCreated(`Reclamo "${title.trim()}" generado correctamente.`);
      onClose();
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Error al guardar el reclamo.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.65)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        className="panel-card"
        style={{
          width: '100%',
          maxWidth: 600,
          maxHeight: '92dvh',
          overflowY: 'auto',
          margin: 0,
        }}
      >
        <div className="card-header-row">
          <div>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Plus size={20} /> Generar Reclamo (Carga desde Administración)
            </h2>
            <p>Registrá un reclamo georreferenciado con foto directamente desde el panel.</p>
          </div>
          <button type="button" className="btn-outline" onClick={onClose}>
            <X size={16} /> Cerrar
          </button>
        </div>

        {errorMsg && (
          <div
            style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              padding: '10px 12px',
              borderRadius: 8,
              marginBottom: 12,
            }}
          >
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ fontWeight: 600, fontSize: 14 }}>
            Categoría del reclamo
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              required
              style={{
                width: '100%',
                marginTop: 5,
                padding: '9px 10px',
                borderRadius: 8,
                border: '1px solid #cbd5e1',
              }}
            >
              {activeCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label style={{ fontWeight: 600, fontSize: 14 }}>
            Título breve
            <input
              type="text"
              required
              placeholder="Ej.: Alcantarilla desmoronada en Camino a Timote"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{
                width: '100%',
                marginTop: 5,
                padding: '9px 10px',
                borderRadius: 8,
                border: '1px solid #cbd5e1',
              }}
            />
          </label>

          <label style={{ fontWeight: 600, fontSize: 14 }}>
            Descripción / observaciones
            <textarea
              rows={3}
              placeholder="Detalles adicionales sobre el estado del tramo..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{
                width: '100%',
                marginTop: 5,
                padding: '9px 10px',
                borderRadius: 8,
                border: '1px solid #cbd5e1',
              }}
            />
          </label>

          <div
            style={{
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: 10,
              padding: 12,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <strong style={{ fontSize: 14 }}>
                <MapPin size={15} style={{ verticalAlign: 'middle' }} /> Ubicación GPS
              </strong>
              <button
                type="button"
                className="btn-outline"
                onClick={handleUseCurrentGps}
                disabled={locating}
              >
                {locating ? 'Buscando GPS...' : 'Usar mi GPS actual'}
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label style={{ fontSize: 13 }}>
                Latitud
                <input
                  type="number"
                  step="any"
                  required
                  value={lat}
                  onChange={(e) => setLat(Number(e.target.value))}
                  style={{
                    width: '100%',
                    marginTop: 4,
                    padding: '7px 9px',
                    borderRadius: 6,
                    border: '1px solid #cbd5e1',
                  }}
                />
              </label>
              <label style={{ fontSize: 13 }}>
                Longitud
                <input
                  type="number"
                  step="any"
                  required
                  value={lon}
                  onChange={(e) => setLon(Number(e.target.value))}
                  style={{
                    width: '100%',
                    marginTop: 4,
                    padding: '7px 9px',
                    borderRadius: 6,
                    border: '1px solid #cbd5e1',
                  }}
                />
              </label>
            </div>
          </div>

          <div
            style={{
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: 10,
              padding: 12,
            }}
          >
            <strong style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
              <Camera size={15} style={{ verticalAlign: 'middle' }} /> Fotografía del reclamo
            </strong>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleFileChange}
              />
              <button
                type="button"
                className="btn-outline"
                onClick={handleGenerateSamplePhoto}
              >
                <Sparkles size={15} /> Generar foto de prueba (PC)
              </button>
            </div>

            {compressedPhoto && (
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
                <img
                  src={compressedPhoto.thumbDataUrl}
                  alt="Vista previa"
                  style={{ width: 96, height: 68, objectFit: 'cover', borderRadius: 6 }}
                />
                <small style={{ color: '#475569' }}>
                  Foto comprimida lista ({Math.round(compressedPhoto.compressedSizeBytes / 1024)} KB)
                </small>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
            <button
              type="button"
              className="btn-outline"
              onClick={onClose}
              disabled={submitting}
            >
              Cancelar
            </button>
            <button type="submit" className="btn-approve" disabled={submitting}>
              {submitting ? 'Guardando reclamo...' : 'Confirmar y Generar Reclamo'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
