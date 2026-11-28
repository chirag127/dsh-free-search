// Native keyword-only research adapters; no MCP or DSH runtime dependency.
// Primary contracts verified 2026-11-28:
// https://clinicaltrials.gov/api/oas/v2
// https://openlibrary.org/dev/docs/api/search (also official internetarchive/openlibrary source)
// https://datadryad.org/openapi.yml
// https://docs.figshare.com/swagger.json
import { httpsJson, htmlToText } from './fetch_upstream.js';

const HEADERS = { 'User-Agent': 'dsh-free-search/0.8 (plugin)', Accept: 'application/json' };
const LIMIT = 3;
const text = (v) => typeof v === 'string' ? htmlToText(v).replace(/\s+/g, ' ').trim() : '';
const date = (v) => typeof v === 'string' ? v.slice(0, 10) : '';
const strings = (v) => Array.isArray(v) ? v.filter(x => typeof x === 'string').map(text).join(', ') : '';
function query(q) {
  if (typeof q !== 'string' || !q.trim()) throw new Error('Research search requires a non-empty query');
  return q.trim();
}
function malformed(engine) { throw new Error(`${engine}: malformed response`); }
function rows(value, engine) {
  if (!Array.isArray(value)) malformed(engine);
  return value.slice(0, LIMIT);
}
function source(engine, url, title, snippet, publishedAt) {
  if (!text(title)) malformed(engine);
  try { if (!['http:', 'https:'].includes(new URL(url).protocol)) malformed(engine); }
  catch { malformed(engine); }
  return { url, title: text(title), snippet: text(snippet).slice(0, 280), publishedAt: date(publishedAt) };
}
async function request(engine, url, body) {
  const r = await httpsJson(body ? 'POST' : 'GET', url, {
    headers: { ...HEADERS, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    timeoutMs: 20000, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status !== 200) throw new Error(`${engine}: HTTP ${r.status}`);
  let d;
  try { d = JSON.parse(r.text); } catch { throw new Error(`${engine}: malformed JSON response`); }
  if (d && !Array.isArray(d) && (d.error != null || (d.code != null && d.message != null))) {
    throw new Error(`${engine}: API error`);
  }
  return d;
}
const clinicaltrials = {
  desc: 'ClinicalTrials.gov: clinical trials by keyword (search only)',
  async run(q) {
    const params = new URLSearchParams({ 'query.term': query(q), format: 'json', pageSize: String(LIMIT) });
    const d = await request('clinicaltrials', `https://clinicaltrials.gov/api/v2/studies?${params}`);
    return rows(d?.studies, 'clinicaltrials').map(s => {
      const p = s?.protocolSection;
      const id = p?.identificationModule?.nctId;
      if (typeof id !== 'string' || !/^NCT\d{8}$/.test(id)) malformed('clinicaltrials');
      const title = text(p.identificationModule.briefTitle) || text(p.identificationModule.officialTitle);
      if (!title) malformed('clinicaltrials');
      return source('clinicaltrials', `https://clinicaltrials.gov/study/${id}`, `${id} — ${title}`,
        [text(p.statusModule?.overallStatus), strings(p.conditionsModule?.conditions), text(p.descriptionModule?.briefSummary)].filter(Boolean).join(' · '),
        p.statusModule?.studyFirstPostDateStruct?.date);
    });
  },
};
const openlibrary = {
  desc: 'Open Library: books by title, author, or keywords (search only)',
  async run(q) {
    const params = new URLSearchParams({ q: query(q), limit: String(LIMIT), fields: 'key,title,author_name,first_publish_year,edition_count' });
    const d = await request('openlibrary', `https://openlibrary.org/search.json?${params}`);
    return rows(d?.docs, 'openlibrary').map(w => {
      if (typeof w?.key !== 'string' || !/^(?:\/works\/)?OL\d+W$/.test(w.key)) malformed('openlibrary');
      const key = w.key.startsWith('/') ? w.key : `/works/${w.key}`;
      const year = Number.isInteger(w.first_publish_year) ? String(w.first_publish_year) : '';
      return source('openlibrary', `https://openlibrary.org${key}`, w.title,
        [strings(w.author_name), Number.isInteger(w.edition_count) ? `${w.edition_count} editions` : ''].filter(Boolean).join(' · '), year);
    });
  },
};
const dryad = {
  desc: 'Dryad: curated research datasets by keyword (search only)',
  async run(q) {
    const params = new URLSearchParams({ q: query(q), per_page: String(LIMIT), page: '1' });
    const d = await request('dryad', `https://datadryad.org/api/v2/search?${params}`);
    return rows(d?._embedded?.['stash:datasets'], 'dryad').map(w => {
      const doi = typeof w?.identifier === 'string' ? w.identifier.replace(/^doi:/i, '') : '';
      if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) malformed('dryad');
      return source('dryad', `https://doi.org/${encodeURI(doi).replace(/#/g, '%23').replace(/\?/g, '%3F')}`, w.title, w.abstract, w.publicationDate);
    });
  },
};
const figshare = {
  desc: 'Figshare: public datasets by keyword (search only)',
  async run(q) {
    const d = await request('figshare', 'https://api.figshare.com/v2/articles/search', { search_for: query(q), item_type: 3, page: 1, page_size: LIMIT });
    return rows(d, 'figshare').map(w => {
      const doi = typeof w?.doi === 'string' && /^10\.\d{4,9}\/\S+$/.test(w.doi) ? w.doi : '';
      const url = text(w?.url_public_html) || (doi ? `https://doi.org/${encodeURI(doi).replace(/#/g, '%23').replace(/\?/g, '%3F')}` : '');
      return source('figshare', url, w?.title, [text(w?.defined_type_name), doi ? `DOI ${doi}` : ''].filter(Boolean).join(' · '), w?.published_date);
    });
  },
};

// Parent registry integration: import and spread RESEARCH_ENGINES into ENGINES.
export const RESEARCH_ENGINES = { clinicaltrials, openlibrary, dryad, figshare };
