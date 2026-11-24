'use strict';
/* Powerball Explorer - frontend logic (no frameworks, no inline scripts). */
const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 12;
const state = { draws: [], view: [], page: 1 };

/* ---------- helpers ---------- */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function ball(n, cls = '') { return el('span', 'ball ' + cls, String(n)); }
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = (iso) => DOW[new Date(iso + 'T00:00:00Z').getUTCDay()];

function showBanner(msg, kind = 'error') {
  const b = $('banner');
  b.textContent = msg; b.className = 'banner' + (kind === 'warn' ? ' warn' : ''); b.hidden = !msg;
}

async function api(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  let res;
  try {
    res = await fetch(`/api/${path}${qs ? '?' + qs : ''}`, { headers: { Accept: 'application/json' } });
  } catch {
    throw new Error('Cannot reach the server. Check your internet connection and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  const server = res.headers.get('X-Served-By');
  if (server) $('serverBadge').textContent = 'server: ' + server;
  if (!res.ok) throw new Error((data && data.error) || `Request failed (HTTP ${res.status}).`);
  return data;
}

/* ---------- tabs ---------- */
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== 'tab-' + t.dataset.tab));
  if (t.dataset.tab === 'stats') renderStats();
}));

/* ---------- loading drawings ---------- */
function syncSourceInputs() {
  const s = $('source').value;
  $('fromWrap').hidden = $('toWrap').hidden = s !== 'between';
  $('dateWrap').hidden = s !== 'date';
}
$('source').addEventListener('change', syncSourceInputs);

async function loadDraws() {
  const s = $('source').value;
  const btn = $('loadBtn');
  btn.disabled = true; showBanner('');
  $('status').textContent = 'Loading drawings…';
  try {
    let data;
    if (s === 'between') {
      if (!$('fromDate').value || !$('toDate').value) throw new Error('Please choose both a start and an end date.');
      data = await api('between', { from: $('fromDate').value, to: $('toDate').value });
    } else if (s === 'date') {
      if (!$('oneDate').value) throw new Error('Please choose a date.');
      data = await api('date', { date: $('oneDate').value });
    } else data = await api(s);
    state.draws = data.draws;
    if (data.warning) showBanner(data.warning, 'warn');
    setMode(data.source);
    populateFilters();
    applyFilters();
  } catch (e) {
    state.draws = []; applyFilters();
    showBanner(e.message);
    $('status').textContent = '';
  } finally { btn.disabled = false; }
}
$('loadBtn').addEventListener('click', loadDraws);

function setMode(source) {
  const b = $('modeBadge');
  const demo = source === 'demo';
  b.textContent = demo ? 'Demo data (no API key set)' : 'Live API data' + (source === 'cache' ? ' (cached)' : source === 'stale-cache' ? ' (saved copy)' : '');
  b.className = 'badge ' + (demo ? 'demo' : 'live');
}

/* ---------- filters / sort / search ---------- */
function fillSelect(sel, values, label) {
  const keep = sel.value;
  sel.replaceChildren(new Option(label, ''));
  values.forEach((v) => sel.add(new Option(v, v)));
  if (values.map(String).includes(keep)) sel.value = keep;
}
function populateFilters() {
  const uniq = (arr) => [...new Set(arr)];
  fillSelect($('pbFilter'), uniq(state.draws.map((d) => d.powerball)).sort((a, b) => a - b), 'Any');
  fillSelect($('multFilter'), uniq(state.draws.map((d) => d.multiplier).filter(Boolean)).sort((a, b) => a - b).map((m) => m), 'Any');
  fillSelect($('yearFilter'), uniq(state.draws.map((d) => d.date.slice(0, 4))).sort().reverse(), 'Any');
}

function applyFilters() {
  const q = $('search').value.trim();
  const pb = $('pbFilter').value, mult = $('multFilter').value, year = $('yearFilter').value;
  let list = state.draws.filter((d) => {
    if (pb && String(d.powerball) !== pb) return false;
    if (mult && String(d.multiplier) !== mult) return false;
    if (year && !d.date.startsWith(year)) return false;
    if (q) {
      const hay = [d.date, ...d.numbers, d.powerball].join(' ');
      return q.split(/[\s,]+/).filter(Boolean).every((tok) => hay.includes(tok));
    }
    return true;
  });
  const [key, dir] = $('sortBy').value.split('-');
  const val = { date: (d) => d.date, pb: (d) => d.powerball, sum: (d) => d.numbers.reduce((a, b) => a + b, 0) }[key];
  list.sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * (dir === 'asc' ? 1 : -1));
  state.view = list; state.page = 1;
  renderResults();
}
['search', 'pbFilter', 'multFilter', 'yearFilter', 'sortBy'].forEach((id) =>
  $(id).addEventListener(id === 'search' ? 'input' : 'change', applyFilters));
$('resetBtn').addEventListener('click', () => {
  $('search').value = ''; ['pbFilter', 'multFilter', 'yearFilter'].forEach((i) => ($(i).value = ''));
  $('sortBy').value = 'date-desc'; applyFilters();
});

/* ---------- rendering ---------- */
function drawCard(d) {
  const c = el('article', 'draw');
  const row = el('div', 'row');
  const left = el('div');
  left.append(el('span', 'date', d.date), el('span', 'dow', dow(d.date)));
  row.append(left);
  if (d.multiplier) row.append(el('span', 'mult', `Power Play ×${d.multiplier}`));
  const balls = el('div', 'balls');
  d.numbers.forEach((n) => balls.append(ball(n)));
  balls.append(ball(d.powerball, 'pb'));
  c.append(row, balls, el('div', 'meta', `Sum of white balls: ${d.numbers.reduce((a, b) => a + b, 0)}`));
  return c;
}

function renderResults() {
  const box = $('results'), total = state.view.length;
  box.replaceChildren();
  if (!state.draws.length) { $('status').textContent = $('banner').hidden ? 'No drawings loaded yet. Press "Load drawings".' : ''; $('pager').replaceChildren(); return; }
  if (!total) { $('status').textContent = 'No drawings match your filters.'; $('pager').replaceChildren(); return; }
  const pages = Math.ceil(total / PAGE_SIZE);
  state.page = Math.min(state.page, pages);
  state.view.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE).forEach((d) => box.append(drawCard(d)));
  $('status').textContent = `Showing ${total} of ${state.draws.length} drawings`;
  const p = $('pager'); p.replaceChildren();
  const prev = el('button', '', '← Prev'), next = el('button', '', 'Next →');
  prev.disabled = state.page <= 1; next.disabled = state.page >= pages;
  prev.onclick = () => { state.page--; renderResults(); };
  next.onclick = () => { state.page++; renderResults(); };
  p.append(prev, el('span', 'muted', `Page ${state.page} / ${pages}`), next);
}

/* ---------- statistics (computed from the loaded drawings) ---------- */
function bars(target, rows, cls = '') {
  target.replaceChildren();
  const max = Math.max(...rows.map((r) => r.value), 1);
  rows.forEach((r) => {
    const row = el('div', 'bar ' + cls);
    const track = el('div', 'track'), fill = el('div', 'fill');
    fill.style.width = (r.value / max) * 100 + '%';
    track.append(fill);
    row.append(el('span', '', String(r.label)), track, el('span', 'val', r.text || String(r.value)));
    target.append(row);
  });
}
function renderStats() {
  const ds = state.draws;
  ['hotChart', 'coldChart', 'pbChart', 'overdueChart'].forEach((i) => $(i).replaceChildren());
  if (!ds.length) { $('statsNote').textContent = 'Load some drawings first (Drawings tab). Tip: choose "All drawings" for the best statistics.'; return; }
  $('statsNote').textContent = `Based on ${ds.length} loaded drawing${ds.length === 1 ? '' : 's'} (${ds[ds.length - 1].date} → ${ds[0].date}).`;
  const white = new Map(), reds = new Map(), last = new Map();
  for (let n = 1; n <= 69; n++) white.set(n, 0);
  for (let n = 1; n <= 26; n++) reds.set(n, 0);
  const byNew = [...ds].sort((a, b) => b.date.localeCompare(a.date));
  byNew.forEach((d, i) => {
    d.numbers.forEach((n) => { white.set(n, (white.get(n) || 0) + 1); if (!last.has(n)) last.set(n, i); });
    reds.set(d.powerball, (reds.get(d.powerball) || 0) + 1);
  });
  const sorted = [...white].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  bars($('hotChart'), sorted.slice(0, 10).map(([n, c]) => ({ label: n, value: c, text: c + '×' })));
  bars($('coldChart'), sorted.slice(-10).reverse().map(([n, c]) => ({ label: n, value: c, text: c + '×' })));
  bars($('pbChart'), [...reds].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 10).map(([n, c]) => ({ label: n, value: c, text: c + '×' })), 'pbbar');
  const overdue = [...white.keys()].map((n) => ({ n, gap: last.has(n) ? last.get(n) : byNew.length }))
    .sort((a, b) => b.gap - a.gap || a.n - b.n).slice(0, 10);
  bars($('overdueChart'), overdue.map((o) => ({ label: o.n, value: o.gap, text: o.gap + ' draws' })));
}

/* ---------- ticket checker ---------- */
$('checkBtn').addEventListener('click', async () => {
  const out = $('checkResult'); out.replaceChildren();
  const btn = $('checkBtn'); btn.disabled = true;
  try {
    const r = await api('check', { numbers: $('tNums').value.replace(/\s+/g, ''), powerball: $('tPb').value, date: $('tDate').value });
    const box = el('div', 'result-box ' + (r.won ? 'win' : 'lose'));
    box.append(el('strong', '', r.won ? `🎉 Winner! Prize: ${r.prize}` : 'No prize this time.'));
    box.append(el('div', 'muted small', `Draw of ${r.draw.date}: ${r.matched.length} white ball(s) matched${r.powerballMatch ? ' + the Powerball' : ''}.`));
    const yours = el('div', 'balls'); yours.append(el('span', 'small muted', 'Your ticket:'));
    r.ticket.numbers.forEach((n) => yours.append(ball(n, r.matched.includes(n) ? 'hit' : '')));
    yours.append(ball(r.ticket.pb, 'pb' + (r.powerballMatch ? ' hit' : '')));
    const drawn = el('div', 'balls'); drawn.append(el('span', 'small muted', 'Winning numbers:'));
    r.draw.numbers.forEach((n) => drawn.append(ball(n)));
    drawn.append(ball(r.draw.powerball, 'pb'));
    box.append(yours, drawn);
    out.append(box);
    if (r.warning) showBanner(r.warning, 'warn');
  } catch (e) {
    const box = el('div', 'result-box'); box.append(el('span', '', '⚠️ ' + e.message)); out.append(box);
  } finally { btn.disabled = false; }
});

/* ---------- quick pick ---------- */
$('quickBtn').addEventListener('click', async () => {
  const box = $('quickBalls');
  try {
    const r = await api('quickpick');
    box.replaceChildren(...r.numbers.map((n) => ball(n, 'big')), ball(r.powerball, 'big pb'));
  } catch (e) { box.replaceChildren(el('span', 'muted', '⚠️ ' + e.message)); }
});

/* ---------- init ---------- */
(async function init() {
  syncSourceInputs();
  const today = new Date().toISOString().slice(0, 10);
  $('toDate').value = today; $('tDate').max = today; $('oneDate').max = today;
  const from = new Date(); from.setMonth(from.getMonth() - 1); $('fromDate').value = from.toISOString().slice(0, 10);
  try {
    const h = await api('health');
    $('modeBadge').textContent = h.mode === 'demo' ? 'Demo data (no API key set)' : 'Live API data';
    $('modeBadge').className = 'badge ' + (h.mode === 'demo' ? 'demo' : 'live');
    $('serverBadge').textContent = 'server: ' + h.server;
  } catch (e) { showBanner(e.message); }
  loadDraws();
})();
