// Trails: chain echoes into a walk. Build (createTrail + drop with trailId) and walk (next stop, distance, bearing).
import { distanceM, bearingDeg, gpsPad } from './geo.js';
export const ARRIVE_M = 25;   // same as the unlock radius

export async function startTrail(client, { name, description } = {}) {
  const n = String(name ?? '').trim();
  if (!n) throw Object.assign(new Error('Give the trail a name'), { code: 'INVALID' });
  const r = await client.createTrail({ name: n.slice(0, 80), description: description?.trim() || null });
  return typeof r === 'object' && r ? r.id ?? r.trail_id ?? r : r;
}
export const dropOnTrail = (client, trailId, drop) => client.dropEcho({ ...drop, trailId });

// createTrailWalk({ client, trailId, onState }) -> { load, update(fix), markVisited(id), state() }
// state: { name, stops:[{id,lat,lng,stop,visited}], next, index, distanceM, bearingDeg, arrived, done, progress }
export function createTrailWalk({ client, trailId, onState, arriveM = ARRIVE_M }) {
  let stops = [], name = '', description = '', i = 0, last = null, fix = null;
  const emit = () => { last = compute(); onState?.(last); return last; };
  function compute() {
    const next = stops[i] || null, done = stops.length > 0 && i >= stops.length;
    let d = null, b = null, arrived = false;
    if (next && fix) { d = distanceM(fix, next); b = bearingDeg(fix, next); arrived = d <= arriveM + gpsPad(fix.accuracy) + (next.radiusM || 0); }
    return { name, description, stops, next, index: i, distanceM: d, bearingDeg: b, arrived, done,
      progress: stops.length ? Math.min(i, stops.length) / stops.length : 0 };
  }
  return {
    async load() {
      const rows = await client.trailEchoes(trailId);
      stops = rows.map((r) => ({ id: r.id, lat: r.lat, lng: r.lng, stop: r.stop, radiusM: r.radiusM ?? r.radius_m ?? 0, placeLabel: r.placeLabel ?? r.place_label ?? null, visited: false }));
      name = rows[0]?.trailName ?? rows[0]?.trail_name ?? ''; description = rows[0]?.trailDescription ?? rows[0]?.trail_description ?? '';
      i = 0; return emit();
    },
    update(f) { fix = f; return emit(); },
    // call after the stop's echo is unlocked/heard (or when arrived and user taps "next")
    markVisited(id = stops[i]?.id) {
      const k = stops.findIndex((s) => s.id === id);
      if (k >= 0) stops[k].visited = true;
      while (i < stops.length && stops[i].visited) i++;
      return emit();
    },
    skip() { if (i < stops.length) i++; return emit(); },
    state: () => last || compute(),
  };
}

export async function trailsNearMe(client, { lat, lng, radiusM = 2000 }) {
  return client.nearbyTrails({ lat, lng, radiusM });
}
