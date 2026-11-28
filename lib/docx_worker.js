// Trusted stdin/stdout worker. Optional dependencies are loaded only in this child.
// APIs: yauzl 3.4.0 README (fromBufferPromise/eachEntry/openReadStreamPromise),
// mammoth 1.13.0 README (extractRawText({buffer})). No HTML conversion or paths.
const MAX_INPUT = 10 * 1024 * 1024;
const MAX_ENTRY = 8 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_TEXT = 200_000;

function invalid() { throw new Error('Invalid or oversized DOCX'); }

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT) invalid();
    chunks.push(chunk);
  }
  if (!size) invalid();
  return Buffer.concat(chunks, size);
}

function safeName(name) {
  // Reject ambiguous names rather than allowing the two ZIP parsers to resolve
  // dot segments, separators or Unicode aliases differently.
  if (!name || /[\\\x00-\x1f\x7f:]/u.test(name) || name.startsWith('/')) invalid();
  const parts = name.replace(/\/$/u, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) invalid();
  return parts.join('/').normalize('NFC');
}

async function validateZip(buffer, yauzl) {
  const zip = await yauzl.fromBufferPromise(buffer, {
    lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true,
  });
  const names = new Set();
  let count = 0;
  let total = 0;
  try {
    if (zip.entryCount > 1000) invalid();
    for await (const entry of zip.eachEntry()) {
      if (++count > 1000) invalid();
      const name = safeName(entry.fileName);
      if (names.has(name)) invalid();
      names.add(name);
      if ((entry.generalPurposeBitFlag & 0x41) !== 0
        || ![0, 8].includes(entry.compressionMethod)) invalid();
      if (!Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0
        || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
        || entry.uncompressedSize > MAX_ENTRY
        || entry.uncompressedSize > entry.compressedSize * 100) invalid();
      // Mammoth reparses the original buffer with a different ZIP library.
      // Reject conflicting local metadata instead of relying on both parsers
      // choosing the central directory for every redundant field.
      const local = await zip.readLocalFileHeaderPromise(entry);
      if (!local.fileName.equals(entry.fileNameRaw)
        || local.generalPurposeBitFlag !== entry.generalPurposeBitFlag
        || local.compressionMethod !== entry.compressionMethod) invalid();
      // With a data descriptor the local sizes/CRC may legitimately be zero.
      if (!(entry.generalPurposeBitFlag & 8)
        && (local.compressedSize !== entry.compressedSize
          || local.uncompressedSize !== entry.uncompressedSize
          || local.crc32 !== entry.crc32)) invalid();
      // Inflate every entry, including directories and unused media, before
      // Mammoth sees any bytes. Metadata checks alone cannot bound a ZIP bomb.
      const stream = await zip.openReadStreamPromise(entry);
      let actual = 0;
      for await (const chunk of stream) {
        actual += chunk.length;
        total += chunk.length;
        if (actual > MAX_ENTRY || total > MAX_TOTAL
          || actual > entry.compressedSize * 100) invalid();
      }
      if (actual !== entry.uncompressedSize) invalid();
      if (entry.fileName.endsWith('/') && actual !== 0) invalid();
    }
    if (count !== zip.entryCount || !names.has('[Content_Types].xml')
      || !names.has('word/document.xml')) invalid();
  } finally {
    zip.close();
  }
}

try {
  const buffer = await readInput();
  const yauzl = (await import('yauzl')).default;
  await validateZip(buffer, yauzl);
  const mammoth = (await import('mammoth')).default;
  // extractRawText has no options argument. External access is disabled by
  // Mammoth's default and no path, HTML/image converter or transform is passed.
  const result = await mammoth.extractRawText({ buffer });
  if (typeof result.value !== 'string') invalid();
  process.stdout.write(JSON.stringify({
    text: result.value.slice(0, MAX_TEXT), truncated: result.value.length > MAX_TEXT,
  }));
} catch {
  // No document content, diagnostics or partial JSON crosses the protocol.
  process.exitCode = 1;
  process.stdin.destroy();
}
