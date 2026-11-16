import { combineFixes, distM } from '../js/precise-fix.js';
const truth = { lat: 43.6532, lng: -79.3832 }; let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
const m2deg = 1 / 111320;
let single = 0, combined = 0, N = 300, fails = 0;
for (let t = 0; t < N; t++) {
  const fixes = [];
  for (let i = 0; i < 8; i++) { const a = 8 + rnd() * 8, s = a / 1.5;
    fixes.push({ lat: truth.lat + gauss() * s * m2deg, lng: truth.lng + gauss() * s * m2deg / Math.cos(truth.lat * Math.PI / 180), accuracy: a }); }
  if (t % 3 === 0) fixes.push({ lat: truth.lat + 60 * m2deg, lng: truth.lng, accuracy: 25 }); // multipath jump
  single += distM(fixes[fixes.length - 1], truth);
  const c = combineFixes(fixes); combined += distM(c, truth);
}
const s = single / N, c = combined / N;
console.log(`mean error: latest single fix ${s.toFixed(1)} m, precise lock ${c.toFixed(1)} m`);
console.log(combineFixes([{ lat: 1, lng: 1, accuracy: 50 }]) === null ? 'rejects 50 m fix: ok' : (fails++, 'FAIL reject'));
if (!(c < s / 2)) { fails++; console.log('FAIL: not 2x better'); }
process.exit(fails ? 1 : 0);
