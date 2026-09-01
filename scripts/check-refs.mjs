/* Détecte les identifiants utilisés mais jamais déclarés.

   `node --check` ne contrôle que la syntaxe : un appel à une fonction inexistante
   ou une affectation à une variable non déclarée passent sans bruit et n'explosent
   qu'à l'exécution, souvent dans une branche rarement empruntée. Deux pannes de ce
   type ont été livrées ainsi — un balayage de mise au point qui mourait à sa
   première ligne, et un écran de diagnostic qui refusait de s'ouvrir.

   L'analyse est volontairement simple : commentaires et chaînes sont retirés,
   puis on compare les identifiants employés à ceux déclarés. */
import { readFile } from 'node:fs/promises';

const FICHIERS = ['app.js', 'angle-worker.js', 'install.js', 'history.js', 'sw.js'];

const GLOBALES = new Set([
  'window', 'document', 'location', 'navigator', 'console', 'self', 'globalThis',
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'RegExp',
  'Set', 'Map', 'WeakMap', 'Promise', 'Error', 'Symbol', 'Infinity', 'NaN', 'undefined',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'fetch', 'Response', 'Request', 'Headers', 'URL', 'Blob', 'FileReader', 'caches',
  'Worker', 'OffscreenCanvas', 'ImageBitmap', 'createImageBitmap', 'ImageData',
  'Image', 'Event', 'CustomEvent', 'MutationObserver', 'DOMParser', 'AbortController',
  'Uint8Array', 'Uint8ClampedArray', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'performance', 'crypto', 'structuredClone', 'confirm', 'alert', 'prompt',
  'BarcodeDetector', 'Tesseract', 'Capacitor', 'ZXing', 'firebase',
  'true', 'false', 'null', 'this', 'arguments', 'super', 'import', 'require'
]);

const MOTS_CLES = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'function', 'class', 'extends', 'new', 'delete', 'typeof', 'instanceof',
  'in', 'of', 'let', 'const', 'var', 'await', 'async', 'yield', 'throw', 'try', 'catch',
  'finally', 'void', 'with', 'get', 'set', 'static'
]);

function retirerCommentairesEtChaines(code) {
  let out = '', i = 0;
  while (i < code.length) {
    const c = code[i], d = code[i + 1];
    if (c === '/' && d === '/') { while (i < code.length && code[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const guillemet = c; i++;
      while (i < code.length && code[i] !== guillemet) {
        // Les gabarits contiennent du vrai code entre ${ } : on le conserve.
        if (guillemet === '`' && code[i] === '$' && code[i + 1] === '{') {
          let profondeur = 1; i += 2; out += ' ';
          while (i < code.length && profondeur > 0) {
            if (code[i] === '{') profondeur++;
            else if (code[i] === '}') profondeur--;
            if (profondeur > 0) out += code[i];
            i++;
          }
          continue;
        }
        if (code[i] === '\\') i++;
        i++;
      }
      i++; out += '""'; continue;
    }
    out += c; i++;
  }
  return out;
}

function declarations(code) {
  const noms = new Set();
  const ajouterListe = (texte) => {
    let profondeur = 0, courant = '';
    const pousser = (t) => {
      // Les accolades doivent tomber AVANT le découpage : sinon `{ x } = ...`
      // laisse « { » comme premier jeton et le nom déstructuré est perdu.
      const nu = t.replace(/[{}[\]()]/g, ' ').trim();
      for (const part of nu.split(/\s*,\s*/)) {
        const nom = part.split(/[=\s:]/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(nom)) noms.add(nom);
      }
    };
    for (const ch of texte) {
      if ('([{'.includes(ch)) profondeur++;
      else if (')]}'.includes(ch)) profondeur--;
      if (ch === ',' && profondeur === 0) { pousser(courant); courant = ''; }
      else courant += ch;
    }
    pousser(courant);
  };
  for (const m of code.matchAll(/\b(?:let|const|var)\s+([^;\n]+)/g)) ajouterListe(m[1]);
  for (const m of code.matchAll(/\b(?:function|class)\s*\*?\s*([A-Za-z_$][\w$]*)/g)) noms.add(m[1]);
  for (const m of code.matchAll(/\bfunction\s*\*?\s*[A-Za-z_$]*\s*\(([^)]*)\)/g)) ajouterListe(m[1]);
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) ajouterListe(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) noms.add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) noms.add(m[1]);
  for (const m of code.matchAll(/\b(?:for)\s*\(\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) noms.add(m[1]);
  // Propriétés de méthodes abrégées dans les objets : `nom(args) {`
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) noms.add(m[1]);
  return noms;
}

let problemes = 0;
for (const fichier of FICHIERS) {
  const brut = await readFile(new URL(`../${fichier}`, import.meta.url), 'utf8');
  const code = retirerCommentairesEtChaines(brut);
  const connus = declarations(code);
  const suspects = new Set();

  // Identifiants employés : appels de fonction et affectations.
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const n = m[1];
    if (!connus.has(n) && !GLOBALES.has(n) && !MOTS_CLES.has(n)) suspects.add(n + '()');
  }
  for (const m of code.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*(?:=[^=>]|\+=|-=|\*=)/gm)) {
    const n = m[1];
    if (!connus.has(n) && !GLOBALES.has(n) && !MOTS_CLES.has(n)) suspects.add(n + ' =');
  }

  if (suspects.size) { problemes++; console.log(`✗ ${fichier} : ${[...suspects].join(', ')}`); }
  else console.log(`✓ ${fichier}`);
}

if (problemes) { console.log(`\n${problemes} fichier(s) avec des références non résolues`); process.exit(1); }
console.log('\nAucune référence non résolue');
