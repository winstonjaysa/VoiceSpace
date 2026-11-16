// echoes-client-v2.js — Echolocation browser client, backend v2 (ES module, no build step).
// DROP-IN SUPERSET of v1 echoes-client.js: every v1 export keeps its name, arguments, return shape and error
// codes. New: recordListen, reportEcho, mapEchoes, hotEchoes, setPrivateZone/myPrivateZone/clearPrivateZone,
// echoDetails, setEchoText, echoesByTag, echoReplies, trails, and v2 fields on dropEcho / nearby rows.
//
//   import * as echoes from './echoes-client-v2.js';
//   await echoes.init({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
//
// Errors are EchoError with a stable .code (switch on it), .message (v1 codes: server text as in v1;
// new codes: a friendly sentence you can show as-is), .friendly (always a friendly sentence),
// .category ('RATE_LIMITED' | 'BLOCKED' | 'INVALID' | ...), .serverMessage (raw).

const SUPABASE_ESM = 'https://esm.sh/@supabase/supabase-js@2';
const BUCKET = 'echoes';
const DEVICE_KEY = 'echolocation.device';
export const MAX_DURATION_S = 60;
export const MAX_BYTES = 3 * 1024 * 1024;
export const REPORT_REASONS = ['harassment', 'hate', 'sexual', 'personal_info', 'spam', 'danger', 'other'];
/** 004_place.sql: what the dropper was in/on (null = unknown). */
export const PLACE_KINDS = ['building', 'road', 'park', 'other'];

const EXT_BY_MIME = {
  'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/aac': 'aac',
};
// RPCs that only exist after migration-v2.sql. If one is missing we raise V2_MISSING (NOT SCHEMA_MISSING),
// so callers like js/echo-store.js don't mistake "v2 not pasted yet" for "backend down" and fall back to local.
const V2_RPCS = new Set(['drop_echo_v2', 'record_listen', 'report_echo', 'map_echoes', 'hot_echoes', 'echo_details',
  'set_echo_text', 'echoes_by_tag', 'echo_replies', 'create_trail', 'add_to_trail', 'set_trail_order', 'trail_echoes',
  'nearby_trails', 'set_private_zone', 'my_private_zone', 'clear_private_zone']);

let sb = null;
let deviceOverride = null;
let memDeviceId = null;

export class EchoError extends Error {
  constructor(code, message, cause, extra = {}) {
    super(message); this.name = 'EchoError'; this.code = code; this.cause = cause;
    Object.assign(this, { friendly: message, category: code, serverMessage: message }, extra);
  }
}

/** Friendly text for every code (v2 server codes + v1 client codes). */
export const FRIENDLY = {
  RATE_LIMIT_MINUTE: 'Easy — wait a minute before dropping another echo.',
  RATE_LIMIT_HOUR: "You've dropped a lot of echoes this hour. Try again a bit later.",
  RATE_LIMIT_DAY: "You've reached today's echo limit. Come back tomorrow.",
  RATE_LIMIT_SPOT: 'You already have several echoes on this exact spot. Try somewhere else.',
  RATE_LIMIT_IP: 'Too many echoes from this network right now. Try again later.',
  RATE_LIMIT_REPORTS: "You've sent a lot of reports. Try again later.",
  RATE_LIMIT_LISTENS: 'Too many listens from this device right now.',
  RATE_LIMIT_TRAILS: "You've created enough trails for today.",
  RATE_LIMITED: 'Too many echoes from this device. Try again later.',
  ZONE_BLOCKED: "Echoes can't be dropped here (protected area, e.g. near a school or playground).",
  BANNED: 'This device can no longer drop echoes.',
  PRIVATE_ZONE_COOLDOWN: 'Your private zone can only be moved once a day.',
  REPLY_TOO_FAR: 'Walk back to the original echo to reply (within 50 m).',
  TRAIL_FULL: 'This trail is full.',
  INVALID_UNLOCK_AT: 'Pick an unlock time between 1 minute and 1 year from now.',
  INVALID_TAG: 'Tags can use letters, numbers, _ or - (max 32 characters, 8 tags).',
  INVALID_PLACE: 'That place info is not valid (kind: building/road/park/other, name up to 120 characters, level -10 to 200).',
  INVALID_REASON: 'Pick a reason for the report.',
  TOO_FAR: 'Walk closer to hear this echo.',
  FADED: 'This echo has faded.',
  ALREADY_RESONATED: 'You already resonated this one.',
  OWN_ECHO: "That one's your own echo.",
  NOT_YOURS: "That isn't yours.",
  UPLOAD: 'The recording failed to upload. Try again.',
  INVALID: 'Something about that request was not valid.',
  FORBIDDEN: 'Not allowed.',
  NETWORK: 'No connection. Check your network and try again.',
  SCHEMA_MISSING: 'The backend is not set up yet.',
  V2_MISSING: 'This feature needs the v2 backend update (migration-v2.sql) — not installed yet.',
  NOT_INITIALISED: 'Not connected yet.',
  UNKNOWN: 'Something went wrong.',
};
const CATEGORY = (code) =>
  code.startsWith('RATE_LIMIT') ? 'RATE_LIMITED' :
  ['ZONE_BLOCKED', 'BANNED', 'PRIVATE_ZONE_COOLDOWN'].includes(code) ? 'BLOCKED' :
  code.startsWith('INVALID') ? 'INVALID' : code;

function toEchoError(err, fn) {
  const m = String(err?.message || err || '');
  if (err?.code === 'PGRST202') {
    return V2_RPCS.has(fn)
      ? new EchoError('V2_MISSING', FRIENDLY.V2_MISSING, err, { serverMessage: m, category: 'V2_MISSING' })
      : new EchoError('SCHEMA_MISSING', 'backend not set up yet: run schema.sql in the Supabase SQL editor', err, { friendly: FRIENDLY.SCHEMA_MISSING, serverMessage: m });
  }
  // v2 server errors: 'CODE: text'
  const tagged = /^([A-Z][A-Z_]{2,}): (.*)$/s.exec(m);
  if (tagged) {
    const code = tagged[1];
    const friendly = FRIENDLY[code] || tagged[2];
    return new EchoError(code, friendly, err, { friendly, category: CATEGORY(code), serverMessage: m });
  }
  if (err?.code === '42501' || /permission denied/i.test(m)) return new EchoError('FORBIDDEN', m, err, { friendly: FRIENDLY.FORBIDDEN, serverMessage: m });
  const code =                                   // v1 mapping, unchanged
    /too far/i.test(m) ? 'TOO_FAR' :
    /not found or faded/i.test(m) ? 'FADED' :
    /already resonated/i.test(m) ? 'ALREADY_RESONATED' :
    /own echo/i.test(m) ? 'OWN_ECHO' :
    /too many/i.test(m) ? 'RATE_LIMITED' :
    /not yours/i.test(m) ? 'NOT_YOURS' :
    /not uploaded|already used/i.test(m) ? 'UPLOAD' :
    /invalid|must|unsupported|max/i.test(m) ? 'INVALID' :
    /fetch|network|failed to/i.test(m) ? 'NETWORK' : 'UNKNOWN';
  return new EchoError(code, m, err, { friendly: FRIENDLY[code] || m, category: CATEGORY(code), serverMessage: m });
}

function client() {
  if (!sb) throw new EchoError('NOT_INITIALISED', 'call init({url, anonKey}) first');
  return sb;
}
async function rpc(fn, args) {
  const { data, error } = await client().rpc(fn, args);
  if (error) throw toEchoError(error, fn);
  return data;
}
const one = (rows) => (Array.isArray(rows) ? rows[0] : rows) ?? null;

export async function init({ url, anonKey, createClient, deviceId } = {}) {
  if (!url || !anonKey) throw new EchoError('INVALID', 'init needs {url, anonKey}');
  if (/^sb_secret_|service_role/.test(anonKey)) throw new EchoError('INVALID', 'never use the secret/service_role key in the client');
  const create = createClient || (await import(/* @vite-ignore */ SUPABASE_ESM)).createClient;
  sb = create(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  if (deviceId) deviceOverride = deviceId;
  return sb;
}

export function getDeviceId() {
  if (deviceOverride) return deviceOverride;
  const make = () => globalThis.crypto?.randomUUID?.() || 'd' + String(Math.random()).slice(2) + Date.now();
  const valid = (id) => /^[A-Za-z0-9_-]{8,64}$/.test(id || '');
  try {
    let id = globalThis.localStorage?.getItem(DEVICE_KEY);
    if (!valid(id)) { id = make(); globalThis.localStorage?.setItem(DEVICE_KEY, id); }
    if (id) return id;
  } catch { /* storage blocked */ }
  return (memDeviceId ||= make());
}

const baseMime = (t) => String(t || '').split(';')[0].trim().toLowerCase();
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const pick = (...v) => v.find((x) => x !== undefined && x !== null);
const iso = (d) => (d == null ? null : new Date(d).toISOString());

/**
 * dropEcho({ blob, lat, lng, accuracyM|accuracy, headingDeg|heading, altitudeM|altitude, durationS|durationMs, caption,
 *            // v2, all optional:
 *            placeLabel, blurred, parentId, unlockAt (Date|ISO), trailId, transcript, tags: string[],
 *            // 004_place.sql, all optional (snake_case place_kind / place_name also accepted):
 *            placeKind: 'building'|'road'|'park'|'other', placeName: string (<= 120 chars), level: integer -10..200 }) -> echo id
 * Without v2-only fields this calls drop_echo exactly like v1 (place_label/blurred/place_* are only sent when given).
 * If the database doesn't have 004 yet, the drop is retried once without place_kind/place_name/level (never lost).
 * Invalid place values throw EchoError INVALID_PLACE before anything is uploaded.
 * Privacy: for blurred:true echoes the server never shows placeName/level publicly (only placeKind).
 */
export async function dropEcho(o = {}) {
  const { blob, lat, lng, caption } = o;
  const accuracy = pick(o.accuracyM, o.accuracy);
  const heading = pick(o.headingDeg, o.heading);
  const altitude = pick(o.altitudeM, o.altitude);
  const durationS = o.durationS != null ? Number(o.durationS) : o.durationMs != null ? Number(o.durationMs) / 1000 : NaN;
  if (!blob || !blob.size) throw new EchoError('INVALID', 'no audio recorded');
  if (blob.size > MAX_BYTES) throw new EchoError('INVALID', 'recording too large (max 3 MB)');
  if (!(durationS > 0 && durationS <= MAX_DURATION_S)) throw new EchoError('INVALID', 'duration must be 0–60 s');
  const mime = baseMime(blob.type) || 'audio/webm';
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new EchoError('INVALID', `unsupported audio type ${blob.type}`);
  const parentId = pick(o.parentId, o.parent_id), unlockAt = pick(o.unlockAt, o.unlock_at), trailId = pick(o.trailId, o.trail_id);
  const placeLabel = pick(o.placeLabel, o.place_label);
  const place = placeArgs(o);
  const v2 = parentId != null || unlockAt != null || trailId != null || o.transcript != null || (o.tags && o.tags.length);
  const path = `${globalThis.crypto.randomUUID()}.${ext}`;

  const up = await client().storage.from(BUCKET).upload(path, blob, { contentType: mime, upsert: false, cacheControl: '86400' });
  if (up.error) throw toEchoError(up.error, 'upload');

  const args = {
    lat, lng,
    accuracy_m: num(accuracy), heading_deg: num(heading), altitude_m: num(altitude),
    audio_path: path, duration_s: Math.round(durationS * 100) / 100, mime_type: mime,
    device_id: getDeviceId(), caption: caption?.trim() || null,
  };
  if (placeLabel != null && String(placeLabel).trim()) args.place_label = String(placeLabel).trim().slice(0, 120);
  if (o.blurred != null) args.blurred = !!o.blurred;
  const fn = v2 ? 'drop_echo_v2' : 'drop_echo';
  const full = !v2 ? args : {
    ...args, parent_id: parentId ?? null, unlock_at: iso(unlockAt), trail_id: trailId ?? null,
    transcript: o.transcript?.trim() || null, tags: o.tags?.length ? o.tags : null,
  };
  if (!Object.keys(place).length) return rpc(fn, full);
  try {
    return await rpc(fn, { ...full, ...place });
  } catch (e) {
    // 004_place.sql not applied yet: PostgREST doesn't know the place_* args -> drop without them
    if (e?.cause?.code === 'PGRST202') return rpc(fn, full);
    throw e;
  }
}
/** place_kind / place_name / level args for drop_echo(_v2), validated + cleaned like the server does. */
function placeArgs(o) {
  const out = {};
  const kind = pick(o.placeKind, o.place_kind), name = pick(o.placeName, o.place_name), level = pick(o.level, o.placeLevel, o.place_level);
  const bad = (msg) => new EchoError('INVALID_PLACE', FRIENDLY.INVALID_PLACE, null, { category: 'INVALID', serverMessage: msg });
  if (kind != null && String(kind).trim()) {
    const k = String(kind).trim().toLowerCase();
    if (!PLACE_KINDS.includes(k)) throw bad(`place_kind must be one of ${PLACE_KINDS.join(', ')}`);
    out.place_kind = k;
  }
  if (name != null) {
    // eslint-disable-next-line no-control-regex
    const n = String(name).replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();
    if ([...n].length > 120) throw bad('place_name max 120 chars');
    if (n) out.place_name = n;
  }
  if (level != null && level !== '') {
    const l = Number(level);
    if (!Number.isInteger(l) || l < -10 || l > 200) throw bad('level must be an integer between -10 and 200');
    out.level = l;
  }
  return out;
}

/** nearbyEchoes({lat,lng,radiusM}) -> raw rows (v1 columns + heat, listen_count, reply_count, parent_id, unlock_at, tags, place_label, blurred) */
export async function nearbyEchoes({ lat, lng, radiusM = 150 } = {}) {
  return (await rpc('nearby_echoes', { lat, lng, radius_m: radiusM })) || [];
}
export async function unlockEcho(id, { lat, lng, accuracyM, accuracy } = {}) {
  const path = await rpc('unlock_echo', { echo_id: id, lat, lng, accuracy_m: num(pick(accuracyM, accuracy)) });
  return client().storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}
export async function resonate(id, { lat, lng, accuracyM, accuracy } = {}) {
  const r = one(await rpc('resonate', { echo_id: id, device_id: getDeviceId(), lat, lng, accuracy_m: num(pick(accuracyM, accuracy)) }));
  return { expiresAt: new Date(r.expires_at).toISOString(), resonanceCount: r.resonance_count };
}
export async function retractEcho(id) {
  return rpc('retract_echo', { echo_id: id, device_id: getDeviceId() });
}
export async function debugEchoes({ lat, lng, radiusM = 2000 } = {}) {
  return (await rpc('debug_echoes', { lat, lng, radius_m: radiusM })) || [];
}

// ---------------------------------------------------------------------------- v2
/** Call when playback stops or ends. Gate: within 50 m + min(accuracy, 40). Own echoes return recorded:false. */
export async function recordListen(id, { lat, lng, accuracyM, accuracy, listenedMs, completed = false } = {}) {
  const r = one(await rpc('record_listen', {
    echo_id: id, device_id: getDeviceId(), lat, lng, accuracy_m: num(pick(accuracyM, accuracy)),
    listened_ms: listenedMs == null ? null : Math.max(0, Math.round(listenedMs)), completed: !!completed,
  }));
  return { recorded: r.recorded, heat: r.heat, listenCount: r.listen_count };
}
/** reportEcho(id, reason, {lat,lng}?) -> { hidden, reportCount }. reason ∈ REPORT_REASONS. Repeat reports are no-ops. */
export async function reportEcho(id, reason, { lat, lng } = {}) {
  const r = one(await rpc('report_echo', { echo_id: id, device_id: getDeviceId(), reason, lat: num(lat), lng: num(lng) }));
  return { hidden: r.hidden, reportCount: r.report_count };
}
const toPin = (r) => ({
  id: r.id, lat: r.lat ?? r.echo_lat, lng: r.lng ?? r.echo_lng, radiusM: r.radius_m ?? r.pin_radius_m ?? 0,
  blurred: !!r.blurred, heat: r.heat ?? 0, resonanceCount: r.resonance_count ?? 0, listenCount: r.listen_count ?? 0,
  replyCount: r.reply_count ?? 0, createdAt: r.created_at ?? null, expiresAt: r.expires_at ?? null,
  tags: r.tags ?? [], placeLabel: r.place_label ?? null, distanceM: r.distance_m ?? null,
  // 004 (null before 004 / on rows that don't carry them; placeName + level are always null for blurred echoes)
  durationS: r.duration_s ?? null, placeKind: r.place_kind ?? null, placeName: r.place_name ?? null, level: r.level ?? null,
});
/** Live map: pins in a viewport (max 2°). Exact unless the echo was dropped with blurred:true (then a stable 30–60 m glow).
 *  Pins: {id, lat, lng, radiusM, blurred, heat, resonanceCount, listenCount, replyCount, createdAt, expiresAt,
 *         durationS, placeKind, placeName, level} (last 4 need 004_place.sql; null otherwise). */
export async function mapEchoes({ minLat, minLng, maxLat, maxLng } = {}) {
  return ((await rpc('map_echoes', { min_lat: minLat, min_lng: minLng, max_lat: maxLat, max_lng: maxLng })) || []).map(toPin);
}
/** Hottest echoes around a point (same pins as mapEchoes), hottest first. */
export async function hotEchoes({ lat, lng, radiusM = 2000, maxRows = 100 } = {}) {
  return ((await rpc('hot_echoes', { lat, lng, radius_m: radiusM, max_rows: maxRows })) || []).map(toPin);
}
export async function echoesByTag({ lat, lng, tag, radiusM = 2000 } = {}) {
  return ((await rpc('echoes_by_tag', { lat, lng, tag, radius_m: radiusM })) || []).map(toPin);
}
/** Caption, transcript, tags, place label… gated like unlock (25 m + pad). */
export async function echoDetails(id, { lat, lng, accuracyM, accuracy } = {}) {
  const r = one(await rpc('echo_details', { echo_id: id, lat, lng, accuracy_m: num(pick(accuracyM, accuracy)) }));
  return r && {
    id: r.id, caption: r.caption, transcript: r.transcript, tags: r.tags || [], placeLabel: r.place_label,
    durationS: r.duration_s, mimeType: r.mime_type, createdAt: r.created_at, expiresAt: r.expires_at, unlockAt: r.unlock_at,
    parentId: r.parent_id, trailIds: r.trail_ids || [], resonanceCount: r.resonance_count, listenCount: r.listen_count,
    replyCount: r.reply_count, heat: r.heat, blurred: r.blurred,
  };
}
/** Dropper adds/replaces transcript and/or tags later (null = keep). */
export async function setEchoText(id, { transcript = null, tags = null } = {}) {
  return rpc('set_echo_text', { echo_id: id, device_id: getDeviceId(), transcript, tags });
}
/** Replies (flat thread) of an echo, nearby-shaped rows. */
export async function echoReplies(id, { lat, lng } = {}) {
  return (await rpc('echo_replies', { echo_id: id, lat, lng })) || [];
}
export async function createTrail({ name, description = null } = {}) {
  return rpc('create_trail', { device_id: getDeviceId(), name, description });
}
export async function addToTrail(trailId, echoId) {
  return rpc('add_to_trail', { echo_id: echoId, device_id: getDeviceId(), trail_id: trailId });
}
export async function setTrailOrder(trailId, echoIds) {
  return rpc('set_trail_order', { trail_id: trailId, device_id: getDeviceId(), echo_ids: echoIds });
}
/** Visible stops in order: [{stop, id, lat, lng, radiusM, expiresAt, resonanceCount, heat, placeLabel, trailName}] */
export async function trailEchoes(trailId) {
  return ((await rpc('trail_echoes', { trail_id: trailId })) || []).map((r) => ({ ...toPin(r), stop: r.stop, trailName: r.trail_name, trailDescription: r.trail_description }));
}
export async function nearbyTrails({ lat, lng, radiusM = 2000 } = {}) {
  return ((await rpc('nearby_trails', { lat, lng, radius_m: radiusM })) || []).map((r) => ({
    id: r.trail_id, name: r.name, description: r.description, echoIds: r.echo_ids || [], stopCount: r.stop_count,
    startLat: r.start_lat, startLng: r.start_lng, distanceM: r.distance_m, createdAt: r.created_at,
  }));
}
/** Private home zone: nobody can drop inside; your own echoes inside are hidden. Radius clamped 50–150 m, 90-day life. */
export async function setPrivateZone({ lat, lng, radiusM = 100 } = {}) {
  const r = one(await rpc('set_private_zone', { device_id: getDeviceId(), lat, lng, radius_m: radiusM }));
  return r && { lat: r.zone_lat, lng: r.zone_lng, radiusM: r.zone_radius_m, expiresAt: r.expires_at };
}
export async function myPrivateZone() {
  const r = one(await rpc('my_private_zone', { device_id: getDeviceId() }));
  return r ? { lat: r.zone_lat, lng: r.zone_lng, radiusM: r.zone_radius_m, expiresAt: r.expires_at } : null;
}
export async function clearPrivateZone() {
  return rpc('clear_private_zone', { device_id: getDeviceId() });
}

// ---------------------------------------------------------------------------- hunt adapter
// v1 fields unchanged; v2 rows add heat, placeLabel, parentId, tags, replyCount, listenCount, blurred;
// 004 adds durationS, placeKind, placeName, level
// (undefined/defaults on a v1 database). The adapter also offers recordListen().
const toHunt = (r) => ({
  id: r.id, lat: r.echo_lat, lng: r.echo_lng,
  distanceM: r.distance_m, bearingDeg: r.bearing_deg,
  headingDeg: r.heading_deg, altitudeM: r.altitude_m,
  expiresAt: r.expires_at,
  resonanceCount: r.resonance_count,
  heat: r.heat ?? 0, placeLabel: r.place_label ?? null, parentId: r.parent_id ?? null, tags: r.tags ?? [],
  replyCount: r.reply_count ?? 0, listenCount: r.listen_count ?? 0, blurred: !!r.blurred,
  durationS: r.duration_s ?? null, placeKind: r.place_kind ?? null, placeName: r.place_name ?? null, level: r.level ?? null,
});
export function createHuntAdapter({ debug = false } = {}) {
  return {
    name: debug ? 'supabase-debug' : 'supabase',
    async nearby({ lat, lng, radiusM = 300 } = {}) {
      const rows = debug ? await debugEchoes({ lat, lng, radiusM }) : await nearbyEchoes({ lat, lng, radiusM });
      return rows.map(toHunt);
    },
    unlock: (id, { lat, lng, accuracyM } = {}) => unlockEcho(id, { lat, lng, accuracyM }),
    resonate: (id, { lat, lng, accuracyM } = {}) => resonate(id, { lat, lng, accuracyM }),
    recordListen: (id, q = {}) => recordListen(id, q),
  };
}
export const huntAdapter = createHuntAdapter();
export const createSupabaseSource = createHuntAdapter;
