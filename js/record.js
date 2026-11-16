// Record-and-drop screen. Self-contained: owns its markup (TEMPLATE), styles (css/record.css) and logic.
// Mount with: mountRecordScreen(containerEl). Swap-out friendly: the only dependency is js/echo-store.js.
//
// Flow: [Enable tap] -> mic + GPS + compass permissions (all from that tap)
//       -> hold (or tap start/stop) the big button, max 30 s, live level meter
//       -> preview / re-record -> "Drop here" -> confirmation (lat/lng/accuracy/expiry).

import * as store from './echo-store.js';
import { createLiveTranscript, capsulePresets, opensIn, canReplyHere, replyTo as replyToEcho, dropOnTrail } from './v2/index.js';
const { dropEcho } = store;
import { MAX_RECORD_MS, GPS_GOOD_ACCURACY_M } from './config.js';
import { preciseFix, placeLabel, distM } from './precise-fix.js';
import { STYLES } from './map.js';
import { haptic, spring } from './fx.js';
import { setDuration } from './opened.js';
import { resolvePlace, placeLabel as placeText, KIND_TO_DB, levelToInt, levelShort, ROAD_WARN } from './place.js';

const LOCK_WINDOW_MS = 15000;     // wait up to 15 s for a good fix
const LOCK_TARGET_M = 15;         // ... at or under 15 m
const SPOT_MAX_MOVE_M = 100;      // the confirm-your-spot pin can move this far from the fix, no more
const UNDO_MS = 5000;

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
    <p class="reply-banner" data-reply-banner hidden></p>
    <p class="transcript" data-transcript aria-live="polite" hidden></p>

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
      <div class="tags" data-tags aria-label="Tags" hidden></div>
      <fieldset class="capsule" data-capsule>
        <legend>Opens</legend>
        <div class="chips" role="radiogroup" aria-label="When this echo opens" data-capsule-chips></div>
        <small class="v2-hint" data-capsule-hint></small>
      </fieldset>
      <label class="blur-toggle" data-trail-row hidden>
        <input type="checkbox" role="switch" data-trail checked>
        <span class="switch" aria-hidden="true"></span>
        <span class="blur-text"><strong data-trail-name>Add to trail</strong><small>Becomes the next stop on your trail</small></span>
      </label>
      <div class="row">
        <button class="btn" data-rerecord>Re-record</button>
        <button class="btn primary" data-drop disabled>Waiting for GPS&hellip;</button>
      </div>
      <p class="warn" data-warn role="status"></p>
    </div>
  </div>

  <div class="rec-lock" data-lock hidden role="status" aria-live="polite">
    <div class="lock-meter" aria-hidden="true">
      <svg viewBox="0 0 200 200"><circle class="ring-bg" cx="100" cy="100" r="88"/>
        <circle class="lock-ring" data-lock-ring cx="100" cy="100" r="88" stroke-dasharray="553" stroke-dashoffset="553" transform="rotate(-90 100 100)"/></svg>
      <div class="lock-read"><strong data-lock-acc>…</strong><small data-lock-sub>finding you</small></div>
      <span class="lock-sweep"></span>
    </div>
    <p class="eyebrow">Locking your spot</p>
    <h2 data-lock-title>Hold still a moment</h2>
    <p class="lede" data-lock-note>Waiting for a reading within ${LOCK_TARGET_M} m. Near a window or outside is fastest.</p>
    <div class="row"><button class="btn" data-lock-cancel>Back</button><button class="btn" data-lock-skip hidden>Use best so far</button></div>
  </div>

  <div class="rec-spot" data-spot hidden>
    <p class="eyebrow">Confirm your spot</p>
    <h2 data-spot-title>Is the pin where you are?</h2>
    <div class="spot-map" data-spot-map role="application" aria-label="Map: drag the pin onto the exact spot where you are"></div>
    <div class="spot-place" data-spot-place>
      <span class="place-chip" data-place-chip data-kind="checking" aria-live="polite">Checking where you are…</span>
      <button class="btn small" data-place-snap hidden></button>
    </div>
    <p class="spot-warn" data-spot-warn role="alert" hidden></p>
    <fieldset class="floor" data-floor hidden>
      <legend>Which floor? <small>optional</small></legend>
      <div class="chips" role="radiogroup" aria-label="Floor" data-floor-chips></div>
    </fieldset>
    <p class="spot-note" data-spot-note role="status"></p>
    <div class="row">
      <button class="btn" data-spot-relock>Re-lock</button>
      <button class="btn primary" data-spot-ok>Drop here</button>
    </div>
  </div>

  <div class="rec-confirm" data-confirm hidden>
    <div class="ripple" aria-hidden="true"><span></span><span></span><span></span></div>
    <p class="eyebrow" data-c-eyebrow>Dropped</p>
    <h2 data-c-title>Your echo is out there</h2>
    <p class="lede" data-c-source></p>
    <dl>
      <dt>Where</dt><dd data-c-place></dd>
      <dt>Position</dt><dd><span data-c-lat></span>, <span data-c-lng></span></dd>
      <dt>Accuracy</dt><dd data-c-acc></dd>
      <dt>Heading</dt><dd data-c-heading></dd>
      <dt>Fades</dt><dd data-c-exp></dd>
    </dl>
    <p class="muted small" data-c-note>It fades in 24 h unless listeners resonate with it.</p>
    <button class="btn undo" data-undo hidden><span>Undo</span><i data-undo-n></i><b class="undo-bar" data-undo-bar></b></button>
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
export function mountRecordScreen(root, { onClose = () => {}, onDropped = () => {}, autoStart = false, onToast = () => {},
  replyTo = null, activeTrail = null, onHelp = () => {} } = {}) {
  const v2 = () => store.mapMode === 'map_echoes';
  root.innerHTML = TEMPLATE;
  const $ = (s) => root.querySelector(s);
  const el = {
    wrap: $('.rec'), gps: $('[data-gps]'), compass: $('[data-compass]'),
    gate: $('[data-gate]'), enable: $('[data-enable]'), gateErr: $('[data-gate-err]'),
    main: $('[data-main]'), timer: $('[data-timer]'), meter: $('[data-meter]'),
    rec: $('[data-rec]'), ring: $('[data-ring]'), hint: $('[data-hint]'),
    review: $('[data-review]'), audio: $('[data-audio]'), rerecord: $('[data-rerecord]'),
    drop: $('[data-drop]'), warn: $('[data-warn]'), blur: $('[data-blur]'),
    transcript: $('[data-transcript]'), tags: $('[data-tags]'), capsule: $('[data-capsule]'), chips: $('[data-capsule-chips]'),
    capsuleHint: $('[data-capsule-hint]'), trailRow: $('[data-trail-row]'), trail: $('[data-trail]'), trailName: $('[data-trail-name]'),
    replyBanner: $('[data-reply-banner]'),
    lock: $('[data-lock]'), lockRing: $('[data-lock-ring]'), lockAcc: $('[data-lock-acc]'), lockSub: $('[data-lock-sub]'),
    lockTitle: $('[data-lock-title]'), lockNote: $('[data-lock-note]'), lockCancel: $('[data-lock-cancel]'), lockSkip: $('[data-lock-skip]'),
    spot: $('[data-spot]'), spotMap: $('[data-spot-map]'), spotNote: $('[data-spot-note]'), spotTitle: $('[data-spot-title]'),
    spotOk: $('[data-spot-ok]'), spotRelock: $('[data-spot-relock]'),
    placeChip: $('[data-place-chip]'), snapBtn: $('[data-place-snap]'), spotWarn: $('[data-spot-warn]'), floor: $('[data-floor]'), floorChips: $('[data-floor-chips]'),
    undo: $('[data-undo]'), undoN: $('[data-undo-n]'), undoBar: $('[data-undo-bar]'),
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
    el.lock.hidden = p !== 'locking';
    el.spot.hidden = p !== 'spot';
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
      const denied = err?.name === 'NotAllowedError';
      el.gateErr.textContent = denied ? 'The microphone is blocked. ' : `Microphone unavailable: ${err?.message || err}. `;
      const fix = document.createElement('button'); fix.className = 'link-btn';
      fix.textContent = denied ? 'Show me how to allow it' : 'Try again';
      fix.addEventListener('click', () => (denied ? onHelp('mic') : el.enable.click()));
      el.gateErr.append(fix);
      el.enable.textContent = 'Try again';
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
    // live transcript + tags while recording (SpeechRecognition; silently absent where unsupported)
    s.transcript = null; s.tags = [];
    s.lt = createLiveTranscript({ onText: (t) => { el.transcript.hidden = !t; el.transcript.textContent = t; } });
    if (s.lt.supported) { el.transcript.hidden = false; el.transcript.textContent = 'Listening for words\u2026'; s.lt.start(); }
    s.startTs = performance.now();
    navigator.vibrate?.(15);
    setPhase('recording');
  }

  function stopRecording() {
    if (s.phase !== 'recording' || !s.recorder) return;
    s.durationMs = Math.min(MAX_RECORD_MS, performance.now() - s.startTs);
    s.phase = 'stopping';
    if (s.recorder.state !== 'inactive') s.recorder.stop();
    try { const r = s.lt?.stop({ caption: '' }) || {}; s.transcript = r.transcript || null; s.tags = r.tags || []; } catch { s.transcript = null; s.tags = []; }
    renderExtras();
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

  // ---------------------------------------------------------------- v2 extras: tags, capsule, trail, reply
  function renderExtras() {
    const on = v2();
    if (s.transcript) { el.transcript.hidden = false; el.transcript.textContent = `\u201c${s.transcript}\u201d`; }
    else el.transcript.hidden = true;
    el.tags.hidden = !s.tags?.length;
    el.tags.innerHTML = (s.tags || []).map((t) => `<span class="tag">#${t.replace(/[^a-z0-9_-]/g, '')}</span>`).join('')
      + (s.tags?.length && !on ? '<small class="v2-hint">Tags are saved once the backend update is in.</small>' : '');
    // time capsule presets with "opens in X"
    const presets = [{ id: 'now', label: 'Now', at: null }, ...capsulePresets()];
    s.capsuleId ||= 'now';
    el.chips.innerHTML = presets.map((p) => `<button type="button" class="chip-btn" role="radio" data-cap="${p.id}"
      aria-checked="${p.id === s.capsuleId}" ${on || p.id === 'now' ? '' : 'disabled'}>${p.label}${p.at ? `<small>${opensIn(p.at)}</small>` : ''}</button>`).join('');
    el.chips.onclick = (ev) => {
      const b = ev.target.closest('[data-cap]'); if (!b || b.disabled) return;
      s.capsuleId = b.dataset.cap; s.unlockAt = presets.find((p) => p.id === s.capsuleId)?.at?.toISOString() || null;
      renderExtras();
    };
    el.capsuleHint.textContent = !on ? 'Time capsules arrive with the backend update (migration-v2.sql).'
      : s.unlockAt ? `Hidden until it ${opensIn(s.unlockAt).replace('opens', 'opens')}. Its 24 h starts then.` : '';
    el.trailRow.hidden = !(activeTrail && on && !replyTo);
    if (activeTrail) el.trailName.textContent = `Add to trail \u201c${activeTrail.name}\u201d`;
    el.capsule.hidden = Boolean(replyTo);
    if (replyTo) {
      el.replyBanner.hidden = false;
      el.replyBanner.textContent = on ? `Replying to the echo${replyTo.place_label ? ` near ${replyTo.place_label}` : ''}` : 'Replies need the backend update (migration-v2.sql).';
    }
  }
  renderExtras();

  el.rerecord.addEventListener('click', () => { el.audio.pause(); clearClip(); setPhase('ready'); });

  // ---------------------------------------------------------------- drop
  function updateDropButton(errMsg) {
    if (s.phase !== 'review') return;
    el.drop.classList.remove('warn');
    if (errMsg) { el.drop.disabled = true; el.drop.textContent = 'No location'; el.warn.textContent = errMsg; return; }
    if (s.dropping) { el.drop.disabled = true; if (!s.locking) el.drop.textContent = 'Dropping\u2026'; return; }
    if (replyTo && !v2()) { el.drop.disabled = true; el.drop.textContent = 'Replies not available yet'; el.warn.textContent = store.V2_HINT; return; }
    if (replyTo && s.fix) {
      const chk = canReplyHere(replyTo, { lat: s.fix.lat, lng: s.fix.lng, accuracy: s.fix.accuracy });
      if (!chk.ok) { el.drop.disabled = true; el.drop.textContent = `Walk ${Math.ceil(chk.moveM)} m closer`; el.warn.textContent = 'Replies are dropped at the original echo (within 50 m).'; return; }
    }
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

  // Drop = 1) lock: wait up to 15 s for a reading at or under 15 m, with a live ±m meter;
  //        2) confirm your spot: a mini-map with a draggable pin (max 100 m from the fix), so the echo lands exactly where you are;
  //        3) drop, with 5 s to undo. The stored accuracy is the final fix's. A weak fix is only used after the user confirms the pin.
  let lockRun = 0, spotMap = null, spotPin = null, spotFix = null, labelP = null;
  el.drop.addEventListener('click', () => { if (s.blob && s.fix && !s.dropping) startLock(); });
  el.lockCancel.addEventListener('click', () => { lockRun++; s.locking = false; setPhase('review'); updateDropButton(); });
  el.lockSkip.addEventListener('click', () => { if (s.lockBest) { lockRun++; showSpot(s.lockBest); } });
  el.spotRelock.addEventListener('click', () => startLock());
  el.spotOk.addEventListener('click', () => commitDrop());

  async function startLock() {
    const run = ++lockRun; s.locking = true; s.lockBest = null;
    setPhase('locking'); haptic('tap');
    el.lockSkip.hidden = true; el.lockTitle.textContent = 'Hold still a moment';
    el.lockNote.textContent = `Waiting for a reading within ${LOCK_TARGET_M} m. Near a window or outside is fastest.`;
    const t0 = performance.now();
    const ringTick = () => {
      if (run !== lockRun || s.phase !== 'locking') return;
      const k = Math.min(1, (performance.now() - t0) / LOCK_WINDOW_MS);
      el.lockRing.style.strokeDashoffset = String(553 * (1 - k));
      requestAnimationFrame(ringTick);
    };
    requestAnimationFrame(ringTick);
    const show = (acc, n) => {
      el.lockAcc.textContent = `\u00b1${acc} m`; el.lockSub.textContent = `${n} reading${n === 1 ? '' : 's'}`;
      el.lock.dataset.q = acc <= LOCK_TARGET_M ? 'good' : acc <= 30 ? 'ok' : 'weak';
    };
    if (s.fix) show(Math.round(s.fix.accuracy), 0);
    setTimeout(() => { if (run === lockRun && s.phase === 'locking' && s.lockBest) el.lockSkip.hidden = false; }, 5000);
    labelP = navigator.onLine === false ? Promise.resolve(null) : placeLabel({ lat: s.fix.lat, lng: s.fix.lng }).catch(() => null);
    let fix = null;
    try {
      const p = await preciseFix({ windowMs: LOCK_WINDOW_MS, targetM: LOCK_TARGET_M, minSamples: 2, maxAccuracyM: 100, fallbackMs: LOCK_WINDOW_MS + 1000,
        seed: s.fix ? { lat: s.fix.lat, lng: s.fix.lng, accuracy: s.fix.accuracy, ts: s.fix.ts } : null,
        onProgress: (q) => {
          show(q.accuracy, q.samples);
          if (s.fix) s.lockBest = { lat: s.fix.lat, lng: s.fix.lng, accuracy: s.fix.accuracy, samples: q.samples, lowConfidence: q.accuracy > LOCK_TARGET_M };
        } });
      fix = { lat: p.lat, lng: p.lng, accuracy: p.accuracy, samples: p.samples, single: Boolean(p.single),
        lowConfidence: p.accuracy > LOCK_TARGET_M || Boolean(p.single && p.accuracy > LOCK_TARGET_M) };
    } catch (e) {
      if (run !== lockRun) return;
      if (e.message === 'location-denied') {
        el.lockTitle.textContent = 'Location is off';
        el.lockNote.textContent = 'Turn on Location for this site in your browser settings, then tap Re-lock. Your recording is kept.';
      } else if (s.fix) fix = { lat: s.fix.lat, lng: s.fix.lng, accuracy: s.fix.accuracy, samples: 1, single: true, lowConfidence: true };
      else {
        el.lockTitle.textContent = 'No GPS reading yet';
        el.lockNote.textContent = 'Step outside or near a window and try again. Your recording is kept.';
      }
      if (!fix) { el.lockSkip.hidden = true; el.lockCancel.textContent = 'Back'; s.locking = false; return; }
    }
    if (run !== lockRun) return;
    s.locking = false;
    showSpot(fix);
  }

  function showSpot(fix) {
    spotFix = fix; setPhase('spot'); haptic(fix.lowConfidence ? 'warn' : 'success');
    pinCtx = null; snapped = null; floorSel = null; root.dataset.snapped = '0';
    el.snapBtn.hidden = true; el.spotWarn.hidden = true; el.floor.hidden = true;
    spotPin?.getElement().querySelector('.pin-warn')?.setAttribute('hidden', '');
    const acc = Math.round(fix.accuracy);
    el.spotTitle.textContent = fix.lowConfidence ? 'Weak signal: check the pin' : 'Is the pin where you are?';
    el.spotOk.textContent = fix.lowConfidence ? 'Yes, I\u2019m here' : 'Drop here';
    el.spotNote.dataset.q = fix.lowConfidence ? 'weak' : 'good';
    el.spotNote.textContent = fix.lowConfidence
      ? `GPS is only good to \u00b1${acc} m here. Drag the pin onto your exact spot (up to ${SPOT_MAX_MOVE_M} m), then confirm.`
      : `Locked to \u00b1${acc} m${fix.samples > 1 ? ` from ${fix.samples} readings` : ''}. Drag the pin if it\u2019s off.`;
    const ml = window.maplibregl;
    if (!ml) { el.spotMap.hidden = true; return; }        // map library missing: the confirm button still works
    el.spotMap.hidden = false;
    if (!spotMap) {
      spotMap = new ml.Map({ container: el.spotMap, style: STYLES[0].url, center: [fix.lng, fix.lat], zoom: 18, attributionControl: false,
        dragRotate: false, pitchWithRotate: false, maxPitch: 0, fadeDuration: 0 });
      spotMap.touchZoomRotate.disableRotation();
      root.__spotMap = spotMap;                         // tests
      spotMap.on('styleimagemissing', (e) => { if (!spotMap.hasImage(e.id)) spotMap.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
      spotMap.on('error', (e) => console.info('[spot-map]', e?.error?.message || e));
      const elPin = document.createElement('div'); elPin.className = 'spot-pin'; elPin.innerHTML = '<b class="pin-warn" hidden>\u26A0 In the road</b><i></i>';
      elPin.setAttribute('aria-label', 'Your spot'); elPin.setAttribute('role', 'img');
      spotPin = new ml.Marker({ element: elPin, draggable: true, anchor: 'bottom' }).setLngLat([fix.lng, fix.lat]).addTo(spotMap);
      spotPin.on('dragstart', () => haptic('tick'));
      spotPin.on('dragend', onPinDragEnd);
      spotMap.on('load', () => { addAccCircle(); spotMap.resize(); });
    } else {
      spotPin.setLngLat([fix.lng, fix.lat]); spotMap.jumpTo({ center: [fix.lng, fix.lat], zoom: 18 }); addAccCircle();
      requestAnimationFrame(() => spotMap.resize());
    }
    root.dataset.spotMoved = '0';
    lookupPlace(fix, { allowSnap: true });
  }

  // ---------------------------------------------------------------- place context (inside / on a road / in a park)
  let placeRun = 0, pinCtx = null, fixCtx = null, snapped = null, floorSel = null, placeT = 0;
  const blurOn = () => Boolean(el.blur?.checked);
  function setChip(text, kind) { el.placeChip.textContent = text; el.placeChip.dataset.kind = kind; root.dataset.placeKind = kind; }
  async function lookupPlace(at, { allowSnap = false, userPlaced = false } = {}) {
    const run = ++placeRun;
    setChip('Checking where you are\u2026', 'checking');
    const ctx = await resolvePlace({ lat: at.lat, lng: at.lng, accuracy: userPlaced ? 5 : at.accuracy },
      { map: spotMap || null, store, blurred: blurOn() || !allowSnap });
    if (run !== placeRun || s.phase !== 'spot') return;
    root.dataset.placeSource = ctx?.source || 'none';
    if (allowSnap) { fixCtx = ctx; snapped = null; }
    if (allowSnap && ctx?.snap && !blurOn()) { applySnap(ctx); return; }
    applyCtx(ctx);
  }
  function applyCtx(ctx) {
    pinCtx = ctx && ctx.kind !== 'unknown' ? ctx : null;
    const road = pinCtx?.kind === 'road';
    setChip(pinCtx?.label || 'Couldn\u2019t tell what\u2019s here', pinCtx?.kind || 'unknown');
    const warnEl = spotPin?.getElement().querySelector('.pin-warn');
    if (warnEl) warnEl.hidden = !road;
    el.spotWarn.hidden = !road;
    el.spotWarn.textContent = road ? ROAD_WARN : '';
    if (road) haptic('warn');
    el.snapBtn.hidden = !snapped;
    renderFloors(pinCtx?.kind === 'indoor' ? pinCtx.levels : null, pinCtx?.floorHint);
  }
  function applySnap(ctx) {
    const sp = ctx.snap; const from = spotPin.getLngLat();
    snapped = { from: { lat: from.lat, lng: from.lng }, to: { lat: sp.lat, lng: sp.lng }, ctx };
    spring(0, 1, (k) => spotPin.setLngLat([from.lng + (sp.lng - from.lng) * k, from.lat + (sp.lat - from.lat) * k]), { stiffness: 200, damping: 20, precision: 0.002 });
    haptic('success');
    root.dataset.snapped = '1';
    applyCtx({ kind: 'indoor', name: sp.name, label: `Inside ${sp.name}`, levels: sp.levels || [], building: { name: sp.name, extentM: sp.extentM || 40 }, source: ctx.source, mall: sp.mall });
    el.spotNote.dataset.q = 'ok';
    el.spotNote.textContent = `GPS put you on ${ctx.road?.name || 'the road'} (\u00b1${Math.round(spotFix.accuracy)} m), so the pin moved ${Math.round(sp.distM)} m inside ${sp.name}. Drag it if that\u2019s wrong.`;
    el.snapBtn.textContent = `Keep it on ${ctx.road?.name || 'the road'}`;
    el.snapBtn.hidden = false;
  }
  el.snapBtn.addEventListener('click', () => {
    if (!snapped) return;
    const { from, ctx } = snapped; snapped = null; root.dataset.snapped = '0';
    spotPin.setLngLat([from.lng, from.lat]); haptic('tap');
    applyCtx(ctx);
    el.spotNote.textContent = 'Back where GPS put you. Drag the pin if it\u2019s off.';
  });
  function renderFloors(levels, hint) {
    if (!levels?.length || blurOn()) { el.floor.hidden = true; floorSel = null; return; }
    el.floor.hidden = false;
    if (hint && floorSel == null) floorSel = hint;
    el.floorChips.innerHTML = levels.map((l) => `<button type="button" class="chip-btn" role="radio" aria-checked="${l === floorSel}" data-level="${l}">${levelShort(l)}</button>`).join('');
  }
  el.floorChips.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-level]'); if (!b) return;
    floorSel = floorSel === b.dataset.level ? null : b.dataset.level; haptic('tick');
    for (const c of el.floorChips.querySelectorAll('[data-level]')) c.setAttribute('aria-checked', String(c.dataset.level === floorSel));
    if (pinCtx) setChip(placeText(pinCtx, floorSel) || pinCtx.label, pinCtx.kind);
  });
  function circleGeo({ lat, lng }, r) {
    const pts = []; for (let i = 0; i <= 48; i++) { const a = (i / 48) * 2 * Math.PI;
      pts.push([lng + (r * Math.sin(a)) / (111320 * Math.cos(lat * Math.PI / 180)), lat + (r * Math.cos(a)) / 110540]); }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: {} };
  }
  function addAccCircle() {
    if (!spotMap?.isStyleLoaded?.() || !spotFix) return;
    const data = { type: 'FeatureCollection', features: [circleGeo(spotFix, Math.max(5, spotFix.accuracy)), circleGeo(spotFix, SPOT_MAX_MOVE_M)] };
    data.features[1].properties.limit = 1;
    if (spotMap.getSource('acc')) { spotMap.getSource('acc').setData(data); return; }
    spotMap.addSource('acc', { type: 'geojson', data });
    spotMap.addLayer({ id: 'acc-fill', type: 'fill', source: 'acc', filter: ['!', ['has', 'limit']], paint: { 'fill-color': '#8fd3e8', 'fill-opacity': 0.12 } });
    spotMap.addLayer({ id: 'acc-line', type: 'line', source: 'acc', paint: { 'line-color': ['case', ['has', 'limit'], 'rgba(255,255,255,.18)', '#8fd3e8'],
      'line-width': 1.2, 'line-dasharray': ['case', ['has', 'limit'], ['literal', [2, 3]], ['literal', [1, 0]]] } });
  }
  function onPinDragEnd() {
    const ll = spotPin.getLngLat(); const d = distM(spotFix, { lat: ll.lat, lng: ll.lng });
    if (d > SPOT_MAX_MOVE_M) {
      haptic('warn');
      const from = { lat: ll.lat, lng: ll.lng };
      spring(0, 1, (k) => spotPin.setLngLat([from.lng + (spotFix.lng - from.lng) * k, from.lat + (spotFix.lat - from.lat) * k]), { stiffness: 260, damping: 22, precision: 0.002 });
      el.spotNote.dataset.q = 'weak';
      el.spotNote.textContent = `That\u2019s ${Math.round(d)} m from your GPS fix. Pins can move up to ${SPOT_MAX_MOVE_M} m, so it snapped back.`;
      root.dataset.spotMoved = '0';
    } else {
      haptic('tick');
      root.dataset.spotMoved = d >= 1 ? '1' : '0';
      el.spotNote.dataset.q = 'good';
      el.spotNote.textContent = d >= 1 ? `Moved ${Math.round(d)} m. Drop when it\u2019s right on your spot.` : el.spotNote.textContent;
      if (d >= 3) { snapped = null; root.dataset.snapped = '0'; clearTimeout(placeT); placeT = setTimeout(() => lookupPlace({ lat: ll.lat, lng: ll.lng }, { userPlaced: true }), 350); }
    }
  }

  async function commitDrop() {
    if (!s.blob || !spotFix || s.dropping) return;
    s.dropping = true; el.spotOk.disabled = true; el.spotOk.textContent = 'Dropping\u2026';
    const ll = spotPin ? spotPin.getLngLat() : { lat: spotFix.lat, lng: spotFix.lng };
    const moved = distM(spotFix, { lat: ll.lat, lng: ll.lng });
    const fix = { ...spotFix, lat: ll.lat, lng: ll.lng, adjustedM: moved >= 1 ? moved : 0 };
    const blurred = el.blur.checked;
    const ctxLabel = pinCtx ? placeText(pinCtx, floorSel, { blurred }) : null;
    const place = ctxLabel || (blurred ? null : await Promise.race([labelP || Promise.resolve(null), new Promise((r) => setTimeout(() => r(null), 1500))]));
    const generic = !pinCtx?.name || /^(a|an) /.test(pinCtx.name);
    try {
      const args = {
        blurred, placeLabel: place || null,
        placeKind: pinCtx ? KIND_TO_DB[pinCtx.kind] || null : null,
        placeName: pinCtx && !generic && !blurred ? pinCtx.name.slice(0, 120) : null,
        level: pinCtx?.kind === 'indoor' && !blurred ? levelToInt(floorSel) : null,
        transcript: s.transcript || null, tags: s.tags?.length ? s.tags : null,
        unlockAt: !replyTo && v2() ? s.unlockAt || null : null, accuracy: fix.accuracy,
        blob: s.blob, mimeType: s.blob.type, durationMs: Math.round(s.durationMs),
        lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracy,
        heading: s.heading, altitude: s.fix?.altitude,
      };
      const shim = { dropEcho };                 // trax's helpers call client.dropEcho: route them through the store
      const echo = replyTo ? await replyToEcho(shim, replyTo, args)
        : activeTrail && v2() && el.trail.checked ? await dropOnTrail(shim, activeTrail.id, args)
          : await dropEcho(args);
      setDuration(echo.id, s.durationMs);
      haptic('drop');
      lastFix = fix;
      showConfirmation(echo);
    } catch (err) {
      el.spotNote.dataset.q = 'weak';
      el.spotNote.textContent = `Couldn\u2019t drop: ${err?.friendly || err?.message || err}. Tap Drop again; your recording is kept.`;
      onToast(`Couldn\u2019t drop: ${err?.friendly || err?.message || err}`);
    } finally {
      s.dropping = false; el.spotOk.disabled = false;
      if (s.phase === 'spot') el.spotOk.textContent = spotFix?.lowConfidence ? 'Yes, I\u2019m here' : 'Drop here';
    }
  }

  function showConfirmation(echo) {
    root.querySelector('[data-c-lat]').textContent = echo.lat.toFixed(5);
    root.querySelector('[data-c-lng]').textContent = echo.lng.toFixed(5);
    root.querySelector('[data-c-acc]').textContent = (echo.accuracy_m != null ? `\u00b1${Math.round(echo.accuracy_m)} m` : 'unknown')
      + (lastFix?.adjustedM ? ` \u00b7 pin moved ${Math.round(lastFix.adjustedM)} m by you` : '')
      + (lastFix?.lowConfidence ? ' \u00b7 weak GPS, confirmed by you' : lastFix?.samples > 1 ? ` \u00b7 ${lastFix.samples} readings` : '');
    const placeEl = root.querySelector('[data-c-place]');
    if (echo.place_label) placeEl.textContent = echo.place_label;
    else if (navigator.onLine === false || echo.blurred) placeEl.textContent = 'Unnamed spot';
    else { placeEl.textContent = '\u2026'; placeLabel({ lat: echo.lat, lng: echo.lng }).then((l) => { placeEl.textContent = l || 'Unnamed spot'; }).catch(() => { placeEl.textContent = 'Unnamed spot'; }); }
    const q = Boolean(echo.queued);
    const sealed = echo.unlock_at || (q && echo.unlockAt);
    root.querySelector('[data-c-eyebrow]').textContent = q ? 'Queued' : echo.parent_id ? 'Reply' : echo.trail_id ? 'Trail stop' : sealed ? 'Time capsule' : 'Dropped';
    root.querySelector('[data-c-title]').textContent = q ? 'Queued, will upload' : echo.parent_id ? 'Your reply is in the thread'
      : echo.trail_id ? `Stop added to \u201c${activeTrail?.name || 'your trail'}\u201d` : sealed ? `Sealed \u00b7 ${opensIn(sealed)}` : 'Your echo is out there';
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
    setPhase('dropped');
    startUndo(echo);
  }

  // 5 s undo: the clip is kept until the window closes, so Undo returns to the review with the recording intact.
  let undoT = 0, undoRaf = 0;
  function startUndo(echo) {
    clearTimeout(undoT); cancelAnimationFrame(undoRaf);
    el.undo.hidden = false; el.undo.disabled = false; const t0 = performance.now();
    const tick = () => {
      const left = Math.max(0, UNDO_MS - (performance.now() - t0));
      el.undoN.textContent = String(Math.ceil(left / 1000));
      el.undoBar.style.transform = `scaleX(${(left / UNDO_MS).toFixed(3)})`;
      if (left > 0 && !el.undo.hidden) undoRaf = requestAnimationFrame(tick);
    };
    tick();
    undoT = setTimeout(endUndo, UNDO_MS);
    el.undo.onclick = async () => {
      clearTimeout(undoT); cancelAnimationFrame(undoRaf); el.undo.disabled = true; el.undoN.textContent = '';
      try {
        await store.retractEcho(echo.id);
        haptic('tap'); onToast('Drop undone. Your recording is still here.');
        el.undo.hidden = true; lastEcho = null; delete root.dataset.lastEchoId;
        root.dataset.undone = echo.id;
        setPhase('review'); updateDropButton();
      } catch (err) { onToast(`Couldn\u2019t undo: ${err?.friendly || err?.message || err}. Open the echo on the map and tap Take it back.`); endUndo(); }
    };
  }
  function endUndo() { cancelAnimationFrame(undoRaf); el.undo.hidden = true; if (s.phase === 'dropped') clearClip(); }

  el.another.addEventListener('click', () => { endUndo(); clearClip(); setPhase('ready'); });
  el.see.addEventListener('click', () => { endUndo(); onDropped(lastEcho); });
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
      try { s.lt?.stop(); } catch { /* ignore */ }
      cancelAnimationFrame(s.raf); lockRun++; clearTimeout(undoT);
      try { spotMap?.remove(); } catch { /* ignore */ }
      if (s.watchId != null) navigator.geolocation.clearWatch(s.watchId);
      s.stream?.getTracks().forEach((t) => t.stop());
      s.audioCtx?.close?.();
    },
  };
}

function cardinal(h) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(h / 45) % 8];
}
