'use strict';
// Deterministic demo data (Mon/Wed/Sat draws) used when no API key is set or USE_MOCK=true.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildMock(start = '2023-01-01') {
  const out = [];
  const end = new Date();
  for (let d = new Date(start + 'T00:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (![1, 3, 6].includes(d.getUTCDay())) continue;
    const date = d.toISOString().slice(0, 10);
    const r = rng(Number(date.replace(/-/g, '')));
    const set = new Set();
    while (set.size < 5) set.add(1 + Math.floor(r() * 69));
    out.push({
      date,
      numbers: [...set].sort((a, b) => a - b),
      powerball: 1 + Math.floor(r() * 26),
      multiplier: [2, 3, 4, 5, 10][Math.floor(r() * 5)],
    });
  }
  return out.reverse(); // newest first
}
module.exports = { buildMock };
