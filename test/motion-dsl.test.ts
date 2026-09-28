/**
 * test/motion-dsl.test.ts — Tests for motion DSL.
 */
import { describe, it, expect } from "bun:test";
import { evalTrack, evaluateAsset, validateMotion, assetDurationMs, fieldCapability, rolesToParamTracks, sanitizeMotionAsset } from "../src/client/animation/motion-dsl";
import type { MotionTrack, MotionAsset } from "../src/shared/types";

describe("evalTrack", () => {
  it("returns 0 for empty track", () => {
    const track: MotionTrack = { kind: "role", target: "angleX", interp: "linear", keys: [] };
    expect(evalTrack(track, 0)).toBe(0);
  });

  it("returns first key value before start", () => {
    const track: MotionTrack = {
      kind: "role", target: "angleX", interp: "linear",
      keys: [{ t: 0.5, v: 10 }],
    };
    expect(evalTrack(track, 0)).toBe(10);
  });

  it("interpolates linearly", () => {
    const track: MotionTrack = {
      kind: "role", target: "angleX", interp: "linear",
      keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }],
    };
    expect(evalTrack(track, 0.5)).toBe(5);
  });

  it("holds last value after end", () => {
    const track: MotionTrack = {
      kind: "role", target: "angleX", interp: "linear",
      keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }],
    };
    expect(evalTrack(track, 2)).toBe(10);
  });

  it("handles ease-in interpolation", () => {
    const track: MotionTrack = {
      kind: "role", target: "angleX", interp: "ease-in",
      keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }],
    };
    const v = evalTrack(track, 0.5);
    // ease-in: t^3 = 0.125, so value = 1.25
    expect(v).toBeCloseTo(1.25, 1);
  });
});

describe("evaluateAsset", () => {
  it("evaluates role tracks", () => {
    const asset: MotionAsset = {
      version: 1, id: "test", name: "Test", description: "",
      tags: [], source: "builtin", type: "gesture",
      duration: 1, loop: false,
      intensity: { min: 0.3, max: 1, default: 0.8 },
      emotionCompatibility: {}, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [],
      tracks: [{
        kind: "role", target: "angleX", interp: "linear",
        keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }],
      }],
    };
    const ev = evaluateAsset(asset, 0.5, 1);
    expect(ev.roles.ax).toBe(5);
    // alias SPEC dikanoniskan: tidak ada kunci duplikat gaya SPEC di roles
    expect(ev.roles.angleX).toBeUndefined();
  });

  it("respects intensity scaling", () => {
    const asset: MotionAsset = {
      version: 1, id: "test", name: "Test", description: "",
      tags: [], source: "builtin", type: "gesture",
      duration: 1, loop: false,
      intensity: { min: 0.3, max: 1, default: 0.8 },
      emotionCompatibility: {}, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [],
      tracks: [{
        kind: "role", target: "angleX", interp: "linear",
        keys: [{ t: 0, v: 0 }, { t: 1, v: 20 }],
      }],
    };
    const ev = evaluateAsset(asset, 0.5, 0.5);
    expect(ev.roles.ax).toBe(5); // 10 * 0.5
  });

  it("clamps to field bounds", () => {
    const asset: MotionAsset = {
      version: 1, id: "test", name: "Test", description: "",
      tags: [], source: "builtin", type: "gesture",
      duration: 1, loop: false,
      intensity: { min: 0.3, max: 1, default: 0.8 },
      emotionCompatibility: {}, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [],
      tracks: [{
        kind: "role", target: "angleX", interp: "linear",
        keys: [{ t: 0, v: 0 }, { t: 1, v: 50 }], // 50 > bound of 30
      }],
    };
    const ev = evaluateAsset(asset, 1, 1);
    expect(ev.roles.ax).toBe(30); // clamped
  });
});

describe("validateMotion", () => {
  it("rejects empty id", () => {
    const asset: MotionAsset = {
      version: 1, id: "", name: "Test", description: "",
      tags: [], source: "user", type: "keyframe",
      duration: 1, loop: false,
      intensity: { min: 0.3, max: 1, default: 0.8 },
      emotionCompatibility: {}, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [],
      tracks: [{ kind: "role", target: "angleX", interp: "linear", keys: [{ t: 0, v: 0 }] }],
    };
    const errors = validateMotion(asset);
    expect(errors.some((e) => e.includes("id"))).toBe(true);
  });

  it("rejects invalid duration", () => {
    const asset: MotionAsset = {
      version: 1, id: "test", name: "Test", description: "",
      tags: [], source: "user", type: "keyframe",
      duration: 0, loop: false,
      intensity: { min: 0.3, max: 1, default: 0.8 },
      emotionCompatibility: {}, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [],
      tracks: [{ kind: "role", target: "angleX", interp: "linear", keys: [{ t: 0, v: 0 }] }],
    };
    const errors = validateMotion(asset);
    expect(errors.some((e) => e.includes("duration"))).toBe(true);
  });

  it("accepts valid motion", () => {
    const asset: MotionAsset = {
      version: 1, id: "wave", name: "Wave", description: "Test wave",
      tags: ["greeting"], source: "user", type: "keyframe",
      duration: 1.5, loop: false,
      intensity: { min: 0.3, max: 1, default: 0.8 },
      emotionCompatibility: { senang: 1 }, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [],
      tracks: [{
        kind: "role", target: "angleX", interp: "linear",
        keys: [{ t: 0, v: 0 }, { t: 0.5, v: 5 }, { t: 1, v: 0 }],
      }],
    };
    const errors = validateMotion(asset);
    expect(errors).toHaveLength(0);
  });
});

describe("assetDurationMs", () => {
  it("converts seconds to ms", () => {
    const asset = { duration: 1.5 } as MotionAsset;
    expect(assetDurationMs(asset)).toBe(1500);
  });

  it("has minimum of 200ms", () => {
    const asset = { duration: 0 } as MotionAsset;
    expect(assetDurationMs(asset)).toBe(200);
  });
});

describe("kosakata v2 (field ekspresi, 2026-09-29)", () => {
  it("fieldCapability memetakan field baru ke grup capability yang benar", () => {
    expect(fieldCapability("az")).toBe("head");
    expect(fieldCapability("browLY")).toBe("brow");
    expect(fieldCapability("browRY")).toBe("brow");
    expect(fieldCapability("browLF")).toBe("brow");
    expect(fieldCapability("browRF")).toBe("brow");
    expect(fieldCapability("smileL")).toBe("eyes");
    expect(fieldCapability("smileR")).toBe("eyes");
    expect(fieldCapability("mouthOpen")).toBe("mouth");
  });

  it("rolesToParamTracks: field deviasi-dari-default berhenti di default milik model", () => {
    // Rig senyum mata 0..100 dengan default 80 — nilai 0 (istirahat) tetap 80,
    // +1 mencapai max. Bukan midpoint (yang akan diam di 50).
    const roleMap = { eyeLSmile: "m_001" };
    const ranges = { m_001: { min: 0, max: 100, def: 80 } };
    const asset: MotionAsset = {
      version: 1, id: "senyum", name: "Senyum", description: "",
      tags: [], source: "ai", type: "keyframe",
      duration: 1, loop: false,
      intensity: { min: 0.3, max: 1, default: 0.8 },
      emotionCompatibility: {}, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [],
      tracks: [{
        kind: "role", target: "smileL", interp: "linear",
        keys: [{ t: 0, v: 0 }, { t: 0.5, v: 1 }, { t: 1, v: 0 }],
      }],
    };
    const out: any = rolesToParamTracks(asset, roleMap, ranges);
    expect(out.tracks[0].param).toBe("m_001");
    expect(out.tracks[0].keys[0].v).toBe(80);  // 0 = default (diam)
    expect(out.tracks[0].keys[1].v).toBe(100); // +1 = max
    expect(out.tracks[0].keys[2].v).toBe(80);  // pulang ke default
  });

  it("rolesToParamTracks: mouthOpen -1 turun ke min (mulut tertutup) pada rig 0..1", () => {
    const roleMap = { mouthOpenY: "m_002" };
    const ranges = { m_002: { min: 0, max: 1, def: 0 } };
    const asset: MotionAsset = {
      version: 1, id: "buka", name: "Buka", description: "",
      tags: [], source: "ai", type: "keyframe",
      duration: 1, loop: false,
      intensity: { min: 0.3, max: 1, default: 0.8 },
      emotionCompatibility: {}, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [],
      tracks: [{
        kind: "role", target: "mouthOpen", interp: "linear",
        keys: [{ t: 0.5, v: -1 }],
      }],
    };
    const out: any = rolesToParamTracks(asset, roleMap, ranges);
    expect(out.tracks[0].keys[0].v).toBe(0);
  });

  it("rolesToParamTracks: az memakai skala derajat ±30", () => {
    const roleMap = { angleZ: "m_003" };
    const ranges = { m_003: { min: -30, max: 30, def: 0 } };
    const asset: MotionAsset = {
      version: 1, id: "miring", name: "Miring", description: "",
      tags: [], source: "ai", type: "keyframe",
      duration: 1, loop: false,
      intensity: { min: 0.3, max: 1, default: 0.8 },
      emotionCompatibility: {}, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [],
      tracks: [{
        kind: "role", target: "az", interp: "linear",
        keys: [{ t: 0, v: 0 }, { t: 1, v: 12 }],
      }],
    };
    const out: any = rolesToParamTracks(asset, roleMap, ranges);
    expect(out.tracks[0].keys[1].v).toBe(12);
  });

  it("sanitize menerima alias v2 dan meng-clamp ke bound", () => {
    const r = sanitizeMotionAsset({
      id: "kaget", duration: 1,
      tracks: [
        { target: "browLY", keys: [{ t: 0, v: 0 }, { t: 0.4, v: 5 }, { t: 1, v: 0 }] },
        { target: "mouthOpenY", keys: [{ t: 0, v: 0 }, { t: 0.4, v: 3 }, { t: 1, v: 0 }] },
      ],
    } as any, { requireTracks: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.asset.tracks[0] as any).target).toBe("browLY");
      expect((r.asset.tracks[0] as any).keys[1].v).toBe(1); // clamp 5 → 1
      expect((r.asset.tracks[1] as any).target).toBe("mouthOpen");
      expect((r.asset.tracks[1] as any).keys[1].v).toBe(1);
    }
  });
});
