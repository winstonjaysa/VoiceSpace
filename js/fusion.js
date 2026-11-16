// fusion.js — GPS + pedestrian dead reckoning (PDR) for the Echolocation hunt. Pure, DOM-free, unit-tested.
//
//   step detector : DeviceMotion acceleration magnitude -> step events (peak + valley hysteresis)
//   PDR Kalman    : 2-D position in local metres (east, north). Each step predicts L metres along the heading,
//                   with along-track (step length) and cross-track (heading) noise. Each GPS fix corrects it,
//                   weighted by its reported accuracy (R = acc^2), with a robust gate against multipath jumps.
//   step length   : starts at 0.7 m, calibrated from GPS distance over step count while walking straight.
//   coarse check  : detects iOS "Precise Location off" / approximate location (>= ~1 km or grid-quantised fixes).
//   normalizeFix  : accepts a GeolocationPosition or a teammate's precise-fix result (Cooker / trax / spec shapes).

const R_EARTH = 6371008.8, RAD = Math.PI / 180, DEG = 180 / Math.PI;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// ------------------------------------------------------------------ fix normalisation
/**
 * Any fix -> { lat, lng, accuracy, altitude, timestamp } or null.
 * Accepts: GeolocationPosition {coords,timestamp}; Cooker's preciseFix() {lat,lng,accuracy,samples,at};
 * the {lat,lng,accuracyM,altitude,samples,quality} shape; and {latitude,longitude,...}. Timestamps: timestamp|at|ts.
 */
export function normalizeFix(f) {
  if (!f) return null;
  const c = f.coords || f;
  const lat = Number(c.latitude ?? c.lat), lng = Number(c.longitude ?? c.lng ?? c.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const acc = Number(c.accuracy ?? c.accuracyM ?? f.accuracyM ?? f.accuracy);
  const ts = Number(f.timestamp ?? f.at ?? f.ts ?? c.timestamp ?? Date.now());
  return { lat, lng, accuracy: Number.isFinite(acc) && acc > 0 ? acc : 30, altitude: Number.isFinite(c.altitude) ? c.altitude : null,
    timestamp: Number.isFinite(ts) ? ts : Date.now(), samples: f.samples ?? null };
}

// ------------------------------------------------------------------ local tangent plane
export function createFrame(lat0, lng0) {
  const k = Math.cos(lat0 * RAD);
  return {
    lat0, lng0,
    toENU: (lat, lng) => ({ e: (lng - lng0) * RAD * R_EARTH * k, n: (lat - lat0) * RAD * R_EARTH }),
    toLL: (e, n) => ({ lat: lat0 + (n / R_EARTH) * DEG, lng: lng0 + (e / (R_EARTH * k)) * DEG }),
  };
}

// ------------------------------------------------------------------ step detection
/**
 * Feed acceleration magnitude samples (m/s^2, with or without gravity) via push(tMs, mag).
 * Removes gravity/bias with a slow EMA, smooths with a fast EMA, then counts a step at each peak
 * above +peakThreshold that follows a dip below -valleyThreshold, at least minIntervalMs after the last.
 * Returns true from push() on the sample that completes a step.
 */
export function createStepDetector({ peakThreshold = 0.9, valleyThreshold = 0.5, minIntervalMs = 280, maxIntervalMs = 2000,
  smoothing = 0.35, biasTauMs = 1500 } = {}) {
  let bias = null, smooth = 0, lastT = null, armed = true, peak = -Infinity, inPeak = false, lastStepAt = -Infinity, count = 0, cadenceMs = null;
  return {
    push(t, mag) {
      if (!Number.isFinite(mag)) return false;
      const dt = lastT == null ? 16 : clamp(t - lastT, 1, 200); lastT = t;
      bias = bias == null ? mag : bias + (1 - Math.exp(-dt / biasTauMs)) * (mag - bias);
      smooth += smoothing * (mag - bias - smooth);
      if (smooth < -valleyThreshold) armed = true;
      if (armed && smooth > peakThreshold) { inPeak = true; peak = Math.max(peak, smooth); }
      if (inPeak && smooth < peak * 0.6) {        // peak passed
        inPeak = false; peak = -Infinity;
        if (t - lastStepAt >= minIntervalMs) {
          const iv = t - lastStepAt;
          if (iv <= maxIntervalMs) cadenceMs = cadenceMs == null ? iv : cadenceMs + 0.2 * (iv - cadenceMs);
          lastStepAt = t; count++; armed = false;
          return true;
        }
      }
      return false;
    },
    get count() { return count; },
    get lastStepAt() { return lastStepAt; },
    /** steps per second, or 0 if no step recently */
    cadence(t) { return cadenceMs && t - lastStepAt < maxIntervalMs ? 1000 / cadenceMs : 0; },
    reset() { bias = null; smooth = 0; lastT = null; armed = true; inPeak = false; peak = -Infinity; lastStepAt = -Infinity; count = 0; cadenceMs = null; },
  };
}

/** Magnitude from a DeviceMotionEvent (prefers gravity-free acceleration; both work with the detector's bias removal). */
export function motionMagnitude(e) {
  const a = (e.acceleration && e.acceleration.x != null) ? e.acceleration : e.accelerationIncludingGravity;
  if (!a || a.x == null) return NaN;
  return Math.hypot(a.x, a.y || 0, a.z || 0);
}

// ------------------------------------------------------------------ PDR + GPS Kalman filter
export const FUSION_DEFAULTS = Object.freeze({
  stepLengthM: 0.7,        // initial step length; calibrated from GPS over time
  stepLengthSigma: 0.15,   // fractional along-track error per step
  headingSigmaDeg: 12,     // compass vs walking-direction error per step (cross-track), after calibration
  uncalibratedHeadingSigmaDeg: 18, // until the first GPS-vs-steps calibration (compass bias unknown)
  walkNoise: 1.4,          // m/s random walk when steps are NOT available (no motion sensor) — like v1's q
  stillNoise: 0.15,        // m/s random walk when the motion sensor is live but no steps (standing still)
  noHeadingStepNoise: 2.0, // isotropic metres per step when we have steps but no heading
  minAccuracyM: 3,         // GNSS floor: never trust a fix more than this
  maxAccuracyM: 60,        // fixes worse than this are ignored once initialised
  gate: 13.8,              // chi^2 (2 dof, 99.9 %): beyond this the fix is down-weighted
  resetAfterRejects: 4,    // this many gated fixes in a row => trust GPS again (we were wrong, not GPS)
  jumpResetM: 250,
  calibrate: true, calibMinM: 35, calibMinSteps: 30, calibMaxAccM: 12, calibRate: 0.25, biasRate: 0.3, firstBiasRate: 0.6, stepLengthRange: [0.45, 1.0],
});

export function createFusion(opts = {}) {
  const o = { ...FUSION_DEFAULTS, ...opts };
  let frame = null, x = 0, y = 0, P = [[1, 0], [0, 1]], tLast = 0, init = false;
  let stepLen = o.stepLengthM, headingBias = 0, calibrated = 0, steps = 0, rejects = 0, motionLive = false, lastAcc = null, lastStepT = -Infinity;
  let calib = null; // { e, n, steps, headings[] } anchor for step-length calibration

  const addQ = (q00, q01, q11) => { P = [[P[0][0] + q00, P[0][1] + q01], [P[1][0] + q01, P[1][1] + q11]]; };
  function timeUpdate(t) {
    const dt = Math.max(0, (t - tLast) / 1000); tLast = Math.max(tLast, t);
    if (!dt) return;
    const walking = t - lastStepT < 1500;
    const q = motionLive ? (walking ? o.stillNoise * 2 : o.stillNoise) : o.walkNoise;
    addQ(q * q * dt, 0, q * q * dt);
  }
  const out = (extra = {}) => {
    const ll = frame.toLL(x, y);
    return { lat: ll.lat, lng: ll.lng, accuracy: Math.sqrt((P[0][0] + P[1][1]) / 2), stepLengthM: stepLen, steps, ...extra };
  };
  function resetTo(f, t) {
    frame = frame || createFrame(f.lat, f.lng);
    const p = frame.toENU(f.lat, f.lng); x = p.e; y = p.n;
    const a = Math.max(f.accuracy, o.minAccuracyM); P = [[a * a, 0], [0, a * a]]; tLast = t; init = true; rejects = 0; calib = null;
  }

  return {
    /** GPS (or a teammate's precise-fix result). Returns the fused estimate + { accepted, gated }. */
    gps(fix) {
      const f = normalizeFix(fix); if (!f) return init ? out({ accepted: false }) : null;
      const t = f.timestamp; lastAcc = f.accuracy;
      const a = Math.max(f.accuracy, o.minAccuracyM);
      if (!init) { resetTo(f, t); return out({ accepted: true, lowConfidence: f.accuracy > o.maxAccuracyM }); }
      if (f.accuracy > o.maxAccuracyM) return out({ accepted: false, lowConfidence: true });
      timeUpdate(t);
      const z = frame.toENU(f.lat, f.lng), vx = z.e - x, vy = z.n - y;
      if (Math.hypot(vx, vy) > o.jumpResetM) { resetTo(f, t); return out({ accepted: true, reset: true }); }
      let r = a * a;
      let S = [[P[0][0] + r, P[0][1]], [P[1][0], P[1][1] + r]];
      let det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
      const d2 = (vx * (S[1][1] * vx - S[0][1] * vy) + vy * (-S[1][0] * vx + S[0][0] * vy)) / det;
      let gated = false;
      if (d2 > o.gate) {
        if (++rejects >= o.resetAfterRejects) { resetTo(f, t); return out({ accepted: true, reset: true }); }
        gated = true; r *= d2 / o.gate;            // robust: inflate R instead of hard reject
        S = [[P[0][0] + r, P[0][1]], [P[1][0], P[1][1] + r]]; det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
      } else rejects = 0;
      const Si = [[S[1][1] / det, -S[0][1] / det], [-S[1][0] / det, S[0][0] / det]];
      const K = [[P[0][0] * Si[0][0] + P[0][1] * Si[1][0], P[0][0] * Si[0][1] + P[0][1] * Si[1][1]],
                 [P[1][0] * Si[0][0] + P[1][1] * Si[1][0], P[1][0] * Si[0][1] + P[1][1] * Si[1][1]]];
      x += K[0][0] * vx + K[0][1] * vy; y += K[1][0] * vx + K[1][1] * vy;
      const IK = [[1 - K[0][0], -K[0][1]], [-K[1][0], 1 - K[1][1]]];
      P = [[IK[0][0] * P[0][0] + IK[0][1] * P[1][0], IK[0][0] * P[0][1] + IK[0][1] * P[1][1]],
           [IK[1][0] * P[0][0] + IK[1][1] * P[1][0], IK[1][0] * P[0][1] + IK[1][1] * P[1][1]]];
      P[0][1] = P[1][0] = (P[0][1] + P[1][0]) / 2;
      if (o.calibrate && !gated) calibrateWith(z, f.accuracy);
      return out({ accepted: true, gated });
    },
    /** One detected step. headingDeg = walking direction (compass of the phone top/back); null = unknown. */
    step(t, headingDeg = null) {
      motionLive = true; lastStepT = t; steps++;
      if (!init) return null;
      timeUpdate(t);
      if (headingDeg == null || !Number.isFinite(headingDeg)) {
        const s = o.noHeadingStepNoise; addQ(s * s, 0, s * s);
        if (calib) calib = null;
        return out({ propagated: false });
      }
      const raw = headingDeg * RAD, h = (headingDeg - headingBias) * RAD, se = Math.sin(h), cn = Math.cos(h);
      x += stepLen * se; y += stepLen * cn;
      const sa = stepLen * o.stepLengthSigma, sc = stepLen * (calibrated ? o.headingSigmaDeg : o.uncalibratedHeadingSigmaDeg) * RAD;
      // Q = Rot diag(sa^2, sc^2) Rot^T, along = (se, cn), cross = (cn, -se)
      addQ(sa * sa * se * se + sc * sc * cn * cn, (sa * sa - sc * sc) * se * cn, sa * sa * cn * cn + sc * sc * se * se);
      if (calib) { calib.steps++; calib.hs += Math.sin(raw); calib.hc += Math.cos(raw); }
      return out({ propagated: true });
    },
    /** Motion sensor is delivering events (even without steps) — lowers process noise when standing still. */
    motionAlive(t) { motionLive = true; if (init) timeUpdate(t); },
    /** Prediction to time t without a measurement (call before reading between events if you want time-decay). */
    predict(t) { if (init) timeUpdate(t); return init ? out() : null; },
    reset() { init = false; frame = null; calib = null; steps = 0; rejects = 0; },
    get estimate() { return init ? out() : null; },
    get stepLengthM() { return stepLen; },
    get headingBiasDeg() { return headingBias; },
    set stepLengthM(v) { stepLen = clamp(v, ...o.stepLengthRange); },
    get initialised() { return init; },
    get lastGpsAccuracy() { return lastAcc; },
  };

  // step length = GPS straight-line distance / steps, over a straight stretch with good fixes
  function calibrateWith(z, acc) {
    if (acc > o.calibMaxAccM) { calib = null; return; }
    if (!calib) { calib = { e: z.e, n: z.n, steps: 0, hs: 0, hc: 0 }; return; }
    const d = Math.hypot(z.e - calib.e, z.n - calib.n);
    if (calib.steps >= o.calibMinSteps && d >= o.calibMinM) {
      const straightness = Math.hypot(calib.hs, calib.hc) / calib.steps;   // 1 = all steps same heading
      if (straightness > 0.95) {
        const est = clamp(d / calib.steps, ...o.stepLengthRange);
        stepLen = clamp(stepLen + o.calibRate * (est - stepLen), ...o.stepLengthRange);
        // compass-vs-walking-direction bias (phone held askew, magnetic disturbance, declination quirks)
        const stepDir = Math.atan2(calib.hs, calib.hc) * DEG, gpsDir = Math.atan2(z.e - calib.e, z.n - calib.n) * DEG;
        let b = stepDir - gpsDir; b = ((b + 540) % 360) - 180;
        if (Math.abs(b) < 60) headingBias = clamp(headingBias + (calibrated ? o.biasRate : o.firstBiasRate) * (b - headingBias), -45, 45);
        calibrated++;
      }
      calib = { e: z.e, n: z.n, steps: 0, hs: 0, hc: 0 };
    }
  }
}

// ------------------------------------------------------------------ coarse / approximate location
const isQuantised = (v, step) => Math.abs(v / step - Math.round(v / step)) < 1e-6;
/**
 * fixes: recent [{lat,lng,accuracy}] (newest last). Returns { coarse, level, reason }.
 *  level 'approximate' : accuracy >= coarseM on most recent fixes, or coordinates snapped to a grid
 *                        (iOS Precise Location off / Android "approximate" permission)
 *  level 'weak'        : 100 m .. coarseM (Wi-Fi/cell only, typically indoors)
 *  level 'ok'
 */
export function detectCoarse(fixes, { coarseM = 1000, weakM = 100, minFixes = 3 } = {}) {
  const f = (fixes || []).map(normalizeFix).filter(Boolean).slice(-6);
  if (f.length < minFixes) return { coarse: false, level: 'unknown', reason: 'not enough fixes' };
  const accs = f.map(x => x.accuracy).sort((a, b) => a - b), med = accs[Math.floor(accs.length / 2)];
  const distinct = new Set(f.map(x => `${x.lat},${x.lng}`)).size;
  const grid = [0.01, 0.005, 0.001].find(s => f.every(x => isQuantised(x.lat, s) && isQuantised(x.lng, s)));
  const lastN = f.slice(-minFixes);
  if (lastN.every(x => x.accuracy >= coarseM)) return { coarse: true, level: 'approximate', reason: `last ${minFixes} fixes ±${Math.round(Math.min(...lastN.map(x => x.accuracy)))} m or worse` };
  if (grid && (distinct >= 2 || med >= 200)) return { coarse: true, level: 'approximate', reason: `coordinates snapped to a ${grid}° grid` };
  if (med >= weakM) return { coarse: false, level: 'weak', reason: `median ±${Math.round(med)} m` };
  return { coarse: false, level: 'ok', reason: `median ±${Math.round(med)} m` };
}

/** Platform-specific fix-it text. ua = navigator.userAgent. Sources in README. */
export function preciseLocationHelp(ua = '') {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua));
  if (ios) return {
    platform: 'ios',
    title: 'Precise Location is off',
    steps: ['Open Settings › Privacy & Security › Location Services.', 'Tap Safari Websites (or the browser you use, e.g. Chrome).',
      'Choose “While Using the App” and turn Precise Location on.', 'Come back here and reload.'],
  };
  if (/Android/.test(ua)) return {
    platform: 'android',
    title: 'Your phone is only sharing an approximate location',
    steps: ['Chrome: ⋮ › Settings › Site settings › Location — allow this site.', 'Android Settings › Apps › Chrome › Permissions › Location — Allow only while using the app, and turn on “Use precise location”.',
      'Android Settings › Location › Location services › Location Accuracy — turn on “Improve Location Accuracy”.', 'Come back here and reload.'],
  };
  return { platform: 'other', title: 'Location is approximate', steps: ['Allow precise location for this site in your browser and device settings, then reload.'] };
}
