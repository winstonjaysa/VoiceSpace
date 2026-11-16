// precise-fix.js — drop-time GPS lock. Instead of dropping on whatever single fix is newest,
// collect fresh high-accuracy fixes for a short window, reject stale/poor ones, and return an
// accuracy-weighted average (inverse-variance). Typically tightens ±10–15 m phone fixes to ~±4–6 m
// when standing still outdoors. Optional reverse geocode for a human place label (OpenStreetMap: Nominatim, Photon fallback).
// Origin: Cooker's /home/box/shared/echolocation/v2/cooker/precise-fix.js (2026-11-15). raptor: placeLabel() moved
// off Mapbox (no token in the repo) to Nominatim with a Photon fallback; no API key needed for either.
// Usage: const fix = await preciseFix({ onProgress: p => pill.textContent = `GPS ±${p.accuracy} m` });

const R = 6371008.8, rad = d => d * Math.PI / 180;
export function distM(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Pure combiner (unit-testable). fixes: [{lat,lng,accuracy,ts}] */
export function combineFixes(fixes, { maxAccuracyM = 30, outlierK = 2.5 } = {}) {
  let good = fixes.filter(f => Number.isFinite(f.lat) && Number.isFinite(f.lng) && f.accuracy > 0 && f.accuracy <= maxAccuracyM);
  if (!good.length) return null;
  const avg = list => {
    let W = 0, lat = 0, lng = 0;
    for (const f of list) { const w = 1 / (f.accuracy * f.accuracy); W += w; lat += w * f.lat; lng += w * f.lng; }
    return { lat: lat / W, lng: lng / W, accuracy: Math.sqrt(1 / W) };
  };
  let c = avg(good);
  // drop fixes that disagree with the consensus by more than outlierK × their own accuracy (multipath jumps)
  const kept = good.filter(f => distM(f, c) <= outlierK * f.accuracy);
  if (kept.length && kept.length < good.length) { good = kept; c = avg(good); }
  // never claim better than the best single fix / 2, nor below 3 m (GNSS floor)
  const best = Math.min(...good.map(f => f.accuracy));
  c.accuracy = Math.max(3, best / 2, c.accuracy);
  c.samples = good.length;
  return c;
}

/** Collects fixes for up to windowMs; resolves early once targetM is reached with >= minSamples. */
export function preciseFix({ windowMs = 8000, targetM = 6, minSamples = 3, maxAccuracyM = 30, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('no-geolocation'));
    const fixes = [], started = Date.now();
    let done = false, last = null;
    const finish = () => {
      if (done) return; done = true;
      navigator.geolocation.clearWatch(id); clearTimeout(timer);
      const c = combineFixes(fixes, { maxAccuracyM });
      c ? resolve({ ...c, at: Date.now() }) : reject(new Error(last ? `gps-too-weak:${Math.round(last.accuracy)}` : 'gps-timeout'));
    };
    const id = navigator.geolocation.watchPosition(p => {
      if (p.timestamp < started - 1000) return;                 // ignore cached fixes
      const c = p.coords; last = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, ts: p.timestamp };
      fixes.push(last);
      const cur = combineFixes(fixes, { maxAccuracyM });
      onProgress?.({ accuracy: Math.round(cur?.accuracy ?? c.accuracy), samples: cur?.samples ?? 0 });
      if (cur && cur.samples >= minSamples && cur.accuracy <= targetM) finish();
    }, e => { if (e.code === 1) { done = true; clearTimeout(timer); navigator.geolocation.clearWatch(id); reject(new Error('location-denied')); } },
    { enableHighAccuracy: true, maximumAge: 0, timeout: windowMs + 5000 });
    const timer = setTimeout(finish, windowMs);
  });
}

/** Reverse geocode -> short label like "Queens Park Cres W, Toronto". Free OSM services, no key.
 *  One request per drop (Nominatim policy: max 1 req/s, identify the app; browsers send the Referer). */
export async function placeLabel({ lat, lng }, { lang = navigator.language || 'en', timeoutMs = 4000 } = {}) {
  const get = async (url) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { const r = await fetch(url, { signal: ctl.signal, headers: { 'Accept-Language': lang } }); return r.ok ? await r.json() : null; }
    catch { return null; } finally { clearTimeout(t); }
  };
  const la = lat.toFixed(5), ln = lng.toFixed(5);
  const n = await get(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${la}&lon=${ln}&zoom=17&addressdetails=1`);
  if (n?.address) {
    const a = n.address;
    const street = a.road || a.pedestrian || a.footway || a.path || a.square || a.neighbourhood || a.suburb;
    const city = a.city || a.town || a.village || a.municipality || a.county;
    const label = [street, city].filter(Boolean).join(', ');
    if (label) return label;
  }
  const p = await get(`https://photon.komoot.io/reverse?lat=${la}&lon=${ln}&limit=1`);
  const f = p?.features?.[0]?.properties;
  return f ? [f.street || f.name, f.city || f.county].filter(Boolean).join(', ') || null : null;
}
