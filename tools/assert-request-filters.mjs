import assert from 'node:assert/strict';
import { normalizeRequestFilters as normalize, sourceMatchesFilters as matches, filterSources, requestFilterCacheKey as key } from '../lib/request_filters.js';
import { setActiveBlockedDomains, getActiveBlockedDomains } from '../lib/domain_filter.js';

const source = (url, publishedAt) => ({ url, publishedAt });
const empty = normalize();
const unchanged = Object.freeze([Object.freeze(source('not a URL')), null, Object.freeze(source('https://example.com', 'invalid'))]);
assert.equal(filterSources(unchanged, empty), unchanged);
assert.equal(matches(null, empty), true);
assert.throws(() => filterSources(null, empty), TypeError);

const input = Object.freeze({
  includeDomains: Object.freeze(['WWW.Example.COM.', 'https://example.com/path', 'other.test']),
  excludeDomains: Object.freeze(['deny.example.com']),
  publishedAfter: '2024-02-29', publishedBefore: '2024-02-29',
});
const global = Object.freeze(['global.example.com', 'deny.example.com']);
const filters = normalize(input, global);
assert.deepEqual(filters.includeDomains, ['example.com', 'other.test']);
assert.deepEqual(filters.excludeDomains, ['deny.example.com', 'global.example.com']);
assert.equal(filters.publishedAfter, '2024-02-29T00:00:00.000Z');
assert.equal(filters.publishedBefore, '2024-02-29T23:59:59.999Z');
assert.ok(Object.isFrozen(filters) && Object.isFrozen(filters.includeDomains) && Object.isFrozen(filters.excludeDomains));
assert.throws(() => filters.includeDomains.push('mutate.test'), TypeError);
assert.equal(input.includeDomains[0], 'WWW.Example.COM.');
assert.deepEqual(global, ['global.example.com', 'deny.example.com']);

for (const date of ['2024-02-29', '2024-02-29T00:00:00Z', '2024-02-29T23:59:59.999Z', '2024-03-01T01:59:59.999+02:00']) {
  assert.equal(matches(source('https://www.sub.example.com./x', date), filters), true, date);
}
for (const date of [undefined, null, '', 'garbage', '2024-02-30', '2024-02-29T12:00:00', '2024-02-28T23:59:59.999Z', '2024-03-01T00:00:00Z']) {
  assert.equal(matches(source('https://example.com', date), filters), false, String(date));
}
assert.equal(matches({ url: 'https://example.com', fetched_at: '2024-02-29' }, filters), false);
for (const url of ['https://deny.example.com', 'https://child.global.example.com.', 'https://notexample.com', 'broken']) {
  assert.equal(matches(source(url, '2024-02-29'), filters), false, url);
}
assert.equal(matches(source('https://example.com'), normalize({ includeDomains: ['example.com'], excludeDomains: ['example.com'] })), false);
assert.equal(matches(source('https://example.com'), normalize({ includeDomains: ['example.com'] }, ['example.com'])), false);
assert.equal(matches(source('https://example.com'), normalize({ excludeDomains: [] }, ['example.com'])), false);

for (const field of ['includeDomains', 'excludeDomains']) {
  for (const value of [null, '', 'example.com', {}, [null], [12], [''], [' '], ['bad domain'], ['bad_domain'], ['-bad.test'], ['bad-.test'], ['bad..test'], ['a'.repeat(64) + '.test'], ['ok.test', 'bad domain']]) {
    assert.throws(() => normalize({ [field]: value }), undefined, `${field}: ${JSON.stringify(value)}`);
  }
}
assert.throws(() => normalize({}, ['bad domain']));
for (const value of [null, [], 42, 'filters']) assert.throws(() => normalize(value), TypeError);
for (const field of ['publishedAfter', 'publishedBefore']) {
  for (const value of [null, 0, new Date(), '', '2023-02-29', '1900-02-29', '2024-04-31', '2024-00-01', '2024-13-01', '2024-01-00', '2024-01-32', '2024-02-29T24:00:00Z', '2024-02-29T12:60:00Z', '2024-02-29T12:00:60Z', '2024-02-29T12:00:00+24:00', '2024-02-29T12:00:00+02:60', '2024-02-29T12:00:00', '02/29/2024', '2024-2-29']) {
    assert.throws(() => normalize({ [field]: value }), undefined, `${field}: ${value}`);
  }
}
assert.doesNotThrow(() => normalize({ publishedAfter: '2000-02-29' }));
assert.throws(() => normalize({ publishedAfter: '2024-03-01', publishedBefore: '2024-02-29' }), RangeError);
const instant = normalize({ publishedAfter: '2024-02-29T12:00:00+02:00', publishedBefore: '2024-02-29T10:00:00Z' });
assert.equal(matches(source('https://example.com', '2024-02-29T10:00:00Z'), instant), true);
assert.equal(matches(source('https://example.com', '2024-02-29T10:00:00.001Z'), instant), false);
assert.equal(matches(source('https://example.com', '2024-02-29T09:59:59.999Z'), instant), false);

assert.equal(key(normalize({ includeDomains: ['z.test', 'WWW.A.TEST.', 'a.test'] }, ['blocked.test'])), key(normalize({ includeDomains: ['a.test', 'z.test'], excludeDomains: ['blocked.test'] })));
assert.equal(key(normalize({ publishedAfter: '2024-02-29' })), key(normalize({ publishedAfter: '2024-02-29T02:00:00+02:00' })));
assert.notEqual(key(empty), key(normalize({}, ['blocked.test'])));
assert.notEqual(key(empty), key(normalize({ publishedBefore: '2024-02-29' })));
const candidates = Object.freeze([source('https://one.test'), source('https://two.test'), source('https://one.test/x')].map(Object.freeze));
const savedActive = getActiveBlockedDomains();
try {
  setActiveBlockedDomains(['one.test']);
  await Promise.all(Array.from({ length: 40 }, async (_, index) => {
    const domain = index % 2 ? 'one.test' : 'two.test';
    const local = normalize({ includeDomains: [domain] });
    await Promise.resolve();
    const result = filterSources(candidates, local);
    assert.deepEqual(result, candidates.filter(item => item.url.includes(domain)));
    assert.equal(result[0], domain === 'one.test' ? candidates[0] : candidates[1]);
    assert.deepEqual(local.excludeDomains, []);
  }));
  assert.deepEqual(getActiveBlockedDomains(), ['one.test']);
} finally {
  setActiveBlockedDomains(savedActive);
}
console.log('request filters assertions passed (validation, immutable state, UTC boundaries, cache keys, concurrent isolation)');
