// Install as an app: Android/desktop Chrome via beforeinstallprompt, iOS Safari via a "Share → Add to Home Screen" hint.
// Everything stays hidden when already running standalone.
const ua = navigator.userAgent || '';
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
export const isIOS = () => /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isIOSSafari = () => isIOS() && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);
let deferred = null; const subs = new Set();
const emit = () => subs.forEach((f) => f(installState()));
export function installState() {
  if (isStandalone()) return { mode: 'installed' };
  if (deferred) return { mode: 'prompt' };
  if (isIOS()) return { mode: isIOSSafari() ? 'ios' : 'ios-other' };
  return { mode: 'none' };
}
export function onInstallChange(f) { subs.add(f); f(installState()); return () => subs.delete(f); }
export async function promptInstall() {
  if (!deferred) return 'unavailable';
  const e = deferred; deferred = null; e.prompt();
  const { outcome } = await e.userChoice.catch(() => ({ outcome: 'dismissed' }));
  emit(); return outcome;
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; emit(); });
window.addEventListener('appinstalled', () => { deferred = null; emit(); });
matchMedia('(display-mode: standalone)').addEventListener?.('change', emit);
