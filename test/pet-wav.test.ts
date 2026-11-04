/**
 * Unit test encoder WAV pet (src/client/pet/wav.ts) — murni bit-level.
 */
import { describe, expect, it } from "bun:test";
import { concatFloat32, encodeWav, floatToInt16 } from "../src/client/pet/wav";

describe("pet wav — encoder PCM16 mono", () => {
  it("header RIFF valid: 44 byte + data PCM16", () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5]), 16000);
    expect(wav.length).toBe(44 + 6);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(new TextDecoder().decode(wav.slice(12, 16))).toBe("fmt ");
    expect(new DataView(wav.buffer).getUint16(20, true)).toBe(1); // PCM
    expect(new DataView(wav.buffer).getUint16(22, true)).toBe(1); // mono
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16000);
    expect(new DataView(wav.buffer).getUint32(28, true)).toBe(32000); // byte rate
    expect(new TextDecoder().decode(wav.slice(36, 40))).toBe("data");
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(6); // 3 sampel × 2
  });

  it("konversi amplitudo: 1.0 → 32767, −1.0 → −32768, 0 → 0", () => {
    const i = floatToInt16(new Float32Array([1, -1, 0]));
    expect(i[0]).toBe(32767);
    expect(i[1]).toBe(-32768);
    expect(i[2]).toBe(0);
  });

  it("clamp (bukan wrap): 1.5 tetap 32767, −2 tetap −32768", () => {
    const i = floatToInt16(new Float32Array([1.5, -2]));
    expect(i[0]).toBe(32767);
    expect(i[1]).toBe(-32768);
  });

  it("concatFloat32: urutan chunk terjaga", () => {
    const out = concatFloat32([new Float32Array([1]), new Float32Array([2, 3])]);
    expect([...out]).toEqual([1, 2, 3]);
  });

  it("siklus: encode → decode data kembali sesuai amplitudo (0.5 → ~16384)", () => {
    const wav = encodeWav(new Float32Array([0.5, -0.5]), 16000);
    const pcm = new Int16Array(wav.buffer, 44);
    expect(Math.abs(pcm[0] - 16384)).toBeLessThanOrEqual(1);
    expect(Math.abs(pcm[1] + 16384)).toBeLessThanOrEqual(1);
  });

  it("sampel kosong → header saja, tidak crash", () => {
    const wav = encodeWav(new Float32Array([]), 16000);
    expect(wav.length).toBe(44);
  });
});
