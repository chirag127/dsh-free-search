// Offline integration through the actual provider, local HTTP, and Node builtin seams.
import assert from 'node:assert/strict';
import http from 'node:http';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { createFetchProvider, slimHtml } from '../lib/fetch_provider.js';

let parsersAvailable = true;
try { await Promise.all([import('jsdom'), import('@mozilla/readability')]); }
catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  parsersAvailable = false;
}
console.log(`Parser lane: ${parsersAvailable ? 'real optional libraries' : 'optional libraries absent; exact fallback'}`);
function assertArticleContent(content) {
  if (parsersAvailable) {
    assert.ok(content.startsWith(head));
    assert.doesNotMatch(content, /REMOVE_NAV|REMOVE_FOOTER/);
  } else {
    assert.equal(content, slimHtml(html));
  }
}

const paragraph = 'The observatory measured distant stars using careful observations, comparing the results with historical records. '.repeat(12);
const head = '<head><title>Observatory report</title><meta property="article:modified_time" content="2026-01-02"><link rel="canonical" href="https://example.org/report"></head>';
const html = `<html>${head}<body><nav>REMOVE_NAV <a href="/menu">Menu</a></nav><article><h1>Observatory report</h1><p>${paragraph}</p><p>${paragraph}</p></article><footer>REMOVE_FOOTER</footer></body></html>`;
const envNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const savedEnv = Object.fromEntries(envNames.map(k => [k, process.env[k]]));
for (const k of envNames) delete process.env[k];
let body = html, type = 'text/html', status = 202;
const server = http.createServer((req, res) => {
  if (req.url === '/redirect') { res.writeHead(302, { location: '/final' }); res.end(); return; }
  res.writeHead(status, { 'content-type': type }); res.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let keys = 0, checks = 0;
const provider = (extra = {}) => createFetchProvider({
  validateUrl: async () => {}, allowedCidrs: () => ['127.0.0.0/8'],
  resolveApiKey: async () => { keys++; return undefined; }, browserEnabled: () => false, ...extra,
});
const check = async (name, fn) => { await fn(); checks++; console.log(`ok ${name}`); };
const originalSpawn = childProcess.spawn;
try {
  await check('direct extraction retains redirect URL, status, head metadata and contract', async () => {
    const result = await provider().fetch({ url: `${base}/redirect` });
    assert.equal(result.url, `${base}/final`); assert.equal(result.statusCode, 202);
    assert.equal(result.body.kind, 'html'); assert.equal(result.truncated, false);
    assertArticleContent(result.body.content);
    assert.match(result.body.content, /observatory measured/i);
    assert.equal(keys, 0);
  });
  await check('unextractable page uses exact original slimHtml fallback', async () => {
    body = `<html>${head}<body><nav>${'<a href="/">Menu</a>'.repeat(40)}</nav><script>hidden()</script></body></html>`;
    assert.equal((await provider().fetch({ url: base })).body.content, slimHtml(body));
  });
  await check('body metadata loss falls back instead of losing research dates', async () => {
    body = html.replace('<nav>', '<nav><time datetime="2025-12-31">Updated</time>');
    assert.equal((await provider().fetch({ url: base })).body.content, slimHtml(body));
  });
  await check('JSON, plain text, XML and XHTML keep preexisting treatment', async () => {
    body = html;
    for (type of ['application/json', 'text/plain', 'application/xml', 'application/xhtml+xml']) {
      assert.equal((await provider().fetch({ url: base })).body.content, slimHtml(body), type);
    }
  });
  await check('browser HTML extracts without changing URL or status or starting later tiers', async () => {
    status = 503; type = 'text/html'; body = 'unavailable';
    childProcess.spawn = () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => true; child.unref = () => {};
      queueMicrotask(() => { child.stdout.end(html); child.emit('exit', 0); });
      return child;
    };
    syncBuiltinESMExports();
    const result = await provider({ browserEnabled: () => true, browserPath: () => process.execPath }).fetch({ url: base });
    assert.equal(result.url, base); assert.equal(result.statusCode, 200);
    assert.equal(result.body.kind, 'html'); assert.equal(result.truncated, false);
    assertArticleContent(result.body.content);
    assert.equal(keys, 0);
  });
} finally {
  childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  for (const k of envNames) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
}
console.log(`OK: ${checks} article provider integration checks passed`);
