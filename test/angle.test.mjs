// Test de l'estimateur d'orientation de LibrisRecto sur des couvertures synthétiques.
// La couverture est portrait (bords verticaux longs) et le texte a des jambages :
// c'est exactement le cas où le pic brut de l'histogramme est perpendiculaire au titre.
import fs from 'node:fs';
import vm from 'node:vm';

// Le détecteur vit dans le Worker : c'est lui la source unique de l'algorithme.
const src = fs.readFileSync(new URL('../angle-worker.js', import.meta.url), 'utf8');

const sandbox = { console };   // pas de `self` : le bloc Worker ne s'exécute pas
vm.createContext(sandbox);
vm.runInContext(src + '\n;globalThis.__orientationOf = orientationOf;', sandbox);
const _orientationOf = sandbox.__orientationOf;

// l'app redresse modulo 90° : la vérité attendue est l'inclinaison repliée dans (-45, 45]
const wrap = (a) => ((a + 45) % 90 + 90) % 90 - 45;

// Rendu supersamplé : sans anti-aliasing les bords sont des escaliers de pixels
// et Sobel ne voit plus que 0 / 26.5 / 45 / 63.4°.
function cover(W, H, theta, opts = {}) {
  const { noise = 6, SS = 4 } = opts;
  const rad = theta * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const halfW = 46, halfH = 66;            // couverture portrait, en unités page
  const scale = Math.min(W / 200, H / 200);

  // Une "lettre" : deux jambages verticaux + une barre horizontale.
  const rows = [];
  const addRow = (y, h, wMin, wMax) => {
    const line = [];
    let x = -halfW * 0.78;
    x += Math.random() * (wMax * 1.5);        // décalage aléatoire de début de ligne
    while (x < halfW * 0.78) {
      const w = wMin + Math.random() * (wMax - wMin);
      if (x + w > halfW * 0.78) break;
      line.push({ x, y, w, h });
      x += w + (h * 0.25) + Math.random() * (h * 0.5);
      if (Math.random() < 0.16) x += h * 0.9;  // espace entre mots
    }
    rows.push(line);
  };
  addRow(-46, 13, 7, 12);                      // titre, ligne 1
  addRow(-28, 13, 7, 12);                      // titre, ligne 2
  for (let i = 0; i < 6; i++) addRow(6 + i * 8, 5, 2.6, 4.4);   // corps de texte

  const glyph = (u, v, gx, gy, w, h) => {
    const du = u - gx, dv = v - gy;
    if (du < 0 || du > w || dv < 0 || dv > h) return false;
    if (du < w * 0.22 || du > w * 0.78) return true;          // jambages
    return dv > h * 0.42 && dv < h * 0.58;                    // barre
  };

  const sample = (px, py) => {
    const dx = (px - W / 2) / scale, dy = (py - H / 2) / scale;
    const u = dx * cos + dy * sin;         // rotation inverse -> repère page
    const v = -dx * sin + dy * cos;
    if (Math.abs(u) >= halfW || Math.abs(v) >= halfH) return 70;   // fond
    for (const r of rows) {
      for (const g of r) if (glyph(u, v, g.x, g.y, g.w, g.h)) return 18;
    }
    return 242;                                                     // papier
  };

  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) acc += sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      const val = acc / (SS * SS) + (Math.random() - 0.5) * noise;
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = val; data[i + 3] = 255;
    }
  }
  return data;
}

const W = 224, H = 130;
const ANGLES = [0, 5, -7, 12, -18, 30, -35, 44, 60, -75, 88];
let fails = 0;

function check(label, theta, got, tol = 3) {
  const err = got === null ? null : Math.abs(wrap(got - theta));
  const ok = err !== null && err < tol;
  if (!ok) fails++;
  console.log(`${label.padEnd(22)} ${String(theta).padStart(4)}° -> ` +
    (got === null ? '   null ' : got.toFixed(2).padStart(8) + '°') +
    (err === null ? '' : `  écart ${err.toFixed(2)}°`) + (ok ? '  ok' : '  ECHEC'));
}

console.log('— estimation directe (ancre déjà convergée) —');
for (const t of ANGLES) check('direct', t, _orientationOf(cover(W, H, t), W, H));

console.log('\n— convergence du lissage par frame (12 frames depuis 0°) —');
for (const t of ANGLES) {
  const px = cover(W, H, t);
  let a = 0;
  for (let k = 0; k < 12; k++) {
    const got = _orientationOf(px, W, H);
    if (got !== null) a += wrap(got - a) * 0.5;
  }
  check('convergence', t, a);
}

console.log('\n— dos de livre vertical (le quart de tour est manuel) —');
for (const t of [88, 92, 105, 70]) {
  const got = _orientationOf(cover(W, H, t), W, H);
  check('modulo 90', t, got);
}

console.log('\n— stabilité sur 20 frames bruitées (theta = -22°) —');
{
  let max = 0;
  for (let k = 0; k < 20; k++) {
    const got = _orientationOf(cover(W, H, -22), W, H);
    if (got === null) continue;
    max = Math.max(max, Math.abs(wrap(got - (-22))));
  }
  const ok = max < 3;
  if (!ok) fails++;
  console.log(`écart max frame à frame : ${max.toFixed(2)}°` + (ok ? '  ok' : '  ECHEC'));
}

console.log('\n— scène sans direction dominante —');
{
  const noiseOnly = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < noiseOnly.length; i += 4) {
    const v = Math.random() * 255;
    noiseOnly[i] = noiseOnly[i + 1] = noiseOnly[i + 2] = v; noiseOnly[i + 3] = 255;
  }
  const res = _orientationOf(noiseOnly, W, H);
  const ok = res === null;
  if (!ok) fails++;
  console.log('bruit pur -> ' + res + (ok ? '  ok (pas de verrou)' : '  ECHEC'));
}

console.log(fails === 0 ? '\nTOUT PASSE' : `\n${fails} ECHEC(S)`);
process.exit(fails === 0 ? 0 : 1);
