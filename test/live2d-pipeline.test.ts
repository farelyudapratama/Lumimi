/**
 * Unit test stack Live2D baru (src/live2d/*) — logika murni, tanpa jaringan,
 * tanpa WebGL, tanpa menulis data/config.json.
 */
import { describe, expect, it } from "bun:test";
import { ParameterArbiter } from "../src/live2d/ParameterArbiter";
import { mapRoles } from "../src/client/engine/role-mapping";

describe("ParameterArbiter — prioritas & konflik", () => {
  it("manual (100) mengalahkan blink (90)", () => {
    const a = new ParameterArbiter();
    a.set("ParamAngleX", 1, "blink");
    a.set("ParamAngleX", 2, "manual");
    expect(a.resolve().get("ParamAngleX")).toBe(2);
  });

  it("blink (90) mengalahkan emotion (80) dan motion (60)", () => {
    const a = new ParameterArbiter();
    a.set("ParamEyeLOpen", 0.1, "emotion");
    a.set("ParamEyeLOpen", 0.2, "motion");
    a.set("ParamEyeLOpen", 0, "blink");
    expect(a.resolve().get("ParamEyeLOpen")).toBe(0);
  });

  it("prioritas sama → seq terbaru menang", () => {
    const a = new ParameterArbiter();
    a.set("ParamAngleX", 1, "motion");
    a.set("ParamAngleX", 5, "motion");
    expect(a.resolve().get("ParamAngleX")).toBe(5);
  });

  it("hasConflict hanya true bila >1 sumber menulis param sama", () => {
    const a = new ParameterArbiter();
    a.set("ParamAngleX", 1, "motion");
    expect(a.hasConflict("ParamAngleX")).toBe(false);
    a.set("ParamAngleX", 2, "emotion");
    expect(a.hasConflict("ParamAngleX")).toBe(true);
    expect(a.hasConflict("ParamTidakAda")).toBe(false);
  });

  it("clearSource hanya membuang sumber itu — param lain utuh", () => {
    const a = new ParameterArbiter();
    a.set("ParamAngleX", 1, "motion");
    a.set("ParamAngleX", 2, "gaze");
    a.set("ParamAngleY", 3, "gaze");
    a.clearSource("gaze");
    expect(a.resolve().get("ParamAngleX")).toBe(1);
    expect(a.resolve().has("ParamAngleY")).toBe(false);
  });

  it("clearAll membuang semua sticky — ganti model tidak mewarisi pose lama", () => {
    const a = new ParameterArbiter();
    a.set("ParamAngleY", -14, "manual");
    a.set("ParamMouthForm", 1, "emotion");
    expect(a.resolve().size).toBe(2);
    a.clearAll();
    expect(a.resolve().size).toBe(0);
    // cache resolveFinal ikut basi — bacaan setelah clear tak menghidupkan lagi
    a.set("ParamAngleY", 5, "manual");
    expect(a.resolveFinal().get("ParamAngleY")).toBe(5);
    a.clearAll();
    expect(a.resolveFinal().has("ParamAngleY")).toBe(false);
  });

  it("resolve() murni — dua panggilan hasil sama, tidak mengubah state", () => {
    const a = new ParameterArbiter();
    a.set("ParamAngleX", 7, "motion");
    const r1 = a.resolve();
    const r2 = a.resolve();
    expect(r1.get("ParamAngleX")).toBe(7);
    expect(r2.get("ParamAngleX")).toBe(7);
    expect(a.hasConflict("ParamAngleX")).toBe(false);
  });
});

describe("role ear — deteksi via role space, bebas positif palsu", () => {
  it("keluarga ParamEar* terpetakan ke role ear", () => {
    const m = mapRoles(new Set(["ParamAngleX", "ParamEarL", "ParamEarR"]));
    expect(["ParamEarL", "ParamEarR"]).toContain(m.ear);
  });

  it("varian left_ear / Right_Ear terpetakan via token terpisah", () => {
    const m = mapRoles(new Set(["Left_Ear", "Right_Ear"]));
    expect(["Left_Ear", "Right_Ear"]).toContain(m.ear);
  });

  it("ParamEarLeft / ParamEarRight terpetakan", () => {
    const m = mapRoles(new Set(["ParamEarLeft", "ParamEarRight"]));
    expect(["ParamEarLeft", "ParamEarRight"]).toContain(m.ear);
  });

  it("HEART dan PEARL tidak boleh positif-palsu jadi ear (pelajaran 'earl' ⊂ 'pearl')", () => {
    const m = mapRoles(new Set(["ParamHeart", "PearlOpacity"]));
    expect(m.ear).toBeUndefined();
  });

  it("invariansi nama: rig diganti nama total → ear tidak terpetakan (tidak nebak)", () => {
    const m = mapRoles(new Set(["m_001", "m_002", "m_003"]));
    expect(m.ear).toBeUndefined();
  });
});
