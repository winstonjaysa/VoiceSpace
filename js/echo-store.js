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
import * as sbClient from './echoes-client.js'; // night crawler's Supabase client (see SUPABASE BACKEND below)
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
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('echoes')) db.createObjectStore('echoes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

const audioUrlCache = new Map(); // id -> objectURL

const localBackend = {
  name: 'local-indexeddb',

  async dropEcho({ blob, mimeType, durationMs, lat, lng, accuracyM, heading, altitude }) {
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
// SUPABASE BACKEND: delegates to night crawler's final client js/echoes-client.js (copied verbatim from
// /home/box/shared/echolocation/backend/echoes-client.js; supabase-js loaded from esm.sh on first use).
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
  const msg = String(err?.message || err);
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
    source: 'supabase',
    ...extra,
  };
}

const supabaseBackend = {
  name: 'supabase',

  async dropEcho({ blob, mimeType, durationMs, lat, lng, accuracyM, heading, altitude, caption }) {
    validateDrop({ blob, lat, lng });
    // echoes-client derives the type from blob.type; make sure it carries the recorder's mimeType.
    const typed = blob.type ? blob : new Blob([blob], { type: mimeType || 'audio/webm' });
    const durationS = Math.min(60, Math.max(0.1, (durationMs || 0) / 1000));
    const id = await sb(() => sbClient.dropEcho({ blob: typed, lat, lng, accuracyM, heading, altitude, durationS, caption }));
    const now = Date.now();
    return {
      id, lat, lng, accuracy_m: numOrNull(accuracyM), heading: numOrNull(heading), altitude: numOrNull(altitude),
      created_at: new Date(now).toISOString(), expires_at: new Date(now + ECHO_TTL_MS).toISOString(),
      resonance_count: 0, audio_path: null, duration_ms: Math.round(durationMs || 0),
      mime_type: (typed.type || '').split(';')[0], source: 'supabase',
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

  async listAllEchoes({ lat, lng, radiusM = 20000 } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const rows = await sb(() => sbClient.debugEchoes({ lat, lng, radiusM }));
    return rows.map((r) => fromServerRow(r));
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
export let backendName = supabaseConfigured ? 'supabase' : localBackend.name;
export let backendError = supabaseConfigured ? null : 'Supabase not configured';

function fallBack(err) {
  if (!supabaseDown) console.warn('[echo-store] Supabase unavailable, using local IndexedDB fallback:', err.message);
  supabaseDown = true;
  backendName = localBackend.name;
  backendError = err.message;
  events.dispatchEvent(new CustomEvent('backend', { detail: { backend: backendName, error: err.message } }));
}

async function withFallback(remote, local) {
  if (!supabaseDown) {
    try { return await remote(); } catch (err) {
      if (!(err instanceof SupabaseError) || !err.unavailable) throw err;
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
  rememberPos(input.lat, input.lng);
  const saved = await withFallback(() => supabaseBackend.dropEcho(input),
    async () => ({ ...(await localBackend.dropEcho(input)), source: 'local' }));
  // Also carry trax's return shape ({ id, audioPath }) so either caller style works.
  const echo = { ...saved, audioPath: saved.audio_path };
  markMine(echo.id);
  events.dispatchEvent(new CustomEvent('drop', { detail: echo }));
  return echo;
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
 *  (debug_echoes RPC, 20 km radius); local includes expired ones. */
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
let mapProbeAt = 0;
const MAP_REPROBE_MS = 60_000;      // re-check for the migration once a minute, so it switches over by itself
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
  try { await sbReady(); return sbClient.getClient(); } catch { return null; }
}

const inBox = (b, lat, lng) => lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
function fuzzRow(r, fuzz = 'client') {
  const lat = r.echo_lat ?? r.lat, lng = r.echo_lng ?? r.lng;
  const f = fuzz === 'server' ? { lat, lng, radiusM: r.radius_m } : fuzzPoint(r.id, lat, lng);
  return {
    id: r.id, lat: f.lat, lng: f.lng, radius_m: f.radiusM,
    resonance_count: r.resonance_count ?? 0,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    fuzz, mine: isMine(r.id),
  };
}

/** Fuzzed echoes inside a viewport { minLat, minLng, maxLat, maxLng } (+ local-only ones). */
export async function mapEchoes(bounds) {
  const b = bounds;
  const now = Date.now();
  const local = (await localBackend.listAllEchoes())
    .filter((e) => !isExpired(e, now) && inBox(b, e.lat, e.lng))
    .map((e) => ({ ...fuzzRow(e), source: 'local', mine: true }));
  const remote = await withFallback(async () => {
    const tryNew = mapMode === 'map_echoes' || mapMode === null || now - mapProbeAt > MAP_REPROBE_MS;
    if (tryNew) {
      mapProbeAt = now;
      try {
        const rows = await sb(() => sbClient.mapEchoes(b));
        mapMode = 'map_echoes';
        return rows.map((r) => ({ ...fuzzRow(r, 'server'), source: 'supabase' }));
      } catch (e) {
        // function not there yet (migration not run) -> legacy path; anything else is a real error
        if (!(e instanceof SupabaseError) || !['SCHEMA_MISSING', 'FORBIDDEN'].includes(e.code)) throw e;
        if (mapMode === 'map_echoes' || mapMode === null) mapMode = 'legacy-debug';
      }
    }
    const lat = (b.minLat + b.maxLat) / 2, lng = (b.minLng + b.maxLng) / 2;
    const radiusM = Math.min(20000, Math.max(200, haversineM(lat, lng, b.maxLat, b.maxLng)));
    if (mapMode !== 'legacy-nearby') {
      try {
        const rows = await sb(() => sbClient.debugEchoes({ lat, lng, radiusM }));
        mapMode = 'legacy-debug';
        return rows.map((r) => ({ ...fuzzRow(r), source: 'supabase' }));
      } catch (e) {
        if (!(e instanceof SupabaseError) || !['SCHEMA_MISSING', 'FORBIDDEN'].includes(e.code)) throw e;
        mapMode = 'legacy-nearby';                                   // debug_echoes revoked
      }
    }
    const rows = await sb(() => sbClient.nearbyEchoes({ lat, lng, radiusM: Math.min(500, radiusM) }));
    return rows.map((r) => ({ ...fuzzRow(r), source: 'supabase' }));
  }, () => { mapMode = 'local'; return []; });
  return [...remote, ...local];
}

/** Take back an echo this device dropped (Supabase retract_echo, or delete the local copy). */
export async function retractEcho(id) {
  if (await isLocalId(id)) {
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
