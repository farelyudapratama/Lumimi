/**
 * Unit test detektor sentuhan pet (src/client/pet/touch.ts) — murni.
 * Skenario: grab lurus, boop tap, pat wiggle (pat mengalahkan grab),
 * lemparan release.
 */
import { describe, expect, it } from "bun:test";
import { createTouchDetector } from "../src/client/pet/touch";

function kinds(events: { kind: string }[]): string[] {
  return events.map((e) => e.kind);
}

describe("pet touch — grab", () => {
  it("geser lurus ≥10 px → grab lalu drag", () => {
    const d = createTouchDetector();
    expect(d.feed(100, 100, true, 0)).toEqual([]);
    expect(kinds(d.feed(105, 100, true, 30))).toEqual([]); // <10 px
    const g = d.feed(112, 100, true, 60);
    expect(kinds(g)).toContain("grab");
    const dr = d.feed(120, 100, true, 90);
    expect(kinds(dr)).toContain("drag");
  });

  it("release setelah grab → release.grabbed = true", () => {
    const d = createTouchDetector();
    d.feed(100, 100, true, 0);
    d.feed(120, 100, true, 50);
    d.feed(140, 100, true, 100);
    const up = d.feed(140, 100, false, 150);
    const rel = up.find((e) => e.kind === "release") as { grabbed: boolean; vx: number };
    expect(rel.grabbed).toBe(true);
    expect(rel.vx).toBeGreaterThan(0); // ada lemparan ke kanan
  });

  it("isGrabbing: true saat drag, false setelah lepas", () => {
    const d = createTouchDetector();
    d.feed(100, 100, true, 0);
    d.feed(130, 100, true, 50);
    expect(d.isGrabbing()).toBe(true);
    d.feed(130, 100, false, 80);
    expect(d.isGrabbing()).toBe(false);
  });
});

describe("pet touch — boop", () => {
  it("tap singkat tanpa geser → boop", () => {
    const d = createTouchDetector();
    d.feed(100, 100, true, 0);
    const up = d.feed(101, 101, false, 120);
    expect(kinds(up)).toContain("boop");
  });

  it("tekan lama tanpa geser → BUKAN boop", () => {
    const d = createTouchDetector();
    d.feed(100, 100, true, 0);
    const up = d.feed(100, 100, false, 400);
    expect(kinds(up)).not.toContain("boop");
  });

  it("tap tapi geser jauh → grab, bukan boop", () => {
    const d = createTouchDetector();
    d.feed(100, 100, true, 0);
    d.feed(140, 100, true, 100);
    const up = d.feed(140, 100, false, 150);
    expect(kinds(up)).not.toContain("boop");
    expect(up.some((e) => e.kind === "release" && (e as { grabbed: boolean }).grabbed)).toBe(true);
  });
});

describe("pet touch — pat (wiggle)", () => {
  it("3 balikan arah + path cukup → pat, dan grab TIDAK menyusul", () => {
    const d = createTouchDetector();
    d.feed(100, 100, true, 0);
    let gotPat = false;
    // wiggle kanan-kiri melewati dead zone 2px tiap sisi
    const xs = [106, 102, 108, 103, 110, 104, 112];
    for (let i = 0; i < xs.length; i++) {
      const ev = d.feed(xs[i], 100 + (i % 2), true, 40 * (i + 1));
      if (kinds(ev).includes("pat")) gotPat = true;
      if (gotPat) expect(kinds(ev)).not.toContain("grab");
    }
    expect(gotPat).toBe(true);
  });

  it("geser lurus dengan sedikit jitter TETAP grab (flip < 3)", () => {
    const d = createTouchDetector();
    d.feed(100, 100, true, 0);
    const e1 = d.feed(112, 100, true, 50);
    const e2 = d.feed(110, 100, true, 90); // jitter kecil balik
    const e3 = d.feed(124, 100, true, 130);
    const all = [...e1, ...e2, ...e3];
    expect(kinds(all)).toContain("grab");
    expect(kinds(all)).not.toContain("pat");
  });

  it("pat gelisah tanpa path ≥ patMinPath → bukan pat", () => {
    const d = createTouchDetector({ patFlips: 2 });
    d.feed(100, 100, true, 0);
    // banyak flip tapi path total kecil (di bawah patMinPath 30 px)
    const xs = [103, 100, 103, 100, 103, 100];
    let gotPat = false;
    for (let i = 0; i < xs.length; i++) {
      const ev = d.feed(xs[i], 100, true, 40 * (i + 1));
      if (kinds(ev).includes("pat")) gotPat = true;
    }
    expect(gotPat).toBe(false);
  });
});

describe("pet touch — kebersihan state", () => {
  it("dua tekanan berturut-turut: state tidak bocor antar-press", () => {
    const d = createTouchDetector();
    d.feed(100, 100, true, 0);
    d.feed(101, 100, false, 100); // boop 1
    d.feed(300, 300, true, 200); // press baru
    const up = d.feed(301, 300, false, 320);
    expect(kinds(up)).toContain("boop"); // path baru dihitung dari 0
  });
});
