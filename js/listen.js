// listen.js: the hunt overlay (v2). Opened from the map: "Walk to it" (one target echo) or "Listen" (nearest).
// Hosts js/hunt.js -> hunt-core.js (night crawler's engine) unchanged. Exact echo positions are only ever known
// inside the engine (nearby_echoes within 500 m); beyond that we guide toward the echo's fuzzy glow.
import * as store from './echo-store.js';
import { startHunt } from './hunt.js';
import { markOpened } from './opened.js';
import { haptic, cherryBurst } from './fx.js';
import { echoPlace, placeSentence, placeContext, nearestEntrance, cardinal } from './place.js';

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
export function openHunt(root, { target = null, onClose = () => {}, onState, initialFix = null, onError = () => {} } = {}) {
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
      <p class="hunt-place" data-place hidden></p>
      <p class="hunt-foot" data-foot role="status">Headphones help · hold your phone upright, like a lantern</p>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const guide = $('[data-guide]'), arrow = $('[data-arrow]'), gdist = $('[data-gdist]'), gnote = $('[data-gnote]');
  const chip = $('[data-chip]'), foot = $('[data-foot]');
  let hunt = null, closed = false;

  // place context: "It's inside Square One, level 2. Head to the nearest entrance (Door 3, 120 m NE)"
  const placeEl = $('[data-place]');
  const tp = target ? echoPlace(target) : null;
  if (tp?.text) {
    placeEl.hidden = false; placeEl.dataset.kind = tp.kind; placeEl.textContent = placeSentence(tp) || tp.text;
    root.dataset.placeKind = tp.kind;
    if (tp.kind === 'indoor' && tp.name && !(target.blurred || target.radius_m > 0)) {
      placeContext({ lat: target.lat, lng: target.lng, accuracy: 15 }).then((ctx) => {
        if (closed || !ctx.entrances?.length) return;
        const from = window.__huntState?.position || initialFix || target;
        const e = nearestEntrance(ctx.entrances, from); if (!e) return;
        const what = e.name ? e.name.replace(/^./, (c) => c.toUpperCase()) : 'Entrance';
        placeEl.textContent = placeSentence(tp, { entrance: `${what}, ${fmtDist(e.distM)} ${cardinal(e.bearing)}` });
        root.dataset.entrance = `${e.lat.toFixed(6)},${e.lng.toFixed(6)}`;
      }).catch(() => {});
    }
  }

  if (target?.expires_at) {
    const h = Math.max(0, (Date.parse(target.expires_at) - Date.now()) / 3.6e6);
    chip.textContent = h >= 1 ? `fades in ${Math.round(h)} h` : `fades in ${Math.max(1, Math.round(h * 60))} min`;
  } else chip.hidden = true;

  // rewards: haptic ticks as the tune-in clears, a cherry burst the first time an echo opens on this device
  let tickBucket = -1, lastTick = 0, playing = null;
  const onHuntState = (s) => {
    const t = s.tuning;
    if (t && t.status !== 'playing') tickBucket = -1;
    if (t?.status === 'playing') {
      if (!playing || playing.id !== t.id) {
        playing = { id: t.id, at: Date.now() };
        if (markOpened(t.id)) { const r = root.getBoundingClientRect(); cherryBurst(r.width / 2, r.height * 0.42); root.dataset.opened = t.id; }
      }
      const b = Math.floor((t.alignment || 0) * 8);                     // 8 steps from noise to clear
      if (b > tickBucket && performance.now() - lastTick > 110) { haptic(b >= 7 ? 'success' : 'tick'); lastTick = performance.now(); }
      tickBucket = b;
    }
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
    else if (s.location?.coarse && s.location.help) foot.textContent = `${s.location.help.title}: ${s.location.help.steps.join(' ')}`;
    else if (s.location?.level === 'weak') foot.textContent = 'GPS is weak here. Step outside for a better signal.';
    try { onState?.(s); } catch { /* host hook */ }
  };

  function close() {
    if (closed) return; closed = true;
    if (playing && store.mapMode === 'map_echoes') {          // play count (migration-v2 record_listen); skipped before it
      const pos = window.__huntState?.position || initialFix;
      store.v2Client().then((c) => c && pos && c.rpc('record_listen', { echo_id: playing.id, device_id: store.getDeviceId(), lat: pos.lat, lng: pos.lng,
        accuracy_m: pos.accuracy ?? null, listened_ms: Date.now() - playing.at, completed: false })).catch(() => {});
    }
    hunt?.stop(); hunt = null; root.innerHTML = ''; onClose();
  }
  $('[data-close]').addEventListener('click', close);

  // synchronous: startHunt does its gesture-bound work before its first await
  startHunt($('[data-hunt]'), { store, onState: onHuntState, targetId: target?.id || null, options: { initialFix } }).then((h) => {
    if (closed) h.stop(); else hunt = h;
  }, (e) => {
    console.warn('[listen] hunt failed to start', e);
    onError(e);
    foot.textContent = `Couldn't start listening: ${e.message || e}`;
  });
  return { close, get hunt() { return hunt; } };
}
