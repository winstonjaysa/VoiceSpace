// App shell (v2): the shared live map is the home screen.
//   map (js/map.js) <- feed (js/map-feed.js: viewport polling + Supabase Realtime) <- store (js/echo-store.js)
//   record button -> record sheet (js/record.js) · tap a glow -> card -> "Walk to it" -> hunt (js/listen.js)
import * as store from './echo-store.js';
import { createMapView } from './map.js';
import { createMapFeed } from './map-feed.js';
import { mountRecordScreen } from './record.js';
import { openHunt, fmtDist } from './listen.js';
import { APP_VERSION, APP_BUILD, SW_CACHE } from './config.js';
import { onInstallChange, promptInstall } from './pwa.js';
import * as opened from './opened.js';
import { haptic, draggableSheet, cherryBurst, reduced as fxReduced } from './fx.js';
import { canReplyHere, loadThread, startTrail, createTrailWalk, trailsNearMe } from './v2/index.js';

const $ = (s) => document.querySelector(s);
const body = document.body;
const els = {
  map: $('#map'), card: $('[data-card]'), record: $('#screen-record'), listen: $('#screen-listen'),
  live: $('[data-live]'), liveText: $('[data-live-text]'), toast: $('[data-toast]'),
  fab: $('[data-record]'), listenBtn: $('[data-listen]'), locate: $('[data-locate]'),
  gps: $('[data-gps-pill]'), gpsText: $('[data-gps-text]'), outbox: $('[data-outbox]'), outboxText: $('[data-outbox-text]'),
  drawer: $('[data-drawer]'), drawerHandle: $('[data-drawer-handle]'), drawerList: $('[data-drawer-list]'), drawerTitle: $('[data-drawer-title]'),
  drawerNew: $('[data-drawer-new]'), drawerStats: $('[data-drawer-stats]'), help: $('[data-help]'), onboard: $('[data-onboard]'),
  recenter: $('[data-recenter]'), install: $('[data-install]'), iosHint: $('[data-ios-hint]'), trailwalk: $('[data-trailwalk]'), about: $('[data-about]'), aboutOpen: $('[data-about-open]'), skeleton: $('[data-skeleton]'),
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const params = new URLSearchParams(location.search);

let view = null, feed = null, me = null, geoWatch = null, followMe = true, cardId = null, recordApi = null, huntApi = null;
let viewportCount = 0, lastRawFix = null, compassHeading = null, compassAt = 0, gpsCourse = null, lastFollowAt = 0;

// ------------------------------------------------------------------ formatting
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function ago(iso) {
  if (!iso) return '—';
  const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}
function left(iso) {
  const m = Math.max(0, (Date.parse(iso) - Date.now()) / 60000);
  if (m < 60) return `${Math.max(1, Math.round(m))} min`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} d`;
}
const heatWord = (n) => (n >= 6 ? 'Hot' : n >= 2 ? 'Warm' : n >= 1 ? 'Stirring' : 'Quiet');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let toastT = 0;
const toastSeen = new Map();
/** Show a toast. `key` de-duplicates repeats of the same failure within 30 s. */
function toast(msg, ms = 2800, key = null, action = null) {
  if (key) { const t = toastSeen.get(key); if (t && Date.now() - t < 30000) return; toastSeen.set(key, Date.now()); }
  els.toast.textContent = msg; els.toast.hidden = false;
  els.toast.classList.toggle('has-action', Boolean(action));
  if (action) {
    const b = document.createElement('button'); b.className = 'toast-act'; b.textContent = action.label;
    b.addEventListener('click', () => { els.toast.classList.remove('show'); setTimeout(() => { els.toast.hidden = true; }, 300); action.fn(); }, { once: true });
    els.toast.append(' ', b); ms = Math.max(ms, 5000);
  }
  requestAnimationFrame(() => els.toast.classList.add('show'));
  clearTimeout(toastT);
  toastT = setTimeout(() => { els.toast.classList.remove('show'); setTimeout(() => { els.toast.hidden = true; }, 300); }, ms);
}

// ------------------------------------------------------------------ position
const blurR = (e) => (e?.blurred || e?.radius_m > 0 ? (e.radius_m || 45) : 0);
function distTo(e) {
  if (!me || !e) return null;
  return Math.max(0, store.haversineM(me.lat, me.lng, e.lat, e.lng) - blurR(e) * 0.5);
}

// GPS accuracy pill: always visible. good <= 10 m, ok <= 25 m, poor beyond; tap it to turn location on.
function setGps(q, text, label) {
  els.gps.dataset.q = q; els.gpsText.textContent = text;
  els.gps.setAttribute('aria-label', label || `GPS accuracy: ${text}`);
}
function updateGpsPill() {
  if (!me) return;
  const a = Math.round(me.accuracy || 0);
  const q = a <= 10 ? 'good' : a <= 25 ? 'ok' : 'poor';
  setGps(q, `GPS \u00b1${a} m`, `GPS accuracy plus or minus ${a} metres, ${q === 'good' ? 'good' : q === 'ok' ? 'fair' : 'poor'}`);
}

// Heading: compass (deviceorientation) first, GPS course over ground while walking as the fallback.
function currentHeading() {
  if (compassHeading != null && Date.now() - compassAt < 3000) return compassHeading;
  return gpsCourse;
}
function onOrientation(ev) {
  let h = null;
  if (Number.isFinite(ev.webkitCompassHeading)) h = ev.webkitCompassHeading;                // iOS: degrees from north
  else if (ev.absolute && Number.isFinite(ev.alpha)) h = (360 - ev.alpha) % 360;           // Android absolute
  if (h == null) return;
  const scr = (screen.orientation?.angle ?? window.orientation ?? 0) || 0;
  compassHeading = (h + scr + 360) % 360; compassAt = Date.now();
  if (me) { me.heading = currentHeading(); scheduleMeUpdate(); }
}
let compassOn = false;
function startCompass() {            // call inside a tap (iOS asks for permission)
  if (compassOn) return;
  const attach = () => {
    compassOn = true;
    window.addEventListener('deviceorientationabsolute', onOrientation);
    window.addEventListener('deviceorientation', onOrientation);
  };
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    DOE.requestPermission().then((r) => { if (r === 'granted') attach(); }).catch(() => {});
  } else if (DOE) attach();
}
let meRaf = 0;
function scheduleMeUpdate() {
  if (meRaf) return;
  meRaf = requestAnimationFrame(() => { meRaf = 0; view?.setMe(me); });
}

function setFollow(on) {
  followMe = on;
  els.locate.setAttribute('aria-pressed', String(on));
  els.locate.setAttribute('aria-label', on ? 'Following you on the map' : 'Follow me on the map');
  els.recenter.hidden = on || !me;
}

let geoErrShown = false;
function startGeo() {
  if (geoWatch != null || !('geolocation' in navigator)) {
    if (!('geolocation' in navigator)) setGps('off', 'No GPS', 'This device has no location support');
    return;
  }
  if (!me) setGps('locating', 'GPS \u2026', 'Finding your location');
  geoWatch = navigator.geolocation.watchPosition((p) => {
    const first = !me;
    const c = p.coords;
    if (Number.isFinite(c.heading) && (c.speed ?? 0) > 0.7) gpsCourse = c.heading;
    me = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, heading: null };
    me.heading = currentHeading();
    lastRawFix = { coords: { latitude: me.lat, longitude: me.lng, accuracy: me.accuracy, altitude: c.altitude }, timestamp: p.timestamp };
    recordApi?.setFix?.(lastRawFix);
    view?.setMe(me);
    updateGpsPill();
    geoErrShown = false;
    if (first) setFollow(followMe);
    if (view?.ready && followMe && !cardId && !body.classList.contains('has-overlay')) {
      if (first) view.jumpTo(me, Math.max(15.5, view.map.getZoom()));
      else if (Date.now() - lastFollowAt > 1200) { lastFollowAt = Date.now(); view.follow(me); }
    }
    if (cardId) renderCard(cardId);
    if (trailWalk) trailWalk.update(me);
    updateDrawer();
  }, (err) => {
    if (err.code === 1) {
      geoWatch = null; setGps('off', 'GPS off', 'Location is off. Tap to turn it on.');
      toast('Location is off, so you can\u2019t be placed on the map.', 6000, 'geo-denied', { label: 'How to fix', fn: () => showHelp('location') });
    } else if (!geoErrShown) {
      geoErrShown = true;
      if (!me) setGps('poor', 'No GPS fix', 'No GPS fix yet');
      toast(err.code === 3 ? 'Still looking for a GPS fix. Step outside or near a window.' : 'GPS is unavailable right now.', 5000, 'geo-err',
        { label: 'Retry', fn: () => { if (geoWatch != null) navigator.geolocation.clearWatch(geoWatch); geoWatch = null; geoErrShown = false; startGeo(); } });
    }
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
navigator.permissions?.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') startGeo(); }).catch(() => {});

// ------------------------------------------------------------------ live status pill
function updateLive(st = feed?.status()) {
  if (!st) return;
  const rt = st.realtime === 'live';
  const state = st.mode === 'local' ? 'offline' : rt ? 'live' : st.lastPollAt ? 'polling' : 'connecting';
  els.live.dataset.state = state;
  body.dataset.feedMode = st.mode || '';
  body.dataset.realtime = st.realtime || '';
  const n = viewportCount;
  if (state !== 'connecting') els.skeleton?.classList.add('done');
  els.liveText.textContent = state === 'offline' ? 'Offline · this device only'
    : state === 'connecting' ? '' : `${rt ? 'Live' : 'Updating'} · ${n ? plural(n, 'echo') : 'no echoes here yet'}`;
}

// ------------------------------------------------------------------ echo card
function closeCard() {
  cardId = null; els.card.dataset.shape = ''; els.card.classList.remove('open');
  setTimeout(() => { if (!cardId) els.card.hidden = true; }, reducedMotion ? 0 : 280);
}
const fmtLen = (e) => { const ms = e.duration_ms || opened.durationMs(e.id); if (!ms) return '\u2014'; const t = Math.round(ms / 1000); return `0:${String(t).padStart(2, '0')}`; };
const fmtPlays = (e) => (Number.isFinite(e.listen_count) ? String(e.listen_count) : '\u2014');
function renderCard(id) {
  const e = feed.get(id);
  if (!e) { closeCard(); return; }
  const d = distTo(e);
  const res = e.resonance_count || 0;
  const blurred = blurR(e) > 0, queued = Boolean(e.queued);
  const where = d == null ? (blurred ? 'Somewhere in this glow' : 'Pinned right here')
    : blurred ? (d < 30 ? 'You\u2019re inside the glow' : `~${fmtDist(d)} away`)
      : d < 12 ? 'You\u2019re right on it' : `${fmtDist(d)} away`;
  const place = e.place_label ? ` near ${esc(e.place_label)}` : '';
  const note = queued ? 'Waiting for a connection. It uploads by itself as soon as you\u2019re back online.'
    : blurred ? `Blurred by its author: the spot is somewhere inside the ${Math.round(blurR(e))} m glow${place}. Walk there and listen for it.`
      : `Pinned exactly here${place}. Walk to the pin and listen.`;
  const lifeFrac = Math.max(0, Math.min(1, (Date.parse(e.expires_at) - Date.now()) / (24 * 3600e3)));
  // Same echo already shown: patch text in place so a tap in progress (or an open thread) survives GPS/feed updates.
  const shape = `${id}|${queued}|${Boolean(e.mine)}|${v2On()}|${blurred}`;
  if (els.card.dataset.shape === shape && els.card.querySelector('.card-head')) {
    const set = (sel, v, attr) => { const n = els.card.querySelector(sel); if (n && (attr ? n.getAttribute(attr) : n.innerHTML) !== v) attr ? n.setAttribute(attr, v) : (n.innerHTML = v); };
    set('.card-title .eyebrow', `${e.mine ? 'Your echo' : opened.isOpened(e.id) ? 'Echo \u00b7 opened' : '\u{1F352} Unopened'} · ${queued ? '<span class="tag-queued">Queued, will upload</span>' : heatWord(res)}${blurred ? ' · Blurred' : ''}`);
    set('.card-title strong', where);
    set('[data-stat="age"]', esc(ago(e.created_at))); set('[data-stat="left"]', esc(left(e.expires_at)));
    set('[data-stat="res"]', String(res)); set('[data-stat="len"]', fmtLen(e)); set('[data-stat="plays"]', fmtPlays(e)); set('[data-stat="dist"]', d == null ? '—' : (blurred ? '~' : '') + fmtDist(d));
    set('.life i', `transform:scaleX(${lifeFrac.toFixed(3)})`, 'style');
    set('.card-note', note);
    const glyph = els.card.querySelector('.card-glyph'); if (glyph) glyph.dataset.heat = heatWord(res).toLowerCase();
    const row = els.card.querySelector('.v2-row');
    if (row && !queued) {
      const html = replyRow(e);
      if (row.dataset.src !== html) { const t = document.createElement('template'); t.innerHTML = html.trim(); t.content.firstChild.dataset.src = html; row.replaceWith(t.content.firstChild); }
    }
    return;
  }
  els.card.dataset.id = id; els.card.dataset.shape = shape;
  els.card.innerHTML = `
    <div class="grab" aria-hidden="true"></div>
    <header class="card-head">
      <div class="card-glyph" data-heat="${heatWord(res).toLowerCase()}" aria-hidden="true"><span></span><span></span></div>
      <div class="card-title">
        <span class="eyebrow">${e.mine ? 'Your echo' : opened.isOpened(e.id) ? 'Echo \u00b7 opened' : '\u{1F352} Unopened'} · ${queued ? '<span class="tag-queued">Queued, will upload</span>' : heatWord(res)}${blurred ? ' · Blurred' : ''}</span>
        <strong>${where}</strong>
      </div>
      <button class="icon-btn" data-card-close aria-label="Close echo details"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </header>
    <dl class="stats">
      <div><dt>Distance</dt><dd data-stat="dist">${d == null ? '—' : (blurred ? '~' : '') + fmtDist(d)}</dd></div>
      <div><dt>Length</dt><dd data-stat="len">${fmtLen(e)}</dd></div>
      <div><dt>Plays</dt><dd data-stat="plays">${fmtPlays(e)}</dd></div>
      <div><dt>Dropped</dt><dd data-stat="age">${esc(ago(e.created_at))}</dd></div>
      <div><dt>Fades</dt><dd data-stat="left">${esc(left(e.expires_at))}</dd></div>
      <div><dt>Resonance</dt><dd data-stat="res">${res}</dd></div>
    </dl>
    <div class="life" role="img" aria-label="Time left: ${esc(left(e.expires_at))}"><i style="transform:scaleX(${lifeFrac.toFixed(3)})"></i></div>
    <p class="card-note">${note}</p>
    ${queued ? '' : replyRow(e)}
    <div class="thread" data-thread hidden></div>
    <div class="row">
      ${e.mine ? `<button class="btn" data-retract>${queued ? 'Cancel upload' : 'Take it back'}</button>` : ''}
      ${queued ? '' : `<button class="btn primary" data-walk aria-label="Walk to this echo and listen">`}
        ${queued ? '' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l6 16-6-4-6 4z"/></svg>Walk to it</button>'}
    </div>`;
}
// ------------------------------------------------------------------ v2 (trax): replies, threads, trails
const v2On = () => store.mapMode === 'map_echoes';
function replyRow(e) {
  if (!v2On()) {
    return `<div class="row v2-row"><button class="btn small" disabled aria-describedby="v2hint">Reply here</button>
      <p class="v2-hint" id="v2hint">Replies, threads, capsules and trails arrive with the backend update.</p></div>`;
  }
  const chk = me ? canReplyHere(e, me) : { ok: false, reason: 'no-fix' };
  const label = chk.ok ? 'Reply here' : chk.reason === 'too-far' ? `Reply \u00b7 walk ${Math.ceil(chk.moveM)} m closer` : 'Reply here';
  const n = e.reply_count || 0;
  return `<div class="row v2-row">
    <button class="btn small" data-reply ${chk.ok ? '' : 'aria-disabled="true"'}>${label}</button>
    <button class="btn small" data-thread-open ${n ? '' : 'disabled'}>${n ? `Thread \u00b7 ${n}` : 'No replies yet'}</button></div>`;
}
async function showThread(e) {
  const box = els.card.querySelector('[data-thread]'); if (!box) return;
  box.hidden = false; box.innerHTML = '<div class="card-skel"></div><div class="card-skel" style="width:70%"></div>';
  try {
    const client = await store.v2Client(); if (!client) throw new Error(store.V2_HINT);
    const rows = await loadThread(client, e.parent_id || e.id, me || e);
    box.innerHTML = rows.length ? `<ol aria-label="Replies">${rows.map((r) => `<li><button class="thread-item" data-thread-walk="${r.id}">
      <span>Reply \u00b7 ${esc(ago(r.createdAt))}</span><span>${r.distanceM != null ? fmtDist(r.distanceM) : ''}</span></button></li>`).join('')}</ol>`
      : '<p class="v2-hint">No replies yet. Walk there and leave the first.</p>';
    box._rows = rows;
  } catch (err) { box.innerHTML = `<p class="v2-hint">${esc(err.friendly || err.message)}</p>`; toast(`Couldn\u2019t load the thread: ${err.friendly || err.message}`); }
}

// trails: an active trail (new drops become its stops) and a trail walk (next stop, distance, direction, progress)
const TRAIL_KEY = 'echolocation.activeTrail';
let activeTrail = (() => { try { return JSON.parse(localStorage.getItem(TRAIL_KEY)); } catch { return null; } })();
function setActiveTrail(t) { activeTrail = t; try { t ? localStorage.setItem(TRAIL_KEY, JSON.stringify(t)) : localStorage.removeItem(TRAIL_KEY); } catch { /* ignore */ } }
let trailWalk = null;
async function walkTrail(trail) {
  try {
    const client = await store.v2Client(); if (!client) throw new Error(store.V2_HINT);
    trailWalk = createTrailWalk({ client, trailId: trail.id, onState: renderTrailWalk });
    trailWalk.trail = trail;
    await trailWalk.load();
    if (me) trailWalk.update(me);
    closeAbout(); els.trailwalk.hidden = false;
  } catch (err) { trailWalk = null; toast(`Couldn\u2019t start the trail: ${err.friendly || err.message}`, 3600); }
}
function renderTrailWalk(st) {
  if (!trailWalk || !st) return;
  const n = st.stops.length, k = Math.min(st.index + 1, n);
  const rel = st.bearingDeg == null ? 0 : st.bearingDeg - (Number.isFinite(currentHeading()) ? currentHeading() : 0);
  els.trailwalk.innerHTML = st.done ? `
    <div class="tw-head"><span class="eyebrow">Trail complete</span><strong>${esc(st.name || trailWalk.trail.name)}</strong></div>
    <div class="life"><i style="transform:scaleX(1)"></i></div>
    <div class="row"><button class="btn small" data-tw-end>Done</button></div>`
    : n === 0 ? `<div class="tw-head"><span class="eyebrow">Trail</span><strong>${esc(trailWalk.trail.name)}</strong></div>
      <p class="v2-hint">No visible stops yet.</p><div class="row"><button class="btn small" data-tw-end>Close</button></div>` : `
    <div class="tw-head">
      <svg class="tw-arrow" viewBox="0 0 24 24" style="transform:rotate(${rel.toFixed(0)}deg)" aria-hidden="true"><path d="M12 3l6 16-6-4-6 4z"/></svg>
      <div><span class="eyebrow">${esc(st.name || trailWalk.trail.name)} \u00b7 stop ${k} of ${n}</span>
      <strong data-tw-dist>${st.arrived ? 'You\u2019re at the stop' : st.distanceM != null ? `${fmtDist(st.distanceM)} to the next stop` : 'Finding you\u2026'}</strong>
      ${st.next?.placeLabel ? `<span class="tw-place">${esc(st.next.placeLabel)}</span>` : ''}</div>
    </div>
    <div class="life" role="progressbar" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${st.index}" aria-label="Trail progress"><i style="transform:scaleX(${st.progress.toFixed(3)})"></i></div>
    <div class="row">
      ${st.arrived ? '<button class="btn small primary" data-tw-listen>Listen</button><button class="btn small" data-tw-next>Next stop</button>' : '<button class="btn small" data-tw-skip>Skip</button>'}
      <button class="btn small" data-tw-end aria-label="End trail walk">End</button>
    </div>`;
  els.trailwalk.dataset.arrived = st.arrived ? '1' : '';
}
els.trailwalk.addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b || !trailWalk) return;
  const st = trailWalk.state();
  if (b.matches('[data-tw-end]')) { trailWalk = null; els.trailwalk.hidden = true; }
  else if (b.matches('[data-tw-skip]')) trailWalk.skip();
  else if (b.matches('[data-tw-next]')) trailWalk.markVisited();
  else if (b.matches('[data-tw-listen]') && st.next) startHunt(feed.get(st.next.id) || { id: st.next.id, lat: st.next.lat, lng: st.next.lng, radius_m: 0 });
});

function openCard(id) {
  cardId = id; renderCard(id); haptic('tick'); opened.markSeen([id]); updateDrawer();
  const e = feed.get(id);
  setFollow(false);
  // keep the glow visible above the sheet
  if (e && view?.ready) view.map.easeTo({ center: [e.lng, e.lat], offset: [0, -150], duration: reducedMotion ? 0 : 600 });
  els.card.hidden = false;
  requestAnimationFrame(() => els.card.classList.add('open'));
}
els.card.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button'); if (!t) return;
  if (t.matches('[data-card-close]')) closeCard();
  else if (t.matches('[data-walk]')) { const e = feed.get(cardId); closeCard(); startHunt(e); }  // sync: tap gesture
  else if (t.matches('[data-reply]')) {
    const e = feed.get(cardId); const chk = me ? canReplyHere(e, me) : { ok: false };
    if (!chk.ok) { toast(chk.moveM != null ? `Walk ${Math.ceil(chk.moveM)} m closer to reply here` : 'Waiting for your location\u2026'); return; }
    openRecord({ autoStart: true, replyTo: e });
  }
  else if (t.matches('[data-thread-open]')) showThread(feed.get(cardId));
  else if (t.matches('[data-thread-walk]')) {
    const r = (els.card.querySelector('[data-thread]')._rows || []).find((x) => x.id === t.dataset.threadWalk);
    if (r) { closeCard(); startHunt(feed.get(r.id) || { id: r.id, lat: r.lat, lng: r.lng, radius_m: 0 }); }
  }
  else if (t.matches('[data-retract]')) {
    t.disabled = true; t.textContent = 'Taking it back\u2026';
    const q = String(cardId).startsWith('q-');
    try { await store.retractEcho(cardId); closeCard(); toast(q ? 'Upload cancelled' : 'Echo taken back'); } catch (e) { t.disabled = false; t.textContent = 'Take it back'; toast(`Couldn\u2019t take it back: ${e.friendly || e.message}`); }
  }
});

// ------------------------------------------------------------------ overlays
function showOverlay(el) { el.hidden = false; requestAnimationFrame(() => el.classList.add('open')); body.classList.add('has-overlay'); }
function hideOverlay(el) {
  el.classList.remove('open');
  setTimeout(() => { el.hidden = true; if (els.record.hidden && els.listen.hidden) body.classList.remove('has-overlay'); }, reducedMotion ? 0 : 320);
}

function openRecord({ autoStart = true, replyTo = null } = {}) {
  closeCard();
  recordApi?.destroy?.();
  showOverlay(els.record);
  startGeo();
  recordApi = mountRecordScreen(els.record, {
    autoStart, replyTo, activeTrail: v2On() ? activeTrail : null,
    onClose: closeRecord,
    onToast: (m) => toast(m, 3600),
    onHelp: (k) => showHelp(k),
    onDropped: (echo) => {
      closeRecord();
      setTimeout(() => {
        const rec = feed.get(echo.id);
        if (rec) { view.jumpTo(rec, 16.4); openCard(echo.id); }
      }, 350);
    },
  });
  if (lastRawFix && Date.now() - lastRawFix.timestamp < 120000) recordApi.setFix(lastRawFix);  // own watch refines it
}
function closeRecord() {
  recordApi?.destroy?.(); recordApi = null;
  hideOverlay(els.record);
  setTimeout(() => { if (els.record.hidden) els.record.innerHTML = ''; }, 400);
}

function startHunt(target = null) {
  huntApi?.close();
  showOverlay(els.listen);
  startGeo();
  huntApi = openHunt(els.listen, { target, initialFix: lastRawFix, onClose: () => { huntApi = null; hideOverlay(els.listen); },
    onError: (e) => toast(`Couldn\u2019t start listening: ${e.friendly || e.message || e}`, 5000, null,
      /denied|permission/i.test(String(e?.message)) ? { label: 'How to fix', fn: () => showHelp('location') } : { label: 'Try again', fn: () => startHunt(target) }) });
}

els.fab.addEventListener('click', () => { haptic('tap'); drawerCtl.snapTo(0); openRecord({ autoStart: true }); });
els.listenBtn.addEventListener('click', () => startHunt(null));
function recenter() {
  startGeo(); startCompass(); setFollow(true); closeCard();
  if (me) view?.flyTo(me, Math.max(16, view.map.getZoom())); else toast('Finding you\u2026', 2400, 'finding');
}
els.locate.addEventListener('click', () => {
  if (followMe && me) { setFollow(false); toast('Follow off \u00b7 the map stays put', 2000); } else recenter();
});
els.recenter.addEventListener('click', recenter);
els.gps.addEventListener('click', () => { startGeo(); startCompass(); if (me) toast(`GPS accurate to \u00b1${Math.round(me.accuracy)} m`, 2200); });

// ------------------------------------------------------------------ outbox (drops waiting for a connection)
async function updateOutbox(n) {
  if (n == null) n = await store.outboxCount();
  els.outbox.hidden = n === 0;
  els.outboxText.textContent = n === 1 ? 'Queued, will upload' : `${n} queued, will upload`;
  els.outbox.setAttribute('aria-label', `${n} echo${n === 1 ? '' : 'es'} queued. Tap to retry upload now.`);
}
store.events.addEventListener('outbox', (ev) => {
  updateOutbox(ev.detail.count);
  if (ev.detail.sent) toast(ev.detail.sent === 1 ? 'Your queued echo is uploaded' : `${ev.detail.sent} queued echoes uploaded`);
});
store.events.addEventListener('outbox-failed', (ev) => {
  toast(`A queued echo couldn\u2019t upload: ${ev.detail.error}${ev.detail.dropped ? ' (gave up)' : ''}`, 4200);
});
store.events.addEventListener('backend', (ev) => {
  if (ev.detail.error) toast('Can\u2019t reach the shared map. New echoes stay on this phone for now.', 3600, 'backend-down');
});
els.outbox.addEventListener('click', async () => {
  if (navigator.onLine === false) { toast('Still offline. It uploads as soon as you\u2019re back.'); return; }
  els.outboxText.textContent = 'Uploading\u2026';
  const r = await store.flushOutbox();
  if (r.left) { updateOutbox(r.left); toast('Couldn\u2019t upload yet. Will keep trying.'); }
});
window.addEventListener('offline', () => toast('You\u2019re offline. New echoes queue and upload later.', 3200, 'offline'));

// ------------------------------------------------------------------ about / settings sheet
function renderAbout() {
  const st = feed?.status() || {};
  const mode = { map_echoes: 'Shared map (v2 backend)', 'legacy-debug': 'Shared map (v1 backend)', 'legacy-nearby': 'Shared map, nearby only', local: 'This device only' }[st.mode] || 'Connecting';
  els.about.innerHTML = `
    <div class="grab" aria-hidden="true"></div>
    <header class="card-head">
      <div class="card-title"><span class="eyebrow">About</span><h2 id="about-title">Echolocation</h2></div>
      <button class="icon-btn" data-about-close aria-label="Close about"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </header>
    <dl>
      <dt>Version</dt><dd data-version>v${esc(APP_VERSION)}</dd>
      <dt>Build</dt><dd>${esc(APP_BUILD)}</dd>
      <dt>Cache</dt><dd>${esc(SW_CACHE)}</dd>
      <dt>Backend</dt><dd>${esc(mode)}</dd>
      <dt>Live updates</dt><dd>${st.realtime === 'live' ? 'On' : 'Polling every 5 s'}</dd>
      <dt>GPS</dt><dd>${me ? `\u00b1${Math.round(me.accuracy)} m` : 'Off'}</dd>
      <dt>Heading</dt><dd>${Number.isFinite(currentHeading()) ? `${Math.round(currentHeading())}\u00b0 (${compassHeading != null && Date.now() - compassAt < 3000 ? 'compass' : 'GPS course'})` : 'Not available'}</dd>
      <dt>Queued drops</dt><dd data-about-queue>\u2026</dd>
    </dl>
    <section class="about-trails" aria-label="Trails">
      <h3>Trails</h3>
      ${v2On() ? `
        <p class="muted">${activeTrail ? `New echoes are added to <strong>${esc(activeTrail.name)}</strong> (you can switch it off per drop).` : 'Chain your echoes into a walk others can follow.'}</p>
        <div class="trail-new"><label class="sr" for="trail-name">Trail name</label>
          <input id="trail-name" data-trail-name maxlength="80" placeholder="Name a new trail" autocomplete="off">
          <button class="btn small" data-trail-create>Create</button></div>
        <div class="row">${activeTrail ? '<button class="btn small" data-trail-stop>Stop adding</button>' : ''}<button class="btn small" data-trail-near>Trails near me</button></div>
        <ul class="trail-list" data-trail-list></ul>`
      : '<p class="v2-hint">Trails, replies and time capsules need the backend update (migration-v2.sql). They switch on by themselves once it\u2019s installed.</p>'}
    </section>
    <p class="muted">Echoes are exact pins unless their author turned on \u201cBlur my spot\u201d. Map \u00a9 OpenStreetMap contributors, OpenFreeMap.</p>
    <div class="row"><button class="btn" data-about-close>Close</button></div>`;
  store.outboxCount().then((n) => { const q = els.about.querySelector('[data-about-queue]'); if (q) q.textContent = String(n); });
}
function openAbout() {
  closeCard(); renderAbout(); els.about.hidden = false;
  requestAnimationFrame(() => els.about.classList.add('open'));
  els.about.querySelector('[data-about-close]')?.focus();
}
function closeAbout() {
  els.about.classList.remove('open');
  setTimeout(() => { els.about.hidden = true; }, reducedMotion ? 0 : 280);
  els.aboutOpen.focus();
}
els.aboutOpen.addEventListener('click', openAbout);
els.about.addEventListener('click', async (ev) => {
  if (ev.target.closest('[data-about-close]')) { closeAbout(); return; }
  const b = ev.target.closest('button'); if (!b) return;
  try {
    if (b.matches('[data-trail-create]')) {
      const name = els.about.querySelector('[data-trail-name]').value;
      const client = await store.v2Client(); if (!client) throw new Error(store.V2_HINT);
      b.disabled = true;
      const id = await startTrail(client, { name });
      setActiveTrail({ id, name: name.trim().slice(0, 80) }); renderAbout();
      toast(`Trail \u201c${activeTrail.name}\u201d created. Your next drops become its stops.`, 3600);
    } else if (b.matches('[data-trail-stop]')) { setActiveTrail(null); renderAbout(); }
    else if (b.matches('[data-trail-near]')) {
      const client = await store.v2Client(); if (!client) throw new Error(store.V2_HINT);
      const c = me || view?.map.getCenter(); const list = els.about.querySelector('[data-trail-list]');
      list.innerHTML = '<li><div class="card-skel"></div></li>';
      const trails = await trailsNearMe(client, { lat: c.lat, lng: c.lng, radiusM: 3000 });
      list._trails = trails;
      list.innerHTML = trails.length ? trails.map((t) => `<li><button class="thread-item" data-trail-walk="${esc(t.id)}">
        <span>${esc(t.name)} \u00b7 ${t.stopCount} stop${t.stopCount === 1 ? '' : 's'}</span><span>${fmtDist(t.distanceM || 0)}</span></button></li>`).join('')
        : '<li class="v2-hint">No trails within 3 km yet.</li>';
    } else if (b.matches('[data-trail-walk]')) {
      const t = (els.about.querySelector('[data-trail-list]')._trails || []).find((x) => String(x.id) === b.dataset.trailWalk);
      if (t) walkTrail(t);
    }
  } catch (err) { b.disabled = false; toast(err.friendly || err.message, 3600); }
});
store.events.addEventListener('v2', () => { if (cardId) renderCard(cardId); if (!els.about.hidden) renderAbout(); });
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!els.about.hidden) closeAbout(); else if (cardId) closeCard();
});

// uncaught failures still get a toast (and never a blank screen)
window.addEventListener('unhandledrejection', (ev) => {
  console.warn('[app] unhandled', ev.reason);
  toast(`Something went wrong: ${ev.reason?.friendly || ev.reason?.message || ev.reason}`, 3600, 'unhandled');
  ev.preventDefault();
});
window.addEventListener('error', (ev) => { if (ev.message) toast('Something went wrong.', 5000, 'error', { label: 'Reload', fn: () => location.reload() }); });

// ------------------------------------------------------------------ boot
async function waitForMapLibre(ms = 10000) {
  const t0 = Date.now();
  while (!window.maplibregl && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return Boolean(window.maplibregl);
}

let knownIds = null;
async function boot() {
  feed = createMapFeed({
    onChange: (list) => {
      view?.setEchoes(list);
      const b = view?.ready ? view.bounds() : null;
      viewportCount = b ? list.filter((e) => e.lat >= b.minLat && e.lat <= b.maxLat && e.lng >= b.minLng && e.lng <= b.maxLng).length : list.length;
      body.dataset.echoCount = String(list.length);
      updateLive();
      if (cardId) { if (feed.get(cardId)) renderCard(cardId); else closeCard(); }
      // pins that just arrived drop in (not on first load)
      const ids = new Set(list.map((e) => e.id));
      if (knownIds) for (const e of list) if (!knownIds.has(e.id) && !e.queued) view?.dropIn(e, { cherry: !e.mine && !opened.isOpened(e.id) });
      knownIds = ids;
      updateDrawer();
    },
    onStatus: updateLive,
    onError: (e) => toast(`Couldn\u2019t refresh echoes: ${e?.friendly || e?.message || e}`, 5000, 'poll', { label: 'Retry', fn: () => feed.refresh?.() }),
  });
  window.addEventListener('echo-map:realtime', (ev) => {
    if (ev.detail.event === 'drop' && !store.isMine(ev.detail.id)) toast('A new echo just surfaced on the map');
  });

  const last = store.lastKnownPosition();
  const qLat = parseFloat(params.get('lat')), qLng = parseFloat(params.get('lng'));
  const center = Number.isFinite(qLat) && Number.isFinite(qLng) ? { lat: qLat, lng: qLng } : last ? { lat: last.lat, lng: last.lng } : null;
  if (!(await waitForMapLibre())) {
    els.liveText.textContent = 'Map failed to load'; els.skeleton?.classList.add('done');
    toast('The map couldn\u2019t load. Check your connection.', 60000, null, { label: 'Reload', fn: () => location.reload() });
    return;
  }
  view = createMapView(els.map, {
    center, zoom: parseFloat(params.get('z')) || (center ? 15.5 : 12),
    onSelect: (id) => (id ? openCard(id) : closeCard()),
    onMove: (b) => { feed.setBounds(b); },
    onReady: () => {
      if (me) view.setMe(me); view.setEchoes(feed.list());
      els.skeleton?.classList.add('done'); setTimeout(() => els.skeleton?.remove(), 700);
    },
    onUserPan: () => setFollow(false),
    onError: (e) => {
      const m = String(e?.error?.message || '');
      if (!view?.ready) toast('Map tiles are slow to load\u2026', 3000, 'map-err');
      else if (/Failed to fetch|NetworkError|AJAXError/i.test(m)) toast('Some map tiles didn\u2019t load.', 3000, 'tiles');
    },
  });
  window.__echoApp = { store, feed, view, opened, drawer: () => drawerCtl, showHelp, openCard, startHunt, openRecord, openAbout, setFollow, walkTrail, setActiveTrail,
    get trailWalk() { return trailWalk; },
    get me() { return me; }, get followMe() { return followMe; },
    get lastFix() { return lastRawFix ? { lat: lastRawFix.coords.latitude, lng: lastRawFix.coords.longitude, accuracy: lastRawFix.coords.accuracy, ts: lastRawFix.timestamp } : null; } };
  // drops made offline: retry now (app start) and whenever the connection comes back (store listens for 'online')
  updateOutbox();
  setTimeout(() => store.flushOutbox().catch(() => {}), 1500);
  if (typeof window.DeviceOrientationEvent?.requestPermission !== 'function') startCompass();  // no prompt needed off iOS

  // legacy deep links from v1
  if (location.hash === '#record') { history.replaceState(null, '', location.pathname + location.search); openRecord({ autoStart: false }); }
}
boot();

// ------------------------------------------------------------------ help sheet: every error has a next step
const isIOSDevice = /iPhone|iPad|iPod/.test(navigator.userAgent);
const HELP = {
  location: () => ({ title: 'Turn on location', steps: isIOSDevice
    ? ['Open <strong>Settings</strong> \u203a <strong>Privacy &amp; Security</strong> \u203a <strong>Location Services</strong>.', 'Set <strong>Safari Websites</strong> (or Echolocation, if installed) to <strong>While Using</strong>.', 'Come back here and tap <strong>Try again</strong>.']
    : ['Tap the <strong>lock / tune icon</strong> next to the address bar.', 'Open <strong>Permissions</strong> and set <strong>Location</strong> to <strong>Allow</strong>.', 'Come back here and tap <strong>Try again</strong>.'],
    action: 'Try again', fn: () => { if (geoWatch != null) navigator.geolocation.clearWatch(geoWatch); geoWatch = null; startGeo(); } }),
  mic: () => ({ title: 'Allow the microphone', steps: isIOSDevice
    ? ['Open <strong>Settings</strong> \u203a <strong>Safari</strong> \u203a <strong>Microphone</strong>.', 'Choose <strong>Ask</strong> or <strong>Allow</strong>.', 'Come back and tap <strong>Drop</strong> again.']
    : ['Tap the <strong>lock / tune icon</strong> next to the address bar.', 'Set <strong>Microphone</strong> to <strong>Allow</strong>.', 'Come back and tap <strong>Drop</strong> again.'],
    action: 'Drop an echo', fn: () => openRecord({ autoStart: true }) }),
};
function showHelp(kind) {
  const h = HELP[kind]?.(); if (!h) return;
  els.help.innerHTML = `<div class="grab" aria-hidden="true"></div>
    <header class="card-head"><div class="card-title"><span class="eyebrow">Quick fix</span><strong id="help-title">${h.title}</strong></div>
      <button class="icon-btn" data-help-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>
    <ol class="ios-steps help-steps">${h.steps.map((x, i) => `<li><span class="ios-ico" aria-hidden="true">${i + 1}</span><span>${x}</span></li>`).join('')}</ol>
    <div class="row"><button class="btn primary" data-help-act>${h.action}</button></div>`;
  els.help.hidden = false; requestAnimationFrame(() => els.help.classList.add('open'));
  els.help.querySelector('[data-help-act]').onclick = () => { closeHelp(); h.fn(); };
  els.help.querySelector('[data-help-close]').onclick = closeHelp;
  els.help.querySelector('[data-help-close]').focus();
}
function closeHelp() { els.help.classList.remove('open'); setTimeout(() => { els.help.hidden = true; }, 250); }

// ------------------------------------------------------------------ nearby drawer (pull-up sheet)
const NEAR_M = 3000;
const R_E = 6371008.8, rd = (x) => x * Math.PI / 180;
function brg(a, b) {
  const y = Math.sin(rd(b.lng - a.lng)) * Math.cos(rd(b.lat));
  const x = Math.cos(rd(a.lat)) * Math.sin(rd(b.lat)) - Math.sin(rd(a.lat)) * Math.cos(rd(b.lat)) * Math.cos(rd(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function hav(a, b) { const dLat = rd(b.lat - a.lat), dLng = rd(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rd(a.lat)) * Math.cos(rd(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R_E * Math.asin(Math.min(1, Math.sqrt(h))); }
function nearbyList() {
  const from = me || (view?.ready ? view.map.getCenter() : null);
  if (!from || !feed) return { from: null, rows: [] };
  const rows = feed.list().filter((e) => !e.expired && Number.isFinite(e.lat))
    .map((e) => ({ e, d: Math.max(0, hav(from, e) - blurR(e) * 0.5), b: brg(from, e) }))
    .filter((r) => r.d <= NEAR_M).sort((a, b) => a.d - b.d).slice(0, 60);
  return { from, rows };
}
const drawerCtl = draggableSheet(els.drawer, els.drawerHandle, {
  getSnaps: () => {
    const H = els.drawer.offsetHeight || 600; const dock = document.querySelector('.dock').getBoundingClientRect();
    const peek = Math.min(H, Math.max(0, innerHeight - dock.top) + 72);       // handle sits just above the dock
    return [H - peek, Math.round(H * 0.45), 0];
  },
  onSnap: (ix) => {
    els.drawerHandle.setAttribute('aria-expanded', String(ix > 0)); body.classList.toggle('drawer-open', ix > 0);
    els.drawer.dataset.snap = String(ix);
    if (ix > 0) { opened.markSeen(nearbyList().rows.map((r) => r.e.id)); updateDrawer(); }
  },
});
els.drawerHandle.addEventListener('sheettap', () => { haptic('tick'); drawerCtl.snapTo(drawerCtl.index === 0 ? 2 : 0); });
els.drawerHandle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drawerCtl.snapTo(drawerCtl.index === 0 ? 2 : 0); } });
addEventListener('resize', () => drawerCtl.refresh());
let drawerT = 0, lastNewToast = 0;
function updateDrawer() {
  clearTimeout(drawerT);
  drawerT = setTimeout(renderDrawer, 120);
}
function renderDrawer() {
  const { from, rows } = nearbyList();
  const others = rows.filter((r) => !r.e.mine && !r.e.queued);
  const fresh = opened.unseen(others.map((r) => r.e.id));
  const st = opened.stats();
  els.drawerTitle.textContent = rows.length ? `${plural(rows.length, 'echo')} nearby` : 'No echoes nearby';
  els.drawerNew.hidden = !fresh.length; els.drawerNew.textContent = `${fresh.length} new`;
  els.drawerStats.textContent = st.found ? `\u{1F352} ${st.found} found${st.streak > 1 ? ` \u00b7 ${st.streak}-day streak` : ''}` : '';
  els.drawer.dataset.new = fresh.length ? '1' : '';
  if (fresh.length && drawerCtl.index === 0 && Date.now() - lastNewToast > 120000 && !body.classList.contains('has-overlay') && !onboardingOpen && !cardId && els.about.hidden && els.help.hidden) {
    lastNewToast = Date.now();
    toast(`${plural(fresh.length, 'new echo')} near you`, 5000, null, { label: 'Show', fn: () => drawerCtl.snapTo(2) });
  }
  if (!rows.length) {
    els.drawerList.innerHTML = `<div class="empty"><div class="empty-art" aria-hidden="true"><span></span><span></span><i></i></div>
      <strong>${from ? 'No echoes nearby yet' : 'Finding you\u2026'}</strong>
      <p>${from ? 'Be the first. Leave something for the next person who walks by.' : 'Turn on location to see what\u2019s around you.'}</p>
      ${from ? '<button class="btn primary" data-empty-drop>Drop the first echo</button>' : '<button class="btn primary" data-empty-geo>Turn on location</button>'}</div>`;
    return;
  }
  const head = currentHeading();
  const items = rows.map(({ e, d, b }) => {
    const unopened = !e.mine && !e.queued && !opened.isOpened(e.id);
    const isNew = fresh.includes(e.id);
    const rel = Number.isFinite(head) ? b - head : b;
    const plays = Number.isFinite(e.listen_count) ? ` \u00b7 \u25B6 ${e.listen_count}` : '';
    const len = fmtLen(e);
    return `<button class="near-row${unopened ? ' is-unopened' : ''}" role="listitem" data-near="${esc(e.id)}"
        aria-label="${unopened ? 'Unopened echo' : e.mine ? 'Your echo' : 'Opened echo'}, ${blurR(e) ? 'about ' : ''}${fmtDist(d)} away, ${len !== '\u2014' ? `${len} long, ` : ''}dropped ${esc(ago(e.created_at))}, fades in ${esc(left(e.expires_at))}">
      <span class="nr-ico" aria-hidden="true">${unopened ? '\u{1F352}' : '<i></i>'}</span>
      <span class="nr-main"><strong>${blurR(e) ? '~' : ''}${fmtDist(d)} <svg class="nr-arrow" viewBox="0 0 24 24" style="transform:rotate(${rel.toFixed(0)}deg)" aria-hidden="true"><path d="M12 3l6 16-6-4-6 4z"/></svg></strong>
        <small>${len !== '\u2014' ? `${len} \u00b7 ` : ''}${esc(ago(e.created_at))} \u00b7 fades in ${esc(left(e.expires_at))}${plays}</small></span>
      <span class="nr-state">${e.mine ? 'Yours' : e.queued ? 'Queued' : unopened ? (isNew ? 'New' : 'Unopened') : 'Opened'}</span>
    </button>`;
  });
  // Patch rows in place when the order is unchanged (GPS updates every second): taps in progress survive and
  // the entry animation doesn't replay. Rebuild only when the set or order changes.
  const want = rows.map((r) => r.e.id);
  const have = [...els.drawerList.querySelectorAll('[data-near]')];
  if (have.length === want.length && have.every((n, i) => n.dataset.near === want[i])) {
    const t = document.createElement('template');
    items.forEach((html, i) => {
      t.innerHTML = html.trim(); const fresh = t.content.firstElementChild, cur = have[i];
      if (cur.className !== fresh.className) cur.className = fresh.className;
      if (cur.getAttribute('aria-label') !== fresh.getAttribute('aria-label')) cur.setAttribute('aria-label', fresh.getAttribute('aria-label'));
      if (cur.innerHTML !== fresh.innerHTML) cur.innerHTML = fresh.innerHTML;
    });
  } else els.drawerList.innerHTML = items.join('');
}
els.drawerList.addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  if (b.matches('[data-empty-drop]')) { openRecord({ autoStart: true }); return; }
  if (b.matches('[data-empty-geo]')) { startGeo(); startCompass(); return; }
  const id = b.dataset.near; const e = id && feed.get(id); if (!e) return;
  haptic('tap'); drawerCtl.snapTo(0); setFollow(false);
  view?.flyTo(e, Math.max(16.5, view.map.getZoom()));
  setTimeout(() => openCard(id), fxReduced() ? 0 : 700);
});
opened.events.addEventListener('opened', () => { view?.refreshPins(); updateDrawer(); });

// ------------------------------------------------------------------ first run: 3 swipeable cards, permissions in context
let onboardingOpen = false;
function maybeOnboard() {
  let done = false; try { done = localStorage.getItem('echolocation.onboarded') === '1'; } catch { /* ignore */ }
  if (done || params.has('noonboard')) return;
  onboardingOpen = true; els.onboard.hidden = false; requestAnimationFrame(() => els.onboard.classList.add('open'));
  const track = els.onboard.querySelector('[data-ob-track]'); const dots = [...els.onboard.querySelectorAll('[data-ob-dots] i')];
  const go = (i) => { track.scrollTo({ left: i * track.clientWidth, behavior: fxReduced() ? 'auto' : 'smooth' }); };
  const ix = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  track.addEventListener('scroll', () => { const i = ix(); dots.forEach((d, k) => d.classList.toggle('on', k === i)); }, { passive: true });
  els.onboard.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return; haptic('tick');
    if (b.matches('[data-ob-next]')) go(ix() + 1);
    else if (b.matches('[data-ob-done]')) finish();
    else if (b.matches('[data-ob-geo]')) {
      const st = els.onboard.querySelector('[data-ob-geo-status]'); st.textContent = 'Asking\u2026'; b.disabled = true;
      navigator.geolocation?.getCurrentPosition(() => { st.textContent = '\u2713 Location on'; b.textContent = 'Next'; b.disabled = false; b.removeAttribute('data-ob-geo'); b.setAttribute('data-ob-next', ''); startGeo(); startCompass(); setTimeout(() => go(2), 500); },
        (err) => { b.disabled = false; st.textContent = err.code === 1 ? 'Location is blocked. You can still browse; turn it on later from the GPS pill.' : 'No fix yet. That\u2019s fine, it keeps trying.'; if (err.code !== 1) startGeo(); b.textContent = 'Next'; b.removeAttribute('data-ob-geo'); b.setAttribute('data-ob-next', ''); },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    } else if (b.matches('[data-ob-mic]')) {
      const st = els.onboard.querySelector('[data-ob-mic-status]'); st.textContent = 'Asking\u2026'; b.disabled = true;
      navigator.mediaDevices?.getUserMedia({ audio: true }).then((ms) => { ms.getTracks().forEach((t) => t.stop()); st.textContent = '\u2713 Microphone ready'; finishSoon(b); },
        () => { st.textContent = 'Microphone blocked. You can allow it later when you drop your first echo.'; finishSoon(b); });
    }
  });
  const finishSoon = (b) => { b.disabled = false; b.textContent = 'Start exploring'; b.removeAttribute('data-ob-mic'); b.setAttribute('data-ob-done', ''); };
  function finish() {
    try { localStorage.setItem('echolocation.onboarded', '1'); } catch { /* ignore */ }
    els.onboard.classList.remove('open'); onboardingOpen = false;
    setTimeout(() => { els.onboard.hidden = true; els.fab.focus(); }, fxReduced() ? 0 : 350);
    updateDrawer();
  }
  els.onboard.querySelector('[data-ob-next]').focus();
}
maybeOnboard();

// ------------------------------------------------------------------ install as an app
let installMode = 'none';
onInstallChange(({ mode }) => {
  installMode = mode;
  els.install.hidden = !(mode === 'prompt' || mode === 'ios' || mode === 'ios-other');
  if (mode === 'installed') els.iosHint.hidden = true;
});
els.install.addEventListener('click', async () => {
  if (installMode === 'prompt') { const r = await promptInstall(); if (r === 'accepted') toast('Installed. Open Echolocation from your home screen.'); }
  else if (installMode === 'ios' || installMode === 'ios-other') {
    els.iosHint.querySelector('[data-ios-other]').hidden = installMode !== 'ios-other';
    els.iosHint.hidden = false; requestAnimationFrame(() => els.iosHint.classList.add('open'));
    els.iosHint.querySelector('[data-ios-hint-close]').focus();
  }
});
els.iosHint.addEventListener('click', (ev) => { if (ev.target.closest('[data-ios-hint-close]')) { els.iosHint.classList.remove('open'); els.iosHint.hidden = true; els.install.focus(); } });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
