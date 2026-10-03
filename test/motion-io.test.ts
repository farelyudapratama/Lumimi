// test/motion-io.test.ts — konversi dua arah Motion Asset ↔ .motion3.json.
// Ekspor: Meta konsisten, pemetaan easing→segmen, skip role tak terpetakan.
// Impor: keyframe & easing kembali, bezier non-baku disubdividi, gerbang
// sanitize (durasi ≤ 20 dtk) menghasilkan warning, PartOpacity dilewati.
import { describe, it, expect } from "bun:test";
import { toMotion3, motion3ToAsset } from "../src/client/animation/motion-io";
import { evaluateAsset } from "../src/client/animation/motion-dsl";
import type { MotionAsset } from "../src/shared/types";

const ROLE_MAP = { angleX: "ParamAngleX", angleZ: "ParamAngleZ", mouthOpenY: "ParamMouthOpenY" };
const RANGES = {
  ParamAngleX: { min: -30, max: 30, def: 0 },
  ParamAngleZ: { min: -30, max: 30, def: 0 },
  ParamMouthOpenY: { min: 0, max: 1, def: 0 },
};

function asset(partial: Partial<MotionAsset>): MotionAsset {
  return {
    version: 1,
    id: "uji",
    name: "Uji",
    description: "",
    tags: [],
    source: "user",
    type: "keyframe",
    duration: 2,
    loop: false,
    intensity: { min: 0.3, max: 1, default: 0.8 },
    emotionCompatibility: {},
    cooldown: 0,
    priority: 60,
    aiEnabled: true,
    requires: [],
    tracks: [],
    ...partial,
  } as MotionAsset;
}

describe("toMotion3 (ekspor)", () => {
  it("role track ter-resolve ke parameter + Meta konsisten", () => {
    const a = asset({
      tracks: [
        { kind: "role", target: "ax", interp: "linear", keys: [{ t: 0, v: 0 }, { t: 1, v: 15 }] } as any,
        { kind: "role", target: "az", interp: "linear", keys: [{ t: 0, v: 0 }, { t: 2, v: 10 }] } as any,
      ],
    });
    const res = toMotion3(a, { roleMap: ROLE_MAP, ranges: RANGES });
    expect(res.errors).toEqual([]);
    expect(res.skipped).toEqual([]);
    const j = res.json as any;
    expect(j.Version).toBe(3);
    expect(j.Curves).toHaveLength(2);
    expect(j.Curves[0].Id).toBe("ParamAngleX");
    // Skala referensi: role ±30 → nilai nyata dalam range model.
    // Format Cubism: [t0, v0, tipe, t, v] → [0, 0, LINEAR, 1, 15].
    expect(j.Curves[0].Segments).toEqual([0, 0, 0, 1, 15]);
    // Meta dihitung dari isi kurva.
    expect(j.Meta.CurveCount).toBe(2);
    expect(j.Meta.Duration).toBe(2);
    // Titik = titik awal kurva [t0,v0] + ujung tiap segmen (bezier menyumbang 3).
    // Segmen mulai di indeks 2 (dua angka pertama = titik awal).
    const points = j.Curves.reduce((s: number, c: any) => {
      let n = 1;
      for (let i = 2; i < c.Segments.length; ) {
        const bezier = c.Segments[i] === 1;
        n += bezier ? 3 : 1;
        i += bezier ? 7 : 3;
      }
      return s + n;
    }, 0);
    expect(j.Meta.TotalPointCount).toBe(points);
    const segments = j.Curves.reduce((s: number, c: any) => {
      let n = 0;
      for (let i = 2; i < c.Segments.length; ) {
        n++;
        i += c.Segments[i] === 1 ? 7 : 3;
      }
      return s + n;
    }, 0);
    expect(j.Meta.TotalSegmentCount).toBe(segments);
  });

  it("easing DSL → tipe segmen native (stepped=2, ease-*=bezier kontrol)", () => {
    const a = asset({
      tracks: [
        {
          kind: "param",
          param: "ParamAngleX",
          interp: "linear",
          keys: [
            { t: 0, v: 0, easing: "stepped" },
            { t: 1, v: 5, easing: "ease-in-out" },
            { t: 2, v: 10 },
          ],
        } as any,
      ],
    });
    const j = toMotion3(a, { roleMap: ROLE_MAP, ranges: RANGES }).json as any;
    const segs = j.Curves[0].Segments;
    // [t0, v0], stepped(2) ke (1,5), bezier(1) 3 titik kontrol ke (2,10).
    expect(segs).toEqual([
      0, 0,
      2, 1, 5,
      1, 1.42, 5, 1.58, 10, 2, 10,
    ]);
  });

  it("role tak terpetakan dilaporkan di skipped, bukan ditebak", () => {
    const a = asset({
      tracks: [{ kind: "role", target: "ax", interp: "linear", keys: [{ t: 0, v: 0 }] } as any],
    });
    const res = toMotion3(a, { roleMap: {}, ranges: {} });
    expect(res.json).toBeNull();
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].target).toBe("ax");
  });

  it("loop + fade mengikuti asset/opsi", () => {
    const a = asset({ loop: true, tracks: [
      { kind: "param", param: "ParamAngleX", interp: "linear", keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } as any,
    ] });
    const j = toMotion3(a, { roleMap: ROLE_MAP, ranges: RANGES }).json as any;
    expect(j.Meta.Loop).toBe(true);
    expect(j.FadeInTime).toBe(0.12);
    const j2 = toMotion3(a, { roleMap: ROLE_MAP, ranges: RANGES, fadeIn: 0.5, fadeOut: 0.5 }).json as any;
    expect(j2.FadeInTime).toBe(0.5);
  });
});

describe("motion3ToAsset (impor)", () => {
  it("membaca kurva linear/stepped + easing menempel di key awal ruas", () => {
    const res = motion3ToAsset({
      Version: 3,
      Meta: { Duration: 2, Loop: true },
      Curves: [
        {
          Target: "Parameter",
          Id: "ParamAngleX",
          // [t0=0, v0=0], stepped(2)→(1,7), linear(0)→(2,10).
          Segments: [0, 0, 2, 1, 7, 0, 2, 10],
        },
      ],
    }, { id: "uji_impor", sourceModelId: "hana" });
    expect(res.errors).toEqual([]);
    const a = res.asset as any;
    expect(a.loop).toBe(true);
    expect(a.sourceModelId).toBe("hana");
    expect(a.tracks[0].param).toBe("ParamAngleX");
    expect(a.tracks[0].keys).toEqual([
      { t: 0, v: 0, easing: "stepped" },
      { t: 1, v: 7 },
      { t: 2, v: 10 },
    ]);
  });

  it("kurva datar 2-titik tetap datar — durasi TIDAK bocor jadi nilai (regresi mtn_03)", () => {
    // Native asli: [t0=0, v0=0, LINEAR, t1=4.4, v1=0] — param diam di 0
    // sepanjang 4.4 dtk. Bug lama membaca indeks geser → nilai jadi 4.4.
    const res = motion3ToAsset({
      Meta: { Duration: 4.4 },
      Curves: [{ Target: "Parameter", Id: "ParamCheek", Segments: [0, 0, 0, 4.4, 0] }],
    }, { id: "datar" });
    expect(res.errors).toEqual([]);
    const keys = (res.asset as any).tracks[0].keys;
    expect(keys).toEqual([{ t: 0, v: 0 }, { t: 4.4, v: 0 }]);
    // Tidak boleh ada keyframe yang nilainya = durasi klip.
    expect(keys.some((k: any) => k.v === 4.4)).toBe(false);
  });

  it("bezier bentuk ease dikenali; bezier asing disubdividi linear", () => {
    // ease-in-out: kontrol (0.42,0)(0.58,1) fraksi → nilai absolut.
    const seg = (x1: number, y1: number, x2: number, y2: number) =>
      motion3ToAsset({
        Meta: { Duration: 1 },
        Curves: [{ Target: "Model", Id: "ParamAngleZ" }].map((c: any) => ({
      ...c,
      // [t0=0, v0=0], bezier(1) kontrol (x1,y1)(x2,y2) → (1,1).
      Segments: [0, 0, 1, x1, y1, x2, y2, 1, 1],
    })),
      }, { id: "bz" });
    const known = seg(0.42, 0, 0.58, 1).asset as any;
    expect(known.tracks[0].keys).toEqual([{ t: 0, v: 0, easing: "ease-in-out" }, { t: 1, v: 1 }]);
    // Kontrol acak → subdividi (lebih dari 2 key, nilai tetap dalam kurva).
    const wild = seg(0.2, 0.9, 0.8, 0.1).asset as any;
    expect(wild.tracks[0].keys.length).toBeGreaterThan(2);
    // Sampling kubik tetap lewat sekitar titik kontrol (monotonik t).
    const ts = wild.tracks[0].keys.map((k: any) => k.t);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
  });

  it("PartOpacity dilewati + warning; inverse-stepped diemulasi lompat awal", () => {
    const res = motion3ToAsset({
      Meta: { Duration: 2 },
      Curves: [
        { Target: "PartOpacity", Id: "PartHair", Segments: [0, 1, 0, 0.5, 1] },
        { Target: "Parameter", Id: "ParamAngleX", Segments: [0, 0, 3, 1, 9, 0, 2, 9] },
      ],
    }, { id: "campur" });
    expect(res.asset).not.toBeNull();
    expect(res.warnings.some((w) => w.includes("PartOpacity"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("inverse-stepped"))).toBe(true);
    const a = res.asset as any;
    expect(a.tracks).toHaveLength(1);
    // Nilai ujung ruas berlaku sejak t=0 (lompatan di awal ruas).
    expect(a.tracks[0].keys[0]).toMatchObject({ t: 0, v: 9 });
  });

  it("durasi native > 20 dtk terpotong oleh gerbang sanitize + warning", () => {
    const res = motion3ToAsset({
      Meta: { Duration: 30 },
      Curves: [
        { Target: "Parameter", Id: "ParamAngleX", Segments: [0, 0, 0, 25, 5, 0, 30, 0] },
      ],
    }, { id: "panjang" });
    expect(res.asset).not.toBeNull();
    expect((res.asset as any).duration).toBe(20);
    expect(res.warnings.some((w) => w.includes("dipotong"))).toBe(true);
  });

  it("round-trip: ekspor → impor → evaluasi bernilai sama", () => {
    const a = asset({
      tracks: [
        {
          kind: "param",
          param: "ParamAngleX",
          interp: "linear",
          keys: [
            { t: 0, v: -10, easing: "ease-in-out" },
            { t: 1.5, v: 20 },
          ],
        } as any,
      ],
    });
    const j = toMotion3(a, { roleMap: ROLE_MAP, ranges: RANGES }).json as any;
    const back = motion3ToAsset(j, { id: "rt" }).asset as any;
    const tr = back.tracks[0];
    expect(tr.param).toBe("ParamAngleX");
    expect(tr.keys.map((k: any) => [k.t, k.v])).toEqual([[0, -10], [1.5, 20]]);
    // Evaluasi di beberapa sampel sama dengan asset asli.
    for (const t of [0, 0.25, 0.5, 0.75, 1, 1.5]) {
      const v0 = evaluateAsset(a, t, 1, null).params.ParamAngleX;
      const v1 = evaluateAsset(back, t, 1, null).params.ParamAngleX;
      expect(Math.abs(v0 - v1)).toBeLessThan(0.01);
    }
  });
});
