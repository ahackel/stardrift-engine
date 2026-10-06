// Zip files, plain: what a song ships in (bundle.js). zip() stores its files as they are (recordings hardly shrink, and
// any browser, Safari 15 too, reads them back without help); unzip() reads those, and deflated files where the browser
// can inflate them (DecompressionStream: a zip made again by hand, from the unzipped folder).
//   zip([{ name, data: Uint8Array | string }]) → Uint8Array
//   unzip(ArrayBuffer | Uint8Array) → { names, has(name), read(name) → Promise<Uint8Array> }

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files, date = new Date()) {
  const utf8 = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const items = files.map(({ name, data }) => {
    const bytes = typeof data === 'string' ? utf8.encode(data) : data;
    return { name: utf8.encode(name), bytes, crc: crc32(bytes) };
  });
  const size = items.reduce((n, f) => n + 30 + f.name.length + f.bytes.length + 46 + f.name.length, 22);
  const out = new Uint8Array(size), v = new DataView(out.buffer);
  let o = 0;
  // a header: [signature, then the fields both headers share]; the central one adds its own
  const common = (f) => {
    v.setUint16(o, 20, true); v.setUint16(o + 2, 0x800, true); v.setUint16(o + 4, 0, true); // needs 2.0, UTF-8 names, stored
    v.setUint16(o + 6, time, true); v.setUint16(o + 8, day, true);
    v.setUint32(o + 10, f.crc, true); v.setUint32(o + 14, f.bytes.length, true); v.setUint32(o + 18, f.bytes.length, true);
    v.setUint16(o + 22, f.name.length, true); v.setUint16(o + 24, 0, true); // (no extra field)
    o += 26;
  };
  for (const f of items) {
    f.at = o;
    v.setUint32(o, 0x04034b50, true); o += 4;
    common(f);
    out.set(f.name, o); o += f.name.length;
    out.set(f.bytes, o); o += f.bytes.length;
  }
  const dir = o;
  for (const f of items) {
    v.setUint32(o, 0x02014b50, true); v.setUint16(o + 4, 20, true); o += 6; // (made by 2.0)
    common(f);
    v.setUint16(o, 0, true); v.setUint16(o + 2, 0, true); v.setUint16(o + 4, 0, true); v.setUint32(o + 6, 0, true); // comment, disk, attributes
    v.setUint32(o + 10, f.at, true); o += 14;
    out.set(f.name, o); o += f.name.length;
  }
  v.setUint32(o, 0x06054b50, true); v.setUint16(o + 4, 0, true); v.setUint16(o + 6, 0, true);
  v.setUint16(o + 8, items.length, true); v.setUint16(o + 10, items.length, true);
  v.setUint32(o + 12, o - dir, true); v.setUint32(o + 16, dir, true); v.setUint16(o + 20, 0, true);
  return out;
}

export const isZip = (buf) => { const b = new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, 4); return b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4; };

export function unzip(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf), v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22; // the directory's end record: at the end, before a comment of up to 64 KB
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || end < bytes.length - 22 - 0xffff) throw new Error('not a zip file');
  const entries = new Map(), utf8 = new TextDecoder();
  for (let i = 0, o = v.getUint32(end + 16, true), n = v.getUint16(end + 10, true); i < n; i++) {
    if (v.getUint32(o, true) !== 0x02014b50) throw new Error('a broken zip file');
    const method = v.getUint16(o + 10, true), size = v.getUint32(o + 20, true), nameLen = v.getUint16(o + 28, true);
    const at = v.getUint32(o + 42, true), name = utf8.decode(bytes.subarray(o + 46, o + 46 + nameLen));
    if (size === 0xffffffff || at === 0xffffffff) throw new Error('zip64 files are not supported');
    const data = at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true); // (past the local header: its own name and extra field)
    if (!name.endsWith('/')) entries.set(name, { method, bytes: bytes.subarray(data, data + size) });
    o += 46 + nameLen + v.getUint16(o + 30, true) + v.getUint16(o + 32, true);
  }
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    async read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`${name} is not in the zip`);
      if (e.method === 0) return e.bytes;
      if (e.method !== 8) throw new Error(`${name}: compression method ${e.method} is not supported`);
      if (typeof DecompressionStream !== 'function') throw new Error(`${name} is compressed, which this browser can't unpack: zip it without compression (store)`);
      return new Uint8Array(await new Response(new Blob([e.bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    },
  };
}
