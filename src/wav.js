// 16-bit stereo PCM WAV from two float channels (-1..1). Used by tools/render.mjs and the editor's export.
export function encodeWav(L, R, sampleRate) {
  const n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 4, true);
  const pcm = (x) => Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  for (let i = 0, o = 44; i < n; i++, o += 4) { v.setInt16(o, pcm(L[i]), true); v.setInt16(o + 2, pcm(R[i]), true); }
  return buf;
}
