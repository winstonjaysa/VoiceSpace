// Hidden debug map (/debug.html). Shows every echo from echo-store + the user's position.
import { MAPBOX_TOKEN } from './config.js';
import * as store from './echo-store.js';
const { listAllEchoes, getAudioUrl, isExpired, lastKnownPosition } = store;

const statusEl = document.getElementById('status');
const rowsEl = document.getElementById('rows');
const showExpiredEl = document.getElementById('showExpired');
const fmt = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

let map = null, mapReady = false, userMarker = null, echoes = [];

try {
  if (!window.mapboxgl) throw new Error('mapbox-gl failed to load');
  if (!MAPBOX_TOKEN) throw new Error('No Mapbox token on this device: open debug.html?mapbox=<your pk. token> once');
  mapboxgl.accessToken = MAPBOX_TOKEN;
  map = new mapboxgl.Map({ container: 'map', style: 'mapbox://styles/mapbox/dark-v11', center: [-79.3832, 43.6532], zoom: 14 });
  map.addControl(new mapboxgl.NavigationControl(), 'top-right');
  map.on('load', () => {
    map.addSource('echoes', { type: 'geojson', data: toGeoJSON([]) });
    map.addLayer({ id: 'echo-acc', type: 'circle', source: 'echoes', paint: {
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, ['/', ['get', 'acc'], 150], 20, ['*', ['get', 'acc'], 7]],
      'circle-color': ['case', ['get', 'expired'], '#555', '#7cf2d4'], 'circle-opacity': 0.12 } });
    map.addLayer({ id: 'echo-dot', type: 'circle', source: 'echoes', paint: {
      'circle-radius': 7, 'circle-color': ['case', ['get', 'expired'], '#666', '#7cf2d4'],
      'circle-stroke-width': 2, 'circle-stroke-color': '#07080b' } });
    map.on('click', 'echo-dot', (e) => openPopup(e.features[0].properties.id));
    map.on('mouseenter', 'echo-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'echo-dot', () => { map.getCanvas().style.cursor = ''; });
    mapReady = true;
    render(true);
  });
  map.on('error', (e) => { statusEl.textContent = `map error: ${e?.error?.message || e}`; });
} catch (err) {
  statusEl.textContent = `map unavailable (${err.message}); table only`;
}

function toGeoJSON(list) {
  const now = Date.now();
  return { type: 'FeatureCollection', features: list.map((e) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [e.lng, e.lat] },
    properties: { id: e.id, acc: e.accuracy_m ?? 10, expired: isExpired(e, now) } })) };
}

async function openPopup(id) {
  const e = echoes.find((x) => x.id === id); if (!e || !map) return;
  const url = await getAudioUrl(e, { lat: e.lat, lng: e.lng }).catch(() => null);
  new mapboxgl.Popup({ maxWidth: '280px' }).setLngLat([e.lng, e.lat]).setHTML(`
    <b>${e.id.slice(0, 8)}</b>${isExpired(e) ? ' <i>(expired)</i>' : ''}<br>
    created: ${fmt(e.created_at)}<br>expires: ${fmt(e.expires_at)}<br>
    accuracy: ±${e.accuracy_m != null ? Math.round(e.accuracy_m) : '?'} m · heading: ${e.heading != null ? Math.round(e.heading) + '°' : 'n/a'}<br>
    resonance: ${e.resonance_count} · ${((e.duration_ms || 0) / 1000).toFixed(1)} s · ${e.mime_type || ''} · ${e.source || ''}
    ${url ? `<audio controls src="${url}" style="width:100%;margin-top:6px"></audio>` : ''}`).addTo(map);
}

async function render(fit = false) {
  const c = window.__debugUserPos || lastKnownPosition() || (map && { lat: map.getCenter().lat, lng: map.getCenter().lng });
  try { echoes = await listAllEchoes(c || {}); } catch (err) { statusEl.textContent = `store error: ${err.message}`; return; }
  const now = Date.now();
  const list = showExpiredEl.checked ? echoes : echoes.filter((e) => !isExpired(e, now));
  statusEl.textContent = `${list.length} shown / ${echoes.length} total · backend: ${store.backendName}${store.backendError ? ` (${store.backendError})` : ''}`;
  document.body.dataset.echoCount = String(echoes.length);
  rowsEl.innerHTML = list.map((e) => `<tr class="${isExpired(e, now) ? 'expired' : ''}" data-id="${e.id}">
    <td>${e.id.slice(0, 8)}</td><td>${e.lat.toFixed(6)}, ${e.lng.toFixed(6)}</td>
    <td>${e.accuracy_m != null ? Math.round(e.accuracy_m) : ''}</td><td>${e.heading != null ? Math.round(e.heading) : ''}</td>
    <td>${fmt(e.created_at)}</td><td>${fmt(e.expires_at)}</td><td>${e.resonance_count}</td>
    <td>${((e.duration_ms || 0) / 1000).toFixed(1)}s</td><td>${e.source || ''}</td><td><button data-play="${e.id}">▶</button></td></tr>`).join('');
  if (mapReady) {
    map.getSource('echoes').setData(toGeoJSON(list));
    if (fit && list.length) {
      const b = new mapboxgl.LngLatBounds();
      list.forEach((e) => b.extend([e.lng, e.lat]));
      map.fitBounds(b, { padding: 60, maxZoom: 18, duration: 0 });
    }
  }
}

rowsEl.addEventListener('click', async (ev) => {
  const id = ev.target?.dataset?.play; if (!id) return;
  const e = echoes.find((x) => x.id === id);
  const url = await getAudioUrl(e, { lat: e.lat, lng: e.lng }); if (url) new Audio(url).play();
  if (map) { map.flyTo({ center: [e.lng, e.lat], zoom: 18 }); openPopup(id); }
});

function locate() {
  navigator.geolocation?.watchPosition((p) => {
    const ll = [p.coords.longitude, p.coords.latitude];
    window.__debugUserPos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
    if (!map || !window.mapboxgl) return;
    if (!userMarker) {
      const dot = document.createElement('div');
      dot.style.cssText = 'width:16px;height:16px;border-radius:50%;background:#4fb7ff;border:3px solid #fff;box-shadow:0 0 0 6px rgba(79,183,255,.3)';
      userMarker = new mapboxgl.Marker({ element: dot }).setLngLat(ll).setPopup(new mapboxgl.Popup().setText('You')).addTo(map);
      if (!echoes.length) map.jumpTo({ center: ll, zoom: 17 });
    } else userMarker.setLngLat(ll);
    userMarker.getPopup().setText(`You · ±${Math.round(p.coords.accuracy)} m`);
  }, (e) => { statusEl.textContent = `location: ${e.message}`; }, { enableHighAccuracy: true });
}
document.getElementById('locate').addEventListener('click', locate);
document.getElementById('reload').addEventListener('click', () => render(true));
showExpiredEl.addEventListener('change', () => render());
// If location was already granted, show the user's position immediately (no prompt is triggered).
navigator.permissions?.query({ name: 'geolocation' }).then((r) => { if (r.state === 'granted') locate(); }).catch(() => {});
render(true);
