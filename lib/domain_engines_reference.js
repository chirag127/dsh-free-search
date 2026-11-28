// Native keyword-only reference adapters; no server or new dependencies.
// Contracts verified 2026-11-28: https://gutendex.com/ and https://www.tvmaze.com/api
// Comparison: free-search-mcp/crates/manifests/sources/w5c/{gutendex,tvmaze}.toml
// Gutendex recommends self-hosting for long-term use. TVmaze data is CC BY-SA 4.0;
// retain TVmaze result links for attribution. No pagination or automatic retries.
import { httpsJson, htmlToText } from './fetch_upstream.js';

const LIMIT = 3;
const text = value => typeof value === 'string' ? htmlToText(value).replace(/[<>]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
const strings = value => Array.isArray(value) ? value.map(text).filter(Boolean).join(', ') : '';
function malformed(engine) { throw new Error(`${engine}: malformed response`); }
function id(value, engine) {
  if (!Number.isSafeInteger(value) || value <= 0) malformed(engine);
  return value;
}
async function request(engine, base, param, q) {
  if (typeof q !== 'string' || !q.trim()) throw new Error(`${engine}: search requires a non-empty query`);
  const url = `${base}?${new URLSearchParams({ [param]: q.trim() })}`;
  const r = await httpsJson('GET', url, { headers: { 'User-Agent': 'dsh-free-search/0.8 (plugin)', Accept: 'application/json' }, timeoutMs: 20000 });
  if (r.status !== 200) throw new Error(`${engine}: HTTP ${r.status}`);
  let data;
  try { data = JSON.parse(r.text); } catch { throw new Error(`${engine}: malformed JSON response`); }
  if (data && !Array.isArray(data) && (data.detail != null || data.error != null || data.status >= 400)) throw new Error(`${engine}: API error`);
  return data;
}
function rows(value, engine) {
  if (!Array.isArray(value)) malformed(engine);
  return value.slice(0, LIMIT);
}
function source(engine, url, title, snippet, publishedAt = '') {
  title = text(title);
  if (!title) malformed(engine);
  return { url, title, snippet: text(snippet).slice(0, 280), publishedAt };
}
const gutendex = {
  desc: 'Gutendex: Project Gutenberg books by title or author (search only)',
  async run(q) {
    const d = await request('gutendex', 'https://gutendex.com/books/', 'search', q);
    return rows(d?.results, 'gutendex').map(book => source('gutendex',
      `https://www.gutenberg.org/ebooks/${id(book?.id, 'gutendex')}`, book.title,
      [Array.isArray(book.authors) ? book.authors.map(author => text(author?.name)).filter(Boolean).join(', ') : '',
        strings(book.languages), strings(book.summaries)].filter(Boolean).join(' · ')));
  },
};
const tvmaze = {
  desc: 'TVmaze: TV shows by name (search only; CC BY-SA data)',
  async run(q) {
    const d = await request('tvmaze', 'https://api.tvmaze.com/search/shows', 'q', q);
    return rows(d, 'tvmaze').map(hit => {
      const show = hit?.show;
      // Canonical ID URL avoids trusting arbitrary URLs in upstream data.
      const url = `https://www.tvmaze.com/shows/${id(show?.id, 'tvmaze')}`;
      const premiered = typeof show.premiered === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(show.premiered) ? show.premiered : '';
      return source('tvmaze', url, show.name,
        [text(show.status), strings(show.genres), text(show.summary)].filter(Boolean).join(' · '), premiered);
    });
  },
};
export const REFERENCE_ENGINES = { gutendex, tvmaze };
