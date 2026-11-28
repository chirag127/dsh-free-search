import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { REFERENCE_ENGINES } from '../lib/domain_engines_reference.js';

// Offline transport fixtures exercise the real adapter and shared HTTPS transport.
const original = https.request;
const originalHttp = http.request;
let fixture;
let calls = [];
https.request = (options, callback) => {
  calls.push(options);
  const req = new EventEmitter();
  req.write = () => { throw new Error('Unexpected request body'); };
  req.destroy = error => req.emit('error', error);
  req.end = () => queueMicrotask(() => {
    if (fixture instanceof Error) return req.emit('error', fixture);
    if (fixture.timeout) return req.emit('timeout');
    const res = new EventEmitter();
    res.statusCode = fixture.status;
    res.headers = {};
    callback(res);
    res.emit('data', Buffer.from(fixture.text));
    res.emit('end');
  });
  return req;
};
http.request = () => { throw new Error('Unexpected HTTP request'); };
const json = value => ({ status: 200, text: JSON.stringify(value) });
async function run(engine, response, q = 'example') {
  calls = [];
  fixture = response;
  return REFERENCE_ENGINES[engine].run(q);
}
const book = { id: 84, title: '<b>Frankenstein</b>', authors: [{ name: 'Shelley, Mary' }], languages: ['en'], summaries: ['<p>A book &amp; story.</p>'] };
const show = { id: 44933, name: 'Severance', status: 'Running', genres: ['Drama'], summary: '<p>A show &amp; story.</p>', premiered: '2022-02-18' };
const cases = {
  gutendex: { host: 'gutendex.com', path: '/books/', param: 'search', item: book, wrap: items => ({ results: items }) },
  tvmaze: { host: 'api.tvmaze.com', path: '/search/shows', param: 'q', item: { show }, wrap: items => items },
};
try {
  assert.deepEqual(Object.keys(REFERENCE_ENGINES), Object.keys(cases));
  for (const [engine, c] of Object.entries(cases)) {
    assert.equal(typeof REFERENCE_ENGINES[engine].desc, 'string');
    const q = 'title & author + 中文 / "quoted"?#%';
    const result = await run(engine, json(c.wrap([c.item])), ` ${q} `);
    assert.equal(result.length, 1);
    assert.deepEqual(Object.keys(result[0]), ['url', 'title', 'snippet', 'publishedAt']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hostname, c.host);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].timeout, 20000);
    assert.equal(calls[0].headers.Accept, 'application/json');
    assert.match(calls[0].headers['User-Agent'], /dsh-free-search/);
    const url = new URL(calls[0].path, `https://${c.host}`);
    assert.equal(url.pathname, c.path);
    assert.deepEqual([...url.searchParams], [[c.param, q]]);
    assert.deepEqual(await run(engine, json(c.wrap([]))), []);
    assert.equal((await run(engine, json(c.wrap(Array(5).fill(c.item))))).length, 3);
    for (const status of [301, 400, 404, 429, 503]) await assert.rejects(run(engine, { status, text: 'failure' }), new RegExp(`HTTP ${status}`));
    await assert.rejects(run(engine, new Error('fixture network failure')), /fixture network failure/);
    await assert.rejects(run(engine, { timeout: true }), /timeout after 20000ms/);
    await assert.rejects(run(engine, { status: 200, text: '<html>challenge</html>' }), /malformed JSON/);
    for (const value of [null, {}, { detail: 'rejected' }, { error: 'rejected' }, { status: 429 }, c.wrap([null]), c.wrap([{}])]) {
      await assert.rejects(run(engine, json(value)), /malformed|API error/);
    }
    for (const q of ['', '  ', null, 42]) {
      await assert.rejects(run(engine, json(c.wrap([])), q), /non-empty query/);
      assert.equal(calls.length, 0);
    }
    for (const badId of [0, -1, 1.5, '84', Number.MAX_SAFE_INTEGER + 1, 'javascript:alert(1)']) {
      const item = engine === 'gutendex' ? { ...book, id: badId } : { show: { ...show, id: badId } };
      await assert.rejects(run(engine, json(c.wrap([item]))), /malformed/);
    }
  }
  assert.deepEqual((await run('gutendex', json({ results: [book] })))[0], { url: 'https://www.gutenberg.org/ebooks/84', title: 'Frankenstein', snippet: 'Shelley, Mary · en · A book & story.', publishedAt: '' });
  assert.deepEqual((await run('tvmaze', json([{ show }])))[0], { url: 'https://www.tvmaze.com/shows/44933', title: 'Severance', snippet: 'Running · Drama · A show & story.', publishedAt: '2022-02-18' });
  const hostile = { ...show, url: 'javascript:alert(1)', name: '<script>evil()</script>&lt;b&gt;Safe\u0000', summary: 'x'.repeat(500), premiered: '<b>2022</b>' };
  const safe = (await run('tvmaze', json([{ show: hostile }])))[0];
  assert.equal(safe.url, 'https://www.tvmaze.com/shows/44933');
  assert.equal(safe.title, 'bSafe');
  assert.equal(safe.snippet.length, 280);
  assert.equal(safe.publishedAt, '');
  for (const engine of Object.keys(cases)) {
    const c = cases[engine];
    const item = engine === 'gutendex' ? { id: 1, title: 'Minimal' } : { show: { id: 1, name: 'Minimal', premiered: null } };
    assert.equal((await run(engine, json(c.wrap([item]))))[0].snippet, '');
    const empty = engine === 'gutendex' ? { ...book, title: '<script>gone</script>' } : { show: { ...show, name: '' } };
    await assert.rejects(run(engine, json(c.wrap([empty]))), /malformed/);
  }
  console.log('reference domain adapters: offline fixtures passed (2 adapters)');
} finally {
  https.request = original;
  http.request = originalHttp;
}
