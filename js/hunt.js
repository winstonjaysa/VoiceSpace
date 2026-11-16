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

function targetedSource(base, targetId) {
  const src = {
    ...base, echoes: [], targetId,
    async nearby(q = {}) {
      const all = await base.nearby({ ...q, radiusM: Math.max(q.radiusM || 0, 500) });
      return (src.echoes = all.filter(e => e.id === targetId));
    },
    unlock: (id, q) => base.unlock(id, q),
    resonate: (id, q) => base.resonate(id, q),
  };
  return src;
}

const CSS = `
.hx{display:flex;flex-direction:column;align-items:center;gap:18px;padding:12px 12px 24px;text-align:center}
.hx-stage{position:relative;width:min(78vw,320px);aspect-ratio:1;display:grid;place-items:center}
.hx-stage::before{content:"";position:absolute;inset:-18%;border-radius:50%;background:radial-gradient(closest-side,rgba(143,211,232,.16),rgba(143,211,232,0) 70%);pointer-events:none}
.hx-ring,.hx-rip{position:absolute;inset:0;border-radius:50%;border:1px solid rgba(190,226,240,.22)}
.hx-ring{box-shadow:0 0 60px rgba(143,211,232,.10) inset,0 0 40px rgba(143,211,232,.08);transition:filter .3s,border-color .3s}
.hx-rip{opacity:0;border-color:rgba(190,226,240,.55)}
.hx-core{width:10px;height:10px;border-radius:50%;background:#eef6ff;box-shadow:0 0 18px 6px rgba(190,226,240,.45)}
.hx-word{font-size:2.1rem;font-weight:300;letter-spacing:.18em;text-transform:uppercase;min-height:2.6rem;color:#eef2f8}
.hx-note{color:rgba(214,222,236,.62);min-height:1.2rem;font-size:.92rem;letter-spacing:.02em}
.hx button{font:inherit;font-weight:500;padding:13px 24px;border-radius:14px;border:1px solid rgba(214,226,246,.18);background:rgba(255,255,255,.06);color:#eef2f8;min-height:48px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
.hx-res{display:none}.hx-res.show{display:inline-block;border-color:rgba(242,211,176,.45);color:#f6e6d2;box-shadow:0 0 28px rgba(242,211,176,.12)}
.hx-tap{display:none}
@media (prefers-reduced-motion: reduce){.hx-ring{transition:none}}`;

// targetId (v2 map: "Walk to it"): hunt only that echo. The engine then asks for 500 m (the server max) so it starts
// pinging as early as possible; beyond that the host screen guides toward the echo's glow on its own.
export async function startHunt(container, { store, desk = new URLSearchParams(location.search).has('desk'), onState, targetId = null, options = {} } = {}) {
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

  const base = typeof store.createHuntSource === 'function' ? store.createHuntSource() : storeSource(store);
  const source = targetId ? targetedSource(base, targetId) : base;
  const hunt = createHunt({ source, onState: render, onPing: p => pulse(p.distanceM < 40 ? 1 : 0.7),
    options: { ...(targetId ? { searchRadiusM: 500 } : {}), ...(desk ? { useDeviceGeolocation: false, useDeviceCompass: false } : {}), ...options } });
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
