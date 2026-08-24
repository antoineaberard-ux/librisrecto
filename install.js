/* Installation sur l'écran d'accueil.

   Deux chemins très différents :
   - Chromium (Chrome, Samsung Internet, Edge) déclenche `beforeinstallprompt`
     et sait installer en un geste. On garde l'événement pour le rejouer au
     moment choisi par l'utilisateur.
   - iOS/Safari n'expose aucune API : la seule voie est « Partager » puis
     « Sur l'écran d'accueil ». On explique donc le geste, en images.

   Rien ne s'affiche si l'app est déjà installée, ni si elle tourne dans une
   coque native. */

const LibrisInstall = (() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SNOOZE_KEY = 'librisrecto.install.snooze';
  const SNOOZE_DAYS = 21;

  let deferredPrompt = null;

  // Le test MacIntel + tactile repère l'iPad, qui se déclare « Macintosh ».
  // Sans l'exclusion d'Android, un téléphone tactile y tombait aussi.
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (!/Android/.test(navigator.userAgent) &&
      navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isNative = () => !!window.__LIBRIS_NATIVE__ || !!window.Capacitor?.isNativePlatform?.();
  const isInstalled = () =>
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches ||
    navigator.standalone === true;

  function snoozed() {
    const until = Number(localStorage.getItem(SNOOZE_KEY) || 0);
    return Date.now() < until;
  }
  function snooze() {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 864e5)); }
    catch { /* navigation privée */ }
  }

  function showBanner() {
    const banner = $('install-banner');
    if (!banner) return;
    banner.hidden = false;
  }
  function hideBanner() {
    const banner = $('install-banner');
    if (banner) banner.hidden = true;
  }

  // ---------- iOS : on montre le geste ----------
  function openIOSSheet() {
    const sheet = $('ios-install');
    // Pleine hauteur : les trois étapes et la note ne tiennent pas dans les 46%
    // par défaut, et une feuille qu'il faut faire défiler rate son but.
    sheet.classList.add('open', 'full');
    sheet.setAttribute('aria-hidden', 'false');
  }
  function closeIOSSheet() {
    const sheet = $('ios-install');
    sheet.classList.remove('open', 'full');
    sheet.setAttribute('aria-hidden', 'true');
  }

  // ---------- Chromium : installation en un geste ----------
  async function promptInstall() {
    if (!deferredPrompt) return false;
    const prompt = deferredPrompt;
    deferredPrompt = null;          // l'événement n'est rejouable qu'une fois
    hideBanner();
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome !== 'accepted') snooze();
    return outcome === 'accepted';
  }

  function open() {
    if (isInstalled()) return;
    if (deferredPrompt) return promptInstall();
    openIOSSheet();               // pas d'API : on explique, iOS comme ailleurs
  }

  function init() {
    if (isNative() || isInstalled()) return;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();          // sinon Chrome affiche sa propre barre
      deferredPrompt = e;
      if (!snoozed()) showBanner();
    });
    window.addEventListener('appinstalled', () => { deferredPrompt = null; hideBanner(); });

    $('install-go')?.addEventListener('click', open);
    $('install-close')?.addEventListener('click', () => { snooze(); hideBanner(); });
    $('ios-install-close')?.addEventListener('click', closeIOSSheet);
    $('ios-install-later')?.addEventListener('click', () => { snooze(); closeIOSSheet(); hideBanner(); });

    // iOS ne préviendra jamais : on décide nous-mêmes d'afficher la bannière,
    // et seulement après quelques secondes pour ne pas couvrir la caméra.
    if (isIOS() && !snoozed()) setTimeout(showBanner, 6000);
  }

  document.addEventListener('DOMContentLoaded', init);
  return { open, isInstalled, isIOS };
})();
