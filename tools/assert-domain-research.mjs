import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { RESEARCH_ENGINES } from '../lib/domain_engines_research.js';

// Exercise actual adapters and fetch_upstream; intercept only the network boundary.
const original = https.request;
const originalHttp = http.request;
let fixture;
let calls = [];
https.request = (options, callback) => {
  const call = { ...options, body: '' };
  calls.push(call);
  const req = new EventEmitter();
  req.write = chunk => { call.body += chunk; };
  req.destroy = error => req.emit('error', error);
  req.end = () => queueMicrotask(() => {
    if (fixture instanceof Error) return req.emit('error', fixture);
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
async function run(engine, response, q = 'climate') {
  calls = [];
  fixture = response;
  return RESEARCH_ENGINES[engine].run(q);
}
const trial = { protocolSection: { identificationModule: { nctId: 'NCT04280705', briefTitle: 'A trial' }, statusModule: { overallStatus: 'COMPLETED', studyFirstPostDateStruct: { date: '2020-02-21' } }, conditionsModule: { conditions: ['Condition'] }, descriptionModule: { briefSummary: 'Trial summary' } } };
const book = { key: '/works/OL123W', title: 'A book', author_name: ['Author'], edition_count: 2, first_publish_year: 2001 };
const dataset = { identifier: 'doi:10.5061/dryad.example', title: '<b>A dataset</b>', abstract: '<p>Data &amp; methods</p>', publicationDate: '2024-01-02' };
const article = { title: 'A figure dataset', url_public_html: 'https://figshare.com/articles/dataset/Example/123', doi: '10.6084/m9.figshare.123', defined_type_name: 'dataset', published_date: '2024-02-03T12:00:00Z' };
const cases = {
  clinicaltrials: { wrap: items => ({ studies: items }), item: trial, host: 'clinicaltrials.gov', path: '/api/v2/studies', param: 'query.term', limit: 'pageSize' },
  openlibrary: { wrap: items => ({ docs: items }), item: book, host: 'openlibrary.org', path: '/search.json', param: 'q', limit: 'limit' },
  dryad: { wrap: items => ({ _embedded: { 'stash:datasets': items } }), item: dataset, host: 'datadryad.org', path: '/api/v2/search', param: 'q', limit: 'per_page' },
  figshare: { wrap: items => items, item: article, host: 'api.figshare.com', path: '/v2/articles/search' },
};
try {
  assert.deepEqual(Object.keys(RESEARCH_ENGINES), Object.keys(cases));
  for (const [engine, c] of Object.entries(cases)) {
    const q = 'cancer & diabetes + 中文 / "quoted"?#%';
    const result = await run(engine, json(c.wrap([c.item])), q);
    assert.equal(result.length, 1);
    assert.deepEqual(Object.keys(result[0]), ['url', 'title', 'snippet', 'publishedAt']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hostname, c.host);
    assert.equal(calls[0].timeout, 20000);
    assert.equal(calls[0].headers.Accept, 'application/json');
    const url = new URL(calls[0].path, `https://${c.host}`);
    assert.equal(url.pathname, c.path);
    if (engine === 'figshare') {
      assert.equal(calls[0].method, 'POST');
      assert.equal(calls[0].headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(calls[0].body), { search_for: q, item_type: 3, page: 1, page_size: 3 });
    } else {
      assert.equal(calls[0].method, 'GET');
      assert.equal(url.searchParams.get(c.param), q);
      assert.equal(url.searchParams.get(c.limit), '3');
      assert.equal(calls[0].body, '');
    }
    assert.deepEqual(await run(engine, json(c.wrap([]))), []);
    assert.equal((await run(engine, json(c.wrap(Array(5).fill(c.item))))).length, 3);
    for (const status of [400, 404, 429, 503]) await assert.rejects(run(engine, { status, text: 'failure' }), new RegExp(`HTTP ${status}`));
    await assert.rejects(run(engine, new Error('fixture network failure')), /fixture network failure/);
    await assert.rejects(run(engine, { status: 200, text: '<html>challenge</html>' }), /malformed JSON/);
    for (const value of [null, {}, { error: 'rejected' }, { code: 400, message: 'rejected' }, c.wrap([null]), c.wrap([{}])]) {
      await assert.rejects(run(engine, json(value)), /malformed|API error/);
    }
    for (const q of ['', '  ', null, 42]) {
      await assert.rejects(run(engine, json(c.wrap([])), q), /non-empty query/);
      assert.equal(calls.length, 0);
    }
  }
  assert.deepEqual((await run('clinicaltrials', json({ studies: [trial] })))[0], { url: 'https://clinicaltrials.gov/study/NCT04280705', title: 'NCT04280705 — A trial', snippet: 'COMPLETED · Condition · Trial summary', publishedAt: '2020-02-21' });
  assert.deepEqual((await run('openlibrary', json({ docs: [book] })))[0], { url: 'https://openlibrary.org/works/OL123W', title: 'A book', snippet: 'Author · 2 editions', publishedAt: '2001' });
  assert.equal((await run('openlibrary', json({ docs: [{ ...book, key: 'OL123W' }] })))[0].url, 'https://openlibrary.org/works/OL123W');
  assert.equal((await run('dryad', json(cases.dryad.wrap([dataset]))))[0].snippet, 'Data & methods');
  assert.equal((await run('figshare', json([article])))[0].publishedAt, '2024-02-03');
  assert.equal((await run('figshare', json([{ ...article, url_public_html: '' }])))[0].url, 'https://doi.org/10.6084/m9.figshare.123');
  await assert.rejects(run('figshare', json([{ ...article, url_public_html: 'javascript:alert(1)' }])), /malformed/);
  const long = { ...dataset, abstract: 'x'.repeat(500) };
  assert.equal((await run('dryad', json(cases.dryad.wrap([long]))))[0].snippet.length, 280);
  console.log('research domain adapters: offline fixtures passed (4 adapters)');
} finally {
  https.request = original;
  http.request = originalHttp;
}
