// hunt.js — VoiceSpace seam (startHunt) wired to night crawler's hunt engine (hunt-core.js + hunt-math.js).
// Adapts js/echo-store.js (raptor) to the engine's source contract { nearby, unlock, resonate }.
// Origin: trax's /home/box/shared/echolocation/integration/js/hunt.js (copied 2026-11-03); raptor additions:
//   - ?desk in the page URL => desk mode (keyboard/sliders fake position+heading; js/desk-sim.js)
//   - source.echoes (last nearby list, needed by desk-sim's warp) and resonanceCount passthrough
//   - opts.onState hook for the host screen
//   - prefers store.createHuntSource(): night crawler's createSupabaseSource() (js/echoes-client.js) while Supabase
//     works, IndexedDB fallback otherwise. storeSource() below (trax) is kept for stores without it.
// nearby_echoes now returns real echo_lat/echo_lng, so the destPoint path below is only a safety net.
import { createHunt } from './hunt-core.js';

export const HUNT_IMPLEMENTED = true;

const toRad = d => d * Math.PI / 180;
function bearing(lat1, lng1, lat2, lng2) {
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Supabase hides echo positions (only distance + bearing from where you asked). The engine ranks by lat/lng,
// so rebuild the point from the query position + distance + bearing (great-circle destination).
function destPoint(lat, lng, distM, brgDeg) {
  const R = 6371e3, d = distM / R, b = toRad(brgDeg), p1 = toRad(lat), l1 = toRad(lng);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * 180 / Math.PI, lng: ((l2 * 180 / Math.PI + 540) % 360) - 180 };
}

function storeSource(store) {
  const seen = new Map();                         // id -> store echo (getAudioUrl wants the echo object)
  const src = {
    echoes: [],                                   // last nearby() result (desk-sim warp reads this)
    name: 'store:' + (store.backendName ?? '?'),
    async nearby({ lat, lng, radiusM }) {
      const rows = await store.nearbyEchoes(lat, lng, radiusM);
      return (src.echoes = rows.filter(e => !store.isExpired?.(e)).map(e => {
        seen.set(e.id, e);
        const hasPos = Number.isFinite(e.lat) && Number.isFinite(e.lng);  // local backend has positions, Supabase gives distance+bearing
        const pt = hasPos ? { lat: e.lat, lng: e.lng }
          : Number.isFinite(e.distance_m) && Number.isFinite(e.bearing_deg) ? destPoint(lat, lng, e.distance_m, e.bearing_deg) : null;
        return {
          id: e.id, lat: pt?.lat, lng: pt?.lng,
          distanceM: e.distance_m ?? (hasPos ? store.haversineM(lat, lng, e.lat, e.lng) : Infinity),
          bearingDeg: e.bearing_deg ?? (hasPos ? bearing(lat, lng, e.lat, e.lng) : 0),
          headingDeg: e.heading ?? null, altitudeM: e.altitude ?? null,
          expiresAt: Date.parse(e.expires_at), resonanceCount: e.resonance_count ?? 0,
        };
      }).filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lng)));
    },
    async unlock(id, { lat, lng }) { return store.getAudioUrl(seen.get(id) || { id }, { lat, lng }); },
    async resonate(id, { lat, lng }) {
      const r = await store.resonate(id, { lat, lng });
      return { expiresAt: Date.parse(r.expires_at), resonanceCount: Number.isFinite(r.resonance_count) ? r.resonance_count : undefined };
    },
  };
  return src;
}

const CSS = `
.hx{display:flex;flex-direction:column;align-items:center;gap:14px;padding:24px 12px;text-align:center}
.hx-stage{position:relative;width:min(70vw,260px);aspect-ratio:1;display:grid;place-items:center}
.hx-ring,.hx-rip{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(255,255,255,.18)}
.hx-rip{opacity:0}
.hx-core{width:14px;height:14px;border-radius:50%;background:#fff;opacity:.35}
.hx-word{font-size:1.6rem;letter-spacing:.04em;min-height:2rem}
.hx-note{opacity:.65;min-height:1.2rem;font-size:.95rem}
.hx button{font:inherit;padding:12px 22px;border-radius:999px;border:1px solid rgba(255,255,255,.3);background:transparent;color:inherit;min-height:44px}
.hx-res{display:none}.hx-res.show{display:inline-block}
.hx-tap{display:none}`;

export async function startHunt(container, { store, desk = new URLSearchParams(location.search).has('desk'), onState } = {}) {
  container.innerHTML = `<style>${CSS}</style><div class="hx">
    <div class="hx-stage"><div class="hx-rip"></div><div class="hx-rip"></div><div class="hx-ring"></div><div class="hx-core"></div></div>
    <div class="hx-word"></div><div class="hx-note">finding you…</div>
    <button class="hx-res">Resonate · keep it another day</button>
    <button class="hx-tap">Tap to hear</button></div>`;
  const $ = s => container.querySelector(s);
  const rips = [...container.querySelectorAll('.hx-rip')]; let ri = 0;
  const NOTES = { locating: 'finding you…', searching: 'silence, for now', starting: '' };
  const render = s => {
    const ring = $('.hx-ring'), word = $('.hx-word'), note = $('.hx-note');
    if (s.tuning && s.status === 'tuning') {
      const a = s.tuning.alignment;
      ring.style.filter = `blur(${((1 - a) * 6).toFixed(1)}px)`;
      ring.style.borderColor = `rgba(255,255,255,${(0.15 + 0.6 * a).toFixed(2)})`;
      word.textContent = s.tuning.status === 'unlocking' ? 'here' : s.tuning.resonated ? 'resonated' : s.tuning.locked ? 'clear' : 'tuning';
      note.textContent = s.tuning.error ? 'the signal slipped away' : s.tuning.resonated ? 'it will linger another day' : 'turn slowly';
      $('.hx-res').classList.toggle('show', s.tuning.canResonate && !s.tuning.resonated);
    } else {
      ring.style.filter = ''; ring.style.borderColor = '';
      word.textContent = s.target ? s.target.word : '';
      note.textContent = s.target ? (s.position?.lowConfidence ? 'signal faint' : s.headingSource === 'none' ? 'no compass · walk to steer' : '') : (NOTES[s.status] ?? '');
      if (s.error === 'location-denied') note.textContent = 'location is off — enable it to listen';
      $('.hx-res').classList.remove('show');
    }
    $('.hx-tap').style.display = s.needsTap ? 'inline-block' : 'none';
    window.__huntState = s;
    try { onState?.(s); } catch (e) { console.warn('[hunt] host onState threw', e); }
  };
  const pulse = k => rips[ri++ % rips.length].animate(
    [{ transform: 'scale(.35)', opacity: .75 * k }, { transform: 'scale(1.08)', opacity: 0 }], { duration: 1300, easing: 'cubic-bezier(.2,.6,.3,1)' });

  const source = typeof store.createHuntSource === 'function' ? store.createHuntSource() : storeSource(store);
  const hunt = createHunt({ source, onState: render, onPing: p => pulse(p.distanceM < 40 ? 1 : 0.7),
    options: desk ? { useDeviceGeolocation: false, useDeviceCompass: false } : {} });
  const started = hunt.start();                   // synchronous gesture-bound work happens here (iOS compass + audio)
  $('.hx-res').onclick = () => hunt.resonate().catch(e => { $('.hx-note').textContent = /already/.test(e.message) ? 'you already resonated this one' : /own/.test(e.message) ? "that one's yours" : 'the echo would not hold'; });
  $('.hx-tap').onclick = () => hunt.resumeAudio();
  window.__hunt = hunt;
  await started;
  let sim = null;
  if (desk) {
    const { createDeskSim } = await import('./desk-sim.js');
    const start = store.lastKnownPosition?.() || undefined;
    sim = createDeskSim({ hunt, source, start: start ? { lat: start.lat, lng: start.lng } : undefined });
    sim.begin(); window.__desk = sim;
  }
  return { hunt, stop() { hunt.stop(); sim?.destroy(); container.innerHTML = ''; } };
}
