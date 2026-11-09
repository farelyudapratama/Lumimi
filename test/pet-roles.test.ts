/**
 * Unit test role writer pet (src/client/pet/roles.ts) — tulis param HANYA
 * lewat role space (MODEL-AGNOSTIC-RULES). Invariansi kunci: nama param
 * diganti total → mapping tetap benar via keyword; skala selalu rentang
 * MILIK model (rig 0..100 menerima nilai skala benar, bukan literal dev).
 */
import { describe, expect, it } from "bun:test";
import { buildRoleWriter, type ParamMetaSource } from "../src/client/pet/roles";

/** Meta sintetis dengan nama param di-rename total (hash / bahasa lain). */
function metaOf(ids: Record<string, { min: number; max: number; def: number }>): ParamMetaSource {
  const list = Object.entries(ids);
  return {
    getParameterCount: () => list.length,
    getParameterId: (i) => list[i][0],
    getParameterMinimumValue: (i) => list[i][1].min,
    getParameterMaximumValue: (i) => list[i][1].max,
    getParameterDefaultValue: (i) => list[i][1].def,
  };
}

describe("pet roles — buildRoleWriter", () => {
  it("role eyeLOpen/eyeROpen terpetakan dari nama (EN)", () => {
    const meta = metaOf({
      ParamEyeLOpen: { min: 0, max: 1, def: 1 },
      ParamEyeROpen: { min: 0, max: 1, def: 1 },
    });
    const w = buildRoleWriter(["ParamEyeLOpen", "ParamEyeROpen"], meta, {
      setParameterValueById: () => {},
    });
    expect(w.ids()["eyeLOpen"]).toBe("ParamEyeLOpen");
    expect(w.ids()["eyeROpen"]).toBe("ParamEyeROpen");
  });

  it("invariansi rename: nama JA/hashed tetap ketemu lewat keyword", () => {
    const meta = metaOf({
      "左目_開閉": { min: 0, max: 100, def: 100 },
      "右目_開閉": { min: 0, max: 100, def: 100 },
    });
    const w = buildRoleWriter(["左目_開閉", "右目_開閉"], meta, {
      setParameterValueById: () => {},
    });
    expect(w.ids()["eyeLOpen"]).toBe("左目_開閉");
    expect(w.ids()["eyeROpen"]).toBe("右目_開閉");
  });

  it("setDev(-1) pada rig 0..100 → 0 (tertutup); setDev(0) → default", () => {
    const writes: Record<string, number> = {};
    const meta = metaOf({
      "左目_開閉": { min: 0, max: 100, def: 100 },
    });
    const w = buildRoleWriter(["左目_開閉"], meta, {
      setParameterValueById: (id, v) => { writes[id] = v; },
    });
    expect(w.setDev("eyeLOpen", -1)).toBe(true);
    expect(writes["左目_開閉"]).toBe(0);
    expect(w.setDev("eyeLOpen", 0)).toBe(true);
    expect(writes["左目_開閉"]).toBe(100); // pulang ke default milik model
  });

  it("setNorm(0.5) = tengah rentang; rig -1..1 → 0", () => {
    const writes: Record<string, number> = {};
    const meta = metaOf({
      ParamAngleX: { min: -30, max: 30, def: 0 },
    });
    const w = buildRoleWriter(["ParamAngleX"], meta, {
      setParameterValueById: (id, v) => { writes[id] = v; },
    });
    expect(w.setNorm("angleX", 0.5)).toBe(true);
    expect(writes["ParamAngleX"]).toBe(0);
    expect(w.setNorm("angleX", 1)).toBe(true);
    expect(writes["ParamAngleX"]).toBe(30);
  });

  it("role tak dikenal model → setDev false (tolak senyap)", () => {
    const w = buildRoleWriter(["ParamMouthOpenY"], metaOf({
      ParamMouthOpenY: { min: 0, max: 1, def: 0 },
    }), { setParameterValueById: () => {} });
    expect(w.setDev("eyeLOpen", -1)).toBe(false);
  });

  it("meta kosong: fallback deviasi mentah di-clamp −1..1 (core yang clamp ke rentang)", () => {
    const writes: Record<string, number> = {};
    const w = buildRoleWriter(["左目_開閉"], null, {
      setParameterValueById: (id, v) => { writes[id] = v; },
    });
    expect(w.setDev("eyeLOpen", -1)).toBe(true);
    expect(writes["左目_開閉"]).toBe(-1); // unit deviasi; core Cubism clamp ke range param
  });
});
