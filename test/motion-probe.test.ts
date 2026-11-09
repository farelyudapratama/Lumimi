import { describe, it, expect } from "bun:test";
import {
  bboxFromDiff,
  classifyDeadWithFloor,
  crossCheck,
  meanAbsDiff,
  signatureFromImageData,
} from "../src/client/animation/motion-probe";

/** ImageData palsu (bun tanpa DOM) — signatureFromImageData hanya butuh
 *  width/height/data RGBA. */
function mkImg(w: number, h: number, px: number[]): ImageData {
  return { width: w, height: h, data: new Uint8ClampedArray(px) } as unknown as ImageData;
}

describe("motion-probe (backlog)", () => {
  it("bboxFromDiff null when empty", () => {
    const arr = new Uint8ClampedArray(4);
    expect(bboxFromDiff(arr, 1, 1)).toBeNull();
  });

  it("classifyDeadWithFloor: sweep harus melampaui k× noise floor", () => {
    // Tanpa noise: ambang dasar 8 tetap berlaku.
    expect(classifyDeadWithFloor(5, 0)).toBe(true);
    expect(classifyDeadWithFloor(9, 0)).toBe(false);
    // Noise floor dominan: sway sisa 10 piksel → butuh > 3×10.
    expect(classifyDeadWithFloor(20, 10)).toBe(true);
    expect(classifyDeadWithFloor(31, 10)).toBe(false);
    // Floor negatif diperlakukan sebagai 0 (bukan ambang aneh).
    expect(classifyDeadWithFloor(9, -5)).toBe(false);
  });

  it("signature + meanAbsDiff: frame tenang vs bergerak", () => {
    const a = mkImg(2, 1, [0, 0, 0, 255, 10, 10, 10, 255]);
    const tenang = mkImg(2, 1, [1, 0, 0, 255, 10, 11, 9, 255]);
    const gerak = mkImg(2, 1, [200, 200, 200, 255, 10, 10, 10, 255]);
    const sa = signatureFromImageData(a);
    expect(meanAbsDiff(sa, signatureFromImageData(tenang))).toBeLessThan(1);
    expect(meanAbsDiff(sa, signatureFromImageData(gerak))).toBeGreaterThan(50);
    // Panjang beda / kosong → dianggap beda total (belum konvergen).
    expect(meanAbsDiff(sa, new Uint8Array(0))).toBe(255);
    expect(meanAbsDiff(sa, new Uint8Array(sa.length + 1))).toBe(255);
  });

  it("crossCheck: bbox kosong + klaim region → konflik; tidak_terlihat bukan klaim", () => {
    const m = { bbox: null, changedPixels: 0, centroid: null, diffRatio: 0 };
    expect(crossCheck({ region: "mata", confidence: 0.9 }, m).conflict).toBe(true);
    expect(crossCheck({ region: "tidak_terlihat", confidence: 0.9 }, m).conflict).toBe(false);
  });

  it("crossCheck: region vs pita vertikal konten", () => {
    const content = { x: 0, y: 0, w: 100, h: 200 };
    // Klaim "badan" tapi pusat perubahan di 5% tinggi konten → konflik.
    const atas = { bbox: { x: 40, y: 8, w: 20, h: 10 }, changedPixels: 50, centroid: { x: 50, y: 10 }, diffRatio: 0.01 };
    const cc1 = crossCheck({ region: "badan", confidence: 0.8 }, atas, content);
    expect(cc1.conflict).toBe(true);
    expect(cc1.reasons.some((s) => s.includes("badan"))).toBe(true);
    expect(cc1.confidence).toBeLessThan(0.8); // konflik menurunkan confidence
    // Klaim "mata" dengan pusat di 25% tinggi → konsisten, confidence utuh.
    const mata = { bbox: { x: 40, y: 48, w: 20, h: 10 }, changedPixels: 50, centroid: { x: 50, y: 50 }, diffRatio: 0.01 };
    const cc2 = crossCheck({ region: "mata", confidence: 0.8 }, mata, content);
    expect(cc2.conflict).toBe(false);
    expect(cc2.confidence).toBe(0.8);
    // Region tanpa pita (mis. "lainnya") → tidak dicek vertikal.
    const cc3 = crossCheck({ region: "lainnya", confidence: 0.8 }, atas, content);
    expect(cc3.conflict).toBe(false);
  });

  it("crossCheck: side layar vs garis tengah konten; karakter_* tidak dicek", () => {
    const content = { x: 0, y: 0, w: 100, h: 200 };
    const kiri = { bbox: { x: 5, y: 150, w: 10, h: 10 }, changedPixels: 30, centroid: { x: 10, y: 155 }, diffRatio: 0.01 };
    // Klaim layar_kanan tapi centroid di kiri tengah → konflik.
    expect(crossCheck({ region: "tangan", side: "layar_kanan", confidence: 0.9 }, kiri, content).conflict).toBe(true);
    // Klaim layar_kiri cocok centroid kiri → konsisten.
    expect(crossCheck({ region: "tangan", side: "layar_kiri", confidence: 0.9 }, kiri, content).conflict).toBe(false);
    // Side karakter_* butuh info arah hadap model — tidak dicek (bukan konflik).
    expect(crossCheck({ region: "tangan", side: "karakter_kiri", confidence: 0.9 }, kiri, content).conflict).toBe(false);
    // Tanpa content bbox → cek side/region-band dilewati (bukan konflik palsu).
    expect(crossCheck({ region: "tangan", side: "layar_kanan", confidence: 0.9 }, kiri).conflict).toBe(false);
  });
});
