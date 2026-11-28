import { runDocumentWorker } from './document_supervisor.js';

/** Extract plain text in the trusted, bounded Node child (no MCP or Python). */
export function extractPdf(bytes, { signal } = {}) {
  return runDocumentWorker(new URL('./pdf_worker.js', import.meta.url), bytes, { signal });
}
