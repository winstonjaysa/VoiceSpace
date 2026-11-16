// desk-sim.js — "desk mode": fake position + heading on a laptop so the hunt can be tried without walking.
// Keys: W/↑ forward, S/↓ back, A/D or ←/→ turn, Q/E strafe, R/F pitch up/down, Shift = fine steps,
// G = warp to 30 m from the nearest echo. Sliders for heading/pitch, a GPS-jitter toggle.
// Usage: createDeskSim({ hunt, source, start: { lat, lng } })   (hunt created with useDeviceGeolocation/Compass: false)

import { destinationPoint, initialBearing, haversine, normDeg } from './hunt-math.js';

export function createDeskSim({ hunt, source, start = { lat: 43.6532, lng: -79.3832 }, altitude = 80, mount = document.body, gpsHz = 1 }) {
  let pos = { ...start }, heading = 0, pitch = 0, jitter = false, timer = null;

  const el = document.createElement('div');
  el.className = 'desk-sim';
  el.innerHTML = `
    <style>
      .desk-sim{position:fixed;left:8px;bottom:8px;z-index:50;font:11px/1.5 ui-monospace,Menlo,monospace;color:#9ab;background:rgba(10,14,20,.85);border:1px solid #234;border-radius:10px;padding:8px 10px;max-width:260px}
      .desk-sim b{color:#cde;font-weight:600}.desk-sim input[type=range]{width:150px;vertical-align:middle}
      .desk-sim button{font:inherit;color:#cde;background:#123;border:1px solid #345;border-radius:6px;padding:2px 7px;margin:2px 1px;cursor:pointer}
    </style>
    <div><b>desk mode</b> — WASD/arrows, Q/E strafe, R/F pitch, G warp</div>
    <div>heading <input type="range" min="0" max="359" value="0" data-k="heading"> <span data-o="heading">0°</span></div>
    <div>pitch&nbsp;&nbsp; <input type="range" min="-60" max="80" value="0" data-k="pitch"> <span data-o="pitch">0°</span></div>
    <div><button data-a="fwd">▲</button><button data-a="back">▼</button><button data-a="left">⟲</button><button data-a="right">⟳</button><button data-a="warp">warp</button>
    <label><input type="checkbox" data-k="jitter"> gps jitter</label></div>
    <div data-o="info"></div>`;
  mount.appendChild(el);
  const $ = s => el.querySelector(s);

  function push(raw = !jitter) {
    let p = pos, acc = 4;
    if (jitter) { acc = 6 + Math.random() * 10; p = destinationPoint(pos.lat, pos.lng, Math.random() * 360, Math.random() * acc); }
    hunt.injectPosition({ lat: p.lat, lng: p.lng, accuracy: acc, altitude }, { raw });
  }
  function turn(d) { heading = normDeg(heading + d); hunt.injectHeading(heading, pitch); render(); }
  function move(dist, side = 0) { pos = destinationPoint(pos.lat, pos.lng, heading + side, dist); push(); render(); }
  function warp() {
    const es = source?.echoes || []; if (!es.length) return;
    const e = es.map(x => ({ ...x, d: haversine(pos.lat, pos.lng, x.lat, x.lng) })).sort((a, b) => a.d - b.d)[0];
    const b = initialBearing(e.lat, e.lng, pos.lat, pos.lng);
    pos = destinationPoint(e.lat, e.lng, b, 30); push(true); render();
  }
  function render() {
    $('[data-k=heading]').value = Math.round(heading); $('[data-o=heading]').textContent = Math.round(heading) + '°';
    $('[data-k=pitch]').value = Math.round(pitch); $('[data-o=pitch]').textContent = Math.round(pitch) + '°';
    const es = (source?.echoes || []).map(x => `${x.id.split('-')[1]}: ${haversine(pos.lat, pos.lng, x.lat, x.lng).toFixed(0)}m @${initialBearing(pos.lat, pos.lng, x.lat, x.lng).toFixed(0)}°`);
    $('[data-o=info]').textContent = `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}  ${es.join(' · ')}`;
  }

  el.addEventListener('input', e => {
    const k = e.target.dataset.k;
    if (k === 'heading') { heading = +e.target.value; hunt.injectHeading(heading, pitch); }
    if (k === 'pitch') { pitch = +e.target.value; hunt.injectHeading(heading, pitch); }
    if (k === 'jitter') jitter = e.target.checked;
    render();
  });
  el.addEventListener('click', e => {
    const a = e.target.dataset.a; if (!a) return;
    ({ fwd: () => move(2), back: () => move(-2), left: () => turn(-10), right: () => turn(10), warp })[a]();
  });
  const onKey = e => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    const f = e.shiftKey ? 0.5 : 2, rot = e.shiftKey ? 2 : 10;
    const k = e.key.toLowerCase();
    const act = { w: () => move(f), arrowup: () => move(f), s: () => move(-f), arrowdown: () => move(-f),
      a: () => turn(-rot), arrowleft: () => turn(-rot), d: () => turn(rot), arrowright: () => turn(rot),
      q: () => move(f, -90), e: () => move(f, 90), r: () => { pitch = Math.min(80, pitch + 5); turn(0); }, f: () => { pitch = Math.max(-60, pitch - 5); turn(0); }, g: warp }[k];
    if (act) { act(); e.preventDefault(); }
  };
  window.addEventListener('keydown', onKey);

  return {
    begin() { push(true); hunt.injectHeading(heading, pitch); render(); timer = setInterval(() => { push(); render(); }, 1000 / gpsHz); },
    destroy() { clearInterval(timer); window.removeEventListener('keydown', onKey); el.remove(); },
    get position() { return { ...pos }; }, get heading() { return heading; },
    setPosition(p) { pos = { ...pos, ...p }; push(true); render(); }, setHeading(h) { heading = normDeg(h); hunt.injectHeading(heading, pitch); render(); },
  };
}
