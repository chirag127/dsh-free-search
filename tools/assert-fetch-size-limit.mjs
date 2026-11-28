// Offline bounded-download regressions: cap bytes after content decompression.
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { httpsGetFollow } from "../lib/fetch_provider.js";

let checks = 0;
const check = async (name, fn) => {
  await fn();
  console.log(`  ok  ${name}`);
  checks++;
};
const deadline = async (promise) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("test deadline exceeded")), 4000);
    })]);
  } finally { clearTimeout(timer); }
};
const withServer = async (handler, run) => {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}/`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
};
const sizeError = { code: "ERR_FETCH_SIZE_LIMIT" };

await check("exact byte boundary preserves the response contract", async () => {
  const body = Buffer.from("é🙂");
  await withServer((req, res) => {
    res.writeHead(201, { "content-type": "text/plain; charset=utf-8" });
    res.end(body);
  }, async url => {
    assert.deepEqual(await httpsGetFollow(url, { maxBytes: body.length }), {
      url, status: 201, text: "é🙂", contentType: "text/plain; charset=utf-8",
    });
    await assert.rejects(httpsGetFollow(url, { maxBytes: body.length - 1 }), sizeError);
  });
});

await check("chunked body above the cumulative limit closes the active connection", async () => {
  let closed;
  const closure = new Promise(resolve => { closed = resolve; });
  await withServer((req, res) => {
    res.on("close", closed);
    res.write("1234");
    setImmediate(() => res.write("5")); // Deliberately never end the response.
  }, async url => {
    let requestError;
    const transport = { request(options, callback) {
      const req = http.request(options, callback);
      requestError = new Promise(resolve => req.on("error", resolve));
      return req;
    } };
    await assert.rejects(deadline(httpsGetFollow(url, { maxBytes: 4 }, transport)), sizeError);
    assert.equal((await deadline(requestError)).code, "ERR_FETCH_SIZE_LIMIT");
    await deadline(closure);
  });
});

for (const [encoding, compress] of [
  ["gzip", zlib.gzipSync], ["deflate", zlib.deflateSync], ["br", zlib.brotliCompressSync],
]) {
  await check(`${encoding}: compressed expansion rejects, exact decoded boundary accepts`, async () => {
    const body = Buffer.alloc(65536, 120);
    const packed = compress(body);
    assert.ok(packed.length < 1024);
    await withServer((req, res) => {
      res.writeHead(200, { "content-encoding": encoding, "content-length": packed.length });
      res.end(packed);
    }, async url => {
      await assert.rejects(deadline(httpsGetFollow(url, { maxBytes: 1024 })), sizeError);
      assert.equal((await httpsGetFollow(url, { maxBytes: body.length })).text, body.toString());
    });
  });
}

await check("omitted and undefined maxBytes use a 10 MiB boundary", async () => {
  const limit = 10 * 1024 * 1024;
  await withServer((req, res) => res.end(Buffer.alloc(req.url === "/over" ? limit + 1 : limit, 120)), async url => {
    assert.equal((await httpsGetFollow(url)).text.length, limit);
    assert.equal((await httpsGetFollow(url, { maxBytes: undefined })).text.length, limit);
    await assert.rejects(httpsGetFollow(`${url}over`), sizeError);
  });
});

await check("invalid maxBytes rejects before transport, agent selection, or lookup", async () => {
  let calls = 0;
  const unexpected = () => { calls++; throw new Error("network must not be touched"); };
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "4", null, true, {}, 1n]) {
    await assert.rejects(httpsGetFollow("http://127.0.0.1/", {
      maxBytes, agent: unexpected, lookup: unexpected,
    }, { request: unexpected }), { name: "TypeError", message: "maxBytes must be a positive safe integer" });
  }
  assert.equal(calls, 0);
});

await check("redirect retains the configured size limit", async () => {
  await withServer((req, res) => {
    if (req.url === "/") { res.writeHead(302, { location: "/body" }); res.end(); }
    else res.end("12345");
  }, async url => {
    await assert.rejects(httpsGetFollow(url, { maxBytes: 4 }), sizeError);
    assert.equal((await httpsGetFollow(url, { maxBytes: 5 })).text, "12345");
  });
});

await check("cancellation below the cap still rejects and closes a stalled body", async () => {
  const controller = new AbortController();
  let closed;
  const closure = new Promise(resolve => { closed = resolve; });
  await withServer((req, res) => {
    res.on("close", closed);
    res.write("x");
    setImmediate(() => controller.abort(new Error("caller cancelled")));
  }, async url => {
    await assert.rejects(deadline(httpsGetFollow(url, { maxBytes: 10, signal: controller.signal })), /caller cancelled/);
    await deadline(closure);
  });
});
console.log(`OK: ${checks} fetch size limit checks passed`);
