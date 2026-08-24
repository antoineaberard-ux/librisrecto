/* Recopie les fichiers web dans www/, le dossier qu'embarque Capacitor.
   Les sources restent à la racine : Firebase Hosting continue de les servir
   telles quelles, il n'y a donc qu'une seule version du code. */
import { cp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const www = path.join(root, 'www');

const FILES = ['index.html', 'app.js', 'history.js', 'styles.css', 'manifest.webmanifest'];
const DIRS = ['icons'];

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });
for (const f of FILES) await cp(path.join(root, f), path.join(www, f));
for (const d of DIRS) await cp(path.join(root, d), path.join(www, d), { recursive: true });

// Le service worker n'a aucun sens dans l'app native : les fichiers sont déjà
// locaux, et son cache ferait écran aux mises à jour de l'APK.
const html = await readFile(path.join(www, 'index.html'), 'utf8');
await writeFile(path.join(www, 'index.html'), html.replace(
  '<script src="app.js"></script>',
  '<script>window.__LIBRIS_NATIVE__ = true;</script>\n  <script src="app.js"></script>'
));

console.log(`www/ prêt : ${FILES.length + DIRS.length} entrées`);
