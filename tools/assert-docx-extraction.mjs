import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractDocx } from '../lib/docx_extraction.js';

// Self-contained ZIP fixtures; actual yauzl and Mammoth are never mocked.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const spec of entries) {
    const name = Buffer.from(spec.name);
    const data = Buffer.from(spec.data ?? '');
    const method = spec.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const size = spec.size ?? data.length;
    const flags = spec.flags ?? 0x800;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(flags, 8); dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(size, 24); dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42); central.push(dir, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function parts(text = 'Hello DOCX') {
  return [
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: 'word/document.xml', data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>` },
  ];
}
const worker = fileURLToPath(new URL('../lib/docx_worker.js', import.meta.url));
function rejected(bytes, label) {
  const result = spawnSync(process.execPath, [worker], { input: bytes, timeout: 15000, maxBuffer: 2_000_000 });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, label);
  assert.equal(result.stdout.length, 0, `${label}: no partial stdout`);
}
rejected(Buffer.alloc(0), 'empty input');
rejected(Buffer.alloc(10 * 1024 * 1024 + 1), 'input limit');
await assert.rejects(extractDocx(Buffer.alloc(10 * 1024 * 1024 + 1)), { code: 'DOCUMENT_INPUT_LIMIT' });
const controller = new AbortController(); controller.abort();
await assert.rejects(extractDocx(Buffer.alloc(1), { signal: controller.signal }), { code: 'DOCUMENT_ABORTED' });
let available = true;
for (const dependency of ['yauzl', 'mammoth']) {
  try { await import(dependency); } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    available = false;
    console.log(`SKIP real DOCX parser fixtures: optional ${dependency} unavailable`);
  }
}
if (available) {
  assert.deepEqual(await extractDocx(zip(parts())), { text: 'Hello DOCX\n\n', truncated: false });
  assert.deepEqual(await extractDocx(zip(parts().map(part => ({ ...part, method: 8 })))), { text: 'Hello DOCX\n\n', truncated: false });
  const long = await extractDocx(zip(parts('x'.repeat(200001))));
  assert.equal(long.text.length, 200000); assert.equal(long.truncated, true);
  rejected(Buffer.from('not a ZIP'), 'malformed ZIP');
  rejected(zip(parts()).subarray(0, -5), 'truncated ZIP');
  const wrongLocalName = zip(parts()); wrongLocalName[30] = 0x58;
  rejected(wrongLocalName, 'local/central name mismatch');
  const wrongLocalSize = zip(parts()); wrongLocalSize.writeUInt32LE(1, 22);
  rejected(wrongLocalSize, 'local/central size mismatch');
  const wrongLocalMethod = zip(parts()); wrongLocalMethod.writeUInt16LE(8, 8);
  rejected(wrongLocalMethod, 'local/central compression mismatch');
  rejected(zip([...parts(), { name: 'word/document.xml/' }]), 'file/directory alias');
  rejected(zip(parts().slice(0, 1)), 'missing document');
  rejected(zip(parts().slice(1)), 'missing content types');
  rejected(zip([...parts(), parts()[1]]), 'duplicate name');
  rejected(zip([...parts(), { name: 'word/./document.xml' }]), 'dot alias');
  rejected(zip([...parts(), { name: '../outside' }]), 'traversal');
  rejected(zip([...parts(), { name: 'word\\document.xml' }]), 'backslash alias');
  rejected(zip([...parts(), { name: 'a\u0301' }, { name: '\u00e1' }]), 'Unicode normalized duplicate');
  rejected(zip([...parts(), { name: 'encrypted', flags: 0x801 }]), 'encryption');
  rejected(zip([...parts(), { name: 'unsupported', method: 12 }]), 'unsupported compression');
  rejected(zip([...parts(), ...Array.from({ length: 999 }, (_, i) => ({ name: `entry${i}` }))]), 'entry count');
  rejected(zip([...parts(), { name: 'bomb', data: 'x'.repeat(1000000), method: 8 }]), 'ratio bomb');
  rejected(zip([...parts(), { name: 'liar', data: 'x'.repeat(1000000), method: 8, size: 1 }]), 'false inflated size');
  rejected(zip([...parts(), { name: 'oversized', data: Buffer.alloc(8 * 1024 * 1024 + 1) }]), 'entry size');
  // Moderately compressible blocks keep each ratio under 100 and the archive
  // under 10 MiB, so this fixture exercises the actual total inflated limit.
  const block = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < block.length; i++) block[i] = (i * 31 + (i >>> 8)) % 251;
  const totalEntries = Array.from({ length: 33 }, (_, i) => ({ name: `bulk${i}`, data: block, method: 8 }));
  const compressedBlock = deflateRawSync(block);
  assert.ok(block.length <= compressedBlock.length * 100, 'total fixture must not hit ratio first');
  assert.ok(zip([...parts(), ...totalEntries]).length < 10 * 1024 * 1024);
  rejected(zip([...parts(), ...totalEntries]), 'total inflated size');
  console.log('PASS real yauzl/Mammoth DOCX fixtures, ZIP rejection and truncation');
}
console.log('PASS DOCX protocol/input/abort assertions');
