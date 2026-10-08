#!/usr/bin/env node
// HarFiddle: an HTTP/HTTPS debugging proxy with a HAR-driven AutoResponder.
//
//   node server.js [--port 8888] [--ui-port 8899] [--lan] [--no-open] [--exit-with-parent] [file.har ...]
//
// The proxy port works two ways at once:
//   • as an HTTP/HTTPS proxy (curl -x, browser/system proxy) — HTTPS is decrypted with a local CA
//   • as a plain server (point your app at http://localhost:8888) — requests are matched by path
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { CertAuthority } = require('./lib/ca');

// ---------------------------------------------------------------- config
const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(name);
  if (i === -1) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
const PORT_ARG = flag('--port', process.env.PORT);
let proxyPort = 8888; // resolved after the saved state is loaded
const UI_PORT = +flag('--ui-port', process.env.UI_PORT || 8899);
const LAN = argv.includes('--lan');
const NO_OPEN = argv.includes('--no-open');
const harArgs = argv.filter((a) => !a.startsWith('--'));

const DATA_DIR = path.join(os.homedir(), '.harfiddle');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SYSPROXY_BACKUP = path.join(DATA_DIR, 'sysproxy-backup.json');
const MAX_SESSIONS = 5000;
const MAX_SESSION_BYTES = 1024 * 1024 * 1024; // all captured bodies together; the oldest sessions go first
const MAX_BODY = 20 * 1024 * 1024;

const DEFAULT_SETTINGS = {
  capture: true,
  rulesEnabled: true,
  passthrough: true, // unmatched requests go to the real server
  matchMethod: true,
  matchQuery: true,
  ignoreHost: false, // (always ignored for direct requests to the proxy port)
  ignoreParams: '_',
  matchBody: false,
  duplicates: 'sequence', // first | sequence | cycle
  simulateLatency: false,
  directFriendly: true, // CORS + preflight + cookie rewriting for direct mode
  proxyPort: 8888, // changed through /api/proxy-port
  fallbackUpstream: '',
  decryptHttps: true,
  tunnelHosts: '*.apple.com, *.icloud.com, *.mzstatic.com',
};

let settings = { ...DEFAULT_SETTINGS };
let rules = [];
let sources = {}; // name -> { enabled, importedAt }

// ---------------------------------------------------------------- persistence
function loadState() {
  let st;
  try {
    st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return;
    // keep the damaged file instead of overwriting it with an empty state on the next save
    const bad = `${STATE_FILE}.damaged-${Date.now()}`;
    try { fs.renameSync(STATE_FILE, bad); } catch {}
    console.error(`Could not read ${STATE_FILE} (${e.message}). It was moved to ${bad}; starting with default settings.`);
    startupWarnings.push(`Your saved rules and settings could not be read, so HarFiddle started fresh. The old file was kept as ${bad}.`);
    return;
  }
  if (!st || typeof st !== 'object') return;
  const saved = st.settings && typeof st.settings === 'object' ? st.settings : {};
  settings = { ...DEFAULT_SETTINGS, ...cleanSettings(saved), proxyPort: saved.proxyPort, capture: true };
  rules = (Array.isArray(st.rules) ? st.rules : []).filter((r) => r && typeof r === 'object').map((r) => normalizeRule({ ...r, hits: 0 }));
  sources = st.sources && typeof st.sources === 'object' ? st.sources : {};
}
const startupWarnings = [];
// Coerces settings to the types of the defaults ("false" -> false, "8888" -> 8888); drops unknown keys.
function cleanSettings(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (!(k in patch) || k === 'proxyPort') continue;
    const def = DEFAULT_SETTINGS[k];
    const v = patch[k];
    if (typeof def === 'boolean') out[k] = v === true || v === 'true' || v === 1;
    else if (typeof def === 'number') { if (Number.isFinite(+v)) out[k] = +v; }
    else out[k] = v == null ? '' : String(v);
  }
  if ('duplicates' in out && !['first', 'sequence', 'cycle'].includes(out.duplicates)) delete out.duplicates;
  return out;
}
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
function saveNow() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ settings, sources, rules }, (k, v) => (k.startsWith('_') ? undefined : v)));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('Could not save state:', e.message);
  }
}

// ---------------------------------------------------------------- helpers
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'http2-settings']);
const DROP_ON_REPLAY = new Set([...HOP, 'content-encoding', 'content-length', 'alt-svc']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => crypto.randomBytes(5).toString('hex');

function rawPairs(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i += 2) out.push([raw[i], raw[i + 1]]);
  return out;
}
function hdr(pairs, name) {
  name = name.toLowerCase();
  const p = pairs.find(([k]) => k.toLowerCase() === name);
  return p ? p[1] : undefined;
}
function flatHeaders(pairs) {
  const out = [];
  for (const [k, v] of pairs) {
    try {
      http.validateHeaderName(k);
      http.validateHeaderValue(k, String(v));
      out.push(k, String(v));
    } catch {}
  }
  return out;
}
function parseHeaderText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*([^:\s][^:]*?)\s*:\s?(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]);
}
function decodeBody(buf, enc) {
  enc = String(enc || '').toLowerCase().trim();
  if (!buf.length || !enc || enc === 'identity') return buf;
  try {
    // capped: a small compressed response can expand to gigabytes ("zip bomb")
    const o = { maxOutputLength: MAX_BODY };
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf, o);
    if (enc === 'br') return zlib.brotliDecompressSync(buf, o);
    if (enc === 'deflate') {
      try { return zlib.inflateSync(buf, o); } catch { return zlib.inflateRawSync(buf, o); }
    }
    if (enc === 'zstd' && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buf, o);
  } catch {}
  return buf;
}
function isTextual(ct, buf) {
  if (/json|text|xml|javascript|ecmascript|html|css|x-www-form-urlencoded|graphql|csv|svg|yaml/i.test(ct || '')) return true;
  if (/image|audio|video|font|octet-stream|protobuf|wasm|zip|pdf/i.test(ct || '')) return false;
  return looksUtf8(buf);
}
// Valid UTF-8 without NUL bytes? Checks up to 64 KB; a multi-byte character cut at the end of the sample is fine.
function looksUtf8(buf) {
  let sample = buf.subarray(0, 65536);
  if (sample.includes(0)) return false;
  if (sample.length < buf.length) { let end = sample.length; while (end > sample.length - 4 && end > 0 && (sample[end - 1] & 0xc0) === 0x80) end--; sample = sample.subarray(0, Math.max(0, end - 1)); }
  return Buffer.from(sample.toString('utf8'), 'utf8').equals(sample);
}
const roundTripsUtf8 = (buf) => Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
function bodyView(buf, ct, textCap = 5 * 1024 * 1024) {
  if (!buf || !buf.length) return { size: 0, text: '' };
  if (isTextual(ct, buf)) {
    return { size: buf.length, text: buf.subarray(0, textCap).toString('utf8'), truncated: buf.length > textCap };
  }
  return { size: buf.length, text: null, base64: buf.length <= textCap ? buf.toString('base64') : null };
}
function canonicalJson(s) {
  try {
    const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => ((o[k] = sort(v[k])), o), {}) : v);
    return JSON.stringify(sort(JSON.parse(s)));
  } catch {
    return String(s).trim();
  }
}
function hostMatches(host, list) {
  host = host.toLowerCase();
  return String(list || '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((p) => {
      p = p.toLowerCase();
      if (p.startsWith('*.')) return host === p.slice(2) || host.endsWith(p.slice(1));
      return host === p;
    });
}
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
// True when host:port is one of HarFiddle's own listeners. Proxying there would hand any proxy client the
// control API (with --lan: anyone on the network) or loop forever (a fallback/mapping pointing at the proxy).
function isOwnPort(hostname, port) {
  port = +port;
  if (![proxyPort, browsePort, UI_PORT].includes(port)) return false;
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  return LOCAL_HOSTS.has(h) || /^127\./.test(h) || h.endsWith('.localhost') || lanIps().includes(h) || h === os.hostname().toLowerCase();
}
function isOwnUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return isOwnPort(u.hostname, u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    return false;
  }
}
function localPort(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!LOCAL_HOSTS.has(u.hostname)) return null;
    return +(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- live events (SSE)
const sseClients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    // a stalled client (suspended tab, frozen window) would buffer forever; drop it, it reconnects and reloads
    if (c.writableLength > 4 * 1024 * 1024) { sseClients.delete(c); c.destroy(); continue; }
    c.write(msg);
  }
}

const logBuf = [];
function log(msg) {
  const e = { ts: Date.now(), msg: String(msg) };
  logBuf.push(e);
  if (logBuf.length > 1000) logBuf.shift();
  broadcast('log', e);
}

// ---------------------------------------------------------------- client process lookup
// Which app opened a connection to the proxy (macOS). Each new client connection is looked up once, in
// batches, with lsof (who owns the other end of the socket) and ps (the app's name). Best effort: a client
// that disconnects within a few milliseconds may be gone before the lookup runs.
const pidNames = new Map();
let lookupQueue = [];
let lookupTimer = null;
function watchClientProcess(sock) {
  if (sock instanceof tls.TLSSocket || sock.__proc) return;
  sock.__proc = lookupProcess(sock).then((name) => (sock.__procName = name));
}
function lookupProcess(sock) {
  const addr = String(sock.remoteAddress || '').replace(/^::ffff:/, '');
  if (!/^(127\.0\.0\.1|::1)$/.test(addr)) return Promise.resolve(addr || null); // another device: show its IP
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    lookupQueue.push({ port: sock.remotePort, resolve });
    if (!lookupTimer) lookupTimer = setTimeout(runProcessLookup, 10);
  });
}
function execOut(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 5000, maxBuffer: 4 << 20 }, (e, out) => resolve(out || '')));
}
function appName(path) {
  const app = path.match(/^.*?\/([^/]+)\.app\//); // outermost .app bundle: helpers report their parent app
  if (app) return app[1];
  const base = path.split('/').pop();
  return base === 'com.apple.WebKit.Networking' ? 'Safari/WebKit' : base;
}
async function runProcessLookup() {
  const batch = lookupQueue;
  lookupQueue = [];
  lookupTimer = null;
  const ours = new Set([proxyPort, browsePort].filter(Boolean));
  const out = await execOut('lsof', ['-nP', '+c', '0', ...[...ours].map((p) => '-iTCP:' + p), '-sTCP:ESTABLISHED', '-F', 'pcn']);
  const byPort = new Map();
  const shortNames = new Map(); // pid -> command name from lsof, used if the process exits before ps runs
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = +line.slice(1);
    else if (line[0] === 'c') shortNames.set(pid, line.slice(1));
    else if (line[0] === 'n' && pid !== process.pid) {
      const m = line.match(/:(\d+)->[^\s]*:(\d+)$/);
      if (m && ours.has(+m[2])) byPort.set(+m[1], pid);
    }
  }
  const unknown = [...new Set(batch.map((b) => byPort.get(b.port)).filter((p) => p && !pidNames.has(p)))];
  if (unknown.length) {
    for (const line of (await execOut('ps', ['-o', 'pid=,comm=', '-p', unknown.join(',')])).split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (m) pidNames.set(+m[1], appName(m[2]));
    }
    if (pidNames.size > 2000) pidNames.clear();
  }
  for (const b of batch) {
    const p = byPort.get(b.port);
    b.resolve(p ? `${pidNames.get(p) || shortNames.get(p) || 'pid'}:${p}` : null);
  }
}
function attachProcess(s, sock) {
  const raw = sock && (sock.__raw || sock);
  if (!raw || !raw.__proc) return;
  if (raw.__procName !== undefined) { s.process = raw.__procName; return; }
  raw.__proc.then((name) => {
    if (!name) return;
    s.process = name;
    if (s.recorded && sessions.has(s.id) && s.source !== 'pending') broadcast('session', summary(s));
  });
}

// ---------------------------------------------------------------- sessions
const sessions = new Map();
let nextSessionId = 1;
let sessionBytes = 0;
const bodyBytes = (s) => (s.reqBody ? s.reqBody.length : 0) + (s.resBody ? s.resBody.length : 0);
function addSession(s) {
  s._bytes = bodyBytes(s);
  sessionBytes += s._bytes;
  sessions.set(s.id, s);
}
function recount(s) {
  if (!sessions.has(s.id)) return;
  const now = bodyBytes(s);
  sessionBytes += now - (s._bytes || 0);
  s._bytes = now;
}
function dropSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  sessionBytes -= s._bytes || 0;
  sessions.delete(id);
  return true;
}
// Keeps the capture within MAX_SESSIONS and MAX_SESSION_BYTES by dropping the oldest sessions.
function trimSessions() {
  const dropped = [];
  for (const id of sessions.keys()) {
    if (sessions.size <= MAX_SESSIONS && sessionBytes <= MAX_SESSION_BYTES) break;
    dropSession(id);
    dropped.push(id);
  }
  if (dropped.length) broadcast('removed', { ids: dropped });
}

function newSession(ctx) {
  const s = {
    id: nextSessionId++,
    ts: ctx.t0 || Date.now(),
    method: ctx.method,
    url: ctx.url,
    mode: ctx.mode,
    httpVersion: ctx.httpVersion || '1.1',
    clientIp: ctx.clientIp || '',
    reqHeaders: ctx.reqPairs || [],
    reqBody: ctx.body && ctx.body.length > MAX_BODY ? ctx.body.subarray(0, MAX_BODY) : ctx.body || Buffer.alloc(0),
    status: 0,
    statusText: '',
    resHeaders: [],
    resBody: Buffer.alloc(0),
    resSize: 0,
    source: 'pending',
    ruleId: null,
    upstream: null,
    error: null,
    note: ctx.note || null,
    duration: null,
    timers: {},
    process: ctx.process || null,
  };
  attachProcess(s, ctx.sock);
  s.timers.ClientBeginRequest = s.ts;
  s.timers.ClientDoneRequest = Date.now();
  if (!settings.capture) return s; // not recorded
  addSession(s);
  trimSessions();
  s.recorded = true;
  broadcast('session', summary(s));
  return s;
}
function finishSession(s, patch) {
  Object.assign(s, patch);
  if (s.recorded) { recount(s); if ('resBody' in patch) trimSessions(); }
  s.duration = Date.now() - s.ts;
  if (s.timers && !s.timers.ClientDoneResponse) s.timers.ClientDoneResponse = Date.now();
  if (s.recorded && sessions.has(s.id)) broadcast('session', summary(s)); // removed sessions stay removed
}
function summary(s) {
  let host = '', pathq = s.url;
  try {
    const u = new URL(s.url);
    host = u.host;
    pathq = u.pathname + u.search;
  } catch {}
  const rule = s.ruleId && rules.find((r) => r.id === s.ruleId);
  return {
    id: s.id, ts: s.ts, method: s.method, url: s.url, host, path: pathq, mode: s.mode,
    status: s.status, source: s.source, ruleId: s.ruleId, ruleSource: rule ? rule.source : null,
    contentType: hdr(s.resHeaders, 'content-type') || '', size: s.resBody.length || s.resSize,
    duration: s.duration, error: s.error, note: s.note,
    protocol: s.method === 'CONNECT' ? 'HTTP' : /^(https|wss):/i.test(s.url) ? 'HTTPS' : 'HTTP',
    caching: caching(s.resHeaders), ruleAction: rule ? rule.action || '' : null,
    mark: s.mark || null,
    process: s.process || '',
    reqHeaderBytes: headerBytes(`${s.method} ${pathq} HTTP/${s.httpVersion}`, s.reqHeaders),
    reqBodyBytes: s.reqBody.length,
    resHeaderBytes: s.status ? headerBytes(`HTTP/1.1 ${s.status} ${s.statusText || ''}`, s.resHeaders) : 0,
    resBodyBytes: s.resSize || s.resBody.length,
  };
}
function headerBytes(startLine, pairs) {
  let n = startLine.length + 4;
  for (const [k, v] of pairs) n += k.length + String(v).length + 4;
  return n;
}
function caching(h) {
  const cc = hdr(h, 'cache-control');
  const ex = hdr(h, 'expires');
  return cc ? String(cc) + (ex ? '; Expires: ' + ex : '') : ex ? 'Expires: ' + ex : '';
}
function sessionDetail(s) {
  return {
    ...summary(s),
    statusText: s.statusText, httpVersion: s.httpVersion, clientIp: s.clientIp, upstream: s.upstream,
    reqHeaders: s.reqHeaders, resHeaders: s.resHeaders, resSize: s.resSize, timers: s.timers || {},
    reqBody: bodyView(s.reqBody, hdr(s.reqHeaders, 'content-type')),
    resBody: bodyView(s.resBody, hdr(s.resHeaders, 'content-type')),
  };
}
// Writes sessions as a HAR file, entry by entry (one big JSON.stringify fails past ~512 MB).
async function writeHar(out, list) {
  const wait = () => new Promise((r) => { out.once('drain', r); out.once('close', r); out.once('error', r); });
  out.write(`{"log":{"version":"1.2","creator":{"name":"HarFiddle","version":${JSON.stringify(require('./package.json').version)}},"pages":[],"entries":[\n`);
  let first = true;
  for (const s of list) {
    if (s.method === 'CONNECT') continue;
    if (out.destroyed) return;
    const ok = out.write((first ? '' : ',\n') + JSON.stringify(sessionToHarEntry(s)));
    first = false;
    if (!ok) await wait();
  }
  out.end('\n]}}\n');
}

function sessionToHarEntry(s) {
  let qs = [];
  try { qs = [...new URL(s.url).searchParams].map(([name, value]) => ({ name, value })); } catch {}
  const resCt = hdr(s.resHeaders, 'content-type') || '';
  const textual = isTextual(resCt, s.resBody) && roundTripsUtf8(s.resBody);
  const entry = {
    startedDateTime: new Date(s.ts).toISOString(),
    time: s.duration || 0,
    request: {
      method: s.method, url: s.url, httpVersion: 'HTTP/' + s.httpVersion,
      headers: s.reqHeaders.map(([name, value]) => ({ name, value: String(value) })),
      queryString: qs, cookies: [], headersSize: -1, bodySize: s.reqBody.length,
    },
    response: {
      status: s.status || 0, statusText: s.statusText || '', httpVersion: 'HTTP/1.1',
      headers: s.resHeaders.map(([name, value]) => ({ name, value: String(value) })),
      cookies: [],
      content: { size: s.resBody.length, mimeType: resCt, text: textual ? s.resBody.toString('utf8') : s.resBody.toString('base64'), ...(textual ? {} : { encoding: 'base64' }) },
      redirectURL: hdr(s.resHeaders, 'location') || '', headersSize: -1, bodySize: s.resSize,
    },
    cache: {},
    timings: { send: 0, wait: s.duration || 0, receive: 0 },
    _harfiddleSource: s.source,
    ...(s.mark ? { _harfiddleMark: s.mark } : {}),
    ...(s.process ? { _harfiddleProcess: s.process } : {}),
  };
  if (s.reqBody.length) {
    const text = roundTripsUtf8(s.reqBody);
    entry.request.postData = { mimeType: hdr(s.reqHeaders, 'content-type') || '', text: s.reqBody.toString(text ? 'utf8' : 'base64'), ...(text ? {} : { _encoding: 'base64' }) };
  }
  return entry;
}

// ---------------------------------------------------------------- rules
function newRule(r) {
  return {
    id: rid(), enabled: true, source: 'custom', method: 'GET', match: '', status: 200, statusText: '',
    headers: [], body: '', mimeType: '', delay: null, harTime: 0, reqBody: null, comment: '', hits: 0, action: '', once: false, ...r,
  };
}
// A rule must produce a final response; 1xx (e.g. a recorded 101 WebSocket switch) can't be replayed.
const validStatus = (n) => (Number.isInteger(+n) && +n >= 200 && +n <= 599 ? +n : null);
// Makes any rule object safe to serve, whatever file or request it came from.
function normalizeRule(r) {
  const out = newRule(r);
  out.id = typeof out.id === 'string' && /^[a-z0-9]{1,40}$/i.test(out.id) ? out.id : rid();
  out.status = validStatus(out.status) || 200;
  out.method = String(out.method || '*').toUpperCase();
  out.match = String(out.match ?? '');
  out.action = String(out.action ?? '');
  out.source = String(out.source || 'custom');
  out.headers = Array.isArray(out.headers) ? out.headers.filter((h) => Array.isArray(h) && h.length >= 2).map(([k, v]) => [String(k), String(v)]) : [];
  out.body = typeof out.body === 'string' ? out.body : '';
  out.enabled = out.enabled !== false;
  out.delay = out.delay == null || out.delay === '' || !Number.isFinite(+out.delay) ? null : Math.max(0, +out.delay);
  return out;
}
const harPairs = (hs) => (Array.isArray(hs) ? hs : []).filter((h) => h && typeof h.name === 'string' && h.name).map((h) => [h.name, String(h.value ?? '')]);

function ruleFromHar(entry, source) {
  const req = entry.request || {};
  const res = entry.response || {};
  if (!/^https?:\/\//i.test(req.url || '') || !validStatus(res.status)) return null;
  const c = res.content || {};
  let body = Buffer.alloc(0);
  if (c.text != null) body = c.encoding === 'base64' ? Buffer.from(c.text, 'base64') : Buffer.from(String(c.text), 'utf8');
  const t = entry.timings || {};
  const pos = (n) => (typeof n === 'number' && n > 0 ? n : 0);
  return newRule({
    source,
    method: String(req.method || 'GET').toUpperCase(),
    match: 'EXACT:' + req.url,
    status: validStatus(res.status) || 200,
    statusText: res.statusText || '',
    headers: harPairs(res.headers).filter(([k]) => !k.startsWith(':')),
    body: body.toString('base64'),
    mimeType: c.mimeType || '',
    harTime: Math.round(pos(t.send) + pos(t.wait) + pos(t.receive)) || Math.round(pos(entry.time)),
    reqBody: req.postData && req.postData.text != null ? String(req.postData.text) : null,
  });
}
function ruleFromSession(s) {
  return newRule({
    source: 'captured',
    method: s.method,
    match: 'EXACT:' + s.url,
    status: s.status || 200,
    statusText: s.statusText || '',
    headers: s.resHeaders.filter(([k]) => !DROP_ON_REPLAY.has(k.toLowerCase()) && !k.startsWith(':')),
    body: s.resBody.toString('base64'),
    mimeType: hdr(s.resHeaders, 'content-type') || '',
    harTime: s.duration || 0,
    reqBody: s.reqBody.length ? s.reqBody.toString('utf8') : null,
  });
}
// rebuild Fiddler-style timers from HAR timings (ms; -1 = not applicable)
function harTimers(t0, t) {
  const p = (n) => (typeof n === 'number' && n > 0 ? n : 0);
  const T = { ClientBeginRequest: t0, ClientDoneRequest: t0 };
  let t1 = t0 + p(t.blocked);
  T.ProxyBeginRequest = t1;
  if (p(t.dns)) T.DNSDone = t1 += p(t.dns);
  const ssl = p(t.ssl);
  if (p(t.connect)) {
    T.ServerConnected = t1 += Math.max(0, p(t.connect) - ssl);
    if (ssl) T.HTTPSDone = t1 += ssl;
  } else { T.ServerConnected = t1; T.reused = true; }
  T.ServerGotRequest = t1 += p(t.send);
  T.ServerBeginResponse = T.ClientBeginResponse = t1 += p(t.wait);
  T.ServerDoneResponse = T.ClientDoneResponse = t1 += p(t.receive);
  return T;
}

const MARKS = new Set(['red', 'blue', 'gold', 'green', 'orange', 'purple']);

// HAR -> sessions (inspect only, nothing is replayed)
function importSessions(name, text) {
  const har = JSON.parse(text);
  const entries = har && har.log && har.log.entries;
  if (!Array.isArray(entries)) throw new Error('Not a HAR file (missing log.entries)');
  const pairs = harPairs;
  let added = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    try {
      const req = e.request || {};
      const res = e.response || {};
      if (typeof req.url !== 'string' || !req.url) continue;
      const c = res.content || {};
      let body = Buffer.alloc(0);
      if (c.text != null) body = c.encoding === 'base64' ? Buffer.from(c.text, 'base64') : Buffer.from(String(c.text), 'utf8');
      const reqHeaders = pairs(req.headers);
      const resHeaders = pairs(res.headers);
      if (!hdr(resHeaders, 'content-type') && c.mimeType) resHeaders.push(['content-type', c.mimeType]);
      const s = {
        id: nextSessionId++,
        ts: Date.parse(e.startedDateTime) || Date.now(),
        method: String(req.method || 'GET').toUpperCase(),
        url: req.url,
        mode: 'har',
        httpVersion: String(req.httpVersion || '1.1').replace(/^HTTP\//i, ''),
        clientIp: '',
        reqHeaders,
        reqBody: req.postData && req.postData.text != null ? Buffer.from(String(req.postData.text), req.postData._encoding === 'base64' ? 'base64' : 'utf8') : Buffer.alloc(0),
        status: Math.trunc(+res.status) || 0,
        statusText: res.statusText || '',
        resHeaders,
        resBody: body,
        resSize: res.bodySize > 0 ? res.bodySize : body.length,
        source: 'har',
        ruleId: null,
        upstream: null,
        error: res.status ? null : res._error || 'No response was recorded for this request',
        note: `Imported from ${name}`,
        duration: Math.round(e.time > 0 ? e.time : 0),
        recorded: true,
        timers: harTimers(Date.parse(e.startedDateTime) || Date.now(), e.timings || {}),
        mark: MARKS.has(e._harfiddleMark) ? e._harfiddleMark : null,
        process: typeof e._harfiddleProcess === 'string' ? e._harfiddleProcess : null,
      };
      addSession(s);
      added++;
    } catch {} // skip malformed entries
  }
  trimSessions();
  broadcast('reload', {});
  log(`Imported ${added} sessions from ${name}`);
  return { name, added };
}

function importHar(name, text) {
  const har = JSON.parse(text);
  const entries = har && har.log && har.log.entries;
  if (!Array.isArray(entries)) throw new Error('Not a HAR file (missing log.entries)');
  const sorted = entries
    .map((e, i) => [e, i])
    .sort((a, b) => (Date.parse(a[0].startedDateTime) || 0) - (Date.parse(b[0].startedDateTime) || 0) || a[1] - b[1])
    .map(([e]) => e);
  const added = [];
  let skipped = 0;
  for (const e of sorted) {
    let r = null;
    try { r = e && typeof e === 'object' ? ruleFromHar(e, name) : null; } catch {} // skip malformed entries
    if (r) added.push(r);
    else skipped++;
  }
  rules = rules.filter((r) => r.source !== name).concat(added);
  sources[name] = { enabled: true, importedAt: Date.now() };
  seq.clear();
  saveState();
  broadcast('rules', {});
  log(`AutoResponder: loaded ${added.length} rules from ${name}${skipped ? ` (${skipped} entries without a response skipped)` : ''}`);
  return { name, added: added.length, skipped };
}
function publicRule(r) {
  const { body, headers, reqBody, ...rest } = r;
  return { ...rest, size: Math.floor((body.length * 3) / 4), contentType: hdr(headers, 'content-type') || r.mimeType || '' };
}
function ruleDetail(r) {
  const buf = Buffer.from(r.body || '', 'base64');
  return { ...r, body: undefined, bodyView: bodyView(buf, hdr(r.headers, 'content-type') || r.mimeType) };
}

// matching
const seq = new Map();
function matchOpts(direct) {
  return {
    ignoreHost: !!(settings.ignoreHost || direct),
    matchQuery: !!settings.matchQuery,
    ignoreParams: new Set(String(settings.ignoreParams || '').split(/[\s,]+/).filter(Boolean)),
  };
}
function urlKey(u, o) {
  let x;
  try { x = new URL(u); } catch { return String(u); }
  let s = o.ignoreHost ? '' : x.protocol + '//' + x.host;
  s += x.pathname;
  if (o.matchQuery) {
    const ps = [...x.searchParams].filter(([k]) => !o.ignoreParams.has(k)).sort((a, b) => (a[0] + '\0' + a[1] < b[0] + '\0' + b[1] ? -1 : 1));
    if (ps.length) s += '?' + ps.map(([k, v]) => k + '=' + v).join('&');
  }
  return s;
}
function ruleMatchesUrl(r, url, reqKey, o, sig) {
  const m = r.match || '';
  if (!r._c || r._c.m !== m || r._c.sig !== sig) {
    const c = { m, sig };
    if (/^exact:/i.test(m)) { c.kind = 'exact'; c.key = urlKey(m.slice(6).trim(), o); }
    else if (/^regex:/i.test(m)) { c.kind = 'regex'; try { c.re = new RegExp(m.slice(6).trim(), 'i'); } catch { c.re = null; } }
    else if (m === '*' || m === '') { c.kind = 'any'; }
    else { c.kind = 'sub'; c.sub = m.toLowerCase(); }
    Object.defineProperty(r, '_c', { value: c, writable: true, configurable: true, enumerable: false });
  }
  const c = r._c;
  if (c.kind === 'exact') return c.key === reqKey;
  if (c.kind === 'regex') return !!c.re && c.re.test(url);
  if (c.kind === 'any') return true;
  return url.toLowerCase().includes(c.sub);
}
function findRule(method, url, body, direct) {
  if (!settings.rulesEnabled) return null;
  const o = matchOpts(direct);
  const sig = [o.ignoreHost, o.matchQuery, [...o.ignoreParams].join(',')].join('|');
  const reqKey = urlKey(url, o);
  const matches = [];
  for (const r of rules) {
    if (!r.enabled || (sources[r.source] && sources[r.source].enabled === false)) continue;
    if (settings.matchMethod && r.method !== '*' && r.method !== method) continue;
    if (!ruleMatchesUrl(r, url, reqKey, o, sig)) continue;
    if (settings.matchBody && r.reqBody != null && canonicalJson(r.reqBody) !== canonicalJson(body.toString('utf8'))) continue;
    matches.push(r);
  }
  if (!matches.length) return null;
  if (matches.length === 1 || settings.duplicates === 'first') return matches[0];
  // Remember which of these rules already answered (not a counter), so rules switching off (match only once)
  // or being edited don't make the sequence skip one.
  const k = method + ' ' + reqKey;
  let played = seq.get(k);
  if (!played) seq.set(k, (played = new Set()));
  let next = matches.find((r) => !played.has(r.id));
  if (!next) {
    if (settings.duplicates === 'cycle') { played.clear(); next = matches[0]; }
    else next = matches[matches.length - 1];
  }
  played.add(next.id);
  return next;
}

// ---------------------------------------------------------------- response sinks
function resSink(res) {
  let closed = false;
  res.once('close', () => (closed = true));
  return {
    get closed() { return closed && !res.writableFinished; },
    writeHead(st, msg, flat) {
      if (msg && /^[\t\x20-\x7e]*$/.test(msg)) res.writeHead(st, msg, flat);
      else res.writeHead(st, flat);
    },
    write: (c) => res.write(c),
    end: (c) => res.end(c),
    destroy: () => res.destroy(),
    reset: () => (res.socket && res.socket.resetAndDestroy ? res.socket.resetAndDestroy() : res.destroy()),
    get sent() { return res.headersSent; },
    onDrain: (f) => res.once('drain', f),
    onClose: (f) => res.once('close', f),
  };
}
function collectSink() {
  let resolve;
  const o = {
    sent: false,
    closed: false,
    done: new Promise((r) => (resolve = r)),
    writeHead() { o.sent = true; },
    write: () => true,
    end: () => resolve(),
    destroy: () => resolve(),
    reset: () => resolve(),
    onDrain: () => {},
    onClose: () => {},
  };
  return o;
}

// ---------------------------------------------------------------- core request handling
function directAdjust(pairs, ctx) {
  if (ctx.mode !== 'direct' || !settings.directFriendly) return pairs;
  const origin = hdr(ctx.reqPairs, 'origin');
  let out = pairs.map(([k, v]) => {
    if (k.toLowerCase() !== 'set-cookie') return [k, v];
    v = String(v).replace(/;\s*domain=[^;]*/gi, '').replace(/;\s*secure(?=;|$)/gi, '').replace(/samesite=none/gi, 'SameSite=Lax');
    return [k, v];
  });
  if (origin) {
    out = out.filter(([k]) => !/^access-control-(allow-origin|allow-credentials|expose-headers)$/i.test(k));
    out.push(['Access-Control-Allow-Origin', origin], ['Access-Control-Allow-Credentials', 'true'], ['Access-Control-Expose-Headers', '*'], ['Vary', 'Origin']);
  }
  return out;
}

function respondSimple(ctx, s, status, body, patch, extra = []) {
  const noBody = status === 204 || status === 304 || status < 200;
  const buf = noBody ? Buffer.alloc(0) : Buffer.from(body);
  const ct = /^\s*[{[]/.test(body) ? 'application/json' : /^\s*</.test(body) ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
  const pairs = directAdjust([...(noBody ? [] : [['Content-Type', ct], ['Content-Length', String(buf.length)]]), ['X-HarFiddle', patch.source], ...extra], ctx);
  try {
    ctx.sink.writeHead(status, null, flatHeaders(pairs));
    ctx.sink.end(ctx.method === 'HEAD' || noBody ? undefined : buf);
  } catch {
    ctx.sink.destroy();
  }
  finishSession(s, { status, resHeaders: pairs, resBody: buf, resSize: buf.length, ...patch });
}

function hitRule(rule) {
  rule.hits = (rule.hits || 0) + 1;
  broadcast('rulehit', { id: rule.id, hits: rule.hits });
  if (rule.once) {
    rule.enabled = false;
    saveState();
    broadcast('rules', {});
  }
}
const FILE_TYPES = { '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.wasm': 'application/wasm' };

// Fiddler-style AutoResponder actions:
//   (empty) recorded response · *200/*404… status only · *delay:ms then go to server · *drop · *reset
//   *redir:url · http(s)://url (map remote, REGEX $1 groups allowed) · /local/file/path
// AutoResponder answers in ~1 ms, often before the client-process lookup (~50 ms) finishes, and the client
// may disconnect right after. On a connection's first request, wait for the lookup: ~50 ms normally, capped at
// 400 ms for when the Mac is busy and lsof is slow.
async function waitForProcess(ctx) {
  const raw = ctx.sock && (ctx.sock.__raw || ctx.sock);
  if (raw && raw.__proc && raw.__procName === undefined) await Promise.race([raw.__proc, sleep(400)]);
}

async function applyRule(ctx, s, rule) {
  await waitForProcess(ctx);
  hitRule(rule);
  s.ruleId = rule.id;
  const action = String(rule.action || '').trim();
  if (!action) return serveRule(ctx, s, rule);
  const subst = (str, forPath) => {
    const re = /^regex:/i.test(rule.match || '') && rule._c && rule._c.re;
    const m = re && ctx.url.match(re);
    if (!m) return str;
    return str.replace(/\$(\d)/g, (_, n) => {
      let v = m[+n] ?? '';
      if (forPath) { try { v = decodeURIComponent(v.split('?')[0]); } catch {} }
      return v;
    });
  };
  let m;
  if (/^\*drop$/i.test(action)) {
    ctx.sink.destroy();
    return finishSession(s, { source: 'auto', note: 'Rule action *drop: connection closed without a response' });
  }
  if (/^\*reset$/i.test(action)) {
    ctx.sink.reset();
    return finishSession(s, { source: 'auto', note: 'Rule action *reset: connection reset' });
  }
  if ((m = action.match(/^\*delay:(\d+)$/i))) {
    await sleep(Math.min(+m[1], 120000));
    if (ctx.sink.closed) return finishSession(s, { source: 'aborted', note: 'The client gave up during the AutoResponder delay' });
    s.note = `Held ${m[1]} ms by AutoResponder, then sent to the server`;
    const up = upstreamFor(ctx);
    if (!up) return respondSimple(ctx, s, 502, 'HarFiddle: *delay rule matched but there is no upstream for a direct request\n', { source: 'blocked' });
    return forward(ctx, s, up);
  }
  if ((m = action.match(/^\*redir:(.+)$/i))) {
    const to = subst(m[1].trim());
    return respondSimple(ctx, s, 307, '', { source: 'auto', note: `Redirected to ${to}` }, [['Location', to]]);
  }
  if ((m = action.match(/^\*(\d{3})\b/))) {
    if (!validStatus(m[1])) return respondSimple(ctx, s, 500, `HarFiddle: "${action}" is not a valid status (use 200-599).\n`, { source: 'error', error: 'Invalid status in rule action' });
    return respondSimple(ctx, s, +m[1], `HarFiddle: HTTP/${m[1]} returned by an AutoResponder rule.\n`, { source: 'auto' });
  }
  if (/^https?:\/\//i.test(action)) {
    const target = subst(action);
    s.note = `AutoResponder mapped this request to ${target}`;
    return forward(ctx, s, target);
  }
  const file = path.resolve(subst(action, true).replace(/^~(?=\/)/, os.homedir()));
  if (path.isAbsolute(action.replace(/^~(?=\/)/, '/'))) {
    // with $1/$2, the request picks part of the path: it must stay inside the folder the rule names
    if (/\$\d/.test(action)) {
      const base = path.resolve(action.slice(0, action.search(/\$\d/)).replace(/^~(?=\/)/, os.homedir()).replace(/[^/]*$/, ''));
      if (file !== base && !file.startsWith(base + path.sep)) {
        return respondSimple(ctx, s, 403, 'HarFiddle: that path is outside the folder this rule serves.\n', { source: 'auto', note: 'Blocked path outside the rule folder' });
      }
    }
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) {
      return respondSimple(ctx, s, 404, `HarFiddle: AutoResponder file not found: ${file}\n`, { source: 'auto', error: e.message });
    }
    const pairs = directAdjust([['Content-Type', FILE_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'], ['Content-Length', String(buf.length)], ['Cache-Control', 'no-cache']], ctx);
    try { ctx.sink.writeHead(200, null, flatHeaders(pairs)); ctx.sink.end(ctx.method === 'HEAD' ? undefined : buf); } catch {}
    return finishSession(s, { status: 200, statusText: 'OK', resHeaders: pairs, resBody: buf, resSize: buf.length, source: 'auto', note: `Served from ${file}` });
  }
  return respondSimple(ctx, s, 500, `HarFiddle: unknown AutoResponder action "${action}"\n`, { source: 'error', error: 'Unknown rule action' });
}

async function serveRule(ctx, s, rule) {
  const delay = rule.delay != null && rule.delay !== '' ? +rule.delay : settings.simulateLatency ? rule.harTime || 0 : 0;
  if (delay > 0) await sleep(Math.min(delay, 120000));
  if (ctx.sink.closed) return finishSession(s, { source: 'aborted', ruleId: rule.id, note: 'The client gave up during the delay' });
  const body = Buffer.from(rule.body || '', 'base64');
  const noBody = rule.status === 204 || rule.status === 304 || rule.status < 200;
  let pairs = rule.headers.filter(([k]) => !DROP_ON_REPLAY.has(k.toLowerCase()) && !k.startsWith(':'));
  if (!noBody) pairs.push(['Content-Length', String(body.length)]);
  pairs = directAdjust(pairs, ctx);
  try {
    s.timers.ClientBeginResponse = Date.now();
    ctx.sink.writeHead(rule.status, rule.statusText, flatHeaders(pairs));
    ctx.sink.end(noBody || ctx.method === 'HEAD' ? undefined : body);
  } catch (e) {
    ctx.sink.destroy(); // never leave the client waiting on a half-written response
    return finishSession(s, { source: 'error', error: 'Failed to write AutoResponse: ' + e.message, ruleId: rule.id });
  }
  finishSession(s, { status: rule.status, statusText: rule.statusText, resHeaders: pairs, resBody: noBody ? Buffer.alloc(0) : body, resSize: body.length, source: 'auto', ruleId: rule.id, note: [s.note, delay ? `delayed ${delay} ms` : ''].filter(Boolean).join(' · ') || null });
}

function forward(ctx, s, upstreamUrl) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(upstreamUrl); } catch {
      respondSimple(ctx, s, 400, `Bad URL: ${upstreamUrl}`, { source: 'error', error: 'Bad URL' });
      return resolve();
    }
    if (isOwnUrl(target.href)) {
      respondSimple(ctx, s, 508, `HarFiddle: refusing to forward to its own port (${target.host}); this would loop.\n`, { source: 'error', error: 'Loop: the request was forwarded to HarFiddle itself' });
      return resolve();
    }
    const secure = target.protocol === 'https:';
    let pairs = ctx.reqPairs.filter(([k]) => !HOP.has(k.toLowerCase()) && !k.startsWith(':') && !/^(content-length|host)$/i.test(k));
    pairs.unshift(['Host', target.host]);
    if (ctx.body.length || /^(POST|PUT|PATCH)$/.test(ctx.method)) pairs.push(['Content-Length', String(ctx.body.length)]);
    if (!s.upstream && upstreamUrl !== ctx.url) s.upstream = upstreamUrl;

    const lib = secure ? https : http;
    let finished = false;
    const up = lib.request({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || (secure ? 443 : 80),
      method: ctx.method,
      path: target.pathname + target.search,
      headers: flatHeaders(pairs),
      rejectUnauthorized: false,
      servername: net.isIP(target.hostname) ? undefined : target.hostname,
    });
    up.setTimeout(120000, () => up.destroy(new Error('Upstream timed out after 120s')));
    const T = s.timers;
    T.ProxyBeginRequest = Date.now();
    up.on('socket', (sock) => {
      if (!sock.connecting) { T.ServerConnected = Date.now(); T.reused = true; return; }
      sock.once('lookup', () => (T.DNSDone = Date.now()));
      sock.once('connect', () => (T.ServerConnected = Date.now()));
      sock.once('secureConnect', () => (T.HTTPSDone = Date.now()));
    });
    up.on('finish', () => (T.ServerGotRequest = Date.now()));
    let clientGone = false;
    ctx.sink.onClose(() => { if (!finished) { clientGone = true; up.destroy(); } });

    up.on('response', (upRes) => {
      up.setTimeout(0); // long polls / event streams may stay quiet for minutes once they've started
      T.ServerBeginResponse = T.ClientBeginResponse = Date.now();
      const resPairs = directAdjust(rawPairs(upRes.rawHeaders).filter(([k]) => !HOP.has(k.toLowerCase())), ctx);
      try { ctx.sink.writeHead(upRes.statusCode, upRes.statusMessage, flatHeaders(resPairs)); } catch {}
      const chunks = [];
      let size = 0;
      upRes.on('data', (c) => {
        if (size + c.length <= MAX_BODY) chunks.push(c);
        size += c.length;
        if (ctx.sink.write(c) === false) {
          upRes.pause();
          ctx.sink.onDrain(() => upRes.resume());
        }
      });
      const done = (err) => {
        if (finished) return;
        finished = true;
        T.ServerDoneResponse = Date.now();
        if (err) ctx.sink.destroy(); else ctx.sink.end();
        const raw = Buffer.concat(chunks);
        finishSession(s, {
          status: upRes.statusCode, statusText: upRes.statusMessage, resHeaders: resPairs,
          resBody: decodeBody(raw, hdr(resPairs, 'content-encoding')), resSize: size,
          source: clientGone ? 'aborted' : err ? 'error' : 'live', error: err && !clientGone ? err.message : null,
          note: clientGone ? 'The client cancelled the request before the response finished'
            : size > MAX_BODY ? `body truncated in capture (${size} bytes)` : s.note,
        });
        resolve();
      };
      upRes.on('end', () => done());
      upRes.on('error', (e) => done(e));
      upRes.on('aborted', () => done(new Error('Upstream aborted')));
    });
    up.on('error', (err) => {
      if (finished) return;
      finished = true;
      if (clientGone) {
        finishSession(s, { source: 'aborted', note: 'The client cancelled the request before a response arrived' });
        return resolve();
      }
      if (s.recorded) log(`${ctx.method} ${ctx.url} failed: ${err.message}`);
      if (!ctx.sink.sent) respondSimple(ctx, s, 502, `HarFiddle could not reach ${target.host}: ${err.message}\n`, { source: 'error', error: err.message });
      else { ctx.sink.destroy(); finishSession(s, { source: 'error', error: err.message }); }
      resolve();
    });
    up.end(ctx.body);
  });
}

async function handle(ctx) {
  const s = newSession(ctx);
  ctx.session = s;

  const direct = ctx.mode === 'direct';
  if (direct && settings.directFriendly && ctx.method === 'OPTIONS' && hdr(ctx.reqPairs, 'access-control-request-method')) {
    const r = findRule('OPTIONS', ctx.url, ctx.body, true);
    if (r) return applyRule(ctx, s, r);
    await waitForProcess(ctx);
    const extra = [
      ['Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS'],
      ['Access-Control-Allow-Headers', hdr(ctx.reqPairs, 'access-control-request-headers') || '*'],
      ['Access-Control-Max-Age', '600'],
    ];
    return respondSimple(ctx, s, 204, '', { source: 'auto', note: 'CORS preflight answered by HarFiddle' }, extra);
  }

  const rule = ctx.useRules === false ? null : findRule(ctx.method, ctx.url, ctx.body, direct);
  if (rule) return applyRule(ctx, s, rule);

  if (settings.rulesEnabled && !settings.passthrough && ctx.useRules !== false) {
    return respondSimple(ctx, s, 404, 'HarFiddle: no AutoResponder rule matched (unmatched passthrough is off)\n', { source: 'blocked' });
  }

  const upstream = upstreamFor(ctx);
  if (!upstream) {
    {
      const u = new URL(ctx.url);
      if (u.pathname === '/' && /html/.test(hdr(ctx.reqPairs, 'accept') || '')) {
        return respondSimple(ctx, s, 404, `<!doctype html><title>HarFiddle</title><body style="font:15px system-ui;padding:40px;color:#333"><h2>HarFiddle proxy is running</h2><p>No AutoResponder rule matched <code>/</code> and no fallback upstream is set.</p><p>Open the UI: <a href="http://127.0.0.1:${UI_PORT}">http://127.0.0.1:${UI_PORT}</a></p></body>`, { source: 'blocked' });
      }
      return respondSimple(ctx, s, 502, JSON.stringify({ error: 'HarFiddle: no AutoResponder rule matched and no fallback upstream is configured', method: ctx.method, path: u.pathname + u.search }), { source: 'blocked', note: 'No rule and no fallback upstream' });
    }
  }
  return forward(ctx, s, upstream);
}

// where a request goes when no rule answers it
function upstreamFor(ctx) {
  if (ctx.mode !== 'direct') return ctx.url;
  const fb = String(settings.fallbackUpstream || '').trim().replace(/\/+$/, '');
  if (!fb) return null;
  const u = new URL(ctx.url);
  return (/^https?:\/\//i.test(fb) ? fb : 'https://' + fb) + u.pathname + u.search;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function classify(req) {
  const sock = req.socket;
  let mode = 'proxy', url;
  if (sock.__target) {
    const tPort = String(sock.__target).match(/:(\d+)$/);
    let host = req.headers.host || sock.__target;
    if (!/:\d+$/.test(host) && !/^\[.*\]$/.test(host) && tPort && tPort[1] !== (sock.encrypted ? '443' : '80')) host += ':' + tPort[1];
    url = `${sock.encrypted ? 'https' : 'http'}://${host}${req.url}`;
  }
  else if (/^https?:\/\//i.test(req.url)) url = req.url;
  else { mode = 'direct'; url = `http://${req.headers.host || 'localhost:' + proxyPort}${req.url}`; }
  // an absolute URL that names the proxy itself is really a direct request
  if (mode === 'proxy' && !sock.__target && localPort(url) === proxyPort) {
    mode = 'direct';
    try { const u = new URL(url); url = `http://localhost:${proxyPort}${u.pathname}${u.search}`; } catch {}
  }
  return { mode, url, own: mode === 'proxy' && isOwnUrl(url) };
}

async function onProxyRequest(req, res, presetBody) {
  const t0 = Date.now();
  if (req.socket.__requests != null) {
    req.socket.__requests++;
    hostWorked.set(req.socket.__host, t0);
  }
  let ctx;
  try {
    const { mode, url, own } = classify(req);
    if (own) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('HarFiddle does not proxy requests to its own ports.\n');
    }
    const body = presetBody !== undefined ? presetBody : await readBody(req);
    ctx = {
      method: req.method, url, mode, body, t0, sock: req.socket,
      reqPairs: rawPairs(req.rawHeaders), httpVersion: req.httpVersion,
      clientIp: req.socket.remoteAddress, sink: resSink(res),
    };
    await handle(ctx);
  } catch (e) {
    // anything unexpected: answer instead of leaving the client hanging
    log(`Internal error while handling ${req.method} ${req.url}: ${e.message}`);
    try {
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(`HarFiddle internal error: ${e.message}\n`); }
      else res.destroy();
    } catch {}
    if (ctx && ctx.session && ctx.session.source === 'pending') finishSession(ctx.session, { status: 500, source: 'error', error: 'Internal error: ' + e.message });
  }
}

// WebSocket & other upgrades: pipe through (not inspected frame-by-frame)
function onUpgrade(req, sock, head) {
  sock.on('error', () => {});
  if (!/\bwebsocket\b/i.test(String(req.headers.upgrade || ''))) {
    // Other upgrade offers (e.g. "Upgrade: h2c" from curl --http2 or Java's HttpClient) are optional:
    // ignore the offer and answer as a normal HTTP/1.1 request, so rules and the inspector still work.
    const res = new http.ServerResponse(req);
    res.shouldKeepAlive = false;
    res.assignSocket(sock);
    res.on('finish', () => sock.end());
    return onProxyRequest(req, res, head || Buffer.alloc(0));
  }
  let mode, url, t;
  try {
    ({ mode, url } = classify(req));
    if (isOwnUrl(url)) return sock.destroy();
    if (mode === 'direct') {
      const fb = String(settings.fallbackUpstream || '').trim().replace(/\/+$/, '');
      if (!fb) return sock.destroy();
      const u = new URL(url);
      url = (/^https?:\/\//i.test(fb) ? fb : 'https://' + fb) + u.pathname + u.search;
      if (isOwnUrl(url)) return sock.destroy();
    }
    t = new URL(url.replace(/^ws/, 'http'));
  } catch {
    return sock.destroy();
  }
  const secure = t.protocol === 'https:';
  const s = newSession({ method: req.method, url, mode, reqPairs: rawPairs(req.rawHeaders), httpVersion: req.httpVersion, clientIp: sock.remoteAddress, sock });
  const port = +(t.port || (secure ? 443 : 80));
  const host = t.hostname.replace(/^\[|\]$/g, '');
  const up = secure
    ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
    : net.connect(port, host);
  let first = true;
  up.once(secure ? 'secureConnect' : 'connect', () => {
    const lines = [`${req.method} ${t.pathname}${t.search} HTTP/1.1`];
    for (const [k, v] of rawPairs(req.rawHeaders)) {
      if (/^proxy-/i.test(k)) continue;
      lines.push(`${k}: ${/^host$/i.test(k) ? t.host : v}`);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    sock.pipe(up);
    up.pipe(sock);
  });
  up.on('data', (c) => {
    if (first) {
      first = false;
      const m = c.toString('latin1', 0, 64).match(/^HTTP\/\d\.\d (\d{3})/);
      finishSession(s, { status: m ? +m[1] : 0, source: 'live', note: 'WebSocket/upgrade tunnel — frames are not inspected' });
    }
  });
  let closed = false;
  const close = (err) => {
    if (closed) return;
    closed = true;
    if (!s.status) finishSession(s, { source: 'error', error: err ? err.message : 'The connection closed before the server answered the WebSocket request' });
    else finishSession(s, { note: `WebSocket closed: ${sock.bytesRead} bytes sent, ${up.bytesRead} bytes received` });
    up.destroy();
    sock.destroy();
  };
  up.on('error', close);
  sock.on('error', close);
  up.on('close', () => close());
  sock.on('close', () => close());
  // either side hanging up ends the tunnel (otherwise a half-closed socket keeps it open)
  up.on('end', () => close());
  sock.on('end', () => close());
}

// CONNECT: decrypt TLS with our CA, or tunnel it untouched.
//
// Traffic from the system proxy comes from every app on the Mac, and many of them don't trust (or pin
// against) our certificate, so decrypting it blindly breaks the internet. Rules:
//   • explicit clients (Browse, curl -x, a proxy you configured while system capture is off): decrypt
//   • system capture: decrypt port 443 only, only while macOS trusts the root certificate, and never for
//     hosts where an app rejected our certificate (those are tunneled for REJECT_TTL)
const tlsErrorSeen = new Map();
const rejectedHosts = new Map(); // host -> until (ms)
const REJECT_TTL = 30 * 60 * 1000;
const hostWorked = new Map(); // host -> last time a decrypted request arrived
const quickCloses = new Map(); // host -> [timestamps of handshakes closed without a request]
const REJECT_ALERTS = /ALERT_(UNKNOWN_CA|BAD_CERTIFICATE|CERTIFICATE_UNKNOWN|UNSUPPORTED_CERTIFICATE|CERTIFICATE_REVOKED|ACCESS_DENIED)/;

function decryptDecision(host, port, explicit) {
  if (!settings.decryptHttps) return 'HTTPS decryption is off';
  if (hostMatches(host, settings.tunnelHosts)) return 'host is in the Skip decryption list';
  if (explicit) return null;
  if (port !== 443) return `port ${port} is not standard HTTPS`;
  if (!caTrusted) return 'macOS does not trust the HarFiddle root certificate yet (Tools › Trust Root Certificate)';
  const until = rejectedHosts.get(host);
  if (until && until > Date.now()) return 'an app rejected the HarFiddle certificate for this host earlier';
  return null;
}
function markRejected(host, why) {
  if (rejectedHosts.has(host) && rejectedHosts.get(host) > Date.now()) return;
  rejectedHosts.set(host, Date.now() + REJECT_TTL);
  log(`Not decrypting ${host} for 30 minutes: ${why}. Its traffic is tunneled so the app keeps working.`);
}

function onConnect(req, sock, head) {
  const m = req.url.match(/^\[?([^\]]+?)\]?:(\d+)$/) || [null, req.url, '443'];
  const host = m[1].toLowerCase();
  const port = +m[2];
  sock.on('error', () => {});
  if (!(port >= 1 && port <= 65535) || !host || /[\s/]/.test(host)) { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} return; }
  if (isOwnPort(host, port)) { try { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch {} return; }
  // From system capture unless it came in on the Browse port or capture is off (a client chose this proxy).
  const explicit = sock.localPort === browsePort || !systemProxyOn;
  sock.on('error', () => {});

  const tunnel = (initial, why) => {
    const s = newSession({ method: 'CONNECT', url: `https://${req.url}/`, mode: 'proxy', reqPairs: rawPairs(req.rawHeaders), clientIp: sock.remoteAddress, sock });
    const up = net.connect(port, host, () => {
      if (!initial) sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (initial && initial.length) up.write(initial);
      if (head && head.length && !initial) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
      sock.resume();
      finishSession(s, { status: 200, source: 'tunnel', note: `Tunneled without decryption: ${why}` });
    });
    up.on('error', (e) => {
      if (!s.status) {
        try { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
        finishSession(s, { status: 502, source: 'error', error: e.message });
      }
      sock.destroy();
    });
    sock.on('close', () => { up.destroy(); if (s.status === 200) finishSession(s, { note: `${s.note} (${sock.bytesRead} bytes sent, ${up.bytesRead} received)` }); });
  };

  const why = decryptDecision(host, port, explicit);
  if (why) return tunnel(null, why);

  sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  const start = (first) => {
    if (first[0] !== 0x16) return tunnel(sock.read() || first, 'not a TLS connection');
    let ctx;
    try { ctx = ca.contextFor(host); } catch (e) { return sock.destroy(); }
    const tlsSock = new tls.TLSSocket(sock, {
      isServer: true,
      secureContext: ctx,
      ALPNProtocols: ['http/1.1'],
      SNICallback: (name, cb) => { try { cb(null, ca.contextFor(name)); } catch (e) { cb(e); } },
    });
    tlsSock.__target = req.url;
    tlsSock.__raw = sock;
    tlsSock.__requests = 0;
    let secureAt = 0;
    tlsSock.once('secure', () => (secureAt = Date.now()));
    tlsSock.__host = host;
    // Browsers sometimes close a spare connection the same way, so a host is only marked when it happens
    // twice within a minute and no request to it has worked recently.
    // Apps that reject the certificate often just close the socket: during the handshake (TLS 1.3) or
    // right after it (TLS 1.2), without sending an alert.
    tlsSock.once('close', () => {
      if (explicit || tlsSock.__requests > 0 || (secureAt && Date.now() - secureAt > 1500)) return;
      if ((hostWorked.get(host) || 0) > Date.now() - 120000) return;
      const recent = (quickCloses.get(host) || []).filter((t) => t > Date.now() - 60000).concat(Date.now());
      quickCloses.set(host, recent);
      if (recent.length >= 2) markRejected(host, 'an app keeps closing the connection when it sees the certificate (it does not trust it, or pins its own)');
    });
    tlsSock.on('error', (err) => {
      if (secureAt) return;
      const code = err.code || err.message;
      const rejected = REJECT_ALERTS.test(code);
      if (rejected && !explicit) markRejected(host, `an app rejected the certificate (${code})`);
      if (!rejected) return; // resets during the handshake are usually just cancelled connections
      const last = tlsErrorSeen.get(host) || 0;
      if (Date.now() - last < 10000) return;
      tlsErrorSeen.set(host, Date.now());
      const s = newSession({ method: 'CONNECT', url: `https://${req.url}/`, mode: 'proxy', reqPairs: rawPairs(req.rawHeaders), clientIp: sock.remoteAddress, sock });
      finishSession(s, {
        status: 0, source: 'error',
        error: `The client rejected HarFiddle's certificate for ${host} (${code}). ` +
          (explicit ? 'Trust the root certificate (Tools › Trust Root Certificate) or use Browse.' : 'This host will be tunneled without decryption so the app keeps working.'),
      });
    });
    proxyServer.emit('connection', tlsSock);
  };
  if (head && head.length) { sock.unshift(head); start(head); }
  else sock.once('data', (d) => { sock.pause(); sock.unshift(d); start(d); });
}

// ---------------------------------------------------------------- macOS system proxy
function run(cmd, args, timeout = 15000) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout }, (e, out, err) => (e ? reject(new Error((err || e.message).trim())) : resolve(out))));
}
async function networkServices() {
  const out = await run('networksetup', ['-listallnetworkservices']);
  return out.split('\n').slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith('*'));
}
function parseProxyInfo(out) {
  const g = (k) => ((out.match(new RegExp('^' + k + ':\\s*(.*)$', 'm')) || [])[1] || '').trim();
  return { enabled: g('Enabled') === 'Yes', server: g('Server'), port: g('Port') };
}
let systemProxyOn = false;
// What macOS is actually using right now (one fast scutil call instead of several networksetup calls).
async function systemProxyStatus() {
  if (process.platform !== 'darwin') return false;
  try {
    const out = await run('scutil', ['--proxy']);
    const g = (k) => (out.match(new RegExp('\\b' + k + '\\s*:\\s*(\\S+)')) || [])[1];
    return g('HTTPEnable') === '1' && g('HTTPProxy') === '127.0.0.1' && +g('HTTPPort') === proxyPort;
  } catch {
    return false;
  }
}
let proxyToggle = Promise.resolve();
let togglingProxy = false;
function setSystemProxy(on) {
  // serialize clicks so two toggles never interleave their networksetup calls
  const next = proxyToggle.then(async () => {
    togglingProxy = true;
    try { await applySystemProxy(on); } finally { togglingProxy = false; }
  });
  proxyToggle = next.catch(() => {});
  return next;
}
async function applySystemProxy(on) {
  if (process.platform !== 'darwin') throw new Error('System proxy toggle is only implemented for macOS');
  if (on === systemProxyOn) return;
  if (on) {
    const [services] = await Promise.all([networkServices(), checkCaTrust()]);
    const existing = readBackup();
    if (backupOwnedByOther(existing)) throw new Error('Another copy of HarFiddle is capturing system traffic right now. Quit it first.');
    const backup = existing || {};
    await Promise.all(services.filter((svc) => !backup[svc]).map(async (svc) => {
      const [web, secure] = await Promise.all([run('networksetup', ['-getwebproxy', svc]), run('networksetup', ['-getsecurewebproxy', svc])]);
      backup[svc] = { web: parseProxyInfo(web), secure: parseProxyInfo(secure) };
    }));
    backup._owner = process.pid;
    fs.writeFileSync(SYSPROXY_BACKUP, JSON.stringify(backup));
    systemProxyOn = true; // before macOS starts sending traffic, so the first connections count as system traffic
    const errors = [];
    for (const svc of services) { // sequential: networksetup locks the network preferences
      try {
        await run('networksetup', ['-setsecurewebproxy', svc, '127.0.0.1', String(proxyPort)]);
        await run('networksetup', ['-setwebproxy', svc, '127.0.0.1', String(proxyPort)]);
      } catch (e) {
        errors.push(`${svc}: ${e.message}`);
      }
    }
    let active = false;
    for (let i = 0; i < 10 && !active; i++) {
      active = await systemProxyStatus();
      if (!active) await sleep(50);
    }
    if (!active && errors.length) {
      systemProxyOn = false;
      await restoreSystemProxy();
      log('Could not capture system traffic: ' + errors.join('; '));
      throw new Error(errors.join('; '));
    }
    log(`Capturing system traffic: ${services.join(', ')} now use 127.0.0.1:${proxyPort}`);
    if (!caTrusted) log('HTTPS from system traffic is tunneled, not decrypted, because macOS does not trust the HarFiddle root certificate. Trust it to see HTTPS contents.');
  } else {
    await restoreSystemProxy();
    systemProxyOn = false;
    log('Stopped capturing system traffic; previous proxy settings restored');
  }
  broadcast('info', await info());
}
// Puts back what each network service had before capture started: a proxy that was on gets its old host and
// port back; one that was off is turned off (its greyed-out address doesn't matter, and re-setting it would
// briefly switch it on).
// The backup records which HarFiddle process turned capture on (`_owner`), so a second copy starting up
// never undoes a capture that another running copy owns.
function readBackup() {
  try { return JSON.parse(fs.readFileSync(SYSPROXY_BACKUP, 'utf8')); } catch { return null; }
}
function backupOwnedByOther(backup) {
  const pid = backup && backup._owner;
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const PROXY_KINDS = [['web', '-setwebproxy', '-setwebproxystate'], ['secure', '-setsecurewebproxy', '-setsecurewebproxystate']];
// The commands that put one network service back the way the backup says it was.
function restoreCommands(backup) {
  const cmds = [];
  for (const [svc, b] of Object.entries(backup || {})) {
    if (svc.startsWith('_') || !b) continue;
    for (const [kind, set, state] of PROXY_KINDS) {
      const p = b[kind] || {};
      cmds.push(p.enabled && p.server ? [set, svc, p.server, String(+p.port || 8080)] : [state, svc, 'off']);
    }
  }
  return cmds;
}
// Puts back what each network service had before capture started: a proxy that was on gets its old host and
// port back; one that was off is turned off (its greyed-out address doesn't matter, and re-setting it would
// briefly switch it on). The backup is only deleted once every service was restored.
async function restoreSystemProxy() {
  const backup = readBackup();
  let failed = 0;
  for (const args of restoreCommands(backup)) {
    try { await run('networksetup', args); } catch { failed++; }
  }
  // no backup (or it didn't cover every service) but macOS still points at us: switch our proxy off everywhere
  if (await systemProxyStatus()) {
    for (const svc of await networkServices().catch(() => [])) {
      for (const [, , state] of PROXY_KINDS) { try { await run('networksetup', [state, svc, 'off']); } catch { failed++; } }
    }
  }
  if (!failed) { try { fs.unlinkSync(SYSPROXY_BACKUP); } catch {} }
  else log(`Could not restore ${failed} proxy setting(s); the backup in ${SYSPROXY_BACKUP} was kept so the next start retries.`);
}
// Synchronous version for process exit and startup after a crash.
function restoreSystemProxySync() {
  const backup = readBackup();
  if (!backup || backupOwnedByOther(backup)) return;
  let failed = 0;
  for (const args of restoreCommands(backup)) {
    try { execFileSync('networksetup', args, { timeout: 10000 }); } catch { failed++; }
  }
  if (!failed) { try { fs.unlinkSync(SYSPROXY_BACKUP); } catch {} console.log('System proxy settings restored.'); }
  else console.error(`Could not restore ${failed} system proxy setting(s); will retry on the next start.`);
}

function launchBrowser(which, startUrl) {
  const app = which === 'edge' ? 'Microsoft Edge' : 'Google Chrome';
  const profile = path.join(DATA_DIR, which === 'edge' ? 'edge-profile' : 'chrome-profile');
  const args = ['-na', app, '--args',
    `--proxy-server=http://127.0.0.1:${browsePort || proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    `--user-data-dir=${profile}`,
    '--ignore-certificate-errors',
    '--no-first-run', '--no-default-browser-check',
  ];
  if (startUrl && /^https?:\/\/[^\s]+$/i.test(String(startUrl))) args.push(String(startUrl));
  return run('open', args);
}

// ---------------------------------------------------------------- UI / API server
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function sendJson(res, status, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
// Parses a JSON object body; anything else (null, arrays, numbers) becomes {}.
async function jsonObject(req) {
  const v = await jsonBody(req);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
async function jsonBody(req) {
  const b = await readBody(req);
  return b.length ? JSON.parse(b.toString('utf8')) : {};
}
function lanIps() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}
let caTrusted = null;
// macOS trust can change behind our back (Keychain Access), so re-check while capturing
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of tlsErrorSeen) if (now - t > 60000) tlsErrorSeen.delete(k);
  for (const [k, t] of hostWorked) if (now - t > 10 * 60000) hostWorked.delete(k);
  for (const [k, list] of quickCloses) if (!list.some((t) => now - t < 60000)) quickCloses.delete(k);
  for (const [k, until] of rejectedHosts) if (until < now) rejectedHosts.delete(k);
}, 60000).unref();
setInterval(async () => {
  // Someone may have changed the proxy in System Settings: follow what macOS actually does.
  if (!togglingProxy && process.platform === 'darwin') {
    const active = await systemProxyStatus();
    if (!togglingProxy && active !== systemProxyOn) {
      systemProxyOn = active;
      log(active ? 'macOS is using HarFiddle as its proxy' : 'macOS is no longer using HarFiddle as its proxy (changed outside HarFiddle)');
      broadcast('info', await info());
    }
  }
  if (!systemProxyOn) return;
  const before = caTrusted;
  if ((await checkCaTrust()) !== before) {
    log(caTrusted ? 'The HarFiddle root certificate is now trusted; decrypting system HTTPS traffic' : 'The HarFiddle root certificate is no longer trusted; tunneling system HTTPS traffic');
    broadcast('info', await info());
  }
}, 20000).unref();
async function checkCaTrust() {
  if (process.platform !== 'darwin') return (caTrusted = false);
  try { await run('security', ['verify-cert', '-c', ca.caCertPath]); caTrusted = true; }
  catch { caTrusted = false; }
  return caTrusted;
}
async function info() {
  if (caTrusted === null) await checkCaTrust();
  return {
    caTrusted,
    proxyPort: proxyPort, uiPort: UI_PORT, browsePort, lan: LAN, lanIps: LAN ? lanIps() : [],
    caPath: ca.caCertPath, caFingerprint: ca.fingerprint(), dataDir: DATA_DIR,
    systemProxy: systemProxyOn, platform: process.platform,
    browsers: {
      chrome: fs.existsSync('/Applications/Google Chrome.app'),
      edge: fs.existsSync('/Applications/Microsoft Edge.app'),
    },
  };
}

async function api(req, res, u) {
  const p = u.pathname;
  const m = req.method;
  let mm;

  if (p === '/api/info' && m === 'GET') return sendJson(res, 200, await info());
  if (p === '/api/settings' && m === 'GET') return sendJson(res, 200, settings);
  if (p === '/api/settings' && m === 'PUT') {
    const patch = cleanSettings(await jsonObject(req));
    if (patch.fallbackUpstream) {
      const fb = /^https?:\/\//i.test(patch.fallbackUpstream) ? patch.fallbackUpstream : 'https://' + patch.fallbackUpstream;
      try { new URL(fb); } catch { return sendJson(res, 400, { error: 'The fallback upstream is not a valid URL' }); }
      if (isOwnUrl(fb)) return sendJson(res, 400, { error: 'The fallback upstream cannot be HarFiddle itself; requests would loop forever' });
    }
    Object.assign(settings, patch);
    seq.clear();
    saveState();
    broadcast('settings', settings);
    return sendJson(res, 200, settings);
  }

  // sessions
  if (p === '/api/sessions' && m === 'GET') return sendJson(res, 200, [...sessions.values()].map(summary));
  if (p === '/api/sessions' && m === 'DELETE') {
    const b = await jsonObject(req); // malformed JSON throws -> 400, instead of clearing everything
    if (Array.isArray(b.ids)) {
      b.ids.forEach((id) => dropSession(+id));
      broadcast('removed', { ids: b.ids.map(Number) });
    } else {
      sessions.clear();
      sessionBytes = 0;
      broadcast('cleared', {});
    }
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/sessions/replay' && m === 'POST') {
    const b = await jsonObject(req);
    const out = [];
    const wasCapturing = settings.capture;
    settings.capture = true;
    for (const id of Array.isArray(b.ids) ? b.ids : []) {
      const old = sessions.get(+id);
      if (!old || old.method === 'CONNECT') continue;
      const reqPairs = old.reqHeaders.filter(([k]) => !k.startsWith(':'));
      if (!hdr(reqPairs, 'host')) { try { reqPairs.unshift(['Host', new URL(old.url).host]); } catch {} }
      handle({ method: old.method, url: old.url, mode: old.mode === 'direct' ? 'direct' : 'composer', reqPairs, body: old.reqBody, useRules: b.useRules !== false, sink: collectSink(), note: `Reissued from #${old.id}`, process: 'HarFiddle (reissue)' });
      out.push(nextSessionId - 1);
    }
    settings.capture = wasCapturing;
    return sendJson(res, 200, { ids: out });
  }
  if (p === '/api/log' && m === 'GET') return sendJson(res, 200, logBuf);
  if (p === '/api/sessions/mark' && m === 'POST') {
    const b = await jsonObject(req);
    const mark = MARKS.has(b.mark) ? b.mark : null;
    for (const id of Array.isArray(b.ids) ? b.ids : []) {
      const s = sessions.get(+id);
      if (!s) continue;
      s.mark = mark;
      broadcast('session', summary(s));
    }
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/sessions/import' && m === 'POST') {
    const name = (u.searchParams.get('name') || 'imported.har').slice(0, 200);
    return sendJson(res, 200, importSessions(name, (await readBody(req)).toString('utf8')));
  }
  if (p === '/api/sessions/export.har' && m === 'GET') {
    const ids = u.searchParams.get('ids');
    const list = ids ? ids.split(',').map(Number).map((id) => sessions.get(id)).filter(Boolean) : [...sessions.values()];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="harfiddle-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.har"` });
    await writeHar(res, list);
    return;
  }
  // Open a HAR file from disk by its path (the app's Open dialog and dropped files provide the path).
  if (p === '/api/sessions/open' && m === 'POST') {
    const b = await jsonObject(req);
    const file = String(b.path || '');
    if (!path.isAbsolute(file)) return sendJson(res, 400, { error: 'An absolute file path is required' });
    let st;
    try { st = fs.statSync(file); } catch { return sendJson(res, 404, { error: `File not found: ${file}` }); }
    if (!st.isFile()) return sendJson(res, 400, { error: `Not a file: ${file}` });
    if (st.size > 1024 * 1024 * 1024) return sendJson(res, 400, { error: 'The file is larger than 1 GB' });
    const r = importSessions(path.basename(file), fs.readFileSync(file, 'utf8'));
    return sendJson(res, 200, { ...r, path: file });
  }
  // Save the session list (or some ids) to a HAR file: written next to it first, then swapped in, so a failed
  // save never leaves a half-written file behind.
  if (p === '/api/sessions/save' && m === 'POST') {
    const b = await jsonObject(req);
    const file = String(b.path || '');
    if (!path.isAbsolute(file) || !/\.(har|json)$/i.test(file)) return sendJson(res, 400, { error: 'Choose a .har file to save to' });
    const list = Array.isArray(b.ids) ? b.ids.map(Number).map((id) => sessions.get(id)).filter(Boolean) : [...sessions.values()];
    const tmp = `${file}.harfiddle-${process.pid}.tmp`;
    try {
      const out = fs.createWriteStream(tmp);
      const done = new Promise((resolve, reject) => { out.once('finish', resolve); out.once('error', reject); });
      await writeHar(out, list);
      await done;
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      return sendJson(res, 500, { error: `Could not save ${path.basename(file)}: ${e.message}` });
    }
    const count = list.filter((s) => s.method !== 'CONNECT').length;
    log(`Saved ${count} sessions to ${file}`);
    return sendJson(res, 200, { path: file, name: path.basename(file), count });
  }
  if ((mm = p.match(/^\/api\/sessions\/(\d+)$/)) && m === 'GET') {
    const s = sessions.get(+mm[1]);
    return s ? sendJson(res, 200, sessionDetail(s)) : sendJson(res, 404, { error: 'Session no longer in memory' });
  }
  if ((mm = p.match(/^\/api\/sessions\/(\d+)\/torule$/)) && m === 'POST') {
    const s = sessions.get(+mm[1]);
    if (!s) return sendJson(res, 404, { error: 'Session not found' });
    if (!s.status) return sendJson(res, 400, { error: 'Session has no response to replay' });
    const r = ruleFromSession(s);
    rules.unshift(r);
    if (!sources.captured) sources.captured = { enabled: true, importedAt: Date.now() };
    saveState();
    broadcast('rules', {});
    return sendJson(res, 200, publicRule(r));
  }

  // rules
  if (p === '/api/rules' && m === 'GET') return sendJson(res, 200, { rules: rules.map(publicRule), sources });
  if (p === '/api/rules/import' && m === 'POST') {
    const name = (u.searchParams.get('name') || 'imported.har').slice(0, 200);
    const text = (await readBody(req)).toString('utf8');
    return sendJson(res, 200, importHar(name, text));
  }
  if (p === '/api/rules' && m === 'POST') {
    const b = await jsonObject(req);
    if (b.status != null && !validStatus(b.status)) return sendJson(res, 400, { error: 'Status must be between 200 and 599' });
    const r = normalizeRule({
      source: 'custom', method: String(b.method || '*').toUpperCase(), match: String(b.match || ''), status: validStatus(b.status) || 200, action: String(b.action || '').trim(),
      headers: parseHeaderText(b.headersText || 'Content-Type: application/json'),
      body: Buffer.from(b.bodyText || '', 'utf8').toString('base64'),
    });
    rules.unshift(r);
    if (!sources.custom) sources.custom = { enabled: true, importedAt: Date.now() };
    saveState();
    broadcast('rules', {});
    return sendJson(res, 200, ruleDetail(r));
  }
  if (p === '/api/rules/bulk' && m === 'POST') {
    const b = await jsonObject(req);
    const ids = new Set(b.ids || []);
    const pick = (r) => (b.source ? r.source === b.source : ids.has(r.id));
    if (b.action === 'delete') {
      rules = rules.filter((r) => !pick(r));
      if (b.source) delete sources[b.source];
    } else if (b.action === 'enable' || b.action === 'disable') {
      rules.forEach((r) => pick(r) && (r.enabled = b.action === 'enable'));
    } else if (b.action === 'resetHits') {
      rules.forEach((r) => (r.hits = 0));
      seq.clear();
    }
    saveState();
    broadcast('rules', {});
    return sendJson(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/api\/sources\/(.+)$/)) && m === 'PUT') {
    const name = decodeURIComponent(mm[1]);
    const b = await jsonObject(req);
    sources[name] = { ...(sources[name] || {}), enabled: !!b.enabled };
    seq.clear();
    saveState();
    broadcast('rules', {});
    return sendJson(res, 200, sources[name]);
  }
  if ((mm = p.match(/^\/api\/rules\/([a-f0-9]+)$/))) {
    const idx = rules.findIndex((r) => r.id === mm[1]);
    if (idx === -1) return sendJson(res, 404, { error: 'Rule not found' });
    const r = rules[idx];
    if (m === 'GET') return sendJson(res, 200, ruleDetail(r));
    if (m === 'DELETE') {
      rules.splice(idx, 1);
      saveState();
      broadcast('rules', {});
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'PUT') {
      const b = await jsonObject(req);
      if ('enabled' in b) r.enabled = !!b.enabled;
      if ('method' in b) r.method = String(b.method || '*').toUpperCase();
      if ('match' in b) r.match = String(b.match);
      if ('status' in b && !validStatus(b.status)) return sendJson(res, 400, { error: 'Status must be between 200 and 599' });
      if ('status' in b) r.status = validStatus(b.status);
      if ('statusText' in b) r.statusText = String(b.statusText || '');
      if ('delay' in b) r.delay = b.delay === '' || b.delay == null ? null : +b.delay;
      if ('comment' in b) r.comment = String(b.comment || '');
      if ('action' in b) r.action = String(b.action || '').trim();
      if ('once' in b) r.once = !!b.once;
      if ('headersText' in b) r.headers = parseHeaderText(b.headersText);
      if (typeof b.bodyText === 'string') r.body = Buffer.from(b.bodyText, 'utf8').toString('base64');
      if (typeof b.bodyBase64 === 'string') r.body = b.bodyBase64;
      if ('move' in b) {
        rules.splice(idx, 1);
        rules.splice(b.move === 'top' ? 0 : rules.length, 0, r);
      }
      seq.clear();
      saveState();
      broadcast('rules', {});
      return sendJson(res, 200, ruleDetail(r));
    }
  }
  if (p === '/api/test-match' && m === 'POST') {
    const b = await jsonObject(req);
    const method = String(b.method || 'GET').toUpperCase();
    const url = String(b.url || '');
    let single = null;
    if (b.ruleId) {
      const r = rules.find((x) => x.id === b.ruleId);
      if (r) {
        const o = matchOpts(!!b.direct);
        const sig = [o.ignoreHost, o.matchQuery, [...o.ignoreParams].join(',')].join('|');
        single = (!settings.matchMethod || r.method === '*' || r.method === method) && ruleMatchesUrl(r, url, urlKey(url, o), o, sig);
      }
    }
    const saved = new Map([...seq].map(([k, v]) => [k, new Set(v)])); // testing must not advance playback
    const r = findRule(method, url, Buffer.from(b.body || ''), !!b.direct);
    seq.clear();
    saved.forEach((v, k) => seq.set(k, v));
    return sendJson(res, 200, { rule: r ? publicRule(r) : null, ruleMatches: single });
  }

  // composer
  if (p === '/api/compose' && m === 'POST') {
    const b = await jsonObject(req);
    let url = String(b.url || '').trim();
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    try { new URL(url); } catch { return sendJson(res, 400, { error: 'Invalid URL' }); }
    const method = String(b.method || 'GET').toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]*$/.test(method)) return sendJson(res, 400, { error: `Invalid method "${method}"` });
    if (method === 'CONNECT') return sendJson(res, 400, { error: 'CONNECT cannot be sent from the Composer' });
    if (isOwnUrl(url)) return sendJson(res, 400, { error: "The Composer can't send requests to HarFiddle's own ports" });
    const reqPairs = parseHeaderText(b.headersText).filter(([k, v]) => { try { http.validateHeaderName(k); http.validateHeaderValue(k, v); return true; } catch { return false; } });
    if (!hdr(reqPairs, 'host')) reqPairs.unshift(['Host', new URL(url).host]);
    const sink = collectSink();
    const ctx = { method, url, mode: 'composer', process: 'HarFiddle Composer', reqPairs, body: Buffer.from(b.bodyText || '', 'utf8'), useRules: b.useRules !== false, sink };
    const wasCapturing = settings.capture;
    settings.capture = true; // composer requests are always recorded
    const pending = handle(ctx);
    settings.capture = wasCapturing;
    const id = nextSessionId - 1;
    await Promise.race([pending, sleep(130000)]);
    return sendJson(res, 200, { id });
  }

  // environment
  if (p === '/api/proxy-port' && m === 'POST') {
    const b = await jsonObject(req);
    try {
      await changeProxyPort(b.port);
      return sendJson(res, 200, await info());
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }
  if (p === '/api/system-proxy' && m === 'POST') {
    const b = await jsonObject(req);
    try {
      await setSystemProxy(!!b.on);
      return sendJson(res, 200, await info());
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }
  if (p === '/api/launch-browser' && m === 'POST') {
    const b = await jsonObject(req);
    try {
      await launchBrowser(b.browser, b.url);
      log(`Launched ${b.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} with proxy 127.0.0.1:${proxyPort}`);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }
  if (p === '/api/trust-ca' && m === 'POST') {
    // Adds the CA to the login keychain; macOS shows its own password/Touch ID prompt.
    try {
      await run('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', path.join(os.homedir(), 'Library/Keychains/login.keychain-db'), ca.caCertPath], 180000);
      await checkCaTrust();
      log(caTrusted ? 'HarFiddle root certificate is now trusted' : 'Certificate was added but macOS still reports it as untrusted');
      const i = await info();
      broadcast('info', i);
      return sendJson(res, 200, i);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }
  sendJson(res, 404, { error: 'Not found' });
}

async function onUiRequest(req, res) {
  // Only answer to our own origin (blocks DNS-rebinding / drive-by requests from other sites).
  const hostOk = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host || '');
  if (!hostOk) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const u = new URL(req.url.replace(/^\/+/, '/'), 'http://ui');
    if (u.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }
    if (u.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers['x-harfiddle'] !== '1') return sendJson(res, 403, { error: 'Missing X-HarFiddle header' });
      return await api(req, res, u);
    }
    if (u.pathname === '/harfiddle-ca.pem') {
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="harfiddle-ca.pem"' });
      return res.end(ca.caCertPem);
    }
    const file = path.normalize(path.join(PUBLIC, u.pathname === '/' ? 'index.html' : u.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!res.headersSent) sendJson(res, e instanceof SyntaxError ? 400 : 500, { error: e.message });
  }
}

// ---------------------------------------------------------------- boot
fs.mkdirSync(DATA_DIR, { recursive: true });
restoreSystemProxySync(); // in case a previous run crashed with the system proxy on
loadState();
startupWarnings.forEach((w) => log(w)); // in the Log before the UI can connect
proxyPort = +(PORT_ARG || settings.proxyPort || 8888);
const ca = new CertAuthority(DATA_DIR);

for (const f of harArgs) {
  try {
    const r = importHar(path.basename(f), fs.readFileSync(f, 'utf8'));
    console.log(`Loaded ${r.added} rules from ${r.name}${r.skipped ? ` (${r.skipped} skipped)` : ''}`);
  } catch (e) {
    console.error(`Could not load ${f}: ${e.message}`);
  }
}

function makeProxyServer() {
  const srv = http.createServer(onProxyRequest);
  srv.on('connect', onConnect);
  srv.on('upgrade', onUpgrade);
  srv.on('clientError', (err, sock) => { try { sock.destroy(); } catch {} });
  srv.keepAliveTimeout = 30000;
  srv.on('connection', watchClientProcess);
  return srv;
}
let proxyServer = makeProxyServer();

// Move the proxy to another port without restarting. Open connections finish on the old port.
async function changeProxyPort(port) {
  port = Math.floor(+port);
  if (!(port >= 1 && port <= 65535)) throw new Error('Enter a port between 1 and 65535');
  if (port === proxyPort) return;
  if (port === UI_PORT || port === browsePort) throw new Error(`Port ${port} is already used by HarFiddle itself`);
  const fresh = makeProxyServer();
  await listen(fresh, port, LAN ? '0.0.0.0' : '127.0.0.1', 'Proxy');
  const old = proxyServer;
  const oldPort = proxyPort;
  proxyServer = fresh;
  proxyPort = port;
  old.close();
  old.closeIdleConnections?.();
  settings.proxyPort = port;
  saveState();
  if (systemProxyOn) {
    for (const svc of await networkServices()) {
      try {
        await run('networksetup', ['-setwebproxy', svc, '127.0.0.1', String(port)]);
        await run('networksetup', ['-setsecurewebproxy', svc, '127.0.0.1', String(port)]);
      } catch {}
    }
  }
  log(`Proxy moved from port ${oldPort} to ${port}${systemProxyOn ? '; system proxy updated' : ''}`);
  broadcast('info', await info());
}

// A private port for browsers launched with Browse: their HTTPS is always decrypted (they accept our
// certificate), even while system traffic is being tunneled.
let browsePort = 0;
const browseServer = http.createServer(onProxyRequest);
browseServer.on('connect', onConnect);
browseServer.on('upgrade', onUpgrade);
browseServer.on('clientError', (err, sock) => { try { sock.destroy(); } catch {} });
browseServer.on('connection', watchClientProcess);

const uiServer = http.createServer(onUiRequest);

function listen(server, port, host, label) {
  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? `${label} port ${port} is already in use (try --${label === 'Proxy' ? 'port' : 'ui-port'} <n>)` : e.message)));
    server.listen(port, host, resolve);
  });
}

(async () => {
  try {
    await listen(proxyServer, proxyPort, LAN ? '0.0.0.0' : '127.0.0.1', 'Proxy');
    await listen(uiServer, UI_PORT, '127.0.0.1', 'UI');
    // fixed port so an already-open Browse window keeps working across restarts; random if taken
    await listen(browseServer, proxyPort + 1, '127.0.0.1', 'Browse').catch(() => listen(browseServer, 0, '127.0.0.1', 'Browse'));
    browsePort = browseServer.address().port;
  } catch (e) {
    console.error('\n  ' + e.message + '\n');
    process.exit(1);
  }
  systemProxyOn = await systemProxyStatus();
  await checkCaTrust();
  log(`HarFiddle listening on 127.0.0.1:${proxyPort}${LAN ? ' (LAN enabled)' : ''}; ${rules.length} AutoResponder rules loaded`);
  const uiUrl = `http://127.0.0.1:${UI_PORT}`;
  console.log(`
  HarFiddle is running
  ─────────────────────────────────────────────
  UI           ${uiUrl}
  Proxy        127.0.0.1:${proxyPort}${LAN ? `  (LAN: ${lanIps().map((i) => i + ':' + proxyPort).join(', ')})` : ''}
  Direct mode  http://localhost:${proxyPort}/<path>
  Rules        ${rules.length} loaded from ${Object.keys(sources).length} source(s)
  CA cert      ${ca.caCertPath}

  Ctrl+C to quit (system proxy is restored on exit)
`);
  if (!NO_OPEN && process.platform === 'darwin') spawn('open', [uiUrl], { stdio: 'ignore', detached: true }).unref();
})();

let exiting = false;
function shutdown() {
  if (exiting) return;
  exiting = true;
  saveNow();
  restoreSystemProxySync();
  // still pointed at us without a backup to restore from (e.g. it was left over from a crash): switch it off
  if (systemProxyOn && !readBackup() && process.platform === 'darwin') {
    try {
      const services = execFileSync('networksetup', ['-listallnetworkservices'], { timeout: 5000 }).toString().split('\n').slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith('*'));
      for (const svc of services) for (const [, , state] of PROXY_KINDS) { try { execFileSync('networksetup', [state, svc, 'off'], { timeout: 5000 }); } catch {} }
    } catch {}
  }
  process.exit(0);
}
// when launched by the macOS app: quit (and restore the system proxy) if the app goes away
if (argv.includes('--exit-with-parent')) {
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) shutdown(); }, 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.on('uncaughtException', (e) => console.error('[harfiddle] unexpected error:', e && e.stack || e));
