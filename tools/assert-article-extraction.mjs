import assert from 'node:assert/strict';
import { ARTICLE_LIMITS, extractArticle } from '../lib/article_extraction.js';

const url = 'https://example.test/news/story';
const raw = '<article><p>Original source stays intact.</p></article>';
let constructed = 0;
let closed = 0;
let seenOptions;
let seenReaderOptions;
function textNode(value) { return { nodeType: 3, nodeValue: value, nodeName: '#text' }; }
function element(name, children = []) {
  children.forEach((child, i) => { child.previousSibling = children[i - 1] || null; });
  return { nodeType: 1, nodeName: name, lastChild: children.at(-1) || null };
}
function dependencies({ result, error, count = 3, outputCount = 3, closeError = false } = {}) {
  const root = element('#document-fragment', [element('P', [textNode('First paragraph with useful article information.')]), element('P', [textNode('Second paragraph with further useful details.')])]);
  root.querySelectorAll = () => ({ length: outputCount });
  return {
    VirtualConsole: class {},
    JSDOM: class {
      constructor(input, options) {
        constructed++;
        assert.equal(input, raw);
        seenOptions = options;
        this.window = { document: { getElementsByTagName: () => ({ length: count }), createElement: name => { assert.equal(name, 'template'); return { content: root }; } }, close() { closed++; if (closeError) throw Error('close'); } };
      }
    },
    Readability: class {
      constructor(document, options) { seenReaderOptions = options; }
      parse() { if (error) throw Error('synthetic parser failure'); return result; }
    },
  };
}
async function fallback(reason, html = raw, options = {}, sourceUrl = url) {
  const result = await extractArticle(html, sourceUrl, options);
  assert.equal(result.status, 'fallback');
  assert.equal(result.extracted, false);
  assert.equal(result.reason, reason);
  assert.equal(result.html, html);
  assert.equal(result.text, null);
  assert.equal(result.sourceUrl, sourceUrl);
  return result;
}
await fallback('invalid-input', null);
await fallback('empty-input', '   ');
await fallback('invalid-url', raw, {}, 'file:///secret');
await fallback('invalid-url', raw, {}, 'not a URL');
await fallback('input-limit', 'x'.repeat(ARTICLE_LIMITS.maxInputChars + 1), { loadDependencies() { throw Error('must not load'); } });
await fallback('input-limit', raw, { maxInputChars: 4 });
await fallback('element-limit', '<i></i>'.repeat(5), { maxElements: 4 });
await fallback('dependencies-unavailable', raw, { loadDependencies() { throw Error('missing'); } });
await fallback('dependencies-unavailable', raw, { dependencies: {} });
await fallback('no-article', raw, { dependencies: dependencies({ result: null }) });
await fallback('parser-error', raw, { dependencies: dependencies({ error: true }) });
await fallback('element-limit', raw, { dependencies: dependencies({ count: 30 }), maxElements: 10 });
await fallback('insufficient-content', raw, { dependencies: dependencies({ result: { content: '' } }) });
await fallback('output-limit', raw, { dependencies: dependencies({ result: { content: 'x'.repeat(ARTICLE_LIMITS.maxInputChars + 1) } }) });
await fallback('element-limit', raw, { dependencies: dependencies({ result: { content: '<p>Text</p>' }, outputCount: 30 }), maxElements: 10 });
await fallback('insufficient-content', raw, { dependencies: dependencies({ result: { content: '<p>Text</p>' } }) });
const result = await extractArticle(raw, url, { dependencies: dependencies({ result: { title: 'Example', content: '<p>First paragraph</p><p>Second paragraph</p>' }, closeError: true }), minTextChars: 20 });
assert.equal(result.status, 'extracted');
assert.equal(result.extracted, true);
assert.equal(result.extractor, 'mozilla-readability');
assert.equal(result.sourceUrl, url);
assert.equal(result.title, 'Example');
assert.equal(result.text, 'First paragraph with useful article information.\n\nSecond paragraph with further useful details.');
assert.equal(result.html, '<p>First paragraph</p><p>Second paragraph</p>');
assert.equal(seenOptions.url, url);
assert.equal(seenOptions.contentType, 'text/html');
assert.equal(Object.hasOwn(seenOptions, 'resources'), false);
assert.equal(Object.hasOwn(seenOptions, 'runScripts'), false);
assert.equal(seenReaderOptions.maxElemsToParse, ARTICLE_LIMITS.maxElements);
assert.equal(seenReaderOptions.charThreshold, 20);
assert.equal(closed, constructed);
console.log('PASS: injected article helper contract, limits, fallback preservation, cleanup and paragraph tests (not a real parser test).');

// Optional real-library checks: never install packages or fetch any fixtures.
let real;
try {
  const [dom, reader] = await Promise.all([import('jsdom'), import('@mozilla/readability')]);
  real = { JSDOM: dom.JSDOM, VirtualConsole: dom.VirtualConsole, Readability: reader.Readability };
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  console.log('SKIP: real parser/security/relative-link fixture tests; install jsdom@26.1.0 and @mozilla/readability before claiming parser validation.');
}
if (real) {
  const prose = 'The local research team published a detailed account of the project, describing its careful observations and explaining why the evidence matters to readers. '.repeat(5);
  const fixture = `<!doctype html><html><head><title>Local research report</title><script>globalThis.__articleExecutionSentinel = true</script></head><body><nav>Home | Menu</nav><article><h1>Local research report</h1><p>${prose}</p><p>${prose}<a href="../reference">Reference</a></p></article></body></html>`;
  const actual = await extractArticle(fixture, url, { dependencies: real });
  assert.equal(actual.status, 'extracted');
  assert.match(actual.text, /\n\n/);
  assert.match(actual.html, /https:\/\/example\.test\/reference/);
  assert.equal(globalThis.__articleExecutionSentinel, undefined);
  await fallback('insufficient-content', '<p>Tiny.</p>', { dependencies: real });
  console.log('PASS: real parser offline article, paragraph and relative-link fixtures. Script options are verified above; no external resource fixture is requested.');
}
