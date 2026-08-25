/* Grave la date de compilation dans app.js et le nom du cache du service worker.
   Sans tampon, impossible de savoir si un téléphone tourne encore sur une
   version en cache — et c'est la première question à se poser devant un
   « ça ne marche toujours pas ». */
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  + ` ${pad(now.getHours())}:${pad(now.getMinutes())}`;

const appPath = new URL('app.js', root);
let app = await readFile(appPath, 'utf8');
app = app.replace(/^const LIBRIS_VERSION = '.*';$/m, `const LIBRIS_VERSION = '${stamp}';`);
await writeFile(appPath, app);

// Le nom du cache doit changer à chaque publication, sinon l'ancien survit.
const swPath = new URL('sw.js', root);
let sw = await readFile(swPath, 'utf8');
sw = sw.replace(/^const CACHE = '.*';$/m, `const CACHE = 'librisrecto-${stamp.replace(/[^0-9]/g, '')}';`);
await writeFile(swPath, sw);

console.log(`version ${stamp}`);
