/* LibrisRecto — redresseur de livre (PWA iOS + Android)
   But principal : viser un livre incliné -> le titre s'affiche à l'horizontale.

   Pipeline :
     1. ROI centrée (la zone réellement visée, alignée sur le cadre à l'écran)
     2. Sobel -> histogramme circulaire d'orientation des contours (180 bins, 1°)
     3. lissage circulaire + interpolation parabolique + hystérésis anti-bascule 90°
     4. rotation GPU de la scène (CSS transform) lissée image par image

   Secondaire : lecture du titre (OCR Tesseract) et scan ISBN
   (BarcodeDetector natif, repli ZXing) -> synopsis Open Library / Google Books. */

const LibrisRecto = (() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const video = $('video'), stage = $('stage'), work = $('work');
  const freezeCanvas = $('freeze'), badge = $('angle-badge'), sheet = $('sheet');

  const DEG = 180 / Math.PI;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  const CDN_ZXING = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
  const CDN_TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  // Zone d'analyse : fraction de la surface visible (pas de la frame brute,
  // qui est recadrée par object-fit:cover). Doit coller au cadre affiché.
  const ROI_W = 0.80, ROI_H = 0.52;   // cadre de visée = zone d'analyse d'angle
  const OCR_W = 0.94, OCR_H = 0.86;   // l'OCR ratisse plus large : le titre déborde souvent du cadre
  const ANALYSIS_W = 224;      // largeur d'analyse (perf)
  const EST_PERIOD = 110;      // ms entre deux estimations (~9 fps)
  // Orientation repliée modulo 90° : les lignes de texte, les jambages des
  // lettres et les bords de la couverture sont tous alignés sur les mêmes axes,
  // donc ils votent tous dans le même bin. Décider LEQUEL des deux axes porte le
  // titre est peu fiable sur une vignette de 224 px ; on applique donc la
  // rotation minimale (< 45°) et le bouton quart de tour couvre les dos verticaux.
  const NBINS = 90;            // 1° par bin, orientation modulo 90°

  let stream = null, running = false;
  let dispAngle = 0;           // orientation détectée, lissée (continue, non bornée)
  let targetAngle = 0;         // orientation brute retenue par l'estimateur
  let locked = false;          // détection fiable ?
  let manualOffset = 0, useAuto = true;
  let frozen = false, zoom = 1, rawFrame = null;
  let quarterTurns = 0;        // quarts de tour ajoutés par l'utilisateur
  let freezeDirty = false;     // l'image figée ne se redessine que si l'angle/zoom bouge
  let scanMode = false;        // scan code-barres : on affiche la vue non pivotée
  let lastEstimate = 0;
  let zxingReader = null, ocrWorker = null, cancelScan = null;
  let track = null, caps = {}, torchOn = false;   // piste vidéo et ses capacités matérielles
  let focusRingTimer = 0;
  const scanCanvas = document.createElement('canvas');

  // ---------- Angles ----------
  // Ramène dans (-45, 45] : les orientations sont définies modulo 90°.
  const wrap90 = (a) => ((a + 45) % 90 + 90) % 90 - 45;
  const angDiff = (target, current) => wrap90(target - current);

  // ---------- Caméra ----------
  async function startCamera() {
    $('cam-gate').hidden = true;
    if (!navigator.mediaDevices?.getUserMedia) return showNoCam('Caméra non supportée par ce navigateur.');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          // Un code-barres se lit à 10-15 cm : sans autofocus continu le
          // capteur reste sur l'hyperfocale et l'image est floue de près.
          // `advanced` est au mieux : les contraintes inconnues sont ignorées.
          width: { ideal: 2560 }, height: { ideal: 1440 },
          advanced: [{ focusMode: 'continuous' }]
        },
        audio: false
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
      $('no-cam').hidden = true;
      $('roi').hidden = false;
      running = true;
      setupTrack();
    } catch (err) {
      const denied = /NotAllowed|Permission/i.test(String(err));
      showNoCam(denied ? 'Caméra refusée. Autorisez-la puis réessayez.' : 'Caméra inaccessible.');
    }
  }
  function showNoCam(msg) { $('no-cam-msg').textContent = msg; $('no-cam').hidden = false; }

  /* Capacités de la piste vidéo. Android Chrome expose focus, torche et zoom
     optique ; iOS Safari n'expose rien de tout ça (applyConstraints échoue en
     silence), d'où les boutons masqués plutôt que morts. */
  function setupTrack() {
    track = stream.getVideoTracks()[0] || null;
    caps = track?.getCapabilities ? (track.getCapabilities() || {}) : {};
    applyFocusMode('continuous');
    $('btn-torch').hidden = !caps.torch;
    setupZoomSlider();
  }
  async function applyFocusMode(mode) {
    if (!track?.applyConstraints) return false;
    if (caps.focusMode && !caps.focusMode.includes(mode)) return false;
    try { await track.applyConstraints({ advanced: [{ focusMode: mode }] }); return true; }
    catch { return false; }
  }

  // Point du repère écran -> coordonnées normalisées du capteur. La scène est
  // pivotée et zoomée, et le <video> est en object-fit:cover : il faut défaire
  // les deux, sinon le point de mise au point tombe à côté.
  function screenToSensor(px, py) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return null;
    const w = window.innerWidth, h = window.innerHeight;
    const rad = -currentAngle() * Math.PI / 180;
    const s = coverScale(currentAngle()) * zoom;
    const dx = px - w / 2, dy = py - h / 2;
    const ux = (dx * Math.cos(rad) - dy * Math.sin(rad)) / s + w / 2;
    const uy = (dx * Math.sin(rad) + dy * Math.cos(rad)) / s + h / 2;
    const cover = Math.max(w / vw, h / vh);
    const dispW = vw * cover, dispH = vh * cover;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    return { x: clamp((ux - (w - dispW) / 2) / dispW), y: clamp((uy - (h - dispH) / 2) / dispH) };
  }

  async function focusAt(px, py) {
    const p = screenToSensor(px, py);
    if (!p || !track?.applyConstraints) return;
    showFocusRing(px, py);
    const single = caps.focusMode?.includes('single-shot');
    try {
      await track.applyConstraints({
        advanced: [{ pointsOfInterest: [{ x: p.x, y: p.y }], focusMode: single ? 'single-shot' : 'continuous' }]
      });
    } catch { /* non supporté : le focus continu reste actif */ }
    if (single) {
      clearTimeout(focusRingTimer);
      focusRingTimer = setTimeout(() => applyFocusMode('continuous'), 3000);
    }
  }
  function showFocusRing(px, py) {
    const ring = $('focus-ring');
    ring.style.left = `${px}px`; ring.style.top = `${py}px`;
    ring.classList.remove('pulse');
    void ring.offsetWidth;           // relance l'animation
    ring.classList.add('pulse');
  }

  async function toggleTorch() {
    if (!track?.applyConstraints || !caps.torch) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      torchOn = next;
    } catch { torchOn = false; }
    $('btn-torch').classList.toggle('on', torchOn);
    $('btn-torch').textContent = torchOn ? '🔦' : '💡';
  }
  async function setTorch(on) { if (caps.torch && torchOn !== on) await toggleTorch(); }

  // Le curseur pilote le zoom OPTIQUE quand la caméra le permet (bien plus net
  // qu'un agrandissement de pixels), sinon il retombe sur un scale CSS.
  function setupZoomSlider() {
    const z = $('zoom');
    z.min = 1; z.max = 4; z.step = 0.1; z.value = 1;
    $('zoom-row').classList.toggle('optical', !!caps.zoom);
  }
  function applyZoom(value) {
    if (!frozen && caps.zoom && track?.applyConstraints) {
      const { min, max, step } = caps.zoom;
      const top = Math.min(max, min * 4);
      const target = min + (value - 1) / 3 * (top - min);
      zoom = 1;                       // pas de double zoom : le capteur s'en charge
      track.applyConstraints({ advanced: [{ zoom: step ? Math.round(target / step) * step : target }] })
        .catch(() => { zoom = value; });
    } else {
      zoom = value;
    }
    freezeDirty = true;
  }
  function restoreStream() {
    if (stream && !video.srcObject) { video.srcObject = stream; video.play().catch(() => {}); }
  }

  // ---------- Géométrie de la ROI ----------
  // object-fit:cover recadre la vidéo au ratio de l'écran ; on analyse la même
  // portion que celle affichée, sinon le cadre à l'écran ment sur ce qui est lu.
  function roiGeometry(vw, vh, wFrac = ROI_W, hFrac = ROI_H) {
    if (!vw || !vh) return null;
    const screenRatio = window.innerWidth / window.innerHeight;
    let coverW, coverH;
    if (vw / vh > screenRatio) { coverH = vh; coverW = vh * screenRatio; }
    else { coverW = vw; coverH = vw / screenRatio; }
    const sw = Math.max(16, Math.round(coverW * wFrac));
    const sh = Math.max(16, Math.round(coverH * hFrac));
    return { sx: Math.round((vw - sw) / 2), sy: Math.round((vh - sh) / 2), sw, sh };
  }
  function currentSource() {
    if (frozen && rawFrame) return { src: rawFrame, vw: rawFrame.width, vh: rawFrame.height };
    return { src: video, vw: video.videoWidth, vh: video.videoHeight };
  }

  // ---------- Estimation de l'inclinaison ----------
  const hist = new Float32Array(NBINS);
  const smoothed = new Float32Array(NBINS);
  const KERNEL = [0.06, 0.24, 0.40, 0.24, 0.06];   // ~2° de lissage circulaire

  function estimateAngle() {
    const g = roiGeometry(video.videoWidth, video.videoHeight);
    if (!g) return;

    const W = ANALYSIS_W, H = Math.max(8, Math.round(g.sh / g.sw * ANALYSIS_W));
    work.width = W; work.height = H;
    const ctx = work.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, g.sx, g.sy, g.sw, g.sh, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;

    const found = orientationOf(px, W, H);
    if (found === null) { setLock(false, 'Cherche un livre…'); return; }
    targetAngle = found;
    setLock(true, null);
  }

  /* Coeur de la détection, isolé du DOM pour être testable.
     Rend l'inclinaison des structures dominantes en degrés dans (-45, 45],
     ou null si la scène n'a pas de direction franche. */
  function orientationOf(px, W, H) {
    const lum = new Float32Array(W * H);
    for (let i = 0, p = 0; p < lum.length; i += 4, p++)
      lum[p] = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;

    hist.fill(0);
    const mags = new Float32Array(W * H), oris = new Float32Array(W * H);
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
    for (let i = 0; i < mags.length; i++) {
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

  function setLock(ok, text) {
    if (ok && !locked) $('hint').classList.add('hide');
    locked = ok;
    $('roi').classList.toggle('locked', ok);
    if (!ok) { badge.textContent = text; badge.classList.remove('active'); }
  }

  // ---------- Rendu ----------
  function currentAngle() {
    if (scanMode) return 0;
    return (useAuto ? -dispAngle : 0) + quarterTurns * 90 + manualOffset;
  }
  // Agrandit juste ce qu'il faut pour qu'aucun coin vide n'apparaisse après rotation.
  function coverScale(angleDeg) {
    const r = Math.abs(angleDeg) * Math.PI / 180;
    const W = window.innerWidth, H = window.innerHeight;
    const cos = Math.abs(Math.cos(r)), sin = Math.abs(Math.sin(r));
    return Math.max((W * cos + H * sin) / W, (W * sin + H * cos) / H);
  }
  function applyTransform() {
    const angle = currentAngle();
    stage.style.transform = `rotate(${angle.toFixed(2)}deg) scale(${(coverScale(angle) * zoom).toFixed(4)})`;
    if (locked && useAuto && !scanMode) {
      badge.textContent = `Redressé · ${angle.toFixed(0)}°`;
      badge.classList.add('active');
    } else if (!useAuto) {
      badge.textContent = `Manuel · ${manualOffset.toFixed(0)}°`;
      badge.classList.remove('active');
    }
  }

  function loop() {
    requestAnimationFrame(loop);
    if (!running) return;

    const now = performance.now();
    if (!frozen && !scanMode && useAuto && now - lastEstimate > EST_PERIOD) {
      lastEstimate = now;
      try { estimateAngle(); } catch { /* frame pas encore prête */ }
    }
    // Lissage par frame : la rotation suit la main sans à-coups.
    const d = angDiff(targetAngle, dispAngle);
    if (Math.abs(d) > 0.2) dispAngle += d * 0.18;

    // Image figée : inutile de la repeindre 60 fois par seconde.
    if (frozen) { if (freezeDirty) { freezeDirty = false; renderFreeze(); } }
    else applyTransform();
  }

  // ---------- Figer / Reprendre ----------
  function toggleFreeze() { frozen ? unfreeze() : freeze(); }
  function freeze() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    // On stocke la frame BRUTE : rezoomer ensuite ne doit pas rattraper une
    // nouvelle image (le flux continue de tourner derrière le canvas).
    if (!rawFrame) rawFrame = document.createElement('canvas');
    rawFrame.width = vw; rawFrame.height = vh;
    rawFrame.getContext('2d').drawImage(video, 0, 0, vw, vh);
    frozen = true;
    freezeCanvas.hidden = false;
    // Le zoom optique est déjà dans la frame capturée : on repart de 1 pour
    // que le curseur ne l'applique pas une seconde fois en CSS.
    zoom = 1; $('zoom').value = 1;
    freezeDirty = false; renderFreeze();
    $('btn-freeze').innerHTML = '▶ Reprendre';
    haptic(15);
  }
  function unfreeze() {
    frozen = false; freezeCanvas.hidden = true;
    $('btn-freeze').innerHTML = '⏸ Figer';
    zoom = 1; $('zoom').value = 1;
    applyZoom(1);
    applyTransform();
  }
  function renderFreeze() {
    if (!rawFrame) return;
    const w = window.innerWidth, h = window.innerHeight;
    const bw = Math.round(w * DPR), bh = Math.round(h * DPR);
    if (freezeCanvas.width !== bw || freezeCanvas.height !== bh) {
      freezeCanvas.width = bw; freezeCanvas.height = bh;
    }
    const ctx = freezeCanvas.getContext('2d');
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const angle = currentAngle();
    const vw = rawFrame.width, vh = rawFrame.height;
    const s = Math.max(w / vw, h / vh) * coverScale(angle) * zoom;
    ctx.translate(w / 2, h / 2);
    ctx.rotate(angle * Math.PI / 180);
    ctx.drawImage(rawFrame, -vw * s / 2, -vh * s / 2, vw * s, vh * s);
  }
  function haptic(p) { if (navigator.vibrate) navigator.vibrate(p); }

  // ---------- Capture redressée (pour l'OCR) ----------
  function captureUpright() {
    const { src, vw, vh } = currentSource();
    const g = roiGeometry(vw, vh, OCR_W, OCR_H);
    if (!g) return null;
    const out = document.createElement('canvas');
    const pad = 1.2;   // marge pour ne pas rogner les coins après rotation
    out.width = Math.round(g.sw * pad); out.height = Math.round(g.sh * pad);
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.width, out.height);
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(currentAngle() * Math.PI / 180);
    ctx.drawImage(src, g.sx, g.sy, g.sw, g.sh, -g.sw / 2, -g.sh / 2, g.sw, g.sh);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return boostContrast(out, ctx);
  }
  // Niveaux de gris + étirement sur les percentiles 2/98 : Tesseract décroche
  // vite sur une couverture peu contrastée ou surexposée.
  function boostContrast(canvas, ctx) {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data, n = d.length / 4;
    const gray = new Uint8ClampedArray(n), histo = new Uint32Array(256);
    for (let i = 0, p = 0; p < n; i += 4, p++) {
      const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      gray[p] = v; histo[v]++;
    }
    const lowCut = n * 0.02, highCut = n * 0.98;
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += histo[v]; if (acc >= lowCut) { lo = v; break; } }
    acc = 0;
    for (let v = 0; v < 256; v++) { acc += histo[v]; if (acc >= highCut) { hi = v; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0, p = 0; p < n; i += 4, p++) {
      const v = Math.max(0, Math.min(255, ((gray[p] - lo) * 255) / span));
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // ---------- Chargement paresseux des libs ----------
  const loaded = new Map();
  function loadScript(src) {
    if (loaded.has(src)) return loaded.get(src);
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { loaded.delete(src); reject(new Error('CDN inaccessible')); };
      document.head.appendChild(s);
    });
    loaded.set(src, p);
    return p;
  }

  // ---------- Scan du code-barres ISBN ----------
  async function scanBarcode() {
    closeDialog();
    if (!stream) return showNoCam('Activez la caméra pour scanner un code-barres.');
    if (frozen) unfreeze();
    scanMode = true; applyTransform();
    showScanHud('Visez le code-barres au dos du livre…');
    // Un code-barres se lit de près : on force la mise au point sur le cadre.
    focusAt(window.innerWidth / 2, window.innerHeight / 2);
    let timer = 0;
    try {
      const decode = await pickDecoder();
      const code = await new Promise((resolve, reject) => {
        timer = setTimeout(() => { cancelScan?.(); reject(new Error('timeout')); }, 30000);
        pumpFrames(decode).then(resolve, reject);
      });
      clearTimeout(timer);
      endScan();
      haptic(25);
      lookup({ isbn: code.replace(/[^0-9Xx]/g, '') });
    } catch (err) {
      clearTimeout(timer);
      endScan();
      if (String(err.message) === 'cancel') return;
      openSheet();
      showError(/CDN/.test(String(err.message))
        ? "Scanner indisponible hors connexion. Saisissez l'ISBN à la main."
        : "Code-barres non détecté. Tenez le code à 15 cm dans le cadre, touchez l'écran pour faire le point, allumez la lampe si besoin — ou saisissez l'ISBN à la main.");
    }
  }
  function endScan() {
    cancelScan = null; scanMode = false;
    hideScanHud(); restoreStream(); applyTransform();
    setTorch(false);
  }

  /* Recadrage de la bande visée, à la résolution NATIVE du capteur.
     C'est le vrai correctif du scan : décoder la frame entière revient à
     donner au décodeur un code-barres large de quelques dizaines de pixels,
     alors que le capteur en a des centaines dans le cadre. */
  function scanFrameCrop() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return null;
    let box = $('scan-frame').getBoundingClientRect();
    if (box.width < 8 || box.height < 8) {
      // Le HUD vient d'apparaître et la mise en page n'est pas encore calculée :
      // on retombe sur une bande centrée équivalente plutôt que de perdre la frame.
      const w = window.innerWidth, h = window.innerHeight;
      const bw = Math.min(w * 0.84, 420), bh = 130;
      box = { left: (w - bw) / 2, right: (w + bw) / 2, top: (h - bh) / 2, bottom: (h + bh) / 2, width: bw, height: bh };
    }
    const padX = box.width * 0.10, padY = box.height * 0.35;
    const a = screenToSensor(box.left - padX, box.top - padY);
    const b = screenToSensor(box.right + padX, box.bottom + padY);
    if (!a || !b) return null;
    const sx = Math.round(a.x * vw), sy = Math.round(a.y * vh);
    const sw = Math.round((b.x - a.x) * vw), sh = Math.round((b.y - a.y) * vh);
    if (sw < 40 || sh < 20) return null;
    scanCanvas.width = sw; scanCanvas.height = sh;
    scanCanvas.getContext('2d', { willReadFrequently: true })
      .drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    return scanCanvas;
  }

  const fullCanvas = document.createElement('canvas');
  /* Vue large. On ne réduit qu'au strict nécessaire : mesuré sur des images
     floues et bruitées comme en vrai, passer 2560 px à 1600 px fait tomber le
     taux de lecture de 5/5 à 0/5. BarcodeDetector est natif et encaisse la
     pleine résolution ; ZXing est en JS, d'où un plafond plus bas pour lui. */
  function fullFrame(maxWidth) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return null;
    const scale = Math.min(1, maxWidth / vw);
    fullCanvas.width = Math.round(vw * scale); fullCanvas.height = Math.round(vh * scale);
    fullCanvas.getContext('2d', { willReadFrequently: true })
      .drawImage(video, 0, 0, fullCanvas.width, fullCanvas.height);
    return fullCanvas;
  }

  /* Alterne cadre serré et vue large : le premier attrape le code tenu près,
     le second celui d'un livre posé plus loin. */
  function pumpFrames({ decode, maxWidth }) {
    return new Promise((resolve, reject) => {
      let stopped = false, useCrop = true, tries = 0;
      cancelScan = () => { stopped = true; };
      const tick = async () => {
        if (stopped) return reject(new Error('cancel'));
        const source = (useCrop ? scanFrameCrop() : fullFrame(maxWidth)) || fullFrame(maxWidth);
        useCrop = !useCrop;
        if (source) {
          try {
            const code = await decode(source);
            if (code) { stopped = true; return resolve(code); }
          } catch { /* rien sur cette frame */ }
        }
        // Après 4 s sans succès, l'éclairage est souvent en cause.
        if (++tries === 32 && caps.torch && !torchOn) {
          $('scan-msg').textContent = 'Toujours rien — essayez la lampe 💡';
        }
        setTimeout(tick, 110);
      };
      tick();
    });
  }

  async function pickDecoder() {
    if ('BarcodeDetector' in window) {
      const wanted = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
      const supported = await window.BarcodeDetector.getSupportedFormats().catch(() => []);
      const formats = wanted.filter((f) => supported.includes(f));
      if (formats.length) {
        const detector = new window.BarcodeDetector({ formats });
        return { decode: async (src) => (await detector.detect(src))[0]?.rawValue, maxWidth: Infinity };
      }
    }
    if (!window.ZXing) await loadScript(CDN_ZXING);
    const Z = window.ZXing;
    // Sans restriction de format, ZXing teste vingt symbologies par frame.
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS,
      [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    if (!zxingReader) zxingReader = new Z.BrowserMultiFormatReader(hints);
    else zxingReader.hints = hints;
    // decodeFromCanvas : on garde la main sur le flux. decodeFromVideoElement
    // impose reset(), qui coupe les pistes du MediaStream et tue la caméra.
    return { decode: async (src) => zxingReader.decodeFromCanvas(src)?.getText(), maxWidth: 1920 };
  }

  function showScanHud(msg) {
    $('scan-hud').hidden = false; $('scan-msg').textContent = msg;
    document.body.classList.add('scanning');
  }
  function hideScanHud() {
    $('scan-hud').hidden = true;
    document.body.classList.remove('scanning');
  }

  // ---------- Lecture du titre (OCR) ----------
  async function readTitle() {
    closeDialog();
    openSheet();
    showLoading('Préparation de la lecture…');
    try {
      const shot = captureUpright();
      if (!shot) throw new Error('frame');
      if (!window.Tesseract) {
        showLoading('Téléchargement du moteur OCR (première fois)…');
        await loadScript(CDN_TESSERACT);
      }
      if (!ocrWorker) {
        showLoading('Chargement des dictionnaires FR + EN…');
        ocrWorker = await window.Tesseract.createWorker('fra+eng');
      }
      showLoading('Lecture du titre…');
      const { data } = await ocrWorker.recognize(shot);
      const title = pickTitle(data);
      if (!title) return showError('Titre illisible. Rapprochez-vous, stabilisez, puis réessayez.');
      showLoading(`Recherche « ${title} »…`);
      const book = await byQuery(title);
      if (book) renderBook(book);
      else showError(`Aucune correspondance pour « ${title} ».`);
    } catch (err) {
      showError(/CDN|Failed/.test(String(err.message))
        ? 'Lecture du titre indisponible : connexion requise au premier usage.'
        : 'Lecture du titre impossible sur cette image.');
    }
  }
  // Sur une couverture, le titre est le texte le plus GRAND, pas le premier.
  function pickTitle(data) {
    const lines = (data.lines || []).map((l) => ({
      text: (l.text || '').replace(/\s+/g, ' ').trim(),
      conf: l.confidence || 0,
      top: l.bbox ? l.bbox.y0 : 0,
      height: l.bbox ? l.bbox.y1 - l.bbox.y0 : 0
    })).filter((l) => l.conf > 55 && /[A-Za-zÀ-ÿ]{3}/.test(l.text));
    if (!lines.length) return null;
    const best = lines.slice().sort((a, b) => b.height * b.conf - a.height * a.conf)[0];
    // Un titre déborde souvent sur deux lignes de même corps : on les recolle.
    return lines
      .filter((l) => l.height > best.height * 0.75)
      .sort((a, b) => a.top - b.top)
      .slice(0, 2)
      .map((l) => l.text)
      .join(' ')
      .slice(0, 90);
  }

  // ---------- Recherche du livre ----------
  function lookupFromInput() {
    const val = $('manual-input').value.trim();
    if (!val) return;
    const digits = val.replace(/[^0-9Xx]/g, '');
    if (digits.length === 13 || digits.length === 10) lookup({ isbn: digits });
    else lookup({ text: val });
    $('manual-input').value = '';
  }
  async function lookup(q) {
    openSheet(); showLoading('Recherche du livre…');
    try {
      const book = q.isbn ? await byISBN(q.isbn) : await byQuery(q.text);
      if (book) renderBook({ ...book, isbn: q.isbn || book.isbn || '' });
      else showError(q.isbn ? `Aucun livre pour l'ISBN ${q.isbn}.` : 'Aucune correspondance.');
    } catch { showError('Erreur réseau.'); }
  }
  async function byISBN(isbn) {
    try {
      const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
      const j = await r.json(); const d = j[`ISBN:${isbn}`];
      if (d) return mapOL(d, isbn);
    } catch { /* repli Google Books */ }
    try {
      const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
      const j = await r.json(); if (j.items?.length) return mapG(j.items[0]);
    } catch { /* rien trouvé */ }
    return null;
  }
  async function byQuery(text) {
    try {
      const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(text)}&maxResults=1`);
      const j = await r.json(); if (j.items?.length) return mapG(j.items[0]);
      // j.error : le quota anonyme de Google Books est par IP et vite atteint.
    } catch { /* repli Open Library */ }
    try {
      const r = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(text)}&limit=1`);
      const j = await r.json();
      if (j.docs?.length) return await mapOLSearch(j.docs[0]);
    } catch { /* rien trouvé */ }
    return null;
  }
  async function mapOLSearch(d) {
    let synopsis = 'Synopsis non disponible.';
    try {
      const r = await fetch(`https://openlibrary.org${d.key}.json`);
      const w = await r.json();
      const desc = typeof w.description === 'string' ? w.description : w.description?.value;
      if (desc) synopsis = desc;
    } catch { /* pas de résumé */ }
    return {
      title: d.title || 'Sans titre',
      author: (d.author_name || []).join(', ') || 'Auteur inconnu',
      rating: d.ratings_average || null,
      year: d.first_publish_year,
      pages: d.number_of_pages_median,
      cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
      synopsis
    };
  }
  function mapOL(d, isbn) {
    return {
      title: d.title || 'Sans titre',
      author: (d.authors || []).map((a) => a.name).join(', ') || 'Auteur inconnu',
      rating: null,
      year: (d.publish_date || '').match(/\d{4}/)?.[0],
      pages: d.number_of_pages,
      cover: d.cover?.medium || (isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg` : ''),
      synopsis: typeof d.notes === 'string' ? d.notes : d.excerpts?.[0]?.text || 'Synopsis non disponible.'
    };
  }
  function mapG(item) {
    const v = item.volumeInfo || {};
    return {
      title: v.title + (v.subtitle ? ` — ${v.subtitle}` : ''),
      author: (v.authors || []).join(', ') || 'Auteur inconnu',
      rating: v.averageRating || null,
      year: (v.publishedDate || '').match(/\d{4}/)?.[0],
      pages: v.pageCount,
      cover: (v.imageLinks?.thumbnail || '').replace('http:', 'https:'),
      synopsis: v.description || 'Synopsis non disponible.'
    };
  }

  // ---------- Feuille de synopsis ----------
  function renderBook(b) {
    $('sheet-loading').hidden = true; $('book-error').hidden = true; $('book').hidden = false;
    window.LibrisHistory?.add(b);
    $('book-title').textContent = b.title;
    $('book-author').textContent = b.author;
    const c = $('book-cover');
    if (b.cover) { c.src = b.cover; c.style.visibility = 'visible'; } else c.style.visibility = 'hidden';
    $('book-rating').textContent = b.rating
      ? '★'.repeat(Math.round(b.rating)) + '☆'.repeat(5 - Math.round(b.rating)) : '';
    $('book-extra').textContent = [b.year, b.pages ? `${b.pages} pages` : null].filter(Boolean).join(' · ');
    $('book-synopsis').textContent = b.synopsis;
  }
  function showLoading(m) {
    $('book').hidden = true; $('book-error').hidden = true;
    $('loading-msg').textContent = m; $('sheet-loading').hidden = false;
  }
  function showError(m) {
    $('sheet-loading').hidden = true; $('book').hidden = true;
    $('book-error').hidden = false; $('book-error-msg').textContent = m;
  }
  function openSheet() { sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false'); }
  function dismissSheet() { sheet.classList.remove('open', 'full'); sheet.setAttribute('aria-hidden', 'true'); }
  function setupSheet() {
    const handle = $('sheet-handle');
    let y0 = 0, dragging = false;
    handle.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; dragging = true; }, { passive: true });
    handle.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const dy = e.touches[0].clientY - y0;
      if (dy < -40) { sheet.classList.add('full'); dragging = false; }
      else if (dy > 60) { dismissSheet(); dragging = false; }
    }, { passive: true });
    handle.addEventListener('touchend', () => { dragging = false; });
    handle.addEventListener('click', () => sheet.classList.toggle('full'));
  }

  // ---------- Historique ----------
  function openHistory() {
    dismissSheet();
    const h = $('history-sheet');
    h.classList.add('open', 'full');
    h.setAttribute('aria-hidden', 'false');
  }
  function closeHistory() {
    const h = $('history-sheet');
    h.classList.remove('open', 'full');
    h.setAttribute('aria-hidden', 'true');
  }
  function renderHistory(items) {
    const ul = $('history-list');
    ul.textContent = '';
    $('history-empty').hidden = items.length > 0;
    for (const it of items) {
      const li = document.createElement('li');
      li.className = 'history-item';
      const img = document.createElement('img');
      img.alt = ''; img.loading = 'lazy';
      if (it.cover) img.src = it.cover;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const t = document.createElement('div'); t.className = 't'; t.textContent = it.title;
      const a = document.createElement('div'); a.className = 'a';
      a.textContent = [it.author, it.year].filter(Boolean).join(' · ');
      meta.append(t, a);
      const del = document.createElement('button');
      del.className = 'del'; del.type = 'button';
      del.setAttribute('aria-label', `Retirer ${it.title}`);
      del.textContent = '✕';
      del.addEventListener('click', (e) => { e.stopPropagation(); window.LibrisHistory?.remove(it.id); });
      // Retoucher une fiche : on relance la recherche depuis l'historique.
      li.addEventListener('click', () => {
        closeHistory();
        lookup(it.isbn ? { isbn: it.isbn } : { text: `${it.title} ${it.author}` });
      });
      li.append(img, meta, del);
      ul.append(li);
    }
    $('history-sync').textContent = window.LibrisHistory?.isSynced()
      ? 'Enregistré sur cet appareil et sauvegardé en ligne.'
      : 'Enregistré sur cet appareil.';
  }

  // ---------- Dialogue infos ----------
  function openDialog() { $('info-dialog').showModal(); }
  function closeDialog() { const d = $('info-dialog'); if (d.open) d.close('cancel'); }

  // Dans l'app native les fichiers sont déjà locaux : un service worker
  // n'apporterait rien et son cache ferait écran aux mises à jour de l'APK.
  const isNative = () => !!window.__LIBRIS_NATIVE__ || !!window.Capacitor?.isNativePlatform?.();
  function registerSW() {
    if (isNative() || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  function init() {
    setupSheet(); registerSW();

    $('rotate-fine').addEventListener('input', (e) => { manualOffset = +e.target.value; freezeDirty = true; });
    $('btn-reset').addEventListener('click', () => {
      useAuto = !useAuto;
      manualOffset = 0; quarterTurns = 0; $('rotate-fine').value = 0; freezeDirty = true;
      $('btn-reset').textContent = useAuto ? 'Auto' : 'Manuel';
      $('btn-reset').classList.toggle('on', useAuto);
    });
    // Le redressement automatique est à ±45° près : un dos de livre vertical
    // se retrouve droit mais à la verticale, d'où le quart de tour manuel.
    $('btn-quarter').addEventListener('click', () => {
      quarterTurns = (quarterTurns + 1) % 4; freezeDirty = true;
      $('btn-quarter').classList.toggle('on', quarterTurns !== 0);
      haptic(10);
    });
    $('zoom').addEventListener('input', (e) => applyZoom(+e.target.value));
    $('btn-torch').addEventListener('click', toggleTorch);
    // Toucher l'image = faire le point là où on vise. Indispensable pour un
    // code-barres tenu à 15 cm, que l'autofocus continu rate souvent.
    $('scanner').addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, a, .sheet, dialog')) return;
      focusAt(e.clientX, e.clientY);
    });

    $('btn-freeze').addEventListener('click', toggleFreeze);
    $('btn-info').addEventListener('click', openDialog);
    $('btn-scan-isbn').addEventListener('click', scanBarcode);
    $('btn-read-title').addEventListener('click', readTitle);
    $('btn-scan-cancel').addEventListener('click', () => cancelScan?.());
    // La soumission implicite (Entrée) déclenche le PREMIER bouton du formulaire,
    // donc « Fermer » : on intercepte pour lancer la recherche.
    $('manual-input').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); closeDialog(); lookupFromInput();
    });
    $('info-form').addEventListener('submit', () => {
      const dlg = $('info-dialog');
      setTimeout(() => { if (dlg.returnValue === 'ok') lookupFromInput(); }, 0);
    });
    $('btn-history').addEventListener('click', openHistory);
    $('history-handle').addEventListener('click', closeHistory);
    $('btn-history-clear').addEventListener('click', () => {
      if (confirm('Effacer tout l\'historique des livres scannés ?')) window.LibrisHistory?.clear();
    });
    // history.js est un module : il peut arriver après ce script.
    const bindHistory = () => window.LibrisHistory
      ? window.LibrisHistory.onChange(renderHistory)
      : setTimeout(bindHistory, 200);
    bindHistory();

    $('btn-start').addEventListener('click', startCamera);
    $('btn-retry').addEventListener('click', startCamera);
    window.addEventListener('resize', () => { applyTransform(); freezeDirty = true; });

    $('cam-gate').hidden = false;
    setTimeout(() => $('cv-status').classList.add('hide'), 4000);
    requestAnimationFrame(loop);
  }
  document.addEventListener('DOMContentLoaded', init);

  return { dismissSheet, lookup, scanBarcode, readTitle, openHistory, _orientationOf: orientationOf };
})();
