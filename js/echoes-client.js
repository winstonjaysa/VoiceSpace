// echoes-client.js — Echolocation browser client (ES module, no build step).
//
//   import * as echoes from './backend/echoes-client.js';
//   import { SUPABASE_URL, SUPABASE_ANON_KEY } from './backend/config.js';
//   await echoes.init({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
//
// Works with the new publishable key (sb_publishable_...) and the legacy anon JWT.
// All database access goes through the RPC functions in schema.sql; the only direct
// Storage operation is an upload (INSERT) into the public 'echoes' bucket.

const SUPABASE_ESM = 'https://esm.sh/@supabase/supabase-js@2';
const BUCKET = 'echoes';
const DEVICE_KEY = 'echolocation.device';   // same key hunt/http-source.js and store/ use, so "own echo" checks agree
export const MAX_DURATION_S = 60;
export const MAX_BYTES = 3 * 1024 * 1024;

const EXT_BY_MIME = {
  'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/aac': 'aac',
};

let sb = null;          // supabase client
let deviceOverride = null;
let memDeviceId = null; // fallback when localStorage is unavailable (private mode / Node)

/** Error with a stable .code the UI can switch on. */
export class EchoError extends Error {
  constructor(code, message, cause) { super(message); this.name = 'EchoError'; this.code = code; this.cause = cause; }
}

function toEchoError(err) {
  const m = String(err?.message || err || '');
  if (err?.code === 'PGRST202') return new EchoError('SCHEMA_MISSING', 'backend not set up yet: run schema.sql in the Supabase SQL editor', err);
  if (err?.code === '42501' || /permission denied/i.test(m)) return new EchoError('FORBIDDEN', m, err);
  const code =
    /too far/i.test(m) ? 'TOO_FAR' :
    /not found or faded/i.test(m) ? 'FADED' :
    /already resonated/i.test(m) ? 'ALREADY_RESONATED' :
    /own echo/i.test(m) ? 'OWN_ECHO' :
    /too many/i.test(m) ? 'RATE_LIMITED' :
    /not yours/i.test(m) ? 'NOT_YOURS' :
    /not uploaded|already used/i.test(m) ? 'UPLOAD' :
    /invalid|must|unsupported|max/i.test(m) ? 'INVALID' :
    /fetch|network|failed to/i.test(m) ? 'NETWORK' : 'UNKNOWN';
  return new EchoError(code, m, err);
}

function client() {
  if (!sb) throw new EchoError('NOT_INITIALISED', 'call init({url, anonKey}) first');
  return sb;
}

async function rpc(fn, args) {
  const { data, error } = await client().rpc(fn, args);
  if (error) throw toEchoError(error);
  return data;
}

/**
 * init({ url, anonKey, createClient?, deviceId? })
 * createClient / deviceId are optional injections (used by Node scripts & tests).
 */
export async function init({ url, anonKey, createClient, deviceId } = {}) {
  if (!url || !anonKey) throw new EchoError('INVALID', 'init needs {url, anonKey}');
  if (/^sb_secret_|service_role/.test(anonKey)) throw new EchoError('INVALID', 'never use the secret/service_role key in the client');
  const create = createClient || (await import(/* @vite-ignore */ SUPABASE_ESM)).createClient;
  sb = create(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  if (deviceId) deviceOverride = deviceId;
  return sb;
}

/** Anonymous random device id, persisted in localStorage. */
export function getDeviceId() {
  if (deviceOverride) return deviceOverride;
  const make = () => globalThis.crypto?.randomUUID?.() || 'd' + String(Math.random()).slice(2) + Date.now();
  const valid = (id) => /^[A-Za-z0-9_-]{8,64}$/.test(id || '');   // what the server accepts
  try {
    let id = globalThis.localStorage?.getItem(DEVICE_KEY);
    if (!valid(id)) { id = make(); globalThis.localStorage?.setItem(DEVICE_KEY, id); }
    if (id) return id;
  } catch { /* storage blocked */ }
  return (memDeviceId ||= make());
}

const baseMime = (t) => String(t || '').split(';')[0].trim().toLowerCase();
const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

const pick = (...v) => v.find((x) => x !== undefined && x !== null);

/**
 * dropEcho({ blob, lat, lng, accuracyM|accuracy, headingDeg|heading, altitudeM|altitude,
 *            durationS|durationMs, caption }) -> echo id (uuid)
 * Both naming styles are accepted (store/supabase-store.js uses accuracyM/headingDeg/durationS,
 * raptor's js/echo-store.js uses heading/durationMs). Server max is 60 s.
 * blob: the MediaRecorder Blob (audio/webm on Chrome, audio/mp4 on iOS Safari).
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
  const path = `${globalThis.crypto.randomUUID()}.${ext}`;

  const up = await client().storage.from(BUCKET).upload(path, blob, { contentType: mime, upsert: false, cacheControl: '86400' });
  if (up.error) throw toEchoError(up.error);

  return rpc('drop_echo', {
    lat, lng,
    accuracy_m: num(accuracy), heading_deg: num(heading), altitude_m: num(altitude),
    audio_path: path, duration_s: Math.round(durationS * 100) / 100, mime_type: mime,
    device_id: getDeviceId(), caption: caption?.trim() || null,
  });
}

/** nearbyEchoes({lat,lng,radiusM}) -> raw rows [{ id, echo_lat, echo_lng, distance_m, bearing_deg, heading_deg, altitude_m, expires_at, resonance_count }] */
export async function nearbyEchoes({ lat, lng, radiusM = 150 } = {}) {
  return (await rpc('nearby_echoes', { lat, lng, radius_m: radiusM })) || [];
}

/** unlockEcho(id, {lat,lng,accuracyM}) -> public audio URL. Server gate: <= 25 m + min(accuracyM, 40). Throws TOO_FAR / FADED. */
export async function unlockEcho(id, { lat, lng, accuracyM, accuracy } = {}) {
  const path = await rpc('unlock_echo', { echo_id: id, lat, lng, accuracy_m: num(pick(accuracyM, accuracy)) });
  return client().storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/** resonate(id, {lat,lng,accuracyM}) -> { expiresAt (ISO string), resonanceCount }. Gate: <= 50 m + min(accuracyM, 40).
 *  Throws ALREADY_RESONATED / OWN_ECHO / TOO_FAR / FADED. */
export async function resonate(id, { lat, lng, accuracyM, accuracy } = {}) {
  const rows = await rpc('resonate', { echo_id: id, device_id: getDeviceId(), lat, lng, accuracy_m: num(pick(accuracyM, accuracy)) });
  const r = Array.isArray(rows) ? rows[0] : rows;
  return { expiresAt: new Date(r.expires_at).toISOString(), resonanceCount: r.resonance_count };
}

/** retractEcho(id) -> true. Only the device that dropped the echo can take it back. */
export async function retractEcho(id) {
  return rpc('retract_echo', { echo_id: id, device_id: getDeviceId() });
}

/** DEBUG MAP ONLY: debugEchoes({lat,lng,radiusM}) -> rows incl. echo_lat / echo_lng. Disabled before launch. */
export async function debugEchoes({ lat, lng, radiusM = 2000 } = {}) {
  return (await rpc('debug_echoes', { lat, lng, radius_m: radiusM })) || [];
}

/** The initialised supabase-js client (map feed uses it for the Realtime 'echo-map' channel). */
export function getClient() { return client(); }

/** MAP (needs backend/migrations/002_map_realtime.sql): mapEchoes({minLat,minLng,maxLat,maxLng})
 *  -> [{ id, lat, lng, radius_m, resonance_count, created_at, expires_at }] with lat/lng already FUZZED server-side.
 *  Throws SCHEMA_MISSING before the migration is applied (echo-store then falls back to client-side fuzzing). */
export async function mapEchoes({ minLat, minLng, maxLat, maxLng } = {}) {
  return (await rpc('map_echoes', { min_lat: minLat, min_lng: minLng, max_lat: maxLat, max_lng: maxLng })) || [];
}

const toHunt = (r) => ({
  id: r.id, lat: r.echo_lat, lng: r.echo_lng,          // real coordinates (hunt computes distance/bearing on the phone)
  distanceM: r.distance_m, bearingDeg: r.bearing_deg,
  headingDeg: r.heading_deg, altitudeM: r.altitude_m,
  expiresAt: r.expires_at,                              // ISO string
  resonanceCount: r.resonance_count,
});

/**
 * Source adapter for hunt/hunt.js — matches hunt/README.md "Source adapter contract":
 *   nearby({lat,lng,radiusM=300,accuracyM?,altitudeM?}) -> [{id, lat, lng, expiresAt, resonanceCount, distanceM, bearingDeg, headingDeg, altitudeM}]
 *   unlock(id,{lat,lng,accuracyM}) -> audioUrl (public Storage URL, CORS-enabled)
 *   resonate(id,{lat,lng,accuracyM}) -> {expiresAt, resonanceCount}
 * createHuntAdapter({ debug: true }) uses debug_echoes (wider radius, extra fields) for the Mapbox debug map.
 */
export function createHuntAdapter({ debug = false } = {}) {
  return {
    name: debug ? 'supabase-debug' : 'supabase',
    async nearby({ lat, lng, radiusM = 300 } = {}) {
      const rows = debug ? await debugEchoes({ lat, lng, radiusM }) : await nearbyEchoes({ lat, lng, radiusM });
      return rows.map(toHunt);
    },
    unlock: (id, { lat, lng, accuracyM } = {}) => unlockEcho(id, { lat, lng, accuracyM }),
    resonate: (id, { lat, lng, accuracyM } = {}) => resonate(id, { lat, lng, accuracyM }),
  };
}
export const huntAdapter = createHuntAdapter();
export const createSupabaseSource = createHuntAdapter;   // alias matching hunt/http-source.js naming
