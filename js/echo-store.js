// echo-store: the single data seam for Echolocation.
// Every screen (record, listen/hunt, debug) talks ONLY to the functions exported here.
//
// Backends:
//   - supabaseBackend : night crawler's Supabase schema (RPCs + 'echoes' storage bucket). Used when configured + reachable.
//   - localBackend    : IndexedDB on this device. Fallback when config is empty, the schema isn't applied, or the network fails.
//
// Echo record shape (both backends MUST return exactly this; see README):
//   { id, lat, lng, accuracy_m, heading, altitude, created_at, expires_at,
//     resonance_count, audio_path, duration_ms, mime_type }
//   created_at / expires_at are ISO-8601 strings. heading is degrees from true/magnetic north (0..360) or null.
//   nearbyEchoes() adds `distance_m` (+ `bearing_deg` from Supabase); every record carries `source`: 'supabase' | 'local'.
//   Supabase nearby results carry real lat/lng (nearby_echoes' echo_lat/echo_lng) and audio_path = null
//   (unlocked server-side within 25 m + GPS pad via getAudioUrl). Hunt adapter: createHuntSource().
//   dropEcho() also accepts trax's names { durationS, headingDeg, altitudeM, caption }; see normalizeDropInput().

import {
  SUPABASE_URL, SUPABASE_ANON_KEY,
  ECHO_TTL_MS, RESONATE_EXTENSION_MS, DEFAULT_NEARBY_RADIUS_M,
} from './config.js';
import * as sbClient from './echoes-client-v2.js'; // night crawler's v2 client, verbatim (drop-in superset of v1)
import { fuzzPoint } from './fuzz.js';

// Fires 'drop', 'resonate' and 'backend' (fell back to local) events (detail = echo record) so screens can refresh.
export const events = new EventTarget();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
export function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isExpired(echo, now = Date.now()) {
  return Date.parse(echo.expires_at) <= now;
}

function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * Accepts both field-name styles and returns the canonical one:
 *   ours : { blob, mimeType, durationMs, lat, lng, accuracyM, heading,    altitude }
 *   trax : { blob,           durationS,  lat, lng, accuracyM, headingDeg, altitudeM, caption }
 *          (/home/box/shared/echolocation/store/supabase-store.js)
 * Canonical names win if both are given. mimeType defaults to blob.type.
 */
export function normalizeDropInput(input = {}) {
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null);
  const durS = pick(input.durationS, input.duration_s);
  return {
    blob: input.blob,
    mimeType: pick(input.mimeType, input.mime_type, input.blob?.type) || '',
    durationMs: pick(input.durationMs, input.duration_ms, durS != null ? Number(durS) * 1000 : undefined) ?? 0,
    lat: Number(input.lat), lng: Number(input.lng),
    accuracyM: pick(input.accuracyM, input.accuracy_m) ?? null,
    heading: pick(input.heading, input.headingDeg, input.heading_deg) ?? null,
    altitude: pick(input.altitude, input.altitudeM, input.altitude_m) ?? null,
    caption: pick(input.caption) ?? null,
    blurred: Boolean(pick(input.blurred, input.blur)),
    placeLabel: pick(input.placeLabel, input.place_label) ?? null,
    placeKind: pick(input.placeKind, input.place_kind) ?? null,          // 004_place.sql
    placeName: pick(input.placeName, input.place_name) ?? null,
    level: Number.isInteger(input.level) ? input.level : null,
    // migration-v2 extras (trax's modules): sent only once v2 is installed, see supabaseBackend.dropEcho
    transcript: pick(input.transcript) ?? null,
    tags: Array.isArray(input.tags) && input.tags.length ? input.tags.slice(0, 8) : null,
    parentId: pick(input.parentId, input.parent_id) ?? null,
    unlockAt: pick(input.unlockAt, input.unlock_at) ?? null,
    trailId: pick(input.trailId, input.trail_id) ?? null,   // "Blur my spot": show a 30–60 m glow instead of the exact pin
  };
}

function validateDrop({ blob, lat, lng }) {
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error('dropEcho: empty or missing audio blob');
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error('dropEcho: invalid lat/lng');
  }
}

const numOrNull = (v) => (Number.isFinite(v) ? v : null);

export function extForMime(mimeType = '') {
  if (mimeType.includes('mp4') || mimeType.includes('aac')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}

// ---------------------------------------------------------------------------
// LOCAL FALLBACK BACKEND (IndexedDB) - single device only
// ---------------------------------------------------------------------------
const DB_NAME = 'echolocation';
const DB_VERSION = 2;              // v2 adds the 'outbox' store (drops waiting for a connection)
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    // An old tab still holding v1 open blocks the v2 upgrade; don't hang the app on it.
    const t = setTimeout(() => { dbPromise = null; reject(new Error('IndexedDB is busy (close other Echolocation tabs)')); }, 5000);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onblocked = () => console.info('[echo-store] IndexedDB upgrade waiting for another tab to close');
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('echoes')) db.createObjectStore('echoes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'qid' });
    };
    req.onsuccess = () => {
      clearTimeout(t);
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };   // let a newer version of the app upgrade
      resolve(db);
    };
    req.onerror = () => { clearTimeout(t); dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

const audioUrlCache = new Map(); // id -> objectURL

const localBackend = {
  name: 'local-indexeddb',

  async dropEcho({ blob, mimeType, durationMs, lat, lng, accuracyM, heading, altitude, caption, blurred, placeLabel, placeKind, placeName, level }) {
    validateDrop({ blob, lat, lng });
    const db = await openDb();
    const id = newId();
    const now = Date.now();
    const echo = {
      id,
      lat, lng,
      accuracy_m: numOrNull(accuracyM),
      heading: numOrNull(heading),
      altitude: numOrNull(altitude),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ECHO_TTL_MS).toISOString(),
      resonance_count: 0,
      audio_path: `local:${id}.${extForMime(mimeType || blob.type)}`,
      duration_ms: Math.round(durationMs || 0),
      mime_type: mimeType || blob.type || 'application/octet-stream',
      caption: caption || null,
      blurred: Boolean(blurred),
      place_label: placeLabel || null, place_kind: placeKind || null,
      place_name: blurred ? null : placeName || null, level: blurred ? null : level ?? null,
    };
    // Store the Blob directly (IndexedDB supports Blobs, incl. iOS Safari 14+).
    const buf = await blob.arrayBuffer(); // ArrayBuffer is the most portable IDB value
    const tx = db.transaction(['echoes', 'audio'], 'readwrite');
    tx.objectStore('echoes').put(echo);
    tx.objectStore('audio').put({ id, mime_type: echo.mime_type, data: buf });
    await txDone(tx);
    return echo;
  },

  async nearbyEchoes(lat, lng, radiusM = DEFAULT_NEARBY_RADIUS_M) {
    const now = Date.now();
    const all = await this.listAllEchoes();
    return all
      .filter((e) => !isExpired(e, now))
      .map((e) => ({ ...e, distance_m: haversineM(lat, lng, e.lat, e.lng) }))
      .filter((e) => e.distance_m <= radiusM)
      .sort((a, b) => a.distance_m - b.distance_m);
  },

  async resonate(id) {
    const db = await openDb();
    const tx = db.transaction('echoes', 'readwrite');
    const os = tx.objectStore('echoes');
    const echo = await reqP(os.get(id));
    if (!echo) throw new Error('resonate: echo not found');
    const now = Date.now();
    if (isExpired(echo, now)) throw new Error('resonate: echo already decayed');
    echo.resonance_count = (echo.resonance_count || 0) + 1;
    echo.expires_at = new Date(Date.parse(echo.expires_at) + RESONATE_EXTENSION_MS).toISOString();
    os.put(echo);
    await txDone(tx);
    return echo;
  },

  async getAudioUrl(echo) {
    const id = typeof echo === 'string' ? echo : echo.id;
    if (audioUrlCache.has(id)) return audioUrlCache.get(id);
    const db = await openDb();
    const row = await reqP(db.transaction('audio').objectStore('audio').get(id));
    if (!row) return null;
    const blob = row.data instanceof Blob ? row.data : new Blob([row.data], { type: row.mime_type });
    const url = URL.createObjectURL(blob);
    audioUrlCache.set(id, url);
    return url;
  },

  // Debug/testing helper (used by debug.html). Includes expired echoes.
  async listAllEchoes() {
    const db = await openDb();
    const all = await reqP(db.transaction('echoes').objectStore('echoes').getAll());
    return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
};

// ---------------------------------------------------------------------------
// SUPABASE BACKEND: delegates to night crawler's v2 client js/echoes-client-v2.js (copied verbatim from
// /home/box/shared/echolocation/v2/night-crawler/echoes-client-v2.js; supabase-js loaded from esm.sh on first use).
// Works before AND after migration-v2.sql: v2-only RPCs raise V2_MISSING, which we treat as "use the v1 path".
// Schema (backend/schema.sql, re-checked 2026-11-03 04:05):
//   drop_echo(lat,lng,accuracy_m,heading_deg,altitude_m,audio_path,duration_s,mime_type,device_id,caption) -> uuid
//   nearby_echoes(lat,lng,radius_m)  -> [{id,echo_lat,echo_lng,distance_m,bearing_deg,heading_deg,altitude_m,expires_at,resonance_count}]
//   unlock_echo(echo_id,lat,lng,accuracy_m) -> audio_path   (<= 25 m + min(accuracy,40))
//   resonate(echo_id,device_id,lat,lng,accuracy_m) -> {expires_at,resonance_count}  (<= 50 m + pad, once/device, not own)
//   debug_echoes(lat,lng,radius_m)   -> full rows incl. echo_lat/echo_lng (debug map only)
// ---------------------------------------------------------------------------
const OLD_DEVICE_KEY = 'echolocation.device_id'; // pre-2026-11-03 builds of this file used this key; migrated once
const LAST_POS_KEY = 'echolocation.last_pos';

/** Anonymous device id (localStorage 'echolocation.device', shared with echoes-client.js and the hunt). */
export function getDeviceId() {
  try {
    const old = localStorage.getItem(OLD_DEVICE_KEY);
    if (old && !localStorage.getItem('echolocation.device') && /^[A-Za-z0-9_-]{8,64}$/.test(old)) {
      localStorage.setItem('echolocation.device', old);
    }
  } catch { /* private mode */ }
  return sbClient.getDeviceId();
}

function rememberPos(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  try { localStorage.setItem(LAST_POS_KEY, JSON.stringify({ lat, lng, at: Date.now() })); } catch { /* ignore */ }
}
/** Last position this device used with the store (or null). Handy default center for the debug map. */
export function lastKnownPosition() {
  try { return JSON.parse(localStorage.getItem(LAST_POS_KEY)); } catch { return null; }
}

/** Wraps any backend failure. `unavailable` = backend missing/unreachable -> caller may fall back to local. */
export class SupabaseError extends Error {
  constructor(message, { code, unavailable = false, cause } = {}) {
    super(message); this.name = 'SupabaseError'; this.code = code; this.unavailable = unavailable; this.cause = cause;
  }
}
// EchoError codes from echoes-client.js that mean "the backend can't be used right now".
const UNAVAILABLE_CODES = new Set(['SCHEMA_MISSING', 'NETWORK', 'NOT_INITIALISED', 'FORBIDDEN']);
function toSbError(err) {
  if (err instanceof SupabaseError) return err;
  const msg = String(err?.friendly && !UNAVAILABLE_CODES.has(err?.code) ? err.friendly : err?.message || err);
  const unavailable = UNAVAILABLE_CODES.has(err?.code) || /bucket not found|failed to fetch|import|esm\.sh|load failed/i.test(msg)
    || err?.cause?.status >= 500;
  return new SupabaseError(msg, { code: err?.code, unavailable, cause: err });
}
let initP = null;
function sbReady() {
  initP ||= sbClient.init({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY }).catch((e) => {
    initP = null; // allow a retry later
    throw new SupabaseError(`supabase-js failed to load: ${e.message || e}`, { code: 'NETWORK', unavailable: true, cause: e });
  });
  return initP;
}
const sb = async (fn) => { try { await sbReady(); getDeviceId(); return await fn(); } catch (e) { throw toSbError(e); } };

function fromServerRow(r, extra = {}) {
  return {
    id: r.id,
    lat: r.echo_lat ?? r.lat ?? null, lng: r.echo_lng ?? r.lng ?? null,
    accuracy_m: r.accuracy_m ?? null,
    heading: r.heading_deg ?? null,
    altitude: r.altitude_m ?? null,
    created_at: r.created_at ?? null,
    expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    resonance_count: r.resonance_count ?? 0,
    audio_path: r.audio_path ?? null,                              // revealed only by unlock_echo
    duration_ms: r.duration_s != null ? Math.round(r.duration_s * 1000) : null,
    mime_type: r.mime_type ?? null,
    distance_m: r.distance_m,
    bearing_deg: r.bearing_deg,                                     // user -> echo, 0 = north, clockwise
    ...('caption' in r ? { caption: stripBlurMarker(r.caption) } : {}),
    ...('blurred' in r || 'caption' in r ? { blurred: Boolean(r.blurred) || hasBlurMarker(r.caption) } : {}),
    ...(r.place_label ? { place_label: r.place_label } : {}),
    source: 'supabase',
    ...extra,
  };
}

const supabaseBackend = {
  name: 'supabase',

  async dropEcho({ blob, mimeType, durationMs, lat, lng, accuracyM, heading, altitude, caption, blurred, placeLabel,
    placeKind, placeName, level, transcript, tags, parentId, unlockAt, trailId }) {
    validateDrop({ blob, lat, lng });
    // echoes-client derives the type from blob.type; make sure it carries the recorder's mimeType.
    const typed = blob.type ? blob : new Blob([blob], { type: mimeType || 'audio/webm' });
    const durationS = Math.min(60, Math.max(0.1, (durationMs || 0) / 1000));
    // migration-v2 live (map_echoes answered): send blurred + place_label as columns. Before it, drop_echo has no
    // such parameters, so call it exactly like v1 and keep the blur choice as a caption marker (maps read it back).
    // A blurred drop must never rely on a stale "v2 missing" cache: re-check right before writing the marker.
    const needsV2 = Boolean(parentId || unlockAt || trailId);
    const v2 = mapMode === 'map_echoes' || (blurred || needsV2 ? await probeV2({ force: true }) : false);
    if (needsV2 && !v2) throw new SupabaseError(V2_HINT, { code: 'V2_MISSING' });
    const args = { blob: typed, lat, lng, accuracyM, heading, altitude, durationS };
    if (v2) {
      Object.assign(args, { caption, placeLabel: placeLabel || null, blurred: Boolean(blurred) });
      // 004_place.sql: kind/name/level columns (echoes-client-v2 retries without them while 004 isn't there yet)
      if (placeKind) Object.assign(args, { placeKind, ...(blurred ? {} : { placeName: placeName || null, level: Number.isInteger(level) ? level : null }) });
      // transcript/tags/reply/capsule/trail go through drop_echo_v2; a drop never fails just for lack of a transcript
      if (transcript) args.transcript = transcript;
      if (tags?.length) args.tags = tags;
      if (parentId) args.parentId = parentId;
      if (unlockAt) args.unlockAt = unlockAt;
      if (trailId) args.trailId = trailId;
    }
    else args.caption = withPlaceMarker(blurred ? withBlurMarker(caption) : caption, placeLabel);
    const id = await sb(() => sbClient.dropEcho(args));
    const blurVia = blurred ? (v2 ? 'column' : 'caption') : null;
    const now = Date.now();
    return {
      id, lat, lng, accuracy_m: numOrNull(accuracyM), heading: numOrNull(heading), altitude: numOrNull(altitude),
      created_at: new Date(now).toISOString(), expires_at: new Date(now + ECHO_TTL_MS).toISOString(),
      resonance_count: 0, audio_path: null, duration_ms: Math.round(durationMs || 0),
      mime_type: (typed.type || '').split(';')[0], source: 'supabase',
      blurred: Boolean(blurred), blur_via: blurVia, place_label: placeLabel || null,
      place_kind: placeKind || null, place_name: blurred ? null : placeName || null, level: blurred ? null : level ?? null,
      parent_id: v2 ? parentId || null : null, unlock_at: v2 ? unlockAt || null : null, trail_id: v2 ? trailId || null : null,
      tags: v2 ? tags || null : null, transcript: v2 ? transcript || null : null,
    };
  },

  async nearbyEchoes(lat, lng, radiusM) {
    const rows = await sb(() => sbClient.nearbyEchoes({ lat, lng, radiusM }));
    return rows.map((r) => fromServerRow(r));
  },

  async resonate(id, { lat, lng, accuracyM } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('resonate: current {lat, lng} required');
    const r = await sb(() => sbClient.resonate(id, { lat, lng, accuracyM }));
    return { id, expires_at: r.expiresAt, resonance_count: r.resonanceCount, source: 'supabase' };
  },

  async getAudioUrl(echo, { lat, lng, accuracyM } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('getAudioUrl: current {lat, lng} required to unlock');
    return sb(() => sbClient.unlockEcho(echo.id, { lat, lng, accuracyM })); // throws TOO_FAR beyond 25 m + pad
  },

  /** Debug map rows. map_echoes (migration-v2: exact pins, glow centre for blurred ones) when it exists;
   *  debug_echoes (exact, v1) only while it doesn't; nearby_echoes (500 m) if debug_echoes is revoked too. */
  async listAllEchoes({ lat, lng, radiusM = 20000 } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const dLat = Math.min(0.99, radiusM / 111320), dLng = Math.min(0.99, radiusM / (111320 * Math.cos(lat * Math.PI / 180)));
    const box = { minLat: Math.max(-90, lat - dLat), maxLat: Math.min(90, lat + dLat),
      minLng: Math.max(-180, lng - dLng), maxLng: Math.min(180, lng + dLng) };
    if (await probeV2()) {
      const pins = await sb(() => sbClient.mapEchoes(box));
      return pins.map((p) => ({ ...mapRecord(p, 'server'), accuracy_m: null, heading: null, source: 'supabase', via: 'map_echoes' }));
    }
    try {
      const rows = await sb(() => sbClient.debugEchoes({ lat, lng, radiusM }));
      return rows.map((r) => ({ ...fromServerRow(r), via: 'debug_echoes' }));
    } catch (e) {
      if (!(e instanceof SupabaseError) || !['SCHEMA_MISSING', 'FORBIDDEN'].includes(e.code)) throw e;
      hintMigrationLive();                                            // revoked => v2 is probably in now
      const rows = await sb(() => sbClient.nearbyEchoes({ lat, lng, radiusM: 500 }));
      return rows.map((r) => ({ ...fromServerRow(r), via: 'nearby_echoes' }));
    }
  },

  /** night crawler's hunt plug-in (createSupabaseSource), errors normalised to SupabaseError. */
  huntSource() {
    const src = sbClient.createSupabaseSource();
    return {
      nearby: (q) => sb(() => src.nearby(q)),
      unlock: (id, q) => sb(() => src.unlock(id, q)),
      resonate: (id, q) => sb(() => src.resonate(id, q)),
    };
  },
};

// ---------------------------------------------------------------------------
// backend selection + public API
//   Supabase when configured and reachable; any "unavailable" error (schema not applied => PGRST202,
//   network down, 5xx) switches this session to the IndexedDB fallback. Business errors
//   ("too far", "already resonated", rate limit) are thrown to the caller as-is.
//   Echoes that were saved locally keep working locally (routed by echo.source / local lookup).
// ---------------------------------------------------------------------------
const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
let supabaseDown = !supabaseConfigured;
let downForNetwork = false;          // true when the fallback was caused by a lost connection (retry on 'online')
const isOfflineNow = () => typeof navigator !== 'undefined' && navigator.onLine === false;
function isNetworkError(err) {
  return err?.code === 'NETWORK' || /failed to fetch|load failed|network|fetch failed|timed? ?out/i.test(String(err?.message || ''));
}
/** After a lost connection comes back, try Supabase again (it stays down for real schema/config problems). */
export function reviveBackend() {
  if (!supabaseConfigured || !supabaseDown || !downForNetwork) return false;
  supabaseDown = false; downForNetwork = false; initP = null;
  backendName = 'supabase'; backendError = null;
  events.dispatchEvent(new CustomEvent('backend', { detail: { backend: backendName, error: null } }));
  return true;
}
export let backendName = supabaseConfigured ? 'supabase' : localBackend.name;
export let backendError = supabaseConfigured ? null : 'Supabase not configured';

function fallBack(err) {
  if (!supabaseDown) console.info('[echo-store] Supabase unavailable, using local IndexedDB fallback:', err.message);
  supabaseDown = true;
  downForNetwork = isNetworkError(err);
  backendName = localBackend.name;
  backendError = err.message;
  events.dispatchEvent(new CustomEvent('backend', { detail: { backend: backendName, error: err.message } }));
}

async function withFallback(remote, local, { queueOnNetwork = false } = {}) {
  if (!supabaseDown) {
    try { return await remote(); } catch (err) {
      if (!(err instanceof SupabaseError) || !err.unavailable) throw err;
      if (queueOnNetwork && isNetworkError(err)) throw err;          // caller queues it instead of saving locally
      fallBack(err);
    }
  }
  return local();
}

async function isLocalId(id) {
  const db = await openDb();
  return Boolean(await reqP(db.transaction('echoes').objectStore('echoes').getKey(id)));
}

/** Probe the backend once (cheap RPC). Resolves to the active backend name. */
export async function checkBackend(lat = 0, lng = 0) {
  if (supabaseDown) return backendName;
  try { await supabaseBackend.nearbyEchoes(lat, lng, 1); } catch (err) {
    if (err instanceof SupabaseError && err.unavailable) fallBack(err);
  }
  return backendName;
}

/** @returns {Promise<Echo>} the dropped echo (record shape in README) */
export async function dropEcho(rawInput) {
  const input = normalizeDropInput(rawInput);
  validateDrop(input);
  rememberPos(input.lat, input.lng);
  let saved;
  if (supabaseConfigured && isOfflineNow()) {
    saved = await enqueueDrop(input, 'offline');                     // no connection: outbox, upload later
  } else {
    try {
      saved = await withFallback(() => supabaseBackend.dropEcho(input),
        async () => ({ ...(await localBackend.dropEcho(input)), source: 'local' }), { queueOnNetwork: true });
    } catch (err) {
      if (!(err instanceof SupabaseError && isNetworkError(err))) throw err;
      saved = await enqueueDrop(input, err.message);                // connection dropped mid-upload
    }
  }
  // Also carry trax's return shape ({ id, audioPath }) so either caller style works.
  const echo = { ...saved, audioPath: saved.audio_path };
  markMine(echo.id);
  if (echo.queued) outboxChanged();
  events.dispatchEvent(new CustomEvent('drop', { detail: echo }));
  return echo;
}

// ---------------------------------------------------------------------------
// OUTBOX: drops made without a connection wait in IndexedDB ('outbox') and upload on 'online', on app start
// (flushOutbox() from app.js) and every 20 s while anything is queued. A queued echo shows on this phone's map
// as a dim pending pin (id 'q-…', source 'queued') until the upload replaces it with the real one.
// Events: 'outbox' { count, sent?, error? }; on upload 'retract' { id: qid, replacedBy } then 'drop' (real echo).
// ---------------------------------------------------------------------------
async function enqueueDrop(input, reason) {
  const db = await openDb();
  const qid = `q-${globalThis.crypto?.randomUUID?.() || newId()}`;
  const now = Date.now();
  const rec = {
    qid, queued_at: new Date(now).toISOString(), tries: 0, last_error: String(reason || 'offline'),
    input: { ...input, blob: undefined }, mime_type: input.mimeType || input.blob.type || 'audio/webm',
    data: await input.blob.arrayBuffer(),
  };
  const tx = db.transaction('outbox', 'readwrite'); tx.objectStore('outbox').put(rec); await txDone(tx);
  scheduleOutboxRetry();
  outboxChanged();
  return queuedEcho(rec);
}
function queuedEcho(rec) {
  const i = rec.input;
  const t = Date.parse(rec.queued_at);
  return {
    id: rec.qid, lat: i.lat, lng: i.lng, accuracy_m: numOrNull(i.accuracyM), heading: numOrNull(i.heading),
    altitude: numOrNull(i.altitude), created_at: rec.queued_at, expires_at: new Date(t + ECHO_TTL_MS).toISOString(),
    resonance_count: 0, audio_path: null, duration_ms: Math.round(i.durationMs || 0), mime_type: rec.mime_type,
    blurred: Boolean(i.blurred), place_label: i.placeLabel ?? null, caption: i.caption ?? null,
    place_kind: i.placeKind ?? null, place_name: i.blurred ? null : i.placeName ?? null, level: i.blurred ? null : i.level ?? null,
    source: 'queued', queued: true, last_error: rec.last_error,
  };
}
async function readOutbox() {
  try { const db = await openDb(); return await reqP(db.transaction('outbox').objectStore('outbox').getAll()); } catch { return []; }
}
/** Queued drops as echo records (newest first). */
export async function listOutbox() {
  return (await readOutbox()).map(queuedEcho).sort((a, b) => b.created_at.localeCompare(a.created_at));
}
export async function outboxCount() { return (await readOutbox()).length; }
async function outboxChanged(extra = {}) {
  events.dispatchEvent(new CustomEvent('outbox', { detail: { count: await outboxCount(), ...extra } }));
}
/** Attach the place label to a queued drop once the reverse-geocode comes back (it was looked up after Drop). */
export async function setQueuedPlaceLabel(qid, label) {
  if (!String(qid).startsWith('q-') || !label) return;
  const db = await openDb(); const tx = db.transaction('outbox', 'readwrite'); const os = tx.objectStore('outbox');
  const rec = await reqP(os.get(qid)); if (rec) { rec.input.placeLabel = label; os.put(rec); } await txDone(tx);
}

let flushing = null, retryTimer = null;
function scheduleOutboxRetry() {
  if (retryTimer || typeof setInterval === 'undefined') return;
  retryTimer = setInterval(async () => {
    if ((await outboxCount()) === 0) { clearInterval(retryTimer); retryTimer = null; return; }
    if (!isOfflineNow()) flushOutbox();
  }, 20_000);
}
/** Try to upload every queued drop. Resolves { sent, left }. Safe to call any time (no-op while offline). */
export function flushOutbox() {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    const items = (await readOutbox()).sort((a, b) => a.queued_at.localeCompare(b.queued_at));
    if (!items.length || !supabaseConfigured || isOfflineNow()) return { sent, left: items.length };
    reviveBackend();
    const db = await openDb();
    for (const rec of items) {
      const input = { ...rec.input, blob: new Blob([rec.data], { type: rec.mime_type }) };
      let saved = null, err = null;
      try {
        if (supabaseDown && !downForNetwork) saved = { ...(await localBackend.dropEcho(input)), source: 'local' };
        else saved = await supabaseBackend.dropEcho(input);
      } catch (e) { err = e; }
      if (err) {
        const se = err instanceof SupabaseError ? err : toSbError(err);
        if (isNetworkError(se)) {                                        // still no connection: keep everything queued
          rec.tries += 1; rec.last_error = se.message;
          const tx = db.transaction('outbox', 'readwrite'); tx.objectStore('outbox').put(rec); await txDone(tx);
          await outboxChanged({ error: se.message });
          scheduleOutboxRetry();
          return { sent, left: items.length - sent };
        }
        // Backend can't take it (schema missing etc.): keep the echo on this phone instead of losing it.
        if (se.unavailable) saved = { ...(await localBackend.dropEcho(input)), source: 'local' };
        else {                                                           // rejected (rate limit, zone, invalid)
          rec.tries += 1; rec.last_error = se.message;
          const tx = db.transaction('outbox', 'readwrite');
          if (rec.tries >= 5) tx.objectStore('outbox').delete(rec.qid); else tx.objectStore('outbox').put(rec);
          await txDone(tx);
          events.dispatchEvent(new CustomEvent('outbox-failed', { detail: { qid: rec.qid, error: se.message, dropped: rec.tries >= 5 } }));
          continue;
        }
      }
      const tx = db.transaction('outbox', 'readwrite'); tx.objectStore('outbox').delete(rec.qid); await txDone(tx);
      sent += 1;
      const echo = { ...saved, audioPath: saved.audio_path, fromQueue: rec.qid };
      markMine(echo.id);
      events.dispatchEvent(new CustomEvent('retract', { detail: { id: rec.qid, replacedBy: echo.id } }));
      events.dispatchEvent(new CustomEvent('drop', { detail: echo }));
    }
    const left = await outboxCount();
    await outboxChanged({ sent });
    return { sent, left };
  })().finally(() => { flushing = null; });
  return flushing;
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { reviveBackend(); flushOutbox(); });
}

/** Non-expired echoes within radiusM, nearest first, each with distance_m and real lat/lng. */
export async function nearbyEchoes(lat, lng, radiusM = DEFAULT_NEARBY_RADIUS_M) {
  rememberPos(lat, lng);
  const local = (await localBackend.nearbyEchoes(lat, lng, radiusM)).map((e) => ({ ...e, source: 'local' }));
  const remote = await withFallback(() => supabaseBackend.nearbyEchoes(lat, lng, radiusM), () => []);
  return [...remote, ...local].sort((a, b) => a.distance_m - b.distance_m);
}

/** Resonate (extend life). Supabase needs the listener's position: resonate(id, {lat, lng}). */
export async function resonate(id, pos = {}) {
  const echo = (await isLocalId(id)) ? await localBackend.resonate(id)
    : await withFallback(() => supabaseBackend.resonate(id, pos), () => localBackend.resonate(id));
  events.dispatchEvent(new CustomEvent('resonate', { detail: echo }));
  return echo;
}

/** Playable URL. Supabase echoes are unlocked server-side only within 25 m: getAudioUrl(echo, {lat, lng}). */
export async function getAudioUrl(echo, pos = {}) {
  if (echo.source === 'local' || (typeof echo.audio_path === 'string' && echo.audio_path.startsWith('local:')) ||
      (await isLocalId(echo.id))) return localBackend.getAudioUrl(echo);
  return withFallback(() => supabaseBackend.getAudioUrl(echo, pos), () => localBackend.getAudioUrl(echo));
}

/** Debug/testing only (debug.html): every echo with exact positions. Supabase needs a center {lat, lng}
 *  (map_echoes after migration-v2, else debug_echoes; 20 km radius); local includes expired ones. */
export async function listAllEchoes(center = lastKnownPosition() || {}) {
  const local = (await localBackend.listAllEchoes()).map((e) => ({ ...e, source: 'local' }));
  const remote = await withFallback(() => supabaseBackend.listAllEchoes(center), () => []);
  return [...remote, ...local];
}

/**
 * Source adapter for the hunt engine (js/hunt-core.js contract: nearby / unlock / resonate).
 * While Supabase works it is night crawler's createSupabaseSource() (real echo_lat/echo_lng from nearby_echoes,
 * server-gated unlock + resonate). If Supabase is unavailable (schema not applied, offline) it switches to the
 * IndexedDB fallback. Echoes saved only on this device are always merged in, so fallback drops are findable.
 * `source.echoes` holds the last nearby() list (desk mode's warp uses it); `source.backend()` names the active one.
 */
export function createHuntSource() {
  let remote = null;
  const localIds = new Set();
  const toHunt = (e) => ({
    id: e.id, lat: e.lat, lng: e.lng, distanceM: e.distance_m, bearingDeg: e.bearing_deg,
    headingDeg: e.heading ?? null, altitudeM: e.altitude ?? null,
    expiresAt: e.expires_at, resonanceCount: e.resonance_count ?? 0, source: 'local',
  });
  const src = {
    name: 'echo-store',
    echoes: [],
    backend: () => backendName,
    async nearby({ lat, lng, radiusM = 300, accuracyM } = {}) {
      rememberPos(lat, lng);
      const local = (await localBackend.nearbyEchoes(lat, lng, radiusM)).map(toHunt);
      local.forEach((e) => localIds.add(e.id));
      const fromSb = await withFallback(async () => {
        remote ||= supabaseBackend.huntSource();
        return (await remote.nearby({ lat, lng, radiusM: Math.min(radiusM, 500), accuracyM }))
          .map((e) => ({ ...e, source: 'supabase' }));
      }, () => []);
      src.echoes = [...fromSb, ...local].filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lng));
      return src.echoes;
    },
    async unlock(id, pos = {}) {
      if (localIds.has(id) || (await isLocalId(id))) return localBackend.getAudioUrl(id);
      remote ||= supabaseBackend.huntSource();
      return remote.unlock(id, pos);
    },
    async resonate(id, pos = {}) {
      let res;
      if (localIds.has(id) || (await isLocalId(id))) {
        const e = await localBackend.resonate(id);
        res = { expiresAt: e.expires_at, resonanceCount: e.resonance_count };
      } else {
        remote ||= supabaseBackend.huntSource();
        res = await remote.resonate(id, pos);
      }
      events.dispatchEvent(new CustomEvent('resonate', { detail: { id, ...res } }));
      return res;
    },
  };
  return src;
}

// ---------------------------------------------------------------------------
// MAP (v2): shared live map. Every map record is FUZZED: { id, lat, lng, radius_m, resonance_count,
// created_at, expires_at, source, fuzz: 'server' | 'client', mine }. lat/lng is the centre of a 30–60 m glow
// that contains the real spot, never the spot itself.
//   - After backend/migrations/002_map_realtime.sql: map_echoes(bbox) fuzzes on the server (secret salt).
//   - Before it: debug_echoes(centre, radius) (or nearby_echoes within 500 m if debug is revoked) and
//     js/fuzz.js fuzzes on the phone. Exact coordinates are dropped right after fuzzing.
//   mapMode tells which path is live: 'map_echoes' | 'legacy-debug' | 'legacy-nearby' | 'local'.
// ---------------------------------------------------------------------------
export let mapMode = supabaseConfigured ? null : 'local';
const MAP_PROBE_KEY = 'echolocation.map_echoes_missing_at';
const MAP_REPROBE_MS = 60_000;      // map_echoes missing (404) is cached for the session; re-check once a minute
let mapProbeAt = (() => { try { return Number(sessionStorage.getItem(MAP_PROBE_KEY)) || 0; } catch { return 0; } })();
if (supabaseConfigured && mapProbeAt && Date.now() - mapProbeAt < MAP_REPROBE_MS) mapMode = 'legacy-debug';
/**
 * Is migration-v2 installed (map_echoes, drop_echo(..., blurred, place_label))? Uses the per-session cache
 * (a missing map_echoes is re-checked once a minute) unless force. One tiny map_echoes call when it checks.
 */
let probeP = null;
export async function probeV2({ force = false } = {}) {
  if (mapMode === 'map_echoes') return true;
  if (probeP) return probeP;                                          // one probe at a time; callers share it
  if (!supabaseConfigured || supabaseDown) return false;
  if (!force && mapProbeAt && Date.now() - mapProbeAt < MAP_REPROBE_MS) return false;
  mapProbeAt = Date.now();
  probeP = runProbe().finally(() => { probeP = null; });
  return probeP;
}
async function runProbe() {
  try {
    await sb(() => sbClient.mapEchoes({ minLat: 0, minLng: 0, maxLat: 0.0001, maxLng: 0.0001 }));
    mapMode = 'map_echoes';
    try { sessionStorage.removeItem(MAP_PROBE_KEY); } catch { /* ignore */ }
    events.dispatchEvent(new CustomEvent('v2', { detail: { available: true } }));
    return true;
  } catch (e) {
    if (!(e instanceof SupabaseError) || !['V2_MISSING', 'SCHEMA_MISSING', 'FORBIDDEN'].includes(e.code)) throw e;
    if (mapMode === null) mapMode = 'legacy-debug';
    try { sessionStorage.setItem(MAP_PROBE_KEY, String(mapProbeAt)); } catch { /* ignore */ }
    return false;
  }
}

/** Something hinted that migration-v2 is live (e.g. a trigger broadcast): probe map_echoes on the next poll. */
export function hintMigrationLive() { if (mapMode !== 'map_echoes') mapProbeAt = 0; }
const MINE_KEY = 'echolocation.mine';

function readMine() { try { return JSON.parse(localStorage.getItem(MINE_KEY)) || {}; } catch { return {}; } }
/** Remember echoes dropped from this device (the server never reveals device ids). */
export function markMine(id) {
  if (!id) return;
  const m = readMine(); m[id] = Date.now();
  const cutoff = Date.now() - 8 * 24 * 3600e3;                       // echoes live 7 days max
  for (const k of Object.keys(m)) if (m[k] < cutoff) delete m[k];
  try { localStorage.setItem(MINE_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}
export function isMine(id) { return Boolean(readMine()[id]); }

/** Ready supabase-js client (or null when the backend is unavailable). Used by the map feed for Realtime. */
export async function supabaseClient() {
  if (supabaseDown) return null;
  try { return await sbReady(); } catch { return null; }       // init() resolves to the supabase-js client
}

export const V2_HINT = 'This needs the backend update (migration-v2.sql), which isn\u2019t installed yet.';
/** Ready night crawler v2 client (for trax's modules: trails, threads). Null while the backend is unavailable. */
export async function v2Client() {
  if (supabaseDown || !(await probeV2())) return null;
  await sbReady(); return sbClient;
}

/** "Blur my spot" before migration-v2: drop_echo has no blurred column yet, so the choice rides in the caption. */
export const BLUR_MARKER = '[[blur]]';
// Place before migration-v2 (no place_label column): rides in the caption too, as [[@Inside Square One · L2]].
const PLACE_RE = /\s*\[\[@([^\]]{1,80})\]\]/;
export const withBlurMarker = (c) => {
  const t = String(c || '').replace(BLUR_MARKER, '').trim();
  return t ? `${t.slice(0, 120)} ${BLUR_MARKER}` : BLUR_MARKER;
};
export function withPlaceMarker(c, label) {
  if (!label) return c;
  const m = ` [[@${String(label).replace(/[\[\]]/g, '').slice(0, 80)}]]`;
  const t = String(c || '').replace(PLACE_RE, '');
  return (t.slice(0, 140 - m.length) + m).trim();
}
export const placeFromCaption = (c) => (typeof c === 'string' ? c.match(PLACE_RE)?.[1] ?? null : null);
export const hasBlurMarker = (c) => typeof c === 'string' && c.includes(BLUR_MARKER);
export const stripBlurMarker = (c) => (typeof c === 'string' ? c.replace(BLUR_MARKER, '').replace(PLACE_RE, '').trim() || null : c);
/** 004 place fields (+ the packed label) from any row shape. Blurred rows never carry a name or level. */
function placeFields(r, blurred) {
  const kind = r.placeKind ?? r.place_kind ?? null;
  return { place_kind: kind, place_name: blurred ? null : r.placeName ?? r.place_name ?? null,
    level: blurred ? null : r.level ?? null, place_label: r.placeLabel ?? r.place_label ?? placeFromCaption(r.caption) ?? null };
}
export { placeFields };

const inBox = (b, lat, lng) => lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
/**
 * One map record. EXACT pin (radius_m 0) unless the echo was dropped with "Blur my spot".
 *   server : map_echoes pin from echoes-client-v2 (camelCase; the server already blurred it if needed)
 *   client : exact row (debug_echoes / nearby_echoes / local); blurred ones get the 30–60 m glow from js/fuzz.js
 * blurred is known from the v2 column, the pre-v2 caption marker, or (local) the stored flag. When it can't be
 * known (nearby_echoes before v2 has neither) we blur, so a private choice is never shown as an exact pin.
 */
function mapRecord(r, fuzz = 'client') {
  if (fuzz === 'server') {
    const radius = Number(r.radiusM ?? r.radius_m) || 0;
    return {
      id: r.id, lat: r.lat, lng: r.lng, radius_m: radius, blurred: Boolean(r.blurred) || radius > 0,
      resonance_count: r.resonanceCount ?? r.resonance_count ?? 0, heat: r.heat ?? null,
      created_at: r.createdAt ?? r.created_at ? new Date(r.createdAt ?? r.created_at).toISOString() : null,
      expires_at: r.expiresAt ?? r.expires_at ? new Date(r.expiresAt ?? r.expires_at).toISOString() : null,
      ...placeFields(r, Boolean(r.blurred) || radius > 0), fuzz: 'server', mine: isMine(r.id),
      reply_count: r.replyCount ?? r.reply_count ?? 0, listen_count: r.listenCount ?? r.listen_count ?? 0, tags: r.tags ?? [],
      duration_ms: r.duration_ms ?? (r.duration_s ?? r.durationS) != null ? (r.duration_ms ?? Math.round((r.duration_s ?? r.durationS) * 1000)) : null,
    };
  }
  const lat = r.echo_lat ?? r.lat, lng = r.echo_lng ?? r.lng;
  const blurKnown = 'blurred' in r || 'caption' in r;
  const blurred = Boolean(r.blurred) || hasBlurMarker(r.caption) || !blurKnown;
  const f = blurred ? fuzzPoint(r.id, lat, lng) : { lat, lng, radiusM: 0 };
  return {
    id: r.id, lat: f.lat, lng: f.lng, radius_m: f.radiusM, blurred,
    resonance_count: r.resonance_count ?? 0, heat: r.heat ?? null,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    ...placeFields(r, blurred), fuzz: blurred ? 'client' : 'none', mine: isMine(r.id),
    duration_ms: r.duration_ms ?? (r.duration_s ?? r.durationS) != null ? (r.duration_ms ?? Math.round((r.duration_s ?? r.durationS) * 1000)) : null,
  };
}
export { mapRecord };

/** Fuzzed echoes inside a viewport { minLat, minLng, maxLat, maxLng } (+ local-only ones). */
export async function mapEchoes(bounds) {
  const b = bounds;
  const now = Date.now();
  const local = (await localBackend.listAllEchoes().catch(() => []))
    .filter((e) => !isExpired(e, now) && inBox(b, e.lat, e.lng))
    .map((e) => ({ ...mapRecord(e), source: 'local', mine: true }));
  for (const q of await listOutbox()) {
    if (inBox(b, q.lat, q.lng)) local.push({ ...mapRecord(q), source: 'queued', queued: true, mine: true });
  }
  const remote = await withFallback(async () => {
    const tryNew = mapMode === 'map_echoes' || (mapMode === null && !mapProbeAt) || now - mapProbeAt > MAP_REPROBE_MS;
    if (tryNew) {
      mapProbeAt = now;
      try {
        const rows = await sb(() => sbClient.mapEchoes(b));
        if (mapMode !== 'map_echoes') setTimeout(() => events.dispatchEvent(new CustomEvent('v2', { detail: { available: true } })), 0);
        mapMode = 'map_echoes';
        try { sessionStorage.removeItem(MAP_PROBE_KEY); } catch { /* ignore */ }
        return rows.map((r) => ({ ...mapRecord(r, 'server'), source: 'supabase' }));
      } catch (e) {
        // function not there yet (migration not run) -> legacy path; anything else is a real error
        if (!(e instanceof SupabaseError) || !['V2_MISSING', 'SCHEMA_MISSING', 'FORBIDDEN'].includes(e.code)) throw e;
        if (mapMode === 'map_echoes' || mapMode === null) mapMode = 'legacy-debug';
        try { sessionStorage.setItem(MAP_PROBE_KEY, String(now)); } catch { /* ignore */ }  // don't re-404 on reload
      }
    }
    const lat = (b.minLat + b.maxLat) / 2, lng = (b.minLng + b.maxLng) / 2;
    const radiusM = Math.min(20000, Math.max(200, haversineM(lat, lng, b.maxLat, b.maxLng)));
    if (mapMode !== 'legacy-nearby') {
      try {
        const rows = await sb(() => sbClient.debugEchoes({ lat, lng, radiusM }));
        mapMode = 'legacy-debug';
        return rows.map((r) => ({ ...mapRecord(r), source: 'supabase' }));
      } catch (e) {
        if (!(e instanceof SupabaseError) || !['SCHEMA_MISSING', 'FORBIDDEN'].includes(e.code)) throw e;
        mapMode = 'legacy-nearby';                                   // debug_echoes revoked: v2 is likely in
        mapProbeAt = 0;                                              // so look for map_echoes again on the next poll
      }
    }
    const rows = await sb(() => sbClient.nearbyEchoes({ lat, lng, radiusM: Math.min(500, radiusM) }));
    return rows.map((r) => ({ ...mapRecord(r), source: 'supabase' }));
  }, () => { mapMode = 'local'; return []; });
  return [...remote, ...local];
}

/** Take back an echo this device dropped (Supabase retract_echo, or delete the local copy). */
export async function retractEcho(id) {
  if (String(id).startsWith('q-')) {                                   // still in the outbox: just cancel the upload
    const db = await openDb(); const tx = db.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').delete(id); await txDone(tx); outboxChanged();
  } else if (await isLocalId(id)) {
    const db = await openDb();
    const tx = db.transaction(['echoes', 'audio'], 'readwrite');
    tx.objectStore('echoes').delete(id); tx.objectStore('audio').delete(id);
    await txDone(tx);
  } else {
    await sb(() => sbClient.retractEcho(id));
  }
  events.dispatchEvent(new CustomEvent('retract', { detail: { id } }));
  return true;
}
