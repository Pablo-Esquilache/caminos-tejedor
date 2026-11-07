export interface CompressedPhotoResult {
  photoBlob: Blob;
  thumbBlob: Blob;
  thumbDataUrl: string;
  originalSizeBytes: number;
  compressedSizeBytes: number;
}

function loadImageFromFile(file: File | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

function resizeToJpegBlob(
  img: HTMLImageElement,
  maxDimension: number,
  quality: number
): Promise<{ blob: Blob; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    let targetW = width;
    let targetH = height;

    if (width > maxDimension || height > maxDimension) {
      if (width >= height) {
        targetW = maxDimension;
        targetH = Math.round((height * maxDimension) / width);
      } else {
        targetH = maxDimension;
        targetW = Math.round((width * maxDimension) / height);
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, targetW);
    canvas.height = Math.max(1, targetH);

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('No se pudo inicializar el compresor de imagen.'));
      return;
    }

    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Error al comprimir imagen a JPEG.'));
          return;
        }
        resolve({ blob, dataUrl });
      },
      'image/jpeg',
      quality
    );
  });
}

/**
 * Comprime la foto en el cliente antes de subirla o guardarla en la cola offline:
 * - Foto principal: máx 1600px (JPEG 0.78)
 * - Miniatura (thumbnail): máx 320px (JPEG 0.72) para listados livianos
 */
export async function compressClaimPhoto(file: File | Blob): Promise<CompressedPhotoResult> {
  const img = await loadImageFromFile(file);
  const [mainRes, thumbRes] = await Promise.all([
    resizeToJpegBlob(img, 1600, 0.78),
    resizeToJpegBlob(img, 320, 0.72),
  ]);

  return {
    photoBlob: mainRes.blob,
    thumbBlob: thumbRes.blob,
    thumbDataUrl: thumbRes.dataUrl,
    originalSizeBytes: file.size,
    compressedSizeBytes: mainRes.blob.size,
  };
}

/**
 * Genera una imagen de prueba realista para probar la carga de reclamos desde la PC
 */
export async function generateSimulatedClaimPhoto(
  categoryName: string,
  lat: number,
  lon: number
): Promise<CompressedPhotoResult> {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 800;
  const ctx = canvas.getContext('2d')!;

  // Cielo rural
  const skyGrad = ctx.createLinearGradient(0, 0, 0, 380);
  skyGrad.addColorStop(0, '#38bdf8');
  skyGrad.addColorStop(1, '#bae6fd');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, 1200, 380);

  // Campo a los costados
  ctx.fillStyle = '#3f6212';
  ctx.fillRect(0, 380, 1200, 420);

  // Camino de tierra en perspectiva
  ctx.fillStyle = '#92400e';
  ctx.beginPath();
  ctx.moveTo(490, 380);
  ctx.lineTo(710, 380);
  ctx.lineTo(1060, 800);
  ctx.lineTo(140, 800);
  ctx.closePath();
  ctx.fill();

  // Huella de agua / bache simulado en el centro del camino
  ctx.fillStyle = '#451a03';
  ctx.beginPath();
  ctx.ellipse(600, 610, 180, 58, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#0284c7';
  ctx.beginPath();
  ctx.ellipse(600, 612, 150, 42, 0, 0, Math.PI * 2);
  ctx.fill();

  // Cartel inferior con metadatos de relevamiento
  ctx.fillStyle = 'rgba(15, 23, 42, 0.84)';
  ctx.fillRect(30, 645, 1140, 125);

  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(`RELEVAMIENTO VIAL - ${categoryName.toUpperCase()}`, 55, 690);

  ctx.fillStyle = '#cbd5e1';
  ctx.font = '22px sans-serif';
  ctx.fillText(
    `Partido de Carlos Tejedor • GPS: ${lat.toFixed(5)}, ${lon.toFixed(5)} • ${new Date().toLocaleString('es-AR')}`,
    55,
    735
  );

  const rawBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('No se pudo generar la foto de prueba'))),
      'image/jpeg',
      0.88
    );
  });

  return compressClaimPhoto(rawBlob);
}
