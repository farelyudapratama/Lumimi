/**
 * test/mouth-candidates.test.ts — Lab Mulut: kandidat & klasifikasi param
 * mulut HARUS tahan terhadap nama arbitrer rigger (model-agnostic).
 *
 * Kelas cacat yang difalsifikasi: fitur yang bergantung pada NAMA parameter
 * sebagai kebenaran. Klasifikasi nama di sini hanya DUGAAN — kebenaran
 * evidence role/manifest harus tetap bekerja saat nama di-mangle.
 */
import { describe, expect, it } from "bun:test";
import {
  classifyByName,
  collectMouthCandidates,
  mergeMarks,
} from "../src/client/engine/mouth-candidates";

describe("classifyByName — dugaan dari nama", () => {
  it("param standar Cubism masuk bucket yang benar", () => {
    expect(classifyByName("ParamMouthOpenY")?.bucket).toBe("open");
    expect(classifyByName("ParamMouthOpenX")?.bucket).toBe("width");
    expect(classifyByName("ParamMouthForm")?.bucket).toBe("form");
    expect(classifyByName("ParamMouthA")?.bucket).toBe("vowel");
    expect(classifyByName("ParamMouthI")?.bucket).toBe("vowel");
    expect(classifyByName("ParamMouthSmile")?.bucket).toBe("form");
    expect(classifyByName("ParamLipUp")?.bucket).toBe("lip");
  });

  it("nama CJK/Jepang/Tionghoa terklasifikasi", () => {
    expect(classifyByName("口開")?.bucket).toBe("open");
    expect(classifyByName("嘴宽")?.bucket).toBe("width");
    expect(classifyByName("口形状")?.bucket).toBe("form");
  });

  it("openX tidak tertukar dengan open (lebar ≠ bukaan)", () => {
    expect(classifyByName("ParamMouthOpenX")?.matchedBy).toBe("openX");
  });

  it("param non-mulut tidak ikut tertarik oleh token umum", () => {
    // "open" milik mata, "smile" milik mata, "clip" mengandung "lip".
    expect(classifyByName("ParamEyeLOpen")).toBeNull();
    expect(classifyByName("ParamEyeLSmile")).toBeNull();
    expect(classifyByName("ParamClipX")).toBeNull();
    expect(classifyByName("ParamAngleX")).toBeNull();
  });

  it("gigi/lidah bukan lip — jatuh ke other", () => {
    expect(classifyByName("ParamTeethUpper")?.bucket).toBe("other");
    expect(classifyByName("ParamTongueOut")?.bucket).toBe("other");
  });
});

describe("collectMouthCandidates — gabungan evidence", () => {
  const params = [
    { id: "ParamMouthOpenY", min: 0, max: 1, def: 0, label: "Mulut" },
    { id: "ParamMouthForm", min: -1, max: 1, def: 0 },
    { id: "ParamMouthWide", min: -1, max: 1, def: 0 },
    { id: "p_077", min: 0, max: 2, def: 1 },
  ];

  it("evidence nama + manifest + role tergabung, bucket role menang", () => {
    const cands = collectMouthCandidates(params, {
      roleIds: { mouthOpenY: "ParamMouthOpenY", mouthForm: "ParamMouthForm" },
      officialLipSyncIds: ["ParamMouthOpenY", "p_077"],
    });
    const open = cands.find((c) => c.id === "ParamMouthOpenY");
    expect(open?.evidence).toContain("name");
    expect(open?.evidence).toContain("manifest");
    expect(open?.evidence).toContain("role");
    expect(open?.bucket).toBe("open");
  });

  it("nama di-mangle: tetap masuk lewat evidence role, bucket ikut role", () => {
    const cands = collectMouthCandidates(
      [{ id: "m_001", min: 0, max: 100, def: 50 }],
      { roleIds: { mouthOpenY: "m_001" } },
    );
    expect(cands).toHaveLength(1);
    expect(cands[0].bucket).toBe("open");
    expect(cands[0].evidence).toEqual(["role"]);
    expect(cands[0].matchedBy).toBe("mouthOpenY");
    // Nama di-mangle TIDAK menghasilkan dugaan nama.
    expect(classifyByName("m_001")).toBeNull();
  });

  it("id manifest tanpa nama bermakna: bucket other, jangan menebak", () => {
    const cands = collectMouthCandidates(params, {
      officialLipSyncIds: ["p_077"],
    });
    const c = cands.find((x) => x.id === "p_077");
    expect(c?.bucket).toBe("other");
    expect(c?.evidence).toEqual(["manifest"]);
  });

  it("role ter-resolve yang tak ada di params tetap muncul (sheet basi)", () => {
    const cands = collectMouthCandidates([], {
      roleIds: { mouthOpenX: "ParamMouthOpenX" },
    });
    expect(cands).toHaveLength(1);
    expect(cands[0].id).toBe("ParamMouthOpenX");
    expect(cands[0].bucket).toBe("width");
  });

  it("id manual user ikut dikumpulkan", () => {
    const cands = collectMouthCandidates(params, { manualIds: ["ParamKustom"] });
    const c = cands.find((x) => x.id === "ParamKustom");
    expect(c?.evidence).toContain("manual");
  });

  it("urut per bucket: open sebelum width sebelum form sebelum other", () => {
    const cands = collectMouthCandidates(params, {
      roleIds: { mouthOpenY: "ParamMouthOpenY", mouthForm: "ParamMouthForm" },
      officialLipSyncIds: ["p_077"],
    });
    const order = cands.map((c) => c.bucket);
    const first = (b: string) => order.indexOf(b as never);
    expect(first("open")).toBeLessThan(first("width"));
    expect(first("width")).toBeLessThan(first("form"));
    expect(first("form")).toBeLessThan(first("other"));
  });
});

describe("mergeMarks — putusan user", () => {
  it("set dan hapus verdict", () => {
    let m = mergeMarks({}, { A: "lipsync", B: "ignore" });
    expect(m).toEqual({ A: "lipsync", B: "ignore" });
    m = mergeMarks(m, { B: undefined as never, A: "expression" });
    expect(m).toEqual({ A: "expression" });
  });
});
