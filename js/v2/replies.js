// Replies at the same spot. Server rules: parent visible, drop within 50 m + gpsPad(accuracy), flat threads.
import { distanceM, gpsPad } from './geo.js';
export const REPLY_RADIUS_M = 50;

// parent: {lat,lng} (hunt/map row), fix: {lat,lng,accuracy}
export function canReplyHere(parent, fix, radiusM = REPLY_RADIUS_M) {
  if (!parent || !fix || parent.lat == null || fix.lat == null) return { ok: false, reason: 'no-fix', distanceM: null };
  const d = distanceM(parent, fix), limit = radiusM + gpsPad(fix.accuracy ?? fix.accuracyM);
  return { ok: d <= limit, reason: d <= limit ? null : 'too-far', distanceM: d, limitM: limit, moveM: Math.max(0, d - limit) };
}

// client = echoes-client-v2 module. drop = the normal dropEcho args (blob, lat, lng, accuracy, durationS, ...).
export async function replyTo(client, parent, drop) {
  const chk = canReplyHere(parent, drop);
  if (!chk.ok && chk.reason === 'too-far') {
    const e = new Error(`Walk ${Math.ceil(chk.moveM)} m closer to reply here`); e.code = 'REPLY_TOO_FAR'; throw e;
  }
  return client.dropEcho({ ...drop, parentId: parent.parentId || parent.id });   // reply to a reply = reply to its root
}

// Thread oldest-first: [{id, lat, lng, distanceM, expiresAt, createdAt, ...}]
export async function loadThread(client, parentId, { lat, lng }) {
  const rows = await client.echoReplies(parentId, { lat, lng });
  return rows.map((r) => ({ id: r.id, lat: r.echo_lat, lng: r.echo_lng, distanceM: r.distance_m, bearingDeg: r.bearing_deg,
    expiresAt: r.expires_at, createdAt: r.created_at, resonanceCount: r.resonance_count, heat: r.heat, listenCount: r.listen_count }));
}
