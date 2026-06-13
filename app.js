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

  // ---------- Détection d'angle (orientation des gradients, JS pur) ----------
  // Sobel → on histogramme l'orientation des contours quasi-horizontaux
  // (bords du livre + lignes de texte) et on prend le pic = inclinaison.
  function estimateAngle() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const W = 240, H = Math.max(1, Math.round(vh / vw * 240));
    work.width = W; work.height = H;
    const ctx = work.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;

    const g = new Float32Array(W * H);
    for (let i = 0, p = 0; i < data.length; i += 4, p++)
      g[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;

    const bins = new Float32Array(81);   // orientations -40°..+40°
    let count = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx = -g[i-1-W] - 2*g[i-1] - g[i-1+W] + g[i+1-W] + 2*g[i+1] + g[i+1+W];
        const gy = -g[i-W-1] - 2*g[i-W] - g[i-W+1] + g[i+W-1] + 2*g[i+W] + g[i+W+1];
        const mag = Math.hypot(gx, gy);
        if (mag < 70) continue;
        let ori = deg(Math.atan2(gy, gx)) + 90;      // orientation du contour
        if (ori > 90) ori -= 180; else if (ori < -90) ori += 180;
        if (ori >= -40 && ori <= 40) { bins[Math.round(ori) + 40] += mag; count++; }
      }
    }

    if (count < 120) { badge.textContent = 'Cherche un livre…'; badge.classList.remove('active'); return; }

    let peak = 40, best = 0;
    for (let b = 0; b < 81; b++) if (bins[b] > best) { best = bins[b]; peak = b; }
    let a = peak - 40;
    // interpolation parabolique (précision < 1°)
    const l = bins[peak-1] || 0, c = bins[peak], r = bins[peak+1] || 0, dn = l - 2*c + r;
    if (dn !== 0) a += 0.5 * (l - r) / dn;

    if (Math.abs(a - autoAngle) > 1.0) autoAngle += (a - autoAngle) * 0.25;   // lissage + zone morte
    badge.textContent = `Redressé · ${(-autoAngle).toFixed(0)}°`;
    badge.classList.add('active');
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

  function init() {
    setupSheet(); registerSW();
    cvReady = true;   // détection d'angle en JS pur, prête immédiatement
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
    setTimeout(() => $('cv-status').classList.add('hide'), 3000);
  }
  document.addEventListener('DOMContentLoaded', init);
  return { dismissSheet, lookup, scanISBN };
})();
