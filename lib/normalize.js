'use strict';
// Turns whatever shape the upstream API returns into one clean draw object:
//   { date: 'YYYY-MM-DD', numbers: [n1..n5 sorted], powerball: n, multiplier: n|null }

const pick = (o, keys) => {
  for (const k of keys) {
    const hit = Object.keys(o).find((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '') === k);
    if (hit !== undefined && o[hit] !== null && o[hit] !== '') return o[hit];
  }
  return undefined;
};

function toNumbers(v) {
  if (Array.isArray(v)) return v.map(Number).filter(Number.isFinite);
  if (typeof v === 'string') return (v.match(/\d+/g) || []).map(Number);
  return [];
}

function toISODate(v) {
  if (!v) return null;
  const s = String(v);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function normalizeDraw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = toISODate(pick(raw, ['date', 'drawdate', 'drawingdate', 'drawing', 'day']));
  let nums = toNumbers(pick(raw, ['numbers', 'winningnumbers', 'winningnumber', 'whiteballs', 'main', 'result']));
  if (nums.length < 5) {
    const seq = [1, 2, 3, 4, 5].map((i) => pick(raw, [`n${i}`, `number${i}`, `ball${i}`, `white${i}`]));
    if (seq.every((x) => x !== undefined)) nums = seq.map(Number);
  }
  let pb = pick(raw, ['powerball', 'pb', 'redball', 'bonus', 'bonusball', 'power']);
  pb = pb === undefined ? undefined : Number(Array.isArray(pb) ? pb[0] : pb);
  if ((pb === undefined || !Number.isFinite(pb)) && nums.length === 6) pb = nums.pop();
  nums = nums.slice(0, 5);
  if (!date || nums.length !== 5 || !Number.isFinite(pb)) return null;
  const mRaw = pick(raw, ['multiplier', 'powerplay', 'mult']);
  const mult = mRaw === undefined ? null : Number(String(mRaw).replace(/[^0-9.]/g, '')) || null;
  return { date, numbers: nums.sort((a, b) => a - b), powerball: pb, multiplier: mult };
}

function extractList(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    for (const k of ['data', 'results', 'drawings', 'draws', 'items', 'result']) {
      if (Array.isArray(body[k])) return body[k];
      if (body[k] && typeof body[k] === 'object') {
        const inner = extractList(body[k]);
        if (inner.length) return inner;
      }
    }
    return [body];
  }
  return [];
}

function normalizeResponse(body) {
  const seen = new Set();
  return extractList(body)
    .map(normalizeDraw)
    .filter(Boolean)
    .filter((d) => (seen.has(d.date) ? false : seen.add(d.date)))
    .sort((a, b) => b.date.localeCompare(a.date));
}

module.exports = { normalizeDraw, normalizeResponse, toISODate };
