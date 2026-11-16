# VoiceSpace · Echolocation
Connect with Voice.

**Echolocation** is a mobile web app (PWA). Record a short audio clip (an *Echo*) and drop it at your exact GPS
position. There is no map in the app: others discover Echoes by walking. Haptic/sound pings speed up as they get
closer, then they *tune in* by pointing the phone (compass + spatial audio). Echoes decay after 24 h, and each
*resonate* from a listener extends their life.

Live: https://winstonjaysa.github.io/VoiceSpace/ (GitHub Pages, branch `main`, path `/`).
No build step: plain HTML/CSS and ES modules. All paths are relative, so it works under `/VoiceSpace/`.

## Run locally
```sh
python3 -m http.server 8080   # then open http://localhost:8080/
```
Mic, geolocation and compass need a secure context: `localhost` or HTTPS.

## Layout
| Path | What | Owner |
|---|---|---|
| `index.html`, `js/app.js`, `css/app.css` | App shell: tab bar (Drop / Listen), hash routing, SW registration | raptor |
| `js/record.js`, `css/record.css` | **Record-and-drop screen**. Self-contained (markup + logic); mount via `mountRecordScreen(el)` | raptor (trax may replace) |
| `js/config.js` | Public config: Supabase URL/anon key (empty = local fallback), Mapbox token (from `?mapbox=` once per device, not committed), echo rules | raptor |
| `js/echo-store.js` | **Data seam (the one store).** Supabase via `echoes-client.js`, IndexedDB fallback, hunt source adapter | raptor |
| `js/echoes-client.js` | night crawler's Supabase client, copied verbatim from `backend/echoes-client.js` | night crawler |
| `js/listen.js` | Listen tab: intro + Start listening; hides it and gives the screen to the hunt ring | raptor |
| `js/hunt.js` | `startHunt(container, { store })`: thin wrapper (UI + source) over the engine | trax (wrapper) |
| `js/hunt-core.js`, `js/hunt-math.js`, `js/desk-sim.js` | Hunt engine: sonar pings, Kalman GPS, compass tuning, HRTF audio, resonate. Unchanged copies | night crawler |
| `debug.html`, `js/debug.js` | Hidden Mapbox debug map at `/debug.html`, not linked from the UI | Cooker |
| `manifest.json`, `sw.js`, `icons/` | PWA: add to home screen, offline shell | raptor |

## Record-and-drop screen
- **Enable mic & location** (one tap) requests DeviceOrientation permission (iOS), the microphone and
  high-accuracy geolocation. Every permission prompt comes from a user tap.
- Big button: **hold to record**, or **tap to start / tap to stop**. 30 s max, with a progress ring, timer and live level meter.
- MediaRecorder mimeType preference (first `isTypeSupported` wins on every platform): `audio/mp4;codecs=mp4a.40.2`,
  `audio/mp4;codecs=aac`, `audio/aac`, `audio/mp4`, then `audio/webm;codecs=opus`, `audio/webm`, ogg. iOS Safari
  records AAC in mp4. Recent Chrome reports `audio/mp4`, which records Opus-in-mp4 there.
- Preview playback, **Re-record**, then **Drop here**. If GPS accuracy is worse than 25 m the button
  turns amber ("Drop anyway (±N m)") with a warning to wait for a better fix.
- Compass heading at drop time comes from `webkitCompassHeading` (iOS) or `deviceorientationabsolute` (Android).
- The confirmation shows lat/lng, accuracy, heading and the 24 h expiry time.

## echo-store API (`js/echo-store.js`)
```js
import { dropEcho, nearbyEchoes, resonate, getAudioUrl } from './js/echo-store.js';
await dropEcho({ blob, mimeType, durationMs, lat, lng, accuracyM, heading, altitude, caption }); // -> Echo (+ audioPath)
//  also accepts trax's / echoes-client names: { blob, durationS, lat, lng, accuracyM, headingDeg, altitudeM }
//  (and snake_case duration_s / heading_deg / altitude_m / accuracy_m / mime_type); mimeType defaults to blob.type
await nearbyEchoes(lat, lng, radiusM);   // -> Echo[] not expired, nearest first, + distance_m (+ bearing_deg on Supabase)
await resonate(id, { lat, lng });        // -> { id, expires_at, ... }  (Supabase: within 50 m, once per device, not your own)
await getAudioUrl(echo, { lat, lng });   // -> playable URL (Supabase: unlocks only within 25 m, else throws "too far")
createHuntSource();                      // -> hunt-core source { nearby, unlock, resonate, echoes } (see Hunt)
// extras: listAllEchoes(center) (debug only), checkBackend(), events ('drop'|'resonate'|'backend'),
//         backendName, backendError, getDeviceId(), lastKnownPosition(), haversineM(), isExpired()
```

### Echo record shape
| field | type | notes |
|---|---|---|
| `id` | string (uuid) | |
| `lat`, `lng` | number | WGS84. Supabase `nearby_echoes` returns `echo_lat`/`echo_lng`, renamed here |
| `accuracy_m` | number \| null | GPS accuracy radius at drop time |
| `heading` | number \| null | compass degrees 0–360 at drop time (`heading_deg` in SQL) |
| `altitude` | number \| null | metres (`altitude_m` in SQL) |
| `created_at` | ISO-8601 string | |
| `expires_at` | ISO-8601 string | `created_at + 24 h`; each resonate +12 h, capped at 7 days (server rules) |
| `resonance_count` | integer | |
| `audio_path` | string \| null | `<uuid>.<ext>` in bucket `echoes`; null until unlocked; `local:<id>.<ext>` in the fallback |
| `duration_ms` | integer | (`duration_s` in SQL) |
| `mime_type` | string | `audio/webm`, `audio/mp4`, … (codec params stripped for the server) |
| `source` | `'supabase'` \| `'local'` | which backend holds it |

### Backend: Supabase (via echoes-client.js) with an IndexedDB fallback
`js/config.js` holds the public Supabase URL + publishable (anon) key from night crawler's `backend/config.js`.
The Supabase path delegates to **`js/echoes-client.js`**, night crawler's client copied verbatim (78/78 tests).
It loads `@supabase/supabase-js@2` from esm.sh on first use and calls the RPCs in `backend/schema.sql`:
`drop_echo`, `nearby_echoes`, `unlock_echo` (25 m + GPS pad), `resonate` (50 m + pad, once per device, not your
own), `debug_echoes`. Audio goes to the public `echoes` bucket. The anonymous device id lives in localStorage
under `echolocation.device`, shared with the client and the hunt (the old `echolocation.device_id` is migrated).

If the config is empty, supabase-js can't load, or the client throws `SCHEMA_MISSING` / `NETWORK` /
`NOT_INITIALISED` / `FORBIDDEN` / "Bucket not found" / 5xx, the session switches to the **IndexedDB fallback**,
which only works on one device. Game errors (`TOO_FAR`, `ALREADY_RESONATED`, `OWN_ECHO`, `RATE_LIMITED`, `FADED`)
are passed to the caller and do not trigger it. Local echoes stay findable, playable and resonatable locally.
**Status 2026-11-03 04:15 EST: the schema has still not been applied (RPCs return `PGRST202`, bucket missing),
so the app runs on the fallback.** Once `schema.sql` is run in the Supabase SQL editor it switches over
automatically, with no code change.

### Hunt (Listen tab)
`js/listen.js` → `startHunt(container, { store })` (`js/hunt.js`, trax's wrapper) → `createHunt()` (`js/hunt-core.js`,
night crawler's engine, see `docs/HUNT.md`). `hunt.start()` runs synchronously inside the "Start listening" tap
(AudioContext, compass permission, geolocation all need the gesture). The source is `store.createHuntSource()`.
While Supabase works that is the client's `createSupabaseSource()`, with real `echo_lat/echo_lng` and server-gated
unlock and resonate. Otherwise it uses the local IndexedDB echoes. Echoes saved only on this device are always
merged in. When the hunt starts, the intro and Start button hide so the ring fills the screen; × stops it.
Add `?desk` to the URL for desk mode (keyboard/drag simulation via `js/desk-sim.js`, no GPS or compass needed).
`window.__hunt` / `window.__huntState` are exposed for QA.

## Debug map
`/debug.html` (unlisted; open it once as `debug.html?mapbox=<pk. token>` to store the Mapbox token on that device) uses Mapbox GL JS to show every Echo (including expired ones, greyed out) as a dot with an
accuracy halo. Click a dot for a popup with created/expires/accuracy/audio. The table below the map lists the
same data. "Show my position" adds your location.
