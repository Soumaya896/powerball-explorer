'use strict';

/**
 * Powerball Explorer - backend
 * Uses the DrawAnalytics public Powerball API.
 * Caches responses, validates input, and handles API errors.
 * Adds an X-Served-By header to identify Web01/Web02.
 * Zero npm dependencies: Node.js built-ins only.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadEnv } = require('./lib/env');
const { normalizeResponse, normalizeDraw } = require('./lib/normalize');
const { buildMock } = require('./lib/mock');

loadEnv();

const DEFAULT_API_BASE = 'https://www.drawanalytics.com/api/v1/california/powerball/results';
const PAGE_SIZE = 100;
const MAX_RESULTS = 5000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 2;

const cfg = () => ({
  port: Number(process.env.PORT) || 3000,
  base: (process.env.API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, ''),
  ttl: (Number(process.env.CACHE_TTL) || 300) * 1000,
  mock: String(process.env.USE_MOCK).toLowerCase() === 'true',
});

const SERVER_NAME = process.env.SERVER_NAME || os.hostname();
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const COMMON_HEADERS = {
  'X-Served-By': SERVER_NAME,
  'X-Content-Type-Options': 'nosniff',
};

const STATIC_CSP =
  "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:";

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

const validationError = (message) => new ApiError(400, message, 'validation');

const noDrawError = (date) =>
  new ApiError(404, `No Powerball drawing took place on ${date}.`, 'not_found');

const RETRYABLE_CODES = new Set(['upstream', 'timeout', 'network']);

const STABLE_FALLBACK_CODES = new Set([
  'upstream',
  'network',
  'timeout',
  'rate_limit',
]);

function isDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const parsed = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === s;
}

const randomInt = (min, max) =>
  min + Math.floor(Math.random() * (max - min + 1));

const cache = new Map();

function errorForStatus(status) {
  if (status === 404) {
    return new ApiError(
      404,
      'The DrawAnalytics endpoint was not found.',
      'not_found'
    );
  }
  if (status === 429) {
    return new ApiError(
      429,
      'The data service rate limit was reached. Please wait and try again.',
      'rate_limit'
    );
  }
  if (status >= 500) {
    return new ApiError(
      502,
      `The data service is having problems (HTTP ${status}).`,
      'upstream'
    );
  }
  return new ApiError(
    502,
    `Unexpected data service response (HTTP ${status}).`,
    'upstream'
  );
}

function toApiError(e) {
  if (e instanceof ApiError) return e;
  if (e.name === 'AbortError') {
    return new ApiError(
      504,
      'The data service took too long to answer.',
      'timeout'
    );
  }
  return new ApiError(502, 'Could not reach the public data service.', 'network');
}

async function requestOnce(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw errorForStatus(res.status);
  }

  const body = await res.json();

  if (body.success !== true || !Array.isArray(body.data)) {
    throw new ApiError(
      502,
      'The data service returned an unexpected response.',
      'bad_response'
    );
  }

  return body;
}

async function fetchPage(url) {
  let lastErr;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await requestOnce(url);
    } catch (e) {
      lastErr = toApiError(e);
      if (!RETRYABLE_CODES.has(lastErr.code)) throw lastErr;
    }
  }

  throw lastErr;
}

const QUERY_BUILDERS = {
  latest: () => ({ limit: 1, offset: 0 }),
  latest10: () => ({ limit: 10, offset: 0 }),
  all: () => ({ limit: PAGE_SIZE, offset: 0 }),
  date: ({ date }) => ({
    start_date: date,
    end_date: date,
    limit: PAGE_SIZE,
    offset: 0,
  }),
  between: ({ first_date, second_date }) => ({
    start_date: first_date,
    end_date: second_date,
    limit: PAGE_SIZE,
    offset: 0,
  }),
};

function buildUrl(base, query) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function callUpstream(kind, params = {}) {
  const { base } = cfg();

  const makeQuery = QUERY_BUILDERS[kind];
  if (!makeQuery) {
    throw new ApiError(500, 'Unknown data request.', 'configuration');
  }
  const query = makeQuery(params);

  const firstPage = await fetchPage(buildUrl(base, query));

  const results = [...firstPage.data];
  const total = Math.min(
    Number(firstPage.meta?.total) || results.length,
    MAX_RESULTS
  );

  for (let offset = PAGE_SIZE; offset < total; offset += PAGE_SIZE) {
    const page = await fetchPage(
      buildUrl(base, { ...query, limit: PAGE_SIZE, offset })
    );
    results.push(...page.data);
  }

  return { ...firstPage, data: results };
}

const specs = {
  latest: () => ({
    key: 'latest',
    kind: 'latest',
    params: {},
    narrow: (draws) => draws.slice(0, 1),
  }),
  latest10: () => ({
    key: 'latest10',
    kind: 'latest10',
    params: {},
    narrow: (draws) => draws.slice(0, 10),
  }),
  all: () => ({
    key: 'all',
    kind: 'all',
    params: {},
    narrow: (draws) => draws,
  }),
  between: (from, to) => ({
    key: `between:${from}:${to}`,
    kind: 'between',
    params: { first_date: from, second_date: to },
    narrow: (draws) => draws.filter((d) => d.date >= from && d.date <= to),
  }),
  onDate: (date) => ({
    key: `date:${date}`,
    kind: 'date',
    params: { date },
    narrow: (draws) => draws.filter((d) => d.date === date),
  }),
};

async function getDraws({ key, kind, params, narrow }) {
  const c = cfg();

  if (c.mock) {
    return { draws: narrow(buildMock()), source: 'demo' };
  }
  const cached = cache.get(key);

  if (cached && Date.now() - cached.at < c.ttl) {
    return { draws: cached.value, source: 'cache' };
  }

  try {
    const draws = normalizeResponse(await callUpstream(kind, params));

    if (!draws.length) {
      throw new ApiError(
        404,
        'The API returned no recognisable Powerball drawings.',
        'empty'
      );
    }

    cache.set(key, { at: Date.now(), value: draws });
    return { draws, source: 'live' };
  } catch (e) {
    if (cached && STABLE_FALLBACK_CODES.has(e.code)) {
      return {
        draws: cached.value,
        source: 'stale-cache',
        warning: `${e.message} Showing previously saved results.`,
      };
    }
    throw e;
  }
}

async function lookup(spec) {
  const result = await getDraws(spec);
  return { result, draws: spec.narrow(result.draws) };
}

const PRIZES = {
  '5-1': 'JACKPOT',
  '5-0': '$1,000,000',
  '4-1': '$50,000',
  '4-0': '$100',
  '3-1': '$100',
  '3-0': '$7',
  '2-1': '$7',
  '1-1': '$4',
  '0-1': '$4',
};

function prize(whiteMatches, pbMatch) {
  return PRIZES[`${whiteMatches}-${pbMatch ? 1 : 0}`] ?? null;
}

function parseTicket(q) {
  const numbers = String(q.numbers || '')
  .split(',')
  .map((s) => Number(s.trim()));
  const pb = Number(q.powerball);

  const outOfRange = (n) => !Number.isInteger(n) || n < 1 || n > 69;

  if (numbers.length !== 5 || numbers.some(outOfRange)) {
    throw validationError('Enter exactly 5 white numbers between 1 and 69.');
  }
  if (new Set(numbers).size !== 5) {
    throw validationError('White numbers must all be different.');
  }
  if (!Number.isInteger(pb) || pb < 1 || pb > 26) {
    throw validationError('Powerball must be between 1 and 26.');
  }
  if (!isDate(q.date || '')) {
    throw validationError('Enter the draw date as YYYY-MM-DD.');
  }

  return {
    numbers: numbers.sort((a, b) => a - b),
    pb,
    date: q.date,
  };
}

function meta(result) {
  return {
    server: SERVER_NAME,
    source: result.source,
    warning: result.warning || null,
  };
}

function pack(result, draws) {
  return {
    ...meta(result),
    count: draws.length,
    draws,
  };
}

const routes = {
  '/api/health': async () => ({
    status: 'ok',
    server: SERVER_NAME,
    mode: cfg().mock ? 'demo' : 'live',
    time: new Date().toISOString(),
  }),

  '/api/latest': async () => {
    const { result, draws } = await lookup(specs.latest());
    return pack(result, draws);
  },

  '/api/latest10': async () => {
    const { result, draws } = await lookup(specs.latest10());
    return pack(result, draws);
  },

  '/api/all': async () => {
    const { result, draws } = await lookup(specs.all());
    return pack(result, draws);
  },

  '/api/between': async (q) => {
    if (!isDate(q.from || '') || !isDate(q.to || '')) {
      throw validationError('Both dates must be valid and formatted YYYY-MM-DD.');
    }
    if (q.from > q.to) {
      throw validationError('The start date must be before the end date.');
    }

    const { result, draws } = await lookup(specs.between(q.from, q.to));
    return pack(result, draws);
  },

  '/api/date': async (q) => {
    if (!isDate(q.date || '')) {
      throw validationError('Date must be valid and formatted YYYY-MM-DD.');
    }

    const { result, draws } = await lookup(specs.onDate(q.date));
    if (!draws.length) throw noDrawError(q.date);

    return pack(result, draws);
  },

  '/api/check': async (q) => {
    const ticket = parseTicket(q);

    const { result, draws } = await lookup(specs.onDate(ticket.date));
    const [draw] = draws;
    if (!draw) throw noDrawError(ticket.date);

    const matched = ticket.numbers.filter((n) => draw.numbers.includes(n));
    const powerballMatch = ticket.pb === draw.powerball;
    const won = prize(matched.length, powerballMatch);

    return {
      ...meta(result),
      ticket,
      draw,
      matched,
      powerballMatch,
      prize: won,
      won: Boolean(won),
    };
  },

  '/api/quickpick': async () => {
    const whites = new Set();
    while (whites.size < 5) whites.add(randomInt(1,69));

    return {
      server: SERVER_NAME,
      numbers: [...whites].sort((a, b) => a - b),
      powerball: randomInt(1, 26),
    };
  },
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...COMMON_HEADERS,
    ...headers,
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));

  const insidePublic = 
  file.startsWith(PUBLIC_DIR + path.sep) || file === PUBLIC_DIR;
  if (!insidePublic) {
    return send(res, 403, { error: 'Forbidden' });
  }

  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      ...COMMON_HEADERS,
      'Content-Security-Policy': STATIC_CSP,
    });
    res.end(buf);
  });
}

function sendError(res, e) {
  if (e instanceof ApiError) {
    return send(res, e.status, { error: e.message, code: e.code });
  }

  console.error(e);
  return send(res, 500, {
    error: 'Something went wrong on the server.',
    code: 'server',
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, { error: 'Method not allowed' });
      }

      const handler = routes[url.pathname];
      if (handler) {
        const query = Object.fromEntries(url.searchParams);
        return send(res, 200, await handler(query));
      }

      if (url.pathname.startsWith('/api/')) {
        return send(res, 404, { error: 'Unknown API route', code: 'not_found' });
      }

      return serveStatic(req, res, url.pathname);
    } catch (e) {
      return sendError(res, e);
    }
  });
}

if (require.main === module) {
  const { port, mock } = cfg();

  createServer().listen(port, '0.0.0.0', () => {
    console.log(
      `Powerball Explorer on http://0.0.0.0:${port} ` +
      `[${SERVER_NAME}] mode=${mock ? 'DEMO DATA' : 'DRAWANALYTICS'}`
    );
  });
}

module.exports = {
  createServer,
  prize,
  normalizeDraw,
};
