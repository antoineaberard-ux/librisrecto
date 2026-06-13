/* LibrisRecto — PWA (iOS + Android)
   Pipeline navigateur :
     Étape 1-2  caméra (ZXing gère le flux, multi-navigateurs dont Safari iOS)
     Étape 3    ISBN code-barres (ZXing)  ·  ou OCR titre (Tesseract.js)
     Étape 4    API Open Library / Google Books
     Étape 5    rendu bottom sheet
   La rectification 3D temps-réel (homographie/dewarping/CLAHE) du cahier des charges
   reste prévue en natif (v3) ; ici un prétraitement contraste léger précède l'OCR. */

const LibrisRecto = (() => {
  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const reticle = $('reticle');
  const hint = $('hint');
  const sheet = $('sheet');

  let reader = null;            // ZXing BrowserMultiFormatReader
  let controls = null;          // contrôle du flux ZXing (stop)
  let locked = false;
  let lastCode = null, lockTimer = null;
  let ocrBusy = false;

  const isISBN = (v) => v.length === 13 || v.length === 10;

  // ---------- Démarrage caméra ----------
  async function startScan() {
    $('cam-gate').hidden = true;
    if (!window.ZXing || !navigator.mediaDevices?.getUserMedia) {
      return showNoCam("Ce navigateur ne supporte pas la caméra web.");
    }
    try {
      if (!reader) reader = new ZXing.BrowserMultiFormatReader();
      // ZXing ouvre le flux (facingMode arrière) et décode en continu.
      controls = await reader.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' } } },
        video,
        (result, err) => {
          if (result && !locked) {
            const code = result.getText().replace(/[^0-9Xx]/g, '');
            if (isISBN(code)) onLock(code);
          }
        }
      );
    } catch (err) {
      console.warn('Caméra:', err);
      const denied = /NotAllowed|Permission/i.test(String(err));
      showNoCam(denied ? "Caméra refusée. Autorisez-la dans les réglages du navigateur." : "Caméra inaccessible.");
    }
  }

  function showNoCam(msg) { $('no-cam-msg').textContent = msg || ''; $('no-cam').hidden = false; }

  // Verrouillage : stabilité 500ms avant de figer (cahier des charges)
  function onLock(code) {
    if (locked) return;
    if (code !== lastCode) {
      lastCode = code;
      clearTimeout(lockTimer);
      lockTimer = setTimeout(() => confirmLock(code), 500);
    }
  }
  function confirmLock(code) {
    locked = true;
    reticle.classList.add('locked');
    haptic([18, 40, 18]);
    hint.textContent = 'Livre détecté ✓';
    lookup({ isbn: code });
  }
  function haptic(p) { if (navigator.vibrate) navigator.vibrate(p); }

  // ---------- OCR titre (Tesseract) ----------
  async function scanTitle() {
    if (ocrBusy || !window.Tesseract) {
      if (!window.Tesseract) showNoCam("OCR non chargé (connexion requise).");
      return;
    }
    if (video.readyState < 2) return;
    ocrBusy = true; locked = true;
    haptic(12);
    openSheet(); showLoading('Lecture du titre (OCR)…');
    try {
      const canvas = $('frame');
      const vw = video.videoWidth, vh = video.videoHeight;
      // crop central (zone réticule) + prétraitement contraste (proxy CLAHE)
      const cw = Math.round(vw * 0.7), ch = Math.round(vh * 0.55);
      const cx = (vw - cw) / 2, cy = (vh - ch) / 2;
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, cx, cy, cw, ch, 0, 0, cw, ch);
      preprocess(ctx, cw, ch);
      const { data } = await Tesseract.recognize(canvas, 'fra+eng');
      const lines = (data.text || '').split('\n').map(s => s.trim())
        .filter(s => s.length >= 3 && /[a-zA-ZÀ-ÿ]/.test(s));
      lines.sort((a, b) => b.length - a.length);
      const query = lines.slice(0, 2).join(' ').slice(0, 80);
      if (query) lookup({ text: query });
      else showError("Texte illisible. Rapprochez-vous du titre.");
    } catch (e) {
      console.error(e); showError("Échec de l'OCR.");
    } finally { ocrBusy = false; }
  }

  // niveaux de gris + renforcement de contraste local (léger, façon CLAHE)
  function preprocess(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h), d = img.data;
    let min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114) | 0;
      d[i] = d[i+1] = d[i+2] = g;
      if (g < min) min = g; if (g > max) max = g;
    }
    const range = Math.max(1, max - min);
    for (let i = 0; i < d.length; i += 4) {
      const v = ((d[i] - min) / range) * 255;
      const c = v < 128 ? v * 0.8 : 255 - (255 - v) * 0.8; // accentue le contraste
      d[i] = d[i+1] = d[i+2] = c;
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---------- API métadonnées ----------
  async function lookup(q) {
    openSheet(); showLoading('Recherche du livre…');
    try {
      const book = q.isbn ? await byISBN(q.isbn) : await byQuery(q.text);
      if (book) renderBook(book);
      else showError(q.isbn ? `Aucun livre pour l'ISBN ${q.isbn}.` : `Aucune correspondance pour « ${q.text} ».`);
    } catch (e) { console.error(e); showError('Erreur réseau. Vérifiez la connexion.'); }
  }
  async function byISBN(isbn) {
    try {
      const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
      const j = await r.json(); const d = j[`ISBN:${isbn}`];
      if (d) return mapOpenLibrary(d, isbn);
    } catch {}
    try {
      const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
      const j = await r.json(); if (j.items?.length) return mapGoogle(j.items[0]);
    } catch {}
    return null;
  }
  async function byQuery(text) {
    try {
      const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(text)}&maxResults=1`);
      const j = await r.json(); if (j.items?.length) return mapGoogle(j.items[0]);
    } catch {}
    try {
      const r = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(text)}&limit=1`);
      const j = await r.json(); const doc = j.docs?.[0];
      if (doc) return { title: doc.title, author: (doc.author_name || []).join(', '), rating: null,
        year: doc.first_publish_year, cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : '',
        synopsis: 'Synopsis non disponible pour ce titre.' };
    } catch {}
    return null;
  }
  function mapOpenLibrary(d, isbn) {
    return { title: d.title || 'Sans titre',
      author: (d.authors || []).map(a => a.name).join(', ') || 'Auteur inconnu', rating: null,
      year: (d.publish_date || '').match(/\d{4}/)?.[0], pages: d.number_of_pages,
      cover: d.cover?.medium || (isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg` : ''),
      synopsis: typeof d.notes === 'string' ? d.notes
        : d.excerpts?.[0]?.text || 'Synopsis non fourni par Open Library — essayez « Scanner le titre ».' };
  }
  function mapGoogle(item) {
    const v = item.volumeInfo || {};
    return { title: v.title + (v.subtitle ? ` — ${v.subtitle}` : ''),
      author: (v.authors || []).join(', ') || 'Auteur inconnu', rating: v.averageRating || null,
      year: (v.publishedDate || '').match(/\d{4}/)?.[0], pages: v.pageCount,
      cover: (v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || '').replace('http:', 'https:'),
      synopsis: v.description || 'Synopsis non disponible.' };
  }

  // ---------- Rendu ----------
  function renderBook(b) {
    $('sheet-loading').hidden = true; $('book-error').hidden = true;
    $('book').hidden = false;
    $('book-title').textContent = b.title;
    $('book-author').textContent = b.author;
    const cover = $('book-cover');
    if (b.cover) { cover.src = b.cover; cover.style.visibility = 'visible'; } else cover.style.visibility = 'hidden';
    $('book-rating').textContent = b.rating ? '★'.repeat(Math.round(b.rating)) + '☆'.repeat(5 - Math.round(b.rating)) : '';
    $('book-extra').textContent = [b.year, b.pages ? `${b.pages} pages` : null].filter(Boolean).join(' · ');
    $('book-synopsis').textContent = b.synopsis;
  }
  function showLoading(msg) { $('book').hidden = true; $('book-error').hidden = true;
    $('loading-msg').textContent = msg || 'Recherche…'; $('sheet-loading').hidden = false; }
  function showError(msg) { $('sheet-loading').hidden = true; $('book').hidden = true;
    $('book-error').hidden = false; $('book-error-msg').textContent = msg; }

  // ---------- Bottom sheet ----------
  function openSheet() { sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false'); }
  function dismissSheet() {
    sheet.classList.remove('open', 'full'); sheet.setAttribute('aria-hidden', 'true');
    locked = false; lastCode = null; clearTimeout(lockTimer);
    reticle.classList.remove('locked');
    hint.textContent = 'Pointez le code-barres (dos du livre) dans le cadre';
  }
  function setupSheetGestures() {
    const handle = $('sheet-handle'); let startY = 0, dragging = false;
    const start = (y) => { startY = y; dragging = true; };
    const move = (y) => { if (!dragging) return; const dy = y - startY;
      if (dy < -40) { sheet.classList.add('full'); dragging = false; }
      else if (dy > 60) { dismissSheet(); dragging = false; } };
    const end = () => { dragging = false; };
    handle.addEventListener('touchstart', e => start(e.touches[0].clientY), { passive: true });
    handle.addEventListener('touchmove', e => move(e.touches[0].clientY), { passive: true });
    handle.addEventListener('touchend', end);
    handle.addEventListener('mousedown', e => start(e.clientY));
    window.addEventListener('mousemove', e => move(e.clientY));
    window.addEventListener('mouseup', end);
    handle.addEventListener('click', () => sheet.classList.toggle('full'));
  }

  // ---------- Saisie manuelle ----------
  function openManual() { const dlg = $('manual-dialog'); dlg.showModal(); $('manual-input').focus(); }
  function setupManual() {
    $('manual-form').addEventListener('submit', () => {
      const dlg = $('manual-dialog'); const val = $('manual-input').value.trim();
      setTimeout(() => {
        if (dlg.returnValue === 'cancel' || !val) return;
        const digits = val.replace(/[^0-9Xx]/g, '');
        if (isISBN(digits)) lookup({ isbn: digits }); else lookup({ text: val });
        $('manual-input').value = '';
      }, 0);
    });
  }

  function registerSW() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // iOS exige souvent un geste pour démarrer la caméra → on affiche un bouton d'activation.
  function needsGesture() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function init() {
    setupSheetGestures(); setupManual(); registerSW();
    $('btn-ocr').addEventListener('click', scanTitle);
    $('btn-manual').addEventListener('click', openManual);
    $('btn-manual-2').addEventListener('click', openManual);
    $('btn-manual-3').addEventListener('click', openManual);
    $('btn-start').addEventListener('click', startScan);
    if (needsGesture()) $('cam-gate').hidden = false;  // attend le tap (iOS)
    else startScan();                                   // Android/desktop : démarrage direct
  }
  document.addEventListener('DOMContentLoaded', init);
  return { dismissSheet, lookup, scanTitle };
})();
