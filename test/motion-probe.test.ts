import { describe, it, expect } from "bun:test";
import { bboxFromDiff, crossCheck } from "../src/client/animation/motion-probe";

describe("motion-probe (backlog)", () => {
  it("bboxFromDiff null when empty", () => {
    const arr = new Uint8ClampedArray(4);
    expect(bboxFromDiff(arr, 1, 1)).toBeNull();
  });
  it("bbox + cross-check conflict", () => {
    const arr = new Uint8ClampedArray(16);
    // mark a pixel far right (index 3 => x=3 in 4x1? actually 4x? use 4x1)
    arr[(0 * 4 + 3) * 4 + 3] = 255;
    const bb = bboxFromDiff(arr, 4, 1);
    expect(bb).not.toBeNull();
    const cm: any = { bbox: bb, changedPixels: 1, centroid: { x: 3, y: 0 }, diffRatio: 0.25 };
    const cc = crossCheck({ side: "karakter_kiri", region: "mata", confidence: 0.9 }, cm, 1, 3);
    expect(cc.conflict).toBe(true);
  });
});