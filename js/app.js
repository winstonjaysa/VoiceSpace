// App shell: tab routing (#record / #listen) + service worker registration.
import { mountRecordScreen } from './record.js';
import { mountListenScreen } from './listen.js';

const screens = {
  record: { el: document.getElementById('screen-record'), mount: mountRecordScreen, api: null },
  listen: { el: document.getElementById('screen-listen'), mount: mountListenScreen, api: null },
};

function show(name) {
  if (!screens[name]) name = 'record';
  for (const [key, sc] of Object.entries(screens)) {
    const active = key === name;
    if (active && !sc.api) sc.api = sc.mount(sc.el);
    if (!active) sc.api?.hide?.();
    sc.el.hidden = !active;
    document.querySelector(`.tabbar [data-tab="${key}"]`)?.setAttribute('aria-current', active ? 'page' : 'false');
  }
}

window.addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1) || 'record');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
