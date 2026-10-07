'use strict';
// End-to-end tests: starts HarFiddle with a temporary data folder, plus local HTTP/HTTPS/WebSocket servers
// to act as "the internet", then drives it the way real clients and the UI do. No network access needed.
//
//   npm test
//
// Never touches the macOS system proxy or keychain.
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { CertAuthority } = require('../lib/ca');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harfiddle-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ tiny test runner
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'expected equal'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }

// ------------------------------------------------------------------ helpers
function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function collect(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: res.rawHeaders, body: Buffer.concat(chunks) }));
    res.on('error', reject);
  });
}
function request(opts, body) {
  // Node only sends a body with DELETE/GET/OPTIONS when the length is set explicitly
  if (body != null && opts.method !== 'CONNECT') opts = { ...opts, headers: { 'Content-Length': Buffer.byteLength(body), ...(opts.headers || {}) } };
  return new Promise((resolve, reject) => {
    const req = http.request({ agent: false, ...opts }, (res) => collect(res).then(resolve, reject));
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('client timeout')));
    req.end(body);
  });
}
let P, U; // proxy port, UI port
const api = async (method, p, json, extraHeaders = {}) => {
  const body = json === undefined ? undefined : typeof json === 'string' || Buffer.isBuffer(json) ? json : JSON.stringify(json);
  const r = await request({ host: '127.0.0.1', port: U, method, path: p, headers: { 'X-HarFiddle': '1', 'Content-Type': 'application/json', ...extraHeaders } }, body);
  let data = null;
  try { data = JSON.parse(r.body.toString()); } catch {}
  return { ...r, data };
};
// HTTP through the proxy (absolute-form request)
const viaProxy = (url, { method = 'GET', headers = {}, body } = {}) =>
  request({ host: '127.0.0.1', port: P, method, path: url, headers: { Host: new URL(url).host, ...headers } }, body);
// HTTPS through the proxy: CONNECT, TLS (accepting HarFiddle's certificate), then the request
function viaProxyTls(url, { method = 'GET', headers = {}, body, port = P } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const c = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `${u.hostname}:${u.port || 443}`, agent: false });
    c.on('connect', (res, sock) => {
      if (res.statusCode !== 200) return reject(new Error('CONNECT ' + res.statusCode));
      const t = tls.connect({ socket: sock, servername: u.hostname, rejectUnauthorized: false }, () => {
        // agent must be undefined (not false) or Node ignores createConnection and dials the host directly
        request({ agent: undefined, createConnection: () => t, host: u.hostname, method, path: u.pathname + u.search, headers: { Host: u.host, ...headers } }, body).then(resolve, reject);
      });
      t.on('error', reject);
    });
    c.on('error', reject);
    c.end();
  });
}
const direct = (p, opts = {}) => request({ host: '127.0.0.1', port: P, path: p, method: opts.method || 'GET', headers: opts.headers || {} }, opts.body);
const sessions = async () => (await api('GET', '/api/sessions')).data;
const lastSession = async () => (await sessions()).slice(-1)[0];
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(40);
  }
}

// ------------------------------------------------------------------ fake internet
let UP, UPS; // upstream http / https ports
const BIG = Buffer.alloc(3 * 1024 * 1024, 'x');
function upstreamHandler(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const body = Buffer.concat(chunks).toString();
    if (u.pathname === '/echo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    }
    if (u.pathname === '/cookies') {
      res.writeHead(200, [['Set-Cookie', 'a=1; Path=/'], ['Set-Cookie', 'b=2; Path=/'], ['Content-Type', 'text/plain']].flat());
      return res.end('ok');
    }
    if (u.pathname === '/gzip') {
      const gz = zlib.gzipSync(Buffer.from('{"compressed":true}'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      return res.end(gz);
    }
    if (u.pathname === '/chunked') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('part1-');
      return setTimeout(() => res.end('part2'), 30);
    }
    if (u.pathname === '/big') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(BIG); }
    if (u.pathname === '/bomb') { // 64 MB of zeros, a few KB compressed
      const gz = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024));
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      return res.end(gz);
    }
    if (u.pathname === '/drip') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('first-'); return setTimeout(() => res.end('last'), 1500); }
    if (u.pathname === '/slow') { return setTimeout(() => { res.writeHead(200); res.end('late'); }, 1500); }
    if (u.pathname.startsWith('/status/')) { res.writeHead(+u.pathname.slice(8)); return res.end(); }
    if (u.pathname === '/head') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 5 }); return res.end(req.method === 'HEAD' ? undefined : 'hello'); }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found: ' + req.url);
  });
}
function wsUpgrade(req, sock) {
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  sock.on('data', (d) => sock.write(d));
}

// ------------------------------------------------------------------ server process
let child;
async function startHarFiddle(args) {
  child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--no-open', ...args], { env: { ...process.env, HOME: TMP }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.on('exit', (code) => { if (code && code !== 0) process.stderr.write(`\nHarFiddle exited with ${code}:\n${out}\n`); });
  await waitFor(async () => {
    try { return (await request({ host: '127.0.0.1', port: U, path: '/api/info' })).status === 200; } catch { return false; }
  }, 10000);
}
async function stopHarFiddle() {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await done;
}

// ================================================================== tests
test('starts and reports its ports', async () => {
  const r = await api('GET', '/api/info');
  eq(r.data.proxyPort, P, 'proxy port');
  eq(r.data.uiPort, U, 'ui port');
  assert(r.data.browsePort > 0, 'browse port');
});

test('UI is served; path traversal is refused', async () => {
  const page = await request({ host: '127.0.0.1', port: U, path: '/' });
  eq(page.status, 200);
  assert(page.body.toString().includes('HarFiddle'), 'index.html');
  const trav = await request({ host: '127.0.0.1', port: U, path: '/../server.js' });
  assert(trav.status !== 200 || !trav.body.toString().includes('require('), 'served a file outside public/');
  const trav2 = await request({ host: '127.0.0.1', port: U, path: '/%2e%2e/server.js' });
  assert(trav2.status !== 200 || !trav2.body.toString().includes('require('), 'served a file outside public/ (encoded)');
});

test('API refuses requests without the X-HarFiddle header or with a foreign Host', async () => {
  const noHeader = await request({ host: '127.0.0.1', port: U, method: 'DELETE', path: '/api/sessions' });
  eq(noHeader.status, 403, 'missing header');
  const badHost = await request({ host: '127.0.0.1', port: U, path: '/api/info', headers: { Host: 'evil.example' } });
  eq(badHost.status, 403, 'foreign host');
});

test('HTTP proxy forwards method, path, headers and body', async () => {
  const r = await viaProxy(`http://127.0.0.1:${UP}/echo?x=1`, { method: 'POST', headers: { 'X-Test': 'yes', 'Content-Type': 'text/plain' }, body: 'hello body' });
  eq(r.status, 200);
  const echo = JSON.parse(r.body);
  eq(echo.method, 'POST');
  eq(echo.url, '/echo?x=1');
  eq(echo.headers['x-test'], 'yes');
  eq(echo.body, 'hello body');
  assert(!echo.headers['proxy-connection'], 'hop-by-hop header leaked');
  const s = await waitFor(async () => { const l = await lastSession(); return l && l.source === 'live' && l; });
  eq(s.method, 'POST');
  eq(s.reqBodyBytes, 10, 'request size');
});

test('duplicate Set-Cookie headers survive', async () => {
  const r = await viaProxy(`http://127.0.0.1:${UP}/cookies`);
  eq(r.headers['set-cookie'].length, 2, 'set-cookie count');
});

test('gzip responses pass through untouched and are decoded in the inspector', async () => {
  const r = await viaProxy(`http://127.0.0.1:${UP}/gzip`, { headers: { 'Accept-Encoding': 'gzip' } });
  eq(r.headers['content-encoding'], 'gzip');
  eq(zlib.gunzipSync(r.body).toString(), '{"compressed":true}');
  const s = await lastSession();
  const d = (await api('GET', `/api/sessions/${s.id}`)).data;
  eq(d.resBody.text, '{"compressed":true}', 'decoded body in inspector');
});

test('chunked and large bodies stream intact', async () => {
  eq((await viaProxy(`http://127.0.0.1:${UP}/chunked`)).body.toString(), 'part1-part2');
  const big = await viaProxy(`http://127.0.0.1:${UP}/big`);
  eq(big.body.length, BIG.length, 'big body length');
  const up = await viaProxy(`http://127.0.0.1:${UP}/echo`, { method: 'POST', body: BIG });
  eq(JSON.parse(up.body).body.length, BIG.length, 'big upload length');
});

test('HEAD, 204 and 304 have no body', async () => {
  const head = await viaProxy(`http://127.0.0.1:${UP}/head`, { method: 'HEAD' });
  eq(head.status, 200);
  eq(head.body.length, 0, 'HEAD body');
  eq((await viaProxy(`http://127.0.0.1:${UP}/status/204`)).status, 204);
  eq((await viaProxy(`http://127.0.0.1:${UP}/status/304`)).status, 304);
});

test('HTTPS is decrypted for explicit clients', async () => {
  const r = await viaProxyTls(`https://localhost:${UPS}/echo?secure=1`, { method: 'PUT', body: 'tls body' });
  eq(r.status, 200);
  eq(JSON.parse(r.body).body, 'tls body');
  const s = await waitFor(async () => (await sessions()).find((x) => x.url === `https://localhost:${UPS}/echo?secure=1` && x.source === 'live'));
  eq(s.protocol, 'HTTPS');
  eq(s.method, 'PUT');
});

test('Browse port decrypts HTTPS too', async () => {
  const info = (await api('GET', '/api/info')).data;
  const r = await viaProxyTls(`https://localhost:${UPS}/echo?browse=1`, { port: info.browsePort });
  eq(r.status, 200);
});

test('unreachable host gives 502 and an error session', async () => {
  const dead = await freePort();
  const r = await viaProxy(`http://127.0.0.1:${dead}/x`);
  eq(r.status, 502);
  const s = await lastSession();
  eq(s.source, 'error');
});

test('client abort is recorded as aborted, not error', async () => {
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: P, path: `http://127.0.0.1:${UP}/slow`, headers: { Host: `127.0.0.1:${UP}` }, agent: false });
    req.on('error', () => resolve());
    req.end();
    setTimeout(() => { req.destroy(); resolve(); }, 300);
  });
  const s = await waitFor(async () => { const l = (await sessions()).find((x) => x.url.endsWith('/slow')); return l && l.source !== 'pending' && l; }, 4000);
  eq(s.source, 'aborted');
});

test('WebSocket upgrades are tunneled', async () => {
  const msg = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: P, path: `http://127.0.0.1:${UP}/ws`, agent: false, headers: { Host: `127.0.0.1:${UP}`, Connection: 'Upgrade', Upgrade: 'websocket' } });
    req.on('upgrade', (res, sock) => { sock.write('ping'); sock.once('data', (d) => { resolve(d.toString()); sock.destroy(); }); });
    req.on('response', (res) => reject(new Error('no upgrade: ' + res.statusCode)));
    req.on('error', reject);
    req.end();
  });
  eq(msg, 'ping');
});

test('HAR import creates rules; direct mode answers by path in recorded order', async () => {
  const har = fs.readFileSync(path.join(ROOT, 'examples/demo.har'));
  const r = await api('POST', '/api/rules/import?name=demo.har', har);
  eq(r.data.added, 8, 'rules added');
  const user = await direct('/v1/users/1');
  eq(user.status, 200);
  eq(JSON.parse(user.body).name, 'Ada Lovelace');
  const states = [];
  for (let i = 0; i < 4; i++) states.push(JSON.parse((await direct('/v1/jobs/42')).body).status);
  eq(states.join(','), 'queued,running,done,done', 'sequence');
  const s = await lastSession();
  eq(s.source, 'auto');
  eq(s.ruleSource, 'demo.har');
});

test('AutoResponder answers proxied HTTPS by full URL', async () => {
  const r = await viaProxyTls('https://api.example.com/v1/users/1');
  eq(JSON.parse(r.body).id, 1);
});

test('duplicates: cycle and first modes', async () => {
  await api('PUT', '/api/settings', { duplicates: 'cycle' });
  const c = [];
  for (let i = 0; i < 4; i++) c.push(JSON.parse((await direct('/v1/jobs/42')).body).status);
  eq(c.join(','), 'queued,running,done,queued', 'cycle');
  await api('PUT', '/api/settings', { duplicates: 'first' });
  eq(JSON.parse((await direct('/v1/jobs/42')).body).status, 'queued', 'first');
  await api('PUT', '/api/settings', { duplicates: 'sequence' });
});

test('POST body matching and ignored query params', async () => {
  await api('PUT', '/api/settings', { matchBody: true });
  const ok = await direct('/v1/jobs', { method: 'POST', body: '{"type": "export"}' });
  eq(ok.status, 201, 'same JSON body matches');
  const miss = await direct('/v1/jobs', { method: 'POST', body: '{"type":"other"}' });
  assert(miss.status !== 201, 'different body should not match');
  await api('PUT', '/api/settings', { matchBody: false });
  eq((await direct('/v1/users/1?_=123')).status, 200, '_ is ignored');
});

test('CORS preflight and headers for direct requests', async () => {
  const pre = await direct('/v1/users', { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'GET' } });
  eq(pre.status, 204);
  eq(pre.headers['access-control-allow-origin'], 'http://localhost:3000');
  const r = await direct('/v1/users', { headers: { Origin: 'http://localhost:3000' } });
  eq(r.headers['access-control-allow-origin'], 'http://localhost:3000');
});

test('unmatched direct requests: 502 without fallback, forwarded with fallback', async () => {
  eq((await direct('/nothing-here')).status, 502);
  await api('PUT', '/api/settings', { fallbackUpstream: `http://127.0.0.1:${UP}` });
  const r = await direct('/echo?via=fallback');
  eq(r.status, 200);
  eq(JSON.parse(r.body).url, '/echo?via=fallback');
  await api('PUT', '/api/settings', { fallbackUpstream: '' });
});

test('passthrough off blocks unmatched requests with 404', async () => {
  await api('PUT', '/api/settings', { passthrough: false });
  eq((await viaProxy(`http://127.0.0.1:${UP}/echo`)).status, 404);
  await api('PUT', '/api/settings', { passthrough: true });
  eq((await viaProxy(`http://127.0.0.1:${UP}/echo`)).status, 200);
});

const addRule = async (match, action, extra = {}) => {
  const r = (await api('POST', '/api/rules', { method: '*', match })).data;
  await api('PUT', `/api/rules/${r.id}`, { action, ...extra });
  return r.id;
};

test('rule actions: *404, *redir, *delay, *drop, file, REGEX mapping', async () => {
  await addRule('EXACT:http://act.test/s404', '*404');
  eq((await viaProxy('http://act.test/s404')).status, 404);

  await addRule('EXACT:http://act.test/redir', '*redir:https://example.com/new');
  const red = await viaProxy('http://act.test/redir');
  eq(red.status, 307);
  eq(red.headers.location, 'https://example.com/new');

  await addRule(`EXACT:http://127.0.0.1:${UP}/echo?d=1`, '*delay:300');
  const t0 = Date.now();
  eq((await viaProxy(`http://127.0.0.1:${UP}/echo?d=1`)).status, 200);
  assert(Date.now() - t0 >= 280, 'delay not applied');

  await addRule('EXACT:http://act.test/drop', '*drop');
  let dropped = false;
  try { await viaProxy('http://act.test/drop'); } catch { dropped = true; }
  assert(dropped, '*drop should close the connection');

  const file = path.join(TMP, 'mock.json');
  fs.writeFileSync(file, '{"from":"file"}');
  await addRule('EXACT:http://act.test/file', file);
  const f = await viaProxy('http://act.test/file');
  eq(f.body.toString(), '{"from":"file"}');
  assert(/json/.test(f.headers['content-type']), 'file content type');

  await addRule('REGEX:^http://act\\.test/map/(.*)$', `http://127.0.0.1:${UP}/echo?p=$1`);
  eq(JSON.parse((await viaProxy('http://act.test/map/abc')).body).url, '/echo?p=abc');
});

test('match only once disables the rule after its first hit', async () => {
  const id = await addRule('EXACT:http://act.test/once', '*418', { once: true });
  eq((await viaProxy('http://act.test/once')).status, 418);
  const rule = (await api('GET', `/api/rules/${id}`)).data;
  eq(rule.enabled, false);
});

test('editing a rule changes its response', async () => {
  const id = (await api('POST', '/api/rules', { method: 'GET', match: 'EXACT:http://edit.test/x', bodyText: 'old' })).data.id;
  await api('PUT', `/api/rules/${id}`, { status: 201, headersText: 'Content-Type: text/plain\nX-Edited: 1', bodyText: 'new body' });
  const r = await viaProxy('http://edit.test/x');
  eq(r.status, 201);
  eq(r.headers['x-edited'], '1');
  eq(r.body.toString(), 'new body');
});

test('sources can be disabled and removed', async () => {
  await api('PUT', '/api/sources/demo.har', { enabled: false });
  eq((await direct('/v1/users/1')).status, 502, 'disabled source should not answer');
  await api('PUT', '/api/sources/demo.har', { enabled: true });
  eq((await direct('/v1/users/1')).status, 200);
});

test('test-match finds the right rule', async () => {
  const r = (await api('POST', '/api/test-match', { method: 'GET', url: 'https://api.example.com/v1/users/1' })).data;
  assert(r.rule && r.rule.match.endsWith('/v1/users/1'), 'wrong rule');
});

test('sessions: detail, mark, add to AutoResponder, replay, remove', async () => {
  await viaProxy(`http://127.0.0.1:${UP}/echo?for=rule`);
  const s = await lastSession();
  const d = (await api('GET', `/api/sessions/${s.id}`)).data;
  assert(d.reqHeaders.length > 0 && d.resBody.text.includes('for=rule'), 'detail');

  await api('POST', '/api/sessions/mark', { ids: [s.id], mark: 'red' });
  eq((await sessions()).find((x) => x.id === s.id).mark, 'red');

  const rule = (await api('POST', `/api/sessions/${s.id}/torule`)).data;
  assert(rule.id, 'rule created');
  eq((await viaProxy(`http://127.0.0.1:${UP}/echo?for=rule`)).status, 200);
  eq((await lastSession()).source, 'auto', 'answered by the new rule');

  const rep = (await api('POST', '/api/sessions/replay', { ids: [s.id], useRules: false })).data;
  eq(rep.ids.length, 1);
  const replayed = await waitFor(async () => { const x = (await sessions()).find((y) => y.id === rep.ids[0]); return x && x.source !== 'pending' && x; });
  eq(replayed.source, 'live', 'replay without rules hits the server');

  await api('DELETE', '/api/sessions', { ids: [s.id] });
  assert(!(await sessions()).some((x) => x.id === s.id), 'removed');
  eq((await api('GET', `/api/sessions/${s.id}`)).status, 404);
});

test('composer sends requests and records them', async () => {
  const r = (await api('POST', '/api/compose', { method: 'POST', url: `http://127.0.0.1:${UP}/echo?c=1`, headersText: 'X-From: composer', bodyText: 'composed' })).data;
  const s = (await sessions()).find((x) => x.id === r.id);
  eq(s.status, 200);
  eq(s.process, 'HarFiddle Composer');
  const d = (await api('GET', `/api/sessions/${r.id}`)).data;
  eq(JSON.parse(d.resBody.text).body, 'composed');
});

test('client process is identified', async () => {
  await direct('/v1/users/1');
  const s = await lastSession();
  eq(s.process, `node:${process.pid}`);
});

test('HAR export and re-import keep sessions, marks and process', async () => {
  const before = await sessions();
  await api('POST', '/api/sessions/mark', { ids: [before[0].id], mark: 'blue' });
  const har = await request({ host: '127.0.0.1', port: U, path: '/api/sessions/export.har' });
  const parsed = JSON.parse(har.body);
  assert(parsed.log.entries.length >= before.filter((x) => x.method !== 'CONNECT').length, `entries exported: ${parsed.log.entries.length} of ${before.length} sessions`);
  await api('DELETE', '/api/sessions');
  eq((await sessions()).length, 0, 'cleared');
  const imp = (await api('POST', '/api/sessions/import?name=export.har', har.body)).data;
  eq(imp.added, parsed.log.entries.length);
  const after = await sessions();
  assert(after.some((x) => x.mark === 'blue'), 'mark kept');
  assert(after.some((x) => x.process === `node:${process.pid}`), 'process kept');
  assert(after.every((x) => x.source === 'har'), 'imported as har');
});

test('bad input is rejected cleanly', async () => {
  const notHar = await api('POST', '/api/rules/import?name=x.har', '{"not":"a har"}');
  assert(notHar.status >= 400 && /HAR/.test(notHar.data.error), 'JSON that is not a HAR gives an error');
  const bad = await api('POST', '/api/rules/import?name=x.har', 'garbage');
  assert(bad.status >= 400 && bad.data && bad.data.error, 'invalid HAR gives an error');
  const badJson = await api('PUT', '/api/settings', '{not json');
  assert(badJson.status >= 400, 'invalid JSON gives an error');
  eq((await api('GET', '/api/rules/doesnotexist')).status, 404);
  eq((await api('POST', '/api/proxy-port', { port: 70000 })).status, 400);
  eq((await api('POST', '/api/proxy-port', { port: U })).status, 400, 'own UI port refused');
  eq((await api('GET', '/api/info')).status, 200, 'still alive');
});

test('live events stream sessions over SSE', async () => {
  const got = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: U, path: '/api/events', agent: false }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        if (/event: session/.test(buf)) { req.destroy(); resolve(true); }
      });
      setTimeout(() => viaProxy(`http://127.0.0.1:${UP}/echo?sse=1`).catch(() => {}), 100);
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    setTimeout(() => reject(new Error('no session event')), 3000);
    req.end();
  });
  assert(got);
});

// ------------------------------------------------------------------ regressions (bugs found in review)
test('the proxy refuses to reach HarFiddle itself', async () => {
  eq((await viaProxy(`http://127.0.0.1:${U}/api/info`, { headers: { 'X-HarFiddle': '1' } })).status, 403, 'UI port via proxy');
  const connect = await new Promise((resolve) => {
    const c = http.request({ host: '127.0.0.1', port: P, method: 'CONNECT', path: `127.0.0.1:${U}`, agent: false });
    c.on('connect', (res, sock) => { sock.destroy(); resolve(res.statusCode); });
    c.on('response', (res) => resolve(res.statusCode));
    c.on('error', () => resolve('error'));
    c.end();
  });
  eq(connect, 403, 'CONNECT to the UI port');
  eq((await api('PUT', '/api/settings', { fallbackUpstream: `http://127.0.0.1:${P}` })).status, 400, 'fallback pointing at the proxy');
  const before = (await sessions()).length;
  await addRule('EXACT:http://loop.test/x', `http://127.0.0.1:${P}/loop`);
  eq((await viaProxy('http://loop.test/x')).status, 508, 'mapping to the proxy itself');
  await sleep(200);
  assert((await sessions()).length - before <= 2, 'no request loop');
});

test('unusual requests get an answer instead of hanging', async () => {
  const slash = await request({ host: '127.0.0.1', port: U, path: '//' });
  assert(slash.status >= 200, 'UI: path starting with //');
  const badHost = await request({ host: '127.0.0.1', port: P, path: '/x', headers: { Host: 'a b' } });
  assert(badHost.status >= 400, 'proxy: invalid Host');
  const star = await request({ host: '127.0.0.1', port: P, method: 'OPTIONS', path: '*' });
  assert(star.status >= 200, 'OPTIONS *');
  const badPort = await new Promise((resolve) => {
    const c = http.request({ host: '127.0.0.1', port: P, method: 'CONNECT', path: 'example.com:99999', agent: false });
    c.on('connect', (res, sock) => { sock.destroy(); resolve(res.statusCode); });
    c.on('response', (res) => resolve(res.statusCode));
    c.on('error', () => resolve('error'));
    c.end();
  });
  eq(badPort, 400, 'CONNECT to an invalid port');
});

test('rule statuses are validated', async () => {
  eq((await api('POST', '/api/rules', { match: 'EXACT:http://s.test/a', status: 42 })).status, 400);
  const id = (await api('POST', '/api/rules', { match: 'EXACT:http://s.test/b' })).data.id;
  eq((await api('PUT', `/api/rules/${id}`, { status: 1000 })).status, 400);
  await addRule('EXACT:http://s.test/c', '*099');
  eq((await viaProxy('http://s.test/c')).status, 500, 'invalid *NNN answers instead of hanging');
});

test('Upgrade: h2c is answered as a normal request', async () => {
  await addRule('EXACT:http://h2c.test/x', '*201');
  const r = await viaProxy('http://h2c.test/x', { headers: { Connection: 'Upgrade, HTTP2-Settings', Upgrade: 'h2c', 'HTTP2-Settings': 'AAMAAABkAARAAAAAAAIAAAAA' } });
  eq(r.status, 201, 'answered by the AutoResponder, not tunneled');
  const s = await lastSession();
  eq(s.source, 'auto');
});

test('decompressing a huge body is capped', async () => {
  const r = await viaProxy(`http://127.0.0.1:${UP}/bomb`, { headers: { 'Accept-Encoding': 'gzip' } });
  eq(r.status, 200);
  const s = await lastSession();
  const d = (await api('GET', `/api/sessions/${s.id}`)).data;
  assert(d.resBody.size <= 20 * 1024 * 1024, `stored ${d.resBody.size} bytes`);
});

test("file rules can't serve files outside their folder", async () => {
  const www = path.join(TMP, 'www');
  fs.mkdirSync(www, { recursive: true });
  fs.writeFileSync(path.join(www, 'a.txt'), 'inside');
  fs.writeFileSync(path.join(TMP, 'secret.txt'), 'outside');
  await addRule('REGEX:^http://files\\.test/(.*)$', `${www}/$1`);
  eq((await viaProxy('http://files.test/a.txt')).body.toString(), 'inside');
  eq((await viaProxy('http://files.test/../secret.txt')).status, 403, 'literal ..');
  eq((await viaProxy('http://files.test/%2e%2e/secret.txt')).status, 403, 'encoded ..');
});

test('"match only once" rules keep the playback order', async () => {
  // new rules go to the top of the list, so add them last-first to get 201, 202, 203 in list order
  for (const [st, once] of [[203, false], [202, false], [201, true]]) await addRule('EXACT:http://seq.test/x', `*${st}`, { once });
  const got = [];
  for (let i = 0; i < 4; i++) got.push((await viaProxy('http://seq.test/x')).status);
  eq(got.join(','), '201,202,203,203');
});

test('a response cut off by the client is recorded as aborted', async () => {
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: P, path: `http://127.0.0.1:${UP}/drip`, headers: { Host: `127.0.0.1:${UP}` }, agent: false }, (res) => {
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', () => resolve());
    req.end();
  });
  const s = await waitFor(async () => { const l = (await sessions()).find((x) => x.url.endsWith('/drip')); return l && l.source !== 'pending' && l; }, 4000);
  eq(s.source, 'aborted');
  assert(/cancelled/.test(s.note || ''), 'note says it was cancelled');
});

test('API input is validated', async () => {
  assert((await api('PUT', '/api/settings', 'null')).status < 500, 'null settings body');
  const n = (await sessions()).length;
  eq((await api('DELETE', '/api/sessions', '{broken')).status, 400, 'malformed delete');
  eq((await sessions()).length, n, 'malformed delete must not clear everything');
  eq((await api('POST', '/api/compose', { method: 'GE T', url: `http://127.0.0.1:${UP}/echo` })).status, 400, 'invalid method');
  await api('PUT', '/api/settings', { passthrough: 'false' });
  eq((await api('GET', '/api/settings')).data.passthrough, false, '"false" means false');
  await api('PUT', '/api/settings', { passthrough: true });
});

test('binary request bodies survive HAR export and import', async () => {
  const bin = Buffer.from([...Array(256).keys()]);
  await viaProxy(`http://127.0.0.1:${UP}/echo?bin=1`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bin });
  const s = (await sessions()).find((x) => x.url.endsWith('/echo?bin=1'));
  const har = await request({ host: '127.0.0.1', port: U, path: `/api/sessions/export.har?ids=${s.id}` });
  const imp = (await api('POST', '/api/sessions/import?name=bin.har', har.body)).data;
  eq(imp.added, 1);
  const back = (await sessions()).slice(-1)[0];
  const d = (await api('GET', `/api/sessions/${back.id}`)).data;
  eq(Buffer.from(d.reqBody.base64 || '', 'base64').equals(bin), true, 'bytes identical');
});

test('hostile HAR content is neutralised', async () => {
  const har = { log: { entries: [
    { startedDateTime: new Date().toISOString(), time: 1, request: { method: 'GET', url: 'http://x.test/a', headers: [{ name: 5, value: 'x' }, { name: 'ok', value: 'y' }] }, response: { status: '<img src=x onerror=alert(1)>', headers: [], content: { text: 'hi' } } },
    'not an entry',
    { startedDateTime: new Date().toISOString(), time: 1, request: { method: 'GET', url: 'http://x.test/b', headers: [] }, response: { status: 200, headers: [], content: { text: 'ok' } } },
  ] } };
  const r = (await api('POST', '/api/sessions/import?name=hostile.har', JSON.stringify(har))).data;
  eq(r.added, 2, 'bad entry skipped, others kept');
  const imported = (await sessions()).filter((x) => x.url.startsWith('http://x.test/'));
  assert(imported.every((x) => typeof x.status === 'number'), 'status is always a number');
});

test('proxy port can be changed live and is remembered after restart', async () => {
  const p2 = await freePort();
  const r = await api('POST', '/api/proxy-port', { port: p2 });
  eq(r.data.proxyPort, p2);
  const oldP = P;
  P = p2;
  eq((await viaProxy(`http://127.0.0.1:${UP}/echo`)).status, 200, 'new port works');
  let oldWorks = true;
  try { await request({ host: '127.0.0.1', port: oldP, path: `http://127.0.0.1:${UP}/echo` }); } catch { oldWorks = false; }
  assert(!oldWorks, 'old port should be closed');
  await api('PUT', '/api/settings', { simulateLatency: true });
  await stopHarFiddle();
  await startHarFiddle(['--ui-port', String(U)]); // no --port: must use the saved one
  eq((await api('GET', '/api/info')).data.proxyPort, p2, 'saved port used');
  eq((await api('GET', '/api/settings')).data.simulateLatency, true, 'settings persisted');
  assert((await api('GET', '/api/rules')).data.rules.length >= 8, 'rules persisted');
  await api('PUT', '/api/settings', { simulateLatency: false });
});

test('a damaged state file is kept aside, not silently overwritten', async () => {
  await stopHarFiddle();
  fs.writeFileSync(path.join(TMP, '.harfiddle', 'state.json'), '{ this is not json');
  await startHarFiddle(['--port', String(P), '--ui-port', String(U)]);
  eq((await api('GET', '/api/info')).status, 200);
  assert(fs.readdirSync(path.join(TMP, '.harfiddle')).some((f) => f.startsWith('state.json.damaged-')), 'damaged file kept');
  assert((await api('GET', '/api/log')).data.some((e) => /could not be read/.test(e.msg)), 'user is told in the Log');
});

test('a malformed rule in the state file does not break anything', async () => {
  await stopHarFiddle();
  fs.writeFileSync(path.join(TMP, '.harfiddle', 'state.json'), JSON.stringify({ settings: {}, sources: {}, rules: [{ id: 'abc', match: 'EXACT:http://bad.test/x', method: 'GET', status: 42 }, null, 'junk'] }));
  await startHarFiddle(['--port', String(P), '--ui-port', String(U)]);
  eq((await api('GET', '/api/rules')).status, 200, 'rules list loads');
  eq((await viaProxy('http://bad.test/x')).status, 200, 'rule answers with a sane default');
});

// ================================================================== run
(async () => {
  [P, U, UP, UPS] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const up = http.createServer(upstreamHandler).listen(UP, '127.0.0.1');
  up.on('upgrade', wsUpgrade);
  const upCa = new CertAuthority(path.join(TMP, 'upstream-ca'));
  const ctx = upCa.contextFor('localhost');
  const ups = https.createServer({ SNICallback: (n, cb) => cb(null, ctx) }, upstreamHandler).listen(UPS, '127.0.0.1');
  await startHarFiddle(['--port', String(P), '--ui-port', String(U)]);

  let failed = 0;
  for (const t of tests) {
    const t0 = Date.now();
    try {
      await t.fn();
      console.log(`  ✓ ${t.name} (${Date.now() - t0} ms)`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${t.name}\n      ${e.message}`);
    }
  }
  await stopHarFiddle();
  up.close();
  ups.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
