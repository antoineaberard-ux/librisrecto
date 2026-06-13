/* LibrisRecto — Redresseur de livre (PWA, iOS + Android)
   BUT PRINCIPAL : pointer un livre incliné → le titre s'affiche à l'horizontale,
   pour lire sans pencher la tête.
   Méthode (cahier des charges) : transformée de Hough (OpenCV.js) → angle d'inclinaison
   → rotation logicielle de l'image en temps réel. Bouton « Figer » + zoom pour lecture.
   Bonus secondaire : scan ISBN → synopsis (Open Library / Google Books). */

const LibrisRecto = (() => {
  const $ = (id) => document.getElementById(id);
  const video = $('video'), stage = $('stage'), work = $('work');
  const freezeCanvas = $('freeze'), badge = $('angle-badge');
  const sheet = $('sheet');

  let stream = null, cvReady = false;
  let autoAngle = 0;            // angle détecté (Hough), lissé
  let manualOffset = 0;        // réglage fin utilisateur
  let useAuto = true;
  let frozen = false, zoom = 1;
  let estTimer = 0;
  let zxing = null;

  const deg = (r) => r * 180 / Math.PI;

  // ---------- Caméra ----------
  async function startCamera() {
    $('cam-gate').hidden = true;
    if (!navigator.mediaDevices?.getUserMedia) return showNoCam("Caméra non supportée par ce navigateur.");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
      $('no-cam').hidden = true;
      loop();
    } catch (err) {
      const denied = /NotAllowed|Permission/i.test(String(err));
      showNoCam(denied ? "Caméra refusée. Autorisez-la puis réessayez." : "Caméra inaccessible.");
    }
  }
  function showNoCam(msg) { $('no-cam-msg').textContent = msg; $('no-cam').hidden = false; }

  // ---------- Boucle d'affichage ----------
  function loop() {
    if (!frozen) {
      const now = performance.now();
      if (cvReady && now - estTimer > 140) {   // estimation Hough ~7 fps (économe)
        estTimer = now;
        try { estimateAngle(); } catch (e) { /* frame non prête */ }
      }
      applyTransform();
    }
    requestAnimationFrame(loop);
  }

  // ---------- Détection d'angle (Hough) ----------
  function estimateAngle() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const W = 360, H = Math.round(vh / vw * 360);
    work.width = W; work.height = H;
    const ctx = work.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, W, H);

    const src = cv.imread(work);
    const gray = new cv.Mat(), edges = new cv.Mat(), lines = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.Canny(gray, edges, 60, 160, 3, false);
    // lignes ~horizontales (bords du livre / lignes de texte)
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 60, Math.max(40, W * 0.18), 12);

    const angles = [];
    for (let i = 0; i < lines.rows; i++) {
      const x1 = lines.data32S[i*4], y1 = lines.data32S[i*4+1];
      const x2 = lines.data32S[i*4+2], y2 = lines.data32S[i*4+3];
      let a = deg(Math.atan2(y2 - y1, x2 - x1));   // [-180,180]
      // ramène vers l'horizontale [-90,90]
      if (a > 90) a -= 180; else if (a < -90) a += 180;
      if (Math.abs(a) <= 40) angles.push(a);        // ne garde que le quasi-horizontal
    }
    src.delete(); gray.delete(); edges.delete(); lines.delete();

    if (angles.length >= 3) {
      angles.sort((p, q) => p - q);
      const median = angles[Math.floor(angles.length / 2)];
      // lissage fort + zone morte (évite l'image qui tremble)
      if (Math.abs(median - autoAngle) > 1.2) autoAngle += (median - autoAngle) * 0.25;
      badge.textContent = `Redressé · ${(-autoAngle).toFixed(0)}°`;
      badge.classList.add('active');
    } else {
      badge.textContent = 'Cherche un livre…';
      badge.classList.remove('active');
    }
  }

  // ---------- Application de la rotation ----------
  function applyTransform() {
    const angle = (useAuto ? -autoAngle : 0) + manualOffset;   // degrés à appliquer
    const s = coverScale(angle) * zoom;
    stage.style.transform = `rotate(${angle}deg) scale(${s})`;
  }
  // échelle pour qu'aucun coin vide n'apparaisse après rotation
  function coverScale(angleDeg) {
    const r = Math.abs(angleDeg) * Math.PI / 180;
    const W = window.innerWidth, H = window.innerHeight;
    const s1 = (W * Math.abs(Math.cos(r)) + H * Math.abs(Math.sin(r))) / W;
    const s2 = (W * Math.abs(Math.sin(r)) + H * Math.abs(Math.cos(r))) / H;
    return Math.max(s1, s2);
  }

  // ---------- Figer / Reprendre ----------
  function toggleFreeze() {
    if (!frozen) freeze(); else unfreeze();
  }
  function freeze() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const angle = ((useAuto ? -autoAngle : 0) + manualOffset) * Math.PI / 180;
    // dessine la frame déjà redressée dans le canvas (image nette et droite)
    const cw = window.innerWidth, ch = window.innerHeight;
    freezeCanvas.width = cw; freezeCanvas.height = ch;
    const ctx = freezeCanvas.getContext('2d');
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(angle);
    const s = coverScale(angle * 180 / Math.PI) * zoom;
    // cover : on étire la vidéo pour couvrir l'écran
    const scale = Math.max(cw / vw, ch / vh) * s;
    ctx.drawImage(video, -vw * scale / 2, -vh * scale / 2, vw * scale, vh * scale);
    ctx.restore();
    freezeCanvas.hidden = false;
    frozen = true;
    $('btn-freeze').innerHTML = '▶ Reprendre';
    $('zoom-row').hidden = false;
    haptic(15);
  }
  function unfreeze() {
    frozen = false; freezeCanvas.hidden = true;
    $('btn-freeze').innerHTML = '⏸ Figer';
    $('zoom-row').hidden = true; zoom = 1; $('zoom').value = 1;
    applyTransform(); loopGuard();
  }
  function loopGuard() { /* la boucle tourne déjà via rAF */ }
  function haptic(p) { if (navigator.vibrate) navigator.vibrate(p); }

  // ---------- OpenCV ----------
  async function waitForCV() {
    for (let i = 0; i < 240; i++) {
      if (window.cv) {
        if (typeof cv.then === 'function') { try { window.cv = await cv; } catch {} }
        if (cv.Mat) return true;
        if (typeof cv.onRuntimeInitialized !== 'undefined' && !cv.Mat) {
          await new Promise(r => { cv.onRuntimeInitialized = r; setTimeout(r, 4000); });
          if (cv.Mat) return true;
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  }

  // ---------- Synopsis (secondaire) ----------
  async function scanISBN() {
    if (!window.ZXing) return openManualSearch('ISBN…');
    try {
      if (!zxing) zxing = new ZXing.BrowserMultiFormatReader();
      $('info-dialog').close();
      openSheet(); showLoading('Visez le code-barres ISBN…');
      const result = await new Promise((resolve, reject) => {
        const to = setTimeout(() => { try { zxing.reset(); } catch {} reject(new Error('timeout')); }, 12000);
        zxing.decodeFromVideoElement(video, (res) => {
          if (res) { clearTimeout(to); try { zxing.reset(); } catch {} resolve(res.getText()); }
        }).catch(reject);
      });
      const isbn = result.replace(/[^0-9Xx]/g, '');
      lookup({ isbn });
    } catch { showError("Code-barres non détecté. Essayez la saisie manuelle."); }
  }
  function openManualSearch() { lookupFromInput(); }
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
      else showError(q.isbn ? `Aucun livre pour l'ISBN ${q.isbn}.` : `Aucune correspondance.`);
    } catch { showError('Erreur réseau.'); }
  }
  async function byISBN(isbn) {
    try { const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
      const j = await r.json(); const d = j[`ISBN:${isbn}`]; if (d) return mapOL(d, isbn); } catch {}
    try { const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
      const j = await r.json(); if (j.items?.length) return mapG(j.items[0]); } catch {}
    return null;
  }
  async function byQuery(text) {
    try { const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(text)}&maxResults=1`);
      const j = await r.json(); if (j.items?.length) return mapG(j.items[0]); } catch {}
    return null;
  }
  function mapOL(d, isbn) { return { title: d.title || 'Sans titre',
    author: (d.authors || []).map(a => a.name).join(', ') || 'Auteur inconnu', rating: null,
    year: (d.publish_date || '').match(/\d{4}/)?.[0], pages: d.number_of_pages,
    cover: d.cover?.medium || (isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg` : ''),
    synopsis: typeof d.notes === 'string' ? d.notes : d.excerpts?.[0]?.text || 'Synopsis non disponible.' }; }
  function mapG(item) { const v = item.volumeInfo || {}; return {
    title: v.title + (v.subtitle ? ` — ${v.subtitle}` : ''), author: (v.authors || []).join(', ') || 'Auteur inconnu',
    rating: v.averageRating || null, year: (v.publishedDate || '').match(/\d{4}/)?.[0], pages: v.pageCount,
    cover: (v.imageLinks?.thumbnail || '').replace('http:', 'https:'),
    synopsis: v.description || 'Synopsis non disponible.' }; }

  function renderBook(b) {
    $('sheet-loading').hidden = true; $('book-error').hidden = true; $('book').hidden = false;
    $('book-title').textContent = b.title; $('book-author').textContent = b.author;
    const c = $('book-cover'); if (b.cover) { c.src = b.cover; c.style.visibility = 'visible'; } else c.style.visibility = 'hidden';
    $('book-rating').textContent = b.rating ? '★'.repeat(Math.round(b.rating)) + '☆'.repeat(5 - Math.round(b.rating)) : '';
    $('book-extra').textContent = [b.year, b.pages ? `${b.pages} pages` : null].filter(Boolean).join(' · ');
    $('book-synopsis').textContent = b.synopsis;
  }
  function showLoading(m) { $('book').hidden = true; $('book-error').hidden = true; $('loading-msg').textContent = m; $('sheet-loading').hidden = false; }
  function showError(m) { $('sheet-loading').hidden = true; $('book').hidden = true; $('book-error').hidden = false; $('book-error-msg').textContent = m; }

  function openSheet() { sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false'); }
  function dismissSheet() { sheet.classList.remove('open', 'full'); sheet.setAttribute('aria-hidden', 'true'); }
  function setupSheet() {
    const h = $('sheet-handle'); let y0 = 0, drag = false;
    const s = y => { y0 = y; drag = true; }, m = y => { if (!drag) return; const dy = y - y0;
      if (dy < -40) { sheet.classList.add('full'); drag = false; } else if (dy > 60) { dismissSheet(); drag = false; } }, e = () => drag = false;
    h.addEventListener('touchstart', ev => s(ev.touches[0].clientY), { passive: true });
    h.addEventListener('touchmove', ev => m(ev.touches[0].clientY), { passive: true });
    h.addEventListener('touchend', e);
    h.addEventListener('click', () => sheet.classList.toggle('full'));
  }

  function registerSW() { if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {}); }
  function needsGesture() { return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }

  async function init() {
    setupSheet(); registerSW();
    $('rotate-fine').addEventListener('input', e => { manualOffset = +e.target.value; useAuto = false; badge.textContent = `Manuel · ${(-manualOffset).toFixed(0)}°`; });
    $('btn-reset').addEventListener('click', () => { useAuto = true; manualOffset = 0; $('rotate-fine').value = 0; });
    $('zoom').addEventListener('input', e => { zoom = +e.target.value; if (frozen) freeze(); else applyTransform(); });
    $('btn-freeze').addEventListener('click', toggleFreeze);
    $('btn-info').addEventListener('click', () => $('info-dialog').showModal());
    $('btn-scan-isbn').addEventListener('click', scanISBN);
    $('info-form').addEventListener('submit', () => { const dlg = $('info-dialog'); setTimeout(() => { if (dlg.returnValue !== 'cancel') lookupFromInput(); }, 0); });
    $('btn-start').addEventListener('click', startCamera);
    $('btn-retry').addEventListener('click', startCamera);
    window.addEventListener('resize', applyTransform);

    if (needsGesture()) $('cam-gate').hidden = false; else startCamera();

    cvReady = await waitForCV();
    $('cv-status').textContent = cvReady ? '' : 'Redressement auto indisponible — utilisez le réglage manuel ↻';
    if (cvReady) $('cv-status').classList.add('hide');
    else setTimeout(() => $('cv-status').classList.add('hide'), 4000);
  }
  document.addEventListener('DOMContentLoaded', init);
  return { dismissSheet, lookup, scanISBN };
})();
