
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.USE_MOCK = 'true';

const { createServer, prize } = require('../server');
const { normalizeResponse } = require('../lib/normalize');

let app, base;

test.before(async () => {
  app = createServer();
  await new Promise((resolve) => app.listen(0, resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});

test.after(() => app.close());

const get = async (path) => {
  const response = await fetch(base + path);
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json().catch(() => null)
  };
};

test('serves frontend and server identity header', async () => {
  const response = await fetch(base + '/');
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('x-served-by'));
  assert.match(await response.text(), /Powerball Explorer/);
});

test('blocks path traversal', async () => {
  const response = await fetch(base + '/..%2f..%2fetc/passwd');
  assert.ok([403, 404].includes(response.status));
});

test('demo mode returns ten sample drawings', async () => {
  const { status, body } = await get('/api/latest10');
  assert.equal(status, 200);
  assert.equal(body.count, 10);
  assert.equal(body.source, 'demo');
  assert.equal(body.draws[0].numbers.length, 5);
});

test('date range validates input and filters results', async () => {
  assert.equal((await get('/api/between?from=abc&to=2025-01-01')).status, 400);
  assert.equal((await get('/api/between?from=2025-02-01&to=2025-01-01')).status, 400);

  const result = await get('/api/between?from=2025-01-01&to=2025-01-31');
  assert.equal(result.status, 200);
  assert.ok(result.body.draws.every(
    (draw) => draw.date >= '2025-01-01' && draw.date <= '2025-01-31'
  ));
});

test('ticket checker validates input and detects a jackpot match', async () => {
  assert.equal(
    (await get('/api/check?numbers=1,2,3&powerball=4&date=2025-01-06')).status,
    400
  );

  assert.equal(
    (await get('/api/check?numbers=1,1,2,3,4&powerball=4&date=2025-01-06')).status,
    400
  );

  const draw = (await get('/api/date?date=2025-01-06')).body.draws[0];

  const result = await get(
    `/api/check?numbers=${draw.numbers.join(',')}&powerball=${draw.powerball}&date=2025-01-06`
  );

  assert.equal(result.body.prize, 'JACKPOT');
  assert.equal(result.body.won, true);
});

test('prize table', () => {
  assert.equal(prize(5, false), '$1,000,000');
  assert.equal(prize(0, true), '$4');
  assert.equal(prize(2, false), null);
});

test('quick pick generates valid unique numbers', async () => {
  const { body } = await get('/api/quickpick');

  assert.equal(new Set(body.numbers).size, 5);
  assert.ok(body.numbers.every((n) => n >= 1 && n <= 69));
  assert.ok(body.powerball >= 1 && body.powerball <= 26);
});

test('normalizer handles the DrawAnalytics response format', () => {
  const draws = normalizeResponse([
    {
      draw_date: '2026-11-23',
      numbers: [7, 9, 27, 40, 58],
      bonus_ball: 19,
      multiplier: null
    }
  ]);

  assert.deepEqual(draws[0], {
    date: '2026-11-23',
    numbers: [7, 9, 27, 40, 58],
    powerball: 19,
    multiplier: null
  });
});

/* Test the DrawAnalytics API integration using a local fake endpoint. */
test('live mode fetches DrawAnalytics data, caches it and falls back to stale cache', async () => {
  let mode = 'ok';
  let hits = 0;
  let lastUrl = '';

  const upstream = http.createServer((req, res) => {
    hits++;
    lastUrl = req.url;

    if (mode === '500') {
      res.writeHead(500);
      return res.end('temporary error');
    }

    if (mode === 'junk') {
      res.writeHead(200);
      return res.end('<html>not JSON</html>');
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });

    res.end(JSON.stringify({
      success: true,
      data: [
        {
          draw_date: '2026-11-23',
          numbers: [7, 9, 27, 40, 58],
          bonus_ball: 19,
          multiplier: null
        }
      ],
      meta: {
        total: 1,
        limit: 10,
        offset: 0
      }
    }));
  });

  await new Promise((resolve) => upstream.listen(0, resolve));

  process.env.API_BASE_URL =
    `http://127.0.0.1:${upstream.address().port}/california/powerball/results`;

  process.env.CACHE_TTL = '1';
  process.env.USE_MOCK = 'false';

  try {
    let result = await get('/api/latest10');

    assert.equal(result.status, 200);
    assert.equal(result.body.source, 'live');
    assert.equal(result.body.count, 1);
    assert.match(lastUrl, /limit=10/);
    assert.match(lastUrl, /offset=0/);

    result = await get('/api/latest10');

    const before = hits;

    assert.equal(result.body.source, 'cache');
    assert.equal(hits, before);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    mode = '500';
    result = await get('/api/latest10');

    assert.equal(result.body.source, 'stale-cache');
    assert.ok(result.body.warning);

    mode = 'junk';

    await new Promise((resolve) => setTimeout(resolve, 1100));

    result = await get('/api/latest');

    assert.equal(result.status, 502);
    assert.match(result.body.error, /Could not reach|invalid/i);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));

    delete process.env.CACHE_TTL;
    delete process.env.API_BASE_URL;
    process.env.USE_MOCK = 'true';
  }
});
