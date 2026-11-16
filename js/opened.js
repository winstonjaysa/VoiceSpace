// opened.js: what this device has opened (unlocked and heard), a found count + day streak, per-echo durations,
// and "seen" ids for the "N new echoes near you" badge. All local (localStorage); nothing leaves the phone.
const K = { opened: 'echolocation.opened', stats: 'echolocation.stats', dur: 'echolocation.durations', seen: 'echolocation.seen' };
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const cap = (obj, n) => { const e = Object.entries(obj); return e.length > n ? Object.fromEntries(e.sort((a, b) => b[1] - a[1]).slice(0, n)) : obj; };

let opened = load(K.opened, {});            // id -> ms opened
let durs = load(K.dur, {});                 // id -> duration ms
let seen = load(K.seen, {});                // id -> ms first seen
export const events = new EventTarget();

export const isOpened = (id) => Boolean(opened[id]);
export function markOpened(id) {
  if (!id || opened[id]) return false;
  opened = cap({ ...opened, [id]: Date.now() }, 800); save(K.opened, opened);
  const s = stats(); const today = dayKey(Date.now());
  const streak = s.lastDay === today ? s.streak : s.lastDay === dayKey(Date.now() - 864e5) ? s.streak + 1 : 1;
  save(K.stats, { found: s.found + 1, streak, lastDay: today });
  events.dispatchEvent(new CustomEvent('opened', { detail: { id } }));
  return true;
}
function dayKey(t) { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
/** { found, streak (consecutive days with an opened echo, 0 if broken), lastDay } */
export function stats() {
  const s = load(K.stats, { found: 0, streak: 0, lastDay: null });
  const alive = s.lastDay === dayKey(Date.now()) || s.lastDay === dayKey(Date.now() - 864e5);
  return { ...s, streak: alive ? s.streak : 0 };
}

export const durationMs = (id) => durs[id] || null;
export function setDuration(id, ms) {
  if (!id || !(ms > 0) || durs[id] === Math.round(ms)) return;
  durs = cap({ ...durs, [id]: Math.round(ms) }, 800); save(K.dur, durs);
}

/** ids never seen before on this device (for the "new nearby" badge). markSeen() when the user looks. */
export function unseen(ids) { return ids.filter((id) => !seen[id]); }
export function markSeen(ids) {
  let changed = false; const now = Date.now();
  for (const id of ids) if (!seen[id]) { seen[id] = now; changed = true; }
  if (changed) { seen = cap(seen, 1500); save(K.seen, seen); }
}
export function firstRunSeedSeen(ids) { if (!Object.keys(seen).length) markSeen(ids); }
