// Record-and-drop screen. Self-contained: owns its markup (TEMPLATE), styles (css/record.css) and logic.
// Mount with: mountRecordScreen(containerEl). Swap-out friendly: the only dependency is js/echo-store.js.
//
// Flow: [Enable tap] -> mic + GPS + compass permissions (all from that tap)
//       -> hold (or tap start/stop) the big button, max 30 s, live level meter
//       -> preview / re-record -> "Drop here" -> confirmation (lat/lng/accuracy/expiry).

import { dropEcho } from './echo-store.js';
import { MAX_RECORD_MS, GPS_GOOD_ACCURACY_M } from './config.js';
import { preciseFix, placeLabel } from './precise-fix.js';

const RING_R = 92;
const RING_C = 2 * Math.PI * RING_R;
const TAP_THRESHOLD_MS = 350; // press shorter than this = tap mode (tap again to stop)
const MIN_CLIP_MS = 500;

const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const TEMPLATE = `
<div class="rec" data-phase="gate">
  <header class="rec-top">
    <button class="icon-btn" data-close aria-label="Close">${ICON_CLOSE}</button>
    <div class="rec-status">
      <span class="pill" data-gps>GPS off</span>
      <span class="pill" data-compass>Compass off</span>
    </div>
  </header>

  <div class="rec-gate" data-gate>
    <div class="rec-logo" aria-hidden="true"><span></span><span></span><span></span><i></i></div>
    <p class="eyebrow">New echo</p>
    <h1>Leave your voice here</h1>
    <p class="lede">Up to 30 seconds, pinned exactly where you stand. Everyone sees the pin on the map. Only people who walk here can hear it.</p>
    <button class="btn primary big" data-enable>Enable mic &amp; location</button>
    <p class="err" data-gate-err role="alert"></p>
  </div>

  <div class="rec-main" data-main hidden>
    <div class="rec-timer" data-timer>0.0<small> / ${MAX_RECORD_MS / 1000} s</small></div>
    <div class="meter" aria-hidden="true"><div class="meter-fill" data-meter></div></div>

    <button class="rec-btn" data-rec aria-label="Hold to record">
      <span class="rec-aura" aria-hidden="true"></span>
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <circle class="ring-bg" cx="100" cy="100" r="${RING_R}"/>
        <circle class="ring-fg" data-ring cx="100" cy="100" r="${RING_R}"
          stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}" transform="rotate(-90 100 100)"/>
      </svg>
      <span class="rec-core"></span>
    </button>
    <p class="hint" data-hint>Hold to record &middot; or tap to start, tap to stop</p>

    <div class="review" data-review hidden>
      <audio controls preload="auto" data-audio aria-label="Your recording"></audio>
      <label class="blur-toggle">
        <input type="checkbox" role="switch" data-blur aria-describedby="blur-help">
        <span class="switch" aria-hidden="true"></span>
        <span class="blur-text"><strong>Blur my spot</strong><small id="blur-help">Show a 30–60 m glow instead of the exact pin</small></span>
      </label>
      <div class="row">
        <button class="btn" data-rerecord>Re-record</button>
        <button class="btn primary" data-drop disabled>Waiting for GPS&hellip;</button>
      </div>
      <p class="warn" data-warn role="status"></p>
    </div>
  </div>

  <div class="rec-confirm" data-confirm hidden>
    <div class="ripple" aria-hidden="true"><span></span><span></span><span></span></div>
    <p class="eyebrow" data-c-eyebrow>Dropped</p>
    <h2 data-c-title>Your echo is out there</h2>
    <p class="lede" data-c-source></p>
    <dl>
      <dt>Near</dt><dd data-c-place></dd>
      <dt>Position</dt><dd><span data-c-lat></span>, <span data-c-lng></span></dd>
      <dt>Accuracy</dt><dd data-c-acc></dd>
      <dt>Heading</dt><dd data-c-heading></dd>
      <dt>Fades</dt><dd data-c-exp></dd>
    </dl>
    <p class="muted small" data-c-note>It fades in 24 h unless listeners resonate with it.</p>
    <div class="row">
      <button class="btn" data-another>Record another</button>
      <button class="btn primary" data-see>See it on the map</button>
    </div>
  </div>
</div>`;

/**
 * Choose a MediaRecorder mimeType. MP4/AAC is preferred on EVERY platform whenever supported, because older
 * iPhones (pre-iOS 17) can't decode webm/opus when someone else's echo is played back:
 *   1. explicit AAC in MP4 (Safari; Chrome/Android 126+ with proprietary codecs)
 *   2. plain audio/mp4 (Safari gives AAC; some Chromium builds give Opus-in-MP4, still better for iOS 17+ than webm)
 *   3. webm/opus, then ogg (older Chrome/Firefox)
 * Returns '' to let the browser choose, or null when MediaRecorder is missing.
 */
export const MIME_PREFERENCE = [
  'audio/mp4;codecs=mp4a.40.2', 'audio/mp4;codecs=aac', 'audio/aac', 'audio/mp4',
  'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg',
];
export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of MIME_PREFERENCE) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* ignore */ }
  }
  return ''; // let the browser choose
}

/** mountRecordScreen(root, { onClose, onDropped, autoStart, onToast }). autoStart: call it inside a tap to skip the gate. */
export function mountRecordScreen(root, { onClose = () => {}, onDropped = () => {}, autoStart = false, onToast = () => {} } = {}) {
  root.innerHTML = TEMPLATE;
  const $ = (s) => root.querySelector(s);
  const el = {
    wrap: $('.rec'), gps: $('[data-gps]'), compass: $('[data-compass]'),
    gate: $('[data-gate]'), enable: $('[data-enable]'), gateErr: $('[data-gate-err]'),
    main: $('[data-main]'), timer: $('[data-timer]'), meter: $('[data-meter]'),
    rec: $('[data-rec]'), ring: $('[data-ring]'), hint: $('[data-hint]'),
    review: $('[data-review]'), audio: $('[data-audio]'), rerecord: $('[data-rerecord]'),
    drop: $('[data-drop]'), warn: $('[data-warn]'), blur: $('[data-blur]'),
    confirm: $('[data-confirm]'), another: $('[data-another]'), close: $('[data-close]'), see: $('[data-see]'),
  };
  let lastEcho = null, lastFix = null;

  const s = {
    phase: 'gate', stream: null, mimeType: null, recorder: null, chunks: [],
    blob: null, blobUrl: null, durationMs: 0, startTs: 0, downTs: 0, tapMode: false,
    audioCtx: null, analyser: null, levelBuf: null, raf: 0,
    fix: null, watchId: null, heading: null, dropping: false,
  };

  const setPhase = (p) => {
    s.phase = p;
    el.wrap.dataset.phase = p;
    el.gate.hidden = p !== 'gate';
    el.main.hidden = !['ready', 'recording', 'review'].includes(p);
    el.review.hidden = p !== 'review';
    el.confirm.hidden = p !== 'dropped';
    el.rec.disabled = p === 'review';
    el.rec.setAttribute('aria-pressed', String(p === 'recording'));
    if (p === 'ready') {
      el.hint.textContent = 'Hold to record \u00b7 or tap to start, tap to stop';
      setRing(0); setTimer(0);
    }
    if (p === 'recording') el.hint.textContent = s.tapMode ? 'Tap to stop' : 'Release to stop';
    if (p === 'review') el.hint.textContent = 'Listen back, then drop it here';
    updateDropButton();
  };

  // ---------------------------------------------------------------- permissions (from the Enable tap)
  el.enable.addEventListener('click', async () => {
    el.gateErr.textContent = '';
    el.enable.disabled = true;

    // 1) iOS compass permission MUST be requested synchronously inside the user gesture, before any await.
    let orientationP = Promise.resolve('not-required');
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      orientationP = DeviceOrientationEvent.requestPermission().catch(() => 'denied');
    }
    // 2) AudioContext created in the gesture so it is allowed to run (iOS/Chrome autoplay rules).
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      s.audioCtx = s.audioCtx || new AC();
      s.audioCtx.resume?.();
    } catch { /* meter is optional */ }
    // 3) Geolocation, high accuracy, continuous.
    startGeolocation();

    // 4) Microphone.
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot record audio (needs HTTPS + a modern browser).');
      if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is not supported in this browser.');
      s.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      s.mimeType = pickMimeType();
      setupMeter();
    } catch (err) {
      el.enable.disabled = false;
      el.gateErr.textContent = err?.name === 'NotAllowedError'
        ? 'Microphone permission was denied. Allow it in your browser settings and try again.'
        : `Microphone unavailable: ${err?.message || err}`;
      onToast(el.gateErr.textContent);
      return;
    }

    const orientation = await orientationP;
    if (orientation === 'granted' || orientation === 'not-required') startCompass();
    else setPill(el.compass, 'Compass denied', 'bad');

    setPhase('ready');
  });

  // ---------------------------------------------------------------- geolocation
  // Fixes come from this screen's own watch and from the map's watch (setFix), whichever is newer.
  function applyFix(pos) {
    const c = pos.coords;
    if (s.fix && pos.timestamp < s.fix.ts) return;
    s.fix = {
      lat: c.latitude, lng: c.longitude, accuracy: c.accuracy,
      altitude: Number.isFinite(c.altitude) ? c.altitude : null, ts: pos.timestamp,
    };
    const acc = Math.round(c.accuracy);
    setPill(el.gps, `GPS \u00b1${acc} m`, c.accuracy <= GPS_GOOD_ACCURACY_M ? 'good' : 'wait');
    updateDropButton();
  }

  function startGeolocation() {
    if (!('geolocation' in navigator)) { setPill(el.gps, 'No GPS', 'bad'); return; }
    if (s.watchId != null) return;
    setPill(el.gps, 'Locating\u2026', 'wait');
    s.watchId = navigator.geolocation.watchPosition(
      applyFix,
      (err) => {
        setPill(el.gps, err.code === 1 ? 'GPS denied' : 'GPS error', 'bad');
        if (err.code === 1) { navigator.geolocation.clearWatch(s.watchId); s.watchId = null; }
        updateDropButton(err.code === 1 ? 'Location permission denied \u2014 allow it to drop Echoes.' : null);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  }

  // ---------------------------------------------------------------- compass
  function startCompass() {
    const handler = (e) => {
      let h = null;
      if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;         // iOS
      else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;     // Android absolute
      if (h == null || Number.isNaN(h)) return;
      s.heading = h;
      setPill(el.compass, `${Math.round(h)}\u00b0 ${cardinal(h)}`, 'good');
    };
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', handler);
    window.addEventListener('deviceorientation', handler);
    setPill(el.compass, 'Compass\u2026', 'wait');
    setTimeout(() => { if (s.heading == null) setPill(el.compass, 'No compass', 'bad'); }, 4000);
  }

  // ---------------------------------------------------------------- level meter
  function setupMeter() {
    if (!s.audioCtx || !s.stream) return;
    try {
      const src = s.audioCtx.createMediaStreamSource(s.stream);
      s.analyser = s.audioCtx.createAnalyser();
      s.analyser.fftSize = 1024;
      s.levelBuf = new Float32Array(s.analyser.fftSize);
      src.connect(s.analyser); // not connected to destination: no feedback
    } catch { s.analyser = null; }
    cancelAnimationFrame(s.raf);
    const loop = () => {
      s.raf = requestAnimationFrame(loop);
      let level = 0;
      if (s.analyser && s.phase !== 'review') {
        s.analyser.getFloatTimeDomainData(s.levelBuf);
        let sum = 0;
        for (let i = 0; i < s.levelBuf.length; i++) sum += s.levelBuf[i] * s.levelBuf[i];
        const db = 20 * Math.log10(Math.sqrt(sum / s.levelBuf.length) || 1e-8);
        level = Math.min(1, Math.max(0, (db + 60) / 60)); // -60 dB .. 0 dB
      }
      el.meter.style.transform = `scaleX(${level.toFixed(3)})`;
      el.rec.style.setProperty('--level', level.toFixed(3));
      if (s.phase === 'recording') {
        const t = performance.now() - s.startTs;
        setRing(t / MAX_RECORD_MS); setTimer(t);
        if (t >= MAX_RECORD_MS) stopRecording();
      }
    };
    loop();
  }

  // ---------------------------------------------------------------- recording (hold or tap)
  el.rec.addEventListener('contextmenu', (e) => e.preventDefault());
  el.rec.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (s.phase === 'recording') { if (s.tapMode) stopRecording(); return; }
    if (s.phase !== 'ready') return;
    el.rec.setPointerCapture?.(e.pointerId);
    s.downTs = performance.now();
    s.tapMode = false;
    startRecording();
  });
  const onRelease = () => {
    if (s.phase !== 'recording' || s.tapMode) return;
    if (performance.now() - s.downTs < TAP_THRESHOLD_MS) { s.tapMode = true; el.hint.textContent = 'Tap to stop'; return; }
    stopRecording();
  };
  el.rec.addEventListener('pointerup', onRelease);
  el.rec.addEventListener('pointercancel', onRelease);
  el.rec.addEventListener('keydown', (e) => { // keyboard: Space/Enter toggles
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (s.phase === 'ready') { s.tapMode = true; startRecording(); } else if (s.phase === 'recording') stopRecording();
  });

  function startRecording() {
    if (!s.stream) return;
    clearClip();
    s.chunks = [];
    try {
      s.recorder = s.mimeType ? new MediaRecorder(s.stream, { mimeType: s.mimeType }) : new MediaRecorder(s.stream);
    } catch {
      s.recorder = new MediaRecorder(s.stream);
    }
    s.recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) s.chunks.push(ev.data); };
    s.recorder.onstop = onRecorderStop;
    s.audioCtx?.resume?.();
    s.recorder.start(250);
    s.startTs = performance.now();
    navigator.vibrate?.(15);
    setPhase('recording');
  }

  function stopRecording() {
    if (s.phase !== 'recording' || !s.recorder) return;
    s.durationMs = Math.min(MAX_RECORD_MS, performance.now() - s.startTs);
    s.phase = 'stopping';
    if (s.recorder.state !== 'inactive') s.recorder.stop();
    navigator.vibrate?.([10, 40, 10]);
  }

  function onRecorderStop() {
    const type = s.recorder.mimeType || s.mimeType || s.chunks[0]?.type || 'audio/webm';
    s.blob = new Blob(s.chunks, { type });
    s.chunks = [];
    if (s.durationMs < MIN_CLIP_MS || s.blob.size === 0) {
      clearClip();
      setPhase('ready');
      el.hint.textContent = 'Too short \u2014 hold a little longer';
      return;
    }
    s.blobUrl = URL.createObjectURL(s.blob);
    el.audio.src = s.blobUrl;
    setRing(s.durationMs / MAX_RECORD_MS);
    setTimer(s.durationMs);
    setPhase('review');
  }

  function clearClip() {
    if (s.blobUrl) URL.revokeObjectURL(s.blobUrl);
    s.blob = null; s.blobUrl = null; s.durationMs = 0;
    el.audio.removeAttribute('src'); el.audio.load?.();
  }

  el.rerecord.addEventListener('click', () => { el.audio.pause(); clearClip(); setPhase('ready'); });

  // ---------------------------------------------------------------- drop
  function updateDropButton(errMsg) {
    if (s.phase !== 'review') return;
    el.drop.classList.remove('warn');
    if (errMsg) { el.drop.disabled = true; el.drop.textContent = 'No location'; el.warn.textContent = errMsg; return; }
    if (s.dropping) { el.drop.disabled = true; if (!s.locking) el.drop.textContent = 'Dropping\u2026'; return; }
    if (!s.fix) {
      el.drop.disabled = true;
      el.drop.textContent = 'Waiting for GPS\u2026';
      el.warn.textContent = 'Getting a precise location fix\u2026';
      return;
    }
    const acc = Math.round(s.fix.accuracy);
    el.drop.disabled = false;
    if (s.fix.accuracy > GPS_GOOD_ACCURACY_M) {
      el.drop.classList.add('warn');
      el.drop.textContent = `Drop anyway (\u00b1${acc} m)`;
      el.warn.textContent = `GPS is only accurate to \u00b1${acc} m. Wait a moment (ideally \u2264${GPS_GOOD_ACCURACY_M} m, step outside / away from buildings) or drop anyway.`;
    } else {
      el.drop.textContent = 'Drop here';
      el.warn.textContent = `Location locked \u00b7 \u00b1${acc} m`;
    }
  }

  el.drop.addEventListener('click', async () => {
    if (!s.blob || !s.fix || s.dropping) return;
    s.dropping = true; updateDropButton();
    // Precise lock (Cooker's precise-fix.js): 3–8 s of fresh fixes, weak ones and multipath jumps dropped,
    // accuracy-weighted average. Falls back to the live fix if the lock can't do better.
    let fix = s.fix;
    s.locking = true; el.drop.textContent = 'Locking position\u2026';
    el.warn.textContent = 'Hold still for a few seconds while we pin the exact spot.';
    // street label for the echo (stored as place_label after migration-v2); looked up in parallel with the lock
    const labelP = navigator.onLine === false ? Promise.resolve(null)
      : placeLabel({ lat: s.fix.lat, lng: s.fix.lng }).catch(() => null);
    try {
      const p = await preciseFix({ windowMs: 8000, targetM: 6, minSamples: 3, maxAccuracyM: 30, fallbackMs: 4000,
        seed: s.fix ? { lat: s.fix.lat, lng: s.fix.lng, accuracy: s.fix.accuracy, ts: s.fix.ts } : null,
        onProgress: (q) => { el.drop.textContent = `Locking \u00b1${q.accuracy} m \u00b7 ${q.samples} reading${q.samples === 1 ? '' : 's'}`; } });
      if (p && (!Number.isFinite(fix.accuracy) || p.accuracy <= fix.accuracy || p.samples >= 3)) {
        fix = { lat: p.lat, lng: p.lng, accuracy: p.accuracy, altitude: s.fix.altitude, ts: p.at, samples: p.samples,
          precise: !p.single, lowConfidence: Boolean(p.lowConfidence) };
      }
    } catch (e) { console.info('[record] precise lock unavailable, using live fix:', e.message); }
    s.locking = false;
    el.drop.textContent = 'Dropping\u2026';
    const place = await Promise.race([labelP, new Promise((r) => setTimeout(() => r(null), 1500))]);
    try {
      const echo = await dropEcho({
        blurred: el.blur.checked, placeLabel: place || null,
        blob: s.blob,
        mimeType: s.blob.type,
        durationMs: Math.round(s.durationMs),
        lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracy,
        heading: s.heading, altitude: fix.altitude,
      });
      navigator.vibrate?.([30, 60, 30, 60, 90]);
      lastFix = fix;
      showConfirmation(echo);
    } catch (err) {
      el.warn.textContent = `Couldn't drop: ${err?.friendly || err?.message || err}`;
      onToast(`Couldn’t drop: ${err?.friendly || err?.message || err}`);
    } finally {
      s.dropping = false; updateDropButton();
    }
  });

  function showConfirmation(echo) {
    root.querySelector('[data-c-lat]').textContent = echo.lat.toFixed(5);
    root.querySelector('[data-c-lng]').textContent = echo.lng.toFixed(5);
    root.querySelector('[data-c-acc]').textContent = (echo.accuracy_m != null ? `\u00b1${Math.round(echo.accuracy_m)} m` : 'unknown')
      + (lastFix?.precise ? ` \u00b7 locked from ${lastFix.samples} readings` : lastFix?.lowConfidence ? ' \u00b7 single reading (low confidence)' : '');
    const placeEl = root.querySelector('[data-c-place]');
    if (echo.place_label) placeEl.textContent = echo.place_label;
    else if (navigator.onLine === false) placeEl.textContent = 'Unnamed spot';
    else { placeEl.textContent = '\u2026'; placeLabel({ lat: echo.lat, lng: echo.lng }).then((l) => { placeEl.textContent = l || 'Unnamed spot'; }).catch(() => { placeEl.textContent = 'Unnamed spot'; }); }
    const q = Boolean(echo.queued);
    root.querySelector('[data-c-eyebrow]').textContent = q ? 'Queued' : 'Dropped';
    root.querySelector('[data-c-title]').textContent = q ? 'Queued, will upload' : 'Your echo is out there';
    root.querySelector('[data-c-note]').textContent = (echo.blurred
      ? 'Blurred: the map shows a 30\u201360 m glow around this spot, not the exact pin.'
      : 'The map shows an exact pin here.') + ' It fades in 24 h unless listeners resonate with it.';
    el.wrap.dataset.queued = q ? '1' : '';
    root.querySelector('[data-c-heading]').textContent = echo.heading != null ? `${Math.round(echo.heading)}\u00b0 ${cardinal(echo.heading)}` : 'n/a';
    const exp = new Date(echo.expires_at);
    root.querySelector('[data-c-exp]').textContent = exp.toLocaleString([], {
      weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
    root.querySelector('[data-c-source]').textContent = q
      ? 'No connection right now. It\u2019s saved on this phone and uploads by itself as soon as you\u2019re back online.'
      : echo.source === 'local'
        ? 'Saved on this device only for now: the shared map isn\u2019t reachable.' : 'It\u2019s on everyone\u2019s map now. Walk away and let someone find it.';
    lastEcho = echo;
    root.dataset.lastEchoId = echo.id;
    root.dataset.lastEchoSource = echo.source || '';
    el.audio.pause();
    clearClip();
    setPhase('dropped');
  }

  el.another.addEventListener('click', () => setPhase('ready'));
  el.see.addEventListener('click', () => onDropped(lastEcho));
  el.close.addEventListener('click', () => onClose());

  // ---------------------------------------------------------------- small helpers
  function setRing(frac) { el.ring.style.strokeDashoffset = String(RING_C * (1 - Math.min(1, Math.max(0, frac)))); }
  function setTimer(ms) { el.timer.firstChild.nodeValue = (ms / 1000).toFixed(1); }
  function setPill(node, text, state) { node.textContent = text; node.dataset.state = state; }

  setPhase('gate');
  if (autoStart) el.enable.click();   // still inside the opening tap: permissions + AudioContext are allowed

  return {
    /** feed a GeolocationPosition-like { coords, timestamp } from the host's own watch */
    setFix(pos) { if (pos?.coords && s.watchId != null) applyFix(pos); },
    // for the shell: release the mic when the screen is hidden for long, etc.
    destroy() {
      cancelAnimationFrame(s.raf);
      if (s.watchId != null) navigator.geolocation.clearWatch(s.watchId);
      s.stream?.getTracks().forEach((t) => t.stop());
      s.audioCtx?.close?.();
    },
  };
}

function cardinal(h) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(h / 45) % 8];
}
