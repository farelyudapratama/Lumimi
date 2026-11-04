/**
 * pet/roles — tulis parameter Live2D HANYA lewat role space.
 *
 * Aturan wajib MODEL-AGNOSTIC-RULES: tidak ada id param bernomor/hardcode;
 * makna disimpulkan dari NAMA parameter (keyword EN/JA/ZH lewat mapRoles
 * role-mapping.ts) dan nilai dikonversi ke rentang MILIK model
 * (devToActual/normToRange). Dipakai pet untuk doze (mata melempem) dsb.
 * Murni — diuji bun test tanpa model sungguhan.
 */

import {
  devToActual,
  mapRoles,
  normToRange,
  type ParamRange,
} from "../engine/role-mapping";

/** Backend tulis minimal (padanan facade.internalModel.coreModel). */
export interface WriteBackend {
  setParameterValueById(id: string, v: number, w?: number): void;
}

/** Metadata rentang per param id (dari getModel() facade). */
export interface ParamMetaSource {
  getParameterCount(): number;
  getParameterId(i: number): string;
  getParameterMinimumValue(i: number): number;
  getParameterMaximumValue(i: number): number;
  getParameterDefaultValue(i: number): number;
}

export interface RoleWriter {
  /** role → paramId terpetakan (cosmetic/log). */
  ids(): Record<string, string>;
  /** Rentang milik model untuk role (null bila role tak dikenal model). */
  range(role: string): ParamRange | null;
  /** SET nilai role sebagai deviasi-dari-default (−1..1). */
  setDev(role: string, v: number): boolean;
  /** SET nilai role sebagai normalisasi min..max (0..1). */
  setNorm(role: string, t: number): boolean;
}

export function buildRoleWriter(
  paramIds: string[],
  meta: ParamMetaSource | null | undefined,
  backend: WriteBackend | null | undefined,
): RoleWriter {
  const paramSet = new Set(paramIds.filter((id) => typeof id === "string" && id));
  const roleMap = mapRoles(paramSet);
  const ranges: Record<string, ParamRange> = {};
  if (meta) {
    try {
      const n = meta.getParameterCount();
      for (let i = 0; i < n; i++) {
        const id = meta.getParameterId(i);
        if (!id || !paramSet.has(id)) continue;
        ranges[id] = {
          min: meta.getParameterMinimumValue(i),
          max: meta.getParameterMaximumValue(i),
          def: meta.getParameterDefaultValue(i),
        };
      }
    } catch {
      // meta tidak lengkap → role tanpa range: nilai di-clamp 0..1
    }
  }
  return {
    ids() {
      return { ...roleMap };
    },
    range(role: string): ParamRange | null {
      const id = roleMap[role];
      return id ? ranges[id] ?? null : null;
    },
    setDev(role: string, v: number): boolean {
      const id = roleMap[role];
      if (!id || !backend) return false;
      backend.setParameterValueById(id, devToActual(role, v, ranges[id]));
      return true;
    },
    setNorm(role: string, t: number): boolean {
      const id = roleMap[role];
      if (!id || !backend) return false;
      backend.setParameterValueById(id, normToRange(t, ranges[id]));
      return true;
    },
  };
}
