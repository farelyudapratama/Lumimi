/**
 * baseline-release.ts — pelepasan kepemilikan motion atas parameter.
 *
 * Motion native satu-satunya penulis persisten di pipeline dua fase: klip
 * yang selesai (atau di-stop) meninggalkan pose terakhirnya di buffer
 * saveParameters, dan tidak ada yang mengembalikannya — semua sistem lain
 * (gaze/liveliness/breath) menulis ADD di atas baseline itu dan Core
 * meng-clamp hasilnya ke range param. Param yang dianimasikan klip jadi
 * tertahan ("frozen") di pose akhir klip.
 *
 * Modul ini murni (tanpa import framework) — dipakai Live2DUserModel untuk
 * meng-ease parameter kurva klip kembali ke default model saat window play
 * berakhir. Angka selalu dari engine: id kurva dari klip, default dari
 * model — tanpa nama/id/range yang ditulis tangan.
 */

/** Kurva .motion3 bertarget parameter (CubismMotionCurveTarget.Parameter). */
export const CURVE_TARGET_PARAMETER = 1;

export interface MotionCurveLike {
  readonly id: unknown;
  readonly type: number;
}

/** Kumpulkan id kurva parameter dari entri antrean motion yang sedang main.
 * Id disimpan apa adanya (CubismIdHandle hasil interning parse .motion3 —
 * bentuk string tetap ditangani): getParameterIndex model membandingkan
 * handle yang SAMA, jadi string hasil getString() tidak pernah cocok. Entri
 * rusak dilewati; tanpa duplikat via sink. */
export function collectMotionCurveIds(
  entries: readonly unknown[] | null | undefined,
  target: number,
  sink: Set<unknown>,
): void {
  if (!entries) return;
  for (const entry of entries) {
    const curves = (entry as any)?._motion?._motionData?.curves as
      | readonly MotionCurveLike[]
      | undefined;
    if (!curves) continue;
    for (const curve of curves) {
      if (curve.type !== target) continue;
      if (curve.id != null) sink.add(curve.id);
    }
  }
}

export interface BaselineReleasePlan {
  readonly indices: number[];
  readonly from: number[];
  readonly to: number[];
}

/** Susun rencana pelepasan: param yang ADA di model saja (indeks valid),
 * dari nilai saat ini menuju default milik model. Null bila tak ada yang
 * perlu dilepas. Id diteruskan mentah (handle/string) ke getParamIndex. */
export function planBaselineRelease(
  ids: Iterable<unknown>,
  getParamIndex: (id: any) => number,
  getParamCount: () => number,
  getValue: (index: number) => number,
  getDefault: (index: number) => number,
): BaselineReleasePlan | null {
  const count = getParamCount();
  const indices: number[] = [];
  const from: number[] = [];
  const to: number[] = [];
  for (const id of ids) {
    const i = getParamIndex(id);
    if (i < 0 || i >= count) continue;
    indices.push(i);
    from.push(getValue(i));
    to.push(getDefault(i));
  }
  return indices.length ? { indices, from, to } : null;
}

/** easeInOutSine 0..1 — pulih mulus tanpa snap di kedua ujung. */
export function easeBaseline(k: number): number {
  const t = Math.max(0, Math.min(1, k));
  return (1 - Math.cos(t * Math.PI)) / 2;
}

/** Tulis nilai rencana pada fraksi k (0..1) lewat callback setValue. */
export function applyBaselineRelease(
  plan: BaselineReleasePlan,
  k: number,
  setValue: (index: number, value: number) => void,
): void {
  const e = easeBaseline(k);
  for (let i = 0; i < plan.indices.length; i++) {
    setValue(plan.indices[i], plan.from[i] + (plan.to[i] - plan.from[i]) * e);
  }
}
