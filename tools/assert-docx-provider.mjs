import assert from 'node:assert/strict';
import http from 'node:http';
import { createFetchProvider } from '../lib/fetch_provider.js';

// Real stored ZIP/OOXML fixtures, with no parser or transport mocks.
function zip(entries) {
  const chunks = [], dirs = []; let offset = 0;
  for (const [path, text] of entries) {
    const name = Buffer.from(path), data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30), dir = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    chunks.push(local, name, data); dirs.push(dir, name); offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(dirs), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
function docx(text) {
  return zip([
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`],
  ]);
}
const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const valid = docx('Small valid document');
let slowStarted;
const server = http.createServer((req, res) => {
  const route = req.url.split('?')[0];
  if (route === '/redirect.docx') { res.writeHead(302, { location: '/opaque' }); res.end(); return; }
  if (route === '/slow.docx') { res.writeHead(200, { 'content-type': mime }); res.write(valid.subarray(0, 4)); slowStarted?.(); return; }
  const fixtures = {
    '/mime': [mime, valid], '/hint.DOCX': ['application/octet-stream', valid], '/opaque': ['application/octet-stream', valid],
    '/wrong-mime': ['application/zip', valid], '/wrong-signature.docx': [mime, Buffer.from('not zip')],
    '/malformed.docx': [mime, valid.subarray(0, -10)], '/long.docx': [mime, docx('x'.repeat(200001))],
    '/text': ['text/plain; charset=windows-1252', Buffer.from('caf\xe9 '.repeat(100), 'latin1')],
    '/html': ['text/html', Buffer.from(`<html><head><style>discard</style></head><body><p>${'Article content. '.repeat(100)}</p></body></html>`)],
  };
  const [type, bytes] = fixtures[route] || ['text/plain', Buffer.from('missing')];
  res.writeHead(201, { 'content-type': type }); res.end(bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let fallbackCalls = [];
const provider = createFetchProvider({
  // Only bypass the initial public-URL guard for this loopback-only fixture.
  validateUrl: async () => {}, browserEnabled: () => false,
  resolveApiKey: async env => { fallbackCalls.push(env); return undefined; },
});
let parsers = true;
for (const name of ['mammoth', 'yauzl']) { try { await import(name); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; parsers = false; } }
try {
  if (parsers) {
    for (const path of ['/mime', '/hint.DOCX?download=1', '/redirect.docx']) {
      const result = await provider.fetch({ url: base + path });
      assert.deepEqual(result, { url: base + (path === '/redirect.docx' ? '/opaque' : path), statusCode: 201, body: { kind: 'text', content: 'Small valid document\n\n' }, truncated: false });
    }
    const long = await provider.fetch({ url: base + '/long.docx' });
    assert.equal(long.body.content.length, 200000); assert.equal(long.truncated, true);
    assert.deepEqual(fallbackCalls, []);
  } else {
    await assert.rejects(provider.fetch({ url: base + '/mime' }), /could not fetch/);
    console.log('SKIP valid extraction: optional parser unavailable; fallback verified');
  }
  for (const path of ['/wrong-mime', '/wrong-signature.docx', '/malformed.docx']) {
    fallbackCalls = [];
    await assert.rejects(provider.fetch({ url: base + path }), /could not fetch/);
    assert.deepEqual(fallbackCalls, ['EXA_API_KEY', 'FIRECRAWL_API_KEY', 'CRAWL4AI_API_KEY']);
  }
  fallbackCalls = [];
  const text = await provider.fetch({ url: base + '/text' });
  assert.equal(text.body.content, 'café '.repeat(100)); assert.equal(text.body.kind, 'html');
  const html = await provider.fetch({ url: base + '/html' });
  assert.ok(html.body.content.includes('Article content.')); assert.ok(!html.body.content.includes('<style>'));
  const controller = new AbortController();
  const started = new Promise(resolve => { slowStarted = resolve; });
  const pending = provider.fetch({ url: base + '/slow.docx' }, controller.signal);
  await started; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(provider.fetch({ url: base + '/mime' }, controller.signal), { name: 'AbortError' });
  assert.deepEqual(fallbackCalls, []);
  console.log('PASS DOCX provider: real HTTP extraction, hints/signatures, malformed fallback, redirect, truncation, cancellation, charset and HTML');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
