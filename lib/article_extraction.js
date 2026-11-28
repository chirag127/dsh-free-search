// Optional, local-only article extraction. Returned HTML is NOT sanitized.
// Contracts: https://github.com/mozilla/readability#readme
// https://github.com/jsdom/jsdom#executing-scripts (scripts/resources off by default).
export const ARTICLE_LIMITS = Object.freeze({ maxInputChars: 2_000_000, maxElements: 20_000, minTextChars: 200 });

async function loadDependencies() {
  const [dom, reader] = await Promise.all([import('jsdom'), import('@mozilla/readability')]);
  return { JSDOM: dom.JSDOM, VirtualConsole: dom.VirtualConsole, Readability: reader.Readability };
}

function limit(value, fallback, ceiling) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, ceiling) : fallback;
}

// Iterative traversal avoids call-stack exhaustion on deeply nested documents.
function paragraphText(root) {
  const blocks = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TR']);
  const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const parts = [];
  const stack = [{ node: root, exit: false }];
  while (stack.length) {
    const { node, exit } = stack.pop();
    if (node.nodeType === 3) { parts.push(node.nodeValue || ''); continue; }
    if (ignored.has(node.nodeName)) continue;
    if (node.nodeName === 'BR') { parts.push('\n'); continue; }
    if (blocks.has(node.nodeName)) parts.push('\n\n');
    if (exit) continue;
    stack.push({ node, exit: true });
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push({ node: child, exit: false });
  }
  return parts.join('').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Extract from already-fetched HTML only; never fetches a URL or reads a document file.
 * dependencies/loadDependencies are trusted application/test seams, not page-controlled.
 * Fallback retains the EXACT original HTML for the caller's existing slimHtml stage;
 * text is null so callers cannot mistake fallback for an extracted article.
 * Input is rejected, not truncated. Limits bound input and DOM size, not wall time.
 */
export async function extractArticle(html, sourceUrl, options = {}) {
  const fallback = reason => ({ status: 'fallback', extracted: false, reason, html, text: null, sourceUrl, extractor: null });
  if (typeof html !== 'string') return fallback('invalid-input');
  const maxInputChars = limit(options.maxInputChars, ARTICLE_LIMITS.maxInputChars, ARTICLE_LIMITS.maxInputChars);
  const maxElements = limit(options.maxElements, ARTICLE_LIMITS.maxElements, ARTICLE_LIMITS.maxElements);
  const minTextChars = limit(options.minTextChars, ARTICLE_LIMITS.minTextChars, ARTICLE_LIMITS.maxInputChars);
  if (html.length > maxInputChars) return fallback('input-limit');
  if (!html.trim()) return fallback('empty-input');
  let url;
  try {
    url = new URL(sourceUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return fallback('invalid-url');
  } catch { return fallback('invalid-url'); }
  // Conservative preflight avoids building obviously oversized DOMs. Exact count follows.
  let count = 0;
  for (const unused of html.matchAll(/<[a-z][^\s/>]*/gi)) {
    if (++count > maxElements) return fallback('element-limit');
  }
  let deps;
  try { deps = options.dependencies ?? await (options.loadDependencies || loadDependencies)(); }
  catch { return fallback('dependencies-unavailable'); }
  if (typeof deps?.JSDOM !== 'function' || typeof deps?.Readability !== 'function') return fallback('dependencies-unavailable');
  let dom;
  try {
    // Do not accept/spread caller DOM options: runScripts/resources MUST stay absent.
    const domOptions = { url: url.href, contentType: 'text/html' };
    if (typeof deps.VirtualConsole === 'function') domOptions.virtualConsole = new deps.VirtualConsole();
    dom = new deps.JSDOM(html, domOptions);
    const document = dom.window.document;
    if (document.getElementsByTagName('*').length > maxElements) return fallback('element-limit');
    const article = new deps.Readability(document, { maxElemsToParse: maxElements, charThreshold: minTextChars }).parse();
    if (!article) return fallback('no-article');
    if (typeof article.content !== 'string' || !article.content.trim()) return fallback('insufficient-content');
    if (article.content.length > maxInputChars) return fallback('output-limit');
    // Inert template parses the extracted fragment without another browsing context.
    const template = document.createElement('template');
    template.innerHTML = article.content;
    if (template.content.querySelectorAll('*').length > maxElements) return fallback('element-limit');
    const text = paragraphText(template.content);
    if (text.replace(/\s/g, '').length < minTextChars) return fallback('insufficient-content');
    return { status: 'extracted', extracted: true, reason: null, html: article.content, text, sourceUrl, extractor: 'mozilla-readability', title: typeof article.title === 'string' ? article.title : '' };
  } catch { return fallback('parser-error'); }
  finally { try { dom?.window?.close(); } catch { /* cleanup must not break fallback */ } }
}
