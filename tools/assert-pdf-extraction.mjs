import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { extractPdf } from '../lib/pdf_extraction.js';

// Small genuine PDF with a byte-accurate xref, no external fixture dependency.
function pdf(pageTexts) {
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const text of pageTexts) {
    const page = objects.length;
    kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`);
    const escaped = text.replace(/[\\()]/g, '\\$&');
    // Tiny font keeps the long cap fixture inside the page's visible bounds.
    const stream = `BT /F1 0.001 Tf 10 700 Td (${escaped}) Tj 0 -12 Td (Second line) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(' ')}] >>`;
  let body = '%PDF-1.7\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(body));
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body));
}

await assert.rejects(extractPdf('not bytes'), { code: 'DOCUMENT_INPUT' });
await assert.rejects(extractPdf(new Uint8Array(10 * 1024 * 1024 + 1)), { code: 'DOCUMENT_INPUT_LIMIT' });
await assert.rejects(extractPdf(pdf(['aborted']), { signal: AbortSignal.abort() }), { code: 'DOCUMENT_ABORTED' });
console.log('PDF input limit/type and preabort assertions passed');

const [major, minor] = process.versions.node.split('.').map(Number);
const supported = (major === 20 && minor >= 16) || (major === 22 && minor >= 3) || major > 22;
let installed = false;
try { createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs'); installed = true; }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
if (!supported || !installed) {
  await assert.rejects(extractPdf(pdf(['unavailable'])), { code: 'DOCUMENT_WORKER' });
  console.log(`SKIP real PDF extraction: ${!supported ? 'unsupported Node runtime' : 'optional pdfjs-dist is absent'}; graceful rejection verified`);
} else {
  // Supervisor's strict JSON parser also verifies warnings never pollute stdout.
  const result = await extractPdf(pdf(['Hello PDF']));
  assert.match(result.text, /Hello PDF/);
  assert.match(result.text, /Hello PDF[^\n]*\n[^\n]*Second line/);
  assert.equal(result.truncated, false);
  await assert.rejects(extractPdf(new Uint8Array(Buffer.from('%PDF-1.7\nnot a PDF'))), { code: 'DOCUMENT_WORKER' });
  const pages = await extractPdf(pdf(Array.from({ length: 101 }, (_, i) => `PAGE_${i + 1}_END`)));
  assert.equal(pages.truncated, true);
  assert.match(pages.text, /PAGE_100_END/);
  assert.doesNotMatch(pages.text, /PAGE_101_END/);
  const capped = await extractPdf(pdf(['A'.repeat(210_000)]));
  assert.equal(capped.text.length, 200_000);
  assert.equal(capped.truncated, true);
  console.log('Real PDF valid/malformed, newline, 100-page and 200000-character caps passed (strict stdout JSON)');
}
