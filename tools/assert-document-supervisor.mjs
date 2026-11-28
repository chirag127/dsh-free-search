import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDocumentWorker } from '../lib/document_supervisor.js';

const dir = await mkdtemp(join(tmpdir(), 'document-supervisor-'));
const bytes = Buffer.from('tiny document');
async function worker(name, source) {
  const path = join(dir, `${name}.mjs`);
  await writeFile(path, source);
  return pathToFileURL(path);
}
const rejects = (promise, code) => assert.rejects(promise, { code });
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'cleanup completes within five seconds');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function slotsFree(url) {
  await until(async () => {
    const results = await Promise.allSettled([runDocumentWorker(url, bytes), runDocumentWorker(url, bytes)]);
    for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'DOCUMENT_BUSY');
    return results.every(result => result.status === 'fulfilled');
  });
}
try {
  const success = await worker('success', `let chunks=[]; for await (const c of process.stdin) chunks.push(c); process.stdout.write(JSON.stringify({text:Buffer.concat(chunks).toString(),truncated:false}));`);
  assert.deepEqual(await runDocumentWorker(success, bytes), { text: 'tiny document', truncated: false });
  const boundary = await worker('boundary', `process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({text:'x'.repeat(200000),truncated:true})));`);
  assert.equal((await runDocumentWorker(boundary, Buffer.alloc(10 * 1024 * 1024))).text.length, 200000);
  await rejects(runDocumentWorker(success, Buffer.alloc(10 * 1024 * 1024 + 1)), 'DOCUMENT_INPUT_LIMIT');
  await rejects(runDocumentWorker(success, 'not bytes'), 'DOCUMENT_INPUT');
  await rejects(runDocumentWorker(new URL('https://example.org/worker'), bytes), 'DOCUMENT_WORKER');
  const crash = await worker('crash', 'process.exit(7);');
  await rejects(runDocumentWorker(crash, bytes), 'DOCUMENT_WORKER');
  await rejects(runDocumentWorker(pathToFileURL(join(dir, 'missing.mjs')), bytes), 'DOCUMENT_WORKER');
  for (const [name, output] of Object.entries({ malformed: '{', wrong: '{"text":42,"truncated":false}', extra: '{"text":"ok","truncated":false,"other":1}', missing: '{"text":"ok"}', array: '[]' })) {
    await rejects(runDocumentWorker(await worker(name, `process.stdout.write(${JSON.stringify(output)});`), bytes), 'DOCUMENT_REPLY');
  }
  await rejects(runDocumentWorker(await worker('utf8', 'process.stdout.write(Buffer.from([255]));'), bytes), 'DOCUMENT_REPLY');
  await rejects(runDocumentWorker(await worker('text-limit', `process.stdout.write(JSON.stringify({text:'x'.repeat(200001),truncated:false}));`), bytes), 'DOCUMENT_OUTPUT_LIMIT');
  await rejects(runDocumentWorker(await worker('wire-limit', `process.stdout.write('x'.repeat(1300000)); setInterval(()=>{},1000);`), bytes), 'DOCUMENT_OUTPUT_LIMIT');
  // Slots remain reserved until close; a real successful run also checks reuse.
  await slotsFree(success);
  const pidFile = join(dir, 'pid');
  const hang = await worker('hang', `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); process.stdin.resume(); setInterval(()=>{},1000);`);
  const before = Date.now();
  await rejects(runDocumentWorker(hang, bytes), 'DOCUMENT_TIMEOUT');
  assert.ok(Date.now() - before >= 9500 && Date.now() - before < 15000, 'parent enforces fixed ten-second deadline');
  await slotsFree(success);
  const pid = Number(await readFile(pidFile, 'utf8'));
  await until(() => {
    try { process.kill(pid, 0); return false; }
    catch (error) { assert.equal(error.code, 'ESRCH'); return true; }
  });
  const already = new AbortController(); already.abort();
  await rejects(runDocumentWorker(hang, bytes, { signal: already.signal }), 'DOCUMENT_ABORTED');
  const a = new AbortController(), b = new AbortController();
  const first = rejects(runDocumentWorker(hang, bytes, { signal: a.signal }), 'DOCUMENT_ABORTED');
  const second = rejects(runDocumentWorker(hang, bytes, { signal: b.signal }), 'DOCUMENT_ABORTED');
  await rejects(runDocumentWorker(success, bytes), 'DOCUMENT_BUSY');
  a.abort(); b.abort();
  await Promise.all([first, second]);
  await slotsFree(success);
  const prior = process.env.DOCUMENT_TEST_SECRET;
  const options = process.env.NODE_OPTIONS;
  try {
    process.env.DOCUMENT_TEST_SECRET = 'must-not-leak';
    process.env.NODE_OPTIONS = '--definitely-invalid-node-option';
    const environment = await worker('environment', `process.stdout.write(JSON.stringify({text:JSON.stringify({env:process.env,args:process.execArgv}),truncated:false}));`);
    const inspected = JSON.parse((await runDocumentWorker(environment, bytes)).text);
    assert.ok(Object.entries(inspected.env).every(([key, value]) => /^(PATH|SYSTEMROOT|TEMP|TMP|TMPDIR)$/i.test(key) || (process.platform === 'win32' && /^(HOMEDRIVE|HOMEPATH|LOGONSERVER|SYSTEMDRIVE|USERDOMAIN|USERNAME|USERPROFILE|WINDIR)$/.test(key) && value === '')));
    assert.equal(inspected.env.DOCUMENT_TEST_SECRET, undefined);
    assert.equal(inspected.env.NODE_OPTIONS, undefined);
    assert.ok(inspected.args.includes('--max-old-space-size=256'));
  } finally {
    if (prior === undefined) delete process.env.DOCUMENT_TEST_SECRET; else process.env.DOCUMENT_TEST_SECRET = prior;
    if (options === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = options;
  }
  assert.deepEqual(await runDocumentWorker(success, bytes), { text: 'tiny document', truncated: false });
  console.log('document supervisor assertions passed');
} finally {
  // dir is the exact absolute directory returned by mkdtemp above.
  await rm(dir, { recursive: true, force: true });
}
