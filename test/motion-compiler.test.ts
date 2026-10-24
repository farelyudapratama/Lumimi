import { describe, it, expect } from "bun:test";
import { compileMotion, compileBeatToValue } from "../src/client/animation/motion-compiler";

describe("motion-compiler (backlog)", () => {
  it("loop closure + returnToDefault", () => {
    const asset: any = compileMotion([{ beatId: "b1", role: "ax", start: 0, duration: 0.5, intensity: 0.8, sign: 1 }], {}, null);
    expect(asset.tracks.length).toBe(1);
    const tr = asset.tracks[0];
    expect(tr.keys[0].v).toBe(tr.keys[tr.keys.length - 1].v);
  });
  it("holdEnd menyimpan pose akhir", () => {
    const asset: any = compileMotion([{ beatId: "b2", role: "ay", start: 0, duration: 0.5, intensity: 1, holdEnd: true }], {}, null);
    const tr = asset.tracks[0];
    // loop closure tetap menutup, tapi holdEnd tercatat
    expect(asset.holdEnd).toBe(true);
    expect(tr.keys.length).toBeGreaterThan(1);
  });
  it("physics output di-skip", () => {
    const rig: any = { params: { ax: { min: -30, max: 30, base: 0 } }, physicsOutputs: ["ax"] };
    const asset: any = compileMotion([{ beatId: "b3", role: "ax", start: 0, duration: 0.5, intensity: 0.5 }], {}, rig);
    expect(asset.tracks.length).toBe(0);
  });
  it("beatId tersemat", () => {
    const asset: any = compileMotion([{ beatId: "zz", role: "smileL", start: 0, duration: 0.3, intensity: 0.5 }], {}, null);
    expect(asset.beatIds).toContain("zz");
    expect(asset.tracks[0].beatId).toContain("zz");
  });
  it("compileBeatToValue clamp safe range", () => {
    const v = compileBeatToValue({ beatId: "x", role: "ax", intensity: 10, sign: 1, safeRange: [-5, 5] }, null, {});
    expect(Math.abs(v)).toBeLessThanOrEqual(5);
  });

  // ── Beat kind param (paramId hasil approve user — Fase 3 jalur B) ──
  it("beat param → track kind:param dengan clamp safeRange approve", () => {
    const asset: any = compileMotion(
      [{ beatId: "p1", role: "", param: "ParamHairSway", start: 0, duration: 0.5, intensity: 1, sign: 1, safeRange: [-15, 15] }],
      {},
      null,
    );
    expect(asset.tracks.length).toBe(1);
    const tr = asset.tracks[0];
    expect(tr.kind).toBe("param");
    expect(tr.param).toBe("ParamHairSway");
    expect(tr.target).toBe("ParamHairSway");
    expect(tr.min).toBe(-15);
    expect(tr.max).toBe(15);
    // amplitude = setengah safeRange; midpoint = 0 → puncak +15
    const peak = Math.max(...tr.keys.map((k: any) => k.v));
    expect(peak).toBeCloseTo(15, 5);
  });

  it("beat param: loop closure tetap (nilai akhir == awal)", () => {
    const asset: any = compileMotion(
      [{ beatId: "p2", role: "", param: "ParamEar", start: 0, duration: 0.4, intensity: 0.7, sign: -1, safeRange: [0, 2] }],
      {},
      null,
    );
    const tr = asset.tracks[0];
    expect(tr.keys[0].v).toBe(tr.keys[tr.keys.length - 1].v);
    // base = midpoint safeRange = 1; keyframe pertama & terakhir di base
    expect(tr.keys[0].v).toBeCloseTo(1, 5);
  });

  it("beat param physics output di-skip (gerakkan penyebabnya)", () => {
    const rig: any = { params: {}, physicsParamIds: ["ParamHairPhys"] };
    const asset: any = compileMotion(
      [{ beatId: "p3", role: "", param: "ParamHairPhys", start: 0, duration: 0.5, intensity: 1 }],
      {},
      rig,
    );
    expect(asset.tracks.length).toBe(0);
  });

  it("beat param tanpa safeRange → fallback statistik paramsById", () => {
    const rig: any = { params: {}, paramsById: { ParamTail: { min: -10, max: 30, base: 5 } } };
    const asset: any = compileMotion(
      [{ beatId: "p4", role: "", param: "ParamTail", start: 0, duration: 0.5, intensity: 1, sign: 1 }],
      {},
      rig,
    );
    const tr = asset.tracks[0];
    // amp = 0.3 * |30-(-10)| = 12; base = 5 → puncak 17, clamp max 30 tak kena
    const peak = Math.max(...tr.keys.map((k: any) => k.v));
    expect(peak).toBeCloseTo(17, 5);
  });

  it("beat param di luar ownedParams di-skip (capability gate)", () => {
    const asset: any = compileMotion(
      [{ beatId: "p5", role: "", param: "ParamGhost", start: 0, duration: 0.5, intensity: 1 }],
      { ownedParams: new Set(["ParamReal"]) },
      null,
    );
    expect(asset.tracks.length).toBe(0);
  });

  it("storyboard campuran: role + param ekstra dalam satu compile", () => {
    const asset: any = compileMotion(
      [
        { beatId: "m1", role: "ay", start: 0, duration: 0.5, intensity: 0.6 },
        { beatId: "m2", role: "", param: "ParamHairSway", start: 0.2, duration: 0.5, intensity: 0.5, sign: -1, safeRange: [-15, 15] },
      ],
      {},
      null,
    );
    expect(asset.tracks.length).toBe(2);
    const roleTrack = asset.tracks.find((t: any) => t.target === "ay");
    const paramTrack = asset.tracks.find((t: any) => t.kind === "param");
    expect(roleTrack).toBeTruthy();
    expect(paramTrack.param).toBe("ParamHairSway");
    expect(asset.beatIds).toContain("m1");
    expect(asset.beatIds).toContain("m2");
  });
});