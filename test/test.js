'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.API_KEY = ''; // start in demo mode
const { createServer, prize } = require('../server');
const { normalizeResponse } = require('../lib/normalize');

let app, base;
test.before(async () => {
  app = createServer();
  await new Promise((r) => app.listen(0, r));
  base = `http://127.0.0.1:${app.address().port}`;
});
test.after(() => app.close());
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) }; };

test('serves the frontend and X-Served-By header', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('x-served-by'));
  assert.match(await r.text(), /Powerball Explorer/);
});
test('blocks path traversal', async () => {
  const r = await fetch(base + '/..%2f..%2fetc/passwd');
  assert.ok([403, 404].includes(r.status));
});
test('demo: latest10 returns 10 draws', async () => {
  const { status, body } = await get('/api/latest10');
  assert.equal(status, 200); assert.equal(body.count, 10); assert.equal(body.source, 'demo');
  assert.equal(body.draws[0].numbers.length, 5);
});
test('demo: between validates dates', async () => {
  assert.equal((await get('/api/between?from=abc&to=2025-01-01')).status, 400);
  assert.equal((await get('/api/between?from=2025-02-01&to=2025-01-01')).status, 400);
  const ok = await get('/api/between?from=2025-01-01&to=2025-01-31');
  assert.equal(ok.status, 200); assert.ok(ok.body.count > 0);
  assert.ok(ok.body.draws.every((d) => d.date >= '2025-01-01' && d.date <= '2025-01-31'));
});
test('demo: no drawing on a Tuesday -> 404 with friendly message', async () => {
  const r = await get('/api/date?date=2025-01-07');
  assert.equal(r.status, 404); assert.match(r.body.error, /Mon, Wed and Sat/);
});
test('ticket checker validates and scores', async () => {
  assert.equal((await get('/api/check?numbers=1,2,3&powerball=4&date=2025-01-06')).status, 400);
  assert.equal((await get('/api/check?numbers=1,1,2,3,4&powerball=4&date=2025-01-06')).status, 400);
  const draw = (await get('/api/date?date=2025-01-06')).body.draws[0];
  const r = await get(`/api/check?numbers=${draw.numbers.join(',')}&powerball=${draw.powerball}&date=2025-01-06`);
  assert.equal(r.body.prize, 'JACKPOT'); assert.equal(r.body.won, true);
});
test('prize table', () => {
  assert.equal(prize(5, false), '$1,000,000'); assert.equal(prize(0, true), '$4'); assert.equal(prize(2, false), null);
});
test('quickpick', async () => {
  const { body } = await get('/api/quickpick');
  assert.equal(new Set(body.numbers).size, 5); assert.ok(body.powerball >= 1 && body.powerball <= 26);
});
test('normalizer handles several response shapes', () => {
  const a = normalizeResponse({ data: [{ draw_date: '2025-08-02T00:00:00', winning_numbers: '05 10 20 30 40 12', multiplier: '3' }] });
  assert.deepEqual(a[0], { date: '2025-08-02', numbers: [5, 10, 20, 30, 40], powerball: 12, multiplier: 3 });
  const b = normalizeResponse({ Date: '08/02/2025', Numbers: [40, 5, 10, 20, 30], Powerball: 9 });
  assert.equal(b[0].date, '2025-08-02'); assert.equal(b[0].powerball, 9);
  assert.deepEqual(normalizeResponse({ foo: 'bar' }), []);
});

/* ---- live mode against a fake upstream API ---- */
test('live mode: success, caching, auth error, 500 + stale fallback, bad JSON', async () => {
  let mode = 'ok', hits = 0, lastKey = null;
  const up = http.createServer((req, res) => {
    hits++; lastKey = req.headers['x-api-key'];
    if (mode === '401') { res.writeHead(401); return res.end('{}'); }
    if (mode === '500') { res.writeHead(500); return res.end('oops'); }
    if (mode === 'junk') { res.writeHead(200); return res.end('<html>not json</html>'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ date: '2025-08-02', numbers: [1, 2, 3, 4, 5], powerball: 6, multiplier: 2 }]));
  });
  await new Promise((r) => up.listen(0, r));
  Object.assign(process.env, { API_KEY: 'secret123', API_BASE_URL: `http://127.0.0.1:${up.address().port}`, CACHE_TTL: '1' });

  let r = await get('/api/latest10');
  assert.equal(r.body.source, 'live'); assert.equal(lastKey, 'secret123'); assert.equal(r.body.count, 1);
  assert.ok(!JSON.stringify(r.body).includes('secret123'), 'key must never leak to the browser');

  r = await get('/api/latest10'); const before = hits;
  assert.equal(r.body.source, 'cache'); assert.equal(hits, before);

  await new Promise((r2) => setTimeout(r2, 1100)); // let cache expire
  mode = '500';
  r = await get('/api/latest10');
  assert.equal(r.body.source, 'stale-cache'); assert.ok(r.body.warning);

  mode = '401';
  r = await get('/api/all'); assert.equal(r.status, 502); assert.match(r.body.error, /rejected our key/);
  mode = 'junk';
  r = await get('/api/latest'); assert.equal(r.status, 502); assert.match(r.body.error, /invalid/);
  up.close(); delete process.env.CACHE_TTL;
  r = await get('/api/latest10/'); // trailing slash -> not an api route -> static 404
  assert.equal(r.status, 404);
});
