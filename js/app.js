// App shell (v2): the shared live map is the home screen.
//   map (js/map.js) <- feed (js/map-feed.js: viewport polling + Supabase Realtime) <- store (js/echo-store.js)
//   record button -> record sheet (js/record.js) · tap a glow -> card -> "Walk to it" -> hunt (js/listen.js)
import * as store from './echo-store.js';
import { createMapView } from './map.js';
import { createMapFeed } from './map-feed.js';
import { mountRecordScreen } from './record.js';
import { openHunt, fmtDist } from './listen.js';

const $ = (s) => document.querySelector(s);
const body = document.body;
const els = {
  map: $('#map'), card: $('[data-card]'), record: $('#screen-record'), listen: $('#screen-listen'),
  live: $('[data-live]'), liveText: $('[data-live-text]'), toast: $('[data-toast]'),
  fab: $('[data-record]'), listenBtn: $('[data-listen]'), locate: $('[data-locate]'),
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const params = new URLSearchParams(location.search);

let view = null, feed = null, me = null, geoWatch = null, followMe = true, cardId = null, recordApi = null, huntApi = null;
let viewportCount = 0, lastRawFix = null;

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
function toast(msg, ms = 2800) {
  els.toast.textContent = msg; els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('show'));
  clearTimeout(toastT);
  toastT = setTimeout(() => { els.toast.classList.remove('show'); setTimeout(() => { els.toast.hidden = true; }, 300); }, ms);
}

// ------------------------------------------------------------------ position
function distTo(e) {
  if (!me || !e) return null;
  return Math.max(0, store.haversineM(me.lat, me.lng, e.lat, e.lng) - (e.radius_m || 45) * 0.5);
}
function startGeo() {
  if (geoWatch != null || !('geolocation' in navigator)) return;
  geoWatch = navigator.geolocation.watchPosition((p) => {
    const first = !me;
    me = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
    lastRawFix = { coords: { latitude: me.lat, longitude: me.lng, accuracy: me.accuracy, altitude: p.coords.altitude }, timestamp: p.timestamp };
    recordApi?.setFix?.(lastRawFix);
    view?.setMe(me);
    if (first && followMe && view?.ready) view.jumpTo(me, Math.max(15.5, view.map.getZoom()));
    if (cardId) renderCard(cardId);
  }, (err) => {
    if (err.code === 1) { geoWatch = null; toast('Location is off. The map still works, but you can\u2019t be placed on it.'); }
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
  els.liveText.textContent = state === 'offline' ? 'Offline · this device only'
    : state === 'connecting' ? 'Connecting' : `${rt ? 'Live' : 'Updating'} · ${n ? plural(n, 'echo') : 'no echoes here yet'}`;
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
  const lifeFrac = Math.max(0, Math.min(1, (Date.parse(e.expires_at) - Date.now()) / (24 * 3600e3)));
  els.card.dataset.id = id;
  els.card.innerHTML = `
    <div class="grab" aria-hidden="true"></div>
    <header class="card-head">
      <div class="card-glyph" data-heat="${heatWord(res).toLowerCase()}" aria-hidden="true"><span></span><span></span></div>
      <div class="card-title">
        <span class="eyebrow">${e.mine ? 'Your echo' : 'Echo'} · ${heatWord(res)}</span>
        <strong>${d == null ? 'Somewhere in this glow' : d < 30 ? 'You\u2019re inside the glow' : `~${fmtDist(d)} away`}</strong>
      </div>
      <button class="icon-btn" data-card-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </header>
    <dl class="stats">
      <div><dt>Dropped</dt><dd data-stat="age">${esc(ago(e.created_at))}</dd></div>
      <div><dt>Fades</dt><dd data-stat="left">${esc(left(e.expires_at))}</dd></div>
      <div><dt>Resonance</dt><dd data-stat="res">${res}</dd></div>
      <div><dt>Distance</dt><dd data-stat="dist">${d == null ? '—' : '~' + fmtDist(d)}</dd></div>
    </dl>
    <div class="life" aria-label="Time left"><i style="transform:scaleX(${lifeFrac.toFixed(3)})"></i></div>
    <p class="card-note">The exact spot is hidden somewhere inside the ${Math.round(e.radius_m || 45)} m glow. Walk there and listen for it.</p>
    <div class="row">
      ${e.mine ? '<button class="btn" data-retract>Take it back</button>' : ''}
      <button class="btn primary" data-walk>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l6 16-6-4-6 4z"/></svg>Walk to it</button>
    </div>`;
}
function openCard(id) {
  cardId = id; renderCard(id);
  const e = feed.get(id);
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
    try { await store.retractEcho(cardId); closeCard(); toast('Echo taken back'); } catch (e) { t.disabled = false; t.textContent = 'Take it back'; toast(`Couldn't take it back: ${e.message}`); }
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
  huntApi = openHunt(els.listen, { target, onClose: () => { huntApi = null; hideOverlay(els.listen); } });
}

els.fab.addEventListener('click', () => openRecord({ autoStart: true }));
els.listenBtn.addEventListener('click', () => startHunt(null));
els.locate.addEventListener('click', () => {
  startGeo(); followMe = true;
  if (me) view?.flyTo(me, Math.max(16, view.map.getZoom())); else toast('Finding you\u2026');
});

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
  });
  window.addEventListener('echo-map:realtime', (ev) => {
    if (ev.detail.event === 'drop' && !store.isMine(ev.detail.id)) toast('A new echo just surfaced on the map');
  });

  const last = store.lastKnownPosition();
  const qLat = parseFloat(params.get('lat')), qLng = parseFloat(params.get('lng'));
  const center = Number.isFinite(qLat) && Number.isFinite(qLng) ? { lat: qLat, lng: qLng } : last ? { lat: last.lat, lng: last.lng } : null;
  if (!(await waitForMapLibre())) { els.liveText.textContent = 'Map failed to load'; return; }
  view = createMapView(els.map, {
    center, zoom: parseFloat(params.get('z')) || (center ? 15.5 : 12),
    onSelect: (id) => (id ? openCard(id) : closeCard()),
    onMove: (b) => { feed.setBounds(b); },
    onReady: () => { if (me) view.setMe(me); view.setEchoes(feed.list()); },
  });
  view.map.on('dragstart', () => { followMe = false; });
  window.__echoApp = { store, feed, view, openCard, startHunt, openRecord, get me() { return me; } };

  // legacy deep links from v1
  if (location.hash === '#record') { history.replaceState(null, '', location.pathname + location.search); openRecord({ autoStart: false }); }
}
boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
