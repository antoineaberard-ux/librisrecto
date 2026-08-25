# LibrisRecto

**Redressez un livre incliné pour lire le titre sans pencher la tête.**

Visez un livre posé de travers : l'app mesure l'inclinaison des lignes de texte
et **fait pivoter l'image en temps réel** pour remettre le titre à l'horizontale.
Bouton **Figer** + **zoom** pour lire tranquillement.

Bonus : **lecture du titre** (OCR) et scan du **code-barres ISBN** → titre,
auteur, note et **synopsis** (Open Library / Google Books).

## Tester

- **Installer (iOS + Android)** : https://librisrecto.web.app/install — la page détecte le téléphone et donne les gestes exacts.
- **Ouvrir directement** : https://librisrecto.web.app
- **Miroir de secours** : https://antoineaberard-ux.github.io/librisrecto/ (GitHub Pages).
- **En local** : `python3 serve.py` → http://localhost:5180 (Chrome, webcam).
- **Tests de la détection d'angle** : `node test/angle.test.mjs` (aucune dépendance).

> La caméra exige **HTTPS** (GitHub Pages le fournit ; `localhost` est accepté en local).
> Sur iPhone, toucher « Activer la caméra » au démarrage (geste requis par Safari).

## Comment marche le redressement

| Étape | Détail |
|-------|--------|
| 1. Cadre de visée | seule la zone du rectangle est analysée — le reste de la pièce ne vote pas |
| 2. Sobel | dans un Worker, sur une vignette de 224 px, seuil adaptatif à la lumière ambiante |
| 3. Histogramme circulaire | orientation des contours repliée **modulo 90°**, 1 bin par degré, lissé |
| 4. Pic + parabole | interpolation parabolique → précision sous le degré |
| 5. Rotation | `transform: rotate()` sur le GPU, lissée image par image |

Le calcul tourne dans **angle-worker.js**. Sur le thread principal, le
`getImageData` à 9 Hz force une lecture GPU vers CPU qui bloque le compositeur :
c'était la cause des à-coups. Les tableaux y sont réutilisés d'une image à
l'autre, au lieu de 350 Ko réalloués neuf fois par seconde.

Le redressement est **modulo 90°** : il applique toujours la rotation minimale
(< 45°). Décider lequel des deux axes porte le titre n'est pas fiable sur une
vignette — les jambages des lettres et les deux longs bords de la couverture
votent aussi fort que les lignes de texte. Pour un **dos de livre vertical**
(rayonnage), un appui sur **↻ 90°** suffit, et le réglage est conservé pour les
livres suivants.

## Caméra

| Réglage | Détail |
|---------|--------|
| Mise au point | `focusMode: continuous` à l'ouverture ; **toucher l'image** pose un `pointsOfInterest` et déclenche un `single-shot` |
| Lampe | bouton 💡 en haut, affiché seulement si la piste vidéo annonce `torch` |
| Zoom | zoom **optique** du capteur quand il existe, sinon agrandissement CSS |
| Résolution | 2560×1440 demandé ; les frames envoyées au décodeur ne sont **pas** réduites |

Ces trois réglages passent par `applyConstraints`. **Android Chrome** les
supporte ; **iOS Safari** n'en expose aucun, donc le bouton lampe reste masqué
et la mise au point reste celle du système.

## Scan ISBN

Le décodeur reçoit en alternance un **recadrage de la bande visée à la
résolution native** et la vue large. Réduire la frame avant de décoder est ce
qui faisait échouer le scan en conditions réelles — mesuré sur des images
floues, bruitées et peu contrastées comme en vrai :

| flou | largeur du code-barres | recadrage natif | frame réduite en 0,625× |
|------|------------------------|-----------------|--------------------------|
| 0,8 px | 190 px | 5/5 | 0/5 |
| 1,4 px | 247 px | 5/5 | 0/5 |
| 2,0 px | 323 px | 5/5 | 0/5 |

## Lecture du titre

Tesseract est lourd : une capture de 3,5 Mpx prend plusieurs secondes sur un
ordinateur et bien davantage sur un téléphone. La capture est donc plafonnée en
**largeur** — c'est elle qui porte la lisibilité du texte, plafonner le côté
long écrasait la largeur à 555 px sur une image portrait — et la progression est
affichée, sans quoi l'attente passe pour un plantage.

Le titre retenu est la ligne au plus grand corps. Quand rien ne passe le seuil
de confiance, l'app affiche **ce qu'elle a lu** plutôt qu'un « illisible »
opaque, et le diagnostic garde l'image envoyée à l'OCR.

## Compatibilité

Le panneau « Infos livre » n'utilise **pas** `<dialog>` / `showModal()`, absent
d'iOS Safari avant 15.4 et des WebView Android anciennes : l'appel y levait une
erreur et rendait le scan ISBN comme la lecture du titre totalement
inatteignables, pendant que le redressement continuait de fonctionner. Tous les
panneaux sont des feuilles glissantes, sans API récente.

`npm run deploy` grave la date de compilation dans l'app et dans le nom du cache
du service worker. Le diagnostic l'affiche : c'est la première chose à vérifier
devant un « ça ne marche toujours pas », un téléphone pouvant tourner sur une
version en cache.

## Diagnostic

Le bouton **Diagnostic de l'appareil**, dans « Infos livre », affiche ce que le
téléphone sait réellement faire : résolution, images par seconde, réglages
caméra disponibles, moteur de code-barres, dernier texte lu, dernière image
envoyée à l'OCR, **version chargée** et **dernière erreur JavaScript**. Les
capacités varient énormément d'un appareil et d'un navigateur à l'autre : sans
cet écran, un « ça ne marche pas » n'est pas vérifiable à distance.

Le bouton **Forcer la mise à jour** désinscrit le service worker, vide les
caches et recharge, pour le cas où une version périmée survivrait.

## Historique

Les livres trouvés sont gardés **en local d'abord** (`localStorage`), puis
synchronisés vers Firestore sous une **connexion anonyme**.

L'identité anonyme appartient à l'appareil **et** au navigateur : l'historique
n'est donc **pas** partagé entre le téléphone et l'ordinateur. Le faire
demanderait un vrai compte (lien e-mail), volontairement écarté pour ne
collecter aucune donnée personnelle.

Données envoyées : titre, auteur, ISBN, année, URL de couverture, date. Aucun
identifiant de personne, aucune position, aucune image. Les règles Firestore
(`firestore.rules`) enferment chaque identité dans sa propre collection.

Si Firestore est injoignable ou désactivé, l'app continue en local sans rien
signaler.

## Installation

PWA des deux côtés, pas d'app native.

| | Chemin |
|---|---|
| Android | `beforeinstallprompt` → bouton « Installer », un seul geste. Repli : menu du navigateur → « Ajouter à l'écran d'accueil » |
| iOS | Aucune API n'existe : Safari → Partager → Sur l'écran d'accueil. L'app montre le geste d'elle-même |

Un projet **Capacitor** reste dans `android/` et produit un APK signé
(`npm run apk`), mais il n'est plus distribué : **Samsung bloque par défaut
l'installation hors Play Store** (Auto Blocker, One UI récent), ce qui rend le
sideload inutilisable pour l'usage visé. Le projet sert de base si un dépôt sur
le Play Store devient nécessaire.

## Déploiement

```
firebase deploy --only hosting          # https://librisrecto.web.app
firebase deploy --only firestore        # règles de sécurité
git push origin main                    # miroir GitHub Pages
```

## Pile

| Fonction | Techno |
|----------|--------|
| Redressement temps réel | Sobel + histogramme d'orientation, JS pur, dans un **Web Worker** |
| Caméra (iOS + Android) | getUserMedia + rotation CSS (GPU) |
| Lecture du titre | [Tesseract.js](https://tesseract.projectnaptha.com/) `fra+eng`, chargé à la demande |
| Scan ISBN | `BarcodeDetector` natif, repli [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) |
| Métadonnées / synopsis | Open Library API · Google Books API |
| Hors-ligne / installable | Service Worker (réseau d'abord) + Web App Manifest |
| Hébergement | Firebase Hosting |
| Historique | localStorage + Firestore, connexion anonyme |

Tesseract et ZXing ne sont téléchargés qu'au premier usage du bouton
correspondant : le démarrage de l'app ne dépend d'aucun CDN.

Le quota anonyme de Google Books est par adresse IP et vite atteint : les
recherches par texte basculent automatiquement sur Open Library.

## Limites & suite native

La PWA redresse l'**inclinaison plane** (rotation), ce qui couvre le besoin principal
(livre de biais sur une table / dans une bibliothèque). Le **dewarping 3D** (livre ouvert
incurvé) et le **CLAHE** (reflets sur couvertures glacées) restent prévus pour la
version **native** (Swift/AVFoundation, Kotlin/CameraX).
