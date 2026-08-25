/* Détection de l'inclinaison — exécutée dans un Worker.

   Ce calcul tournait sur le thread principal : un getImageData à 9 Hz force une
   lecture GPU vers CPU qui bloque le compositeur, d'où une rotation saccadée.
   Ici il ne gêne plus l'affichage, et les tableaux sont réutilisés d'une image
   à l'autre au lieu d'être réalloués (350 Ko par passe, neuf fois par seconde).

   Méthode : Sobel, puis histogramme circulaire des orientations de contours
   replié modulo 90°, lissé, avec interpolation parabolique du pic. */

const DEG = 180 / Math.PI;
const NBINS = 90;                                   // 1° par bin, modulo 90°
const KERNEL = [0.06, 0.24, 0.40, 0.24, 0.06];      // ~2° de lissage circulaire

const hist = new Float32Array(NBINS);
const smoothed = new Float32Array(NBINS);

// Réutilisés d'une image à l'autre : la taille ne change qu'au changement de ROI.
let lum = null, mags = null, oris = null, cells = 0;
function buffers(n) {
  if (cells === n) return;
  lum = new Float32Array(n);
  mags = new Float32Array(n);
  oris = new Float32Array(n);
  cells = n;
}

const wrap90 = (a) => ((a + 45) % 90 + 90) % 90 - 45;

/* Rend l'inclinaison dominante en degrés dans (-45, 45], ou null si la scène
   n'a pas de direction franche. */
function orientationOf(px, W, H) {
  const n = W * H;
  buffers(n);

  for (let i = 0, p = 0; p < n; i += 4, p++)
    lum[p] = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;

  hist.fill(0);
  let magSum = 0, magCount = 0;

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = -lum[i - 1 - W] - 2 * lum[i - 1] - lum[i - 1 + W]
               + lum[i + 1 - W] + 2 * lum[i + 1] + lum[i + 1 + W];
      const gy = -lum[i - W - 1] - 2 * lum[i - W] - lum[i - W + 1]
               + lum[i + W - 1] + 2 * lum[i + W] + lum[i + W + 1];
      const m = Math.hypot(gx, gy);
      mags[i] = m; magSum += m; magCount++;
      // Orientation du CONTOUR = direction du gradient + 90°, repliée sur [0,90).
      let o = Math.atan2(gy, gx) * DEG + 90;
      o %= 90; if (o < 0) o += 90;
      oris[i] = o;
    }
  }

  // Seuil adaptatif : un dos mat et une couverture glacée en plein soleil
  // n'ont pas du tout les mêmes amplitudes de gradient.
  const threshold = Math.max(20, (magSum / Math.max(1, magCount)) * 1.9);
  let votes = 0, total = 0;
  for (let i = 0; i < n; i++) {
    const m = mags[i];
    if (m < threshold) continue;
    let b = Math.round(oris[i]); if (b >= NBINS) b -= NBINS;
    hist[b] += m; total += m; votes++;
  }
  if (votes < 250) return null;

  for (let b = 0; b < NBINS; b++) {
    let acc = 0;
    for (let k = -2; k <= 2; k++) acc += hist[(b + k + NBINS) % NBINS] * KERNEL[k + 2];
    smoothed[b] = acc;
  }

  let peak = 0;
  for (let b = 1; b < NBINS; b++) if (smoothed[b] > smoothed[peak]) peak = b;
  // Pic à peine au-dessus du bruit = scène sans direction dominante.
  if (smoothed[peak] < (total / NBINS) * 2.0) return null;

  // Interpolation parabolique circulaire : précision sous le degré.
  const l = smoothed[(peak - 1 + NBINS) % NBINS], c = smoothed[peak], r = smoothed[(peak + 1) % NBINS];
  const denom = l - 2 * c + r;
  return wrap90(peak + (denom !== 0 ? 0.5 * (l - r) / denom : 0));
}

// ---------- Interface Worker ----------
// Deux entrées possibles : un ImageBitmap (chemin rapide, décodage hors du
// thread principal) ou une ImageData brute (repli pour les Safari anciens).
let canvas = null, ctx = null;

function fromBitmap(bitmap) {
  const { width: W, height: H } = bitmap;
  if (!canvas || canvas.width !== W || canvas.height !== H) {
    canvas = new OffscreenCanvas(W, H);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { px: ctx.getImageData(0, 0, W, H).data, W, H };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (e) => {
    const { id, bitmap, data, width, height } = e.data;
    try {
      const frame = bitmap ? fromBitmap(bitmap) : { px: new Uint8ClampedArray(data), W: width, H: height };
      self.postMessage({ id, angle: orientationOf(frame.px, frame.W, frame.H) });
    } catch {
      self.postMessage({ id, angle: null });
    }
  };
}
