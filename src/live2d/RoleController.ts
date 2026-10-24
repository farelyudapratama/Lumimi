/** Role mapping → ParameterController (model-agnostic). */
import { mapRoles, writeRef, roleDefaultOf, type ParamRange } from "../client/engine/role-mapping";
import { ParameterController } from "./ParameterController";
import type { CubismModel } from "./cubism/model/cubismmodel";

export class RoleController {
  private roleToId: Record<string, string> = {};
  private rangeByRole: Record<string, ParamRange | null> = {};
  private paramCtrl: ParameterController;

  constructor(
    private model: CubismModel,
    paramSet: Set<string>,
    official?: { eyeBlinkIds: string[]; lipSyncIds: string[] },
    overrides?: Record<string, string> | null,
  ) {
    this.paramCtrl = new ParameterController(model);
    this.roleToId = mapRoles(paramSet, official, overrides);
    // bangun range per role
    for (const role in this.roleToId) {
      const id = this.roleToId[role];
      const info = this.paramCtrl.getParameterInfo(id);
      this.rangeByRole[role] = info ? { min: info.min, max: info.max, def: info.default } : null;
    }
  }

  getRoleMap(): Record<string, string> {
    return { ...this.roleToId };
  }

  /** Set role via skala referensi (±30 atau 0..1), dipetakan ke range model. */
  setRole(role: string, vRef: number): boolean {
    const id = this.roleToId[role];
    if (!id) return false;
    const r = this.rangeByRole[role];
    const actual = writeRef(role, vRef, r);
    return this.paramCtrl.setParameter(id, actual);
  }

  getRole(role: string): number | null {
    const id = this.roleToId[role];
    if (!id) return null;
    return this.paramCtrl.getParameter(id);
  }

  resetRole(role: string): boolean {
    const id = this.roleToId[role];
    if (!id) return false;
    const r = this.rangeByRole[role];
    return this.paramCtrl.setParameter(id, roleDefaultOf(r));
  }

  /** Hitung actual tanpa tulis — untuk arbiter. */
  resolveRole(role: string, vRef: number): { id: string; actual: number } | null {
    const id = this.roleToId[role];
    if (!id) return null;
    const r = this.rangeByRole[role];
    const actual = writeRef(role, vRef, r);
    return { id, actual };
  }

  /** Range aktual role (min/max/def dari model) — dasar penskalaan efek
   * (look/breath) supaya faktor std resmi dipetakan role-space, bukan
   * angka literal yang salah di rig 0..100. */
  roleInfo(role: string): { id: string; min: number; max: number; def: number } | null {
    const id = this.roleToId[role];
    if (!id) return null;
    const info = this.paramCtrl.getParameterInfo(id);
    if (!info) return null;
    return { id, min: info.min, max: info.max, def: info.default };
  }

  /** Default asli model untuk role (bukan 0-ref — eyeOpen dsb. default ≠ 0).
   * Dipakai jalur reset via arbiter supaya satu jalur tulis dengan source. */
  roleDefaultActual(role: string): { id: string; def: number } | null {
    const id = this.roleToId[role];
    if (!id) return null;
    const r = this.rangeByRole[role];
    return { id, def: roleDefaultOf(r) };
  }
}
