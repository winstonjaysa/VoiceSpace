// fx.js: motion + feedback helpers. Springs run on rAF with transforms only (compositor-friendly, 60 fps);
// everything collapses to instant changes under prefers-reduced-motion.
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Vibrate where supported (Android Chrome; iOS Safari ignores it). Patterns: 'tick' | 'tap' | 'success' | 'warn' | number[] */
const PAT = { tick: 8, tap: 14, success: [18, 40, 28], warn: [30, 60, 30], drop: [10, 30, 60] };
export function haptic(p = 'tap') {
  try { if (navigator.vibrate && !reduced()) navigator.vibrate(PAT[p] ?? p); } catch { /* ignore */ }
}

/** Critically-damped-ish spring from -> to. onUpdate(v) each frame; resolves when settled. */
export function spring(from, to, onUpdate, { stiffness = 420, damping = 34, mass = 1, velocity = 0, precision = 0.4 } = {}) {
  if (reduced()) { onUpdate(to); return { stop() {}, done: Promise.resolve() }; }
  let x = from, v = velocity, raf = 0, last = performance.now(), stopped = false, resolve;
  const done = new Promise((r) => { resolve = r; });
  const step = (t) => {
    if (stopped) return;
    const dt = Math.min(0.032, (t - last) / 1000); last = t;
    const a = (-stiffness * (x - to) - damping * v) / mass;
    v += a * dt; x += v * dt;
    if (Math.abs(v) < precision * 10 && Math.abs(x - to) < precision) { onUpdate(to); resolve(); return; }
    onUpdate(x); raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return { stop() { stopped = true; cancelAnimationFrame(raf); resolve(); }, done };
}

/** Cherry burst: little cherries + sparks fly out from (x, y) in viewport px. */
export function cherryBurst(x, y, { count = 14 } = {}) {
  haptic('success');
  if (reduced()) return;
  const host = document.createElement('div'); host.className = 'burst'; host.setAttribute('aria-hidden', 'true');
  host.style.left = `${x}px`; host.style.top = `${y}px`;
  for (let i = 0; i < count; i++) {
    const s = document.createElement('i');
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.4, d = 60 + Math.random() * 70;
    s.style.setProperty('--dx', `${Math.cos(a) * d}px`); s.style.setProperty('--dy', `${Math.sin(a) * d - 30}px`);
    s.style.setProperty('--r', `${Math.round(Math.random() * 360 - 180)}deg`);
    s.style.animationDelay = `${Math.random() * 60}ms`;
    s.className = i % 3 === 0 ? 'b-cherry' : 'b-spark';
    if (i % 3 === 0) s.textContent = '\u{1F352}';
    host.appendChild(s);
  }
  document.body.appendChild(host);
  setTimeout(() => host.remove(), 1200);
}

/** Make a bottom sheet draggable with springs. getSnaps() -> [y px offsets], index is the current snap. */
export function draggableSheet(el, handle, { getSnaps, onSnap = () => {}, start = 0 } = {}) {
  let snapIx = start, y = 0, anim = null, drag = null;
  const set = (v) => { y = v; el.style.transform = `translate3d(0, ${v.toFixed(1)}px, 0)`; };
  const snapTo = (ix, velocity = 0) => {
    const snaps = getSnaps(); snapIx = Math.max(0, Math.min(snaps.length - 1, ix));
    anim?.stop(); anim = spring(y, snaps[snapIx], set, { velocity, stiffness: 380, damping: 32 });
    onSnap(snapIx); return anim.done;
  };
  handle.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    anim?.stop(); drag = { id: e.pointerId, y0: e.clientY, from: y, t: performance.now(), last: e.clientY, v: 0, moved: false };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const snaps = getSnaps(), min = Math.min(...snaps), max = Math.max(...snaps);
    let ny = drag.from + (e.clientY - drag.y0);
    if (ny < min) ny = min - Math.sqrt(min - ny) * 4;                // rubber band
    if (ny > max) ny = max + Math.sqrt(ny - max) * 4;
    const now = performance.now(); drag.v = (e.clientY - drag.last) / Math.max(1, now - drag.t) * 1000; drag.t = now; drag.last = e.clientY;
    if (Math.abs(e.clientY - drag.y0) > 6) drag.moved = true;
    set(ny);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.moved) { handle.dispatchEvent(new CustomEvent('sheettap')); return; }
    const snaps = getSnaps(); const proj = y + d.v * 0.18;             // project with velocity
    let best = 0; snaps.forEach((s, i) => { if (Math.abs(s - proj) < Math.abs(snaps[best] - proj)) best = i; });
    haptic('tick'); snapTo(best, d.v);
  };
  handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  set(getSnaps()[snapIx]);
  return { snapTo, get index() { return snapIx; }, refresh() { set(getSnaps()[snapIx]); } };
}
