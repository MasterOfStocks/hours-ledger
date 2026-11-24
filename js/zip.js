// zip.js — a small ZIP writer and reader, so a backup is one ordinary .zip
// whose evidence files open in any file manager. Files are stored uncompressed
// (photos and screenshots are already compressed) and never all held in memory at once.

const enc = new TextEncoder();
const dec = new TextDecoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// files: [{ name, data: string | Uint8Array | ArrayBuffer | Blob }]
export async function makeZip(files, when = new Date()) {
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime(when);
  for (const f of files) {
    const blob = f.data instanceof Blob ? f.data : new Blob([typeof f.data === 'string' ? enc.encode(f.data) : f.data]);
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
    const name = enc.encode(f.name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, blob.size, true);
    local.setUint32(22, blob.size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, blob);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, blob.size, true);
    cd.setUint32(24, blob.size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd.buffer, name);
    offset += 30 + name.length + blob.size;
  }
  const cdSize = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// Returns [{ name, size, blob(): Promise<Blob> }]
export async function readZip(file) {
  const tailLen = Math.min(file.size, 65557);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let p = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { p = i; break; }
  if (p < 0) throw new Error('This file is not a ZIP archive.');
  const count = tail.getUint16(p + 10, true);
  const cdSize = tail.getUint32(p + 12, true);
  const cdOffset = tail.getUint32(p + 16, true);
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const out = [];
  let q = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(q, true) !== 0x02014b50) throw new Error('The ZIP directory is damaged.');
    const method = cd.getUint16(q + 10, true);
    const csize = cd.getUint32(q + 20, true);
    const usize = cd.getUint32(q + 24, true);
    const nameLen = cd.getUint16(q + 28, true);
    const extraLen = cd.getUint16(q + 30, true);
    const commentLen = cd.getUint16(q + 32, true);
    const localOffset = cd.getUint32(q + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, q + 46, nameLen));
    q += 46 + nameLen + extraLen + commentLen;
    out.push({
      name,
      size: usize,
      async blob() {
        const lh = new DataView(await file.slice(localOffset, localOffset + 30).arrayBuffer());
        const start = localOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        const raw = file.slice(start, start + csize);
        if (method === 0) return raw;
        if (method === 8 && typeof DecompressionStream !== 'undefined') {
          return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
        }
        throw new Error(`"${name}" uses a compression method this app cannot read.`);
      },
    });
  }
  return out;
}
