'use strict';
/**
 * Powerball Explorer - backend
 * - Serves the static frontend from /public
 * - Proxies the Powerball API (RapidAPI) so the API key never reaches the browser
 * - Caches responses, validates input, handles upstream errors gracefully
 * - Adds an X-Served-By header so you can see which web server (Web01/Web02) answered
 * Zero npm dependencies: only Node.js built-ins (Node 18+).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadEnv } = require('./lib/env');
const { normalizeResponse, normalizeDraw } = require('./lib/normalize');
const { buildMock } = require('./lib/mock');

loadEnv();

const cfg = () => ({
  port: Number(process.env.PORT) || 3000,
  base: (process.env.API_BASE_URL || 'https://powerball.p.rapidapi.com').replace(/\/$/, ''),
  key: process.env.API_KEY || '',
  keyHeader: process.env.API_KEY_HEADER || 'x-api-key',
  host: process.env.API_HOST || '',
  ttl: (Number(process.env.CACHE_TTL) || 300) * 1000,
  mock: String(process.env.USE_MOCK).toLowerCase() === 'true' || !process.env.API_KEY,
  paths: {
    latest: process.env.PATH_LATEST || '/Latest',
    latest10: process.env.PATH_LATEST10 || '/Latest10',
    all: process.env.PATH_ALL || '/AllDrawings',
    byDate: process.env.PATH_BY_DATE || '/Drawing/{date}',
    between: process.env.PATH_BETWEEN || '/DrawingsBetween/{first_date}/{second_date}',
  },
});

const SERVER_NAME = process.env.SERVER_NAME || os.hostname();
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
};

/* ---------- small helpers ---------- */
class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || 'error'; }
}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z')) &&
  new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

const cache = new Map(); // key -> { at, value }

/* ---------- upstream access ---------- */
async function callUpstream(template, params = {}) {
  const c = cfg();
  let p = template;
  for (const [k, v] of Object.entries(params)) p = p.replace(`{${k}}`, encodeURIComponent(v));
  const url = c.base + p;
  const headers = { Accept: 'application/json', [c.keyHeader]: c.key };
  if (c.host) headers['X-RapidAPI-Host'] = c.host;

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 401 || res.status === 403)
        throw new ApiError(502, 'The API rejected our key (401/403). Check API_KEY, API_KEY_HEADER and your RapidAPI subscription.', 'auth');
      if (res.status === 404) throw new ApiError(404, 'No data found for that request (404).', 'not_found');
      if (res.status === 429) throw new ApiError(429, 'API rate limit reached. Please wait a moment and try again.', 'rate_limit');
      if (res.status >= 500) throw new ApiError(502, `The Powerball API is having problems (HTTP ${res.status}).`, 'upstream');
      if (!res.ok) throw new ApiError(502, `Unexpected API response (HTTP ${res.status}).`, 'upstream');
      const text = await res.text();
      try { return JSON.parse(text); }
      catch { throw new ApiError(502, 'The API returned invalid (non-JSON) data.', 'bad_json'); }
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof ApiError) {
        if (e.code !== 'upstream') throw e; // only retry server-side failures
        lastErr = e;
      } else if (e.name === 'AbortError') lastErr = new ApiError(504, 'The API took too long to answer (timeout).', 'timeout');
      else lastErr = new ApiError(502, 'Could not reach the Powerball API (network error).', 'network');
    }
  }
  throw lastErr;
}

/** Fetch + normalize + cache. Falls back to stale cache if the API is down. */
async function getDraws(cacheKey, template, params, mockFn) {
  const c = cfg();
  if (c.mock) return { draws: mockFn(buildMock()), source: 'demo' };

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < c.ttl) return { draws: hit.value, source: 'cache' };
  try {
    const body = await callUpstream(template, params);
    const draws = normalizeResponse(body);
    if (!draws.length) throw new ApiError(404, 'The API returned no recognisable drawings for this request.', 'empty');
    cache.set(cacheKey, { at: Date.now(), value: draws });
    return { draws, source: 'live' };
  } catch (e) {
    if (hit && ['upstream', 'network', 'timeout', 'rate_limit'].includes(e.code))
      return { draws: hit.value, source: 'stale-cache', warning: e.message + ' Showing previously saved results.' };
    throw e;
  }
}

/* ---------- ticket checker (Powerball prize table) ---------- */
function prize(whiteMatches, pbMatch) {
  const t = { '5-1': ['JACKPOT', 'Jackpot'], '5-0': ['$1,000,000', '$1,000,000'], '4-1': ['$50,000', '$50,000'],
    '4-0': ['$100', '$100'], '3-1': ['$100', '$100'], '3-0': ['$7', '$7'], '2-1': ['$7', '$7'], '1-1': ['$4', '$4'], '0-1': ['$4', '$4'] };
  const hit = t[`${whiteMatches}-${pbMatch ? 1 : 0}`];
  return hit ? hit[0] : null;
}

function parseTicket(q) {
  const numbers = String(q.numbers || '').split(',').map((s) => Number(s.trim()));
  const pb = Number(q.powerball);
  if (numbers.length !== 5 || numbers.some((n) => !Number.isInteger(n) || n < 1 || n > 69))
    throw new ApiError(400, 'Enter exactly 5 white numbers between 1 and 69.', 'validation');
  if (new Set(numbers).size !== 5) throw new ApiError(400, 'White numbers must all be different.', 'validation');
  if (!Number.isInteger(pb) || pb < 1 || pb > 26) throw new ApiError(400, 'Powerball must be between 1 and 26.', 'validation');
  if (!isDate(q.date || '')) throw new ApiError(400, 'Enter the draw date as YYYY-MM-DD.', 'validation');
  return { numbers: numbers.sort((a, b) => a - b), pb, date: q.date };
}

/* ---------- API routes ---------- */
const routes = {
  '/api/health': async () => ({ status: 'ok', server: SERVER_NAME, mode: cfg().mock ? 'demo' : 'live', time: new Date().toISOString() }),

  '/api/latest': async () => {
    const r = await getDraws('latest', cfg().paths.latest, {}, (m) => m.slice(0, 1));
    return pack(r, r.draws.slice(0, 1));
  },
  '/api/latest10': async () => {
    const r = await getDraws('latest10', cfg().paths.latest10, {}, (m) => m.slice(0, 10));
    return pack(r, r.draws.slice(0, 10));
  },
  '/api/all': async () => {
    const r = await getDraws('all', cfg().paths.all, {}, (m) => m);
    return pack(r, r.draws);
  },
  '/api/between': async (q) => {
    if (!isDate(q.from || '') || !isDate(q.to || '')) throw new ApiError(400, 'Both dates must be valid and formatted YYYY-MM-DD.', 'validation');
    if (q.from > q.to) throw new ApiError(400, 'The start date must be before the end date.', 'validation');
    const r = await getDraws(`between:${q.from}:${q.to}`, cfg().paths.between, { first_date: q.from, second_date: q.to },
      (m) => m.filter((d) => d.date >= q.from && d.date <= q.to));
    return pack(r, r.draws.filter((d) => d.date >= q.from && d.date <= q.to));
  },
  '/api/date': async (q) => {
    if (!isDate(q.date || '')) throw new ApiError(400, 'Date must be valid and formatted YYYY-MM-DD.', 'validation');
    const r = await getDraws(`date:${q.date}`, cfg().paths.byDate, { date: q.date }, (m) => m.filter((d) => d.date === q.date));
    const one = r.draws.filter((d) => d.date === q.date);
    if (!one.length) throw new ApiError(404, `No Powerball drawing took place on ${q.date}. Draws are held Mon, Wed and Sat.`, 'not_found');
    return pack(r, one);
  },
  '/api/check': async (q) => {
    const t = parseTicket(q);
    const r = await getDraws(`date:${t.date}`, cfg().paths.byDate, { date: t.date }, (m) => m.filter((d) => d.date === t.date));
    const draw = r.draws.find((d) => d.date === t.date);
    if (!draw) throw new ApiError(404, `No Powerball drawing took place on ${t.date}. Draws are held Mon, Wed and Sat.`, 'not_found');
    const matched = t.numbers.filter((n) => draw.numbers.includes(n));
    const pbMatch = t.pb === draw.powerball;
    const won = prize(matched.length, pbMatch);
    return { ...meta(r), ticket: t, draw, matched, powerballMatch: pbMatch, prize: won, won: Boolean(won) };
  },
  '/api/quickpick': async () => {
    const set = new Set();
    while (set.size < 5) set.add(1 + Math.floor(Math.random() * 69));
    return { server: SERVER_NAME, numbers: [...set].sort((a, b) => a - b), powerball: 1 + Math.floor(Math.random() * 26) };
  },
};

function meta(r) { return { server: SERVER_NAME, source: r.source, warning: r.warning || null }; }
function pack(r, draws) { return { ...meta(r), count: draws.length, draws }; }

/* ---------- HTTP server ---------- */
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Served-By': SERVER_NAME,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Served-By': SERVER_NAME,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:",
    });
    res.end(buf);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      const handler = routes[url.pathname];
      if (handler) {
        const q = Object.fromEntries(url.searchParams);
        return send(res, 200, await handler(q));
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Unknown API route', code: 'not_found' });
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { error: e.message, code: e.code });
      console.error(e);
      return send(res, 500, { error: 'Something went wrong on the server.', code: 'server' });
    }
  });
}

if (require.main === module) {
  const c = cfg();
  createServer().listen(c.port, '0.0.0.0', () =>
    console.log(`Powerball Explorer on http://0.0.0.0:${c.port}  [${SERVER_NAME}]  mode=${c.mock ? 'DEMO DATA' : 'LIVE API'}`));
}
module.exports = { createServer, prize, normalizeDraw };
