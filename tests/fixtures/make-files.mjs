// Real binary fixtures for the upload paths. Hand-built rather than checked in
// so the edge cases are explicit and adjustable: the .docx reader in
// src/lumen.jsx parses the ZIP container ITSELF (central directory, local
// headers, raw inflate) instead of using a library, so it has to be fed genuine
// bytes — including the malformed shapes a client will eventually attach.
import { deflateRawSync } from "node:zlib";

const enc = new TextEncoder();

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Minimal ZIP writer. `method` 0 = stored, 8 = deflate — both are legal in a
 * .docx and the reader handles them on separate branches, so both get tested.
 */
export function makeZip(entries, { method = 8, corruptEOCD = false } = {}) {
  const files = [], chunks = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const raw = typeof data === "string" ? enc.encode(data) : data;
    const body = method === 8 ? new Uint8Array(deflateRawSync(Buffer.from(raw))) : raw;
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true); dv.setUint16(6, 0, true); dv.setUint16(8, method, true);
    dv.setUint32(14, crc32(raw), true);
    dv.setUint32(18, body.length, true); dv.setUint32(22, raw.length, true);
    dv.setUint16(26, nameBytes.length, true); dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    files.push({ nameBytes, method, crc: crc32(raw), comp: body.length, uncomp: raw.length, offset });
    chunks.push(local, body);
    offset += local.length + body.length;
  }
  const cdStart = offset;
  for (const f of files) {
    const cd = new Uint8Array(46 + f.nameBytes.length);
    const dv = new DataView(cd.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true); dv.setUint16(6, 20, true); dv.setUint16(8, 0, true); dv.setUint16(10, f.method, true);
    dv.setUint32(16, f.crc, true); dv.setUint32(20, f.comp, true); dv.setUint32(24, f.uncomp, true);
    dv.setUint16(28, f.nameBytes.length, true); dv.setUint16(30, 0, true); dv.setUint16(32, 0, true);
    dv.setUint32(42, f.offset, true);
    cd.set(f.nameBytes, 46);
    chunks.push(cd);
    offset += cd.length;
  }
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, corruptEOCD ? 0xdeadbeef : 0x06054b50, true);
  edv.setUint16(8, files.length, true); edv.setUint16(10, files.length, true);
  edv.setUint32(12, offset - cdStart, true); edv.setUint32(16, cdStart, true);
  chunks.push(eocd);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

const DOC_XML = (paragraphs) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="x"><w:body>'
  + paragraphs.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join("")
  + "</w:body></w:document>";

export const docx = (paragraphs, opts) =>
  makeZip([{ name: "[Content_Types].xml", data: "<Types/>" },
           { name: "word/document.xml", data: DOC_XML(paragraphs) }], opts);

/** A .docx-shaped zip with no word/document.xml — e.g. a renamed .pptx. */
export const docxWithoutBody = () =>
  makeZip([{ name: "ppt/presentation.xml", data: "<p/>" }]);

/** Minimal File stand-in: extractFileText only touches these four members. */
export function asFile(name, type, bytes) {
  const u8 = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  return {
    name, type, size: u8.length,
    async arrayBuffer() { return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); },
    async text() { return new TextDecoder().decode(u8); },
  };
}
