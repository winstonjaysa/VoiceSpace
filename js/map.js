// map.js: the shared live map (MapLibre GL JS, free no-key vector tiles). Every Echo is an EXACT pin (small glowing
// dot + sonar ripple) at the spot it was dropped; echoes dropped with "Blur my spot" are a soft 30–60 m glow instead.
// Clusters when zoomed out. You: dot, accuracy ring, and a heading cone (compass / GPS course).
// MapLibre is loaded as a global (<script> from unpkg in index.html / debug.html).

export const STYLES = [
  { url: 'https://tiles.openfreemap.org/styles/dark', font: ['Noto Sans Regular'], name: 'OpenFreeMap dark' },
  { url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json', font: ['Open Sans Regular'], name: 'CARTO dark matter' },
];
const M_PER_PX_Z0 = 78271.517;                  // metres per pixel at zoom 0 at the equator (512 px tiles)
const DAY = 24 * 3600e3;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// circle radius that tracks a real-world size in metres: rpx0 = metres / (M_PER_PX_Z0 * cos(lat))
const metres = (mult) => ['interpolate', ['exponential', 2], ['zoom'],
  0, ['*', ['get', 'rpx0'], mult], 24, ['*', ['get', 'rpx0'], mult * 2 ** 24]];
const HEAT_COLOR = ['interpolate', ['linear'], ['get', 'heat'],
  0, '#8fd3e8', 0.45, '#a9a2f0', 1, '#f2d3b0'];   // ice -> lavender -> warm ivory (no primaries)

/** Darken/cool the base style a touch so the glows carry the scene. Silently skips missing layers. */
function tintBaseStyle(map) {
  const set = (id, prop, v) => { try { if (map.getLayer(id)) map.setPaintProperty(id, prop, v); } catch { /* style differs */ } };
  set('background', 'background-color', '#050608');
  set('water', 'fill-color', '#0a0f15');
  set('waterway', 'line-color', '#0a0f15');
  set('building', 'fill-color', '#0b0c10');
  set('building', 'fill-outline-color', '#14161d');
  set('landuse_park', 'fill-color', '#0b0f0e');
  set('landcover_wood', 'fill-color', '#0b0f0e');
  set('highway_minor', 'line-color', '#15171d');
  set('highway_major_inner', 'line-color', '#191c24');
  set('highway_major_casing', 'line-color', 'rgba(70,78,96,0.55)');
  set('highway_motorway_casing', 'line-color', 'rgba(80,88,108,0.6)');
  set('highway_path', 'line-color', '#14161c');
  set('highway_path', 'line-opacity', 0.55);
  for (const id of ['place_other', 'place_suburb', 'place_village', 'place_town', 'place_city', 'place_city_large', 'highway_name_other']) {
    set(id, 'text-color', 'rgba(150,158,176,0.75)');
  }
}

import { isOpened } from './opened.js';

export function createMapView(container, { center, zoom = 15.3, onSelect = () => {}, onMove = () => {}, onReady = () => {}, onError = () => {},
  onUserPan = () => {} } = {}) {
  const ml = window.maplibregl;
  if (!ml) throw new Error('MapLibre failed to load');
  let styleIx = 0, ready = false, echoes = [], me = null, raf = 0, styleTimer = null;
  const map = new ml.Map({
    container, style: STYLES[0].url, center: center ? [center.lng, center.lat] : [-79.3832, 43.6532], zoom,
    attributionControl: false, pitchWithRotate: false, dragRotate: false, maxPitch: 0, fadeDuration: 150,
  });
  map.touchZoomRotate.disableRotation();
  // Base styles reference sprite images (e.g. 'wood-pattern') that aren't always in the sprite: give MapLibre a
  // transparent stand-in instead of a console warning.
  map.on('styleimagemissing', (e) => {
    if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });
  map.on('dragstart', (e) => { if (e.originalEvent) onUserPan(); });
  map.getCanvas().setAttribute('aria-label', 'Map of echoes near you');
  map.addControl(new ml.AttributionControl({ compact: true }), 'bottom-left');

  // fall back to the second no-key style if the first can't load within 8 s
  const fallback = () => {
    if (ready || styleIx >= STYLES.length - 1) return;
    styleIx++; console.warn('[map] style failed, trying', STYLES[styleIx].name); map.setStyle(STYLES[styleIx].url);
  };
  styleTimer = setTimeout(fallback, 8000);
  map.on('error', (e) => {
    const msg = String(e?.error?.message || '');
    if (!ready && /style|Failed to fetch|NetworkError/i.test(msg)) fallback();
    console.info('[map]', msg || e);
    onError(e);
  });

  const empty = () => ({ type: 'FeatureCollection', features: [] });
  function toFeatures(list) {
    const now = Date.now();
    return { type: 'FeatureCollection', features: list.map((e) => {
      const left = Math.max(0, Date.parse(e.expires_at) - now);
      const heat = 1 - Math.exp(-(e.resonance_count || 0) / 3);
      return { type: 'Feature', id: hashId(e.id), geometry: { type: 'Point', coordinates: [e.lng, e.lat] }, properties: {
        id: e.id, rpx0: (e.radius_m || 45) / (M_PER_PX_Z0 * Math.cos(e.lat * Math.PI / 180)),
        heat, life: Math.max(0.12, Math.min(1, left / DAY)), fresh: e.freshUntil > now ? 1 : 0, mine: e.mine ? 1 : 0,
        blurred: e.blurred || e.radius_m > 0 ? 1 : 0, pending: e.queued ? 1 : 0,
        cherry: !e.mine && !e.queued && !isOpened(e.id) ? 1 : 0,          // unopened on this device
      } };
    }) };
  }
  function meFeatures() {
    if (!me) return empty();
    return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [me.lng, me.lat] },
      properties: { rpx0: Math.max(3, me.accuracy || 10) / (M_PER_PX_Z0 * Math.cos(me.lat * Math.PI / 180)),
        ...(Number.isFinite(me.heading) ? { heading: me.heading } : {}) } }] };
  }

  function addLayers() {
    const font = STYLES[styleIx].font;
    map.addSource('echoes', { type: 'geojson', data: toFeatures(echoes), cluster: true, clusterMaxZoom: 13, clusterRadius: 46,
      clusterProperties: { heat: ['max', ['get', 'heat']], fresh: ['max', ['get', 'fresh']] } });
    map.addSource('me', { type: 'geojson', data: meFeatures() });
    const single = ['!', ['has', 'point_count']];
    const unclustered = ['all', single, ['==', ['get', 'blurred'], 1]];      // blurred: glow layers
    const exact = ['all', single, ['==', ['get', 'blurred'], 0], ['==', ['get', 'cherry'], 0]];   // opened exact pins
    const cherry = ['all', single, ['==', ['get', 'cherry'], 1]];                                 // unopened: cherries
    if (!map.hasImage('me-cone')) map.addImage('me-cone', coneImage(), { pixelRatio: 2 });
    if (!map.hasImage('cherry')) map.addImage('cherry', cherryImage(), { pixelRatio: 2 });
    // clusters: a soft halo + thin ring + count
    map.addLayer({ id: 'cluster-halo', type: 'circle', source: 'echoes', filter: ['has', 'point_count'], paint: {
      'circle-color': HEAT_COLOR, 'circle-blur': 1,
      'circle-radius': ['interpolate', ['linear'], ['get', 'point_count'], 2, 30, 20, 46, 200, 64],
      'circle-opacity': 0.42 } });
    map.addLayer({ id: 'cluster-ring', type: 'circle', source: 'echoes', filter: ['has', 'point_count'], paint: {
      'circle-color': 'rgba(8,10,14,0.7)', 'circle-stroke-color': HEAT_COLOR, 'circle-stroke-width': 1,
      'circle-stroke-opacity': 0.8, 'circle-radius': ['interpolate', ['linear'], ['get', 'point_count'], 2, 15, 20, 20, 200, 26] } });
    map.addLayer({ id: 'cluster-count', type: 'symbol', source: 'echoes', filter: ['has', 'point_count'], layout: {
      'text-field': ['get', 'point_count_abbreviated'], 'text-font': font, 'text-size': 12, 'text-allow-overlap': true },
      paint: { 'text-color': '#e8ecf4' } });
    // single echoes: wide haze, field, inner bloom, ripple, freshly-arrived flash
    map.addLayer({ id: 'echo-haze', type: 'circle', source: 'echoes', filter: unclustered, paint: {
      'circle-radius': metres(1.7), 'circle-color': HEAT_COLOR, 'circle-blur': 1,
      'circle-opacity': ['*', ['get', 'life'], ['+', 0.16, ['*', 0.2, ['get', 'heat']]]] } });
    map.addLayer({ id: 'echo-field', type: 'circle', source: 'echoes', filter: unclustered, paint: {
      'circle-radius': metres(1), 'circle-color': HEAT_COLOR, 'circle-blur': 0.75,
      'circle-opacity': ['*', ['get', 'life'], ['+', 0.22, ['*', 0.3, ['get', 'heat']]]],
      'circle-stroke-width': 0.6, 'circle-stroke-color': HEAT_COLOR, 'circle-stroke-opacity': ['*', 0.25, ['get', 'life']] } });
    map.addLayer({ id: 'echo-bloom', type: 'circle', source: 'echoes', filter: unclustered, paint: {
      'circle-radius': metres(0.4), 'circle-color': '#d6f0ff', 'circle-blur': 1,
      'circle-opacity': ['*', ['get', 'life'], ['+', 0.12, ['*', 0.3, ['get', 'heat']]]] } });
    map.addLayer({ id: 'echo-ripple', type: 'circle', source: 'echoes', filter: unclustered, paint: {
      'circle-radius': metres(0.6), 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 1,
      'circle-stroke-color': HEAT_COLOR, 'circle-stroke-opacity': 0 } });
    map.addLayer({ id: 'echo-flash', type: 'circle', source: 'echoes', filter: ['all', unclustered, ['==', ['get', 'fresh'], 1]], paint: {
      'circle-radius': metres(2.4), 'circle-color': '#e9f6ff', 'circle-blur': 1, 'circle-opacity': 0.35 } });
    // exact pins: soft halo, sonar ripple, bright core (queued/pending ones are dim and warm)
    const pinR = (a, b) => ['interpolate', ['linear'], ['zoom'], 11, a, 18, b];
    map.addLayer({ id: 'pin-halo', type: 'circle', source: 'echoes', filter: exact, paint: {
      'circle-radius': pinR(9, 20), 'circle-color': HEAT_COLOR, 'circle-blur': 1,
      'circle-opacity': ['*', ['get', 'life'], ['case', ['==', ['get', 'pending'], 1], 0.25, ['+', 0.45, ['*', 0.3, ['get', 'heat']]]]] } });
    map.addLayer({ id: 'pin-ripple', type: 'circle', source: 'echoes', filter: ['all', exact, ['==', ['get', 'pending'], 0]], paint: {
      'circle-radius': pinR(8, 16), 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 1.2,
      'circle-stroke-color': HEAT_COLOR, 'circle-stroke-opacity': 0 } });
    map.addLayer({ id: 'pin-core', type: 'circle', source: 'echoes', filter: exact, paint: {
      'circle-radius': pinR(3.2, 5.5),
      'circle-color': ['case', ['==', ['get', 'pending'], 1], '#f2d3b0', '#f4fbff'],
      'circle-opacity': ['case', ['==', ['get', 'pending'], 1], 0.55, 1],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 18, 2],
      'circle-stroke-color': ['case', ['==', ['get', 'pending'], 1], '#f2d3b0', HEAT_COLOR] } });
    map.addLayer({ id: 'pin-flash', type: 'circle', source: 'echoes', filter: ['all', exact, ['==', ['get', 'fresh'], 1]], paint: {
      'circle-radius': pinR(18, 34), 'circle-color': '#e9f6ff', 'circle-blur': 1, 'circle-opacity': 0.35 } });
    // unopened echoes: a glowing, pulsing cherry
    map.addLayer({ id: 'cherry-glow', type: 'circle', source: 'echoes', filter: cherry, paint: {
      'circle-radius': pinR(12, 26), 'circle-color': '#ff3b5c', 'circle-blur': 1, 'circle-opacity': ['*', ['get', 'life'], 0.55] } });
    map.addLayer({ id: 'cherry-ring', type: 'circle', source: 'echoes', filter: cherry, paint: {
      'circle-radius': pinR(8, 16), 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 1.4, 'circle-stroke-color': '#ff6b81', 'circle-stroke-opacity': 0 } });
    map.addLayer({ id: 'cherry-icon', type: 'symbol', source: 'echoes', filter: cherry, layout: {
      'icon-image': 'cherry', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-anchor': 'bottom', 'icon-offset': [0, 6],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.55, 18, 1] },
      paint: { 'icon-opacity': ['max', 0.55, ['get', 'life']] } });
    // you
    map.addLayer({ id: 'me-cone', type: 'symbol', source: 'me', filter: ['has', 'heading'], layout: {
      'icon-image': 'me-cone', 'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.7, 18, 1.1] },
      paint: { 'icon-opacity': 0.9 } });
    map.addLayer({ id: 'me-acc', type: 'circle', source: 'me', paint: {
      'circle-radius': metres(1), 'circle-color': 'rgba(210,225,255,0.07)', 'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(210,225,255,0.22)' } });
    map.addLayer({ id: 'me-glow', type: 'circle', source: 'me', paint: { 'circle-radius': 16, 'circle-color': '#dfe9ff', 'circle-blur': 1, 'circle-opacity': 0.35 } });
    map.addLayer({ id: 'me-dot', type: 'circle', source: 'me', paint: {
      'circle-radius': 5.5, 'circle-color': '#f5f8ff', 'circle-stroke-width': 2.5, 'circle-stroke-color': '#0a0c10' } });
  }

  map.on('style.load', () => {
    clearTimeout(styleTimer);
    tintBaseStyle(map);
    if (!map.getSource('echoes')) addLayers();
    if (!ready) { ready = true; container.dataset.mapReady = '1'; container.dataset.mapStyle = STYLES[styleIx].name; onReady(api); emitMove(); }
    animate();
  });

  const echoLayers = ['echo-field', 'echo-haze', 'echo-bloom', 'pin-halo', 'pin-core', 'cherry-icon', 'cherry-glow'];
  map.on('click', (ev) => {
    if (!ready) return;
    const pad = 14, p = ev.point;
    const box = [[p.x - pad, p.y - pad], [p.x + pad, p.y + pad]];
    const cl = map.queryRenderedFeatures(box, { layers: ['cluster-ring', 'cluster-halo'] })[0];
    if (cl) {
      map.getSource('echoes').getClusterExpansionZoom(cl.properties.cluster_id)
        .then((z) => map.easeTo({ center: cl.geometry.coordinates, zoom: Math.min(z + 0.3, 17), duration: reducedMotion() ? 0 : 650 }))
        .catch(() => {});
      return;
    }
    const hits = map.queryRenderedFeatures(box, { layers: echoLayers });
    if (!hits.length) { onSelect(null); return; }
    // nearest glow centre to the tap
    const best = hits.map((f) => ({ f, d: dist2(map.project(f.geometry.coordinates), p) })).sort((a, b) => a.d - b.d)[0].f;
    onSelect(best.properties.id);
  });
  for (const id of [...echoLayers, 'cluster-ring']) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }

  function emitMove() {
    const b = map.getBounds();
    onMove({ minLat: b.getSouth(), minLng: b.getWest(), maxLat: b.getNorth(), maxLng: b.getEast() }, map.getCenter(), map.getZoom());
  }
  let moveT = 0;
  map.on('moveend', () => { clearTimeout(moveT); moveT = setTimeout(emitMove, 250); });

  // ripple: one slow sonar ring per glow (skipped with prefers-reduced-motion)
  function animate() {
    cancelAnimationFrame(raf);
    if (reducedMotion()) return;
    let last = 0;
    const tick = (t) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 50 || document.hidden || !map.getLayer('echo-ripple')) return;
      last = t;
      const k = (t % 3200) / 3200;                     // 0..1
      const ease = 1 - (1 - k) ** 3;
      map.setPaintProperty('echo-ripple', 'circle-radius', metres(0.35 + 1.1 * ease));
      map.setPaintProperty('echo-ripple', 'circle-stroke-opacity', ['*', ['get', 'life'], 0.55 * (1 - k)]);
      map.setPaintProperty('echo-flash', 'circle-opacity', 0.15 + 0.25 * Math.abs(Math.sin(t / 380)));
      const k2 = ((t + 900) % 2600) / 2600, e2 = 1 - (1 - k2) ** 2;
      map.setPaintProperty('pin-ripple', 'circle-radius', ['interpolate', ['linear'], ['zoom'], 11, 4 + 14 * e2, 18, 6 + 30 * e2]);
      map.setPaintProperty('pin-ripple', 'circle-stroke-opacity', ['*', ['get', 'life'], 0.7 * (1 - k2)]);
      map.setPaintProperty('pin-flash', 'circle-opacity', 0.15 + 0.25 * Math.abs(Math.sin(t / 380)));
      if (map.getLayer('cherry-glow')) {
        const pulse = 0.5 + 0.5 * Math.sin(t / 420);                    // ~2.6 s breathing glow + sonar ring + bob
        map.setPaintProperty('cherry-glow', 'circle-opacity', ['*', ['get', 'life'], 0.3 + 0.4 * pulse]);
        map.setPaintProperty('cherry-ring', 'circle-radius', ['interpolate', ['linear'], ['zoom'], 11, 5 + 14 * e2, 18, 8 + 30 * e2]);
        map.setPaintProperty('cherry-ring', 'circle-stroke-opacity', ['*', ['get', 'life'], 0.8 * (1 - k2)]);
        map.setPaintProperty('cherry-icon', 'icon-translate', [0, -2.5 * pulse]);
      }
    };
    raf = requestAnimationFrame(tick);
  }

  const api = {
    map,
    get ready() { return ready; },
    setEchoes(list) {
      echoes = list;
      if (ready && map.getSource('echoes')) map.getSource('echoes').setData(toFeatures(list));
    },
    setMe(pos) {
      me = pos;
      if (ready && map.getSource('me')) map.getSource('me').setData(meFeatures());
    },
    flyTo({ lat, lng }, z) {
      map.flyTo({ center: [lng, lat], zoom: z ?? Math.max(map.getZoom(), 15.5), duration: reducedMotion() ? 0 : 1100, essential: true });
    },
    follow({ lat, lng }) {
      map.easeTo({ center: [lng, lat], duration: reducedMotion() ? 0 : 600, essential: true });
    },
    jumpTo({ lat, lng }, z) { map.jumpTo({ center: [lng, lat], zoom: z ?? map.getZoom() }); },
    project({ lat, lng }) { return map.project([lng, lat]); },
    bounds() { const b = map.getBounds(); return { minLat: b.getSouth(), minLng: b.getWest(), maxLat: b.getNorth(), maxLng: b.getEast() }; },
    resize() { map.resize(); },
    /** One-shot drop-in: a pin falls onto the spot with a bounce and a ripple (DOM marker, transforms only). */
    dropIn({ lat, lng }, { cherry = false } = {}) {
      if (reducedMotion() || !ready) return;
      const el = document.createElement('div'); el.className = `drop-in${cherry ? ' is-cherry' : ''}`; el.setAttribute('aria-hidden', 'true');
      el.innerHTML = '<i class="di-ring"></i><i class="di-pin"></i>';
      const mk = new ml.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(map);
      setTimeout(() => mk.remove(), 1400);
    },
    refreshPins() { if (ready && map.getSource('echoes')) map.getSource('echoes').setData(toFeatures(echoes)); },
    destroy() { cancelAnimationFrame(raf); map.remove(); },
  };
  return api;
}

/** Heading cone: a soft wedge pointing north from the image centre (rotated by heading on the map). */
function coneImage() {
  const S = 160, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), cx = S / 2, cy = S / 2, R = S / 2;
  const grad = g.createRadialGradient(cx, cy, 4, cx, cy, R);
  grad.addColorStop(0, 'rgba(223,233,255,0.85)'); grad.addColorStop(0.55, 'rgba(169,162,240,0.35)'); grad.addColorStop(1, 'rgba(169,162,240,0)');
  g.fillStyle = grad; g.beginPath(); g.moveTo(cx, cy);
  const half = 32 * Math.PI / 180, up = -Math.PI / 2;
  g.arc(cx, cy, R, up - half, up + half); g.closePath(); g.fill();
  return g.getImageData(0, 0, S, S);
}
/** Cherry: two glossy red drops on a forked stem with a leaf (drawn, not an emoji, so it looks the same everywhere). */
function cherryImage() {
  const W = 72, H = 80, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.lineCap = 'round'; g.strokeStyle = '#5fbf6a'; g.lineWidth = 3.2;
  g.beginPath(); g.moveTo(40, 10); g.quadraticCurveTo(30, 26, 22, 48); g.moveTo(40, 10); g.quadraticCurveTo(46, 30, 50, 52); g.stroke();
  g.fillStyle = '#7ed492'; g.beginPath(); g.ellipse(50, 12, 10, 5, -0.5, 0, Math.PI * 2); g.fill();
  const berry = (x, y, r) => {
    const grd = g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    grd.addColorStop(0, '#ff8fa0'); grd.addColorStop(0.45, '#ff2d55'); grd.addColorStop(1, '#a30d2c');
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,.75)'; g.beginPath(); g.ellipse(x - r * 0.38, y - r * 0.42, r * 0.22, r * 0.13, -0.6, 0, Math.PI * 2); g.fill();
  };
  berry(21, 58, 14); berry(50, 61, 14);
  return g.getImageData(0, 0, W, H);
}
function dist2(a, b) { return (a.x - b.x) ** 2 + (a.y - b.y) ** 2; }
function hashId(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return Math.abs(h); }
