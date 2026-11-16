# Echolocation — `hunt` module

How you find Echoes. **There's no map.** You walk, and a sonar ping speeds up as you get closer. Once you're within ~15 m you *tune in*: turn your body and phone, and the Echo's audio goes from muffled, staticky and off to one side to clear and centred when you face it. If you hold it for 2 s, you can **resonate** the Echo, which keeps it alive longer.

Static ES modules. No build step, no dependencies. Works on GitHub Pages over HTTPS.

| File | What it is |
|---|---|
| `hunt.js` | `createHunt({ source, onState, onPing, options })`: GPS, compass, sonar, tune-in audio graph, wake lock, visibility handling |
| `hunt-math.js` | Pure functions with no DOM: haversine, bearing, heading conversion, Kalman GPS filter, ping mapping, alignment, lock. Unit-tested in node |
| `mock-source.js` | Mock backend. It drops 3 echoes 20/60/120 m from your first fix in random directions and synthesises their audio (OfflineAudioContext → WAV blob) |
| `http-source.js` | Adapter for raptor's **prototype** node API (`../api/server.mjs`). Use it as a template for the Supabase adapter |
| `desk-sim.js` | Desk mode: keyboard and sliders fake your position and heading on a laptop |
| `demo.html` | A minimal near-black "listen, don't look" UI |
| `tests/hunt-math.test.mjs` | Node unit tests (`node --test tests/hunt-math.test.mjs`) |
| `tests/browser-smoke.mjs` | Headless Chrome end-to-end run with mocked geolocation and synthetic compass events |

## Quick start

```
demo.html                     # real GPS + compass, mock echoes around you (walk outside)
demo.html?debug               # + numbers overlay (accuracy, distance, bearing, heading, ping ms, alignment)
demo.html?desk&debug          # desk mode: WASD/arrows to walk/turn, Q/E strafe, R/F pitch, G = warp 30 m from nearest echo
demo.html?api=https://…       # use the prototype HTTP backend instead of the mock
demo.html?unlock=20&seed=42   # unlock radius in metres; deterministic mock layout
```

You need HTTPS for geolocation, the compass and the wake lock. `localhost` also works. For a phone on your LAN, use GitHub Pages or a tunnel.

```js
import { createHunt } from './hunt.js';
import { createMockSource } from './mock-source.js';

const hunt = createHunt({
  source: createMockSource(),           // or your Supabase adapter
  onState: s => render(s),              // throttled (~12/s) snapshot; see "State" below
  onPing: p => pulseRing(p),            // fires on every sonar ping: { intervalMs, distanceM, word, count }
  options: { unlockRadiusM: 15 },
});
beginButton.onclick = () => hunt.start();   // MUST be inside a user gesture, with nothing awaited before it
// hunt.stop(); hunt.resonate(); hunt.resumeAudio() (if state.needsTap)
```

## Source adapter contract (for raptor / the backend)

`hunt.js` only talks to an object with three async methods. Return plain objects. Extra fields are ignored.

### `nearby({ lat, lng, radiusM, accuracyM?, altitudeM? }) → Promise<Echo[]>`
Called about every 10 s, or after the user moves more than 15 m. `radiusM` defaults to 300.

| field | type | req | notes |
|---|---|---|---|
| `id` | string | ✔ | stable id |
| `lat`, `lng` | number (WGS84 deg) | ✔ | **The hunt needs the real coordinates.** Distance and bearing are computed on the phone, so the ping rate and turning work between polls. If you want to hide exact positions, fuzz them by 2 m or less. Fuzzing by more breaks tune-in |
| `expiresAt` | ISO string or epoch ms | ✔ | Echoes past this time are dropped on the phone |
| `resonanceCount` | integer | ✔ | Shown in `state.target` |
| `distanceM` | number | – | Ignored for targeting (we recompute it). Handy for logs |
| `headingDeg` | number 0–360 | – | The direction the dropper faced while recording. Exposed as `target.dropperHeadingDeg` and not used yet |
| `altitudeM` | number (metres, same datum as `coords.altitude`) | – | If present, and the phone reports altitude, pitch becomes part of alignment (e.g. "point up at the balcony") |

Return only Echoes that are live and inside `radiusM`. 20–50 Echoes is plenty.

### `unlock(id, { lat, lng, accuracyM }) → Promise<audioUrl: string>`
Called once per Echo when the user is within `unlockRadiusM`. The result is cached for the session.
* Return a URL that `fetch()` can GET with CORS: a signed Supabase Storage URL, a blob: URL, or similar.
* **Enforce distance on the server**: `haversine(user, echo) <= 25 + min(accuracyM, 40)`. GPS is only good to about 5–15 m, so pad the check. A strict 15 m check will lock people out while they're standing on the spot. On failure, reject or throw. The hunt retries after 8 s.
* Format: anything `decodeAudioData` handles on both platforms. **Use AAC/m4a (`audio/mp4`) or WAV/MP3.** iOS `MediaRecorder` produces `audio/mp4`, and Chrome produces `audio/webm;codecs=opus`. Old iOS can't decode webm/opus. When decoding fails, `hunt.js` falls back to an `<audio>` element through `createMediaElementSource`, but that path needs CORS headers on the audio. Transcoding to m4a on upload is the safest option.
* 5–60 s works best. The clip loops while you're tuning in.

### `resonate(id, { lat, lng, accuracyM }) → Promise<{ expiresAt?, resonanceCount? } | void>`
Called when the user taps "resonate" after holding alignment. The server should check proximity again, the same way as for unlock, and allow one resonance per device or user. The prototype extends the expiry by 24 h. Return the new values if you have them, and the UI updates.

The prototype mapping (see `http-source.js`): `GET /echoes?lat&lng` → `{echoes:[{id,lat,lng,heading,expires,resonances,dist}]}`, `GET /echoes/:id/audio?lat&lng&acc` (server gates by 25 m + acc), `POST /echoes/:id/resonate` with `x-device`. A Supabase adapter would be roughly an RPC `echoes_nearby(lat,lng,radius)` (PostGIS `ST_DWithin`), an edge function `unlock` that checks distance and returns `createSignedUrl(path, 300)`, and an RPC or edge function `resonate`.

## State (`onState` snapshot)
```
status: 'idle'|'starting'|'locating'|'searching'|'tracking'|'tuning'|'stopped'|'error'
error, needsTap, position:{lat,lng,accuracy,rawAccuracy,altitude,lowConfidence}
heading, pitch, headingSource:'compass'|'gps-course'|'none', compassPermission, compassAccuracy
echoesCount, pollError, pingCount, pingIntervalMs (null when silent/tuning)
target:{id,distanceM,bearingDeg,relativeDeg,word:'far'|'near'|'close'|'here',expiresAt,resonanceCount,dropperHeadingDeg,altitudeM}
tuning:{id,status:'unlocking'|'playing',alignment 0..1,errorDeg,lockProgress 0..1,locked,canResonate,resonated,error}
capabilities:{vibrate,geolocation,orientation,orientationNeedsPermission,wakeLock,hrtf}
```

## How it works
* **GPS**: `watchPosition({enableHighAccuracy:true, maximumAge:0})` feeds a 1-state Kalman filter (process noise q = 3 m/s). Fixes worse than 40 m are ignored once there's an estimate and set `lowConfidence`. A first fix that bad is accepted but flagged. A jump over 250 m with a good fix resets the filter. Distance is haversine and direction is the initial great-circle bearing. The nearest live Echo is the target. While tuning, the hunt stays on that Echo until you're more than 1.5 × the unlock radius away, so GPS wander doesn't flip it.
* **Sonar**: `interval = 250 ms × 16^t`, where `t = log(d/5)/log(150/5)`. This is log-log, so each halving of distance gives the same speed-up: 150 m → 4 s, 60 m → 1.9 s, 20 m → 0.77 s, 5 m → 0.25 s. Beyond 300 m it's silent. Each blip is two sines with a pitch drop (1–1.5 kHz falling to 55 %), sent through a feedback delay for an underwater tail. The pitch rises as you get closer. If a heading is known, the blip is stereo-panned toward the Echo and made a bit quieter when it's behind you. `navigator.vibrate` pulses along with each blip where supported.
* **Compass**:
  * Android Chrome: `deviceorientationabsolute`. Heading = `360 − alpha`, with tilt compensation from the W3C formula (where the back of the phone points when you hold it upright), plus `screen.orientation.angle`.
  * iOS: `webkitCompassHeading + screen angle`, after calling `DeviceOrientationEvent.requestPermission()` inside the tap.
  * Heading is smoothed with a circular EMA (wrap-safe).
  * Pitch = `beta − 90` (portrait).
  * If no compass reading arrives within 3 s, the hunt uses GPS course-over-ground while you walk (> 0.7 m/s). With no heading at all, clarity simply grows as you get closer.
* **Tune-in graph**:
  * Signal path: `BufferSource(loop) → lowpass (400 Hz…20 kHz, exponential in alignment²) → gain → HRTF Panner (relative angle → x/z, elevation → y) → out`.
  * Static path, in parallel: `looped pink-ish noise with crackle → bandpass 2.4 kHz → gain ∝ (1−a)^1.2 → out`.
  * A 0.35 Hz LFO wobbles the filter, up to 700 cents off-axis. That's the "ghost transmission" warble.
  * Alignment is `a = max(0, cos(error))`. The error is the spherical angle between where you point (heading, pitch) and the Echo (bearing, elevation).
  * Lock: the error has to stay at 20° or less for 2 s. It releases above 30°. Lock vibrates and allows resonate. Once allowed, resonate stays available for that tune-in.

## iOS Safari vs Android Chrome: limitations

| | iOS Safari | Android Chrome |
|---|---|---|
| Vibration | **No Vibration API.** The ping is audio only. We detect `navigator.vibrate` and skip it | ✔ (needs a prior tap, which the start gesture covers) |
| Compass | Needs `DeviceOrientationEvent.requestPermission()` on a tap (iOS 13+). The user sees a system prompt. Uses `webkitCompassHeading`. Accuracy is in `compassAccuracy` (−1 = uncalibrated) | `deviceorientationabsolute`, no prompt. Calibrate with a figure-8 if it drifts |
| Audio | AudioContext must be created/resumed in the tap (we also play a 1-sample buffer). **The ring/silent switch mutes Web Audio.** On iOS 17+ we set `navigator.audioSession.type = 'playback'` to get around it. On older iOS, tell users to flip the switch | Autoplay policy: also unlocked by the tap |
| Wake lock | `navigator.wakeLock` since 16.4 (in home-screen PWAs only from 18.4). Otherwise the screen dims and the hunt stops | ✔ |
| Background / locked screen | **No browser keeps delivering GPS in the background or with the screen locked.** Sonar stops. We release the wake lock and suspend audio when hidden, then resume when visible. If iOS refuses `resume()` without a gesture, `state.needsTap` is set and the demo shows "tap to wake the sound" | Same (Chrome throttles timers and GPS when hidden) |
| Spatial audio | HRTF works with headphones. The phone speaker is close to mono, so the lowpass, static and volume cues do most of the work | Same |
| Altitude | `coords.altitude` often exists but is ±10–30 m. Elevation only counts when both altitudes exist, and should be treated as a bonus | Often `null` |

General notes:
* GPS accuracy is about 5–15 m in the open and worse near tall buildings. That's why the unlock radius is 15 m, the exit radius 22 m and the server check 25 m + accuracy. Don't go below 10 m.
* The compass is ±10–20° near steel and cars, so the lock cone is 20° with hysteresis.
* Screen rotation is handled for the azimuth. Pitch assumes portrait.

## Tuning constants (`options`, defaults in `DEFAULTS` in hunt.js)
`unlockRadiusM 15`, `unlockExitFactor 1.5`, `searchRadiusM 300`, `pollIntervalMs 10000`, `pollMoveM 15`, `maxAccuracyM 40`, `gpsProcessNoise 3`, `ping {nearM 5, farM 150, silentM 300, minMs 250, maxMs 4000}`, `pingVolume 0.45`, `pingPan true`, `vibrate true`, `headingSmoothing 0.2`, `noCompassTimeoutMs 3000`, `alignLockDeg 20`, `alignReleaseDeg 30`, `alignHoldMs 2000`, `tune {minCutoffHz 400, maxCutoffHz 20000, cutoffCurve 2, maxNoise 0.55, noiseFloor 0.02}`, `useElevation true`, `wakeLock true`, `useDeviceGeolocation/useDeviceCompass true` (set false and call `hunt.injectPosition()` / `hunt.injectHeading()` for desk mode or tests).

## Tests
```
node --test tests/hunt-math.test.mjs                      # 12 tests: haversine, bearing, heading conversion, smoothing, Kalman, ping map, alignment, lock, ranking
npm i playwright-core   # anywhere
PW_MODULE=/path/to/node_modules/playwright-core/index.mjs CHROME=/usr/bin/google-chrome node tests/browser-smoke.mjs
```
The smoke test serves this folder on localhost and grants geolocation, then:
* taps Begin and checks that audio is running and pings fire;
* dispatches compass events, walks into range and checks that the WAV decodes and plays;
* faces the Echo (lowpass at about 19 kHz, almost no noise), then locks and resonates;
* turns 100° away (lowpass at about 400 Hz, noise around 0.46, panned left);
* walks away, sends a 120 m-accuracy fix and checks that it's ignored, then stops;
* repeats the flow in desk mode and with no compass;
* fails on any JS error.

Screenshots are saved to `tests/`.
