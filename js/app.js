// App shell (v2): the shared live map is the home screen.
//   map (js/map.js) <- feed (js/map-feed.js: viewport polling + Supabase Realtime) <- store (js/echo-store.js)
//   record button -> record sheet (js/record.js) · tap a glow -> card -> "Walk to it" -> hunt (js/listen.js)
import * as store from './echo-store.js';
import { createMapView } from './map.js';
import { createMapFeed } from './map-feed.js';
import { mountRecordScreen } from './record.js';
import { openHunt, fmtDist } from './listen.js';
import { APP_VERSION, APP_BUILD, SW_CACHE } from './config.js';

const $ = (s) => document.querySelector(s);
const body = document.body;
const els = {
  map: $('#map'), card: $('[data-card]'), record: $('#screen-record'), listen: $('#screen-listen'),
  live: $('[data-live]'), liveText: $('[data-live-text]'), toast: $('[data-toast]'),
  fab: $('[data-record]'), listenBtn: $('[data-listen]'), locate: $('[data-locate]'),
  gps: $('[data-gps-pill]'), gpsText: $('[data-gps-text]'), outbox: $('[data-outbox]'), outboxText: $('[data-outbox-text]'),
  recenter: $('[data-recenter]'), about: $('[data-about]'), aboutOpen: $('[data-about-open]'), skeleton: $('[data-skeleton]'),
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
function toast(msg, ms = 2800, key = null) {
  if (key) { const t = toastSeen.get(key); if (t && Date.now() - t < 30000) return; toastSeen.set(key, Date.now()); }
  els.toast.textContent = msg; els.toast.hidden = false;
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
  }, (err) => {
    if (err.code === 1) {
      geoWatch = null; setGps('off', 'GPS off', 'Location is off. Tap to turn it on.');
      toast('Location is off. The map still works, but you can\u2019t be placed on it.', 3600, 'geo-denied');
    } else if (!geoErrShown) {
      geoErrShown = true;
      if (!me) setGps('poor', 'No GPS fix', 'No GPS fix yet');
      toast(err.code === 3 ? 'Still looking for a GPS fix\u2026 step outside or near a window.' : 'GPS is unavailable right now.', 3600, 'geo-err');
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
  cardId = null; els.card.classList.remove('open');
  setTimeout(() => { if (!cardId) els.card.hidden = true; }, reducedMotion ? 0 : 280);
}
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
  els.card.dataset.id = id;
  els.card.innerHTML = `
    <div class="grab" aria-hidden="true"></div>
    <header class="card-head">
      <div class="card-glyph" data-heat="${heatWord(res).toLowerCase()}" aria-hidden="true"><span></span><span></span></div>
      <div class="card-title">
        <span class="eyebrow">${e.mine ? 'Your echo' : 'Echo'} · ${queued ? '<span class="tag-queued">Queued, will upload</span>' : heatWord(res)}${blurred ? ' · Blurred' : ''}</span>
        <strong>${where}</strong>
      </div>
      <button class="icon-btn" data-card-close aria-label="Close echo details"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </header>
    <dl class="stats">
      <div><dt>Dropped</dt><dd data-stat="age">${esc(ago(e.created_at))}</dd></div>
      <div><dt>Fades</dt><dd data-stat="left">${esc(left(e.expires_at))}</dd></div>
      <div><dt>Resonance</dt><dd data-stat="res">${res}</dd></div>
      <div><dt>Distance</dt><dd data-stat="dist">${d == null ? '—' : (blurred ? '~' : '') + fmtDist(d)}</dd></div>
    </dl>
    <div class="life" role="img" aria-label="Time left: ${esc(left(e.expires_at))}"><i style="transform:scaleX(${lifeFrac.toFixed(3)})"></i></div>
    <p class="card-note">${note}</p>
    <div class="row">
      ${e.mine ? `<button class="btn" data-retract>${queued ? 'Cancel upload' : 'Take it back'}</button>` : ''}
      ${queued ? '' : `<button class="btn primary" data-walk aria-label="Walk to this echo and listen">`}
        ${queued ? '' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l6 16-6-4-6 4z"/></svg>Walk to it</button>'}
    </div>`;
}
function openCard(id) {
  cardId = id; renderCard(id);
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

function openRecord({ autoStart = true } = {}) {
  closeCard();
  recordApi?.destroy?.();
  showOverlay(els.record);
  startGeo();
  recordApi = mountRecordScreen(els.record, {
    autoStart,
    onClose: closeRecord,
    onToast: (m) => toast(m, 3600),
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
    onError: (e) => toast(`Couldn\u2019t start listening: ${e.friendly || e.message || e}`, 3600) });
}

els.fab.addEventListener('click', () => openRecord({ autoStart: true }));
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
els.about.addEventListener('click', (ev) => { if (ev.target.closest('[data-about-close]')) closeAbout(); });
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
window.addEventListener('error', (ev) => { if (ev.message) toast('Something went wrong. Try again.', 3600, 'error'); });

// ------------------------------------------------------------------ boot
async function waitForMapLibre(ms = 10000) {
  const t0 = Date.now();
  while (!window.maplibregl && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return Boolean(window.maplibregl);
}

async function boot() {
  feed = createMapFeed({
    onChange: (list) => {
      view?.setEchoes(list);
      const b = view?.ready ? view.bounds() : null;
      viewportCount = b ? list.filter((e) => e.lat >= b.minLat && e.lat <= b.maxLat && e.lng >= b.minLng && e.lng <= b.maxLng).length : list.length;
      body.dataset.echoCount = String(list.length);
      updateLive();
      if (cardId) { if (feed.get(cardId)) renderCard(cardId); else closeCard(); }
    },
    onStatus: updateLive,
    onError: (e) => toast(`Couldn\u2019t refresh echoes: ${e?.friendly || e?.message || e}`, 3200, 'poll'),
  });
  window.addEventListener('echo-map:realtime', (ev) => {
    if (ev.detail.event === 'drop' && !store.isMine(ev.detail.id)) toast('A new echo just surfaced on the map');
  });

  const last = store.lastKnownPosition();
  const qLat = parseFloat(params.get('lat')), qLng = parseFloat(params.get('lng'));
  const center = Number.isFinite(qLat) && Number.isFinite(qLng) ? { lat: qLat, lng: qLng } : last ? { lat: last.lat, lng: last.lng } : null;
  if (!(await waitForMapLibre())) {
    els.liveText.textContent = 'Map failed to load'; els.skeleton?.classList.add('done');
    toast('The map couldn\u2019t load. Check your connection and reload.', 6000);
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
  window.__echoApp = { store, feed, view, openCard, startHunt, openRecord, openAbout, setFollow,
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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
