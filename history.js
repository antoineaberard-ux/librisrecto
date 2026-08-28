/* Historique des livres scannés — local d'abord.

   localStorage fait autorité : l'app doit fonctionner hors-ligne, en avion,
   et même si Firestore n'est pas joignable. Firebase n'est chargé qu'après,
   en tâche de fond, pour synchroniser.

   Identité : connexion ANONYME. Elle est propre à l'appareil ET au navigateur.
   L'historique n'est donc PAS partagé entre le téléphone et l'ordinateur :
   cela demanderait un vrai compte (lien e-mail), volontairement non fait ici
   pour ne collecter aucune donnée personnelle.

   Données envoyées : titre, auteur, ISBN, année, URL de couverture, date.
   Aucun identifiant de personne, aucune position, aucune image. */

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBCWCMW1pzuq5VY2PVqailmdsX3OBtU5i4',
  authDomain: 'librisrecto.firebaseapp.com',
  projectId: 'librisrecto',
  storageBucket: 'librisrecto.firebasestorage.app',
  messagingSenderId: '462578432395',
  appId: '1:462578432395:web:4d3b4f64f6d7492d5a978e'
};
const SDK = 'https://www.gstatic.com/firebasejs/12.4.0';
const STORE_KEY = 'librisrecto.history.v1';
const MAX_ENTRIES = 200;

let entries = [];
let cloud = null;            // { db, uid } une fois la synchro prête
let onChange = () => {};

// ---------- Stockage local ----------
function read() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function write() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES))); }
  catch { /* quota plein ou navigation privée : on garde l'historique en mémoire */ }
}

// Un livre sans ISBN reste identifiable par son titre et son auteur.
function idOf(book) {
  const isbn = (book.isbn || '').replace(/[^0-9Xx]/g, '');
  if (isbn) return isbn;
  return 'q-' + `${book.title}|${book.author}`.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}
function normalize(book) {
  return {
    id: idOf(book),
    isbn: (book.isbn || '').replace(/[^0-9Xx]/g, ''),
    title: String(book.title || 'Sans titre').slice(0, 300),
    author: String(book.author || '').slice(0, 200),
    cover: String(book.cover || '').slice(0, 500),
    year: book.year ? String(book.year).slice(0, 8) : '',
    scannedAt: Date.now()
  };
}

function list() { return entries.slice(); }

function add(book) {
  if (!book || !book.title) return;
  const entry = normalize(book);
  entries = [entry, ...entries.filter((e) => e.id !== entry.id)].slice(0, MAX_ENTRIES);
  write();
  onChange(list());
  pushToCloud(entry);
}

function remove(id) {
  entries = entries.filter((e) => e.id !== id);
  write();
  onChange(list());
  removeFromCloud(id);
}

function clear() {
  const ids = entries.map((e) => e.id);
  entries = [];
  write();
  onChange(list());
  ids.forEach(removeFromCloud);
}

// ---------- Synchronisation Firestore (best effort) ----------
// Tout échec ici est silencieux : l'historique local reste la référence.
let fb = null;
async function loadFirebase() {
  if (fb) return fb;
  const [app, auth, store] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`)
  ]);
  fb = { app, auth, store };
  return fb;
}

async function connect() {
  if (cloud || !navigator.onLine) return null;
  try {
    const { app, auth, store } = await loadFirebase();
    const instance = app.getApps().length ? app.getApp() : app.initializeApp(FIREBASE_CONFIG);
    const a = auth.getAuth(instance);
    const cred = await auth.signInAnonymously(a);
    cloud = { db: store.getFirestore(instance), uid: cred.user.uid, store };
    await mergeFromCloud();
    return cloud;
  } catch (err) {
    // Firestore ou la connexion anonyme pas encore activés dans la console :
    // l'app continue en local, sans rien dire à l'utilisateur.
    cloud = null;
    return null;
  }
}

async function mergeFromCloud() {
  if (!cloud) return;
  const { store, db, uid } = cloud;
  const snap = await store.getDocs(store.collection(db, 'users', uid, 'books'));
  const remote = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const byId = new Map();
  for (const e of [...entries, ...remote]) {
    const kept = byId.get(e.id);
    if (!kept || (e.scannedAt || 0) > (kept.scannedAt || 0)) byId.set(e.id, e);
  }
  entries = [...byId.values()].sort((a, b) => (b.scannedAt || 0) - (a.scannedAt || 0)).slice(0, MAX_ENTRIES);
  write();
  onChange(list());
  // Ce qui n'existait qu'en local part vers le nuage.
  const remoteIds = new Set(remote.map((e) => e.id));
  entries.filter((e) => !remoteIds.has(e.id)).forEach(pushToCloud);
}

async function pushToCloud(entry) {
  const c = cloud || await connect();
  if (!c) return;
  const { store, db, uid } = c;
  const { id, ...data } = entry;
  try { await store.setDoc(store.doc(db, 'users', uid, 'books', id), data); }
  catch { /* hors-ligne : la prochaine ouverture rattrapera */ }
}

async function removeFromCloud(id) {
  if (!cloud) return;
  const { store, db, uid } = cloud;
  try { await store.deleteDoc(store.doc(db, 'users', uid, 'books', id)); }
  catch { /* rien à faire */ }
}

// ---------- Démarrage ----------
entries = read();
// La synchro ne doit jamais retarder l'affichage : on la lance en différé.
setTimeout(connect, 2500);
window.addEventListener('online', () => { if (!cloud) connect(); });

window.LibrisHistory = {
  list, add, remove, clear,
  isSynced: () => !!cloud,
  onChange: (fn) => { onChange = fn; fn(list()); }
};

// app.js est un script classique, ce fichier un module : il s'exécute donc
// après. On signale plutôt que de se faire sonder en boucle.
window.dispatchEvent(new Event('librishistory:ready'));

