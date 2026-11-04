/**
 * pet/wav — encoder WAV PCM16 mono (murni, diuji bun test).
 *
 * Rekaman mic press-to-talk pet dikirim ke POST /api/stt (Content-Type
 * audio/wav — lib.rs). Chunks Float32 (−1..1) dari AudioWorklet
 * digabung, dikonversi Int16, dibungkus header RIFF 44 byte.
 */

/** Gabungkan chunks Float32 → satu Float32Array. */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Float32 (−1..1) → Int16 PCM (clamp, bukan modulo). */
export function floatToInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Encode WAV RIFF PCM16 mono. Uint8Array (bukan ArrayBuffer) supaya mudah
 * dikirim sebagai body fetch.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcm = floatToInt16(samples);
  const dataSize = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const wstr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  v.setUint32(16, 16, true); // ukuran chunk fmt
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate = rate × 1 ch × 2 byte
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  wstr(36, "data");
  v.setUint32(40, dataSize, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}
