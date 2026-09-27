// 16-bit PCM WAV from float channels (-1..1): stereo from L and R, mono without R. Used by tools/render.mjs,
// the editor's export and tools/samples.mjs.
export function encodeWav(L, R, sampleRate) {
  const ch = R ? 2 : 1, n = L.length, bytes = n * 2 * ch, buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2 * ch, true); v.setUint16(32, 2 * ch, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, bytes, true);
  const pcm = (x) => Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  for (let i = 0, o = 44; i < n; i++) {
    v.setInt16(o, pcm(L[i]), true); o += 2;
    if (R) { v.setInt16(o, pcm(R[i]), true); o += 2; }
  }
  return buf;
}

// A 16-bit PCM WAV (as written above) → { data: Float32Array (channels mixed to mono), rate }.
// Plain parsing, so node, the AudioWorklet host and a C# port read the sample library the same way.
export function decodeWav(arrayBuffer) {
  const v = new DataView(arrayBuffer), tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let ch = 1, rate = 44100, bits = 16, o = 12;
  while (o + 8 <= v.byteLength) {
    const id = tag(o), size = v.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') { ch = v.getUint16(body + 2, true); rate = v.getUint32(body + 4, true); bits = v.getUint16(body + 14, true); }
    else if (id === 'data') {
      if (bits !== 16) throw new Error(`only 16-bit WAV files are supported (this one is ${bits}-bit)`);
      const n = Math.floor(size / (2 * ch)), data = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < ch; c++) s += v.getInt16(body + (i * ch + c) * 2, true);
        data[i] = s / (ch * 32768);
      }
      return { data, rate };
    }
    o = body + size + (size & 1);
  }
  throw new Error('WAV file without data');
}
