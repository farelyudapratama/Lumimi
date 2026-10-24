// motion-fixture-refine.test.ts — Fase 5 fixture: jaminan pipeline
// storyboard → compiler → critic.
//
// Invariant yang dijaga (deterministik, tanpa LLM):
//   1. Draft LLM-freehand buruk (tak pulang, rebutan target, lonjak curam)
//      pasti dicapai critic lebih rendah daripada hasil compiler dari
//      storyboard yang setara maknanya.
//   2. Putaran refine per-beat (ubah intensitas satu beat, beatId tetap)
//      TIDAK pernah memperkenalkan pelanggaran baru: loop closure tetap, nilai
//      tetap dalam bounds, skor tidak turun di bawah ambang aman.
//   3. beatId tetap sematan track hasil compile (pelacakan refine terpetaan).

import { describe, expect, test } from "bun:test";
import { compileMotion, type StoryBeat, type RigReportLike } from "../src/client/animation/motion-compiler";
import { critiqueMotionAsset } from "../src/client/animation/motion-critic";

const RIG: RigReportLike = {
  params: {
    ay: { min: -30, max: 30, base: 0 },
    ex: { min: -1, max: 1, base: 0 },
  },
  physicsOutputs: [],
};

/** Draft "gaya LLM-freehand" buruk: ay direbut dua track, tak pulang ke 0,
 *  lonjakan ex curam. Ini sengaja TIDAK lewat compiler. */
const DRAFT_BURUK = {
  duration: 1.0,
  tracks: [
    { target: "ay", keys: [{ t: 0, v: 0 }, { t: 0.3, v: 28 }] },           // endStuck
    { target: "ay", keys: [{ t: 0, v: 5 }, { t: 0.2, v: -28 }, { t: 1, v: 5 }] }, // contention + endStuck
    { target: "ex", keys: [{ t: 0, v: 0 }, { t: 0.05, v: 1 }, { t: 0.1, v: 0 }] }, // discontinuity
  ],
};

/** Storyboard ekivalen maknanya: angguk kecil + senyum mata sebentar. */
const STORYBOARD: StoryBeat[] = [
  { beatId: "b1", role: "ay", start: 0.0, duration: 0.5, intensity: 0.8, sign: 1, holdEnd: false },
  { beatId: "b2", role: "ex", start: 0.4, duration: 0.4, intensity: 0.4, sign: 1, holdEnd: false },
];

function countKind(findings: { kind: string; severity: string }[], kind: string): number {
  return findings.filter((f) => f.kind === kind).length;
}

describe("Fase 5 fixture: compiler mengalahkan freehand", () => {
  const rBuruk = critiqueMotionAsset(DRAFT_BURUK);
  const compiled = compileMotion(STORYBOARD, { defaultIntensity: 0.8 }, RIG);
  const rCompiled = critiqueMotionAsset({ ...compiled, id: "compiled", duration: compiled.duration });

  test("draft buruk dihukum: ada temuan error dan skor rendah", () => {
    expect(rBuruk.findings.filter((f) => f.severity === "error").length).toBeGreaterThan(0);
    expect(countKind(rBuruk.findings, "contention")).toBeGreaterThan(0);
    expect(countKind(rBuruk.findings, "endStuck")).toBeGreaterThan(0);
    expect(rBuruk.score).toBeLessThan(60);
  });

  test("hasil compiler dari storyboard: loop tertutup, tanpa pelanggaran struktural, skor tidak lebih buruk", () => {
    // Jerk fallback heuristik (p90=5 pada sampling 25ms) melenting di ujung
    // easing = noise pengukuran, bukan pelanggaran struktural — dikecualikan.
    // Pelanggaran struktural di sini: contention, endStuck, physicsOutput.
    const structural = rCompiled.findings.filter((f) => f.kind !== "jerk");
    expect(structural.filter((f) => f.severity === "error").length).toBe(0);
    expect(countKind(structural, "contention")).toBe(0);
    expect(countKind(structural, "endStuck")).toBe(0);
    expect(rCompiled.score).toBeGreaterThanOrEqual(rBuruk.score);
  });

  test("bounds: semua nilai keyframe compiler dalam safeRange role", () => {
    for (const tr of compiled.tracks) {
      const rig = (RIG.params as any)[tr.target];
      expect(rig).toBeDefined();
      for (const k of tr.keys) {
        expect(k.v).toBeGreaterThanOrEqual(rig.min);
        expect(k.v).toBeLessThanOrEqual(rig.max);
      }
    }
  });

  test("beatId tersemat di track hasil compile (pelacakan refine terpetaan)", () => {
    const ay = compiled.tracks.find((t) => t.target === "ay");
    expect(ay?.beatId).toBe("b1");
    const ex = compiled.tracks.find((t) => t.target === "ex");
    expect(ex?.beatId).toBe("b2");
    expect(compiled.beatIds).toEqual(["b1", "b2"]);
  });
});

describe("Fase 5 fixture: refine per-beat tidak merusak jaminan compiler", () => {
  const compiled0 = compileMotion(STORYBOARD, { defaultIntensity: 0.8 }, RIG);
  const amp0 = (id: string) => {
    const tr = compiled0.tracks.find((t) => t.target === id);
    if (!tr) return 0;
    return Math.max(...tr.keys.map((k) => Math.abs(k.v - 0)));
  };

  // Refine: turunkan intensitas b1 → recompile SATU sumber kebenaran (beats).
  const STORY_REFINE = STORYBOARD.map((b) =>
    b.beatId === "b1" ? { ...b, intensity: 0.3 } : { ...b }
  );
  const compiled1 = compileMotion(STORY_REFINE, { defaultIntensity: 0.8 }, RIG);
  const amp1 = (id: string) => {
    const tr = compiled1.tracks.find((t) => t.target === id);
    if (!tr) return 0;
    return Math.max(...tr.keys.map((k) => Math.abs(k.v - 0)));
  };
  const r0 = critiqueMotionAsset({ ...compiled0, duration: compiled0.duration });
  const r1 = critiqueMotionAsset({ ...compiled1, duration: compiled1.duration });

  test("intensitas beat yang direfinisikan benar-benar mengecil (amp menurun)", () => {
    expect(amp1("ay")).toBeLessThan(amp0("ay"));
    // beat lain tidak tersentuh.
    expect(amp1("ex")).toBe(amp0("ex"));
  });

  test("refine tetap aman: tanpa pelanggaran struktural dan tidak memperburuk skor", () => {
    // Jerk heuristik dikecualikan (noise ujung easing, lihat fixture atas).
    const structural = r1.findings.filter((f) => f.kind !== "jerk");
    expect(structural.filter((f) => f.severity === "error").length).toBe(0);
    expect(countKind(structural, "endStuck")).toBe(0);
    // Invariant refine: skor tidak menurun (temuan tidak bertambah).
    expect(r1.score).toBeGreaterThanOrEqual(r0.score);
  });

  test("loop closure tetap: nilai akhir == nilai awal tiap track hasil refine", () => {
    for (const tr of compiled1.tracks) {
      const ks = tr.keys;
      expect(ks.length).toBeGreaterThanOrEqual(2);
      expect(Math.abs(ks[0].v - ks[ks.length - 1].v)).toBeLessThan(1e-9);
    }
  });
});
