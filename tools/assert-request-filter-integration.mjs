// Offline source-extraction integration tests, following assert-research-call-wrappers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRequestFilters, filterSources, requestFilterCacheKey } from '../lib/request_filters.js';
import { applyBlockedFilterToResult, setActiveBlockedDomains } from '../lib/domain_filter.js';
const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const between = (start, end) => { const a = src.indexOf(start); const b = src.indexOf(end, a); assert.ok(a >= 0 && b > a); return src.slice(a, b); };
const compile = (body, env) => new Function(...Object.keys(env), body)(...Object.values(env));
const helpers = compile(between('const REQUEST_FILTER_PARAMETERS =', '//#endregion') + '; return {rawRequestFilters, applyRequestFiltersToResult, buildCacheKey};', {
  filterSources, requestFilterCacheKey, normalizeDisabledEngines: x => x, normalizeFallbackOrder: x => x,
  normalizePoolPolicy: x => x, normalizeLanguagePool: x => x, DEFAULT_ZH_POOL: [], DEFAULT_EN_POOL: [],
});
const onceText = between('    async searchOnce(request, signal) {', '\n  };\n\n  ctx.inject(["settings"]');
const a = { url: 'https://a.test/a', publishedAt: '2026-01-02' };
const b = { url: 'https://b.test/b', publishedAt: '2025-01-02' };
let cfg = { provider: 'bing', cache: true, cacheTtl: 5, blockedDomains: [], fallbackOrder: ['bing', 'ddg'], fallbackOn: ['invalid-response'] };
const cache = new Map(), calls = [];
let results = { bing: [a, b], ddg: [a] };
const noop = () => {};
const env = {
  ...helpers, normalizeRequestFilters, applyBlockedFilterToResult, setActiveBlockedDomains,
  current: () => cfg, setActiveSearchProxy: noop, setActiveAcceptLanguage: noop, setActiveOutputLanguage: noop,
  acceptLanguageFor: noop, outputLanguage: noop, configLanguage: noop, effectiveDisabledEngines: () => [],
  normalizeFallbackOn: x => x, hasCustomFallbackOrder: () => true, normalizeFallbackOrder: x => x,
  ALL_ENGINES: ['bing', 'ddg'], autoDefaultProvider: 'bing', parseTimeRange: () => undefined,
  searchCache: cache, activity: {}, activityNoteCacheHit: noop, runMultiSearch: async request => ({ sources: filterSources([a,b], normalizeRequestFilters(request)) }),
  enabledEngines: () => ['bing', 'ddg'], EXPLICIT_ONLY_ENGINES: [], isCoolingDown: () => false,
  SEARCH_BUDGET_MS: 30000, activityCurrentRun: () => null, engineConcurrency: () => 1,
  engineRunners: Object.fromEntries(['bing','ddg'].map(engine => [engine, async () => { calls.push(engine); await Promise.resolve(); return { sources: results[engine].slice() }; }])),
  engineRuntime: { run: (_e,_c, fn) => fn(), record: noop }, EngineSkip: class extends Error {},
  clearCooldown: noop, cleanSnippet: x => x, snippetCap: noop, CACHE_MAX_ENTRIES: 50,
  FAILURE_CLASS_LABELS: {}, logger: { warn: noop }, classifyFailure: e => ({ class: 'invalid-response', message: e.message }),
  redactSecrets: x => x, environmentSecrets: () => [], coolKeysForEngine: () => true,
};
const searchOnce = compile('return ({' + onceText + '}).searchOnce;', env);
const query = 'same query';
const proseResult = { sources: [a,b], content: 'b.test secret', answer: 'b.test answer', summary: 'b.test summary' };
const proseFiltered = helpers.applyRequestFiltersToResult(proseResult, normalizeRequestFilters({includeDomains:['a.test']}));
assert.deepEqual(proseFiltered, {sources:[a]});
assert.equal(helpers.applyRequestFiltersToResult(proseResult, normalizeRequestFilters()), proseResult);
// Perplexity-shaped synthesized answer is copied into every citation snippet.
// The disallowed citation may already have been sliced away by the adapter.
for (const citations of [[a, b], [a]]) {
  const answer = 'Excluded b.test evidence appears in the aggregate answer';
  const shaped = { content: answer, sources: citations.map(s => ({ ...s, snippet: answer })) };
  const safe = helpers.applyRequestFiltersToResult(shaped, normalizeRequestFilters({ includeDomains: ['a.test'] }));
  assert.deepEqual(safe, { sources: [a] });
  assert.equal(JSON.stringify(safe).includes('Excluded'), false);
  assert.equal(helpers.applyRequestFiltersToResult(shaped, normalizeRequestFilters()), shaped);
}
assert.equal((await searchOnce({ query })).sources.length, 2);
assert.deepEqual((await searchOnce({ query, includeDomains: ['a.test'] })).sources, [a]);
assert.deepEqual((await searchOnce({ query, includeDomains: ['b.test'] })).sources, [b]);
const before = calls.length;
assert.equal((await searchOnce({ query, includeDomains: ['www.a.test'] }))._cache, 'hit');
assert.equal(calls.length, before);
assert.deepEqual((await searchOnce({ query, publishedAfter: '2026-01-01' })).sources, [a]);
await assert.rejects(searchOnce({ query, publishedAfter: '2026-02-30' }), /impossible/);
results = { bing: [b], ddg: [a] };
const fallback = await searchOnce({ query: 'fallback', includeDomains: ['a.test'] });
assert.equal(fallback.engine, 'ddg');
assert.deepEqual(fallback.sources, [a]);
assert.deepEqual(calls.slice(-2), ['bing','ddg']);
results = { bing: [a,b], ddg: [a,b] };
const simultaneous = await Promise.all(['a.test', 'b.test'].map(domain => searchOnce({ query: 'concurrent', includeDomains: [domain] })));
assert.deepEqual(simultaneous.map(r => r.sources), [[a], [b]]);
assert.deepEqual((await searchOnce({ query: 'multi', engine: 'multi', includeDomains: ['b.test'] })).sources, [b]);
cfg = { ...cfg, blockedDomains: ['a.test'] };
await assert.rejects(searchOnce({ query: 'global', includeDomains: ['a.test'] }), /0 results/);
// Run the real engine-test finalizer with stub transport, not a duplicate filtering implementation.
const engineText = between('  const runEngineTest = async', '\n\n  runMultiSearch =');
const runEngineTest = compile(engineText + '; return runEngineTest;', {
  ...env, withKeylessFirst: (_e, fn) => fn(), searchBing: async () => ({ sources: [a,b] }),
});
cfg = { ...cfg, blockedDomains: [] };
assert.deepEqual((await runEngineTest('bing', query, undefined, 5, { excludeDomains: ['a.test'] })).sources, [b]);
// Pin both parallel fanout and serial top-up forwarding and pre-merge filtering.
const multiText = between('  runMultiSearch = async', '\n  /**');
assert.equal((multiText.match(/runEngineTest\(engine, q, timeRange, limit, requestFilters\)/g) ?? []).length, 2);
assert.match(multiText, /const keptSources = filterSources/);
assert.equal((src.match(/\.\.\.REQUEST_FILTER_PARAMETERS/g) ?? []).length, 2);
assert.equal((src.match(/\.\.\.rawRequestFilters\(args\)/g) ?? []).length, 2);
// Execute the actual multi closure with controlled engine outputs and policy stubs.
const multiCalls = [];
const runMulti = compile(multiText + '; return runMultiSearch;', {
  ...env, filterSources, getActiveBlockedDomains: () => [],
  multiResultLimit: n => n || 8, languagePool: () => ['bing'],
  credentialRequirement: () => null, partitionByCredentials: list => ({eligible:list,missing:[]}),
  selectEngines: list => list, resolveMinSources: () => 1,
  routeEngines: () => ['bing','ddg'], planTopUp: ({chain}) => chain,
  normalizePoolPolicy: x => x, describeTarget: () => '',
  normalizeUrlForDedupe: x => x, domainOf: x => new URL(x).hostname,
  rankMergedResults: x => x, sanitizeSources: x => x, dedupeNearDuplicates: x => x,
  stripLoneSurrogates: x => x, setTimeout: () => {},
  runEngineTest: async (engine,q,tr,n,raw) => {
    multiCalls.push(engine);
    await Promise.resolve();
    return {ok:true,sources:filterSources(engine === 'bing' ? [b] : [a,b], normalizeRequestFilters(raw))};
  },
});
const topped = await runMulti({query, includeDomains:['a.test']});
assert.deepEqual(topped.sources.map(s => s.url), [a.url]);
assert.deepEqual(multiCalls, ['bing','ddg']);
assert.match(topped.content, /noResults: \[bing\]/);
const parallel = await Promise.all(['a.test','b.test'].map(domain => runMulti({query, engines:['bing','ddg'], includeDomains:[domain]})));
assert.deepEqual(parallel.map(r => r.sources.map(s => s.url)), [[a.url],[b.url]]);
assert.deepEqual(parallel[0].sources[0].seenIn, ['ddg']);
assert.deepEqual(parallel[1].sources[0].seenIn, ['bing','ddg']);
console.log('OK: request filter integration (cache isolation/hit, dates, fallback, concurrency, global blocks, multi forwarding, engine finalizer)');
