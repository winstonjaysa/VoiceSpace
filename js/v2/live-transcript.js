// Live transcript + tags captured WHILE recording (iPhone Safari can't transcribe a finished blob).
// const t = createLiveTranscript({ lang: 'en-US', onText });  t.start() with MediaRecorder.start(),
// const { transcript, tags } = t.stop({ caption }) with MediaRecorder.stop(). Never throws: no support => ''.
export const MAX_TAGS = 8, TRANSCRIPT_MAX = 2000;
const STOP = new Set(('a an and are as at be but by for from had has have he her his i if in into is it its just me my of on or our ' +
  'so that the their them then there they this to was we were what when where which who will with you your yeah um uh like ' +
  'okay ok really very here just got get going gonna im its dont thats').split(' '));

export function transcriptSupported(g = globalThis) {
  return !!(g.SpeechRecognition || g.webkitSpeechRecognition);
}

export function normalizeTag(t) {
  // ASCII only (accents stripped): Postgres [[:alnum:]] can reject non-ASCII depending on DB locale, which would fail the whole drop
  t = String(t ?? '').trim().replace(/^#+/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(t) ? t : null;
}

// #hashtags (spoken "hashtag X" too) first, then the most repeated meaningful words.
export function extractTags(text = '', { caption = '', max = MAX_TAGS, keywords = 3 } = {}) {
  const src = `${caption} ${text}`;
  const out = [];
  const add = (t) => { t = normalizeTag(t); if (t && !out.includes(t) && out.length < max) out.push(t); };
  for (const m of src.matchAll(/(?:#|\bhash ?tag\s+)([\p{L}\p{N}_-]{1,32})/giu)) add(m[1]);
  const counts = new Map();
  for (const w of src.toLowerCase().replace(/#[\p{L}\p{N}_-]+/gu, ' ').split(/[^\p{L}\p{N}'-]+/u)) {
    const k = w.replace(/^'+|'+$/g, '').replace(/'s$/, '');
    if (k.length < 4 || STOP.has(k) || /^\d+$/.test(k)) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  [...counts].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, keywords).forEach(([k]) => add(k));
  return out;
}

export function createLiveTranscript({ lang = globalThis.navigator?.language || 'en-US', onText, g = globalThis } = {}) {
  const SR = g.SpeechRecognition || g.webkitSpeechRecognition;
  let rec = null, finals = [], interim = '', running = false;
  const text = () => (finals.join(' ') + ' ' + interim).replace(/\s+/g, ' ').trim().slice(0, TRANSCRIPT_MAX);
  return {
    supported: !!SR,
    start() {
      if (!SR || running) return false;
      finals = []; interim = ''; running = true;
      try {
        rec = new SR(); rec.lang = lang; rec.continuous = true; rec.interimResults = true;
        rec.onresult = (e) => {
          interim = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i], s = r[0]?.transcript?.trim() || '';
            if (r.isFinal) { if (s) finals.push(s); } else interim += ' ' + s;
          }
          onText?.(text());
        };
        rec.onerror = () => {};            // mic denied / no-speech: keep recording audio, transcript stays ''
        rec.onend = () => { if (running) { try { rec.start(); } catch {} } };   // Chrome stops after silences
        rec.start();
        return true;
      } catch { running = false; return false; }
    },
    stop({ caption = '' } = {}) {
      running = false;
      try { rec?.stop(); } catch {}
      const transcript = text();
      return { transcript: transcript || null, tags: extractTags(transcript, { caption }) };
    },
    current: text,
  };
}
