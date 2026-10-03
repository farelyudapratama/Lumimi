/**
 * test/baseline-release.test.ts — pelepasan kepemilikan motion atas
 * parameter HARUS tetap benar saat nama/urutan arbitrer (model-agnostic).
 *
 * Kelas cacat yang difalsifikasi: release yang mengambil makna dari indeks
 * array atau nama param tertentu; dan release yang menulis param yang tidak
 * dimiliki model (harus di-skip, bukan error).
 */
import { describe, expect, it } from "bun:test";
import {
  applyBaselineRelease,
  collectMotionCurveIds,
  CURVE_TARGET_PARAMETER,
  easeBaseline,
  planBaselineRelease,
} from "../src/live2d/baseline-release";

const fakeEntry = (
  curves: Array<{ id: unknown; type: number }>,
) => ({ _motion: { _motionData: { curves } } });

describe("collectMotionCurveIds", () => {
  it("hanya kurva parameter yang dikumpulkan (model/part diabaikan)", () => {
    const sink = new Set<unknown>();
    collectMotionCurveIds(
      [
        fakeEntry([
          { id: "ParamAngleX", type: CURVE_TARGET_PARAMETER },
          { id: "PartArmA", type: 2 },
          { id: "Opacity", type: 0 },
        ]),
      ],
      CURVE_TARGET_PARAMETER,
      sink,
    );
    expect([...sink]).toEqual(["ParamAngleX"]);
  });

  it("id non-string (bentuk handle CubismId) diteruskan mentah ke sink", () => {
    const sink = new Set<unknown>();
    const handle = { getString: () => "m_001" };
    collectMotionCurveIds(
      [fakeEntry([{ id: handle, type: 1 }])],
      CURVE_TARGET_PARAMETER,
      sink,
    );
    expect(sink.has(handle)).toBe(true);
    expect(sink.size).toBe(1);
  });

  it("entri rusak (null motion/kurva) dilewati tanpa error, dedupe antar entri", () => {
    const sink = new Set<unknown>();
    collectMotionCurveIds(
      [
        null,
        {},
        { _motion: null },
        { _motion: { _motionData: null } },
        fakeEntry([{ id: "ParamA", type: 1 }]),
        fakeEntry([{ id: "ParamA", type: 1 }, { id: "ParamB", type: 1 }]),
      ] as any,
      CURVE_TARGET_PARAMETER,
      sink,
    );
    expect([...sink].sort()).toEqual(["ParamA", "ParamB"]);
  });
});

describe("planBaselineRelease", () => {
  const makeModel = () => {
    // Model opaque: id tak punya makna; param di luar count = tidak ada.
    const ids = ["m_003", "m_007", "m_011"];
    const defaults = [10, -5, 0];
    return {
      getParamIndex: (id: string) => ids.indexOf(id),
      getParamCount: () => ids.length,
      getValue: (i: number) => [30, -30, 3][i],
      getDefault: (i: number) => defaults[i],
    };
  };

  it("param yang tidak ada di model di-skip (bukan error)", () => {
    const m = makeModel();
    const plan = planBaselineRelease(
      ["m_007", "m_tidak_ada"],
      m.getParamIndex,
      m.getParamCount,
      m.getValue,
      m.getDefault,
    );
    expect(plan).not.toBeNull();
    expect(plan!.indices).toEqual([1]);
    expect(plan!.from).toEqual([-30]);
    expect(plan!.to).toEqual([-5]);
  });

  it("tidak ada param valid → null (tak ada yang ditulis)", () => {
    const m = makeModel();
    const plan = planBaselineRelease(
      ["m_xxx", "m_yyy"],
      m.getParamIndex,
      m.getParamCount,
      m.getValue,
      m.getDefault,
    );
    expect(plan).toBeNull();
  });
});

describe("easeBaseline & applyBaselineRelease", () => {
  it("monotonik, ujung 0/1 tepat, tengah 0.5", () => {
    expect(easeBaseline(0)).toBe(0);
    expect(easeBaseline(1)).toBe(1);
    expect(easeBaseline(0.5)).toBeCloseTo(0.5, 10);
    let prev = -1;
    for (let k = 0; k <= 1.0001; k += 0.05) {
      const e = easeBaseline(k);
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
  });

  it("fraksi k di luar 0..1 di-clamp tanpa lompatan", () => {
    expect(easeBaseline(-0.5)).toBe(0);
    expect(easeBaseline(1.5)).toBe(1);
  });

  it("interpolasi from→to mengikuti ease, nilai akhir = default", () => {
    const plan = { indices: [0, 2], from: [30, -3], to: [0, 10] };
    const written: Record<number, number> = {};
    applyBaselineRelease(plan, 0, (i, v) => (written[i] = v));
    expect(written[0]).toBe(30);
    applyBaselineRelease(plan, 1, (i, v) => (written[i] = v));
    expect(written[0]).toBe(0);
    expect(written[2]).toBe(10);
    applyBaselineRelease(plan, 0.5, (i, v) => (written[i] = v));
    expect(written[0]).toBeCloseTo(15, 10);
  });
});
