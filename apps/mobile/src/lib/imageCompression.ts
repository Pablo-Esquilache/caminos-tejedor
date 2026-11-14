export interface CompressedPhotoResult {
  photoBlob: Blob;
  thumbBlob: Blob;
  thumbDataUrl: string;
  originalSizeBytes: number;
  compressedSizeBytes: number;
}

interface HeaderDims {
  width: number;
  height: number;
  orientation: number; // EXIF 1..8 (5..8 intercambian ancho/alto)
}

/**
 * Lee las dimensiones y orientación EXIF de una imagen JPEG/PNG/WebP leyendo únicamente
 * los primeros 128 KB del archivo, evitando decodificar fotos de 48-108 MP completas en RAM.
 */
async function readImageDimensionsFromHeader(
  file: File | Blob
): Promise<HeaderDims | null> {
  try {
    const slice = file.slice(0, 131072);
    const buf = await slice.arrayBuffer();
    const view = new DataView(buf);
    const len = view.byteLength;

    // PNG: 89 50 4E 47
    if (len >= 24 && view.getUint32(0, false) === 0x89504e47) {
      const width = view.getUint32(16, false);
      const height = view.getUint32(20, false);
      if (width > 0 && height > 0) return { width, height, orientation: 1 };
    }

    // WebP: "RIFF"...."WEBP"
    if (
      len >= 30 &&
      view.getUint32(0, false) === 0x52494646 &&
      view.getUint32(8, false) === 0x57454250
    ) {
      const chunk = view.getUint32(12, false);
      if (chunk === 0x56503820 && len >= 30) {
        // VP8
        const w = view.getUint16(26, true) & 0x3fff;
        const h = view.getUint16(28, true) & 0x3fff;
        if (w > 0 && h > 0) return { width: w, height: h, orientation: 1 };
      } else if (chunk === 0x5650384c && len >= 25) {
        // VP8L
        const b = view.getUint32(21, true);
        const w = (b & 0x3fff) + 1;
        const h = ((b >> 14) & 0x3fff) + 1;
        if (w > 0 && h > 0) return { width: w, height: h, orientation: 1 };
      } else if (chunk === 0x56503858 && len >= 30) {
        // VP8X
        const w = 1 + (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16));
        const h = 1 + (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16));
        if (w > 0 && h > 0) return { width: w, height: h, orientation: 1 };
      }
    }

    // JPEG: FF D8
    if (len >= 4 && view.getUint16(0, false) === 0xffd8) {
      let offset = 2;
      let orientation = 1;
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
        if (segLen < 2) break;

        // APP1 (EXIF): leer etiqueta Orientation (0x0112)
        if (
          marker === 0xe1 &&
          offset + 10 <= len &&
          view.getUint32(offset + 2, false) === 0x45786966
        ) {
          const tiff = offset + 8;
          if (tiff + 8 <= len) {
            const little = view.getUint16(tiff, false) === 0x4949;
            const ifd0 = tiff + view.getUint32(tiff + 4, little);
            if (ifd0 + 2 <= len) {
              const entries = view.getUint16(ifd0, little);
              for (let i = 0; i < entries; i++) {
                const e = ifd0 + 2 + i * 12;
                if (e + 12 > len) break;
                if (view.getUint16(e, little) === 0x0112) {
                  const val = view.getUint16(e + 8, little);
                  if (val >= 1 && val <= 8) orientation = val;
                  break;
                }
              }
            }
          }
        }

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
            if (width > 0 && height > 0) {
              return { width, height, orientation };
            }
          }
          break;
        }

        if (offset + segLen > len) break;
        offset += segLen;
      }
    }
  } catch {
    // Ignorar y usar fallback
  }
  return null;
}

function fitWithin(w: number, h: number, maxDim: number): { tw: number; th: number } {
  if (w <= maxDim && h <= maxDim) return { tw: w, th: h };
  if (w >= h) {
    return { tw: maxDim, th: Math.max(1, Math.round((h * maxDim) / w)) };
  }
  return { tw: Math.max(1, Math.round((w * maxDim) / h)), th: maxDim };
}

/**
 * Decodifica y redimensiona de forma ultraliviana para móviles.
 * Utiliza createImageBitmap con resizeWidth/resizeHeight y siempre dibuja con
 * ctx.drawImage(bmp, 0, 0, tw, th) para evitar recortes si el navegador ignora resizeWidth.
 */
async function createResizedCanvas(
  file: File | Blob,
  maxDimension: number
): Promise<HTMLCanvasElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      const dims = await readImageDimensionsFromHeader(file);
      let bmp: ImageBitmap;

      if (dims) {
        const swapped = dims.orientation >= 5 && dims.orientation <= 8;
        const dispW = swapped ? dims.height : dims.width;
        const dispH = swapped ? dims.width : dims.height;
        const { tw, th } = fitWithin(dispW, dispH, maxDimension);
        bmp = await createImageBitmap(file, {
          resizeWidth: tw,
          resizeHeight: th,
          resizeQuality: 'medium',
          imageOrientation: 'from-image',
        } as ImageBitmapOptions);
      } else {
        bmp = await createImageBitmap(file, {
          imageOrientation: 'from-image',
        } as ImageBitmapOptions);
      }

      try {
        // Calcular dimensiones finales a partir del bitmap real devuelto
        const { tw, th } = fitWithin(bmp.width, bmp.height, maxDimension);
        const canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          // Escalar explícitamente a (tw, th) por si el navegador ignoró resizeWidth/resizeHeight
          ctx.drawImage(bmp, 0, 0, tw, th);
          return canvas;
        }
      } finally {
        bmp.close();
      }
    } catch {
      // Continuar con fallback estándar si createImageBitmap falla
    }
  }

  // Fallback estándar con HTMLImageElement
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      const { tw, th } = fitWithin(width, height, maxDimension);

      const canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('No se pudo inicializar el contexto de imagen.'));
        return;
      }
      ctx.drawImage(img, 0, 0, tw, th);
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

async function canvasToJpegUnder(
  canvas: HTMLCanvasElement,
  startQuality: number,
  minQuality: number,
  maxBytes: number
): Promise<Blob> {
  let q = startQuality;
  let blob = await canvasToJpegBlob(canvas, q);
  while (blob.size > maxBytes && q - 0.1 >= minQuality) {
    q = Math.round((q - 0.1) * 100) / 100;
    blob = await canvasToJpegBlob(canvas, q);
  }
  return blob;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('No se pudo generar vista previa de miniatura.'));
    };
    reader.onerror = () => reject(reader.error || new Error('Error leyendo miniatura.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Comprime la foto en el cliente antes de subirla o guardarla en la cola offline:
 * - Foto principal: máx 1280px (JPEG <= 150 KB con ajuste iterativo de calidad)
 * - Miniatura (thumbnail): máx 280px (JPEG 0.65, ~8-12 KB)
 * - thumbDataUrl persistente (data:image/jpeg;base64 sobre la miniatura de 8 KB) que no caduca al reiniciar la app.
 */
export async function compressClaimPhoto(file: File | Blob): Promise<CompressedPhotoResult> {
  // 1. Redimensionar foto principal (máx 1280px, objetivo <= 150 KB)
  const mainCanvas = await createResizedCanvas(file, 1280);
  let photoBlob: Blob;
  let thumbCanvas: HTMLCanvasElement;
  try {
    photoBlob = await canvasToJpegUnder(mainCanvas, 0.72, 0.42, 150 * 1024);

    // 2. Generar miniatura liviana a partir del lienzo ya reducido (ahorra 95% de CPU/RAM)
    thumbCanvas = document.createElement('canvas');
    const { tw, th } = fitWithin(mainCanvas.width, mainCanvas.height, 280);
    thumbCanvas.width = tw;
    thumbCanvas.height = th;
    const tCtx = thumbCanvas.getContext('2d');
    if (tCtx) {
      tCtx.drawImage(mainCanvas, 0, 0, tw, th);
    }
  } finally {
    // Liberar memoria de mainCanvas de inmediato
    mainCanvas.width = 0;
    mainCanvas.height = 0;
  }

  let thumbBlob: Blob;
  try {
    thumbBlob = await canvasToJpegBlob(thumbCanvas, 0.65);
  } finally {
    thumbCanvas.width = 0;
    thumbCanvas.height = 0;
  }

  // Generar Data URL sobre la miniatura ya comprimida (~10 KB), segura para IndexedDB offline
  const thumbDataUrl = await blobToDataUrl(thumbBlob);

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
  canvas.width = 0;
  canvas.height = 0;

  return compressClaimPhoto(rawBlob);
}
