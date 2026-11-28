// Synthetic fixtures independently authored from official DataCite/OpenAIRE contracts.
// Recorded free-search-mcp fixtures were inspected for schema only, not copied.
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { SCHOLARLY_ENGINES } from "../lib/domain_engines_scholarly.js";

const original = https.request;
let response, calls = [];
https.request = (options, callback) => {
  calls.push(options);
  const req = new EventEmitter();
  req.write = () => {};
  req.destroy = (error) => req.emit("error", error);
  req.end = () => queueMicrotask(() => {
    if (response instanceof Error) return req.emit("error", response);
    const res = new EventEmitter();
    res.statusCode = response.status ?? 200;
    res.headers = {};
    callback(res);
    res.emit("data", Buffer.from(response.raw ?? JSON.stringify(response.body)));
    res.emit("end");
  });
  return req;
};
const dc = (attributes) => ({ attributes });
const drow = { titles: [{ title: "<b>Climate</b> data" }], url: "https://example.org/data", descriptions: [{ description: "Other" }, { descriptionType: "Abstract", description: "<p>Sample &amp; data</p>" }], publicationYear: 2024 };
const orow = { mainTitle: "<b>Open</b> research", instances: [{ urls: ["javascript:alert(1)", "https://example.org/paper"] }], descriptions: ["<p>Research &amp; software</p>"], publicationDate: "2024-02-29T00:00:00Z" };
async function run(name, body) {
  response = { body };
  return SCHOLARLY_ENGINES[name].run("  climate & water / 数据?  ");
}
try {
  assert.deepEqual(Object.keys(SCHOLARLY_ENGINES), ["datacite", "openaire"]);
  assert.deepEqual(await run("datacite", { data: [dc(drow)] }), [{ url: "https://example.org/data", title: "Climate data", snippet: "Sample & data", publishedAt: "2024" }]);
  assert.deepEqual(await run("openaire", { results: [orow] }), [{ url: "https://example.org/paper", title: "Open research", snippet: "Research & software", publishedAt: "2024-02-29" }]);
  for (const [index, host, path, queryKey, pageKey, accept] of [
    [0, "api.datacite.org", "/dois", "query", "page[size]", "application/vnd.api+json"],
    [1, "api.openaire.eu", "/graph/v3/research-products", "search", "pageSize", "application/json"],
  ]) {
    const request = calls[index];
    const url = new URL(`https://${request.hostname}${request.path}`);
    assert.equal(request.method, "GET");
    assert.equal(request.hostname, host);
    assert.equal(url.pathname, path);
    assert.equal(url.searchParams.get(queryKey), "climate & water / 数据?");
    assert.equal(url.searchParams.get(pageKey), "3");
    assert.equal([...url.searchParams].length, 2);
    assert.equal(request.headers.Accept, accept);
    assert.equal(request.headers.Authorization, undefined);
    assert.equal(request.timeout, 20000);
  }
  assert.deepEqual(await run("datacite", { data: [dc({ ...drow, url: "javascript:bad", doi: "10.1234/ABC", publicationYear: null })] }), [{ url: "https://doi.org/10.1234/abc", title: "Climate data", snippet: "Sample & data", publishedAt: "" }]);
  assert.deepEqual(await run("openaire", { results: [{ mainTitle: "Nullable", pids: [{ scheme: "DOI", value: "10.1234/ABC" }], instances: null, descriptions: null, publicationDate: null }] }), [{ url: "https://doi.org/10.1234/abc", title: "Nullable", snippet: "", publishedAt: "" }]);
  assert.equal((await run("openaire", { results: [{ mainTitle: "Software", instances: null, pids: null, codeRepositoryUrl: "https://example.org/code" }] }))[0].url, "https://example.org/code");
  assert.equal((await run("datacite", { data: [{ id: "10.1234/id", attributes: { titles: [{ title: "ID fallback" }] } }] }))[0].url, "https://doi.org/10.1234/id");
  for (const [name, key, row] of [["datacite", "data", dc(drow)], ["openaire", "results", orow]]) {
    assert.equal((await run(name, { [key]: Array(5).fill(row) })).length, 3);
    assert.deepEqual(await run(name, { [key]: [] }), []);
    assert.deepEqual(await run(name, { [key]: [null, {}, "bad", 1] }), []);
    for (const body of [null, [], {}, { [key]: null }, { [key]: {} }, { [key]: [], errors: [{ title: "failure" }] }, { [key]: [], error: "failed" }, { [key]: [], status: 500 }]) {
      response = { body };
      await assert.rejects(SCHOLARLY_ENGINES[name].run("water"), /malformed|API error/);
    }
    assert.deepEqual(await run(name, { [key]: [], errors: [] }), []);
    response = { raw: "<html>unavailable</html>" };
    await assert.rejects(SCHOLARLY_ENGINES[name].run("water"), /invalid JSON/);
    for (const status of [301, 401, 429, 503]) {
      response = { status, body: { [key]: [] } };
      await assert.rejects(SCHOLARLY_ENGINES[name].run("water"), new RegExp(`HTTP ${status}`));
    }
    response = new Error("network disconnected");
    await assert.rejects(SCHOLARLY_ENGINES[name].run("water"), /network disconnected/);
    const before = calls.length;
    for (const query of ["", "  ", null, 7]) await assert.rejects(SCHOLARLY_ENGINES[name].run(query), /nonempty/);
    assert.equal(calls.length, before);
  }
  for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///tmp/x", "https://user:pass@example.org/", "https://example.org/a b", "not a url"]) {
    assert.deepEqual(await run("datacite", { data: [dc({ ...drow, url })] }), []);
    assert.deepEqual(await run("openaire", { results: [{ ...orow, instances: [{ urls: [url] }] }] }), []);
  }
  for (const date of ["2024-02-30", "not a date", {}, null]) {
    assert.equal((await run("openaire", { results: [{ ...orow, publicationDate: date }] }))[0].publishedAt, "");
  }
  assert.equal((await run("openaire", { results: [{ ...orow, descriptions: ["x".repeat(400)] }] }))[0].snippet.length, 280);
  console.log("Scholarly domain assertions passed (mocked node:https transport; no network).");
} finally {
  https.request = original;
}
