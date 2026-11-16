// listen.js: the hunt overlay (v2). Opened from the map: "Walk to it" (one target echo) or "Listen" (nearest).
// Hosts js/hunt.js -> hunt-core.js (night crawler's engine) unchanged. Exact echo positions are only ever known
// inside the engine (nearby_echoes within 500 m); beyond that we guide toward the echo's fuzzy glow.
import * as store from './echo-store.js';
import { startHunt } from './hunt.js';

const R = 6371008.8, rad = (d) => d * Math.PI / 180;
function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
export const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m / 5) * 5} m`);

/**
 * openHunt(root, { target, onClose, onState }) — MUST be called synchronously inside a tap (iOS audio + compass).
 * target: a map record { id, lat, lng (fuzzed), radius_m, ... } or null for "nearest echo".
 */
export function openHunt(root, { target = null, onClose = () => {}, onState } = {}) {
  root.innerHTML = `
    <div class="hunt" data-hunt-overlay>
      <header class="hunt-top">
        <button class="icon-btn" data-close aria-label="Stop listening">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        <div class="hunt-title">
          <span class="eyebrow">${target ? 'Walking to an echo' : 'Listening'}</span>
          <strong data-title>${target ? 'Follow the sound' : 'Nearest echo'}</strong>
        </div>
        <span class="chip" data-chip></span>
      </header>
      <div class="hunt-stage" data-hunt></div>
      <div class="hunt-guide" data-guide hidden>
        <svg class="guide-arrow" data-arrow viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l6 16-6-4-6 4z"/></svg>
        <div><strong data-gdist></strong><span data-gnote></span></div>
      </div>
      <p class="hunt-foot" data-foot role="status">Headphones help · hold your phone upright, like a lantern</p>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const guide = $('[data-guide]'), arrow = $('[data-arrow]'), gdist = $('[data-gdist]'), gnote = $('[data-gnote]');
  const chip = $('[data-chip]'), foot = $('[data-foot]');
  let hunt = null, closed = false;

  if (target?.expires_at) {
    const h = Math.max(0, (Date.parse(target.expires_at) - Date.now()) / 3.6e6);
    chip.textContent = h >= 1 ? `fades in ${Math.round(h)} h` : `fades in ${Math.max(1, Math.round(h * 60))} min`;
  } else chip.hidden = true;

  const onHuntState = (s) => {
    root.dataset.status = s.status;
    root.dataset.target = s.target?.id || '';
    if (target && !s.target && s.position) {
      // engine doesn't have it yet (> 500 m, or still polling): steer toward the glow centre
      const d = Math.max(0, haversine(s.position, target) - (target.radius_m || 45) * 0.5);
      const brg = bearing(s.position, target);
      const rel = s.heading != null ? (brg - s.heading + 360) % 360 : brg;
      guide.hidden = false;
      arrow.style.transform = `rotate(${rel.toFixed(0)}deg)`;
      gdist.textContent = `~${fmtDist(d)}`;
      gnote.textContent = s.heading != null ? 'head toward the glow · pings start within 500 m' : 'north is up · pings start within 500 m';
    } else if (s.target) {
      guide.hidden = false;
      arrow.style.transform = s.target.relativeDeg != null ? `rotate(${s.target.relativeDeg.toFixed(0)}deg)` : 'none';
      gdist.textContent = s.status === 'tuning' ? 'Here' : `${fmtDist(s.target.distanceM)}`;
      gnote.textContent = s.status === 'tuning' ? 'turn slowly until it clears' : s.target.relativeDeg != null ? 'pings speed up as you close in' : 'walk · pings speed up as you close in';
    } else guide.hidden = true;
    if (s.error === 'location-denied') foot.textContent = 'Location is off. Enable it to listen.';
    try { onState?.(s); } catch { /* host hook */ }
  };

  function close() {
    if (closed) return; closed = true;
    hunt?.stop(); hunt = null; root.innerHTML = ''; onClose();
  }
  $('[data-close]').addEventListener('click', close);

  // synchronous: startHunt does its gesture-bound work before its first await
  startHunt($('[data-hunt]'), { store, onState: onHuntState, targetId: target?.id || null }).then((h) => {
    if (closed) h.stop(); else hunt = h;
  }, (e) => {
    console.error('[listen] hunt failed to start', e);
    foot.textContent = `Couldn't start listening: ${e.message || e}`;
  });
  return { close, get hunt() { return hunt; } };
}
