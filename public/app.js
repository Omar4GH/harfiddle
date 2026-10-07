'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('hf-' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hf-' + k, JSON.stringify(v)); } catch {} },
};
const MAX_ROWS = 5000;
const IS_MAC = /Mac/.test(navigator.platform || navigator.userAgent);

const state = {
  sessions: new Map(), // id -> summary
  rows: new Map(), // id -> <tr>
  sel: new Set(),
  focus: null,
  anchor: null,
  detail: null,
  filter: '',
  show: 'all',
  keep: 0,
  hideConnects: store.get('hideConnects', false),
  settings: {},
  info: {},
  rules: [],
  sources: {},
  ruleFilter: '',
  selRule: null,
  ruleDetail: null,
  reqView: store.get('reqView', 'Headers'),
  resView: store.get('resView', 'TextView'),
  tab: store.get('tab', 'inspector'),
  filterTerms: [],
  keepFloor: 0, // highest session id dropped by Keep
  atBottom: null,
};

// ------------------------------------------------------------ api & status
async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { 'X-HarFiddle': '1' } };
  if (opts.json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
  else if (opts.body !== undefined) init.body = opts.body;
  const r = await fetch(path, init);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
let statusTimer;
function status(msg, err) {
  const el = $('#sbText');
  el.textContent = msg;
  el.classList.toggle('err', !!err);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.classList.remove('err'); renderStatusText(); }, err ? 8000 : 4000);
  appendLog({ ts: Date.now(), msg: (err ? 'ERROR: ' : '') + msg });
}
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); status(`Copied ${what} to the clipboard`); }
  catch { status('Clipboard is not available', true); }
}

// ------------------------------------------------------------ formatting
const n0 = (n) => (n == null ? '' : Number(n).toLocaleString('en-US'));
const pad = (n, w = 2) => String(n).padStart(w, '0');
function clock(ts) { if (!ts) return '—'; const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; }
function elapsed(ms) { ms = Math.max(0, ms | 0); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${h}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`; }
function ctOf(s) { return (s.contentType || '').split(';')[0].trim(); }
function hdrVal(pairs, name) { const p = (pairs || []).find(([k]) => k.toLowerCase() === name); return p ? p[1] : ''; }
function isConnect(s) { return s.method === 'CONNECT'; }

// ------------------------------------------------------------ session list
const COLS = [
  { key: 'id', label: '#', w: 58 },
  { key: 'result', label: 'Result', w: 52 },
  { key: 'method', label: 'Method', w: 62 },
  { key: 'protocol', label: 'Protocol', w: 60 },
  { key: 'host', label: 'Host', w: 170 },
  { key: 'url', label: 'URL', w: 260 },
  { key: 'ctype', label: 'Content-Type', w: 140 },
  { key: 'process', label: 'Process', w: 140 },
  { key: 'start', label: 'Start', w: 88 },
  { key: 'duration', label: 'Duration', w: 72, num: true },
  { key: 'reqsize', label: 'Req Size', w: 70, num: true },
  { key: 'body', label: 'Resp Size', w: 76, num: true },
  { key: 'caching', label: 'Caching', w: 110, hidden: true },
  { key: 'comments', label: 'Comments', w: 240 },
];
const fmtDur = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);
const CELL = {
  id: (s) => `<td class="c-id"><svg><use href="#${iconFor(s)}"/></svg>${s.id}</td>`,
  result: (s) => `<td>${s.source === 'pending' || s.source === 'aborted' ? '-' : esc(s.status || (s.source === 'error' ? '502' : '-'))}</td>`,
  method: (s) => `<td>${esc(s.method)}</td>`,
  protocol: (s) => `<td>${esc(s.protocol)}</td>`,
  host: (s) => `<td title="${esc(s.host)}">${isConnect(s) ? 'Tunnel to' : esc(s.host)}</td>`,
  url: (s) => `<td title="${esc(s.url)}">${esc(isConnect(s) ? s.host : s.path)}</td>`,
  ctype: (s) => `<td title="${esc(s.contentType)}">${esc(ctOf(s))}</td>`,
  process: (s) => `<td title="${esc(s.process)}">${esc(s.process)}</td>`,
  start: (s) => `<td title="${new Date(s.ts).toLocaleString()}">${clock(s.ts)}</td>`,
  duration: (s) => `<td class="num">${s.source === 'pending' ? '' : fmtDur(s.duration)}</td>`,
  reqsize: (s) => `<td class="num" title="Body ${n0(s.reqBodyBytes)} bytes + headers ${n0(s.reqHeaderBytes)} bytes">${isConnect(s) ? '' : n0(s.reqBodyBytes || 0)}</td>`,
  body: (s) => `<td class="num" title="${s.size !== s.resBodyBytes ? `${n0(s.resBodyBytes)} bytes on the wire, ${n0(s.size)} decoded` : `${n0(s.resBodyBytes)} bytes`} + headers ${n0(s.resHeaderBytes)} bytes">${s.source === 'pending' ? '-1' : isConnect(s) ? '' : n0(s.resBodyBytes ?? s.size)}</td>`,
  caching: (s) => `<td title="${esc(s.caching)}">${esc(s.caching)}</td>`,
  comments: (s) => `<td title="${esc(commentFor(s))}">${esc(commentFor(s))}</td>`,
};
let visibleCols = COLS;
function buildColumns() {
  const widths = store.get('colw', {});
  const hidden = new Set(store.get('colsHidden', COLS.filter((c) => c.hidden).map((c) => c.key)));
  visibleCols = COLS.filter((c) => !hidden.has(c.key));
  $('#sessCols').innerHTML = visibleCols.map((c) => `<col data-k="${c.key}" style="width:${widths[c.key] || c.w}px">`).join('');
  $('#sessHead').innerHTML = visibleCols.map((c) => `<th class="${c.num ? 'num' : ''}" data-k="${c.key}">${c.label}<span class="rs"></span></th>`).join('');
  fitTable();
}
// Fixed table width = sum of the columns, so long URLs get cut off instead of widening their column.
function fitTable() {
  const total = $$('#sessCols col').reduce((n, c) => n + (parseInt(c.style.width, 10) || 0), 0);
  $('#sessTable').style.width = total + 'px';
}
function setColumnHidden(key, hide) {
  const hidden = new Set(store.get('colsHidden', COLS.filter((c) => c.hidden).map((c) => c.key)));
  hide ? hidden.add(key) : hidden.delete(key);
  if (hidden.size >= COLS.length) return;
  store.set('colsHidden', [...hidden]);
  buildColumns();
  for (const [id, tr] of state.rows) paintRow(tr, state.sessions.get(id));
}
$('#sessHead').addEventListener('mousedown', (e) => {
  const rs = e.target.closest('.rs');
  if (!rs) return;
  e.preventDefault();
  const k = rs.parentElement.dataset.k;
  const col = $(`#sessCols col[data-k="${k}"]`);
  const x0 = e.clientX, w0 = col.getBoundingClientRect().width;
  const move = (ev) => { col.style.width = Math.max(30, w0 + ev.clientX - x0) + 'px'; fitTable(); };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    const w = store.get('colw', {});
    w[k] = parseInt(col.style.width, 10);
    store.set('colw', w);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});
// right-click the header: choose columns (Fiddler's "Customize Columns")
$('#sessHead').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  closeMenus();
  const m = $('#colmenu');
  const shown = new Set(visibleCols.map((c) => c.key));
  m.innerHTML = COLS.filter((c) => c.key !== 'id').map((c) => `<button data-col="${c.key}" class="${shown.has(c.key) ? 'checked' : ''}">${c.label}</button>`).join('') +
    '<hr><button data-col-reset>Reset columns</button>';
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, innerWidth - r.width - 4) + 'px';
  m.style.top = Math.min(e.clientY, innerHeight - r.height - 4) + 'px';
});
$('#colmenu').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $('#colmenu').hidden = true;
  if (b.hasAttribute('data-col-reset')) {
    store.set('colsHidden', COLS.filter((c) => c.hidden).map((c) => c.key));
    store.set('colw', {});
    buildColumns();
    for (const [id, tr] of state.rows) paintRow(tr, state.sessions.get(id));
    return;
  }
  setColumnHidden(b.dataset.col, b.classList.contains('checked'));
});

function iconFor(s) {
  if (s.source === 'pending') return 'i-pending';
  if (s.source === 'auto') return 'i-bolt';
  if (isConnect(s)) return s.source === 'error' ? 'i-err' : 'i-lock';
  if (s.source === 'aborted') return 'i-block';
  if (s.source === 'error') return 'i-err';
  if (s.source === 'blocked') return 'i-block';
  if (s.status === 101) return 'i-ws';
  if (s.status === 304) return 'i-304';
  if (s.status >= 300 && s.status < 400) return 'i-redir';
  if (s.status >= 400) return 'i-err';
  const ct = ctOf(s);
  if (/^image\//.test(ct)) return 'i-img';
  if (/html/.test(ct)) return 'i-html';
  if (/javascript|ecmascript/.test(ct)) return 'i-js';
  if (/css/.test(ct)) return 'i-css';
  if (/json/.test(ct)) return 'i-json';
  if (s.source === 'har') return 'i-har';
  return 'i-doc';
}
function colorClass(s) {
  if (isConnect(s)) return s.source === 'error' ? 'k-red' : 'k-gray';
  if (s.source === 'aborted') return 'k-gray';
  if (s.source === 'error' || s.source === 'blocked' || s.status >= 400) return 'k-red';
  if (s.status === 304) return 'k-gray';
  const ct = ctOf(s);
  if (/html/.test(ct)) return 'k-blue';
  if (/javascript|ecmascript/.test(ct)) return 'k-green';
  if (/css/.test(ct)) return 'k-purple';
  if (/^image\//.test(ct)) return 'k-gray';
  return '';
}
function commentFor(s) {
  if (s.source === 'auto') {
    if (s.ruleAction) return `AutoResponder: ${s.ruleAction}`;
    return s.ruleSource ? `AutoResponder: ${s.ruleSource}` : s.note || 'AutoResponder';
  }
  if (s.error) return s.error;
  if (s.source === 'har') return s.note || 'Imported';
  if (s.source === 'blocked') return s.note || 'No AutoResponder rule matched';
  if (s.ruleId && s.note) return s.note;
  return s.note || (s.mode === 'direct' ? 'Direct request' : '');
}
function rowHtml(s) {
  return visibleCols.map((c) => CELL[c.key](s)).join('');
}
function rowMatches(s) {
  if (state.hideConnects && isConnect(s)) return false;
  if (state.show === 'auto' && s.source !== 'auto') return false;
  if (state.show === 'live' && !(s.source === 'live' || s.source === 'tunnel' || s.source === 'pending' || s.source === 'aborted')) return false;
  if (state.show === 'har' && s.source !== 'har') return false;
  if (state.show === 'marked' && !s.mark) return false;
  if (state.show === 'error' && !(s.source === 'error' || s.source === 'blocked' || s.status >= 400)) return false;
  if (!state.filterTerms.length) return true;
  return state.filterTerms.every((t) => matchTerm(s, t) !== t.neg);
}

// ------------------------------------------------------------ search / filter
// "host:api status:4xx -process:chrome login" → every term must match (a leading - excludes).
const FILTER_FIELDS = { host: 'host', domain: 'host', path: 'url', url: 'url', process: 'process', proc: 'process', app: 'process', method: 'method', status: 'status', code: 'status', type: 'type', ct: 'type', source: 'source', mark: 'mark' };
function parseFilter(text) {
  const terms = [];
  for (const m of String(text || '').matchAll(/(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g)) {
    let [, neg, field, quoted, word] = m;
    let value = (quoted ?? word ?? '').toLowerCase();
    if (field && !FILTER_FIELDS[field.toLowerCase()]) { value = `${field}:${value}`.toLowerCase(); field = null; } // e.g. "https:" in a pasted URL
    if (!value) continue;
    const t = { neg: !!neg, field: field ? FILTER_FIELDS[field.toLowerCase()] : null, value };
    if (t.field === 'status') t.re = new RegExp('^' + value.replace(/[^\dx]/g, '').replace(/x/g, '\\d') + (value.length < 3 && !/x/.test(value) ? '' : '$'));
    terms.push(t);
  }
  return terms;
}
function matchTerm(s, t) {
  const has = (v) => String(v ?? '').toLowerCase().includes(t.value);
  switch (t.field) {
    case 'host': return has(s.host);
    case 'url': return has(s.url);
    case 'process': return has(s.process);
    case 'method': return String(s.method).toLowerCase() === t.value || has(s.method) && t.value.length > 2;
    case 'status': return t.re.test(String(s.status || ''));
    case 'type': return has(s.contentType);
    case 'source': return has(s.source);
    case 'mark': return has(s.mark);
    default: return `${s.id} ${s.method} ${s.url} ${s.status} ${s.source} ${s.contentType} ${s.process} ${s.mark || ''} ${commentFor(s)}`.toLowerCase().includes(t.value);
  }
}
function setFilter(text) {
  state.filter = String(text || '').trim();
  state.filterTerms = parseFilter(state.filter);
  const box = $('#search');
  if (box.value.trim() !== state.filter) box.value = state.filter;
  box.parentElement.classList.toggle('active', !!state.filter);
  applyFilter();
  renderSearchCount();
}
function renderSearchCount() {
  const el = $('#searchCount');
  el.textContent = state.filter ? `${n0(visibleIds().length)} of ${n0(state.sessions.size)}` : '';
}
$('#search').addEventListener('input', (e) => setFilter(e.target.value));
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.stopPropagation(); setFilter(''); $('#sessWrap').focus(); }
  else if (e.key === 'Enter' || e.key === 'ArrowDown') { // jump into the results
    e.preventDefault();
    const first = visibleIds()[0];
    if (first != null) { state.anchor = first; select([first], first, { scroll: true }); $('#sessWrap').focus(); }
  }
});
function focusSearch() { const box = $('#search'); box.focus(); box.select(); }
function paintRow(tr, s) {
  tr.innerHTML = rowHtml(s);
  tr.className = [colorClass(s), s.source === 'auto' ? 'r-auto' : '', s.mark ? 'mk mk-' + s.mark : '', state.sel.has(s.id) ? 'sel' : ''].filter(Boolean).join(' ');
  tr.hidden = !rowMatches(s);
}
function upsertSession(s) {
  let tr = state.rows.get(s.id);
  if (!tr && s.id <= state.keepFloor) return; // a late update for a session the Keep limit already dropped
  state.sessions.set(s.id, s);
  const wrap = $('#sessWrap');
  // reading the scroll position forces a layout, so do it once per frame of updates, not per row
  if (state.atBottom == null) {
    state.atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 24;
    setTimeout(() => { if (state.atBottom) wrap.scrollTop = wrap.scrollHeight; state.atBottom = null; }, 0);
  }
  if (!tr) {
    tr = document.createElement('tr');
    tr.dataset.id = s.id;
    state.rows.set(s.id, tr);
    $('#sessBody').appendChild(tr);
    enforceKeep();
  }
  paintRow(tr, s);
  if (s.id === state.focus && s.source !== 'pending' && state.detail && state.detail.source === 'pending') loadDetail(s.id);
  if (composerWaiting === s.id && s.source !== 'pending') composerDone(s.id);
  scheduleChrome();
}
function dropRows(ids) {
  let selectionTouched = false;
  for (const id of ids) {
    if (!state.rows.has(id)) continue;
    state.rows.get(id).remove();
    state.rows.delete(id);
    state.sessions.delete(id);
    if (state.sel.delete(id)) selectionTouched = true;
    if (state.anchor === id) state.anchor = null;
    if (state.focus === id) {
      selectionTouched = true;
      state.focus = [...state.sel].pop() ?? null; // keep inspecting another selected session if there is one
      state.detail = null;
    }
  }
  if (selectionTouched) onSelectionChanged();
  else scheduleChrome();
}
// Keep: N drops the oldest sessions, here and in the engine (so Save and reloads agree with the list)
function enforceKeep() {
  const limit = state.keep || MAX_ROWS;
  if (state.rows.size <= limit) return;
  const extra = [...state.rows.keys()].slice(0, state.rows.size - limit);
  state.keepFloor = Math.max(state.keepFloor, ...extra);
  dropRows(extra);
  if (state.keep) api('/api/sessions', { method: 'DELETE', json: { ids: extra } }).catch(() => {});
}
function applyFilter() {
  for (const [id, tr] of state.rows) tr.hidden = !rowMatches(state.sessions.get(id));
  const hidden = [...state.sel].filter((id) => state.rows.get(id)?.hidden);
  if (hidden.length) { // never act on sessions the user can't see
    hidden.forEach((id) => { state.sel.delete(id); state.rows.get(id).classList.remove('sel'); });
    if (!state.sel.has(state.focus)) state.focus = [...state.sel].pop() ?? null;
    onSelectionChanged();
  }
  scheduleChrome();
}
async function loadSessions() {
  const list = await api('/api/sessions');
  const body = $('#sessBody');
  body.innerHTML = '';
  state.rows.clear();
  state.sessions.clear();
  state.keepFloor = 0;
  const frag = document.createDocumentFragment();
  for (const s of list) {
    state.sessions.set(s.id, s);
    const tr = document.createElement('tr');
    tr.dataset.id = s.id;
    state.rows.set(s.id, tr);
    paintRow(tr, s);
    frag.appendChild(tr);
  }
  body.appendChild(frag);
  enforceKeep();
  $('#sessWrap').scrollTop = $('#sessWrap').scrollHeight;
  for (const id of [...state.sel]) if (!state.sessions.has(id)) state.sel.delete(id);
  if (state.focus != null && !state.sessions.has(state.focus)) state.focus = [...state.sel].pop() ?? null;
  if (state.anchor != null && !state.sessions.has(state.anchor)) state.anchor = null;
  onSelectionChanged();
}
const visibleIds = () => [...state.rows].filter(([, tr]) => !tr.hidden).map(([id]) => id);

// selection
function select(ids, focus, { scroll } = {}) {
  ids = ids.filter((id) => state.sessions.has(id));
  if (focus != null && !state.sessions.has(focus)) focus = null;
  state.sel = new Set(ids);
  state.focus = focus ?? ids[ids.length - 1] ?? null;
  for (const [id, tr] of state.rows) tr.classList.toggle('sel', state.sel.has(id));
  if (scroll && state.focus != null) state.rows.get(state.focus)?.scrollIntoView({ block: 'nearest' });
  onSelectionChanged();
}
let detailTimer;
function onSelectionChanged() {
  clearTimeout(detailTimer);
  if (state.focus != null) detailTimer = setTimeout(() => loadDetail(state.focus), 30);
  else { state.detail = null; renderInspector(); }
  renderStats();
  scheduleChrome();
  renderStatusText();
}
$('#sessBody').addEventListener('mousedown', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const id = +tr.dataset.id;
  const contextClick = e.button === 2 || (IS_MAC && e.ctrlKey);
  if (contextClick && state.sel.has(id)) return;
  if (contextClick) { state.anchor = id; return select([id], id); }
  if (IS_MAC ? e.metaKey : e.metaKey || e.ctrlKey) {
    const next = new Set(state.sel);
    next.has(id) ? next.delete(id) : next.add(id);
    state.anchor = id;
    select([...next], next.has(id) ? id : [...next].pop());
  } else if (e.shiftKey && state.anchor != null) {
    const vis = visibleIds();
    const a = vis.indexOf(state.anchor), b = vis.indexOf(id);
    if (a !== -1 && b !== -1) select(vis.slice(Math.min(a, b), Math.max(a, b) + 1), id);
  } else {
    state.anchor = id;
    select([id], id);
  }
});
$('#sessBody').addEventListener('dblclick', () => showTab('inspector'));
$('#sessWrap').addEventListener('mousedown', (e) => {
  const wrap = e.currentTarget;
  if (e.target.closest('tbody tr') || e.target.closest('thead')) return;
  if (e.offsetX > wrap.clientWidth || e.offsetY > wrap.clientHeight) return; // a click on the scrollbars
  if (e.button === 0 && state.sel.size) { state.anchor = null; select([], null); }
});
$('#sessWrap').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const vis = visibleIds();
    if (!vis.length) return;
    let i = vis.indexOf(state.focus);
    i = e.key === 'ArrowDown' ? Math.min(vis.length - 1, i + 1) : Math.max(0, i === -1 ? 0 : i - 1);
    if (e.shiftKey && state.anchor != null && vis.includes(state.anchor)) {
      const a = vis.indexOf(state.anchor);
      select(vis.slice(Math.min(a, i), Math.max(a, i) + 1), vis[i], { scroll: true });
    } else {
      state.anchor = vis[i];
      select([vis[i]], vis[i], { scroll: true });
    }
  } else if (e.key === 'Home' || e.key === 'End') {
    const vis = visibleIds();
    const id = e.key === 'Home' ? vis[0] : vis[vis.length - 1];
    if (id != null) { e.preventDefault(); state.anchor = id; select([id], id, { scroll: true }); }
  } else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); run('removeSelected'); }
  else if (e.key === 'Enter') showTab('inspector');
  else if ((e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run('selectAll'); }
  else if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey) { e.preventDefault(); run(e.shiftKey ? 'replayLive' : 'replay'); }
});

// context menu
$('#sessBody').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openContext(e.clientX, e.clientY);
});
function openContext(x, y) {
  closeMenus();
  const m = $('#ctx');
  refreshMenuState(m);
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 4) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 4) + 'px';
}

// ------------------------------------------------------------ inspectors
const REQ_VIEWS = ['Headers', 'TextView', 'WebForms', 'HexView', 'Cookies', 'Raw', 'JSON'];
const RES_VIEWS = ['Headers', 'TextView', 'ImageView', 'HexView', 'WebView', 'Cookies', 'Raw', 'JSON'];
function buildViewTabs() {
  $('#reqTabs').innerHTML = REQ_VIEWS.map((v) => `<button data-v="${v}">${v}</button>`).join('');
  $('#resTabs').innerHTML = RES_VIEWS.map((v) => `<button data-v="${v}">${v}</button>`).join('');
  $('#reqTabs').onclick = (e) => { const b = e.target.closest('button'); if (b) { state.reqView = b.dataset.v; store.set('reqView', state.reqView); renderInspector(); } };
  $('#resTabs').onclick = (e) => { const b = e.target.closest('button'); if (b) { state.resView = b.dataset.v; store.set('resView', state.resView); renderInspector(); } };
}
async function loadDetail(id) {
  try {
    const d = await api('/api/sessions/' + id);
    if (state.focus !== id) return;
    state.detail = d;
  } catch {
    if (state.focus === id) state.detail = null;
  }
  renderInspector();
  renderStats();
}

const GROUPS_REQ = {
  Cache: /^(cache-control|if-modified-since|if-none-match|if-match|if-range|if-unmodified-since|pragma)$/,
  Client: /^(accept|accept-charset|accept-encoding|accept-language|user-agent|sec-ch-ua.*|dnt|priority|sec-fetch-.*|x-requested-with|device-memory|viewport-width|dpr|save-data)$/,
  'Cookies / Login': /^(cookie|authorization|proxy-authorization)$/,
  Entity: /^(content-.*)$/,
  Security: /^(origin|access-control-request-.*|upgrade-insecure-requests|sec-websocket-.*|sec-gpc)$/,
  Transport: /^(host|connection|proxy-connection|keep-alive|te|transfer-encoding|upgrade|via|referer)$/,
};
const GROUPS_RES = {
  Cache: /^(cache-control|date|expires|etag|last-modified|age|vary|pragma)$/,
  'Cookies / Login': /^(set-cookie|www-authenticate|proxy-authenticate)$/,
  Entity: /^(content-type|content-length|content-encoding|content-language|content-disposition|content-range|content-md5)$/,
  Security: /^(strict-transport-security|access-control-.*|content-security-policy.*|x-frame-options|x-content-type-options|x-xss-protection|referrer-policy|cross-origin-.*|permissions-policy|timing-allow-origin|nel|report-to|expect-ct)$/,
  Transport: /^(connection|keep-alive|transfer-encoding|alt-svc|location|upgrade|via|server-timing)$/,
};
function headersView(d, which) {
  const pairs = which === 'req' ? d.reqHeaders : d.resHeaders;
  if (which === 'res' && d.source === 'pending') return '<div class="empty-note">Waiting for the response…</div>';
  let path = d.url;
  try { const u = new URL(d.url); path = d.protocol === 'HTTPS' || d.mode === 'direct' ? u.pathname + u.search : d.url; } catch {}
  const start = which === 'req' ? `${d.method} ${d.method === 'CONNECT' ? d.host : path} HTTP/${d.httpVersion || '1.1'}` : `HTTP/1.1 ${d.status || ''} ${d.statusText || ''}`;
  const groups = which === 'req' ? GROUPS_REQ : GROUPS_RES;
  const buckets = {};
  for (const [k, v] of pairs) {
    const lk = k.toLowerCase();
    let g = lk.startsWith(':') ? 'HTTP/2 pseudo-headers' : Object.keys(groups).find((name) => groups[name].test(lk)) || 'Miscellaneous';
    (buckets[g] ||= []).push([k, v]);
  }
  const body = Object.keys(buckets).sort().map((g) => {
    const items = buckets[g].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => {
      if (/^cookie$/i.test(k)) {
        const parts = String(v).split(/;\s*/).filter(Boolean);
        return `<div class="hl"><b>Cookie</b></div>${parts.map((p) => `<div class="sub">${esc(p)}</div>`).join('')}`;
      }
      return `<div class="hl"><b>${esc(k)}</b>: ${esc(v)}</div>`;
    }).join('');
    return `<details open><summary>${esc(g)}</summary><div class="kids">${items}</div></details>`;
  }).join('');
  return `<div class="hdr-title">${which === 'req' ? 'Request Headers' : 'Response Headers'}<span class="grow"></span><a data-goto="Raw">[Raw]</a><a data-defs>[Header Definitions]</a></div>` +
    `<div class="hdr-tree tree"><div class="startline">${esc(start)}</div>${body || '<div class="muted">(no headers)</div>'}</div>`;
}
function bodyText(view) { return view && view.text != null ? view.text : null; }
function bodyBytes(view) {
  if (!view || !view.size) return new Uint8Array();
  if (view.text != null) return new TextEncoder().encode(view.text);
  if (view.base64) { const b = atob(view.base64); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  return null;
}
function textView(view, which) {
  if (!view || !view.size) return '<div class="empty-note">No body</div>';
  const t = bodyText(view);
  if (t == null) return `<div class="empty-note">Binary body (${n0(view.size)} bytes). Use HexView${which === 'res' ? ' or ImageView' : ''}.</div>`;
  return `<div class="view-wrap"><div class="scroll"><pre class="tv" data-find>${esc(t.length > 3e6 ? t.slice(0, 3e6) : t)}</pre></div>` +
    `<div class="findbar"><input data-findinput placeholder="Find… (press Enter to highlight all)" spellcheck="false"><span class="muted" data-findcount></span><button class="wbtn" data-copybody>Copy</button></div></div>`;
}
function hexView(view) {
  const bytes = bodyBytes(view);
  if (!bytes || !bytes.length) return `<div class="empty-note">${view && view.size ? 'Body too large to show as hex' : 'No body'}</div>`;
  const max = Math.min(bytes.length, 65536);
  let out = '';
  for (let i = 0; i < max; i += 16) {
    let hex = '', asc = '';
    for (let j = 0; j < 16; j++) {
      if (i + j < max) { const b = bytes[i + j]; hex += b.toString(16).toUpperCase().padStart(2, '0') + ' '; asc += b >= 32 && b < 127 ? String.fromCharCode(b) : '.'; }
      else hex += '   ';
      if (j === 7) hex += ' ';
    }
    out += i.toString(16).toUpperCase().padStart(8, '0') + '  ' + hex + ' ' + asc + '\n';
  }
  if (bytes.length > max) out += `… ${n0(bytes.length - max)} more bytes`;
  return `<pre class="tv">${esc(out)}</pre>`;
}
function gridTable(title, rows, headers = ['Name', 'Value']) {
  return `<div class="grid-title">${esc(title)}</div><table class="grid"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>` +
    (rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}" class="muted">(none)</td></tr>`) + '</tbody></table>';
}
function webFormsView(d) {
  let qs = [];
  try { qs = [...new URL(d.url).searchParams]; } catch {}
  const ct = hdrVal(d.reqHeaders, 'content-type');
  const t = bodyText(d.reqBody) || '';
  let body = [];
  if (/x-www-form-urlencoded/i.test(ct)) body = [...new URLSearchParams(t)];
  else if (/multipart\/form-data/i.test(ct)) body = [...t.matchAll(/name="([^"]+)"(?:; filename="([^"]*)")?\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)\r?\n--/g)].map((m) => [m[1], m[2] != null ? `(file) ${m[2]}` : m[3]]);
  return `<div class="hdr-tree">${gridTable('QueryString', qs)}<br>${gridTable('Body', body)}${!body.length && t ? '<p class="muted">The body is not a form; see TextView or JSON.</p>' : ''}</div>`;
}
function cookiesView(d, which) {
  if (which === 'req') {
    const c = hdrVal(d.reqHeaders, 'cookie');
    const rows = c ? String(c).split(/;\s*/).filter(Boolean).map((p) => { const i = p.indexOf('='); return i === -1 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]; }) : [];
    return `<div class="hdr-tree">${gridTable('Request cookies', rows)}</div>`;
  }
  const rows = d.resHeaders.filter(([k]) => /^set-cookie$/i.test(k)).map(([, v]) => {
    const [nv, ...attrs] = String(v).split(/;\s*/);
    const i = nv.indexOf('=');
    return i === -1 ? [nv, '', attrs.join('; ')] : [nv.slice(0, i), nv.slice(i + 1), attrs.join('; ')];
  });
  return `<div class="hdr-tree">${gridTable('Response sets cookies', rows, ['Name', 'Value', 'Attributes'])}</div>`;
}
function rawView(d, which) {
  const lines = [];
  if (which === 'req') {
    let path = d.url;
    try { const u = new URL(d.url); if (d.protocol === 'HTTPS' || d.mode === 'direct') path = u.pathname + u.search; } catch {}
    lines.push(`${d.method} ${path} HTTP/${d.httpVersion || '1.1'}`);
    d.reqHeaders.forEach(([k, v]) => lines.push(`${k}: ${v}`));
  } else {
    if (d.source === 'pending') return '<div class="empty-note">Waiting for the response…</div>';
    lines.push(`HTTP/1.1 ${d.status} ${d.statusText || ''}`);
    d.resHeaders.forEach(([k, v]) => lines.push(`${k}: ${v}`));
  }
  const view = which === 'req' ? d.reqBody : d.resBody;
  let body = '';
  if (view && view.size) body = view.text != null ? (view.text.length > 1e6 ? view.text.slice(0, 1e6) + '\n… (truncated for display)' : view.text) : `[${n0(view.size)} bytes of binary data — see HexView]`;
  return `<pre class="tv">${esc(lines.join('\n') + '\n\n' + body)}</pre>`;
}
function jsonView(view) {
  const t = bodyText(view);
  if (!t) return '<div class="empty-note">No body</div>';
  let data;
  try { data = JSON.parse(t); } catch { return '<div class="empty-note">The selected body does not contain valid JSON text.</div>'; }
  let count = 0;
  const node = (key, val, depth) => {
    if (++count > 20000) return count === 20001 ? '<div class="hl muted">… (tree truncated)</div>' : '';
    const label = key == null ? '' : esc(key);
    if (val && typeof val === 'object') {
      const arr = Array.isArray(val);
      const kids = arr ? val.map((v) => node(null, v, depth + 1)).join('') : Object.keys(val).map((k) => node(k, val[k], depth + 1)).join('');
      const empty = arr ? !val.length : !Object.keys(val).length;
      return `<details ${depth < 4 ? 'open' : ''}><summary>${label || (arr ? '[]' : '{}')}${empty ? ' <span class="muted">(empty)</span>' : ''}</summary><div class="kids">${kids}</div></details>`;
    }
    const v = val === null ? 'null' : typeof val === 'string' ? val : String(val);
    return `<div class="hl">${label ? `<b>${label}</b>=` : ''}${esc(v)}</div>`;
  };
  return `<div class="view-wrap"><div class="scroll"><div class="json-tree tree"><details open><summary>JSON</summary><div class="kids">${node(null, data, 0).replace(/^<details open><summary>(\[\]|\{\})/, '<details open><summary>$1')}</div></details></div></div>` +
    `<div class="findbar"><button class="wbtn" data-expand>Expand All</button><button class="wbtn" data-collapse>Collapse</button><span class="grow"></span><button class="wbtn" data-copybody>Copy</button></div></div>`;
}
function imageView(d) {
  const v = d.resBody;
  const ct = String(hdrVal(d.resHeaders, 'content-type')).split(';')[0].trim().toLowerCase();
  if (!/^image\/[\w.+-]+$/.test(ct) || !v || !v.size) return '<div class="empty-note">This response is not an image.</div>';
  const src = v.base64 ? `data:${ct};base64,${v.base64}` : /svg/.test(ct) && v.text != null ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(v.text)}` : null;
  if (!src) return '<div class="empty-note">Image too large to preview.</div>';
  return `<div class="view-wrap"><div class="imginfo" data-imginfo>${esc(ct)} · ${n0(v.size)} bytes</div><div class="scroll imgview"><img alt="" src="${esc(src)}" data-img></div></div>`;
}
function webView(d) {
  const ct = hdrVal(d.resHeaders, 'content-type');
  if (!/html/i.test(ct) || !d.resBody.text) return '<div class="empty-note">WebView shows HTML responses. Scripts are disabled.</div>';
  return `<iframe class="webview" sandbox="" srcdoc="${esc(d.resBody.text)}"></iframe>`;
}
function renderPane(which) {
  const d = state.detail;
  const view = which === 'req' ? state.reqView : state.resView;
  const el = $(which === 'req' ? '#reqView' : '#resView');
  $$(`#${which}Tabs button`).forEach((b) => b.classList.toggle('on', b.dataset.v === view));
  if (!d) { el.innerHTML = ''; return; }
  const body = which === 'req' ? d.reqBody : d.resBody;
  let html;
  switch (view) {
    case 'Headers': html = headersView(d, which); break;
    case 'TextView': html = which === 'res' && d.source === 'pending' ? '<div class="empty-note">Waiting for the response…</div>' : textView(body, which); break;
    case 'WebForms': html = webFormsView(d); break;
    case 'HexView': html = hexView(body); break;
    case 'Cookies': html = cookiesView(d, which); break;
    case 'Raw': html = rawView(d, which); break;
    case 'JSON': html = jsonView(body); break;
    case 'ImageView': html = imageView(d); break;
    case 'WebView': html = webView(d); break;
    default: html = '';
  }
  el.innerHTML = html;
  el.scrollTop = 0;
  const img = $('[data-img]', el);
  if (img) img.onload = () => { const info = $('[data-imginfo]', el); if (info) info.textContent += ` · ${img.naturalWidth} × ${img.naturalHeight}`; };
  el.onclick = (e) => {
    const t = e.target;
    if (t.matches('[data-goto]')) { if (which === 'req') state.reqView = t.dataset.goto; else state.resView = t.dataset.goto; renderInspector(); }
    else if (t.matches('[data-defs]')) window.open('https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers', '_blank', 'noopener');
    else if (t.matches('[data-copybody]')) copy(bodyText(body) || '', 'the body');
    else if (t.matches('[data-expand]')) $$('details', el).forEach((x) => (x.open = true));
    else if (t.matches('[data-collapse]')) $$('details', el).forEach((x, i) => (x.open = i < 2));
  };
  const fi = $('[data-findinput]', el);
  if (fi) fi.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const pre = $('[data-find]', el);
    const text = bodyText(body) || '';
    const q = fi.value;
    if (!q) { pre.innerHTML = esc(text); $('[data-findcount]', el).textContent = ''; return; }
    const parts = text.split(q);
    pre.innerHTML = parts.map(esc).join(`<mark>${esc(q)}</mark>`);
    $('[data-findcount]', el).textContent = `${parts.length - 1} match${parts.length === 2 ? '' : 'es'}`;
    $('mark', pre)?.scrollIntoView({ block: 'center' });
  };
}
function renderBars() {
  const d = state.detail;
  const rb = $('#resBar'), qb = $('#reqBar');
  rb.hidden = qb.hidden = true;
  rb.className = qb.className = 'infobar';
  if (!d) return;
  const set = (el, icon, html, err) => { el.hidden = false; el.classList.toggle('err', !!err); el.innerHTML = `<svg><use href="#${icon}"/></svg><span>${html}</span>`; };
  if (d.note && /^Reissued/.test(d.note)) set(qb, 'i-info', esc(d.note));
  if (d.source === 'auto') {
    const what = d.ruleAction ? `rule action <b class="mono">${esc(d.ruleAction)}</b>` : `a recorded response${d.ruleSource ? ` from <b>${esc(d.ruleSource)}</b>` : ''}`;
    set(rb, 'i-bolt', `AutoResponder returned ${what}; this request never reached the server.${d.ruleId ? ` <a data-rule="${esc(d.ruleId)}">Edit rule</a>` : ''}${d.note && !d.ruleAction ? ' — ' + esc(d.note) : ''}`);
  } else if (d.error) set(rb, 'i-err', esc(d.error), true);
  else if (d.source === 'har') set(rb, 'i-har', `${esc(d.note || 'Imported session')}. Nothing was sent; this is the recorded response.`);
  else if (d.source === 'blocked') set(rb, 'i-block', esc(d.note || 'No AutoResponder rule matched and unmatched passthrough is off.'));
  else if (d.ruleId && d.note) set(rb, 'i-bolt', `${esc(d.note)} <a data-rule="${esc(d.ruleId)}">Edit rule</a>`);
  else if (d.note && !/^Reissued/.test(d.note)) set(rb, 'i-info', esc(d.note));
  else if (d.upstream) set(rb, 'i-info', `Forwarded to <span class="mono">${esc(d.upstream)}</span>`);
}
function renderInspector() {
  renderBars();
  renderPane('req');
  renderPane('res');
}
$('#resBar').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-rule]');
  if (a) { showTab('rules'); selectRule(a.dataset.rule, true); }
});

// ------------------------------------------------------------ statistics
function renderStats() {
  if (state.tab !== 'stats') return;
  const ids = [...state.sel].filter((id) => state.sessions.has(id));
  const out = $('#statsText');
  if (!ids.length) { out.textContent = 'Select one or more sessions in the Web Sessions list to view performance statistics.'; return; }
  const list = ids.map((id) => state.sessions.get(id));
  const sent = list.reduce((a, s) => [a[0] + (s.reqHeaderBytes || 0), a[1] + (s.reqBodyBytes || 0)], [0, 0]);
  const recv = list.reduce((a, s) => [a[0] + (s.resHeaderBytes || 0), a[1] + (s.resBodyBytes || 0)], [0, 0]);
  const L = [];
  L.push(`Request Count:   ${n0(list.length)}`);
  if (list.length > 1) L.push(`Unique Hosts:    ${new Set(list.map((s) => s.host)).size}`);
  L.push(`Bytes Sent:      ${n0(sent[0] + sent[1])}\t\t(headers:${n0(sent[0])}; body:${n0(sent[1])})`);
  L.push(`Bytes Received:  ${n0(recv[0] + recv[1])}\t\t(headers:${n0(recv[0])}; body:${n0(recv[1])})`);
  L.push('');
  const d = state.detail;
  if (list.length === 1 && d && d.id === list[0].id) {
    const T = d.timers || {};
    L.push('ACTUAL PERFORMANCE', '--------------');
    if (d.source === 'auto') L.push(`This response was returned by the AutoResponder${d.ruleSource ? ` (rule from ${d.ruleSource})` : ''}.`, 'No connection to a server was made.', '');
    if (d.source === 'har') L.push(`This session was imported from a HAR file; recorded duration ${d.duration || 0}ms.`, '');
    const ms = (a, b) => (a && b ? `${Math.max(0, b - a)}ms` : '0ms');
    const rows = [
      ['ClientBeginRequest', clock(T.ClientBeginRequest)],
      ['ClientDoneRequest', clock(T.ClientDoneRequest)],
      ['DNS Lookup', T.reused ? '0ms (reused connection)' : ms(T.ProxyBeginRequest, T.DNSDone)],
      ['TCP/IP Connect', T.reused ? '0ms (reused connection)' : ms(T.DNSDone || T.ProxyBeginRequest, T.ServerConnected)],
      ['HTTPS Handshake', T.HTTPSDone ? ms(T.ServerConnected, T.HTTPSDone) : '0ms'],
      ['ServerConnected', clock(T.ServerConnected)],
      ['ProxyBeginRequest', clock(T.ProxyBeginRequest)],
      ['ServerGotRequest', clock(T.ServerGotRequest)],
      ['ServerBeginResponse', clock(T.ServerBeginResponse)],
      ['ServerDoneResponse', clock(T.ServerDoneResponse)],
      ['ClientBeginResponse', clock(T.ClientBeginResponse)],
      ['ClientDoneResponse', clock(T.ClientDoneResponse)],
    ];
    rows.forEach(([k, v]) => L.push(`${(k + ':').padEnd(22)}${v}`));
    L.push('', `\tOverall Elapsed:\t${elapsed(d.duration || 0)}`, '');
  } else if (list.length > 1) {
    const t0 = Math.min(...list.map((s) => s.ts)), t1 = Math.max(...list.map((s) => s.ts + (s.duration || 0)));
    L.push('Sequence (clock) time:', `\t${elapsed(t1 - t0)}`, `\t${clock(t0)} - ${clock(t1)}`, '');
    const by = (f) => list.reduce((m, s) => ((m[f(s)] = (m[f(s)] || 0) + 1), m), {});
    const src = by((s) => s.source);
    L.push('SESSION SOURCES', '--------------');
    for (const [k, v] of Object.entries(src)) L.push(`${({ auto: 'AutoResponded', live: 'Live', har: 'Imported', error: 'Error', blocked: 'Blocked', tunnel: 'Tunnel', pending: 'In progress', aborted: 'Aborted' }[k] || k).padEnd(16)}${v}`);
    L.push('', 'RESPONSE CODES', '--------------');
    const codes = by((s) => s.status || 0);
    Object.keys(codes).sort().forEach((c) => L.push(`HTTP/${c}: \t${codes[c]}`));
    L.push('');
  } else {
    L.push('Loading timers…', '');
  }
  const bytesBy = {};
  list.forEach((s) => { const k = ctOf(s) || '(none)'; bytesBy[k] = (bytesBy[k] || 0) + (s.resBodyBytes || 0); });
  L.push('RESPONSE BYTES (by Content-Type)', '--------------');
  const width = Math.max(11, ...Object.keys(bytesBy).map((k) => k.length));
  Object.entries(bytesBy).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => L.push(`${k.padStart(width)}: ${n0(v)}`));
  L.push(`${'~headers~'.padStart(width)}: ${n0(recv[0])}`);
  out.textContent = L.join('\n');
}

// ------------------------------------------------------------ tabs & layout
function showTab(t) {
  state.tab = t;
  store.set('tab', t);
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $$('.tabpage').forEach((el) => (el.hidden = el.id !== 'tab-' + t));
  if (t === 'stats') renderStats();
  if (t === 'log') { const lv = $('#logView'); lv.scrollTop = lv.scrollHeight; }
}
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });

function splitter(el, onMove, onDone) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    el.classList.add('drag');
    const move = (ev) => onMove(ev);
    const up = () => { el.classList.remove('drag'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); onDone(); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
(() => {
  const main = $('#main');
  const left = store.get('left', null);
  if (left) main.style.setProperty('--left', left);
  splitter($('#vsplit'), (ev) => main.style.setProperty('--left', Math.min(85, Math.max(15, (ev.clientX / main.clientWidth) * 100)) + '%'), () => store.set('left', main.style.getPropertyValue('--left')));
  const insp = $('#tab-inspector');
  const reqH = store.get('reqH', null);
  if (reqH) insp.style.setProperty('--req-h', reqH);
  splitter($('#hsplit'), (ev) => {
    const r = insp.getBoundingClientRect();
    insp.style.setProperty('--req-h', Math.min(85, Math.max(10, ((ev.clientY - r.top) / r.height) * 100)) + '%');
  }, () => store.set('reqH', insp.style.getPropertyValue('--req-h')));
})();

// ------------------------------------------------------------ chrome (status bar, toolbar state)
let chromeQueued = false;
function scheduleChrome() {
  if (chromeQueued) return;
  chromeQueued = true;
  setTimeout(paintChrome, 30); // a timer, not rAF: WebKit pauses animation frames while the window is in the background
}
function paintChrome() {
  {
    chromeQueued = false;
    const total = state.sessions.size;
    const shown = visibleIds().length;
    $('#sbCount').textContent = (state.sel.size ? `${state.sel.size} / ` : '') + n0(total) + (shown !== total ? ` (${n0(shown)} shown)` : '');
    const sys = sysPending ?? !!state.info.systemProxy;
    const cap = $('#sbCapture');
    $('use', cap).setAttribute('href', sys ? '#i-capture' : '#i-capture-off');
    $('span', cap).textContent = sys ? 'System proxy' : '';
    $('#tbCapture').classList.toggle('pressed', sys);
    $('use', $('#tbCapture')).setAttribute('href', sys ? '#i-capture' : '#i-capture-off');
    $('span', $('#tbCapture')).textContent = sysPending === null ? `System Proxy: ${sys ? 'On' : 'Off'}` : `System Proxy: turning ${sysPending ? 'on' : 'off'}…`;
    $('#tbCapture').classList.toggle('busy', sysPending !== null);
    $('#optSys').checked = sys;
    const rec = state.settings.capture !== false;
    $('#tbRecord').classList.toggle('pressed', rec);
    $('use', $('#tbRecord')).setAttribute('href', rec ? '#i-rec' : '#i-rec-off');
    $('span', $('#tbRecord')).textContent = rec ? 'Recording' : 'Paused';
    $('#sbProc').textContent = !rec ? 'Recording paused' : state.info.proxyPort ? `Proxy 127.0.0.1:${state.info.proxyPort}` : 'All Processes';
    const active = state.rules.filter((r) => r.enabled && state.sources[r.source]?.enabled !== false).length;
    $('#sbRules').textContent = state.settings.rulesEnabled === false ? 'AutoResponder: off' : `AutoResponder: ${active} rule${active === 1 ? '' : 's'}${state.settings.passthrough === false ? ' (unmatched blocked)' : ''}`;
    $('#sessEmpty').hidden = total > 0;
    renderSearchCount();
    $('#ruleCountText').textContent = state.rules.length ? `${n0(state.rules.length)} rules, ${n0(active)} active` : '';
  }
}
function renderStatusText() {
  const el = $('#sbText');
  if (el.classList.contains('err')) return;
  const s = state.focus != null && state.sessions.get(state.focus);
  el.textContent = s ? s.url : '';
}

// ------------------------------------------------------------ menus & commands
function closeMenus() {
  $$('.menu.open').forEach((m) => m.classList.remove('open'));
  $('#ctx').hidden = true;
  $('#colmenu').hidden = true;
}
function checks() {
  const s = state.settings;
  return {
    capture: !!state.info.systemProxy, record: s.capture !== false, rulesEnabled: !!s.rulesEnabled, passthrough: !!s.passthrough,
    simulateLatency: !!s.simulateLatency, decryptHttps: !!s.decryptHttps, hideConnects: state.hideConnects,
    'tab:stats': state.tab === 'stats', 'tab:inspector': state.tab === 'inspector', 'tab:rules': state.tab === 'rules', 'tab:composer': state.tab === 'composer', 'tab:log': state.tab === 'log',
    'show:all': state.show === 'all', 'show:auto': state.show === 'auto', 'show:live': state.show === 'live', 'show:har': state.show === 'har', 'show:error': state.show === 'error', 'show:marked': state.show === 'marked',
  };
}
function refreshMenuState(root) {
  const c = checks();
  $$('[data-check]', root).forEach((b) => b.classList.toggle('checked', !!c[b.dataset.check]));
  $$('[data-needs="sel"]', root).forEach((b) => (b.disabled = !state.sel.size));
}
$$('.menu').forEach((menu) => {
  const btn = menu.querySelector(':scope > button');
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const was = menu.classList.contains('open');
    closeMenus();
    if (!was) { refreshMenuState(menu); menu.classList.add('open'); }
  });
  btn.addEventListener('mouseenter', () => {
    if ($('.menubar .menu.open') && menu.closest('.menubar') && !menu.classList.contains('open')) {
      closeMenus();
      refreshMenuState(menu);
      menu.classList.add('open');
    }
  });
});
document.addEventListener('mousedown', (e) => { if (!e.target.closest('.dropdown') && !e.target.closest('.menu')) closeMenus(); });
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  if (!b || b.disabled) return;
  e.preventDefault();
  closeMenus();
  run(b.dataset.cmd);
});

const selectedIds = () => [...state.sel].filter((id) => state.sessions.has(id)).sort((a, b) => a - b);
async function detailOf(id) { return state.detail && state.detail.id === id ? state.detail : api('/api/sessions/' + id); }
function toCurl(d) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const parts = ['curl', d.method !== 'GET' ? `-X ${d.method}` : '', q(d.url)];
  for (const [k, v] of d.reqHeaders) if (!/^(host|content-length|connection|proxy-connection|accept-encoding)$/i.test(k) && !k.startsWith(':')) parts.push(`-H ${q(k + ': ' + v)}`);
  if (d.reqBody.size && d.reqBody.text != null) parts.push(`--data-raw ${q(d.reqBody.text)}`);
  return parts.filter(Boolean).join(' \\\n  ');
}
async function removeIds(ids) {
  if (!ids.length) return;
  await api('/api/sessions', { method: 'DELETE', json: { ids } });
}
// Downloads through a hidden frame: if the server answers with an error page instead of a file, it lands
// in the frame rather than replacing HarFiddle's own window.
function download(url) {
  let f = $('#dlFrame');
  if (!f) { f = document.createElement('iframe'); f.id = 'dlFrame'; f.hidden = true; document.body.appendChild(f); }
  f.src = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
}
function exportHar(ids) {
  if (ids && !ids.length) return status('Nothing selected to save', true);
  download('/api/sessions/export.har' + (ids ? '?ids=' + ids.join(',') : ''));
  status(`Saving ${ids ? ids.length : state.sessions.size} sessions as HAR…`);
}
async function replay(useRules) {
  const ids = selectedIds();
  if (!ids.length) return;
  try {
    const r = await api('/api/sessions/replay', { method: 'POST', json: { ids, useRules } });
    status(`Reissued ${r.ids.length} request${r.ids.length === 1 ? '' : 's'}${useRules ? '' : ' (AutoResponder bypassed)'}`);
  } catch (e) { status(e.message, true); }
}
let sysPending = null; // the state we're switching to, while macOS applies it
async function toggleSystemCapture() {
  if (sysPending !== null) return;
  const on = !state.info.systemProxy;
  sysPending = on;
  paintChrome(); // show the new state right away; macOS takes a moment to apply it
  try {
    state.info = await api('/api/system-proxy', { method: 'POST', json: { on } });
    status(on ? (state.info.caTrusted ? 'System proxy on: capturing and decrypting traffic from all apps' : 'System proxy on: capturing all apps; HTTPS is tunneled until you trust the root certificate') : 'System proxy off; your previous proxy settings are restored');
  } catch (e) { status('Could not change the system proxy: ' + e.message, true); }
  sysPending = null;
  renderInfo();
}
async function trustCa() {
  status('macOS will ask for your password to trust the HarFiddle root certificate…');
  try {
    state.info = await api('/api/trust-ca', { method: 'POST' });
    renderInfo();
    status(state.info.caTrusted ? 'Root certificate trusted. Restart open browsers to pick it up.' : 'macOS still reports the certificate as untrusted', !state.info.caTrusted);
  } catch (e) { status(e.message, true); }
}
async function launch(browser) {
  try { await api('/api/launch-browser', { method: 'POST', json: { browser } }); status(`Launching ${browser === 'edge' ? 'Edge' : 'Chrome'} through HarFiddle…`); }
  catch (e) { status(e.message, true); }
}
function setShow(v) { state.show = v; $('#show').value = v; applyFilter(); }

const COMMANDS = {
  capture: toggleSystemCapture,
  record: () => saveSetting('capture', state.settings.capture === false),
  importSessions: () => $('#fileSessions').click(),
  importRules: () => $('#fileRules').click(),
  saveAll: () => exportHar(null),
  saveSelected: () => exportHar(selectedIds()),
  copyUrl: () => copy(selectedIds().map((id) => state.sessions.get(id).url).join('\n'), 'URL'),
  copyCurl: async () => { const ids = selectedIds(); if (ids.length) copy((await Promise.all(ids.map(detailOf))).map(toCurl).join('\n\n'), 'cURL'); },
  selectAll: () => { const v = visibleIds(); select(v, state.focus ?? v[v.length - 1]); },
  removeSelected: () => removeIds(selectedIds()),
  removeUnselected: () => removeIds([...state.sessions.keys()].filter((id) => !state.sel.has(id))),
  removeImported: () => removeIds([...state.sessions.values()].filter((s) => s.source === 'har').map((s) => s.id)),
  removeAll: () => api('/api/sessions', { method: 'DELETE' }),
  find: focusSearch,
  replay: () => replay(true),
  replayLive: () => replay(false),
  compose: async () => { const id = state.focus ?? selectedIds()[0]; if (id != null) loadIntoComposer(await detailOf(id)); },
  addRule: addSessionsToAutoResponder,
  toggleRules: () => saveSetting('rulesEnabled', !state.settings.rulesEnabled),
  togglePassthrough: () => saveSetting('passthrough', !state.settings.passthrough),
  toggleLatency: () => saveSetting('simulateLatency', !state.settings.simulateLatency),
  toggleDecrypt: () => saveSetting('decryptHttps', !state.settings.decryptHttps),
  toggleHideConnects: () => { state.hideConnects = !state.hideConnects; store.set('hideConnects', state.hideConnects); applyFilter(); },
  resetHits: () => api('/api/rules/bulk', { method: 'POST', json: { action: 'resetHits' } }).then(() => status('Rule hit counts and playback order reset')),
  options: () => openOptions('https'),
  help: () => openOptions('usage'),
  qxhelp: () => { showTab('log'); appendLog({ ts: Date.now(), msg: QX_HELP }); },
  about: () => openDialog('aboutDlg'),
  chrome: () => launch('chrome'),
  edge: () => launch('edge'),
  trust: trustCa,
  downloadCert: () => download('/harfiddle-ca.pem'),
};
// Fiddler's marking shortcuts: Ctrl+1…6 colors, Ctrl+0 unmark
const MARK_KEYS = { 1: 'red', 2: 'blue', 3: 'gold', 4: 'green', 5: 'orange', 6: 'purple', 0: null };
async function markSelected(mark) {
  const ids = selectedIds();
  if (!ids.length) return status('Select sessions to mark', true);
  try {
    await api('/api/sessions/mark', { method: 'POST', json: { ids, mark } });
    status(mark ? `Marked ${ids.length} session${ids.length === 1 ? '' : 's'} ${mark}` : `Unmarked ${ids.length} session${ids.length === 1 ? '' : 's'}`);
  } catch (e) { status(e.message, true); }
}

function run(cmd) {
  if (cmd.startsWith('mark:')) return markSelected(cmd.slice(5) || null);
  if (cmd.startsWith('tab:')) return showTab(cmd.slice(4));
  if (cmd.startsWith('show:')) return setShow(cmd.slice(5));
  const f = COMMANDS[cmd];
  if (f) Promise.resolve(f()).catch((e) => status(e.message, true));
}

$('#keep').addEventListener('change', (e) => { state.keep = +e.target.value; store.set('keep', state.keep); enforceKeep(); scheduleChrome(); });
$('#show').addEventListener('change', (e) => setShow(e.target.value));
$('#sbCapture').addEventListener('click', toggleSystemCapture);

// global keys
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (e.key === 'Escape') {
    const open = $$('.menu.open').length || !$('#ctx').hidden || !$('#colmenu').hidden || $$('.modal').some((m) => !m.hidden);
    closeMenus();
    $$('.modal').forEach((m) => (m.hidden = true));
    if (!open && !typing && state.sel.size) { state.anchor = null; select([], null); } // Esc deselects
  }
  if (e.key === 'F12') { e.preventDefault(); toggleSystemCapture(); }
  else if (e.key === 'F7') { e.preventDefault(); showTab('stats'); }
  else if (e.key === 'F8') { e.preventDefault(); showTab('inspector'); }
  else if (!typing && e.altKey && e.code === 'KeyQ') { e.preventDefault(); $('#qx').focus(); }
  else if ((e.metaKey || (!typing && e.ctrlKey)) && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); focusSearch(); }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); run('saveAll'); }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'u') { e.preventDefault(); if (state.sel.size) run('copyUrl'); }
  else if (!typing && e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'x') { e.preventDefault(); run('removeAll'); }
  else if (!typing && e.ctrlKey && !e.metaKey && /^Digit[0-6]$/.test(e.code)) { e.preventDefault(); markSelected(MARK_KEYS[e.code.slice(5)]); }
  else if (!typing && e.key === '/') { e.preventDefault(); focusSearch(); }
  else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && state.tab === 'composer') { e.preventDefault(); $('#cSend').click(); }
});

// ------------------------------------------------------------ QuickExec
const QX_HELP = `QuickExec commands
  text           filter sessions (same as the search box: host: path: process: method: status: type: source:)
  ?text          same as text
  cls / clear    remove all sessions
  start / stop   turn the system proxy on or off
  pause / resume pause or resume recording sessions
  select <type>  show only sessions whose Content-Type contains <type> (e.g. select json)
  show auto|live|har|error|marked|all
  rules on|off   enable or disable the AutoResponder
  help           this list`;
const qx = $('#qx');
qx.addEventListener('input', () => {
  const v = qx.value.trim();
  if (v.startsWith('?')) setFilter(v.slice(1));
});
qx.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { qx.value = ''; setFilter(''); $('#sessWrap').focus(); return; }
  if (e.key !== 'Enter') return;
  const v = qx.value.trim();
  const [cmd, ...rest] = v.split(/\s+/);
  const arg = rest.join(' ');
  const done = (msg) => { if (msg) status(msg); qx.value = ''; };
  switch ((cmd || '').toLowerCase()) {
    case '': setFilter(''); return;
    case 'help': run('qxhelp'); return done();
    case 'cls': case 'clear': run('removeAll'); return done('Removed all sessions');
    case 'start': if (!state.info.systemProxy) toggleSystemCapture(); return done();
    case 'stop': if (state.info.systemProxy) toggleSystemCapture(); return done();
    case 'pause': saveSetting('capture', false); return done('Session list paused');
    case 'resume': saveSetting('capture', true); return done('Session list resumed');
    case 'select': setFilter('type:' + arg); return done(`Showing sessions whose content type contains "${arg}"`);
    case 'show': setShow(['auto', 'live', 'har', 'error', 'marked'].includes(arg) ? arg : 'all'); return done();
    case 'rules': saveSetting('rulesEnabled', arg !== 'off'); return done(`AutoResponder ${arg === 'off' ? 'disabled' : 'enabled'}`);
    default:
      setFilter(v.startsWith('?') ? v.slice(1) : v);
      qx.value = '';
      status(`Filter: ${state.filter} (${visibleIds().length} sessions match; Esc in the search box clears it)`);
  }
});

// ------------------------------------------------------------ settings & info
function renderSettings() {
  const s = state.settings;
  $$('[data-setting]').forEach((el) => {
    const v = s[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el) el.value = v ?? '';
  });
  $('#trustBanner').hidden = !(state.info.systemProxy && state.info.caTrusted === false && s.decryptHttps);
  scheduleChrome();
}
async function saveSetting(key, value) {
  try { state.settings = await api('/api/settings', { method: 'PUT', json: { [key]: value } }); renderSettings(); }
  catch (e) { status(e.message, true); }
}
$$('[data-setting]').forEach((el) => el.addEventListener('change', () => saveSetting(el.dataset.setting, el.type === 'checkbox' ? el.checked : el.value)));

function renderInfo() {
  const i = state.info;
  const p = i.proxyPort;
  $('#emptyProxy').textContent = `127.0.0.1:${p}`;
  $$('.directBase').forEach((el) => (el.textContent = `http://localhost:${p}`));
  $('#caFp').textContent = 'SHA-1 ' + (i.caFingerprint || '');
  $('#caPath').textContent = i.caPath || '';
  $('#caTrust').innerHTML = i.caTrusted ? '<span class="ok-text">trusted by this Mac</span>' : '<span class="bad-text">not trusted yet</span>';
  if (document.activeElement !== $('#optPort')) $('#optPort').value = p || '';
  $('#optBrowsePort').textContent = i.browsePort || '';
  $('#optSys').checked = !!i.systemProxy;
  $('#optLan').textContent = i.lanIps && i.lanIps.length ? `Other devices can use ${i.lanIps.map((x) => x + ':' + p).join(', ')} as their proxy.` : 'Start with --lan to let phones and other devices use this proxy.';
  $$('.needs-edge').forEach((b) => (b.hidden = i.browsers && !i.browsers.edge));
  $('#aboutInfo').textContent = `Proxy 127.0.0.1:${p} · UI port ${i.uiPort} · data in ${i.dataDir}`;
  $('#directExample').textContent = `# your HAR recorded https://api.example.com/v1/me — now just call:\ncurl http://localhost:${p}/v1/me\n\n# or point an app's base URL at it\nAPI_BASE_URL=http://localhost:${p} npm run dev`;
  $('#cliExample').textContent = `curl -x http://127.0.0.1:${p} -k https://api.example.com/v1/me\n\nexport HTTPS_PROXY=http://127.0.0.1:${p} HTTP_PROXY=http://127.0.0.1:${p}\n# Node.js\nexport NODE_EXTRA_CA_CERTS="${i.caPath}"\n# Python requests\nexport REQUESTS_CA_BUNDLE="${i.caPath}"`;
  $('#trustBanner').hidden = !(i.systemProxy && i.caTrusted === false && state.settings.decryptHttps);
  scheduleChrome();
}
$('#optSys').addEventListener('change', toggleSystemCapture);
async function applyPort() {
  const port = +$('#optPort').value;
  const msg = $('#optPortMsg');
  if (port === state.info.proxyPort) { msg.textContent = ''; return; }
  msg.className = 'muted';
  msg.textContent = 'Switching…';
  try {
    state.info = await api('/api/proxy-port', { method: 'POST', json: { port } });
    renderInfo();
    msg.textContent = `Now listening on ${port}`;
    status(`Proxy moved to 127.0.0.1:${port}`);
  } catch (e) {
    msg.className = 'bad-text';
    msg.textContent = e.message;
  }
}
$('#optPortApply').addEventListener('click', applyPort);
$('#optPort').addEventListener('keydown', (e) => e.key === 'Enter' && applyPort());
$('#bannerTrust').addEventListener('click', (e) => { e.preventDefault(); trustCa(); });

// ------------------------------------------------------------ dialogs
function openDialog(id) { closeMenus(); $('#' + id).hidden = false; }
$$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; }));
function openOptions(page) {
  openDialog('optionsDlg');
  $$('#optTabs button').forEach((b) => b.classList.toggle('on', b.dataset.v === page));
  $$('.optpage').forEach((p) => (p.hidden = p.dataset.page !== page));
}
$('#optTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) openOptions(b.dataset.v); });

// ------------------------------------------------------------ log
function appendLog(e) {
  const lv = $('#logView');
  const atBottom = lv.scrollTop + lv.clientHeight >= lv.scrollHeight - 20;
  const d = new Date(e.ts);
  const line = document.createElement('div');
  line.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}:${pad(d.getMilliseconds(), 3)} ${e.msg}`;
  lv.appendChild(line);
  while (lv.childElementCount > 2000) lv.firstElementChild.remove();
  if (atBottom) lv.scrollTop = lv.scrollHeight;
}

// ------------------------------------------------------------ AutoResponder
async function loadRules() {
  const r = await api('/api/rules');
  state.rules = r.rules;
  state.sources = r.sources;
  if (state.selRule && !state.rules.some((x) => x.id === state.selRule)) clearRuleEditor();
  renderRules();
}
function clearRuleEditor() {
  state.selRule = null;
  state.ruleDetail = null;
  $('#ruleEditor').disabled = true;
  ['#reMatch', '#reAction', '#reMethod', '#reStatus', '#reDelay', '#reHeaders', '#reBody'].forEach((sel) => ($(sel).value = ''));
  $('#reOnce').checked = false;
  $('#reBinary').hidden = true;
  $('#reBody').hidden = false;
  $('#reInfo').textContent = '';
}
function matchText(m) {
  if (!m || m === '*') return '*';
  return m;
}
function actionText(r) {
  if (r.action) return r.action;
  const ct = (r.contentType || '').split(';')[0];
  return `*${r.status}  recorded${ct ? ' ' + ct : ''}, ${n0(r.size)} bytes${r.delay ? `, +${r.delay}ms` : ''}`;
}
function renderRules() {
  const counts = {};
  state.rules.forEach((r) => (counts[r.source] = (counts[r.source] || 0) + 1));
  $('#sources').innerHTML = Object.keys(state.sources).filter((n) => counts[n]).map((n) => {
    const on = state.sources[n].enabled !== false;
    return `<label class="src cb" title="Enable or disable every rule from ${esc(n)}"><input type="checkbox" data-src="${esc(n)}" ${on ? 'checked' : ''}>${esc(n)} <span class="n">(${counts[n]})</span><a data-rmsrc="${esc(n)}" title="Remove these rules">✕</a></label>`;
  }).join('');
  const f = state.ruleFilter;
  $('#rulesBody').innerHTML = state.rules
    .filter((r) => !f || `${r.method} ${r.match} ${r.action} ${r.status} ${r.source}`.toLowerCase().includes(f))
    .map((r) => {
      const off = !r.enabled || state.sources[r.source]?.enabled === false;
      return `<tr data-id="${r.id}" class="${off ? 'off' : ''}${r.id === state.selRule ? ' sel' : ''}"><td><input type="checkbox" data-en="${r.id}" ${r.enabled ? 'checked' : ''} aria-label="Enabled"></td>` +
        `<td class="match" title="${esc(r.match)}">${esc(matchText(r.match))}</td><td class="action" title="${esc(actionText(r))}">${esc(actionText(r))}</td>` +
        `<td>${esc(r.method === '*' ? 'ANY' : r.method)}</td><td class="num" data-hits="${r.id}">${r.hits || ''}</td><td title="${esc(r.source)}">${esc(r.source)}${r.once ? ' (once)' : ''}</td></tr>`;
    }).join('');
  $('#rulesEmpty').hidden = state.rules.length > 0;
  scheduleChrome();
}
$('#ruleFilter').addEventListener('input', (e) => { state.ruleFilter = e.target.value.toLowerCase().trim(); renderRules(); });
$('#sources').addEventListener('change', (e) => {
  const n = e.target.dataset.src;
  if (n != null) api('/api/sources/' + encodeURIComponent(n), { method: 'PUT', json: { enabled: e.target.checked } }).catch((er) => status(er.message, true));
});
$('#sources').addEventListener('click', async (e) => {
  const n = e.target.closest('[data-rmsrc]')?.dataset.rmsrc;
  if (!n) return;
  e.preventDefault();
  await api('/api/rules/bulk', { method: 'POST', json: { action: 'delete', source: n } });
  status(`Removed the rules from ${n}`);
});
$('#rulesBody').addEventListener('click', (e) => {
  const cb = e.target.closest('[data-en]');
  if (cb) { api('/api/rules/' + cb.dataset.en, { method: 'PUT', json: { enabled: cb.checked } }).catch((er) => status(er.message, true)); return; }
  const tr = e.target.closest('tr');
  if (tr) selectRule(tr.dataset.id);
});
$('#rulesWrap').addEventListener('keydown', (e) => {
  if (!state.selRule) return;
  const rows = $$('#rulesBody tr');
  const i = rows.findIndex((r) => r.dataset.id === state.selRule);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = rows[e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)];
    if (n) { selectRule(n.dataset.id); n.scrollIntoView({ block: 'nearest' }); }
  } else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); $('#reDelete').click(); }
  else if (e.key === ' ') { e.preventDefault(); const r = state.rules.find((x) => x.id === state.selRule); if (r) api('/api/rules/' + r.id, { method: 'PUT', json: { enabled: !r.enabled } }); }
});

async function selectRule(id, scroll) {
  state.selRule = id;
  $$('#rulesBody tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.id === id));
  if (scroll) {
    if (state.ruleFilter) { state.ruleFilter = ''; $('#ruleFilter').value = ''; renderRules(); }
    $(`#rulesBody tr[data-id="${id}"]`)?.scrollIntoView({ block: 'center' });
  }
  try {
    const r = await api('/api/rules/' + id);
    if (state.selRule !== id) return; // the user already moved to another rule
    state.ruleDetail = r;
    $('#ruleEditor').disabled = false;
    $('#reMatch').value = r.match;
    $('#reAction').value = r.action || '';
    $('#reOnce').checked = !!r.once;
    $('#reMethod').value = r.method;
    $('#reStatus').value = r.status;
    $('#reDelay').value = r.delay ?? '';
    $('#reHeaders').value = r.headers.map(([k, v]) => `${k}: ${v}`).join('\n');
    const bv = r.bodyView;
    const ct = (r.headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || r.mimeType || '';
    if (bv.text != null || !bv.size) {
      $('#reBody').hidden = false;
      $('#reBinary').hidden = true;
      let t = bv.text || '';
      if (/json/.test(ct) && t.length < 2e6) { try { t = JSON.stringify(JSON.parse(t), null, 2); } catch {} }
      $('#reBody').value = t;
      $('#reBody').dataset.orig = t;
      $('#reBodyLabel').textContent = `Body${bv.size ? ` (${n0(bv.size)} bytes)` : ''}${bv.truncated ? ' — truncated; saving will cut it' : ''}`;
    } else {
      $('#reBody').hidden = true;
      $('#reBinary').hidden = false;
      $('#reBinary').innerHTML = `Binary body (${n0(bv.size)} bytes${ct ? ', ' + esc(ct) : ''}), kept as recorded.` + (bv.base64 && /^image\//.test(ct) ? `<img alt="" src="data:${esc(ct.split(';')[0])};base64,${bv.base64}">` : '');
      $('#reBodyLabel').textContent = 'Body';
    }
    $('#reInfo').textContent = `— from ${r.source}${r.harTime ? `, originally took ${r.harTime}ms` : ''}${r.action ? ' (not used while an action is set)' : ''}`;
  } catch (e) { status(e.message, true); }
}
$('#reSave').addEventListener('click', async () => {
  const id = state.selRule;
  if (!id) return;
  const body = {
    match: $('#reMatch').value.trim(), action: $('#reAction').value.trim(), once: $('#reOnce').checked,
    method: $('#reMethod').value.trim() || '*', status: +$('#reStatus').value, delay: $('#reDelay').value, headersText: $('#reHeaders').value,
  };
  if (!$('#reBody').hidden && $('#reBody').value !== $('#reBody').dataset.orig) body.bodyText = $('#reBody').value;
  try { await api('/api/rules/' + id, { method: 'PUT', json: body }); status('Rule saved'); selectRule(id); }
  catch (e) { status(e.message, true); }
});
$('#reDelete').addEventListener('click', async () => {
  const id = state.selRule;
  if (!id) return;
  try { await api('/api/rules/' + id, { method: 'DELETE' }); status('Rule removed'); }
  catch (e) { status(e.message, true); }
  clearRuleEditor();
});
$('#reTop').addEventListener('click', async () => {
  if (!state.selRule) return;
  try {
    await api('/api/rules/' + state.selRule, { method: 'PUT', json: { move: 'top' } });
    status('Rule moved to the top; it now wins over other matching rules');
  } catch (e) { status(e.message, true); }
});
$('#addRule').addEventListener('click', async () => {
  const s = state.focus != null && state.sessions.get(state.focus);
  try {
    const r = await api('/api/rules', { method: 'POST', json: { method: '*', match: s ? 'EXACT:' + s.url : 'EXACT:https://example.com/path', status: 200, headersText: 'Content-Type: application/json', bodyText: '{}' } });
    await loadRules();
    await selectRule(r.id, true);
    $('#reMatch').focus();
    $('#reMatch').select();
  } catch (e) { status(e.message, true); }
});
async function addSessionsToAutoResponder() {
  const ids = selectedIds().filter((id) => { const s = state.sessions.get(id); return s.status && !isConnect(s); });
  if (!ids.length) return status('Select sessions that have a response', true);
  let last;
  for (const id of ids.reverse()) last = await api(`/api/sessions/${id}/torule`, { method: 'POST' });
  await loadRules();
  showTab('rules');
  if (last) selectRule(last.id, true);
  status(`Added ${ids.length} rule${ids.length === 1 ? '' : 's'} to the top of the AutoResponder`);
}

// Validate rule dialog
$('#reTest').addEventListener('click', () => {
  const m = $('#reMatch').value.trim();
  $('#testRuleText').textContent = m || '*';
  setSelect($('#testMethod'), /^[A-Z]+$/.test($('#reMethod').value) ? $('#reMethod').value : 'GET');
  if (!$('#testUrl').value) $('#testUrl').value = /^exact:/i.test(m) ? m.slice(6) : '';
  $('#testResult').innerHTML = '';
  openDialog('testDlg');
  $('#testUrl').focus();
});
$('#testRun').addEventListener('click', async () => {
  const url = $('#testUrl').value.trim();
  if (!url) return;
  const direct = !/^https?:\/\//i.test(url);
  const full = direct ? `http://localhost:${state.info.proxyPort}${url.startsWith('/') ? '' : '/'}${url}` : url;
  const unsaved = $('#reMatch').value.trim() !== (state.ruleDetail?.match || '');
  let r;
  try { r = await api('/api/test-match', { method: 'POST', json: { method: $('#testMethod').value, url: full, direct, ruleId: state.selRule } }); }
  catch (e) { $('#testResult').textContent = e.message; return; }
  const first = r.rule ? `First matching rule overall: <span class="mono">${esc(r.rule.match)}</span> (${esc(r.rule.source)}).` : `No enabled rule matches; the request would ${state.settings.passthrough ? 'go to the server' : 'get a 404'}.`;
  $('#testResult').innerHTML = (r.ruleMatches ? '<div class="ok">✓ This rule matches.</div>' : '<div class="no">✗ This rule does not match.</div>') + `<div>${first}</div>` + (unsaved ? '<div class="muted">The match text has unsaved changes; save the rule to test them.</div>' : '');
});
$('#testUrl').addEventListener('keydown', (e) => e.key === 'Enter' && $('#testRun').click());

// ------------------------------------------------------------ HAR import (files + drag & drop)
async function importSessionFiles(files) {
  for (const f of files) {
    try {
      const r = await api('/api/sessions/import?name=' + encodeURIComponent(f.name), { method: 'POST', body: await f.text() });
      status(`Imported ${r.added} sessions from ${f.name}`);
    } catch (e) { status(`${f.name}: ${e.message}`, true); }
  }
}
async function importRuleFiles(files) {
  for (const f of files) {
    try {
      const r = await api('/api/rules/import?name=' + encodeURIComponent(f.name), { method: 'POST', body: await f.text() });
      status(`Loaded ${r.added} AutoResponder rules from ${f.name}${r.skipped ? ` (${r.skipped} skipped: no response)` : ''}`);
    } catch (e) { status(`${f.name}: ${e.message}`, true); }
  }
  showTab('rules');
}
$('#fileSessions').addEventListener('change', (e) => { importSessionFiles([...e.target.files]); e.target.value = ''; });
$('#fileRules').addEventListener('change', (e) => { importRuleFiles([...e.target.files]); e.target.value = ''; });
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const hideDrop = () => { dragDepth = 0; $('#drop').hidden = true; $$('#drop .zone').forEach((z) => z.classList.remove('hot')); };
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  if ($('#drop').hidden) {
    $('#drop').hidden = false;
    $$('#drop .zone').forEach((z) => z.classList.toggle('hot', z.dataset.zone === (state.tab === 'rules' ? 'rules' : 'inspect')));
  }
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) hideDrop(); });
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const z = e.target.closest?.('.zone');
  if (z) $$('#drop .zone').forEach((x) => x.classList.toggle('hot', x === z));
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const zone = $('#drop .zone.hot')?.dataset.zone || 'inspect';
  hideDrop();
  const files = [...e.dataTransfer.files].filter((f) => /\.(har|json)$/i.test(f.name));
  if (!files.length) return status('Drop .har files', true);
  if (zone === 'rules') importRuleFiles(files);
  else importSessionFiles(files);
});

// ------------------------------------------------------------ composer
let composerWaiting = null;
let cmpMode = 'parsed';
function parsedToRaw() {
  const url = $('#cUrl').value.trim();
  let host = '';
  try { host = new URL(url).host; } catch {}
  const hs = $('#cHeaders').value.trim();
  const hasHost = /^host:/im.test(hs);
  return `${$('#cMethod').value} ${url} ${$('#cVer').value}\n${hasHost || !host ? '' : `Host: ${host}\n`}${hs}${hs ? '\n' : ''}\n${$('#cBody').value}`;
}
function rawToParsed() {
  const raw = $('#cRawText').value.replace(/\r\n/g, '\n');
  const [head, ...bodyParts] = raw.split('\n\n');
  const lines = head.split('\n');
  const m = (lines.shift() || '').match(/^(\S+)\s+(\S+)/);
  if (m) {
    setSelect($('#cMethod'), m[1].toUpperCase());
    $('#cUrl').value = m[2];
  }
  $('#cHeaders').value = lines.filter((l) => !/^host:/i.test(l) || !/^https?:/i.test($('#cUrl').value)).join('\n');
  $('#cBody').value = bodyParts.join('\n\n');
}
$('#cmpTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.v === cmpMode) return;
  if (b.dataset.v === 'raw') $('#cRawText').value = parsedToRaw(); else rawToParsed();
  cmpMode = b.dataset.v;
  $$('#cmpTabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('#cParsed').hidden = cmpMode !== 'parsed';
  $('#cRaw').hidden = cmpMode !== 'raw';
  $('.cmp-top').hidden = cmpMode === 'raw';
});
// sets a <select>, adding the option first if it's missing (PROPFIND, PURGE, …)
function setSelect(sel, value) {
  if (![...sel.options].some((o) => o.value === value)) sel.add(new Option(value));
  sel.value = value;
}
function loadIntoComposer(d) {
  setSelect($('#cMethod'), d.method === 'CONNECT' ? 'GET' : d.method);
  $('#cUrl').value = d.url;
  $('#cHeaders').value = d.reqHeaders.filter(([k]) => !/^(host|content-length|connection|proxy-connection)$/i.test(k) && !k.startsWith(':')).map(([k, v]) => `${k}: ${v}`).join('\n');
  $('#cBody').value = d.reqBody.text || '';
  if (cmpMode === 'raw') $('#cRawText').value = parsedToRaw();
  showTab('composer');
}
$('#cSend').addEventListener('click', async () => {
  if (cmpMode === 'raw') rawToParsed();
  const url = $('#cUrl').value.trim();
  if (!url) return $('#cUrl').focus();
  const btn = $('#cSend');
  btn.disabled = true;
  try {
    const { id } = await api('/api/compose', { method: 'POST', json: { method: $('#cMethod').value, url, headersText: $('#cHeaders').value, bodyText: $('#cBody').value, useRules: $('#cUseRules').checked } });
    composerWaiting = id;
    composerDone(id);
  } catch (e) { status(e.message, true); }
  btn.disabled = false;
});
function composerDone(id) {
  const s = state.sessions.get(id);
  if (!s || s.source === 'pending') return;
  composerWaiting = null;
  status(`Composer: #${id} ${s.method} ${s.url} → ${s.status || s.error || 'no response'}`);
  if ($('#cInspect').checked) { state.anchor = id; select([id], id, { scroll: true }); showTab('inspector'); }
}

// ------------------------------------------------------------ live events
function connect() {
  const es = new EventSource('/api/events');
  const conn = $('#sbConn');
  es.onopen = async () => {
    conn.className = 'sb-cell sb-conn ok';
    conn.title = 'Connected to the HarFiddle engine';
    try {
      [state.info, state.settings] = await Promise.all([api('/api/info'), api('/api/settings')]);
      renderInfo();
      renderSettings();
      const [, , log] = await Promise.all([loadSessions(), loadRules(), api('/api/log')]);
      $('#logView').innerHTML = '';
      log.forEach(appendLog);
      if (!state.hashApplied) { state.hashApplied = true; applyHash(); }
    } catch (e) { status(e.message, true); }
  };
  es.onerror = () => {
    conn.className = 'sb-cell sb-conn bad';
    conn.title = 'HarFiddle is not running — reconnecting…';
    $('#sbText').textContent = 'Lost connection to HarFiddle. Is it still running? Reconnecting…';
  };
  es.addEventListener('session', (e) => upsertSession(JSON.parse(e.data)));
  es.addEventListener('removed', (e) => dropRows(JSON.parse(e.data).ids));
  es.addEventListener('cleared', () => {
    $('#sessBody').innerHTML = '';
    state.rows.clear();
    state.sessions.clear();
    select([], null);
  });
  let reloadTimer, rulesTimer;
  es.addEventListener('reload', () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadSessions, 50); });
  es.addEventListener('rules', () => { clearTimeout(rulesTimer); rulesTimer = setTimeout(loadRules, 60); });
  es.addEventListener('rulehit', (e) => {
    const { id, hits } = JSON.parse(e.data);
    const r = state.rules.find((x) => x.id === id);
    if (r) r.hits = hits;
    const cell = $(`[data-hits="${id}"]`);
    if (cell) cell.textContent = hits;
  });
  es.addEventListener('settings', (e) => { state.settings = JSON.parse(e.data); renderSettings(); });
  es.addEventListener('info', (e) => { state.info = JSON.parse(e.data); renderInfo(); });
  es.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));
}

// deep links: #tab=rules  #s=12  #rule=<id>
function applyHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('rv')) state.resView = h.get('rv');
  if (h.get('qv')) state.reqView = h.get('qv');
  if (h.get('s')) { const ids = h.get('s').split(',').map(Number); state.anchor = ids[0]; select(ids, ids[ids.length - 1], { scroll: true }); }
  if (h.get('tab')) showTab(h.get('tab'));
  if (h.get('rule')) selectRule(h.get('rule'), true);
}

window.addEventListener('hashchange', applyHash);

// boot
buildColumns();
buildViewTabs();
state.keep = store.get('keep', 0);
$('#keep').value = String(state.keep);
showTab(state.tab);
connect();
