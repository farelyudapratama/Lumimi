/**
 * Unit test hit pet (src/client/pet/hit.ts) — murni.
 * Hit-area = AABB facade + pad; konversi kursor fisik → CSS px.
 */
import { describe, expect, it } from "bun:test";
import { aabbContains, expandAABB, physicalToClient } from "../src/client/pet/hit";

describe("pet hit — AABB & konversi kursor", () => {
  const b = { x: 100, y: 200, width: 300, height: 400 };

  it("expandAABB membesar di semua sisi", () => {
    const e = expandAABB(b, 10);
    expect(e.x).toBe(90);
    expect(e.y).toBe(190);
    expect(e.width).toBe(320);
    expect(e.height).toBe(420);
  });

  it("expandAABB pad 0 = identik; pad negatif disipkan tanpa crash", () => {
    expect(expandAABB(b, 0)).toEqual(b);
    const e = expandAABB(b, -5);
    expect(e.width).toBe(290);
  });

  it("aabbContains: tepi terhitung di dalam", () => {
    expect(aabbContains(b, 100, 200)).toBe(true);
    expect(aabbContains(b, 400, 600)).toBe(true);
    expect(aabbContains(b, 99.9, 200)).toBe(false);
    expect(aabbContains(b, 100, 601)).toBe(false);
  });

  it("physicalToClient: scale 1 — geser langsung", () => {
    const c = physicalToClient({ x: 150, y: 250 }, { x: 50, y: 50 }, 1);
    expect(c).toEqual({ x: 100, y: 200 });
  });

  it("physicalToClient: DPI 1.5 — dibagi faktor skala", () => {
    const c = physicalToClient({ x: 200, y: 320 }, { x: 20, y: 20 }, 1.5);
    expect(c.x).toBeCloseTo(120, 5);
    expect(c.y).toBeCloseTo(200, 5);
  });

  it("physicalToClient: scaleFactor tak wajar (0/negatif) → dianggap 1", () => {
    expect(physicalToClient({ x: 10, y: 10 }, { x: 0, y: 0 }, 0)).toEqual({ x: 10, y: 10 });
  });

  it("invariansi: hasil konversi stabil setelah jendela pindah (origin baru)", () => {
    // Jendela digeser +100 fisik dan kursor ikut +100 fisik → client tetap.
    const before = physicalToClient({ x: 150, y: 250 }, { x: 50, y: 50 }, 1);
    const after = physicalToClient({ x: 250, y: 350 }, { x: 150, y: 150 }, 1);
    expect(after).toEqual(before);
  });
});
