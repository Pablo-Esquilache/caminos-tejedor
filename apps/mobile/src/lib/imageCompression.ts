export interface CompressedPhotoResult {
  photoBlob: Blob;
  thumbBlob: Blob;
  thumbDataUrl: string;
  originalSizeBytes: number;
  compressedSizeBytes: number;
}

/**
 * Lee las dimensiones de una imagen JPEG/PNG/WebP leyendo únicamente los primeros 128 KB
 * del archivo, evitando decodificar fotos de 48-108 MP completas en memoria RAM.
 */
async function readImageDimensionsFromHeader(
  file: File | Blob
): Promise<{ width: number; height: number } | null> {
  try {
    const slice = file.slice(0, 131072);
    const buf = await slice.arrayBuffer();
    const view = new DataView(buf);
    const len = view.byteLength;

    // PNG: 89 50 4E 47
    if (len >= 24 && view.getUint32(0, false) === 0x89504e47) {
      const width = view.getUint32(16, false);
      const height = view.getUint32(20, false);
      if (width > 0 && height > 0) return { width, height };
    }

    // JPEG: FF D8
    if (len >= 4 && view.getUint16(0, false) === 0xffd8) {
      let offset = 2;
      while (offset + 4 < len) {
        if (view.getUint8(offset) !== 0xff) break;
        while (offset < len && view.getUint8(offset) === 0xff) offset++;
        if (offset >= len) break;
        const marker = view.getUint8(offset);
        offset++;

        if (marker === 0xd9 || marker === 0xda) break; // EOI o SOS
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

        if (offset + 2 > len) break;
        const segLen = view.getUint16(offset, false);
        if (segLen < 2 || offset + segLen > len) break;

        // SOF0..SOF15 (excepto DHT=C4, JPG=C8, DAC=CC)
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          if (offset + 7 <= len) {
            const height = view.getUint16(offset + 3, false);
            const width = view.getUint16(offset + 5, false);
            if (width > 0 && height > 0) return { width, height };
          }
          break;
        }
        offset += segLen;
      }
    }
  } catch {
    // Ignorar y usar fallback
  }
  return null;
}

/**
 * Decodifica y redimensiona de forma ultraliviana para móviles.
 * Utiliza createImageBitmap con resizeWidth/resizeHeight sin decodificar primero
 * la imagen completa en RAM, evitando errores de "memoria insuficiente" en PWA Android.
 */
async function createResizedCanvas(
  file: File | Blob,
  maxDimension: number
): Promise<HTMLCanvasElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      const dims = await readImageDimensionsFromHeader(file);
      let resizeOpts: ImageBitmapOptions = {
        resizeWidth: maxDimension,
        resizeQuality: 'medium',
      };

      if (dims) {
        let targetW = dims.width;
        let targetH = dims.height;
        if (dims.width > maxDimension || dims.height > maxDimension) {
          if (dims.width >= dims.height) {
            targetW = maxDimension;
            targetH = Math.max(1, Math.round((dims.height * maxDimension) / dims.width));
          } else {
            targetH = maxDimension;
            targetW = Math.max(1, Math.round((dims.width * maxDimension) / dims.height));
          }
        }
        resizeOpts = {
          resizeWidth: targetW,
          resizeHeight: targetH,
          resizeQuality: 'medium',
        };
      }

      const resizedBitmap = await createImageBitmap(file, resizeOpts);
      const canvas = document.createElement('canvas');
      canvas.width = resizedBitmap.width;
      canvas.height = resizedBitmap.height;
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
  // 1. Redimensionar foto principal (máx 1280px, JPEG 0.72 para bajo consumo de RAM en PWA)
  const mainCanvas = await createResizedCanvas(file, 1280);
  const photoBlob = await canvasToJpegBlob(mainCanvas, 0.72);

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
  // Liberar memoria de mainCanvas de inmediato
  mainCanvas.width = 0;
  mainCanvas.height = 0;

  const thumbBlob = await canvasToJpegBlob(thumbCanvas, 0.65);
  thumbCanvas.width = 0;
  thumbCanvas.height = 0;

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
