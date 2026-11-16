// Where is this fix, really? Indoors (which building / mall / floor), on a street, or outside.
// One Mapbox Tilequery call (same pk token the map already uses, CORS-ok, no new API key).
// placeContext(fix, { token }) -> { setting, venue, building, nearby[], floorHint, onRoad, road, snap }
// snapDrop(fix, ctx) -> { lat, lng, snapped, reason }: pulls a pin that indoor GPS drift threw onto the road
// back into the building you're most likely in (only when that building is inside the accuracy circle).
import { distanceM } from './geo.js';

const DRIVE = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'street', 'street_limited', 'service']);
const BIG = new Set(['retail', 'commercial', 'mall', 'university', 'hospital', 'hotel', 'office', 'train_station', 'transportation', 'school', 'stadium', 'civic', 'public']);

function nudgeInside(from, edge, metres = 4) {   // step past the building edge, away from the road point
  const d = distanceM(from, edge) || 1, k = 1 + metres / d;
  return { lat: from.lat + (edge.lat - from.lat) * k, lng: from.lng + (edge.lng - from.lng) * k };
}

export function parseTilequery(json, fix) {
  const feats = (json?.features || []).map((f) => ({
    layer: f.properties?.tilequery?.layer, d: f.properties?.tilequery?.distance ?? 1e9,
    p: f.properties || {}, at: { lng: f.geometry?.coordinates?.[0], lat: f.geometry?.coordinates?.[1] },
  }));
  const bInside = feats.filter((f) => f.layer === 'building' && f.d < 0.5);
  const bNear = feats.filter((f) => f.layer === 'building' && f.d >= 0.5).sort((a, b) => a.d - b.d);
  const roads = feats.filter((f) => f.layer === 'road').sort((a, b) => a.d - b.d);
  const drive = roads.find((r) => DRIVE.has(r.p.class));
  const pois = feats.filter((f) => f.layer === 'poi_label' && f.p.name).sort((a, b) => a.d - b.d);
  const land = feats.find((f) => f.layer === 'landuse' && f.d < 0.5);
  const GREEN = /^(park|grass|garden|wood|scrub|pitch|cemetery|wetland|national_park|playground|golf_course|sand|glacier)$/;
  const parkLand = feats.find((f) => f.layer === 'landuse' && GREEN.test(f.p.class || '') && f.d < 0.5)
    || (land && GREEN.test(land.p.class || '') ? land : null);
  const parkName = pois.find((f) => f.p.class === 'park_like' && f.d < 150)?.p.name || null;
  const levelRx = /\b(?:level|lvl|floor)\s*([A-Z]?\d{1,2})\b/i;
  const levelRoad = roads.find((r) => levelRx.test(r.p.name || ''));
  const indoorWalk = roads.find((r) => r.d < 25 && (r.p.class === 'path' || r.p.class === 'pedestrian') && levelRx.test(r.p.name || ''));
  const venueName = (levelRoad?.p.name || '').replace(levelRx, '').trim() || null;   // "Eaton Centre level 2" -> "Eaton Centre"
  const building = bInside[0] ? { type: bInside.find((b) => b.p.type && b.p.type !== 'building:part')?.p.type || bInside[0].p.type || 'building', heightM: Math.max(...bInside.map((b) => b.p.height || 0)) || null } : null;

  const onRoad = !building && !!drive && drive.d < 6;
  const setting = building || indoorWalk ? 'indoors' : onRoad ? 'street' : parkLand ? 'park' : 'outdoors';
  const venue = setting === 'indoors' ? (venueName || (BIG.has(building?.type) && pois[0]?.p.class === 'store_like' ? 'shopping area' : null)) : null;
  const floorHint = indoorWalk ? (indoorWalk.p.name.match(levelRx)?.[1] ?? null) : null;

  let snap = null;
  if (onRoad && bNear[0]) snap = { building: bNear[0].p.type || 'building', edgeM: bNear[0].d, point: nudgeInside(fix, bNear[0].at) };
  const label = setting === 'indoors'
    ? `Inside ${venue || (building?.type && !/^building/.test(building.type) ? `a ${building.type} building` : 'a building')}${floorHint ? `, level ${floorHint}` : ''}`
    : setting === 'street' ? `On ${drive.p.name || 'the street'}`
    : setting === 'park' ? (parkName ? `In ${parkName}` : 'In a park')
    : pois[0] && pois[0].d < 40 ? `Near ${pois[0].p.name}` : 'Outside';

  return { setting, label, venue, park: setting === 'park' ? parkName : null, building, floorHint, onRoad, road: drive ? { name: drive.p.name || null, class: drive.p.class, distanceM: drive.d } : null,
    nearby: pois.slice(0, 5).map((f) => ({ name: f.p.name, kind: f.p.class, distanceM: Math.round(f.d) })), snap };
}

export async function placeContext(fix, { token, radiusM = 40, fetchImpl = globalThis.fetch, signal } = {}) {
  if (!token || fix?.lat == null) return null;
  const r = Math.min(60, Math.max(radiusM, Math.min(fix.accuracy ?? 0, 60)));
  const url = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${fix.lng},${fix.lat}.json?radius=${r}&limit=40&dedupe=true&layers=building,road,poi_label,landuse,landuse_overlay&access_token=${encodeURIComponent(token)}`;
  try { const res = await fetchImpl(url, { signal }); return res.ok ? parseTilequery(await res.json(), fix) : null; } catch { return null; }
}

// Only snaps when: the fix is on a driveable road, not in any building, accuracy is worse than 8 m,
// and the nearest building edge is within that accuracy. Otherwise the pin stays exactly where GPS put it.
export function snapDrop(fix, ctx) {
  const acc = fix?.accuracy ?? fix?.accuracyM ?? 0;
  if (!ctx?.snap) return { lat: fix.lat, lng: fix.lng, snapped: false, reason: 'not-on-road' };
  if (acc <= 8) return { lat: fix.lat, lng: fix.lng, snapped: false, reason: 'gps-good' };
  if (ctx.snap.edgeM > acc) return { lat: fix.lat, lng: fix.lng, snapped: false, reason: 'building-too-far' };
  return { ...ctx.snap.point, snapped: true, reason: 'road-to-building', movedM: Math.round(distanceM(fix, ctx.snap.point)) };
}

// Map a context onto night crawler's 004 drop fields: dropEcho({ ...toDropPlace(ctx, { blurred }) }).
// placeKind: building|road|park|other; placeName <=120 chars; level: integer -10..200 ("B1" -> -1, "P2" -> -2).
// Blurred drops send only the kind (a building name or floor would undo the blur).
export function levelFromHint(h) {
  if (h == null) return null;
  const m = String(h).trim().match(/^([A-Za-z]?)(\d{1,3})$/); if (!m) return null;
  const n = Number(m[2]) * (/[bp]/i.test(m[1]) ? -1 : 1);
  return Number.isInteger(n) && n >= -10 && n <= 200 ? n : null;
}
export function toDropPlace(ctx, { blurred = false } = {}) {
  if (!ctx) return {};
  const placeKind = ctx.setting === 'indoors' ? 'building' : ctx.setting === 'street' ? 'road'
    : ctx.setting === 'park' ? 'park' : 'other';
  if (blurred) return { placeKind };
  const name = ctx.setting === 'indoors' ? ctx.venue || ctx.nearby?.[0]?.name || null : ctx.setting === 'street' ? ctx.road?.name || null : ctx.setting === 'park' ? ctx.park || null : ctx.nearby?.[0]?.distanceM < 40 ? ctx.nearby[0].name : null;
  const out = { placeKind };
  if (name) out.placeName = String(name).slice(0, 120);
  const level = levelFromHint(ctx.floorHint); if (level != null) out.level = level;
  return out;
}
