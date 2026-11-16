// Time capsules: hidden until unlock_at; the 24 h life starts when it opens. Server: 1 min < unlock <= 365 days.
export const CAPSULE_MAX_DAYS = 365, MIN_LEAD_MS = 2 * 60 * 1000;   // 2 min client floor, 1 min server floor
const DAY = 864e5;

export function capsuleBounds(now = Date.now()) {
  return { min: new Date(now + MIN_LEAD_MS), max: new Date(now + CAPSULE_MAX_DAYS * DAY - 60e3) };
}
export function validateUnlockAt(value, now = Date.now()) {
  if (value == null || value === '') return { ok: true, unlockAt: null };
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return { ok: false, error: 'Pick a valid date' };
  const { min, max } = capsuleBounds(now);
  if (t < min.getTime()) return { ok: false, error: 'Pick a time at least a few minutes from now' };
  if (t > max.getTime()) return { ok: false, error: 'Capsules can open at most a year from now' };
  return { ok: true, unlockAt: new Date(t).toISOString() };
}
// Presets open at 9:00 local time on the target day (except 1 hour).
export function capsulePresets(now = new Date()) {
  const at9 = (days, months = 0, years = 0) => {
    const d = new Date(now); d.setFullYear(d.getFullYear() + years, d.getMonth() + months, d.getDate() + days); d.setHours(9, 0, 0, 0); return d;
  };
  const list = [
    { id: '1h', label: 'In 1 hour', at: new Date(now.getTime() + 3600e3) },
    { id: 'tomorrow', label: 'Tomorrow morning', at: at9(1) },
    { id: 'week', label: 'In a week', at: at9(7) },
    { id: 'month', label: 'In a month', at: at9(0, 1) },
    { id: 'year', label: 'In a year', at: at9(0, 0, 1) },
  ];
  return list.filter((p) => validateUnlockAt(p.at, now.getTime()).ok);
}
// value for <input type="datetime-local" min max>
export function toLocalInput(d) {
  d = new Date(d); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function opensIn(unlockAt, now = Date.now()) {
  const ms = new Date(unlockAt).getTime() - now;
  if (ms <= 0) return 'open now';
  const m = Math.round(ms / 60e3), h = Math.round(ms / 3600e3), d = Math.round(ms / DAY);
  return m < 60 ? `opens in ${m} min` : h < 48 ? `opens in ${h} h` : `opens in ${d} days`;
}
