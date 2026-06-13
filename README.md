# LibrisRecto

PWA : scannez un livre, obtenez instantanément son **synopsis**.

Scannez le **code-barres ISBN** (dos du livre) ou le **titre** (OCR), l'app interroge
Open Library / Google Books et affiche titre, auteur, note et résumé dans un panneau coulissant.

## Tester

- **En ligne (iOS + Android)** : ouvrir l'URL GitHub Pages du dépôt, puis
  « Ajouter à l'écran d'accueil » pour l'installer comme une vraie app.
- **En local** : `python3 serve.py` puis http://localhost:5180 (Chrome, webcam).

> iOS / Android : la caméra exige **HTTPS** (GitHub Pages le fournit).
> Sur iPhone, toucher « Activer la caméra » au démarrage (geste requis par Safari).

## Pile

| Étape | Techno |
|-------|--------|
| Caméra + scan ISBN (iOS+Android) | [ZXing](https://github.com/zxing-js/library) |
| OCR titre (repli sans code-barres) | [Tesseract.js](https://tesseract.projectnaptha.com/) |
| Métadonnées | Open Library API · Google Books API |
| Hors-ligne / installable | Service Worker + Web App Manifest |

## Cahier des charges

Spécifié dans le dossier de cadrage *LibrisRecto*. Le redressement géométrique temps-réel
de l'image (transformée de Hough, homographie, dewarping 3D, CLAHE) est prévu pour la
version **native** (Swift/AVFoundation, Kotlin/CameraX) ; cette PWA couvre le scan ISBN,
l'OCR titre avec prétraitement contraste, et tout le flux données → synopsis.
