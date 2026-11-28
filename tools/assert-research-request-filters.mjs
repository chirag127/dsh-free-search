import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRequestFilters, sourceMatchesFilters, filterSources } from '../lib/request_filters.js';
import { isDomainBlocked, normalizeDomainList } from '../lib/domain_filter.js';

// Execute the actual research module with only its imported service boundaries replaced.
// This keeps the assertion offline and independent of installed DSH runtime packages.
const src = readFileSync(new URL('../lib/research.js', import.meta.url), 'utf8');
let cacheReads = 0, writes = 0, fetches = [], searches = [], fallbackCalls = 0;
let cached = null, searchResults = [], responseUrl;
const body = 'Alpha technical evidence and documentation. '.repeat(30);
const deps = {
  defineTool: x => x,
  getFresh: () => { cacheReads++; return cached; },
  cachePut: () => { writes++; }, cacheSearch: () => [],
  rerank: async (_q, docs) => docs.map(() => 1), embed: async () => null,
  cosineMatrix: () => null, decide: async () => ({ sufficient: { noul: 0.1 } }),
  judgeQueryIntent: async () => null,
  promptLanguageOf: () => 'en', toolDescription: () => '', toolParam: () => '',
  localizedEffect: (_ctx, opts) => opts.register('en'),
  httpsJson: () => { throw Error('unexpected network'); }, htmlToText: s => s,
  callExa: async () => { fallbackCalls++; return body; },
  callFirecrawl: async () => { throw Error('unexpected network'); },
  callCrawl4ai: async () => { throw Error('unexpected network'); },
  isDomainBlocked, normalizeDomainList, normalizeRequestFilters, sourceMatchesFilters, filterSources,
  assessEvidenceQuality: () => ({}),
};
const api = new Function(...Object.keys(deps), src.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nreturn { registerResearchTool, fetchTiered, makeBudget };')(...Object.values(deps));
let tool;
const ctx = { inject: (_names, fn) => fn({ tools: { register: t => { if (t.name === 'research') tool = t; } } }), web: { fetch: async ({ url }) => { fetches.push(url); return { url: responseUrl || url, statusCode: 200, body: { kind: 'text', content: body } }; } } };
api.registerResearchTool(ctx, { provider: { search: async args => { searches.push(args); return { sources: searchResults[searches.length - 1] || [] }; } }, resolveApiKey: async () => undefined, wrapUntrustedBlock: x => x });
const good = { url: 'https://allowed.test/a', title: 'Alpha', publishedAt: '2026-04-15', snippet: 'evidence' };
const filters = { includeDomains: ['allowed.test'], publishedAfter: '2026-04-01', publishedBefore: '2026-04-30' };
searchResults = [[{ ...good, url: 'https://blocked.test/a' }, { ...good, publishedAt: undefined, url: 'https://allowed.test/undated' }, { ...good, publishedAt: '2025-01-01', url: 'https://allowed.test/old' }, good]];
cached = { content: 'undated cached body', fetched_at: Date.now() };
let out = await tool.execute({ question: 'Alpha', ...filters });
assert.deepEqual(out.sources.map(s => s.url), [good.url]);
assert.deepEqual(fetches, [good.url]);
assert.equal(cacheReads, 0);
assert.equal(out.documents[0].cache, false);
assert.match(out.documents[0].published, /2026-04-15.*engine result/);
for (const key of Object.keys(filters)) assert.deepEqual(searches[0][key], filters[key]);
assert.ok(out.notes.some(n => n.includes('never fetched_at')));

// Rejected redirect result is neither cached nor accepted as body evidence.
responseUrl = 'https://blocked.test/redirect'; searches = []; fetches = []; writes = 0;
out = await tool.execute({ question: 'Alpha', ...filters });
assert.equal(writes, 0);
assert.ok(out.documents.every(d => d.kind === 'snippet-only'));

// No-filter calls preserve cache use and omit request fields entirely.
searches = []; responseUrl = undefined; cacheReads = 0;
out = await tool.execute({ question: 'Alpha' });
assert.ok(cacheReads > 0);
assert.ok(out.documents.some(d => d.cache));
assert.equal('includeDomains' in searches[0], false);

// Fetch guard itself rejects before either cache or network.
cacheReads = 0; fetches = [];
assert.equal(await api.fetchTiered(ctx, 'https://blocked.test/a', '', { requestFilters: normalizeRequestFilters(filters), notes: [] }, api.makeBudget(1), { freshness: 'none' }, { ...good, url: 'https://blocked.test/a' }), null);
assert.equal(cacheReads, 0); assert.deepEqual(fetches, []);

// Date-only bounds retain text-only fallback; no fabricated publication time.
const shortCtx = { web: { fetch: async ({ url }) => ({ url, statusCode: 200, body: { content: '' } }) } };
const result = await api.fetchTiered(shortCtx, good.url, '', { requestFilters: normalizeRequestFilters({ publishedAfter: '2026-04-01' }), notes: [], exaKey: 'fake' }, api.makeBudget(1), { freshness: 'none' }, good);
assert.equal(result.tier, 'exa'); assert.equal(fallbackCalls, 1);

// Force the real comparison rewrite path to prove raw filters survive both searches.
searches = []; fetches = []; cached = null;
searchResults = [[good], [{ ...good, title: 'Beta', url: 'https://allowed.test/b' }, { ...good, url: 'https://blocked.test/b' }]];
api.registerResearchTool(ctx, { provider: { search: async args => { searches.push(args); return { sources: searchResults[searches.length - 1] || [] }; } }, resolveApiKey: async key => ['SILICONFLOW_RERANK_API_KEY', 'DECISION_MODEL_API_KEY'].includes(key) ? 'fake' : undefined, wrapUntrustedBlock: x => x });
out = await tool.execute({ question: 'Alpha vs Beta', ...filters });
assert.equal(searches.length, 2);
for (const request of searches) for (const key of Object.keys(filters)) assert.deepEqual(request[key], filters[key]);
assert.ok(out.documents.some(d => d.round === 2));
assert.ok(out.documents.every(d => d.url.startsWith('https://allowed.test/')));
assert.ok(fetches.every(u => u.startsWith('https://allowed.test/')));
await assert.rejects(tool.execute({ question: 'Alpha', publishedAfter: 'bad' }), /publishedAfter/);
console.log('OK: research request filters (initial + rewrite, prefetch guard, redirects, cache dates, date-only fallback, no-filter compatibility)');
