// hunt-math.js — pure, DOM-free math for the Echolocation "hunt" module.
// Every function here is deterministic and unit-tested in node (tests/hunt-math.test.mjs).

export const EARTH_R = 6371008.8; // mean Earth radius, metres
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export const clamp = (x, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);

/** Normalise any angle to [0, 360). */
export function normDeg(d) {
  const r = d % 360;
  return r < 0 ? r + 360 : r === 0 ? 0 : r; // also turns -0 into 0
}

/** Signed smallest difference a - b, in (-180, 180]. Positive = a is clockwise of b. */
export function angleDiff(a, b) {
  let d = normDeg(a - b);
  if (d > 180) d -= 360;
  return d;
}

/** Great-circle distance in metres (haversine). */
export function haversine(lat1, lng1, lat2, lng2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD;
  const dp = (lat2 - lat1) * RAD, dl = (lng2 - lng1) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from point 1 to point 2, degrees clockwise from true north [0,360). */
export function initialBearing(lat1, lng1, lat2, lng2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lng2 - lng1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normDeg(Math.atan2(y, x) * DEG);
}

/** Point reached travelling distM from (lat,lng) on initial bearing bearingDeg. Used by the mock + desk sim. */
export function destinationPoint(lat, lng, bearingDeg, distM) {
  const d = distM / EARTH_R, b = bearingDeg * RAD, p1 = lat * RAD, l1 = lng * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * DEG, lng: ((l2 * DEG + 540) % 360) - 180 };
}

// ---------------------------------------------------------------- compass

/** Current screen rotation in degrees (0, 90, 180, 270). Pass screen.orientation.angle or window.orientation. */
export function screenAngle(angle) {
  return normDeg(Number(angle) || 0);
}

/**
 * Compass heading (deg clockwise from north) of the TOP OF THE SCREEN from an absolute
 * DeviceOrientation alpha (Android `deviceorientationabsolute`). alpha rotates counter-clockwise,
 * so heading = 360 - alpha; then add the screen rotation so landscape still means "where the
 * content's up points".
 */
export function headingFromAlpha(alpha, screenAngleDeg = 0) {
  return normDeg(360 - alpha + screenAngleDeg);
}

/** iOS: webkitCompassHeading is already clockwise-from-north for the device top; add screen rotation. */
export function headingFromWebkit(webkitCompassHeading, screenAngleDeg = 0) {
  return normDeg(webkitCompassHeading + screenAngleDeg);
}

/**
 * Tilt-compensated heading of where the BACK of the phone points (W3C DeviceOrientation spec, example 7),
 * which is what you want when the phone is held upright and "aimed". Falls back to headingFromAlpha
 * when the phone is near-flat (the back points at the ground, so its horizontal direction is undefined).
 * For gamma = 0 this equals 360 - alpha, so the two formulas join continuously.
 */
export function headingFromEuler(alpha, beta, gamma, screenAngleDeg = 0) {
  const x = (beta || 0) * RAD, y = (gamma || 0) * RAD, z = (alpha || 0) * RAD;
  const cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z);
  const sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
  const Vx = -cZ * sY - sZ * sX * cY;
  const Vy = -sZ * sY + cZ * sX * cY;
  if (Math.hypot(Vx, Vy) < 0.5) return headingFromAlpha(alpha || 0, screenAngleDeg); // < ~30° tilt: treat as flat
  return normDeg(Math.atan2(Vx, Vy) * DEG + screenAngleDeg);
}

/** Pitch of the phone's back (camera) direction above the horizon, from beta, portrait only. 0 = upright, +90 = pointing at the sky. */
export function pitchFromBeta(beta) {
  return clamp((beta ?? 90) - 90, -90, 90);
}

/** Circular mean of angles in degrees (null for empty input or perfectly cancelling input). */
export function circularMean(angles, weights) {
  let s = 0, c = 0;
  angles.forEach((a, i) => { const w = weights ? weights[i] : 1; s += w * Math.sin(a * RAD); c += w * Math.cos(a * RAD); });
  if (Math.hypot(s, c) < 1e-9) return null;
  return normDeg(Math.atan2(s, c) * DEG);
}

/** One step of an exponential moving average on a circle (handles the 359 -> 0 wrap). k in (0,1]. */
export function smoothAngle(prev, next, k = 0.25) {
  if (prev == null || !Number.isFinite(prev)) return normDeg(next);
  return normDeg(prev + k * angleDiff(next, prev));
}

// ---------------------------------------------------------------- GPS smoothing

/**
 * Minimal 1-state Kalman filter for lat/lng with per-fix accuracy (the classic "KalmanLatLong").
 * q = process noise in m/s (how fast we believe the walker can move). Fixes worse than maxAccuracyM
 * are ignored once we have an estimate; before the first good fix they are accepted but flagged lowConfidence.
 * Jumps > jumpResetM with a good fix reset the filter (e.g. after a tunnel).
 */
export function createGpsFilter({ q = 3, maxAccuracyM = 40, minAccuracyM = 1, jumpResetM = 250 } = {}) {
  let lat = 0, lng = 0, variance = -1, ts = 0;
  return {
    process(fLat, fLng, accuracy, timestamp) {
      const acc = Math.max(Number.isFinite(accuracy) ? accuracy : 999, minAccuracyM);
      const poor = acc > maxAccuracyM;
      if (variance >= 0 && poor) {
        return { lat, lng, accuracy: Math.sqrt(variance), accepted: false, lowConfidence: true };
      }
      if (variance < 0 || (!poor && haversine(lat, lng, fLat, fLng) > jumpResetM)) {
        lat = fLat; lng = fLng; variance = acc * acc; ts = timestamp;
      } else {
        const dt = Math.max(0, timestamp - ts);
        if (dt > 0) { variance += (dt * q * q) / 1000; ts = timestamp; }
        const K = variance / (variance + acc * acc);
        lat += K * (fLat - lat);
        lng += K * (fLng - lng);
        variance = (1 - K) * variance;
      }
      return { lat, lng, accuracy: Math.sqrt(variance), accepted: true, lowConfidence: poor };
    },
    reset() { variance = -1; },
    get estimate() { return variance < 0 ? null : { lat, lng, accuracy: Math.sqrt(variance) }; },
  };
}

// ---------------------------------------------------------------- sonar

export const PING_DEFAULTS = { nearM: 5, farM: 150, silentM: 300, minMs: 250, maxMs: 4000 };

/**
 * Ping interval in ms for a distance. Geometric (log-log) interpolation between
 * (farM -> maxMs) and (nearM -> minMs): equal *ratios* of distance give equal ratios of rate,
 * which feels linear to the ear. 150 m -> 4 s, 60 m -> ~1.9 s, 20 m -> ~0.9 s, 5 m -> 0.25 s.
 * Beyond farM it stays at maxMs; beyond silentM returns null (no ping).
 */
export function pingIntervalMs(distM, o = {}) {
  const { nearM, farM, silentM, minMs, maxMs } = { ...PING_DEFAULTS, ...o };
  if (distM == null || !Number.isFinite(distM) || distM > silentM) return null;
  const d = clamp(distM, nearM, farM);
  const t = Math.log(d / nearM) / Math.log(farM / nearM); // 0 at near, 1 at far
  return Math.round(minMs * Math.pow(maxMs / minMs, t));
}

/** Ping pitch: rises slightly as you close in (1000 Hz far -> 1500 Hz near). */
export function pingFrequency(distM, o = {}) {
  const { nearM, farM } = { ...PING_DEFAULTS, ...o };
  const t = clamp(Math.log(clamp(distM, nearM, farM) / nearM) / Math.log(farM / nearM));
  return 1500 - 500 * t;
}

/** Vague word for distance; the UI never shows numbers outside debug. */
export function distanceWord(distM, unlockRadiusM = 15) {
  if (distM == null || !Number.isFinite(distM)) return 'quiet';
  if (distM <= unlockRadiusM) return 'here';
  if (distM <= 40) return 'close';
  if (distM <= 100) return 'near';
  return 'far';
}

// ---------------------------------------------------------------- tune-in

/** Bearing of the echo relative to where you face: (-180,180], + = to your right. */
export function relativeAngle(bearingDeg, headingDeg) {
  return angleDiff(bearingDeg, headingDeg);
}

/** Elevation angle (deg) from you to the echo given altitude difference and horizontal distance. */
export function elevationAngle(altDiffM, horizM) {
  return Math.atan2(altDiffM, Math.max(horizM, 1)) * DEG;
}

/**
 * Angular separation (deg) between where you point (az heading, el pitch) and the echo (az bearing, el elev),
 * via the spherical law of cosines. With both elevations 0 this is |relativeAngle|.
 */
export function pointingError(relAzDeg, pitchDeg = 0, elevDeg = 0) {
  const e1 = pitchDeg * RAD, e2 = elevDeg * RAD;
  const c = Math.sin(e1) * Math.sin(e2) + Math.cos(e1) * Math.cos(e2) * Math.cos(relAzDeg * RAD);
  return Math.acos(clamp(c, -1, 1)) * DEG;
}

/** Alignment in [0,1]: cos(error) clamped, so facing away (>= 90°) is 0. */
export function alignment(errorDeg) {
  return clamp(Math.cos(errorDeg * RAD), 0, 1);
}

export const TUNE_DEFAULTS = { minCutoffHz: 400, maxCutoffHz: 20000, cutoffCurve: 2, maxNoise: 0.55, noiseFloor: 0.02 };

/** Map alignment -> audio parameters for the tune-in graph. */
export function tuneParams(a, o = {}) {
  const { minCutoffHz, maxCutoffHz, cutoffCurve, maxNoise, noiseFloor } = { ...TUNE_DEFAULTS, ...o };
  a = clamp(a);
  return {
    cutoffHz: minCutoffHz * Math.pow(maxCutoffHz / minCutoffHz, Math.pow(a, cutoffCurve)), // exponential = perceptually even
    signalGain: 0.22 + 0.78 * Math.pow(a, 1.5),
    noiseGain: noiseFloor + maxNoise * Math.pow(1 - a, 1.2),
    wobbleCents: 700 * (1 - a), // LFO depth on the filter: the "ghost transmission" warble
  };
}

/** Listener-space position for a PannerNode (listener faces -z, +x is right). */
export function pannerPosition(relAzDeg, elevDeg = 0, r = 1) {
  const az = relAzDeg * RAD, el = elevDeg * RAD;
  return { x: r * Math.sin(az) * Math.cos(el), y: r * Math.sin(el), z: -r * Math.cos(az) * Math.cos(el) };
}

/** Stereo pan [-1,1] for the sonar ping from relative angle (behind you is centred-ish but quieter in the caller). */
export function stereoPan(relAzDeg, depth = 0.8) {
  return clamp(Math.sin(relAzDeg * RAD) * depth, -1, 1);
}

/**
 * Alignment lock with hysteresis: locked once |error| <= lockDeg continuously for holdMs;
 * released when error > releaseDeg. Pure reducer: returns a new state.
 */
export function updateLock(state, errorDeg, now, { lockDeg = 20, releaseDeg = 30, holdMs = 2000 } = {}) {
  const s = state || { since: null, locked: false };
  const e = Math.abs(errorDeg);
  if (s.locked) return e > releaseDeg ? { since: null, locked: false, justLocked: false } : { ...s, justLocked: false };
  if (e <= lockDeg) {
    const since = s.since ?? now;
    const locked = now - since >= holdMs;
    return { since, locked, justLocked: locked, progress: clamp((now - since) / holdMs) };
  }
  return { since: null, locked: false, justLocked: false, progress: 0 };
}

// ---------------------------------------------------------------- targeting / polling

/** Annotate echoes with distance/bearing from pos, drop expired, sort nearest first. */
export function rankEchoes(echoes, pos, now = Date.now()) {
  return (echoes || [])
    .filter(e => e && Number.isFinite(e.lat) && Number.isFinite(e.lng))
    .filter(e => !e.expiresAt || new Date(e.expiresAt).getTime() > now)
    .map(e => ({ ...e, distanceM: haversine(pos.lat, pos.lng, e.lat, e.lng), bearingDeg: initialBearing(pos.lat, pos.lng, e.lat, e.lng) }))
    .sort((a, b) => a.distanceM - b.distanceM);
}

/** Should we call source.nearby() again? Time-based (intervalMs) or movement-based (moveM). */
export function shouldPoll(last, pos, now, { intervalMs = 10000, moveM = 15 } = {}) {
  if (!pos) return false;
  if (!last) return true;
  if (now - last.at >= intervalMs) return true;
  return haversine(last.lat, last.lng, pos.lat, pos.lng) >= moveM;
}
