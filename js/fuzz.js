// fuzz.js: turns an exact Echo position into a stable "glow" on the map, never the exact point.
// Each Echo gets a blob 30–60 m in radius whose centre is shifted 30–80 % of that radius in a direction
// derived from the echo id, so the true spot is always inside the glow but never at its centre, and the
// blob does not jump around between refreshes.
//
// CLIENT-SIDE fallback only. Once backend/migrations/002_map_realtime.sql is applied, map_echoes()
// fuzzes on the server with a secret salt and exact coordinates never reach the map at all.
// (This client version is keyed on the public id, so it hides the point visually, not cryptographically.)

export const FUZZ_MIN_R = 30;
export const FUZZ_MAX_R = 60;

// cyrb53-style 2x32-bit hash -> three uniforms in [0,1)
function uniforms(str) {
  let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const h3 = Math.imul(h1 ^ h2 ^ 0x9e3779b9, 0x85ebca6b) ^ (h2 >>> 7);
  return [(h1 >>> 0) / 4294967296, (h2 >>> 0) / 4294967296, (h3 >>> 0) / 4294967296];
}

const R_EARTH = 6371008.8, rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
export function destPoint(lat, lng, brgDeg, distM) {
  const d = distM / R_EARTH, b = rad(brgDeg), p1 = rad(lat), l1 = rad(lng);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: deg(p2), lng: ((deg(l2) + 540) % 360) - 180 };
}

/** fuzzPoint(id, lat, lng) -> { lat, lng, radiusM }  (deterministic per id) */
export function fuzzPoint(id, lat, lng) {
  const [u1, u2, u3] = uniforms(String(id));
  const radiusM = FUZZ_MIN_R + (FUZZ_MAX_R - FUZZ_MIN_R) * u1;
  const c = destPoint(lat, lng, 360 * u3, radiusM * (0.3 + 0.5 * u2));
  // round to ~1 m so the stored value carries no extra precision
  return { lat: Math.round(c.lat * 1e5) / 1e5, lng: Math.round(c.lng * 1e5) / 1e5, radiusM: Math.round(radiusM * 10) / 10 };
}
