/**
 * test/character-adapters.test.ts — Adapter murni keputusan → Intent semantik.
 * Verifikasi pemetaan Director/behavior → Intent, policy-drop paramDrive,
 * serta ketotalan terhadap input null/kosong/kacau (tidak pernah throw).
 */
import { describe, expect, it } from "bun:test";
import {
  behaviorToIntents,
  directorToIntents,
  dropApertureParamCtx,
} from "../src/client/character/adapters";

describe("directorToIntents", () => {
  it("emotion → intent expression affect 60 tanpa durationMs", () => {
    const { intents, dropped } = directorToIntents([{ emotion: "senang" }]);
    expect(dropped).toEqual([]);
    expect(intents).toEqual([
      {
        kind: "expression",
        id: "senang",
        domains: ["affect"],
        priority: 60,
        source: "director",
      },
    ]);
    expect(intents[0].durationMs).toBeUndefined();
  });

  it("emotion 'normal' / kosong / bukan string → tidak ada intent", () => {
    for (const emotion of ["normal", "", "   ", null, 42, undefined]) {
      const { intents, dropped } = directorToIntents([{ emotion }]);
      expect(intents).toEqual([]);
      expect(dropped).toEqual([]);
    }
  });

  it("gesture → intent action head+body 80 durasi tetap 2500", () => {
    const { intents, dropped } = directorToIntents([{ gesture: "nod" }]);
    expect(dropped).toEqual([]);
    expect(intents).toEqual([
      {
        kind: "action",
        id: "nod",
        domains: ["head", "body"],
        durationMs: 2500,
        priority: 80,
        source: "director",
      },
    ]);
  });

  it("motion memakai durationMs segmen; absen/tidak valid → 2500", () => {
    const withDur = directorToIntents([{ motion: "m_wave", durationMs: 4000 }]);
    expect(withDur.intents).toEqual([
      {
        kind: "action",
        id: "m_wave",
        domains: ["head", "body"],
        durationMs: 4000,
        priority: 80,
        source: "director",
      },
    ]);

    for (const bad of [undefined, null, "nanti", 0, -5, NaN]) {
      const { intents } = directorToIntents([{ motion: "m_wave", durationMs: bad }]);
      expect(intents[0].durationMs).toBe(2500);
    }
  });

  it("paramDrive TIDAK pernah jadi intent; selalu masuk dropped policy", () => {
    const { intents, dropped } = directorToIntents([
      {
        emotion: "senang",
        motion: "m_wave",
        paramDrive: { ParamMouthOpenY: 0.8, Param91: 1 },
        intensity: 0.9,
      },
    ]);
    // Hanya expression + action motion; tidak ada intent yang membawa param mentah.
    expect(intents.map((i) => i.id)).toEqual(["senang", "m_wave"]);
    expect(dropped).toEqual([{ field: "paramDrive", reason: "raw-param-ditolak-policy" }]);
    for (const intent of intents) {
      expect(JSON.stringify(intent)).not.toContain("ParamMouthOpenY");
      expect(JSON.stringify(intent)).not.toContain("Param91");
    }
  });

  it("paramDrive null/absen → tidak ada catatan dropped", () => {
    for (const seg of [{ paramDrive: null }, {}, { emotion: "senang" }]) {
      const { dropped } = directorToIntents([seg]);
      expect(dropped).toEqual([]);
    }
  });

  it("intensity diabaikan diam-diam (bukan intent, bukan dropped)", () => {
    const { intents, dropped } = directorToIntents([{ intensity: 0.42 }]);
    expect(intents).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("segmen gabungan: urutan emotion → gesture → motion", () => {
    const { intents } = directorToIntents([
      { text: "hai", emotion: "senang", gesture: "nod", motion: "m_wave", durationMs: 3000 },
    ]);
    expect(intents.map((i) => [i.kind, i.id])).toEqual([
      ["expression", "senang"],
      ["action", "nod"],
      ["action", "m_wave"],
    ]);
  });

  it("nowMs mengisi intent.at", () => {
    const { intents } = directorToIntents([{ emotion: "senang" }], 1234);
    expect(intents[0].at).toBe(1234);
    const withoutNow = directorToIntents([{ emotion: "senang" }]);
    expect(withoutNow.intents[0].at).toBeUndefined();
  });

  it("total: input null/undefined/bukan array/isi kacau tidak pernah throw", () => {
    for (const input of [null, undefined, 42, "x", {}, [null, 7, "x", [], {}]]) {
      const out = directorToIntents(input);
      expect(out).toEqual({ intents: [], dropped: [] });
    }
  });

  it("intents kosong bila tidak ada field yang cocok", () => {
    const { intents, dropped } = directorToIntents([
      { text: "hanya teks" },
      { emotion: "normal", gesture: null, motion: null },
    ]);
    expect(intents).toEqual([]);
    expect(dropped).toEqual([]);
  });
});

describe("behaviorToIntents", () => {
  it("idle-clip + motion → action body 50 dengan holdMs", () => {
    const { intents, dropped } = behaviorToIntents({
      action: "idle-clip",
      motion: "m_idle",
      emotion: "senang",
      holdMs: 4000,
    });
    expect(dropped).toEqual([]);
    // Klip menang atas emosi (satu keputusan = maksimal satu intent).
    expect(intents).toEqual([
      {
        kind: "action",
        id: "m_idle",
        domains: ["body"],
        durationMs: 4000,
        priority: 50,
        source: "behavior",
      },
    ]);
  });

  it("idle-clip tanpa motion + emotion → expression affect 50", () => {
    const { intents, dropped } = behaviorToIntents({
      action: "idle-clip",
      emotion: "senang",
    });
    expect(dropped).toEqual([]);
    expect(intents).toEqual([
      {
        kind: "expression",
        id: "senang",
        domains: ["affect"],
        priority: 50,
        source: "behavior",
      },
    ]);
    expect(intents[0].durationMs).toBeUndefined();
  });

  it("idle-clip tanpa motion & tanpa emotion → intents kosong + dropped", () => {
    const { intents, dropped } = behaviorToIntents({ action: "idle-clip" });
    expect(intents).toEqual([]);
    expect(dropped).toEqual([{ field: "action", reason: "idle-clip-tanpa-target" }]);
  });

  it("settle → action gaze 40, holdMs ?? 2500", () => {
    const withHold = behaviorToIntents({ action: "settle", holdMs: 5200 });
    expect(withHold.intents).toEqual([
      {
        kind: "action",
        id: "settle",
        domains: ["gaze"],
        durationMs: 5200,
        priority: 40,
        source: "behavior",
      },
    ]);

    const noHold = behaviorToIntents({ action: "settle" });
    expect(noHold.intents[0].durationMs).toBe(2500);

    // holdMs tidak valid → fallback default.
    const badHold = behaviorToIntents({ action: "settle", holdMs: "nanti" });
    expect(badHold.intents[0].durationMs).toBe(2500);
  });

  it("gaze-shift & micro-fidget → action gaze+head 40, default 2000", () => {
    for (const action of ["gaze-shift", "micro-fidget"]) {
      const { intents, dropped } = behaviorToIntents({ action, holdMs: 1200 });
      expect(dropped).toEqual([]);
      expect(intents).toEqual([
        {
          kind: "action",
          id: action,
          domains: ["gaze", "head"],
          durationMs: 1200,
          priority: 40,
          source: "behavior",
        },
      ]);

      const fallback = behaviorToIntents({ action });
      expect(fallback.intents[0].durationMs).toBe(2000);
    }
  });

  it("action tak dikenal / kosong → dropped action-tak-dikenal", () => {
    for (const action of ["backflip", "", "   ", null, undefined, 42]) {
      const { intents, dropped } = behaviorToIntents({ action });
      expect(intents).toEqual([]);
      expect(dropped).toEqual([{ field: "action", reason: "action-tak-dikenal" }]);
    }
  });

  it("total: decision null/undefined/bukan objek → dropped action-tak-dikenal", () => {
    for (const d of [null, undefined, "x", 42, []]) {
      const out = behaviorToIntents(d);
      expect(out.intents).toEqual([]);
      expect(out.dropped).toEqual([{ field: "action", reason: "action-tak-dikenal" }]);
    }
  });

  it("nowMs mengisi intent.at", () => {
    const { intents } = behaviorToIntents({ action: "settle" }, 5678);
    expect(intents[0].at).toBe(5678);
  });

  it("field model-agnostic: nilai id semantik apa pun lewat tanpa asumsi nama", () => {
    // Id hasil rename (mis. m_001 / hash) harus tetap dipetakan apa adanya.
    const { intents } = directorToIntents([{ motion: "m_001", durationMs: 800 }]);
    expect(intents[0].id).toBe("m_001");
    expect(intents[0].durationMs).toBe(800);
  });
});

describe("dropApertureParamCtx", () => {
  const ctx = [
    { id: "ParamMouthOpenY", min: 0, max: 1 },
    { id: "ParamMouthOpenX", min: -1, max: 1 },
    { id: "ParamBrowLY", min: -1, max: 1 },
    { id: "m_042", min: 0, max: 2 },
  ];

  it("param apertur role-resolved dibuang dari konteks Director", () => {
    const out = dropApertureParamCtx(ctx, ["ParamMouthOpenY", "ParamMouthOpenX"]);
    expect(out.map((p) => p.id)).toEqual(["ParamBrowLY", "m_042"]);
  });

  it("tanpa role apertur termap (rig tanpa param mulut) → konteks utuh", () => {
    const out = dropApertureParamCtx(ctx, []);
    expect(out).toHaveLength(4);
  });

  it("nama di-mangle tetap tersaring — saringan berbasis id ter-resolve, bukan nama", () => {
    const mangled = [{ id: "p_001", min: 0, max: 1 }, { id: "p_002", min: 0, max: 1 }];
    const out = dropApertureParamCtx(mangled, ["p_001"]);
    expect(out.map((p) => p.id)).toEqual(["p_002"]);
  });
});
