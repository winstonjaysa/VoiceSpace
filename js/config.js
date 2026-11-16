// Echolocation runtime config. Plain ES module, no build step.
// Everything here ships to the browser, so ONLY public/client-safe values belong here.

// --- Supabase (backend seam; owner: raptor) ---------------------------------
// Copied from night crawler's /home/box/shared/echolocation/backend/config.js (schema: backend/schema.sql).
// Set both to '' to force the local IndexedDB fallback in js/echo-store.js.
// The publishable key is public by design (anon role: may only call the Echo RPCs + upload audio).
// NEVER put the secret / service_role key here.
export const SUPABASE_URL = 'https://bfpwdtgknbbfetpvopws.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_V1pPLlFYTWtFM6gLLIvbyg_vYCq9Vij';
export const SUPABASE_AUDIO_BUCKET = 'echoes';

// --- Mapbox (hidden debug view only: /debug.html) ----------------------------
// Public "pk." token, intended for client-side use. Restrict allowed URLs in the Mapbox dashboard.
// Not committed: GitHub's secret scanning rejects Mapbox tokens in pushes. Supply it once per device:
//   open debug.html?mapbox=<your pk. token>  -> it is saved in localStorage for later visits.
export const MAPBOX_TOKEN = (() => {
  try {
    const q = new URLSearchParams(location.search).get('mapbox');
    if (q && q.startsWith('pk.')) localStorage.setItem('echolocation.mapboxToken', q);
    return localStorage.getItem('echolocation.mapboxToken') || '';
  } catch { return ''; }
})();

// --- Echo rules ---------------------------------------------------------------
export const ECHO_TTL_MS = 24 * 60 * 60 * 1000;          // an Echo decays 24 h after it is dropped
export const RESONATE_EXTENSION_MS = 12 * 60 * 60 * 1000; // local fallback only; server rule (echo_rules) is +12 h, capped at 7 d
export const MAX_RECORD_MS = 30 * 1000;                   // max clip length
export const GPS_GOOD_ACCURACY_M = 25;                    // warn / wait if the fix is worse than this
export const DEFAULT_NEARBY_RADIUS_M = 150;   // server default 150, max 500
export const UNLOCK_RADIUS_M = 25;            // server: must be within 25 m to hear (unlock) an Echo
