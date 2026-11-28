import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_INPUT = 10 * 1024 * 1024;
const MAX_TEXT = 200_000;
// JSON may encode each UTF-16 code unit as six ASCII bytes.
const MAX_WIRE = MAX_TEXT * 6 + 128;
const TIMEOUT_MS = 10_000;
let active = 0;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function workerEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|SYSTEMROOT|TEMP|TMP|TMPDIR)$/i.test(key)) {
      const canonical = key.toUpperCase();
      if (!(canonical in env)) env[canonical] = value;
    }
  }
  // libuv injects these Windows variables from the parent when omitted.
  // Explicit empty values prevent that otherwise implicit inheritance.
  if (process.platform === 'win32') {
    for (const key of ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']) env[key] = '';
  }
  return env;
}

/**
 * Run a trusted application worker, never a URL/path supplied by a document.
 * The worker reads raw bytes through stdin until EOF and writes one UTF-8 JSON
 * object { text: string, truncated: boolean } to stdout, then exits with code 0.
 * No metadata, executable arguments, or environment overrides come from input.
 *
 * At most two workers run per module instance; excess requests reject with
 * DOCUMENT_BUSY for the caller's explicit fallback (there is no waiting queue).
 * The 256 MiB V8 old-space cap is NOT a hard RSS limit or an OS sandbox. Workers
 * retain the parent's filesystem/network privileges; only trusted code belongs
 * here. Native allocations and young-generation memory are outside that cap.
 */
export async function runDocumentWorker(workerUrl, bytes, { signal } = {}) {
  const started = performance.now();
  if (!(workerUrl instanceof URL) || workerUrl.protocol !== 'file:' || workerUrl.search || workerUrl.hash) {
    throw failure('DOCUMENT_WORKER', 'Worker must be a trusted application file URL');
  }
  const workerPath = fileURLToPath(workerUrl);
  if (!(bytes instanceof Uint8Array)) throw failure('DOCUMENT_INPUT', 'Document input must be bytes');
  if (bytes.byteLength > MAX_INPUT) throw failure('DOCUMENT_INPUT_LIMIT', 'Document exceeds 10 MiB');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure('DOCUMENT_SIGNAL', 'Invalid AbortSignal');
  if (signal?.aborted) throw failure('DOCUMENT_ABORTED', 'Document extraction aborted');
  if (active >= 2) throw failure('DOCUMENT_BUSY', 'Document workers busy; use fallback');
  active++;

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let released = false;
    let size = 0;
    const chunks = [];
    const release = () => {
      if (!released) { released = true; active--; }
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      chunks.length = 0;
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      // Keep the slot reserved until close confirms the process has exited.
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* error/close handlers remain installed */ }
      }
      if (!child) release();
      if (error) reject(error); else resolve(result);
    };
    const onAbort = () => finish(failure('DOCUMENT_ABORTED', 'Document extraction aborted'));
    // Armed before spawn: launch and stdin transfer count toward the deadline.
    const timer = setTimeout(() => finish(failure('DOCUMENT_TIMEOUT', 'Document worker exceeded 10 seconds')), Math.max(0, TIMEOUT_MS - (performance.now() - started)));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      child = spawn(process.execPath, ['--max-old-space-size=256', '--', workerPath], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: workerEnvironment(),
      });
      child.on('error', () => finish(failure('DOCUMENT_WORKER', 'Document worker failed to launch or run')));
      child.stdin.on('error', () => finish(failure('DOCUMENT_WORKER', 'Document worker input failed')));
      child.stdout.on('error', () => finish(failure('DOCUMENT_WORKER', 'Document worker output failed')));
      child.stdout.on('data', chunk => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_WIRE) {
          finish(failure('DOCUMENT_OUTPUT_LIMIT', 'Document worker reply exceeds byte limit'));
        } else chunks.push(chunk);
      });
      child.on('exit', (code, exitSignal) => {
        if (code !== 0 || exitSignal) finish(failure('DOCUMENT_WORKER', 'Document worker crashed'));
      });
      child.on('close', code => {
        release();
        if (settled) return;
        if (code !== 0) return finish(failure('DOCUMENT_WORKER', 'Document worker failed'));
        try {
          const reply = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
          if (!reply || typeof reply !== 'object' || Array.isArray(reply)
            || Object.keys(reply).length !== 2 || typeof reply.text !== 'string'
            || typeof reply.truncated !== 'boolean') {
            return finish(failure('DOCUMENT_REPLY', 'Invalid document worker reply'));
          }
          if (reply.text.length > MAX_TEXT) return finish(failure('DOCUMENT_OUTPUT_LIMIT', 'Document text exceeds 200000 characters'));
          finish(null, { text: reply.text, truncated: reply.truncated });
        } catch {
          finish(failure('DOCUMENT_REPLY', 'Invalid document worker reply'));
        }
      });
      if (signal?.aborted) onAbort();
      if (performance.now() - started >= TIMEOUT_MS) finish(failure('DOCUMENT_TIMEOUT', 'Document worker exceeded 10 seconds'));
      if (!settled) child.stdin.end(bytes);
    } catch {
      finish(failure('DOCUMENT_WORKER', 'Document worker failed to launch or run'));
    }
  });
}
