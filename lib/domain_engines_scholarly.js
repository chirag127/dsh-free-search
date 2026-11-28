// Independently implemented from the primary API contracts (verified 2026-11-28):
// https://support.datacite.org/docs/api-queries
// https://support.datacite.org/docs/rest-api
// https://graph.openaire.eu/docs/apis/graph-api/quickstart/
// https://graph.openaire.eu/docs/apis/authentication/
// Schema cross-check: free-search-mcp crates/manifests/sources/seed/{datacite,openaire}.toml
// and its recorded search fixtures. No upstream code or fixture bodies copied.
import { httpsJson, htmlToText } from "./fetch_upstream.js";
import { doiIdentifier } from "./scholar_identifiers.js";

const list = (v) => Array.isArray(v) ? v : [];
const text = (v) => typeof v === "string" ? htmlToText(v).replace(/\s+/g, " ").trim() : "";
function safeUrl(value) {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f]/.test(value)) return "";
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : "";
  } catch { return ""; }
}
function doiUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const doi = doiIdentifier(value);
    return doi ? `https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}` : "";
  } catch { return ""; }
}
// Preserve source precision, never manufacture January 1 from a year.
function publication(value) {
  const s = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (/^\d{4}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(s)) {
    const day = s.slice(0, 10);
    const parsed = new Date(day);
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day) return day;
  }
  return "";
}
function nonempty(v) {
  return v != null && v !== false && v !== "" && (!Array.isArray(v) || v.length > 0) &&
    (typeof v !== "object" || Array.isArray(v) || Object.keys(v).length > 0);
}
async function search(engine, endpoint, params, key, accept = "application/json") {
  const url = new URL(endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await httpsJson("GET", url.href, { headers: { Accept: accept, "User-Agent": "dsh-free-search/0.8 (plugin)" }, timeoutMs: 20000 });
  if (r.status !== 200) throw new Error(`${engine}: HTTP ${r.status}`);
  let d;
  try { d = JSON.parse(r.text); } catch { throw new Error(`${engine}: invalid JSON`); }
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error(`${engine}: malformed response`);
  if (nonempty(d.errors) || nonempty(d.error) || (typeof d.status === "number" && d.status >= 400)) throw new Error(`${engine}: API error`);
  if (!Array.isArray(d[key])) throw new Error(`${engine}: malformed ${key}`);
  return d[key];
}
function query(q) {
  if (typeof q !== "string" || !q.trim()) throw new Error("query must be nonempty text");
  return q.trim();
}
function result(url, title, description, date) {
  return url && title ? { url, title, snippet: text(description).slice(0, 280), publishedAt: publication(date) } : null;
}
const datacite = {
  desc: "DataCite keyword search for research datasets, software and DOI metadata (no key)",
  async run(q) {
    const rows = await search("datacite", "https://api.datacite.org/dois", { query: query(q), "page[size]": "3" }, "data", "application/vnd.api+json");
    return rows.map((row) => {
      const a = row?.attributes;
      const descriptions = list(a?.descriptions);
      const description = descriptions.find((d) => d?.descriptionType === "Abstract" && text(d.description))?.description
        || descriptions.find((d) => text(d?.description))?.description;
      return result(safeUrl(a?.url) || doiUrl(a?.doi) || doiUrl(row?.id), list(a?.titles).map((t) => text(t?.title)).find(Boolean), description, a?.publicationYear);
    }).filter(Boolean).slice(0, 3);
  },
};
const openaire = {
  desc: "OpenAIRE Graph keyword search for publications, datasets and research software (no key)",
  async run(q) {
    const rows = await search("openaire", "https://api.openaire.eu/graph/v3/research-products", { search: query(q), pageSize: "3" }, "results");
    return rows.map((row) => {
      const url = list(row?.instances).flatMap((i) => list(i?.urls)).map(safeUrl).find(Boolean)
        || list(row?.pids).filter((p) => typeof p?.scheme === "string" && p.scheme.toLowerCase() === "doi").map((p) => doiUrl(p.value)).find(Boolean)
        || safeUrl(row?.codeRepositoryUrl);
      return result(url, text(row?.mainTitle), list(row?.descriptions).find((d) => text(d)), row?.publicationDate);
    }).filter(Boolean).slice(0, 3);
  },
};
export const SCHOLARLY_ENGINES = { datacite, openaire };
