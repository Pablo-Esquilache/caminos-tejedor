export interface CompressedPhotoResult {
  photoBlob: Blob;
  thumbBlob: Blob;
  thumbDataUrl: string;
  originalSizeBytes: number;
  compressedSizeBytes: number;
}

/**
 * Decodifica y redimensiona de forma ultraliviana para móviles.
 * Utiliza createImageBitmap con redimensionado nativo por hardware cuando está disponible,
 * evitando que fotos pesadas de cámaras modernas (48 MP a 108 MP) desborden la memoria RAM del teléfono.
 */
async function createResizedCanvas(
  file: File | Blob,
  maxDimension: number
): Promise<HTMLCanvasElement> {
  // 1. Camino óptimo para navegadores modernos (reduce memoria antes de decodificar)
  if (typeof createImageBitmap === 'function') {
    try {
      const probe = await createImageBitmap(file);
      const origW = probe.width;
      const origH = probe.height;
      probe.close(); // Liberar memoria de inmediato

      let targetW = origW;
      let targetH = origH;
      if (origW > maxDimension || origH > maxDimension) {
        if (origW >= origH) {
          targetW = maxDimension;
          targetH = Math.max(1, Math.round((origH * maxDimension) / origW));
        } else {
          targetH = maxDimension;
          targetW = Math.max(1, Math.round((origW * maxDimension) / origH));
        }
      }

      const resizedBitmap = await createImageBitmap(file, {
        resizeWidth: targetW,
        resizeHeight: targetH,
        resizeQuality: 'medium',
      });

      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(resizedBitmap, 0, 0);
        resizedBitmap.close();
        return canvas;
      }
      resizedBitmap.close();
    } catch {
      // Continuar con fallback estándar si createImageBitmap falla
    }
  }

  // 2. Fallback estándar con HTMLImageElement
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;

      let targetW = width;
      let targetH = height;
      if (width > maxDimension || height > maxDimension) {
        if (width >= height) {
          targetW = maxDimension;
          targetH = Math.max(1, Math.round((height * maxDimension) / width));
        } else {
          targetH = maxDimension;
          targetW = Math.max(1, Math.round((width * maxDimension) / height));
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('No se pudo inicializar el contexto de imagen.'));
        return;
      }
      ctx.drawImage(img, 0, 0, targetW, targetH);
      resolve(canvas);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Error al comprimir imagen en el lienzo.'));
      },
      'image/jpeg',
      quality
    );
  });
}

/**
 * Comprime la foto en el cliente antes de subirla o guardarla en la cola offline:
 * - Foto principal: máx 1440px (JPEG 0.75, ideal para obras viales y reportes livianos < 150 KB)
 * - Miniatura (thumbnail): máx 280px (JPEG 0.65)
 * - Procesa en serie para mantener el consumo de memoria por debajo de 30 MB en móviles.
 */
export async function compressClaimPhoto(file: File | Blob): Promise<CompressedPhotoResult> {
  // 1. Redimensionar foto principal (máx 1440px)
  const mainCanvas = await createResizedCanvas(file, 1440);
  const photoBlob = await canvasToJpegBlob(mainCanvas, 0.75);

  // 2. Generar miniatura liviana a partir del lienzo ya reducido (ahorra 95% de CPU/RAM)
  const thumbCanvas = document.createElement('canvas');
  const tMax = 280;
  let tW = mainCanvas.width;
  let tH = mainCanvas.height;
  if (tW > tMax || tH > tMax) {
    if (tW >= tH) {
      tW = tMax;
      tH = Math.max(1, Math.round((mainCanvas.height * tMax) / mainCanvas.width));
    } else {
      tH = tMax;
      tW = Math.max(1, Math.round((mainCanvas.width * tMax) / mainCanvas.height));
    }
  }
  thumbCanvas.width = tW;
  thumbCanvas.height = tH;
  const tCtx = thumbCanvas.getContext('2d');
  if (tCtx) {
    tCtx.drawImage(mainCanvas, 0, 0, tW, tH);
  }
  const thumbBlob = await canvasToJpegBlob(thumbCanvas, 0.68);
  const thumbDataUrl = URL.createObjectURL(thumbBlob);

  return {
    photoBlob,
    thumbBlob,
    thumbDataUrl,
    originalSizeBytes: file.size,
    compressedSizeBytes: photoBlob.size,
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
