# LibrisRecto

**Redressez un livre incliné pour lire le titre sans pencher la tête.**

Visez un livre posé de travers : l'app mesure l'inclinaison des lignes de texte
et **fait pivoter l'image en temps réel** pour remettre le titre à l'horizontale.
Bouton **Figer** + **zoom** pour lire tranquillement.

Bonus : **lecture du titre** (OCR) et scan du **code-barres ISBN** → titre,
auteur, note et **synopsis** (Open Library / Google Books).

## Tester

- **En ligne (iOS + Android)** : ouvrir l'URL GitHub Pages, puis « Ajouter à l'écran d'accueil ».
- **En local** : `python3 serve.py` → http://localhost:5180 (Chrome, webcam).
- **Tests de la détection d'angle** : `node test/angle.test.mjs` (aucune dépendance).

> La caméra exige **HTTPS** (GitHub Pages le fournit ; `localhost` est accepté en local).
> Sur iPhone, toucher « Activer la caméra » au démarrage (geste requis par Safari).

## Comment marche le redressement

| Étape | Détail |
|-------|--------|
| 1. Cadre de visée | seule la zone du rectangle est analysée — le reste de la pièce ne vote pas |
| 2. Sobel | gradient sur une vignette de 224 px, seuil adaptatif à la lumière ambiante |
| 3. Histogramme circulaire | orientation des contours repliée **modulo 90°**, 1 bin par degré, lissé |
| 4. Pic + parabole | interpolation parabolique → précision sous le degré |
| 5. Rotation | `transform: rotate()` sur le GPU, lissée image par image |

Le redressement est **modulo 90°** : il applique toujours la rotation minimale
(< 45°). Décider lequel des deux axes porte le titre n'est pas fiable sur une
vignette — les jambages des lettres et les deux longs bords de la couverture
votent aussi fort que les lignes de texte. Pour un **dos de livre vertical**
(rayonnage), un appui sur **↻ 90°** suffit, et le réglage est conservé pour les
livres suivants.

## Pile

| Fonction | Techno |
|----------|--------|
| Redressement temps réel | Sobel + histogramme d'orientation, JS pur (aucune dépendance) |
| Caméra (iOS + Android) | getUserMedia + rotation CSS (GPU) |
| Lecture du titre | [Tesseract.js](https://tesseract.projectnaptha.com/) `fra+eng`, chargé à la demande |
| Scan ISBN | `BarcodeDetector` natif, repli [ZXing](https://github.com/zxing-js/library) |
| Métadonnées / synopsis | Open Library API · Google Books API |
| Hors-ligne / installable | Service Worker + Web App Manifest |

Tesseract et ZXing ne sont téléchargés qu'au premier usage du bouton
correspondant : le démarrage de l'app ne dépend d'aucun CDN.

Le quota anonyme de Google Books est par adresse IP et vite atteint : les
recherches par texte basculent automatiquement sur Open Library.

## Limites & suite native

La PWA redresse l'**inclinaison plane** (rotation), ce qui couvre le besoin principal
(livre de biais sur une table / dans une bibliothèque). Le **dewarping 3D** (livre ouvert
incurvé) et le **CLAHE** (reflets sur couvertures glacées) restent prévus pour la
version **native** (Swift/AVFoundation, Kotlin/CameraX).
