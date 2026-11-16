// hunt.js — the Echolocation "hunt" module: walk, listen, tune in. No map.
// ES module, no build step. Browser-only (uses Geolocation, DeviceOrientation, Web Audio, Wake Lock).
//
//   import { createHunt } from './hunt.js';
//   const hunt = createHunt({ source, onState, onPing });
//   button.onclick = () => hunt.start();   // MUST be called from a user gesture (iOS audio + compass permission)
//
// See README.md for the source adapter contract and tuning constants.
//
// v2 (night crawler): options.fusion (default true) fuses GPS with pedestrian dead reckoning
// (DeviceMotion step detection + compass heading, 2-D Kalman, see fusion.js). Same public API as v1;
// new: hunt.seedFix(fix) (accepts any teammate's precise-fix result), injectStep(), injectMotion(),
// state.position.source, state.fusion, state.location (coarse / Precise Location off detection).

import * as M from './hunt-math.js';
import * as F from './fusion.js';

export const DEFAULTS = Object.freeze({
  unlockRadiusM: 15,        // enter tune-in at <= this distance (GPS is only ~5–15 m good, don't go lower)
  unlockExitFactor: 1.5,    // leave tune-in at > unlockRadiusM * this (hysteresis against GPS wander)
  searchRadiusM: 300,       // radius passed to source.nearby()
  pollIntervalMs: 10000,    // re-query source.nearby() at least this often...
  pollMoveM: 15,            // ...or after moving this far
  maxAccuracyM: 40,         // ignore fixes worse than this (flag lowConfidence)
  gpsProcessNoise: 3,       // m/s, Kalman q (walking pace-ish)
  ping: { ...M.PING_DEFAULTS }, // { nearM, farM, silentM, minMs, maxMs }
  pingVolume: 0.45,
  pingPan: true,            // pan the ping toward the echo when a heading is known
  vibrate: true,            // navigator.vibrate pulses where supported (Android Chrome; not iOS)
  headingSmoothing: 0.2,    // circular EMA factor per orientation event (0..1, lower = smoother)
  noCompassTimeoutMs: 3000, // no valid compass reading after this => fall back to GPS course / distance-only
  alignLockDeg: 20, alignReleaseDeg: 30, alignHoldMs: 2000,
  tune: { ...M.TUNE_DEFAULTS },
  useElevation: true,       // use pitch (beta) when the echo and you both have altitude
  wakeLock: true,
  useDeviceGeolocation: true, // false => feed positions with hunt.injectPosition() (desk mode / tests)
  useDeviceCompass: true,     // false => feed heading with hunt.injectHeading()
  stateThrottleMs: 80,
  fusion: true,               // GPS + step dead reckoning (fusion.js). false => v1 1-state Kalman.
  fusionOptions: {},          // overrides for fusion.js FUSION_DEFAULTS (stepLengthM, headingSigmaDeg, ...)
  useDeviceMotion: true,      // false => feed steps with hunt.injectStep() / hunt.injectMotion() (tests)
  stepDetector: {},           // overrides for fusion.js createStepDetector()
  coarseCheck: true,          // detect approximate location (iOS Precise Location off) and expose state.location
  firstFixTimeoutMs: 4000,    // no fix from watchPosition by then => getCurrentPosition() accepting a cached reading
  fallbackMaxAgeMs: 120000,   // ...up to this old (a stationary phone indoors often never sends a fresh one)
  initialFix: null,           // optional last known reading (GeolocationPosition / precise-fix result) to start from
});

const now = () => Date.now();
const hasVibrate = () => typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
const readScreenAngle = () =>
  M.screenAngle(screen.orientation?.angle ?? (typeof window.orientation === 'number' ? window.orientation : 0));

export function createHunt({ source, onState = () => {}, onPing = () => {}, options = {} } = {}) {
  if (!source || typeof source.nearby !== 'function') throw new Error('createHunt: source adapter with nearby/unlock/resonate required');
  const o = { ...DEFAULTS, ...options, ping: { ...DEFAULTS.ping, ...options.ping }, tune: { ...DEFAULTS.tune, ...options.tune } };

  // ------------------------------------------------------------ state
  let running = false, hidden = false;
  let ctx = null, audio = null;                 // AudioContext + shared nodes
  let geoWatch = null, wakeLock = null;
  const gps = M.createGpsFilter({ q: o.gpsProcessNoise, maxAccuracyM: o.maxAccuracyM });
  const fuser = o.fusion ? F.createFusion({ maxAccuracyM: o.maxAccuracyM, ...o.fusionOptions }) : null;
  const stepDet = F.createStepDetector(o.stepDetector);
  let firstFixTimer = null, lastRawFix = null;
  let motionPermission = 'unknown', motionAt = 0, recentFixes = [], location = { coarse: false, level: 'unknown', reason: '' };
  let pos = null;                               // { lat, lng, accuracy, altitude, lowConfidence, at, rawAccuracy }
  let gpsCourse = null;                         // degrees, from coords.heading when moving
  let heading = null, pitch = null, headingSource = 'none', headingAt = 0, compassAccuracy = null;
  let compassPermission = 'unknown', compassTimer = null;
  let echoes = [], ranked = [], lastPoll = null, polling = false, pollTimer = null, pollError = null;
  let target = null;                            // nearest ranked echo
  let tune = null;                              // { id, status, graph, lock, canResonate, resonated, error }
  const bufferCache = new Map();                // echo id -> AudioBuffer (or { mediaUrl })
  let pingTimer = null, lastPingAt = 0, pingCount = 0;
  let suspendTimer = null, lastEmit = 0, emitTimer = null, status = 'idle', error = null, needsTap = false;

  const caps = {
    vibrate: hasVibrate(),
    geolocation: typeof navigator !== 'undefined' && 'geolocation' in navigator,
    orientation: typeof window !== 'undefined' && ('DeviceOrientationEvent' in window),
    orientationNeedsPermission: typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function',
    wakeLock: typeof navigator !== 'undefined' && 'wakeLock' in navigator,
    motion: typeof window !== 'undefined' && ('DeviceMotionEvent' in window),
    motionNeedsPermission: typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function',
    hrtf: true,
  };

  // ------------------------------------------------------------ state emission
  function snapshot() {
    const t = target;
    const rel = t && heading != null ? M.relativeAngle(t.bearingDeg, heading) : null;
    return {
      status, error, needsTap,
      position: pos && { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, rawAccuracy: pos.rawAccuracy, altitude: pos.altitude, lowConfidence: pos.lowConfidence, source: pos.source || 'gps' },
      fusion: fuser ? { enabled: true, motionPermission, motionLive: now() - motionAt < 3000, steps: stepDet.count, stepLengthM: fuser.stepLengthM } : { enabled: false },
      location: { ...location, help: location.coarse ? F.preciseLocationHelp(typeof navigator !== 'undefined' ? navigator.userAgent : '') : null },
      heading, pitch, headingSource, compassPermission, compassAccuracy,
      echoesCount: ranked.length, pollError, pingCount,
      target: t && {
        id: t.id, distanceM: t.distanceM, bearingDeg: t.bearingDeg, relativeDeg: rel,
        word: M.distanceWord(t.distanceM, o.unlockRadiusM), expiresAt: t.expiresAt, resonanceCount: t.resonanceCount,
        dropperHeadingDeg: t.headingDeg ?? null, altitudeM: t.altitudeM ?? null,
      },
      pingIntervalMs: tune ? null : (t ? M.pingIntervalMs(t.distanceM, o.ping) : null),
      tuning: tune && {
        id: tune.id, status: tune.status, alignment: tune.alignment ?? 0, errorDeg: tune.errorDeg ?? null,
        lockProgress: tune.lock?.progress ?? 0, locked: !!tune.lock?.locked,
        canResonate: tune.canResonate, resonated: tune.resonated, error: tune.error || null,
      },
      capabilities: { ...caps },
    };
  }
  function emit(force = false) {
    const t = now();
    if (!force && t - lastEmit < o.stateThrottleMs) {
      if (!emitTimer) emitTimer = setTimeout(() => { emitTimer = null; emit(true); }, o.stateThrottleMs);
      return;
    }
    lastEmit = t;
    try { onState(snapshot()); } catch (e) { console.error('[hunt] onState threw', e); }
  }
  const setStatus = (s) => { status = s; emit(true); };

  // ------------------------------------------------------------ audio (created/resumed only inside the start() gesture)
  function ensureAudio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio not supported');
      ctx = new AC({ latencyHint: 'interactive' });
      const master = ctx.createDynamicsCompressor();
      master.threshold.value = -14; master.ratio.value = 4;
      master.connect(ctx.destination);
      // sonar bus: dry + feedback delay ("underwater" tail)
      const pingBus = ctx.createGain(); pingBus.gain.value = o.pingVolume;
      const delay = ctx.createDelay(1); delay.delayTime.value = 0.19;
      const fb = ctx.createGain(); fb.gain.value = 0.38;
      const fbLp = ctx.createBiquadFilter(); fbLp.type = 'lowpass'; fbLp.frequency.value = 2200;
      const wet = ctx.createGain(); wet.gain.value = 0.5;
      pingBus.connect(master); pingBus.connect(delay); delay.connect(fbLp); fbLp.connect(fb); fb.connect(delay); fbLp.connect(wet); wet.connect(master);
      audio = { master, pingBus, noiseBuffer: makeNoiseBuffer(ctx) };
    }
    // iOS: play a 1-sample silent buffer inside the gesture to fully unlock output
    try { const b = ctx.createBuffer(1, 1, ctx.sampleRate), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch {}
    // iOS 17+: let Web Audio play even with the ring/silent switch on
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    return ctx.state === 'running' ? Promise.resolve() : ctx.resume();
  }

  function makeNoiseBuffer(c) {
    // 2 s of "radio static": white noise + sparse crackle, looped
    const len = c.sampleRate * 2, b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0);
    let pink = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      pink = 0.97 * pink + 0.03 * w;
      d[i] = 0.55 * w + 1.8 * pink + (Math.random() < 0.0009 ? (Math.random() * 2 - 1) * 0.9 : 0);
    }
    return b;
  }

  function playPing(distM) {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.005, f = M.pingFrequency(distM, o.ping);
    const osc = ctx.createOscillator(), osc2 = ctx.createOscillator(), env = ctx.createGain(), env2 = ctx.createGain();
    osc.type = 'sine'; osc2.type = 'sine';
    osc.frequency.setValueAtTime(f, t); osc.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.2);
    osc2.frequency.setValueAtTime(f * 2.01, t); osc2.frequency.exponentialRampToValueAtTime(f * 1.1, t + 0.12);
    env.gain.setValueAtTime(0.0001, t); env.gain.exponentialRampToValueAtTime(0.9, t + 0.006); env.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    env2.gain.setValueAtTime(0.0001, t); env2.gain.exponentialRampToValueAtTime(0.18, t + 0.004); env2.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    let out = env;
    const rel = target && heading != null ? M.relativeAngle(target.bearingDeg, heading) : null;
    if (o.pingPan && rel != null && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner(); p.pan.value = M.stereoPan(rel);
      // behind you: a touch quieter and duller so front/back is distinguishable on headphones
      const back = ctx.createGain(); back.gain.value = Math.abs(rel) > 100 ? 0.6 : 1;
      env.connect(back); back.connect(p); out = p;
    }
    osc.connect(env); osc2.connect(env2); env2.connect(env);
    out.connect(audio.pingBus);
    osc.start(t); osc2.start(t); osc.stop(t + 0.45); osc2.stop(t + 0.15);
    osc.onended = () => { try { out.disconnect(); env.disconnect(); } catch {} };
  }

  function vibrate(pattern) {
    if (o.vibrate && caps.vibrate) { try { navigator.vibrate(pattern); } catch {} }
  }

  // ------------------------------------------------------------ sonar scheduler (50 ms tick so rate changes apply immediately)
  function pingTick() {
    clearTimeout(pingTimer);
    if (!running) return;
    pingTimer = setTimeout(pingTick, 50);
    if (hidden || tune || !target) return;
    const iv = M.pingIntervalMs(target.distanceM, o.ping);
    if (iv == null) return;
    const t = now();
    if (t - lastPingAt >= iv) {
      lastPingAt = t; pingCount++;
      playPing(target.distanceM);
      vibrate(target.distanceM < 30 ? 18 : 30);
      try { onPing({ intervalMs: iv, distanceM: target.distanceM, word: M.distanceWord(target.distanceM, o.unlockRadiusM), count: pingCount }); } catch {}
    }
  }

  // ------------------------------------------------------------ compass
  function requestCompassPermission() {
    // MUST be invoked synchronously inside the user gesture on iOS 13+.
    if (!o.useDeviceCompass) return Promise.resolve('skipped');
    if (caps.orientationNeedsPermission) {
      try { return DeviceOrientationEvent.requestPermission().catch(() => 'denied'); } catch { return Promise.resolve('denied'); }
    }
    return Promise.resolve(caps.orientation ? 'granted' : 'unsupported');
  }

  function acceptHeading(h, src, p) {
    if (!Number.isFinite(h)) return;
    heading = M.smoothAngle(heading, h, headingSource === src ? o.headingSmoothing : 1);
    headingSource = src; headingAt = now();
    if (p != null && Number.isFinite(p)) pitch = pitch == null ? p : pitch + o.headingSmoothing * (p - pitch);
    onOrientationChanged();
  }

  function onAbsoluteOrientation(e) {   // Android Chrome: deviceorientationabsolute (alpha referenced to north)
    if (e.alpha == null) return;
    acceptHeading(M.headingFromEuler(e.alpha, e.beta, e.gamma, readScreenAngle()), 'compass', M.pitchFromBeta(e.beta));
  }
  function onOrientation(e) {
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) { // iOS Safari
      compassAccuracy = e.webkitCompassAccuracy ?? null;
      acceptHeading(M.headingFromWebkit(e.webkitCompassHeading, readScreenAngle()), 'compass', M.pitchFromBeta(e.beta));
    } else if (e.absolute === true && e.alpha != null) { // Firefox Android / others that mark absolute
      acceptHeading(M.headingFromEuler(e.alpha, e.beta, e.gamma, readScreenAngle()), 'compass', M.pitchFromBeta(e.beta));
    } else if (e.beta != null) {
      // relative alpha is useless for north, but beta still gives pitch
      pitch = M.pitchFromBeta(e.beta);
    }
  }
  function attachCompass() {
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onAbsoluteOrientation);
    else window.addEventListener('deviceorientation', onOrientation);
    clearTimeout(compassTimer);
    compassTimer = setTimeout(() => { if (headingSource !== 'compass') { headingSource = gpsCourse != null ? 'gps-course' : 'none'; emit(true); } }, o.noCompassTimeoutMs);
  }
  function detachCompass() {
    window.removeEventListener('deviceorientationabsolute', onAbsoluteOrientation);
    window.removeEventListener('deviceorientation', onOrientation);
    clearTimeout(compassTimer);
  }
  // ------------------------------------------------------------ motion (step detection for dead reckoning)
  function requestMotionPermission() {
    // iOS 13+: MUST be called synchronously inside the same user gesture as the orientation request.
    if (!fuser || !o.useDeviceMotion) return Promise.resolve('skipped');
    if (caps.motionNeedsPermission) {
      try { return DeviceMotionEvent.requestPermission().catch(() => 'denied'); } catch { return Promise.resolve('denied'); }
    }
    return Promise.resolve(caps.motion ? 'granted' : 'unsupported');
  }
  function stepHeading() {
    if (heading != null && now() - headingAt < 2500) return heading;   // compass (or recent GPS course)
    return null;
  }
  function onStep(t = now()) {
    if (!fuser) return;
    const r = fuser.step(t, stepHeading());
    if (r && r.propagated && pos) {
      pos = { ...pos, lat: r.lat, lng: r.lng, accuracy: r.accuracy, source: 'fused', at: t };
      recompute();
    }
  }
  function onMotionSample(mag, t = now()) {
    motionAt = t;
    if (stepDet.push(t, mag)) onStep(t);
    else if (fuser && t - lastAlive > 1000) { lastAlive = t; fuser.motionAlive(t); }
  }
  let lastAlive = 0;
  function onDeviceMotion(e) { onMotionSample(F.motionMagnitude(e)); }
  function attachMotion() { window.addEventListener('devicemotion', onDeviceMotion); }
  function detachMotion() { window.removeEventListener('devicemotion', onDeviceMotion); }

  // If the compass is silent (desktop, denied, broken), use GPS course over ground while walking.
  function maybeUseGpsCourse() {
    if (gpsCourse == null) return;
    if (headingSource === 'compass' && now() - headingAt < 2000) return;
    heading = M.smoothAngle(headingSource === 'gps-course' ? heading : null, gpsCourse, 0.5);
    headingSource = 'gps-course'; headingAt = now();
  }

  // ------------------------------------------------------------ geolocation
  function onFix(p, raw = false) {
    const c = p.coords;
    let r;
    const ts = now(); // one clock for GPS + steps (p.timestamp can be stale/cached on iOS)
    lastRawFix = p; clearTimeout(firstFixTimer);
    if (o.coarseCheck) {
      recentFixes.push({ lat: c.latitude, lng: c.longitude, accuracy: c.accuracy ?? 999 }); if (recentFixes.length > 6) recentFixes.shift();
      const prev = location.coarse; location = F.detectCoarse(recentFixes);
      if (location.coarse !== prev) emit(true);
    }
    if (raw) {
      r = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy ?? 5, accepted: true, lowConfidence: (c.accuracy ?? 5) > o.maxAccuracyM };
      gps.reset(); gps.process(c.latitude, c.longitude, c.accuracy ?? 5, ts);
      if (fuser) { fuser.reset(); fuser.gps({ lat: c.latitude, lng: c.longitude, accuracy: c.accuracy ?? 5, timestamp: ts }); }
    } else if (fuser) {
      r = fuser.gps({ lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, timestamp: ts });
      if (r && r.lowConfidence == null) r.lowConfidence = (c.accuracy ?? 999) > o.maxAccuracyM;
    } else r = gps.process(c.latitude, c.longitude, c.accuracy, ts);
    if (!r || !r.accepted) { if (pos) { pos.lowConfidence = true; pos.rawAccuracy = c.accuracy; } emit(); return; }
    pos = { lat: r.lat, lng: r.lng, accuracy: r.accuracy, rawAccuracy: c.accuracy, altitude: c.altitude ?? pos?.altitude ?? null, lowConfidence: !!r.lowConfidence, at: ts, source: fuser ? 'fused' : 'gps' };
    if (Number.isFinite(c.heading) && (c.speed ?? 0) > 0.7) { gpsCourse = c.heading; maybeUseGpsCourse(); }
    if (status === 'locating') setStatus('searching');
    recompute();
    maybePoll();
  }
  function onGeoError(err) {
    error = err.code === 1 ? 'location-denied' : err.code === 3 ? 'location-timeout' : 'location-unavailable';
    if (err.code === 1) setStatus('error');
    else { if (!pos) firstFixFallback(); emit(true); }
  }
  // Single-reading fix (Cooker's bug): watchPosition with maximumAge 0 may never fire on a stationary phone
  // indoors (the OS already handed its one reading to another watcher, e.g. app.js's map). After
  // firstFixTimeoutMs, accept any cached reading; flagged lowConfidence when older than 10 s.
  function firstFixFallback() {
    if (!running || pos || !o.useDeviceGeolocation || !caps.geolocation) return;
    if (lastRawFix) { onFix(lastRawFix); return; }
    try {
      navigator.geolocation.getCurrentPosition(p => {
        if (!running || pos) return;
        onFix(p);
        if (pos && p.timestamp && Date.now() - p.timestamp > 10000) { pos.lowConfidence = true; emit(true); }
      }, () => {}, { enableHighAccuracy: false, maximumAge: o.fallbackMaxAgeMs, timeout: 10000 });
    } catch {}
  }

  // ------------------------------------------------------------ polling the source
  function maybePoll() {
    if (!running || polling || !pos || !M.shouldPoll(lastPoll, pos, now(), { intervalMs: o.pollIntervalMs, moveM: o.pollMoveM })) return;
    polling = true;
    const at = { lat: pos.lat, lng: pos.lng, at: now() };
    Promise.resolve(source.nearby({ lat: pos.lat, lng: pos.lng, radiusM: o.searchRadiusM, accuracyM: pos.accuracy, altitudeM: pos.altitude }))
      .then(list => { echoes = Array.isArray(list) ? list : []; pollError = null; lastPoll = at; recompute(); })
      .catch(e => { pollError = String(e?.message || e); lastPoll = { ...at, at: at.at - o.pollIntervalMs / 2 }; emit(true); }) // retry sooner
      .finally(() => { polling = false; });
  }

  // ------------------------------------------------------------ targeting + mode transitions
  function recompute() {
    if (!pos) return;
    ranked = M.rankEchoes(echoes, pos);
    target = ranked[0] || null;
    if (status === 'searching' && target) status = 'tracking';
    if (status === 'tracking' && !target) status = 'searching';
    if (tune) {
      const cur = ranked.find(e => e.id === tune.id);
      if (!cur || cur.distanceM > o.unlockRadiusM * o.unlockExitFactor) exitTune();
      else target = cur; // stay on the tuned echo even if another becomes marginally nearer
    }
    if (!tune && target && target.distanceM <= o.unlockRadiusM && !(target.id === lastFailed.id && now() - lastFailed.at < 8000)) enterTune(target);
    onOrientationChanged();
    emit();
  }

  // ------------------------------------------------------------ tune-in
  let lastFailed = { id: null, at: 0 };
  async function enterTune(echo) {
    const token = (tune = { id: echo.id, status: 'unlocking', lock: null, canResonate: false, resonated: false, alignment: 0 });
    setStatus('tuning');
    vibrate([40, 60, 40]);
    try {
      let buf = bufferCache.get(echo.id);
      if (!buf) {
        const url = await source.unlock(echo.id, { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracy });
        if (tune !== token) return;
        buf = await loadAudio(url);
        bufferCache.set(echo.id, buf);
      }
      if (tune !== token) return;
      token.graph = buildTuneGraph(buf);
      token.status = 'playing';
      onOrientationChanged();
      emit(true);
    } catch (e) {
      if (tune !== token) return;
      console.warn('[hunt] unlock failed', e);
      lastFailed = { id: echo.id, at: now() };
      tune = null; error = 'unlock-failed: ' + (e?.message || e);
      setStatus(target ? 'tracking' : 'searching');
    }
  }

  async function loadAudio(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`audio ${res.status}`);
    const ab = await res.arrayBuffer();
    try {
      return await new Promise((ok, bad) => { const p = ctx.decodeAudioData(ab, ok, bad); if (p && p.then) p.then(ok, bad); });
    } catch (e) {
      // Some containers (e.g. webm/opus on older iOS) won't decodeAudioData; fall back to a media element
      return { mediaUrl: url };
    }
  }

  function buildTuneGraph(buf) {
    const g = {};
    if (buf.mediaUrl) {
      g.el = new Audio(); g.el.crossOrigin = 'anonymous'; g.el.loop = true; g.el.src = buf.mediaUrl; g.el.setAttribute('playsinline', '');
      g.src = ctx.createMediaElementSource(g.el); g.el.play().catch(() => {});
    } else {
      g.src = ctx.createBufferSource(); g.src.buffer = buf; g.src.loop = true;
    }
    g.lp = ctx.createBiquadFilter(); g.lp.type = 'lowpass'; g.lp.Q.value = 0.9; g.lp.frequency.value = o.tune.minCutoffHz;
    g.sig = ctx.createGain(); g.sig.gain.value = 0.2;
    g.panner = ctx.createPanner();
    try { g.panner.panningModel = 'HRTF'; } catch { caps.hrtf = false; }
    g.panner.distanceModel = 'linear'; g.panner.rolloffFactor = 0; g.panner.refDistance = 1;
    g.noise = ctx.createBufferSource(); g.noise.buffer = audio.noiseBuffer; g.noise.loop = true;
    g.bp = ctx.createBiquadFilter(); g.bp.type = 'bandpass'; g.bp.frequency.value = 2400; g.bp.Q.value = 0.7;
    g.ngain = ctx.createGain(); g.ngain.gain.value = o.tune.maxNoise;
    g.lfo = ctx.createOscillator(); g.lfo.frequency.value = 0.35; g.lfoGain = ctx.createGain(); g.lfoGain.gain.value = 600;
    g.out = ctx.createGain(); g.out.gain.setValueAtTime(0.0001, ctx.currentTime); g.out.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 1.2);
    g.src.connect(g.lp); g.lp.connect(g.sig); g.sig.connect(g.panner); g.panner.connect(g.out);
    g.noise.connect(g.bp); g.bp.connect(g.ngain); g.ngain.connect(g.out);   // static is "in the radio", not spatialised
    g.lfo.connect(g.lfoGain); g.lfoGain.connect(g.lp.detune);
    g.out.connect(audio.master);
    if (g.src.start) g.src.start(); g.noise.start(); g.lfo.start();
    return g;
  }

  function setParam(param, v, tc = 0.08) { try { param.setTargetAtTime(v, ctx.currentTime, tc); } catch { param.value = v; } }

  function setPannerPos(p, { x, y, z }) {
    if (p.positionX) { setParam(p.positionX, x, 0.05); setParam(p.positionY, y, 0.05); setParam(p.positionZ, z, 0.05); }
    else p.setPosition(x, y, z);
  }

  function onOrientationChanged() {
    if (!tune || !target || !pos) { emit(); return; }
    let errDeg, rel = 0, elev = 0;
    if (heading != null) {
      rel = M.relativeAngle(target.bearingDeg, heading);
      const canElev = o.useElevation && target.altitudeM != null && pos.altitude != null && pitch != null;
      elev = canElev ? M.elevationAngle(target.altitudeM - pos.altitude, target.distanceM) : 0;
      errDeg = M.pointingError(rel, canElev ? pitch : 0, elev);
      tune.alignment = M.alignment(errDeg);
    } else {
      // no heading at all: clarity just grows as you close in
      errDeg = null;
      tune.alignment = M.clamp(1 - target.distanceM / o.unlockRadiusM, 0.15, 1);
    }
    tune.errorDeg = errDeg;
    const prevLocked = tune.lock?.locked;
    tune.lock = M.updateLock(tune.lock, errDeg ?? (tune.alignment > 0.9 ? 0 : 180), now(), { lockDeg: o.alignLockDeg, releaseDeg: o.alignReleaseDeg, holdMs: o.alignHoldMs });
    if (tune.lock.locked && !prevLocked) { tune.canResonate = true; vibrate([25, 35, 25, 35, 80]); }
    const g = tune.graph;
    if (g) {
      const p = M.tuneParams(tune.alignment, o.tune);
      const nearFactor = 0.6 + 0.4 * M.clamp(target.distanceM / o.unlockRadiusM);
      setParam(g.lp.frequency, p.cutoffHz); setParam(g.sig.gain, p.signalGain);
      setParam(g.ngain.gain, p.noiseGain * nearFactor); setParam(g.lfoGain.gain, p.wobbleCents, 0.3);
      setPannerPos(g.panner, M.pannerPosition(heading != null ? rel : 0, elev - (pitch != null && elev ? pitch : 0)));
    }
    emit();
  }

  function exitTune() {
    const t = tune; tune = null;
    if (t?.graph) {
      const g = t.graph;
      try { g.out.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.25); } catch {}
      setTimeout(() => { try { g.src.stop?.(); g.noise.stop(); g.lfo.stop(); g.el?.pause(); g.out.disconnect(); } catch {} }, 1200);
    }
    if (running) status = target ? 'tracking' : 'searching';
    emit(true);
  }

  // ------------------------------------------------------------ wake lock + visibility
  async function acquireWakeLock() {
    if (!o.wakeLock || !caps.wakeLock || document.visibilityState !== 'visible') return;
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener?.('release', () => { wakeLock = null; }); } catch {}
  }
  function onVisibility() {
    hidden = document.visibilityState !== 'visible';
    if (!running) return;
    if (hidden) { ctx?.suspend().catch(() => {}); }
    else {
      acquireWakeLock();
      ctx?.resume().then(() => { needsTap = ctx.state !== 'running'; emit(true); }, () => { needsTap = true; emit(true); });
      maybePoll();
    }
  }

  // ------------------------------------------------------------ public API
  async function start() {
    if (running) return;
    running = true; error = null; clearTimeout(suspendTimer); setStatus('starting');
    // --- everything gesture-bound happens synchronously, BEFORE the first await ---
    let audioP;
    try { audioP = ensureAudio(); } catch (e) { running = false; error = e.message; setStatus('error'); throw e; }
    const permP = requestCompassPermission();
    const motionP = requestMotionPermission();     // same gesture, same tick (iOS)
    // -------------------------------------------------------------------------------
    document.addEventListener('visibilitychange', onVisibility);
    hidden = document.visibilityState !== 'visible';
    acquireWakeLock();
    try { await audioP; } catch {}
    needsTap = ctx.state !== 'running';
    compassPermission = await permP;
    motionPermission = await motionP;
    if (fuser && o.useDeviceMotion && motionPermission !== 'unsupported' && motionPermission !== 'skipped') attachMotion();
    // Attach even if the permission API said no: some Chromium builds expose requestPermission() but still
    // deliver events. If nothing arrives within noCompassTimeoutMs we fall back (GPS course / distance-only).
    if (o.useDeviceCompass && compassPermission !== 'unsupported') attachCompass();
    else headingSource = 'none';
    status = 'locating';
    if (o.useDeviceGeolocation) {
      if (!caps.geolocation) { error = 'no-geolocation'; setStatus('error'); return; }
      geoWatch = navigator.geolocation.watchPosition(p => onFix(p), onGeoError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
      clearTimeout(firstFixTimer);
      firstFixTimer = setTimeout(firstFixFallback, o.firstFixTimeoutMs);
    }
    if (o.initialFix && !pos) seedFix(o.initialFix);
    pollTimer = setInterval(maybePoll, 1000);
    pingTick();
    emit(true);
  }

  function stop() {
    if (!running) return;
    running = false;
    if (geoWatch != null) navigator.geolocation.clearWatch(geoWatch);
    geoWatch = null;
    detachCompass(); detachMotion(); clearInterval(pollTimer); clearTimeout(firstFixTimer); clearTimeout(pingTimer); clearTimeout(emitTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    if (tune) exitTune();
    wakeLock?.release().catch(() => {}); wakeLock = null;
    suspendTimer = setTimeout(() => ctx?.suspend().catch(() => {}), 1300); // keep the context (iOS lets us reuse it without a new gesture)
    setStatus('stopped');
  }

  async function resonate() {
    if (!tune?.canResonate || tune.resonated) throw new Error('not tuned in');
    if (typeof source.resonate !== 'function') throw new Error('source has no resonate()');
    const res = await source.resonate(tune.id, { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracy });
    tune.resonated = true;
    vibrate([60, 40, 120]);
    if (res && typeof res === 'object') {
      const e = echoes.find(x => x.id === tune.id);
      if (e) { if (res.expiresAt) e.expiresAt = res.expiresAt; if (Number.isFinite(res.resonanceCount)) e.resonanceCount = res.resonanceCount; }
    }
    recompute(); emit(true);
    return res;
  }

  /** Call from a tap if state.needsTap (iOS sometimes refuses resume() without a gesture after backgrounding). */
  function resumeAudio() { const p = ensureAudio(); p.then(() => { needsTap = false; emit(true); }).catch(() => {}); return p; }

  /** Desk mode / tests: feed a position. raw=true bypasses the Kalman filter. */
  function injectPosition({ lat, lng, accuracy = 5, altitude = null, heading: course = null, speed = null }, { raw = true } = {}) {
    onFix({ coords: { latitude: lat, longitude: lng, accuracy, altitude, heading: course, speed }, timestamp: now() }, raw);
  }
  /** Desk mode / tests: feed a compass heading (deg from north) and optional pitch (deg above horizon). */
  function injectHeading(deg, pitchDeg = null) {
    heading = M.normDeg(deg); headingSource = 'compass'; headingAt = now();
    if (pitchDeg != null) pitch = pitchDeg;
    clearTimeout(compassTimer);
    onOrientationChanged();
  }

  /** Seed/correct the position with a precise-fix result (Cooker's or trax's preciseFix(), or a GeolocationPosition). */
  function seedFix(fix) {
    const f = F.normalizeFix(fix); if (!f) return false;
    onFix({ coords: { latitude: f.lat, longitude: f.lng, accuracy: f.accuracy, altitude: f.altitude, heading: null, speed: null }, timestamp: f.timestamp });
    return true;
  }
  /** Tests / desk mode: one step in the current heading (or headingDeg). */
  function injectStep(headingDeg) {
    if (headingDeg != null) { heading = M.normDeg(headingDeg); headingAt = now(); if (headingSource === 'none') headingSource = 'compass'; }
    motionAt = now(); onStep(now());
  }
  /** Tests: feed one accelerometer magnitude sample (m/s^2) through the real step detector. */
  function injectMotion(mag, t = now()) { onMotionSample(mag, t); }

  return {
    start, stop, resonate, resumeAudio, injectPosition, injectHeading, seedFix, injectStep, injectMotion,
    getState: snapshot,
    /** Current tune-in audio parameters (debug/tests). null when not playing. */
    debugAudio() {
      const g = tune?.graph; if (!g) return null;
      return { mode: g.el ? 'media-element' : 'buffer', cutoffHz: g.lp.frequency.value, signalGain: g.sig.gain.value, noiseGain: g.ngain.gain.value,
        panner: g.panner.positionX ? [g.panner.positionX.value, g.panner.positionY.value, g.panner.positionZ.value] : null, panningModel: g.panner.panningModel };
    },
    get audioContext() { return ctx; },
    get options() { return o; },
  };
}
