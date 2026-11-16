// Listen screen: intro + host for the hunt (js/hunt.js -> hunt-core.js). No map or list in the main app:
// discovery happens by walking. Once the hunt starts, the intro hides and the hunt's ring fills the screen.
import * as store from './echo-store.js';
import { startHunt } from './hunt.js';

export function mountListenScreen(root) {
  root.innerHTML = `
    <div class="listen" data-listen>
      <div class="listen-intro" data-intro>
        <div class="listen-orb" aria-hidden="true"><span></span><span></span><span></span></div>
        <h1>Listen</h1>
        <p class="muted">Walk. Your phone pings faster as you near an Echo. Point it to tune in.</p>
        <button class="btn primary big" data-start>Start listening</button>
        <p class="muted small">Headphones help · hold your phone upright, like a lantern</p>
      </div>
      <div class="listen-hunt" data-hunt-wrap hidden>
        <button class="listen-stop" data-stop aria-label="Stop listening">&times;</button>
        <div class="hunt-root" data-hunt></div>
        <p class="muted small listen-status" data-nearby role="status"></p>
      </div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const intro = $('[data-intro]'), wrap = $('[data-hunt-wrap]'), huntEl = $('[data-hunt]'), nearbyEl = $('[data-nearby]');
  let hunt = null;

  const onState = (s) => {
    const n = s.echoesCount ?? 0;
    nearbyEl.dataset.count = String(n);
    nearbyEl.dataset.status = s.status;
    nearbyEl.textContent = s.status === 'locating' || s.status === 'starting' ? ''
      : `${n} Echo${n === 1 ? '' : 'es'} within reach`;
  };

  function stop() {
    hunt?.stop(); hunt = null;
    wrap.hidden = true; intro.hidden = false; root.classList.remove('hunting');
  }

  $('[data-start]').addEventListener('click', () => {
    if (hunt) return;
    intro.hidden = true; wrap.hidden = false; root.classList.add('hunting');
    // startHunt runs its gesture-bound work (AudioContext, iOS compass permission, geolocation) synchronously
    // inside this tap, before its first await. Do NOT await anything before calling it.
    startHunt(huntEl, { store, onState }).then((h) => { hunt = h; }, (e) => {
      console.error('[listen] hunt failed to start', e);
      stop(); intro.querySelector('.muted').textContent = `Couldn't start listening: ${e.message || e}`;
    });
  });
  $('[data-stop]').addEventListener('click', stop);

  return { hide() { stop(); } };
}
