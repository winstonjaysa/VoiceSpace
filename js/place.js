// place.js: where is this spot? Inside a building / mall, on a road, or in a park, from OpenStreetMap (Overpass).
// Free, no token: Overpass with fallback mirrors, cached (memory + localStorage), one request at a time, mirror
// cool-down on 429/5xx. If Overpass is down, falls back to the map's own vector tiles (OpenFreeMap: building
// outlines, roads, parks; no building names), and if that fails too it returns { kind: 'unknown' } and nothing breaks.
// Wording (labels, the road warning) follows Cooker's /home/box/shared/echolocation/v2/cooker/place-context.js.
//
//   const ctx = await placeContext({ lat, lng, accuracy }, { map });   // map: optional MapLibre map for the fallback
//   ctx = { kind: 'indoor'|'road'|'park'|'outdoor'|'unknown', name, label, warn, mall, levels: ['B1','G','1',..],
//           building: { name, rings, extentM }, road: { name, distM }, entrances: [{ lat, lng, name, distM }],
//           snap: { lat, lng, distM, name } | null, source: 'overpass'|'tiles'|'none' }
//   placeLabel(ctx, level, { blurred }) -> 'Inside Square One · L2'   parsePlaceLabel(label) -> { kind, name, level }

export const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
export const ROAD_WARN = 'This pin is in the road. GPS may have drifted. Drag the pin to where you really are.';
const ROAD_HALF_W = { motorway: 12, trunk: 10, primary: 9, secondary: 8, tertiary: 7, unclassified: 5, residential: 5,
  living_street: 4, service: 3.5, road: 5, motorway_link: 6, trunk_link: 6, primary_link: 6, secondary_link: 5, tertiary_link: 5,
  // OpenFreeMap tile classes
  minor: 5, street: 5 };
const SNAP_ACC_M = 20;            // offer "Snap inside" only when GPS is worse than this
const CACHE_KEY = 'echolocation.place.v1';
const CACHE_TTL = 7 * 24 * 3600e3;
const CACHE_MAX = 30;
const R = 6371008.8, rad = (d) => d * Math.PI / 180;

// ------------------------------------------------------------------------------------------------ geometry (metres)
function frame(o) { const kx = R * rad(1) * Math.cos(rad(o.lat)), ky = R * rad(1); return {
  xy: (p) => [(p.lng - o.lng) * kx, (p.lat - o.lat) * ky], ll: ([x, y]) => ({ lat: o.lat + y / ky, lng: o.lng + x / kx }) }; }
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  const q = [a[0] + t * dx, a[1] + t * dy]; return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), q };
}
function inRing(p, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
/** poly = { outer: [ring], inner: [ring] } in metres around the query point (origin = [0,0]). */
export function polyContains(poly, p = [0, 0]) {
  return poly.outer.some((r) => inRing(p, r)) && !poly.inner.some((r) => inRing(p, r));
}
function polyNearest(poly, p = [0, 0]) {
  let best = { d: Infinity, q: null };
  for (const r of [...poly.outer, ...poly.inner]) for (let i = 1; i < r.length; i++) { const s = segDist(p, r[i - 1], r[i]); if (s.d < best.d) best = s; }
  return best;
}
function polyArea(poly) {
  const a = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(s / 2); };
  return poly.outer.reduce((t, r) => t + a(r), 0) - poly.inner.reduce((t, r) => t + a(r), 0);
}
function polyExtent(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of poly.outer) for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return Math.max(x1 - x0, y1 - y0);
}
/** Nearest point a few metres INSIDE the polygon (for "Snap inside"). */
export function interiorPoint(poly, p = [0, 0]) {
  const { q } = polyNearest(poly, p); if (!q) return null;
  const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1;
  for (const k of [3, 6, 10, 16]) { const c = [q[0] + (dx / L) * k, q[1] + (dy / L) * k]; if (polyContains(poly, c)) return c; }
  // concave edge: walk toward the ring's centroid
  const r = poly.outer[0]; const cx = r.reduce((s, v) => s + v[0], 0) / r.length, cy = r.reduce((s, v) => s + v[1], 0) / r.length;
  for (let t = 0.1; t <= 1; t += 0.1) { const c = [q[0] + (cx - q[0]) * t, q[1] + (cy - q[1]) * t]; if (polyContains(poly, c)) return c; }
  return null;
}
/** Join open way segments ([[lng,lat],...]) into closed rings. */
function joinRings(lines) {
  const rings = [], pool = lines.map((l) => l.slice()).filter((l) => l.length > 1);
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  while (pool.length) {
    let cur = pool.shift();
    for (let guard = 0; guard < 500 && !same(cur[0], cur[cur.length - 1]); guard++) {
      const i = pool.findIndex((l) => same(l[0], cur[cur.length - 1]) || same(l[l.length - 1], cur[cur.length - 1]));
      if (i < 0) break;
      const l = pool.splice(i, 1)[0]; cur = cur.concat(same(l[0], cur[cur.length - 1]) ? l.slice(1) : l.reverse().slice(1));
    }
    if (cur.length >= 4) rings.push(cur);
  }
  return rings;
}

// ------------------------------------------------------------------------------------------------ naming
const TYPE_WORD = { retail: 'a retail building', commercial: 'an office building', office: 'an office building', apartments: 'an apartment building',
  house: 'a house', residential: 'a residential building', school: 'a school', university: 'a university building', college: 'a college',
  hospital: 'a hospital', church: 'a church', train_station: 'a station', transportation: 'a station', supermarket: 'a supermarket',
  hotel: 'a hotel', industrial: 'an industrial building', warehouse: 'a warehouse', parking: 'a parking garage', garage: 'a garage',
  public: 'a public building', civic: 'a civic building', mall: 'a mall', stadium: 'a stadium' };
function nameOf(tags = {}) {
  if (tags.name) return tags.name;
  if (tags.brand) return tags.brand;
  if (tags['addr:housenumber'] && tags['addr:street']) return `${tags['addr:housenumber']} ${tags['addr:street']}`;
  return null;
}
function typeWord(tags = {}) {
  if (tags.shop === 'mall') return 'a mall';
  return TYPE_WORD[tags.building] || TYPE_WORD[tags.amenity] || TYPE_WORD[tags.shop] || 'a building';
}
const PARK_RE = /^(park|garden|playground|pitch|nature_reserve|common|recreation_ground|dog_park|golf_course|cemetery|track|stadium)$/;

// ------------------------------------------------------------------------------------------------ levels + labels
export function levelOptions(tags = {}, extra = []) {
  const up = Math.round(Number(tags['building:levels'])) || 0, down = Math.round(Number(tags['building:levels:underground'])) || 0;
  const out = [];
  for (let i = Math.min(down || 1, 4); i >= 1; i--) out.push(`B${i}`);
  out.push('G');
  const top = Math.min(Math.max(3, up - 1), 12);
  for (let i = 1; i <= top; i++) out.push(String(i));
  for (const l of extra) if (l && !out.includes(l)) out.push(l);
  return out;
}
export const levelShort = (l) => (!l ? '' : /^\d+$/.test(l) ? `L${l}` : l);
export const levelWords = (l) => (!l ? '' : l === 'G' ? 'ground level' : /^B\d+$/.test(l) ? `basement level ${l}` : /^\d+$/.test(l) ? `level ${l}` : `level ${l}`);

export const KIND_ONLY = { indoor: 'Inside a building', road: 'On a road', park: 'In a park', outdoor: 'Outside' };
/** The stored label. Blurred echoes: the kind only, never a name or a floor (that would undo the blur). */
export function placeLabel(ctx, level = null, { blurred = false } = {}) {
  if (!ctx || ctx.kind === 'unknown' || !ctx.label) return null;
  if (blurred) return KIND_ONLY[ctx.kind] || null;
  return `${ctx.label}${ctx.kind === 'indoor' && level ? ` \u00b7 ${levelShort(level)}` : ''}`.slice(0, 120);
}
/** 004 columns: kind building|road|park|other, level integer (B1 -> -1, G -> 0, '2' -> 2). */
export const KIND_TO_DB = { indoor: 'building', road: 'road', park: 'park', outdoor: 'other' };
export const DB_TO_KIND = { building: 'indoor', road: 'road', park: 'park', other: 'outdoor' };
export const levelToInt = (l) => (l == null || l === '' ? null : l === 'G' ? 0 : /^B(\d+)$/.test(l) ? -Number(l.slice(1)) : /^-?\d+$/.test(l) ? Number(l) : null);
export const intToLevel = (n) => (!Number.isInteger(n) ? null : n === 0 ? 'G' : n < 0 ? `B${-n}` : String(n));
/** Display place for any echo record ({ kind, name, level, text }) or null. Blurred: kind only. */
export function echoPlace(e) {
  if (!e) return null;
  const blurred = Boolean(e.blurred || e.radius_m > 0);
  let p = null;
  if (e.place_kind) p = { kind: DB_TO_KIND[e.place_kind] || 'outdoor', name: e.place_name || null, level: intToLevel(e.level) };
  const parsed = parsePlaceLabel(e.place_label);
  if (!p) p = parsed;
  else if (!p.name && parsed?.name && !blurred) p = { ...p, name: parsed.name, level: p.level ?? parsed.level };
  if (!p) return null;
  if (blurred || !p.name || /^(a|an) (building|road)$/.test(p.name)) return { kind: p.kind, name: null, level: null, text: KIND_ONLY[p.kind] || null };
  const pre = { indoor: 'Inside', road: 'On', park: 'In', outdoor: 'Near' }[p.kind] || 'Near';
  return { ...p, text: `${pre} ${p.name}${p.kind === 'indoor' && p.level ? ` \u00b7 ${levelShort(p.level)}` : ''}` };
}
/** 'Inside Square One · L2' -> { kind: 'indoor', name: 'Square One', level: '2' } (the pre-004 packed form). */
export function parsePlaceLabel(label) {
  if (!label || typeof label !== 'string') return null;
  const m = label.match(/^(Inside|On|In|Near)\s+(.+?)(?:\s+\u00b7\s+(L?\w+))?$/);
  if (!m) return { kind: 'outdoor', name: label, level: null };
  const kind = { Inside: 'indoor', On: 'road', In: 'park', Near: 'outdoor' }[m[1]];
  const lv = m[3] ? m[3].replace(/^L(\d+)$/, '$1') : null;
  return { kind, name: m[2], level: kind === 'indoor' ? lv : null };
}
/** Hunt / card sentence for an echo's place. */
export function placeSentence(p, { entrance = null } = {}) {
  if (!p) return null;
  if (!p.name) return p.kind === 'indoor' ? 'It\u2019s inside a building. GPS is weak indoors, so follow the sound.' : null;
  if (p.kind === 'indoor') {
    const where = /^(a|an) /.test(p.name) ? p.name : p.name;
    return `It\u2019s inside ${where}${p.level ? `, ${levelWords(p.level)}` : ''}. Head to the nearest entrance${entrance ? ` (${entrance})` : ''}; GPS is weak indoors, so follow the sound.`;
  }
  if (p.kind === 'road') return `It was dropped on ${p.name}. Stay on the sidewalk; it may be a few metres off.`;
  if (p.kind === 'park') return `It\u2019s in ${p.name}.`;
  return `It\u2019s near ${p.name}.`;
}

// ------------------------------------------------------------------------------------------------ cache + rate limit
const mem = new Map();
function cacheKey(lat, lng, r) { return `${lat.toFixed(4)},${lng.toFixed(4)},${r}`; }
function cacheGet(k) {
  if (mem.has(k)) return mem.get(k);
  try { const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); const e = all[k]; if (e && Date.now() - e.t < CACHE_TTL) { mem.set(k, e.d); return e.d; } } catch { /* ignore */ }
  return null;
}
function cachePut(k, d) {
  mem.set(k, d);
  try {
    const s = JSON.stringify(d); if (s.length > 120000) return;            // a huge mall relation: memory only
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); all[k] = { t: Date.now(), d };
    const keys = Object.keys(all).sort((a, b) => all[b].t - all[a].t);
    for (const old of keys.slice(CACHE_MAX)) delete all[old];
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch { /* quota: memory only */ }
}
const cool = {};                       // mirror -> retry-after timestamp
let chain = Promise.resolve(), lastAt = 0;
const inflight = new Map();
export const stats = { requests: 0, cacheHits: 0, mirrorUsed: null, lastError: null };

function buildQuery(lat, lng, r) {
  const L = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const ar = `around:${r},${L}`;
  const rr = `around:${Math.max(30, Math.min(r, 60))},${L}`;
  return `[out:json][timeout:12];
is_in(${L})->.a;
(way(pivot.a)[building];rel(pivot.a)[building];way(pivot.a)[shop];rel(pivot.a)[shop];way(pivot.a)[amenity];rel(pivot.a)[amenity];
 way(pivot.a)[leisure];rel(pivot.a)[leisure];way(pivot.a)[tourism];way(pivot.a)[landuse~"^(retail|recreation_ground|cemetery)$"];
 rel(pivot.a)[landuse~"^(retail|recreation_ground|cemetery)$"];way(pivot.a)[indoor][level];)->.inside;
(way(${ar})[building];rel(${ar})[building];way(${ar})[shop=mall];)->.near;
way(${rr})[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]->.roads;
(way.inside[building];way.inside[shop=mall];way.near;)->.bw;
(rel.inside[building];rel.inside[shop=mall];rel.near;)->.br;
way(r.br)->.bm;
(node(w.bw)[entrance];node(w.bm)[entrance];)->.ent;
(.inside;.near;.roads;.ent;);
out tags geom qt;`;
}
// every mirror failed: leave Overpass alone for 5 min (tiles answer meanwhile) instead of retrying on each drop
const DOWN_KEY = 'echolocation.overpass_down_until';
const overpassDown = () => { try { return Number(sessionStorage.getItem(DOWN_KEY)) > Date.now(); } catch { return false; } };
async function overpass(q, { timeoutMs }) {
  if (overpassDown()) throw new Error('overpass backing off');
  try { return await overpassOnce(q, { timeoutMs }); }
  catch (e) { try { sessionStorage.setItem(DOWN_KEY, String(Date.now() + 5 * 60e3)); } catch { /* ignore */ } throw e; }
}
async function overpassOnce(q, { timeoutMs }) {
  const now = Date.now();
  const order = MIRRORS.filter((m) => !(cool[m] > now)).concat(MIRRORS.filter((m) => cool[m] > now));
  let lastErr = null;
  const deadline = Date.now() + timeoutMs;
  for (const m of order) {
    const left = deadline - Date.now(); if (left < 800) break;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), Math.min(left, 7000));
    try {
      stats.requests++;
      const res = await fetch(m, { method: 'POST', body: new URLSearchParams({ data: q }), signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('Retry-After')) || 60; cool[m] = Date.now() + Math.min(600, ra) * 1000;
        throw new Error(`overpass ${res.status}`);
      }
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      const j = await res.json();
      if (j.remark && /runtime error|timed out|out of memory/i.test(j.remark) && !j.elements?.length) { cool[m] = Date.now() + 60000; throw new Error('overpass remark'); }
      stats.mirrorUsed = m; return j;
    } catch (e) { lastErr = e; if (e.name === 'AbortError') cool[m] = Date.now() + 30000; } finally { clearTimeout(t); }
  }
  throw lastErr || new Error('overpass unavailable');
}
/** Raw OSM features around a point (cached; one request in flight; >= 1.1 s between requests). */
export function fetchOsm(lat, lng, accuracy = 20, { timeoutMs = 9000 } = {}) {
  const r = Math.round(Math.max(35, Math.min(120, (accuracy || 20) + 25)) / 10) * 10;
  const k = cacheKey(lat, lng, r);
  const hit = cacheGet(k); if (hit) { stats.cacheHits++; return Promise.resolve(hit); }
  if (inflight.has(k)) return inflight.get(k);
  const p = (chain = chain.catch(() => {}).then(async () => {
    const wait = 1100 - (Date.now() - lastAt); if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    lastAt = Date.now();
    const j = await overpass(buildQuery(lat, lng, r), { timeoutMs });
    const slim = (j.elements || []).map((e) => ({ type: e.type, id: e.id, tags: e.tags || {}, lat: e.lat, lon: e.lon,
      geometry: e.geometry, members: e.members?.filter((m) => m.type === 'way' && m.geometry).map((m) => ({ role: m.role, geometry: m.geometry })) }));
    const d = { lat, lng, r, elements: slim };
    cachePut(k, d); return d;
  })).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

// ------------------------------------------------------------------------------------------------ classify
function toPolys(elements, f) {
  const polys = [];
  for (const e of elements) {
    const t = e.tags || {};
    if (e.type === 'node' || t.highway) continue;
    if (t.building === 'roof' || t.building === 'no' || t.indoor === 'corridor') continue;
    let outer = [], inner = [];
    if (e.type === 'way' && e.geometry?.length >= 4) {
      const g = e.geometry; if (g[0].lat !== g[g.length - 1].lat || g[0].lon !== g[g.length - 1].lon) continue;
      outer = [g.map((p) => [p.lon, p.lat])];
    } else if (e.type === 'relation' && e.members?.length) {
      outer = joinRings(e.members.filter((m) => m.role !== 'inner').map((m) => m.geometry.map((p) => [p.lon, p.lat])));
      inner = joinRings(e.members.filter((m) => m.role === 'inner').map((m) => m.geometry.map((p) => [p.lon, p.lat])));
    }
    if (!outer.length) continue;
    const m = (r) => r.map(([lng, lat]) => f.xy({ lat, lng }));
    polys.push({ id: `${e.type}/${e.id}`, tags: t, outer: outer.map(m), inner: inner.map(m), ll: outer });
  }
  for (const p of polys) { p.area = polyArea(p); p.extentM = polyExtent(p); }
  return polys;
}
/** Classify from a normalised feature set (Overpass or tiles). */
export function classify({ lat, lng, accuracy = 20 }, { polys, roads, entrances = [], source }) {
  const f = frame({ lat, lng }), O = [0, 0];
  const containing = polys.filter((p) => polyContains(p, O)).sort((a, b) => a.area - b.area);
  const isBldg = (p) => p.tags.building || p.tags['building:part'] || p.tags.shop === 'mall';
  const mall = containing.find((p) => p.tags.shop === 'mall' || (p.tags.landuse === 'retail' && nameOf(p.tags) && containing.some(isBldg)));
  const bldg = containing.find(isBldg);
  const park = containing.find((p) => PARK_RE.test(p.tags.leisure || '') || PARK_RE.test(p.tags.landuse || '') || p.tags.tourism === 'zoo' || p.tags.amenity === 'university');
  const indoorLevels = containing.filter((p) => p.tags.indoor && p.tags.level).map((p) => String(p.tags.level).split(';')[0]);
  // nearest road (segment distance in metres)
  let road = null;
  for (const r of roads) {
    const pts = r.coords.map(([x, y]) => f.xy({ lat: y, lng: x }));
    for (let i = 1; i < pts.length; i++) { const s = segDist(O, pts[i - 1], pts[i]); if (!road || s.d < road.distM) road = { name: r.name || null, cls: r.cls, distM: s.d }; }
  }
  const named = roads.length ? (() => { let b = null; for (const r of roads) { if (!r.name) continue; const pts = r.coords.map(([x, y]) => f.xy({ lat: y, lng: x }));
    for (let i = 1; i < pts.length; i++) { const s = segDist(O, pts[i - 1], pts[i]); if (!b || s.d < b.distM) b = { name: r.name, distM: s.d }; } } return b; })() : null;
  const base = { source, accuracy, road: named && named.distM <= 60 ? named : road?.name ? road : null, entrances: [], snap: null, levels: [], mall: false };
  const host = mall && bldg && mall.area >= bldg.area ? mall : bldg || mall;
  if (host) {
    const name = nameOf(mall?.tags) || nameOf(bldg?.tags) || (mall ? 'a mall' : typeWord(bldg.tags));
    const hostEnts = entrances.map((e) => { const xy = f.xy(e); const onEdge = polyNearest(host, xy).d <= 3; return onEdge ? { ...e, distM: Math.hypot(xy[0], xy[1]) } : null; })
      .filter(Boolean).sort((a, b) => a.distM - b.distM);
    return { ...base, kind: 'indoor', name, mall: Boolean(mall), label: `Inside ${name}`,
      levels: levelOptions({ ...(mall?.tags || {}), ...(bldg?.tags || {}) }, indoorLevels),
      building: { name, rings: host.ll, extentM: Math.round(host.extentM), id: host.id }, entrances: hostEnts };
  }
  const half = road ? (ROAD_HALF_W[road.cls] ?? 4) : 0;
  if (road && road.distM <= half + 1.5) {
    const rn = road.name || (named && named.distM <= half + 8 ? named.name : null);   // tiles: names live on a separate layer
    const out = { ...base, kind: 'road', name: rn || 'a road', label: rn ? `On ${rn}` : 'On a road', warn: ROAD_WARN, road: { ...road, name: rn } };
    // weak GPS + a building inside the accuracy circle -> offer to snap inside it (nearest interior point)
    if (accuracy > SNAP_ACC_M) {
      const cands = polys.filter((p) => isBldg(p) && p.area > 60).map((p) => ({ p, d: polyNearest(p, O).d })).filter((c) => c.d <= accuracy)
        .sort((a, b) => (a.d - (nameOf(a.p.tags) ? 8 : 0)) - (b.d - (nameOf(b.p.tags) ? 8 : 0)));
      for (const c of cands) {
        const ip = interiorPoint(c.p, O); if (!ip) continue;
        const ll = f.ll(ip); const name = nameOf(c.p.tags) || typeWord(c.p.tags);
        out.snap = { lat: ll.lat, lng: ll.lng, distM: Math.hypot(ip[0], ip[1]), name, rings: c.p.ll,
          extentM: Math.round(c.p.extentM), levels: levelOptions(c.p.tags), mall: c.p.tags.shop === 'mall' };
        break;
      }
    }
    return out;
  }
  if (park) { const name = nameOf(park.tags) || 'a park'; return { ...base, kind: 'park', name, label: `In ${name}`, building: null }; }
  if (base.road?.name) return { ...base, kind: 'outdoor', name: base.road.name, label: `Near ${base.road.name}` };
  return { ...base, kind: polys.length || roads.length ? 'outdoor' : 'unknown', name: null, label: null };
}
function fromOverpass(d) {
  const f = frame({ lat: d.lat, lng: d.lng });
  const polys = toPolys(d.elements, f);
  const roads = d.elements.filter((e) => e.type === 'way' && e.tags?.highway && e.geometry?.length > 1)
    .map((e) => ({ name: e.tags.name || e.tags.ref || null, cls: e.tags.highway, coords: e.geometry.map((p) => [p.lon, p.lat]) }));
  const entrances = d.elements.filter((e) => e.type === 'node' && e.tags?.entrance)
    .map((e) => ({ lat: e.lat, lng: e.lon, name: e.tags.name || e.tags.ref || (e.tags.entrance === 'main' ? 'main entrance' : null), main: e.tags.entrance === 'main' }));
  return { polys, roads, entrances };
}
/** Fallback: the map's loaded vector tiles (OpenFreeMap/OpenMapTiles schema). Buildings have no names here. */
export function fromTiles(map, { lat, lng }) {
  if (!map?.getStyle) return null;
  const st = map.getStyle(); const src = Object.keys(st.sources || {}).find((k) => st.sources[k].type === 'vector'); if (!src) return null;
  const f = frame({ lat, lng });
  const q = (layer) => { try { return map.querySourceFeatures(src, { sourceLayer: layer }); } catch { return []; } };
  const polys = [];
  const addPoly = (geom, tags) => {
    const list = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
    for (const rings of list) { const m = (r) => r.map(([x, y]) => f.xy({ lat: y, lng: x }));
      const p = { id: 'tile', tags, outer: [m(rings[0])], inner: rings.slice(1).map(m), ll: [rings[0]] }; p.area = polyArea(p); p.extentM = polyExtent(p); polys.push(p); }
  };
  for (const ft of q('building')) addPoly(ft.geometry, { building: 'yes' });
  for (const ft of q('park')) addPoly(ft.geometry, { leisure: 'park', name: ft.properties.name });
  for (const ft of q('landuse')) if (/park|cemetery|recreation/.test(ft.properties.class)) addPoly(ft.geometry, { leisure: 'park' });
  const names = q('transportation_name');
  const roads = [];
  for (const ft of q('transportation')) {
    const cls = ft.properties.class; if (!ROAD_HALF_W[cls] && !/^(primary|secondary|tertiary|trunk|motorway|minor|service)$/.test(cls)) continue;
    const lines = ft.geometry.type === 'LineString' ? [ft.geometry.coordinates] : ft.geometry.type === 'MultiLineString' ? ft.geometry.coordinates : [];
    for (const c of lines) roads.push({ name: null, cls, coords: c });
  }
  for (const ft of names) {
    const lines = ft.geometry.type === 'LineString' ? [ft.geometry.coordinates] : ft.geometry.type === 'MultiLineString' ? ft.geometry.coordinates : [];
    for (const c of lines) roads.push({ name: ft.properties.name || ft.properties['name:latin'] || null, cls: ft.properties.class, coords: c });
  }
  // POIs: a named shop/mall under the point names the building
  const pois = q('poi').filter((p) => p.geometry.type === 'Point' && p.properties.name);
  for (const poly of polys) {
    if (!poly.tags.building) continue;
    const inside = pois.filter((p) => polyContains(poly, f.xy({ lng: p.geometry.coordinates[0], lat: p.geometry.coordinates[1] })));
    const mallPoi = inside.find((p) => /mall|shopping/.test(`${p.properties.class} ${p.properties.subclass}`));
    if (mallPoi) { poly.tags = { building: 'retail', shop: 'mall', name: mallPoi.properties.name }; }
    else if (inside.length === 1) poly.tags = { building: 'yes', name: inside[0].properties.name };
  }
  return { polys, roads, entrances: [] };
}

/** Main entry. Never throws. */
export async function placeContext({ lat, lng, accuracy = 20 }, { map = null, timeoutMs = 9000 } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { kind: 'unknown', label: null, source: 'none' };
  try {
    if (navigator.onLine === false) throw new Error('offline');
    const d = await fetchOsm(lat, lng, accuracy, { timeoutMs });
    return classify({ lat, lng, accuracy }, { ...fromOverpass(d), source: 'overpass' });
  } catch (e) {
    stats.lastError = String(e?.message || e);
    try {
      if (map && !(map.loaded?.() && map.areTilesLoaded?.())) await new Promise((res) => { const t = setTimeout(res, 3000); map.once('idle', () => { clearTimeout(t); res(); }); });
      const t = fromTiles(map, { lat, lng }); if (t && (t.polys.length || t.roads.length)) return classify({ lat, lng, accuracy }, { ...t, source: 'tiles' });
    } catch { /* ignore */ }
    return { kind: 'unknown', label: null, source: 'none', error: stats.lastError };
  }
}
/** Nearest entrance (from a list) to a position: { name, distM, bearing } */
export function nearestEntrance(entrances, from) {
  if (!entrances?.length || !from) return null;
  const f = frame(from);
  const best = entrances.map((e) => { const [x, y] = f.xy(e); return { ...e, distM: Math.hypot(x, y), bearing: (Math.atan2(x, y) * 180 / Math.PI + 360) % 360 }; })
    .sort((a, b) => a.distM - b.distM)[0];
  return best;
}
export const cardinal = (h) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(h / 45) % 8];

// ------------------------------------------------------------------------------------------------ Mapbox (primary)
// trax's js/v2/place-context.js (Mapbox Tilequery). The pk token is never committed: get_app_config() (night crawler's
// 005_app_config.sql) when the backend has it, else localStorage / ?mapbox=. No token -> OSM above -> no label.
import { placeContext as mapboxContext, snapDrop } from './v2/place-context.js';
const TOKEN_KEY = 'echolocation.mapbox_token', CFG_MISS_KEY = 'echolocation.app_config_missing_at';
let tokenP = null;
export function setMapboxToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } tokenP = null; }
export function mapboxToken({ store = null } = {}) {
  if (tokenP) return tokenP;
  tokenP = (async () => {
    try {                                                          // ?mapbox=pk.… once -> remembered, removed from the URL
      const u = new URL(location.href), q = u.searchParams.get('mapbox');
      if (q && /^pk\./.test(q)) { setMapboxToken(q); u.searchParams.delete('mapbox'); history.replaceState(null, '', u.pathname + u.search + u.hash); return q; }
    } catch { /* ignore */ }
    try { const t = localStorage.getItem(TOKEN_KEY); if (t && /^pk\./.test(t)) return t; } catch { /* ignore */ }
    // get_app_config only exists with 005 (after v2 + 004): ask once v2 is live, and remember a miss for 6 h
    try {
      if (!store || store.mapMode !== 'map_echoes') return null;
      const miss = Number(localStorage.getItem(CFG_MISS_KEY)) || 0; if (Date.now() - miss < 6 * 3600e3) return null;
      const sb = await store.supabaseClient(); if (!sb) return null;
      const { data, error } = await sb.rpc('get_app_config');
      if (error) { localStorage.setItem(CFG_MISS_KEY, String(Date.now())); return null; }
      const cfg = typeof data === 'string' ? JSON.parse(data) : data || {};
      const t = cfg.mapbox_token || cfg.mapboxToken || cfg.mapbox_public_token || null;
      return t && /^pk\./.test(t) ? t : null;
    } catch { return null; }
  })();
  tokenP.then((t) => { if (!t) setTimeout(() => { tokenP = null; }, 60000); });
  return tokenP;
}
const BLDG_WORD = (t) => (!t || /^building/.test(t) ? 'a building' : TYPE_WORD[t] || `a ${t.replace(/_/g, ' ')} building`);
/** trax/Mapbox ctx -> the same shape as the OSM classify() result (+ trax's own ctx under .mapbox). */
export function fromMapbox(c, fix) {
  if (!c) return null;
  const roadName = c.road?.name || null;
  const base = { source: 'mapbox', accuracy: fix.accuracy, road: roadName ? { name: roadName, distM: c.road.distanceM } : null,
    entrances: [], levels: [], snap: null, mall: false, mapbox: c, nearby: c.nearby || [] };
  if (c.setting === 'indoors') {
    const venue = c.venue && c.venue !== 'shopping area' ? c.venue : null;
    const name = venue || (c.venue === 'shopping area' ? 'a shopping area' : BLDG_WORD(c.building?.type));
    const lv = c.floorHint ? String(c.floorHint).replace(/^L/i, '') : null;
    return { ...base, kind: 'indoor', name, label: `Inside ${name}`, mall: c.venue === 'shopping area' || c.building?.type === 'retail',
      levels: levelOptions({}, lv ? [lv] : []), floorHint: lv, building: { name, rings: null, extentM: c.building?.type && /retail|mall|commercial/.test(c.building.type) ? 120 : 40 } };
  }
  if (c.setting === 'street') {
    const out = { ...base, kind: 'road', name: roadName || 'a road', label: roadName ? `On ${roadName}` : 'On a road', warn: ROAD_WARN };
    const sd = snapDrop(fix, c);
    if (sd.snapped) out.snap = { lat: sd.lat, lng: sd.lng, distM: sd.movedM, name: BLDG_WORD(c.snap?.building), levels: levelOptions({}) };
    out.snapReason = sd.reason;
    return out;
  }
  if (/park|grass|pitch|cemetery|wood/.test(c.label || '')) return { ...base, kind: 'park', name: c.nearby?.[0]?.name ? `a park near ${c.nearby[0].name}` : 'a park', label: 'In a park' };
  const near = c.nearby?.[0]?.name || roadName;
  return { ...base, kind: 'outdoor', name: near || null, label: near ? `Near ${near}` : null };
}
/**
 * The drop-time resolver: Mapbox (trax) when a token exists, else OSM (Overpass -> map tiles), else unknown.
 * Never throws. opts: { map, store, blurred } (blurred: no snapping, ever).
 */
export async function resolvePlace(fix, { map = null, store = null, blurred = false, timeoutMs = 7000 } = {}) {
  let ctx = null;
  try {
    const token = await mapboxToken({ store });
    if (token) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
      try { ctx = fromMapbox(await mapboxContext(fix, { token, signal: ctl.signal }), fix); } finally { clearTimeout(t); }
    }
  } catch { ctx = null; }
  if (!ctx) ctx = await placeContext(fix, { map, timeoutMs });
  if (blurred && ctx) ctx = { ...ctx, snap: null };
  return ctx;
}
