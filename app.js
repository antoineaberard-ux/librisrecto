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
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
      $('no-cam').hidden = true;
      $('roi').hidden = false;
      running = true;
    } catch (err) {
      const denied = /NotAllowed|Permission/i.test(String(err));
      showNoCam(denied ? 'Caméra refusée. Autorisez-la puis réessayez.' : 'Caméra inaccessible.');
    }
  }
  function showNoCam(msg) { $('no-cam-msg').textContent = msg; $('no-cam').hidden = false; }
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
    freezeDirty = false; renderFreeze();
    $('btn-freeze').innerHTML = '▶ Reprendre';
    haptic(15);
  }
  function unfreeze() {
    frozen = false; freezeCanvas.hidden = true;
    $('btn-freeze').innerHTML = '⏸ Figer';
    zoom = 1; $('zoom').value = 1;
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
    let timer = 0;
    try {
      const code = await new Promise((resolve, reject) => {
        timer = setTimeout(() => { cancelScan?.(); reject(new Error('timeout')); }, 25000);
        detect().then(resolve, reject);
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
        ? 'Scanner indisponible hors connexion. Saisissez l\'ISBN à la main.'
        : 'Code-barres non détecté. Rapprochez-vous, éclairez le code, ou saisissez l\'ISBN à la main.');
    }
  }
  function endScan() { cancelScan = null; scanMode = false; hideScanHud(); restoreStream(); applyTransform(); }

  function detect() { return ('BarcodeDetector' in window) ? detectNative() : detectZXing(); }

  async function detectNative() {
    const wanted = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
    const supported = await window.BarcodeDetector.getSupportedFormats().catch(() => []);
    const formats = wanted.filter((f) => supported.includes(f));
    if (!formats.length) return detectZXing();
    const detector = new window.BarcodeDetector({ formats });
    return new Promise((resolve, reject) => {
      let stopped = false;
      cancelScan = () => { stopped = true; };
      const tick = async () => {
        if (stopped) return reject(new Error('cancel'));
        try {
          const codes = await detector.detect(video);
          if (codes.length && codes[0].rawValue) { stopped = true; return resolve(codes[0].rawValue); }
        } catch { /* frame non décodable */ }
        setTimeout(tick, 160);
      };
      tick();
    });
  }

  async function detectZXing() {
    if (!window.ZXing) await loadScript(CDN_ZXING);
    const Z = window.ZXing;
    // Sans restriction de format, ZXing teste 20 symbologies par frame et rate l'ISBN.
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS,
      [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    if (!zxingReader) zxingReader = new Z.BrowserMultiFormatReader(hints, 160);

    return new Promise((resolve, reject) => {
      let done = false;
      // reset() couperait les pistes du MediaStream et tuerait la caméra pour de bon.
      const stop = () => { try { zxingReader.stopContinuousDecode(); } catch { /* déjà arrêté */ } };
      cancelScan = () => { if (done) return; done = true; stop(); reject(new Error('cancel')); };
      zxingReader.decodeFromVideoElement(video, (result) => {
        if (!result || done) return;
        done = true; stop(); resolve(result.getText());
      }).catch((e) => { if (!done) { done = true; stop(); reject(e); } });
    });
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
      if (book) renderBook(book);
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

  // ---------- Dialogue infos ----------
  function openDialog() { $('info-dialog').showModal(); }
  function closeDialog() { const d = $('info-dialog'); if (d.open) d.close('cancel'); }

  function registerSW() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
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
    $('zoom').addEventListener('input', (e) => { zoom = +e.target.value; freezeDirty = true; });

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
    $('btn-start').addEventListener('click', startCamera);
    $('btn-retry').addEventListener('click', startCamera);
    window.addEventListener('resize', () => { applyTransform(); freezeDirty = true; });

    $('cam-gate').hidden = false;
    setTimeout(() => $('cv-status').classList.add('hide'), 4000);
    requestAnimationFrame(loop);
  }
  document.addEventListener('DOMContentLoaded', init);

  return { dismissSheet, lookup, scanBarcode, readTitle, _orientationOf: orientationOf };
})();
