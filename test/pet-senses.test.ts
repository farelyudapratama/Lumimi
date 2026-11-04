/**
 * Unit test senses pet (src/client/pet/senses.ts) — murni, tanpa DOM/IPC.
 * Klaim model-agnostic: tidak ada id param/nama model di modul ini.
 */
import { describe, expect, it } from "bun:test";
import { createSenses, isResting } from "../src/client/pet/senses";

describe("pet senses — kinematika kursor", () => {
  it("sampel pertama: posisi terpasang, kecepatan nol", () => {
    const s = createSenses();
    const k = s.feed({ x: 100, y: 50, down: false, t: 0 });
    expect(k.x).toBe(100);
    expect(k.y).toBe(50);
    expect(k.vx).toBe(0);
    expect(k.vy).toBe(0);
  });

  it("gerak lurus menghasilkan kecepatan positif menuju arah gerak", () => {
    const s = createSenses();
    s.feed({ x: 0, y: 0, down: false, t: 0 });
    s.feed({ x: 100, y: 0, down: false, t: 100 }); // 100 px / 0.1 s = 1000 px/s
    const k = s.feed({ x: 200, y: 0, down: false, t: 200 });
    expect(k.vx).toBeGreaterThan(500);
    expect(k.vy).toBeCloseTo(0, 5);
  });

  it("EMA: kecepatan turun halus saat kursor berhenti (bukan lompat nol)", () => {
    const s = createSenses();
    s.feed({ x: 0, y: 0, down: false, t: 0 });
    s.feed({ x: 500, y: 0, down: false, t: 100 });
    const k1 = s.feed({ x: 500, y: 0, down: false, t: 200 });
    const k2 = s.feed({ x: 500, y: 0, down: false, t: 300 });
    expect(Math.abs(k2.vx)).toBeLessThan(Math.abs(k1.vx));
    expect(Math.abs(k2.vx)).toBeGreaterThan(0); // belum nol — EMA
  });

  it("akselerasi non-nol saat kecepatan berubah, nol saat konstan", () => {
    const s = createSenses();
    s.feed({ x: 0, y: 0, down: false, t: 0 });
    s.feed({ x: 100, y: 0, down: false, t: 100 });
    const a1 = s.feed({ x: 300, y: 0, down: false, t: 200 }); // percepat
    const a2 = s.feed({ x: 500, y: 0, down: false, t: 300 }); // tetap cepat
    expect(Math.abs(a1.ax)).toBeGreaterThan(0);
    expect(Math.abs(a2.ax)).toBeLessThan(Math.abs(a1.ax));
  });

  it("tombol turun/naik terlacak", () => {
    const s = createSenses();
    const d = s.feed({ x: 1, y: 1, down: true, t: 0 });
    expect(d.down).toBe(true);
    const u = s.feed({ x: 1, y: 1, down: false, t: 50 });
    expect(u.down).toBe(false);
  });

  it("isResting: diam = true, gerak cepat = false", () => {
    const s = createSenses();
    s.feed({ x: 0, y: 0, down: false, t: 0 });
    s.feed({ x: 500, y: 0, down: false, t: 50 });
    expect(isResting(s.state())).toBe(false);
    for (let i = 1; i <= 30; i++) s.feed({ x: 500, y: 0, down: false, t: 50 + i * 16 });
    expect(isResting(s.state())).toBe(true);
  });

  it("invariansi nama: sampel tak menyimpan id apapun yang bergantung nama", () => {
    const s = createSenses();
    const k = s.feed({ x: 3, y: 4, down: true, t: 10 });
    const keys = Object.keys(k).sort().join(",");
    expect(keys).toBe("ax,ay,down,sinceInputMs,vx,vy,x,y");
  });
});
