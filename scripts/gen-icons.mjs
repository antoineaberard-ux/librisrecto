/* Génère les icônes de lanceur Android à partir des SVG.
   Le rendu passe par le navigateur : sips ne sait pas composer un SVG, et
   aplatir icon-512.png laissait ses coins arrondis transparents en blanc. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
export const DENSITIES = [
  { name: 'mdpi', launcher: 48, foreground: 108 },
  { name: 'hdpi', launcher: 72, foreground: 162 },
  { name: 'xhdpi', launcher: 96, foreground: 216 },
  { name: 'xxhdpi', launcher: 144, foreground: 324 },
  { name: 'xxxhdpi', launcher: 192, foreground: 432 }
];

export async function writePng(dir, file, dataUrl) {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  await writeFile(path.join(root, 'android/app/src/main/res', dir, file), buf);
}

if (process.argv[2] === '--payload') {
  console.log(JSON.stringify({
    launcher: await readFile('/tmp/librisicons/launcher.svg', 'utf8'),
    foreground: await readFile('/tmp/librisicons/fg.svg', 'utf8'),
    densities: DENSITIES
  }));
}
