/* LibrisRecto — redresseur de livre (PWA iOS + Android)
   But principal : viser un livre incliné -> le titre s'affiche à l'horizontale.

   Pipeline :
     1. ROI centrée (la zone réellement visée, alignée sur le cadre à l'écran)
     2. Sobel -> histogramme circulaire d'orientation des contours (180 bins, 1°)
     3. lissage circulaire + interpolation parabolique + hystérésis anti-bascule 90°
     4. rotation GPU de la scène (CSS transform) lissée image par image

   Secondaire : lecture du titre (OCR Tesseract) et scan ISBN
   (BarcodeDetector natif, repli ZXing) -> synopsis Open Library / Google Books. */

// Version affichée dans le diagnostic : sans elle, impossible de savoir si un
// téléphone tourne encore sur une version en cache.
const LIBRIS_VERSION = '2026-08-28 20:21';

// Une erreur avalée est une panne muette : on garde la dernière pour le
// diagnostic. Posé avant tout le reste pour attraper aussi les erreurs d'init.
window.__librisLastError = null;
window.addEventListener('error', (e) => {
  window.__librisLastError = `${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`;
});
window.addEventListener('unhandledrejection', (e) => {
  window.__librisLastError = 'promesse rejetée : ' + (e.reason?.message || e.reason);
});

const LibrisRecto = (() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const video = $('video'), stage = $('stage'), work = $('work');
  const freezeCanvas = $('freeze'), badge = $('angle-badge'), sheet = $('sheet');

  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  // @zxing/library (portage JS) a été abandonné : son API decodeFromCanvas
  // n'existe pas, et il décroche dès le moindre flou. zxing-wasm est le ZXing
  // C++ compilé — mesuré : il lit là où le portage JS échoue.
  const CDN_ZXING_WASM = 'https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.3/dist/es/reader/index.js';
  const CDN_TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  // Zone d'analyse : fraction de la surface visible (pas de la frame brute,
  // qui est recadrée par object-fit:cover). Doit coller au cadre affiché.
  const ROI_W = 0.80, ROI_H = 0.52;   // cadre de visée = zone d'analyse d'angle
  const OCR_W = 0.94, OCR_H = 0.86;   // l'OCR ratisse plus large : le titre déborde souvent du cadre
  // Ce qui compte pour l'OCR, c'est la LARGEUR : le texte court dessus. Plafonner
  // le côté long écrasait la largeur à 555 px sur une capture portrait, rendant
  // le titre illisible. Le plafond en pixels reste un filet de sécurité.
  const OCR_MAX_WIDTH = 1000;
  const OCR_MAX_PIXELS = 1.8e6;
  const ANALYSIS_W = 224;      // largeur d'analyse (perf)
  const EST_PERIOD = 110;      // ms entre deux estimations (~9 fps)
  // Le redressement est modulo 90° : les lignes de texte, les jambages des
  // lettres et les bords de la couverture sont tous alignés sur les mêmes axes.
  // Décider LEQUEL des deux axes porte le titre est peu fiable sur une vignette,
  // on applique donc la rotation minimale (< 45°) et le bouton quart de tour
  // couvre les dos de livre verticaux. Détail de l'algorithme : angle-worker.js

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
  let ocrWorker = null, cancelScan = null;
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
      startWorker();
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
    // Sans autofocus piloté, l'objectif resterait sur sa distance par défaut.
    if (!caps.focusMode?.includes('continuous') && autofocusSupporte()) {
      setTimeout(autofocusSweep, 1200);
    }
  }
  async function applyFocusMode(mode) {
    if (!track?.applyConstraints) return false;
    if (caps.focusMode && !caps.focusMode.includes(mode)) return false;
    try { await track.applyConstraints({ advanced: [{ focusMode: mode }] }); return true; }
    catch { return false; }
  }

  /* Certaines caméras Android n'exposent QUE le mode « manual » : aucun
     autofocus n'est alors pilotable, l'objectif reste à une distance fixe et
     l'image est floue de près. Le redressement s'en accommode, il mesure des
     gradients sur toute une zone ; le code-barres et l'OCR, non.

     On fabrique donc l'autofocus manquant : on balaie les distances de mise au
     point et on garde la plus nette. Une passe coûte un peu plus d'une seconde,
     elle n'est lancée qu'au toucher et avant un scan. */
  const autofocusSupporte = () =>
    !!(caps.focusDistance && track?.applyConstraints &&
       (!caps.focusMode || caps.focusMode.includes('manual')));

  let sharpCanvas = null, sharpCtx = null;

  /* Mesure de netteté normalisée par le contraste.

     Une simple somme de gradients dépend surtout de la scène : un motif très
     contrasté mais flou peut la faire monter plus haut qu'un texte net et pâle.
     En divisant l'énergie des gradients par l'écart-type des luminances, on
     obtient une mesure qui ne juge plus « combien il y a de contraste » mais
     « à quel point ce contraste est franc » — c'est-à-dire la mise au point. */
  function sharpness() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return 0;
    const W = 160, H = 120;
    if (!sharpCanvas) {
      sharpCanvas = document.createElement('canvas');
      sharpCanvas.width = W; sharpCanvas.height = H;
      sharpCtx = sharpCanvas.getContext('2d', { willReadFrequently: true });
    }
    // Centre de l'image : c'est là que l'utilisateur vise.
    const cw = Math.round(vw * 0.4), ch = Math.round(vh * 0.25);
    sharpCtx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, W, H);
    const d = sharpCtx.getImageData(0, 0, W, H).data;

    let somme = 0, sommeCarres = 0, gradients = 0, n = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = (y * W + x) * 4;
        const v = d[i];
        somme += v; sommeCarres += v * v; n++;
        gradients += Math.abs(v - d[i + 4]) + Math.abs(v - d[i + W * 4]);
      }
    }
    if (!n) return 0;
    const moyenne = somme / n;
    const ecartType = Math.sqrt(Math.max(0, sommeCarres / n - moyenne * moyenne));
    if (ecartType < 4) return 0;          // surface unie : rien à mettre au point
    return (gradients / n) / ecartType;
  }

  let netteteTimer = 0, netteteMin = Infinity, netteteMax = 0, netteteEchantillons = 0;
  function demarrerNettete() {
    arreterNettete();
    netteteMin = Infinity; netteteMax = 0; netteteEchantillons = 0;
    $('sharp-meter').hidden = false;
    $('sharp-fill').style.width = '0%';
    netteteTimer = setInterval(() => {
      const note = sharpness();
      netteteEchantillons++;
      if (note > netteteMax) netteteMax = note;
      if (note < netteteMin) netteteMin = note;

      const etendue = netteteMin > 0 ? netteteMax / netteteMin : 1;
      const part = netteteMax > 0 ? Math.max(0, Math.min(1, note / netteteMax)) : 0;
      $('sharp-fill').style.width = `${Math.round(part * 100)}%`;

      // On ne peut affirmer « net » qu'après avoir VU du flou : tant que toutes
      // les mesures se ressemblent, le maximum n'est qu'un maximum local et
      // annoncer la netteté serait une pure invention.
      const aCompare = netteteEchantillons >= 10 && etendue > 1.25;
      const net = aCompare && part > 0.9;
      $('sharp-fill').classList.toggle('bon', net);
      $('sharp-hint').textContent = net
        ? 'Net — gardez cette distance'
        : (aCompare ? 'Éloignez ou rapprochez lentement le téléphone'
                    : 'Bougez lentement pour comparer les distances…');
    }, 200);
  }
  function arreterNettete() {
    clearInterval(netteteTimer);
    netteteTimer = 0;
    const m = $('sharp-meter');
    if (m) m.hidden = true;
  }

  async function autofocusSweep() {
    if (sweepEnCours || !autofocusSupporte()) return false;
    sweepEnCours = true;
    const { min, max } = caps.focusDistance;
    const pas = 8;
    const mesures = [];
    let meilleur = { note: -1, distance: min };
    try {
      for (let i = 0; i < pas; i++) {
        const distance = min + (max - min) * (i / (pas - 1));
        const etat = await appliquerDistance(distance);
        await attendreImage(320);        // une vraie optique met ~300 ms à se poser
        const note = sharpness();
        mesures.push({ d: distance, a: etat.applique, n: note });
        if (note > meilleur.note) meilleur = { note, distance };
      }
      await appliquerDistance(meilleur.distance);

      // L'appareil a-t-il vraiment suivi ? Deux signes : la distance appliquée
      // change d'un pas à l'autre, et la netteté varie. Si les deux sont plats,
      // le réglage est ignoré et il faut le dire plutôt que prétendre l'inverse.
      const distancesAppliquees = new Set(mesures.map((m) => (m.a == null ? 'n/d' : m.a.toFixed(3))));
      const notes = mesures.map((m) => m.n);
      const ecart = Math.max(...notes) / Math.max(1, Math.min(...notes));
      const suivi = distancesAppliquees.size > 1 || ecart > 1.15;

      derniereMiseAuPoint = meilleur.distance.toFixed(2);
      rapportMiseAuPoint = suivi
        ? `${derniereMiseAuPoint} (netteté ×${ecart.toFixed(2)})`
        : `IGNORÉ par l'appareil (netteté plate ×${ecart.toFixed(2)})`;
      return suivi;
    } catch (e) {
      noteIncident('Mise au point', e);
      rapportMiseAuPoint = 'erreur : ' + e.message;
      return false;
    } finally {
      sweepEnCours = false;
    }
  }
  let derniereMiseAuPoint = null;

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
    const continu = caps.focusMode?.includes('continuous');
    if (!single && !continu) return void autofocusSweep();   // autofocus fabriqué

    try {
      await track.applyConstraints({
        advanced: [{ pointsOfInterest: [{ x: p.x, y: p.y }], focusMode: single ? 'single-shot' : 'continuous' }]
      });
    } catch (e) { noteIncident('Mise au point', e); }
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
  // Le détecteur vit dans angle-worker.js. Le faire tourner ici imposait un
  // getImageData synchrone à 9 Hz, qui bloque le compositeur : c'était la cause
  // des à-coups de la rotation.
  let worker = null, workerBusy = false, workerSeq = 0;
  let estimatorCanvas = null, estimatorCtx = null;

  function startWorker() {
    try {
      worker = new Worker('angle-worker.js');
      worker.onmessage = (e) => {
        workerBusy = false;
        if (e.data.angle === null) { setLock(false, 'Cherche un livre…'); return; }
        targetAngle = e.data.angle;
        setLock(true, null);
      };
      worker.onerror = () => { worker = null; };
    } catch { worker = null; }
  }

  async function estimateAngle() {
    if (!worker || workerBusy) return;
    const g = roiGeometry(video.videoWidth, video.videoHeight);
    if (!g) return;
    const W = ANALYSIS_W, H = Math.max(8, Math.round(g.sh / g.sw * ANALYSIS_W));
    workerBusy = true;
    const id = ++workerSeq;

    // createImageBitmap redimensionne hors du thread principal et le résultat
    // est transférable : rien ne transite par le CPU côté page.
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(video, g.sx, g.sy, g.sw, g.sh,
          { resizeWidth: W, resizeHeight: H, resizeQuality: 'low' });
        worker.postMessage({ id, bitmap }, [bitmap]);
        return;
      } catch { /* Safari ancien : repli ci-dessous */ }
    }

    if (!estimatorCanvas) {
      estimatorCanvas = document.createElement('canvas');
      estimatorCtx = estimatorCanvas.getContext('2d', { willReadFrequently: true });
    }
    estimatorCanvas.width = W; estimatorCanvas.height = H;
    estimatorCtx.drawImage(video, g.sx, g.sy, g.sw, g.sh, 0, 0, W, H);
    const data = estimatorCtx.getImageData(0, 0, W, H).data;
    worker.postMessage({ id, data: data.buffer, width: W, height: H }, [data.buffer]);
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

    fps.frames++;
    if (performance.now() - fps.since >= 1000) {
      fps.value = fps.frames;
      fps.frames = 0; fps.since = performance.now();
    }

    const now = performance.now();
    if (!frozen && !scanMode && useAuto && now - lastEstimate > EST_PERIOD) {
      lastEstimate = now;
      estimateAngle();          // asynchrone : la boucle n'attend pas
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

    const pad = 1.2;   // marge pour ne pas rogner les coins après rotation
    const fullW = g.sw * pad, fullH = g.sh * pad;
    // Mesuré : une capture de 3,5 Mpx met Tesseract à genoux, plusieurs secondes
    // ici et bien davantage sur téléphone, sans rien lire de plus. L'étirement de
    // contraste qui suit coûte lui aussi proportionnellement au nombre de pixels,
    // et sur le thread principal.
    const shrink = Math.min(1,
      OCR_MAX_WIDTH / fullW,
      Math.sqrt(OCR_MAX_PIXELS / (fullW * fullH)));

    const out = document.createElement('canvas');
    out.width = Math.round(fullW * shrink);
    out.height = Math.round(fullH * shrink);
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.width, out.height);
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(currentAngle() * Math.PI / 180);
    ctx.scale(shrink, shrink);
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
    // Un code-barres se lit de près : on refait la mise au point sur le cadre.
    // Sur les appareils sans autofocus, le balayage doit finir avant de décoder,
    // sinon on analyse des images floues pendant toute sa durée.
    if (autofocusSupporte() && !caps.focusMode?.includes('continuous')) {
      $('scan-msg').textContent = 'Mise au point…';
      const pilote = await autofocusSweep();
      $('scan-msg').textContent = pilote
        ? 'Visez le code-barres au dos du livre…'
        : 'Cet appareil ne règle pas la mise au point : ajustez la distance';
      if (!pilote) demarrerNettete();
    } else if (!caps.focusMode?.includes('continuous')) {
      // Ni autofocus, ni distance réglable : la distance est le seul recours.
      demarrerNettete();
    } else {
      focusAt(window.innerWidth / 2, window.innerHeight / 2);
    }
    let timer = 0;
    try {
      const decode = await pickDecoder();
      lastDecoder = decode.moteur;
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
    arreterNettete();
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
    scanCanvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
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
    fullCanvas.getContext('2d').drawImage(video, 0, 0, fullCanvas.width, fullCanvas.height);
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
    // BarcodeDetector est natif et reste le plus tolérant au flou : mesuré, il
    // lit encore à 1,8 px de flou là où zxing-wasm s'arrête vers 1,0.
    if ('BarcodeDetector' in window) {
      const wanted = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
      const supported = await window.BarcodeDetector.getSupportedFormats().catch(() => []);
      const formats = wanted.filter((f) => supported.includes(f));
      if (formats.length) {
        const detector = new window.BarcodeDetector({ formats });
        return {
          moteur: 'BarcodeDetector',
          decode: async (src) => (await detector.detect(src))[0]?.rawValue,
          maxWidth: Infinity
        };
      }
    }
    // Safari n'a pas BarcodeDetector : c'est ce chemin que prennent les iPhone.
    const { readBarcodes } = await import(CDN_ZXING_WASM);
    const options = {
      formats: ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E'],
      tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 1
    };
    return {
      moteur: 'zxing-wasm',
      decode: async (src) => {
        const ctx = src.getContext('2d', { willReadFrequently: true });
        const image = ctx.getImageData(0, 0, src.width, src.height);
        const found = await readBarcodes(image, options);
        return found.length ? found[0].text : undefined;
      },
      maxWidth: 1600
    };
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
      if (autofocusSupporte() && !caps.focusMode?.includes('continuous')) {
        showLoading('Mise au point…');
        await autofocusSweep();
      }
      const shot = captureUpright();
      if (!shot) throw new Error('frame');
      lastShot = shot;      // visible dans le diagnostic : « voici ce que l'OCR a vu »
      if (!window.Tesseract) {
        showLoading('Téléchargement du moteur OCR (première fois)…');
        await loadScript(CDN_TESSERACT);
      }
      if (!ocrWorker) {
        showLoading('Chargement des dictionnaires FR + EN…');
        // Sans compte-rendu de progression, la lecture passe pour un plantage :
        // elle prend plusieurs secondes, davantage sur un téléphone.
        ocrWorker = await window.Tesseract.createWorker('fra+eng', 1, {
          logger: (m) => {
            if (m.status !== 'recognizing text') return;
            showLoading(`Lecture du titre… ${Math.round((m.progress || 0) * 100)} %`);
          }
        });
      }
      showLoading('Lecture du titre… 0 %');
      const { data } = await ocrWorker.recognize(shot);
      lastOcrText = (data.text || '').replace(/\s+/g, ' ').trim();
      const title = pickTitle(data);
      if (!title) {
        // Montrer ce qui a été lu vaut mieux qu'un « illisible » opaque :
        // souvent le texte est là mais trop peu sûr pour servir de titre.
        return showError(lastOcrText
          ? `Titre non reconnu. Lu : « ${lastOcrText.slice(0, 80)} ». Figez l'image et rapprochez-vous.`
          : "Aucun texte détecté. Figez l'image, rapprochez-vous, puis réessayez.",
          { text: lastOcrText });
      }
      showLoading(`Recherche « ${title} »…`);
      const book = await byQuery(title);
      if (book) renderBook({ ...book, isbn: book.isbn || '' });
      else showError(`Aucune correspondance pour « ${title} » dans les catalogues.`, { text: title });
    } catch (err) {
      showError(/CDN|Failed|import/.test(String(err.message))
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
    })).filter((l) => l.conf > 35 && /[A-Za-zÀ-ÿ]{3}/.test(l.text));
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

  /* Un catch vide transforme une faute de programmation en panne muette : une
     ReferenceError dans la chaîne de recherche faisait silencieusement tomber
     l'app sur la source suivante. On garde toujours la trace, visible dans le
     diagnostic. */
  function noteIncident(source, err) {
    const msg = `${source} : ${err?.message || err}`;
    window.__librisIncidents = (window.__librisIncidents || []).slice(-4).concat(msg);
    // Une erreur de code n'est pas une panne réseau : elle doit remonter.
    if (err instanceof ReferenceError || err instanceof TypeError) {
      window.__librisLastError = msg;
    }
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
      else showError(
        q.isbn ? `Aucun livre pour l'ISBN ${q.isbn} dans les catalogues.`
               : 'Aucune correspondance dans les catalogues.',
        { isbn: q.isbn, text: q.text });
    } catch { showError('Erreur réseau.', { isbn: q.isbn, text: q.text }); }
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
      const j = await r.json();
      if (j.items?.length) return mapG(j.items[0]);
      // Le quota anonyme de Google Books est par adresse IP et souvent épuisé :
      // un 429 n'est pas une exception, il faut le repérer explicitement.
      if (j.error) noteIncident('Google Books', { message: `${j.error.code} quota` });
    } catch (e) { noteIncident('Google Books', e); }
    try {
      const r = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(text)}&limit=1`);
      const j = await r.json();
      if (j.docs?.length) return await mapOLSearch(j.docs[0]);
    } catch (e) { noteIncident('Open Library', e); }
    return byBnf(text);
  }

  async function mapOLSearch(d) {
    let synopsis = 'Synopsis non disponible.';
    try {
      const r = await fetch(`https://openlibrary.org${d.key}.json`);
      const w = await r.json();
      const desc = typeof w.description === 'string' ? w.description : w.description?.value;
      if (desc) synopsis = desc;
    } catch { /* pas de résumé, le reste de la fiche suffit */ }
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

  /* Catalogue de la Bibliothèque nationale de France. Gratuit, sans clé, et
     bien plus complet que Google Books ou Open Library sur le fonds français —
     ce qui compte ici, l'OCR lisant surtout des titres en français.
     Son index ISBN ne répond pas, d'où l'usage en recherche titre seule. */
  async function byBnf(text) {
    try {
      const query = `bib.title all "${text.replace(/"/g, '')}"`;
      const url = 'https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve'
        + `&query=${encodeURIComponent(query)}&recordSchema=dublincore&maximumRecords=1`;
      const xml = await (await fetch(url)).text();
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const champ = (nom) => {
        for (const el of doc.getElementsByTagName('*')) {
          if (el.localName === nom && el.textContent.trim()) return el.textContent.trim();
        }
        return '';
      };
      const title = champ('title');
      if (!title) return null;
      return {
        title: title.split(' / ')[0].slice(0, 300),
        author: (champ('creator') || 'Auteur inconnu').slice(0, 200),
        rating: null,
        year: (champ('date') || '').match(/\d{4}/)?.[0],
        pages: null,
        cover: '',
        synopsis: champ('description') || 'Synopsis non disponible — fiche BnF.'
      };
    } catch (e) { noteIncident('BnF', e); return null; }
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
    renderLinks($('book-links'), { isbn: b.isbn, text: `${b.title} ${b.author}` });
  }
  function showLoading(m) {
    $('book').hidden = true; $('book-error').hidden = true;
    $('loading-msg').textContent = m; $('sheet-loading').hidden = false;
  }
  function showError(m, recherche) {
    $('sheet-loading').hidden = true; $('book').hidden = true;
    $('book-error').hidden = false; $('book-error-msg').textContent = m;
    renderLinks($('error-links'), recherche || {});
  }
  /* Cultura et Babelio refusent les requêtes d'un navigateur tiers (CORS), et
     l'API d'Amazon exige un compte partenaire et une clé secrète, impossible à
     employer depuis une page web. Le seul pont honnête est donc un lien de
     recherche que l'utilisateur ouvre lui-même. Il est proposé dans tous les
     cas, y compris en échec : c'est souvent là qu'il sert le plus. */
  function renderLinks(container, { isbn, text }) {
    const terme = (isbn || text || '').trim();
    container.textContent = '';
    if (!terme) { container.hidden = true; return; }
    container.hidden = false;
    const cibles = [
      ['Cultura', `https://www.cultura.com/search?q=${encodeURIComponent(terme)}`],
      ['Amazon', `https://www.amazon.fr/s?k=${encodeURIComponent(terme)}`],
      ['Babelio', `https://www.babelio.com/resrecherche.php?Recherche=${encodeURIComponent(terme)}`],
      ['Google', `https://www.google.com/search?q=${encodeURIComponent(terme + ' livre')}`]
    ];
    for (const [nom, url] of cibles) {
      const a = document.createElement('a');
      a.className = 'shop-link';
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = nom;
      container.append(a);
    }
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

  // ---------- Diagnostic ----------
  // Sans cet écran, « ça ne marche pas » depuis un téléphone n'est pas
  // vérifiable : capacités caméra et moteur de décodage varient énormément
  // d'un appareil et d'un navigateur à l'autre.
  let fps = { frames: 0, since: performance.now(), value: 0 };
  let lastDecoder = '—';
  let lastShot = null;      // dernière image envoyée à l'OCR, montrée au diagnostic
  let lastOcrText = '';     // ce que l'OCR a réellement lu, même si on l'a rejeté

  async function openDiag() {
    closeDialog();
    const lines = [];
    const yes = (v) => (v ? 'oui' : 'non');

    lines.push(['Version', LIBRIS_VERSION]);
    lines.push(['Écran', `${window.innerWidth}×${window.innerHeight} @${DPR}x`]);
    lines.push(['Caméra', video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : 'non démarrée']);
    lines.push(['Affichage', `${fps.value} img/s`]);
    lines.push(['Détecteur d\'angle', worker ? 'worker actif' : 'indisponible']);
    lines.push(['Angle détecté', locked ? `${(-dispAngle).toFixed(1)}°` : 'pas de verrou']);

    const modes = caps.focusMode ? caps.focusMode.join(', ') : 'non réglable';
    lines.push(['Mise au point', autofocusSupporte() && !caps.focusMode?.includes('continuous')
      ? `${modes} → balayage auto${derniereMiseAuPoint ? ' (' + derniereMiseAuPoint + ')' : ''}`
      : modes]);
    lines.push(['Distance réglable', caps.focusDistance
      ? `${caps.focusDistance.min} – ${caps.focusDistance.max}` : 'non']);
    if (rapportMiseAuPoint) lines.push(['Dernier balayage', rapportMiseAuPoint]);
    lines.push(['Lampe', yes(!!caps.torch)]);
    lines.push(['Zoom optique', caps.zoom ? `${caps.zoom.min}–${caps.zoom.max}` : 'non']);

    let barcode = 'zxing-wasm (téléchargé à la demande)';
    if ('BarcodeDetector' in window) {
      const f = await window.BarcodeDetector.getSupportedFormats().catch(() => []);
      barcode = f.length ? `BarcodeDetector : ${f.filter((x) => /ean|upc/.test(x)).join(', ') || 'aucun format livre'}`
                         : 'BarcodeDetector présent mais sans format';
    }
    lines.push(['Code-barres', barcode]);
    lines.push(['Dernier scan', lastDecoder]);
    lines.push(['OCR', window.Tesseract ? 'moteur chargé' : 'pas encore téléchargé']);
    if (lastOcrText) lines.push(['Dernier texte lu', lastOcrText.slice(0, 120)]);
    lines.push(['Historique', window.LibrisHistory?.isSynced() ? 'synchronisé' : 'local seulement']);
    lines.push(['Installée', window.matchMedia('(display-mode: standalone)').matches ? 'oui' : 'non (onglet)']);
    lines.push(['Dernière erreur', window.__librisLastError || 'aucune']);
    const inc = window.__librisIncidents || [];
    if (inc.length) lines.push(['Sources en échec', inc.join(' · ').slice(0, 160)]);

    const ul = $('diag-list');
    ul.textContent = '';
    for (const [k, v] of lines) {
      const li = document.createElement('li');
      const dt = document.createElement('span'); dt.className = 'k'; dt.textContent = k;
      const dd = document.createElement('span'); dd.className = 'v'; dd.textContent = v;
      li.append(dt, dd); ul.append(li);
    }
    const preview = $('diag-shot');
    if (lastShot) {
      preview.hidden = false;
      $('diag-shot-img').src = lastShot.toDataURL('image/jpeg', 0.7);
      $('diag-shot-size').textContent = `${lastShot.width}×${lastShot.height}`;
    } else {
      preview.hidden = true;
    }

    const sheet = $('diag-sheet');
    sheet.classList.add('open', 'full');
    sheet.setAttribute('aria-hidden', 'false');
  }
  function closeDiag() {
    const sheet = $('diag-sheet');
    sheet.classList.remove('open', 'full');
    sheet.setAttribute('aria-hidden', 'true');
  }
  // Un service worker peut servir une version périmée : ce bouton coupe court.
  async function forceUpdate() {
    $('diag-refresh').textContent = 'Nettoyage…';
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch { /* on recharge quand même */ }
    location.reload();
  }

  function copyDiag() {
    const txt = [...$('diag-list').children]
      .map((li) => `${li.querySelector('.k').textContent} : ${li.querySelector('.v').textContent}`)
      .join('\n');
    navigator.clipboard?.writeText(txt).then(
      () => { $('diag-copy').textContent = 'Copié ✓'; },
      () => { $('diag-copy').textContent = 'Copie refusée'; }
    );
  }

  /* Autotest des lecteurs, sans caméra.

     Une image de test est fabriquée dans l'app puis passée aux mêmes décodeurs
     que le scan réel. Cela sépare deux causes que l'utilisateur ne peut pas
     distinguer : un moteur indisponible sur son appareil, ou une image de
     caméra trop floue ou mal cadrée. */
  const EAN_L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
  const EAN_G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
  const EAN_R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
  const EAN_PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

  function eanBits(code) {
    const d = code.split('').map(Number);
    let bits = '101';
    const parity = EAN_PARITY[d[0]];
    for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'L' ? EAN_L : EAN_G)[d[i]];
    bits += '01010';
    for (let i = 7; i < 13; i++) bits += EAN_R[d[i]];
    return bits + '101';
  }

  function testBarcodeImage(code) {
    const bits = eanBits(code);
    const module = 3, w = bits.length * module, h = 150;
    const c = document.createElement('canvas');
    c.width = w + 80; c.height = h + 80;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#000000';
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] === '1') ctx.fillRect(40 + i * module, 40, module, h);
    }
    return c;
  }

  function testTextImage() {
    const c = document.createElement('canvas');
    c.width = 900; c.height = 400;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#000000'; ctx.textAlign = 'center';
    ctx.font = 'bold 90px Georgia, serif';
    ctx.fillText('LE ROUGE', c.width / 2, 150);
    ctx.fillText('ET LE NOIR', c.width / 2, 260);
    ctx.font = '48px Georgia, serif';
    ctx.fillText('Stendhal', c.width / 2, 340);
    return c;
  }

  async function runSelfTest() {
    const zone = $('diag-selftest');
    const bouton = $('diag-selftest-run');
    bouton.disabled = true;
    zone.hidden = false;

    const dire = (txt) => { zone.textContent = txt; };
    const CODE = '9782070368228';

    dire('Lecteur de code-barres…');
    let ligneCode;
    try {
      const t0 = performance.now();
      const decodeur = await pickDecoder();
      const lu = await decodeur.decode(testBarcodeImage(CODE));
      const ms = Math.round(performance.now() - t0);
      ligneCode = lu === CODE
        ? `Code-barres : OK (${decodeur.moteur}, ${ms} ms)`
        : `Code-barres : ÉCHEC — ${decodeur.moteur} a lu « ${lu || 'rien' } »`;
    } catch (e) {
      ligneCode = `Code-barres : ÉCHEC — ${e.message}`;
    }

    dire(ligneCode + '\nLecteur de titre… (téléchargement possible)');
    let ligneOcr;
    try {
      const t0 = performance.now();
      if (!window.Tesseract) await loadScript(CDN_TESSERACT);
      if (!ocrWorker) ocrWorker = await window.Tesseract.createWorker('fra+eng');
      const { data } = await ocrWorker.recognize(testTextImage());
      const lu = (data.text || '').replace(/\s+/g, ' ').trim();
      const ms = Math.round(performance.now() - t0);
      ligneOcr = /ROUGE/i.test(lu)
        ? `Titre : OK (${ms} ms) — « ${lu.slice(0, 40)} »`
        : `Titre : ÉCHEC — lu « ${lu.slice(0, 60) || 'rien'} »`;
    } catch (e) {
      ligneOcr = `Titre : ÉCHEC — ${e.message}`;
    }

    dire(`${ligneCode}\n${ligneOcr}\n\nSi ces deux lignes indiquent OK, les lecteurs fonctionnent sur cet appareil et c'est l'image de la caméra qu'il faut améliorer : rapprochez-vous, touchez l'écran pour faire le point, allumez la lampe.`);
    bouton.disabled = false;
  }

  // ---------- Dialogue infos ----------
  // Plus de <dialog>.showModal() : absent d'iOS Safari avant 15.4 et des
  // WebView Android anciennes, où l'appel levait une erreur et rendait le scan
  // ISBN comme l'OCR totalement inatteignables.
  function openDialog() {
    dismissSheet();
    const p = $('info-sheet');
    p.classList.add('open');
    p.setAttribute('aria-hidden', 'false');
  }
  function closeDialog() {
    const p = $('info-sheet');
    p.classList.remove('open', 'full');
    p.setAttribute('aria-hidden', 'true');
  }

  // Dans l'app native les fichiers sont déjà locaux : un service worker
  // n'apporterait rien et son cache ferait écran aux mises à jour de l'APK.
  const isNative = () => !!window.__LIBRIS_NATIVE__ || !!window.Capacitor?.isNativePlatform?.();
  function registerSW() {
    if (isNative() || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // Sans ceci, la page déjà ouverte continue de tourner sur l'ancienne
    // version et il faut recharger deux fois pour voir une mise à jour.
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
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
    $('btn-diag').addEventListener('click', openDiag);
    $('diag-close').addEventListener('click', closeDiag);
    $('diag-copy').addEventListener('click', copyDiag);
    $('diag-refresh').addEventListener('click', forceUpdate);
    $('diag-selftest-run').addEventListener('click', runSelfTest);
    $('manual-input').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); closeDialog(); lookupFromInput();
    });
    $('btn-manual-search').addEventListener('click', () => { closeDialog(); lookupFromInput(); });
    $('btn-info-close').addEventListener('click', closeDialog);
    $('info-handle').addEventListener('click', closeDialog);
    $('btn-history').addEventListener('click', openHistory);
    $('history-handle').addEventListener('click', closeHistory);
    $('btn-history-clear').addEventListener('click', () => {
      if (confirm('Effacer tout l\'historique des livres scannés ?')) window.LibrisHistory?.clear();
    });
    // history.js est un module : il s'exécute après ce script classique. Le
    // sondage précédent tournait indéfiniment si le module ne chargeait jamais.
    const bindHistory = () => window.LibrisHistory?.onChange(renderHistory);
    if (window.LibrisHistory) bindHistory();
    else window.addEventListener('librishistory:ready', bindHistory, { once: true });

    $('btn-start').addEventListener('click', startCamera);
    $('btn-retry').addEventListener('click', startCamera);
    window.addEventListener('resize', () => { applyTransform(); freezeDirty = true; });

    $('cam-gate').hidden = false;
    setTimeout(() => $('cv-status').classList.add('hide'), 4000);
    requestAnimationFrame(loop);
  }
  document.addEventListener('DOMContentLoaded', init);

  return { dismissSheet, lookup, scanBarcode, readTitle, openHistory, openDiag };
})();
