// Trusted stdin/stdout child; optional PDF.js is never imported by the host.
// API verified against pdfjs-dist@5.4.624/types/src/display/api.d.ts.
const MAX_INPUT = 10 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_TEXT = 200_000;

// PDF.js can warn during import, before getDocument's verbosity takes effect.
// Keep all console diagnostics off the stdout protocol, including import errors.
console.log = console.info = console.warn = console.debug = console.error = () => {};

function supportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return (major === 20 && minor >= 16) || (major === 22 && minor >= 3) || major > 22;
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT) throw new Error('PDF input limit');
    chunks.push(chunk);
  }
  if (!size) throw new Error('Empty PDF');
  // PDF.js explicitly rejects Node Buffers: copy into a plain Uint8Array.
  return new Uint8Array(Buffer.concat(chunks, size));
}

// No auxiliary URLs or filesystem assets are accepted from document content.
class NoExternalData {
  async fetch() { throw new Error('External PDF resources disabled'); }
}

let task;
try {
  if (!supportedNode()) throw new Error('Unsupported PDF runtime');
  const data = await readInput();
  // Canvas supplies DOMMatrix at import time; never enumerate system/user fonts.
  // Its default font scan also requires a home directory absent in our child env.
  process.env.DISABLE_SYSTEM_FONTS_LOAD = '1';
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (pdfjs.version !== '5.4.624') throw new Error('Unsupported PDF.js version');
  task = pdfjs.getDocument({
    data,
    verbosity: 0,
    isEvalSupported: false,
    enableXfa: false,
    useWorkerFetch: false,
    useWasm: false,
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    CMapReaderFactory: NoExternalData,
    StandardFontDataFactory: NoExternalData,
    WasmFactory: NoExternalData,
  });
  let result;
  try {
    const document = await task.promise;
    let text = '';
    let truncated = document.numPages > MAX_PAGES;
    const append = value => {
      const remaining = MAX_TEXT - text.length;
      text += value.slice(0, remaining);
      if (value.length > remaining) truncated = true;
    };
    const pages = Math.min(document.numPages, MAX_PAGES);
    for (let number = 1; number <= pages; number++) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        for (let index = 0; index < content.items.length; index++) {
          const item = content.items[index];
          if (typeof item.str !== 'string') continue;
          append(item.str + (item.hasEOL ? '\n' : ' '));
          if (text.length === MAX_TEXT) {
            if (index + 1 < content.items.length || number < document.numPages) truncated = true;
            break;
          }
        }
        if (text.length === MAX_TEXT) break;
        if (number < pages) append('\n');
      } finally {
        page.cleanup();
      }
    }
    result = { text, truncated };
  } finally {
    await task.destroy();
  }
  process.stdout.write(JSON.stringify(result));
} catch {
  // Missing runtime/dependency, malformed or protected PDFs all reject cleanly.
  // No partial text or document-controlled diagnostics cross the protocol.
  process.exitCode = 1;
  process.stdin.destroy();
}
