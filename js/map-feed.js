// map-feed.js: keeps the shared map's echo list live.
//   1. Viewport polling: store.mapEchoes(bbox) every POLL_MS while the page is visible, and right after the map moves.
//   2. Supabase Realtime broadcast on the public topic 'echo-map' (works with the publishable key, no schema change):
//        'drop' / 'update' { id, lat, lng, radius_m, resonance_count, created_at, expires_at, blurred, fuzz }
//            radius_m 0 = exact pin; blurred echoes carry a 30–60 m glow centre instead of the spot
//        'gone'            { id }
//      After night crawler's migration-v2.sql a database trigger sends these (fuzz 'none' | 'server').
//      Before it, the dropping phone broadcasts its own drop/resonate/retract (fuzz 'self' | 'client').
//   Broadcasts are untrusted hints: anything a poll of that area doesn't confirm is removed again.
import * as store from './echo-store.js';
import { fuzzPoint } from './fuzz.js';

const TOPIC = 'echo-map';
const POLL_MS = 5000;
const POLL_TIMEOUT_MS = 12000;    // per poll
const GRACE_MS = 12000;           // keep an unconfirmed realtime echo this long before a poll may drop it
const MAX_SPAN_DEG = 1.2;         // never ask for more than ~130 km of map at once

const finite = Number.isFinite;
function validPayload(p) {
  return p && typeof p.id === 'string' && /^[0-9a-f-]{8,64}$/i.test(p.id) && finite(p.lat) && finite(p.lng)
    && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && finite(p.radius_m) && (p.radius_m === 0 || (p.radius_m >= 10 && p.radius_m <= 120))
    && !Number.isNaN(Date.parse(p.expires_at)) && Date.parse(p.expires_at) < Date.now() + 8 * 24 * 3600e3;
}

export function createMapFeed({ onChange = () => {}, onStatus = () => {}, onError = () => {} } = {}) {
  const echoes = new Map();       // id -> map record (+ seenAt, via, freshUntil)
  let bounds = null, timer = null, inflight = null, queued = false, channel = null, rtState = 'off';
  let lastPollAt = 0, lastError = null, destroyed = false;

  const emit = () => onChange([...echoes.values()]);
  const status = () => onStatus({ mode: store.mapMode, realtime: rtState, lastPollAt, error: lastError, count: echoes.size });

  function upsert(rec, via) {
    const prev = echoes.get(rec.id);
    const now = Date.now();
    // rows that don't carry place/duration (v1 / pre-004 polls) must not wipe what realtime or our own drop told us
    if (prev) for (const k of ['place_label', 'place_kind', 'place_name', 'level', 'duration_ms']) if (rec[k] == null && prev[k] != null) rec = { ...rec, [k]: prev[k] };
    echoes.set(rec.id, {
      ...prev, ...rec, mine: rec.mine ?? store.isMine(rec.id), via: prev?.via === 'poll' ? 'poll' : via,
      seenAt: now, firstSeenAt: prev?.firstSeenAt ?? now,
      freshUntil: prev ? prev.freshUntil : (via === 'realtime' || via === 'self' ? now + 8000 : 0),
    });
  }

  function sweepExpired() {
    const now = Date.now(); let changed = false;
    for (const [id, e] of echoes) if (e.expires_at && Date.parse(e.expires_at) <= now) { echoes.delete(id); changed = true; }
    return changed;
  }

  async function poll() {
    if (!bounds || destroyed) return;
    if (inflight) { queued = true; return inflight; }
    const b = bounds;
    inflight = (async () => {
      try {
        // a stalled request must never freeze the feed: give up after POLL_TIMEOUT_MS and poll again later
        const rows = await Promise.race([store.mapEchoes(b),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out refreshing echoes')), POLL_TIMEOUT_MS))]);
        lastError = null; lastPollAt = Date.now();
        const ids = new Set(rows.map((r) => r.id));
        const now = Date.now();
        for (const [id, e] of echoes) {           // reconcile only inside the polled box
          const inside = e.lat >= b.minLat && e.lat <= b.maxLat && e.lng >= b.minLng && e.lng <= b.maxLng;
          if (inside && !ids.has(id) && !(e.via !== 'poll' && now - e.firstSeenAt < GRACE_MS)) echoes.delete(id);
        }
        rows.forEach((r) => upsert(r, 'poll'));
        sweepExpired();
        emit();
      } catch (e) {
        const first = !lastError;
        lastError = e?.message || String(e);
        console.warn('[map-feed] poll failed', e);
        if (first) try { onError(e); } catch { /* ignore */ }
      } finally {
        inflight = null; status();
        if (queued) { queued = false; poll(); }
      }
    })();
    return inflight;
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => { if (document.visibilityState === 'visible') poll(); else if (sweepExpired()) emit(); }, POLL_MS);
  }

  async function connectRealtime() {
    const sb = await store.supabaseClient();
    if (!sb || destroyed) { rtState = 'unavailable'; status(); return; }
    channel = sb.channel(TOPIC, { config: { broadcast: { self: false, ack: false } } });
    const onMsg = (via) => ({ event, payload }) => {
      if (event === 'gone') { if (payload?.id && echoes.delete(payload.id)) emit(); return; }
      if (!validPayload(payload)) return;
      // Only migration-v2's trigger sends heat + fuzz 'none'/'server': map_echoes must exist now, switch over.
      if ('heat' in payload && (payload.fuzz === 'none' || payload.fuzz === 'server')) store.hintMigrationLive?.();
      const blurred = Boolean(payload.blurred) || payload.radius_m > 0;
      const rec = {
        id: payload.id, lat: payload.lat, lng: payload.lng, radius_m: blurred ? Math.max(10, payload.radius_m) : 0, blurred,
        resonance_count: Math.max(0, payload.resonance_count | 0), created_at: payload.created_at || null,
        expires_at: new Date(payload.expires_at).toISOString(), heat: finite(payload.heat) ? payload.heat : null,
        fuzz: blurred ? (payload.fuzz === 'server' ? 'server' : 'client') : 'none', source: 'supabase',
        // 004_place.sql payload: duration + place (the server never sends a blurred echo's name or level)
        ...(finite(payload.duration_s) ? { duration_ms: Math.round(payload.duration_s * 1000) } : {}),
        ...(payload.place_kind ? { place_kind: String(payload.place_kind) } : {}),
        ...(!blurred && payload.place_name ? { place_name: String(payload.place_name).slice(0, 120) } : {}),
        ...(!blurred && Number.isInteger(payload.level) ? { level: payload.level } : {}),
        ...(payload.place_label ? { place_label: String(payload.place_label).slice(0, 120) } : {}),
      };
      upsert(rec, via); emit();
      window.dispatchEvent(new CustomEvent('echo-map:realtime', { detail: { event, id: rec.id, at: Date.now() } }));
    };
    channel.on('broadcast', { event: 'drop' }, onMsg('realtime'))
      .on('broadcast', { event: 'update' }, onMsg('realtime'))
      .on('broadcast', { event: 'gone' }, onMsg('realtime'))
      .subscribe((s) => { rtState = s === 'SUBSCRIBED' ? 'live' : s.toLowerCase(); status(); });
  }

  // Pre-migration, the dropping phone announces its own changes (client-fuzzed). After it, the DB trigger does.
  const selfBroadcast = (event, payload) => {
    if (store.mapMode === 'map_echoes' || !channel) return;
    channel.send({ type: 'broadcast', event, payload }).catch?.(() => {});
  };
  const onDrop = (ev) => {
    const e = ev.detail; if (!e?.id || !finite(e.lat)) return;
    // Exact pin unless "Blur my spot" was on (then the same deterministic glow every client computes).
    const f = e.blurred ? fuzzPoint(e.id, e.lat, e.lng) : { lat: e.lat, lng: e.lng, radiusM: 0 };
    const rec = { id: e.id, lat: f.lat, lng: f.lng, radius_m: f.radiusM, blurred: Boolean(e.blurred),
      resonance_count: e.resonance_count ?? 0, created_at: e.created_at, expires_at: e.expires_at,
      fuzz: e.blurred ? 'client' : 'self', source: e.source, mine: true, queued: Boolean(e.queued),
      place_label: e.place_label || null, place_kind: e.place_kind || null,
      place_name: e.blurred ? null : e.place_name || null, level: e.blurred ? null : e.level ?? null, duration_ms: e.duration_ms ?? null };
    upsert(rec, 'self'); emit();
    if (e.source === 'supabase') {
      if (store.mapMode === 'map_echoes') setTimeout(poll, 600);  // pick up the server-fuzzed glow
      else selfBroadcast('drop', rec);
    }
  };
  const onResonate = (ev) => {
    const d = ev.detail || {}; const e = echoes.get(d.id); if (!e) return;
    const count = d.resonanceCount ?? d.resonance_count, exp = d.expiresAt ?? d.expires_at;
    if (finite(count)) e.resonance_count = count;
    if (exp) e.expires_at = new Date(exp).toISOString();
    emit();
    if (e.source === 'supabase') selfBroadcast('update', { id: e.id, lat: e.lat, lng: e.lng, radius_m: e.radius_m,
      blurred: Boolean(e.blurred), resonance_count: e.resonance_count, created_at: e.created_at, expires_at: e.expires_at,
      fuzz: e.blurred ? 'client' : 'self' });
  };
  const onRetract = (ev) => {
    const id = ev.detail?.id; if (!id) return;
    const e = echoes.get(id); echoes.delete(id); emit();
    if (e && e.source === 'supabase' && !String(id).startsWith('q-')) selfBroadcast('gone', { id });
  };
  store.events.addEventListener('drop', onDrop);
  store.events.addEventListener('resonate', onResonate);
  store.events.addEventListener('retract', onRetract);
  const onVis = () => { if (document.visibilityState === 'visible') poll(); };
  document.addEventListener('visibilitychange', onVis);

  schedule();
  connectRealtime().catch((e) => { rtState = 'error'; console.warn('[map-feed] realtime', e); status(); });

  return {
    /** bbox from the map: { minLat, minLng, maxLat, maxLng }. Clamped around its centre to MAX_SPAN_DEG. */
    setBounds(b) {
      const cLat = (b.minLat + b.maxLat) / 2, cLng = (b.minLng + b.maxLng) / 2;
      const hLat = Math.min(MAX_SPAN_DEG, b.maxLat - b.minLat) / 2, hLng = Math.min(MAX_SPAN_DEG, b.maxLng - b.minLng) / 2;
      bounds = { minLat: Math.max(-90, cLat - hLat), maxLat: Math.min(90, cLat + hLat),
        minLng: Math.max(-180, cLng - hLng), maxLng: Math.min(180, cLng + hLng) };
      return poll();
    },
    refresh: poll,
    get(id) { return echoes.get(id); },
    list: () => [...echoes.values()],
    status: () => ({ mode: store.mapMode, realtime: rtState, lastPollAt, error: lastError, count: echoes.size }),
    destroy() {
      destroyed = true; clearInterval(timer); channel?.unsubscribe?.();
      store.events.removeEventListener('drop', onDrop);
      store.events.removeEventListener('resonate', onResonate);
      store.events.removeEventListener('retract', onRetract);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}
