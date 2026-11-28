import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createFetchProvider } from '../lib/fetch_provider.js';

// Genuine PDFs with byte-accurate xrefs, served through the real bounded transport.
function pdf(text) {
  const stream = text === null ? '' : `BT /F1 0.001 Tf 10 700 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [4 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let body = '%PDF-1.7\n'; const offsets = [];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
const valid = pdf('Small valid PDF');
const fixtures = {
  '/mime': ['application/pdf; charset=binary', valid],
  '/hint.PDF': ['application/octet-stream', valid], '/opaque': ['application/octet-stream', valid],
  '/final.pdf': ['application/octet-stream', valid],
  '/wrong-mime': ['application/octet-stream', valid], '/binary-as-text': ['text/plain', valid],
  '/wrong-signature.pdf': ['application/pdf', Buffer.from('not PDF')],
  '/malformed.pdf': ['application/pdf', Buffer.from('%PDF-1.7\nnot a PDF')],
  '/empty.pdf': ['application/pdf', pdf(null)],
  '/long.pdf': ['application/pdf', pdf('x'.repeat(210000))],
};
let slowStarted;
const server = http.createServer((req, res) => {
  const route = req.url.split('?')[0];
  if (route === '/redirect.pdf' || route === '/redirect') {
    res.writeHead(302, { location: route === '/redirect' ? '/final.pdf' : '/opaque' }); res.end(); return;
  }
  if (route === '/slow.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.write(valid.subarray(0, 5)); slowStarted?.(); return; }
  const [type, bytes] = fixtures[route];
  res.writeHead(201, { 'content-type': type }); res.end(bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let fallbackCalls = [];
const provider = createFetchProvider({
  validateUrl: async () => {}, browserEnabled: () => false,
  resolveApiKey: async env => { fallbackCalls.push(env); return undefined; },
});
const [major, minor] = process.versions.node.split('.').map(Number);
let available = (major === 20 && minor >= 16) || (major === 22 && minor >= 3) || major > 22;
try { createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; available = false; }
try {
  if (available) {
    for (const [path, final] of [['/mime', '/mime'], ['/hint.PDF?download=1', '/hint.PDF?download=1'], ['/redirect.pdf', '/opaque'], ['/redirect', '/final.pdf']]) {
      const result = await provider.fetch({ url: base + path });
      assert.deepEqual(Object.keys(result).sort(), ['body', 'statusCode', 'truncated', 'url']);
      assert.deepEqual(Object.keys(result.body).sort(), ['content', 'kind']);
      assert.equal(result.url, base + final); assert.equal(result.statusCode, 201);
      assert.equal(result.body.kind, 'text'); assert.equal(result.body.content.trim(), 'Small valid PDF');
      assert.equal(result.truncated, false);
    }
    const long = await provider.fetch({ url: base + '/long.pdf' });
    assert.equal(long.body.content.length, 200000); assert.equal(long.truncated, true);
    assert.deepEqual(fallbackCalls, []);
  } else {
    await assert.rejects(provider.fetch({ url: base + '/mime' }), /could not fetch/);
    assert.deepEqual(fallbackCalls, ['EXA_API_KEY', 'FIRECRAWL_API_KEY', 'CRAWL4AI_API_KEY']);
    console.log('SKIP PDF extraction: optional parser/runtime unavailable; fallback verified');
  }
  for (const path of ['/wrong-mime', '/binary-as-text', '/wrong-signature.pdf', '/malformed.pdf', '/empty.pdf']) {
    fallbackCalls = [];
    await assert.rejects(provider.fetch({ url: base + path }), /could not fetch/);
    assert.deepEqual(fallbackCalls, ['EXA_API_KEY', 'FIRECRAWL_API_KEY', 'CRAWL4AI_API_KEY']);
  }
  fallbackCalls = [];
  const controller = new AbortController();
  const started = new Promise(resolve => { slowStarted = resolve; });
  const pending = provider.fetch({ url: base + '/slow.pdf' }, controller.signal);
  await started; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(provider.fetch({ url: base + '/mime' }, controller.signal), { name: 'AbortError' });
  assert.deepEqual(fallbackCalls, []);
  console.log('PASS PDF provider: HTTP extraction, MIME/original/final hints, signatures, empty/malformed fallback, truncation and cancellation');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
