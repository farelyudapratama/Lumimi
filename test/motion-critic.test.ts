import { describe, it, expect } from "bun:test";
import { critiqueMotionAsset, jerkSeries } from "../src/client/animation/motion-critic";

describe("motion-critic (backlog)", () => {
  it("critic turun setelah refine (skor lebih tinggi untuk asset halus)", () => {
    const smooth: any = {
      id: "smooth", duration: 1, tracks: [
        { target: "ax", keys: [{ t: 0, v: 0 }, { t: 0.5, v: 5 }, { t: 1, v: 0 }] },
      ],
    };
    const jerky: any = {
      id: "jerky", duration: 1, tracks: [
        { target: "ax", keys: [{ t: 0, v: 0 }, { t: 0.25, v: 30 }, { t: 0.5, v: -30 }, { t: 1, v: 0 }] },
      ],
    };
    const rs = critiqueMotionAsset(smooth, {});
    const rj = critiqueMotionAsset(jerky, { nativeJerkSamples: [1, 2, 3] });
    expect(rs.score).toBeGreaterThanOrEqual(rj.score);
  });
  it("end-stuck terdeteksi", () => {
    const asset: any = { id: "x", duration: 1, tracks: [{ target: "ay", keys: [{ t: 0, v: 0 }, { t: 1, v: 5 }] }] };
    const r = critiqueMotionAsset(asset, {});
    expect(r.findings.some((f) => f.kind === "endStuck")).toBe(true);
  });
  it("physicsOutput track error", () => {
    const asset: any = { id: "x", duration: 1, physicsOutputs: ["ax"], tracks: [{ target: "ax", keys: [{ t: 0, v: 0 }, { t: 1, v: 0 }] }] };
    const r = critiqueMotionAsset(asset, {});
    expect(r.findings.some((f) => f.kind === "physicsOutput")).toBe(true);
  });
  it("jerkSeries basic", () => {
    expect(jerkSeries([0, 1, 4, 9, 16], 0.25).length).toBe(3);
  });
});