# LibrisRecto

**Redressez un livre incliné pour lire le titre sans pencher la tête.**

Pointez la caméra sur un livre posé de travers : l'app détecte l'inclinaison
(transformée de Hough, OpenCV.js) et **fait pivoter l'image en temps réel** pour
afficher le titre à l'horizontale. Bouton **Figer** + **zoom** pour lire tranquillement.

Bonus : scan du **code-barres ISBN** → titre, auteur, note et **synopsis**
(Open Library / Google Books).

## Tester

- **En ligne (iOS + Android)** : ouvrir l'URL GitHub Pages, puis « Ajouter à l'écran d'accueil ».
- **En local** : `python3 serve.py` → http://localhost:5180 (Chrome, webcam).

> La caméra exige **HTTPS** (GitHub Pages le fournit).
> Sur iPhone, toucher « Activer la caméra » au démarrage (geste requis par Safari).

## Pile

| Fonction | Techno |
|----------|--------|
| Redressement temps réel (angle d'inclinaison) | OpenCV.js — transformée de Hough |
| Caméra (iOS + Android) | getUserMedia + rotation CSS (GPU) |
| Scan ISBN | [ZXing](https://github.com/zxing-js/library) |
| Métadonnées / synopsis | Open Library API · Google Books API |
| Hors-ligne / installable | Service Worker + Web App Manifest |

## Limites & suite native

La PWA redresse l'**inclinaison plane** (rotation), ce qui couvre le besoin principal
(livre de biais sur une table / dans une bibliothèque). Le **dewarping 3D** (livre ouvert
incurvé) et le **CLAHE** (reflets sur couvertures glacées) du cahier des charges restent
prévus pour la version **native** (Swift/AVFoundation, Kotlin/CameraX).
