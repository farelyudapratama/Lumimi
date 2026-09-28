import { describe, it, expect } from "bun:test";
import { sanitizeMotionAsset, FIELD_BOUNDS, normalizeTarget } from "../src/client/animation/motion-dsl";
import { mergeEventsIntoConfig, KNOWN_EVENT_KEYS } from "../src/shared/config";
import { classifyError } from "../src/shared/llm-client";

describe("FIELD_BOUNDS parity with js/motion-dsl.js", () => {
  it("ax/ay/ex/ey/mouthForm bound 30/1", () => {
    expect(FIELD_BOUNDS.ax).toBe(30);
    expect(FIELD_BOUNDS.ay).toBe(30);
    expect(FIELD_BOUNDS.ex).toBe(1);
    expect(FIELD_BOUNDS.mouthForm).toBe(1);
  });
  it("only canonical keys exist (no alias entries)", () => {
    expect(FIELD_BOUNDS.angleX).toBeUndefined();
    expect(FIELD_BOUNDS.eyeLSmile).toBeUndefined();
    expect(FIELD_BOUNDS.browLForm).toBeUndefined();
  });
  it("v2 expressive fields exist (kosakata diperluas 2026-09-29)", () => {
    expect(FIELD_BOUNDS.az).toBe(30);
    expect(FIELD_BOUNDS.mouthOpen).toBe(1);
    expect(FIELD_BOUNDS.smileL).toBe(1);
    expect(FIELD_BOUNDS.smileR).toBe(1);
    expect(FIELD_BOUNDS.browLY).toBe(1);
    expect(FIELD_BOUNDS.browRY).toBe(1);
    expect(FIELD_BOUNDS.browLF).toBe(1);
    expect(FIELD_BOUNDS.browRF).toBe(1);
  });
  it("SPEC-style alias names are canonicalized to internal fields (legacy parity)", () => {
    expect(normalizeTarget("angleX")).toBe("ax");
    expect(normalizeTarget("angleY")).toBe("ay");
    expect(normalizeTarget("eyeX")).toBe("ex");
    expect(normalizeTarget("eyeY")).toBe("ey");
    expect(normalizeTarget("ax")).toBe("ax");
    expect(normalizeTarget("bodyAngleX")).toBe(null);
    expect(normalizeTarget("mouthOpen")).toBe("mouthOpen");
    expect(normalizeTarget("mouthOpenY")).toBe("mouthOpen");
    expect(normalizeTarget("angleZ")).toBe("az");
    expect(normalizeTarget("eyeLSmile")).toBe("smileL");
    expect(normalizeTarget("browLForm")).toBe("browLF");
  });
  it("sanitize canonicalizes alias target and clamps to bounds", () => {
    const r = sanitizeMotionAsset({ id: "t", duration: 1, tracks: [{ target: "angleX", keys: [{ t: 0, v: 999 }] }] } as any, { requireTracks: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.asset.tracks[0] as any).target).toBe("ax");
      expect((r.asset.tracks[0] as any).keys[0].v).toBe(30);
    }
  });
});

describe("mergeEventsIntoConfig", () => {
  it("keeps only KNOWN_EVENT_KEYS", () => {
    const prev = { events: { idleSpeak: true, foo: 123 } };
    const out = mergeEventsIntoConfig(prev, { idleMs: 5000, bar: 99 });
    expect(out.events.foo).toBeUndefined();
    expect(out.events.bar).toBeUndefined();
    expect(out.events.idleMs).toBe(5000);
  });
  it("preserves UNKNOWN_EVENT not dropped if known", () => {
    const out = mergeEventsIntoConfig({ events: { quietMs: 100 } }, { quietMs: 200 });
    expect(out.events.quietMs).toBe(200);
  });
});

describe("sanitizeMotionAsset rejects out-of-bounds injection", () => {
  it("clamps role value to FIELD_BOUNDS", () => {
    const r = sanitizeMotionAsset({ id: "t", duration: 1, tracks: [{ target: "ax", keys: [{ t: 0, v: 999 }] }] } as any, { requireTracks: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.asset.tracks[0] as any).keys[0].v).toBe(30);
  });
  it("rejects unknown target", () => {
    const r = sanitizeMotionAsset({ id: "t", tracks: [{ target: "hax", keys: [{ t: 0, v: 0 }] }] } as any, { requireTracks: true });
    expect(r.ok).toBe(false);
  });
});

describe("classifyError parity", () => {
  it("rate limit shouldFallback", () => {
    const c = classifyError(429, "rate limit exceeded");
    expect(c.shouldFallback).toBe(true);
    expect(c.cooldownMs).toBeGreaterThan(0);
  });
  it("401 cooldown 120s", () => {
    const c = classifyError(401, "unauthorized");
    expect(c.cooldownMs).toBe(120_000);
  });
});
