/**
 * animation/motion-dsl.ts — Motion Asset DSL: parse/validate/convert/evaluate
 * Port of js/motion-dsl.js (UMD) to TypeScript — single source of truth.
 * Batas nilai per field HARUS identik dengan server — tiga jalur (preset gerak,
 * directive LLM, motion asset) pakai limit yang sama.
 */
import type { MotionAsset, MotionTrack, EasingMode } from "../../shared/types";
import { ease as easeFn, clamp } from "./easing";

// ── Field bounds (semantic role limits) ──────────────────────────
// Kosakata kanonik diperluas dari 8 field v1 (keputusan 2026-09-29): tambah
// az (tilt kepala), alis, senyum mata, dan buka mulut — semuanya role yang
// SUDAH dipetakan role-mapping.ts, jadi analisis disk/validator/rolesToParam
// otomatis mengikutinya lewat ROLE_FOR_FIELD. Nama gaya SPEC (angleZ/eyeX/…)
// diterima lewat ROLE_ALIASES lalu DIKANONISKAN ke field internal — supaya
// dedup track, gating capability, dan format file selalu satu kosakata.
// Dua kategori semantik nilai:
//   - simetris (default): 0 = netral, ±bound = ekstrem (ax/ay/az/ex/ey/…).
//   - deviasi-dari-default: 0 = default milik model, +1 = max, −1 = min
//     (smileL/smileR/mouthOpen — deviasi dari pose istirahat).
export const FIELD_BOUNDS: Record<string, number> = {
  ax: 30, ay: 30, az: 30, bodyX: 30, bodyY: 30, bodyZ: 30,
  ex: 1, ey: 1, mouthForm: 1,
  browLY: 1, browRY: 1, browLF: 1, browRF: 1,
  smileL: 1, smileR: 1, mouthOpen: 1,
};

// Kategori deviasi-dari-default tidak punya konstanta terprogram di sini:
// daftarnya hidup di sisi Rust (motion_dsl.rs) + pemakaiannya di app.js
// (targetDev) — konstanta TS yang dulu ada tidak pernah diimpor siapa pun.

export const ROLE_ALIASES: Record<string, string> = {
  angleX: "ax", angleY: "ay", angleZ: "az",
  eyeX: "ex", eyeY: "ey",
  bodyX: "bodyX", bodyY: "bodyY", bodyZ: "bodyZ",
  mouthForm: "mouthForm", mouthOpenY: "mouthOpen",
  eyeLSmile: "smileL", eyeRSmile: "smileR",
  browLForm: "browLF", browRForm: "browRF",
};

export const KNOWN_REQUIRES = ["head", "eyes", "mouth", "body", "brow"];

export const LIMITS = {
  idLen: 60, nameLen: 60, descLen: 400,
  tagLen: 30, tagsMax: 10,
  durationMin: 0.1, durationMax: 20,
  keysPerTrackMax: 64,
  tracksMax: 48,
  cooldownMax: 600000,
};

export const INTERP_MODES: EasingMode[] = ["linear", "ease-in", "ease-out", "ease-in-out", "stepped"];
export const PARAM_ABS_MAX = 1e6;

function isFiniteNum(v: unknown): boolean { return typeof v === "number" && Number.isFinite(v); }

export function normalizeTarget(name: string): string | null {
  if (typeof name !== "string") return null;
  const k = name.trim();
  if (Object.prototype.hasOwnProperty.call(FIELD_BOUNDS, k)) return k;
  if (Object.prototype.hasOwnProperty.call(ROLE_ALIASES, k)) return ROLE_ALIASES[k];
  return null;
}

function ease(t: number, mode: EasingMode): number { return easeFn(t, mode); }
export { ease };

// ── eval single track ────────────────────────────────────────────
export function evalTrack(track: MotionTrack, t: number): number {
  const keys = track.keys;
  if (!keys.length) return 0;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      const span = b.t - a.t;
      const mode = (a.easing as EasingMode) || track.interp || "linear";
      const f = span <= 0 ? 1 : ease((t - a.t) / span, mode);
      return a.v + (b.v - a.v) * f;
    }
  }
  return last.v;
}

export function fieldCapability(field: string): string {
  if (field === "ax" || field === "ay" || field === "az") return "head";
  if (field === "ex" || field === "ey" || field === "smileL" || field === "smileR") return "eyes";
  if (field === "mouthForm" || field === "mouthOpen") return "mouth";
  if (field === "browLY" || field === "browRY" || field === "browLF" || field === "browRF") return "brow";
  return "body";
}

// ── evaluateAsset (returns roles + params, plus __roles/__params alias keys) ──
// Paritas v1: roles HANYA berisi field kanonik (normalizeTarget mengkanoniskan
// alias sebelum clamp), jadi `roles` dan `__roles` selalu identik isinya.
export function evaluateAsset(
  asset: MotionAsset,
  t: number,
  intensity: number | undefined,
  supports?: Set<string> | null,
  ownedParams?: Set<string> | null
): Record<string, number> & { roles: Record<string, number>; params: Record<string, number>; __roles: Record<string, number>; __params: Record<string, number> } {
  const roles: Record<string, number> = {};
  const params: Record<string, number> = {};
  const inten = isFiniteNum(intensity) ? clamp(intensity as number, 0, 1) : (asset.intensity ? (asset.intensity as any).default : 0.8);
  for (const track of (asset.tracks || []) as any[]) {
    const tt = Math.max(0, t);
    if (track.kind === "param") {
      const id = typeof track.param === "string" ? track.param : null;
      if (!id) continue;
      if (ownedParams && ownedParams.size && !ownedParams.has(id)) continue;
      params[id] = evalTrack(track, tt);
      continue;
    }
    const target = normalizeTarget((track as any).target);
    if (!target) continue;
    if (supports && supports.size && !supports.has(fieldCapability(target))) continue;
    const scale = isFiniteNum((track as any).intensityScale) ? clamp((track as any).intensityScale, 0, 2) : 1;
    roles[target] = clamp(evalTrack(track, tt) * (inten as number) * scale, -FIELD_BOUNDS[target], FIELD_BOUNDS[target]);
  }
  const out: any = { roles, params, __roles: roles, __params: params };
  // Bentuk lama (objek delta polos) tetap dikembalikan lewat spread supaya
  // pemanggil lama — dan test yang membaca `.ax` langsung — tidak patah.
  Object.assign(out, roles, params);
  return out;
}

export function assetDurationMs(asset: MotionAsset): number {
  let maxT = 0;
  for (const tr of (asset.tracks || []) as any[]) for (const k of (tr.keys || [])) if (k.t > maxT) maxT = k.t;
  // Floor 200 ms — paritas dengan motion-dsl.js v1.
  const base = (asset.duration || 0) * 1000;
  return Math.max(base, maxT * 1000, 200);
}

// ── steps <-> tracks conversion ──────────────────────────────────
export function stepsToTracks(steps: any[]): any[] {
  const touched: string[] = [];
  const vals: Record<string, number> = {};
  const keysByField: Record<string, any[]> = {};
  let t = 0;
  for (const step of (steps || [])) {
    const d = (step && step.d) || {};
    const ms = (step && step.ms) || 0;
    const mentioned = new Set<string>();
    for (const k in d) {
      const target = normalizeTarget(k);
      if (!target || !isFiniteNum(d[k])) continue;
      if (!(target in vals)) { touched.push(target); vals[target] = 0; keysByField[target] = []; }
      vals[target] = d[k];
      mentioned.add(target);
    }
    for (const f of touched) if (!mentioned.has(f)) vals[f] = 0;
    if (ms > 0 && touched.length) {
      const tt = +(t / 1000).toFixed(3);
      for (const f of touched) {
        const v = +(vals[f] || 0).toFixed(3);
        const keys = keysByField[f];
        if (keys.length && keys[keys.length - 1].v === v) continue;
        keys.push({ t: tt, v });
      }
      t += ms;
    }
  }
  return Object.keys(keysByField).map(target => ({ target, interp: "linear" as EasingMode, keys: keysByField[target] }));
}

// ── sanitizeMotionAsset (single entrypoint for all motion writes) ──
export function sanitizeMotionAsset(raw: any, opts?: any): { ok: true; asset: MotionAsset } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const o = opts || {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["bukan objek motion"] };

  const id = String(raw.id || "").trim();
  if (!/^[A-Za-z0-9_\-]{1,60}$/.test(id)) errors.push("id tidak valid (1-60 karakter alfanumerik/_/-)");
  const name = String(raw.name || id).trim().slice(0, LIMITS.nameLen);
  let tags: string[] = [];
  if (raw.tags != null) {
    if (!Array.isArray(raw.tags)) errors.push("tags harus array");
    else tags = raw.tags.slice(0, LIMITS.tagsMax).map((t: any) => String(t).trim().toLowerCase().slice(0, LIMITS.tagLen)).filter(Boolean);
  }
  let duration = Number(raw.duration);
  if (!isFiniteNum(duration) || duration < LIMITS.durationMin) duration = 1;
  duration = Math.min(duration, LIMITS.durationMax);
  let intensity: any = { min: 0.3, max: 1.0, default: 0.8 };
  if (raw.intensity && typeof raw.intensity === "object") {
    const mn = isFiniteNum(raw.intensity.min) ? clamp(raw.intensity.min, 0, 1) : 0.3;
    const mx = isFiniteNum(raw.intensity.max) ? clamp(raw.intensity.max, 0, 1) : 1.0;
    const df = isFiniteNum(raw.intensity.default) ? clamp(raw.intensity.default, 0, 1) : 0.8;
    intensity = { min: Math.min(mn, mx), max: Math.max(mn, mx), default: clamp(df, Math.min(mn, mx), Math.max(mn, mx)) };
  }
  let emotionCompatibility: Record<string, number> = {};
  if (raw.emotionCompatibility && typeof raw.emotionCompatibility === "object") {
    for (const [emo, v] of Object.entries(raw.emotionCompatibility as Record<string, unknown>)) {
      if (!isFiniteNum(v)) continue;
      emotionCompatibility[String(emo).slice(0, 30)] = clamp(v as number, 0, 1);
    }
  }
  let cooldown = Number(raw.cooldown);
  if (!isFiniteNum(cooldown) || cooldown < 0) cooldown = 0;
  cooldown = Math.min(cooldown, LIMITS.cooldownMax);
  let priority = Number(raw.priority);
  if (!isFiniteNum(priority)) priority = 60;
  priority = clamp(Math.round(priority), 0, 100);
  const requires = (Array.isArray(raw.requires) ? raw.requires : []).map((r: any) => String(r).trim().toLowerCase()).filter((r: string) => KNOWN_REQUIRES.includes(r));

  const seen = new Set<string>();
  const tracks: any[] = [];
  if (raw.tracks != null) {
    if (!Array.isArray(raw.tracks)) errors.push("tracks harus array");
    else {
      for (const tr of raw.tracks.slice(0, LIMITS.tracksMax)) {
        const isParam = !!(tr && typeof tr.param === "string" && tr.param.trim());
        let target: string | null = null, paramId: string | null = null, seenKey: string | null = null;
        if (isParam) {
          paramId = tr.param.trim().slice(0, 120);
          seenKey = "param:" + paramId;
        } else {
          target = normalizeTarget(tr && tr.target);
          if (!target) { errors.push("track target tidak dikenal: " + (tr && tr.target)); continue; }
          seenKey = "role:" + target;
        }
        if (seen.has(seenKey!)) continue;
        seen.add(seenKey!);
        const bound = isParam ? PARAM_ABS_MAX : FIELD_BOUNDS[target!];
        const label = isParam ? paramId! : target!;
        const keys: any[] = [];
        for (const k of ((tr && tr.keys) || []).slice(0, LIMITS.keysPerTrackMax)) {
          const t = Number(k && k.t), v = Number(k && k.v);
          if (!isFiniteNum(t) || !isFiniteNum(v)) { errors.push("keyframe non-numerik di " + label); continue; }
          if (t < 0 || t > duration + 0.001) continue;
          const key: any = { t: +t.toFixed(3), v: clamp(v, -bound, bound) };
          if (INTERP_MODES.includes(k && k.easing)) key.easing = k.easing;
          keys.push(key);
        }
        keys.sort((a, b) => a.t - b.t);
        const merged: any[] = [];
        for (const k of keys) {
          if (merged.length && merged[merged.length - 1].t === k.t) merged[merged.length - 1] = k;
          else merged.push(k);
        }
        if (merged.length) {
          const interp: EasingMode = INTERP_MODES.includes(tr.interp) ? tr.interp : "linear";
          const intensityScale = isFiniteNum(tr.intensityScale) ? clamp(tr.intensityScale, 0, 2) : undefined;
          if (isParam) {
            const t: any = { kind: "param", param: paramId, interp, keys: merged };
            if (isFiniteNum(tr.min) && isFiniteNum(tr.max)) { t.min = Number(tr.min); t.max = Number(tr.max); }
            if (typeof tr.label === "string" && tr.label.trim()) t.label = tr.label.trim().slice(0, 80);
            tracks.push(t);
          } else {
            tracks.push(intensityScale != null ? { kind: "role", target, interp, intensityScale, keys: merged } : { kind: "role", target, interp, keys: merged });
          }
        }
      }
    }
  }
  if (o.requireTracks && !tracks.length) errors.push("minimal satu track keyframe diperlukan");
  if (errors.length) return { ok: false, errors };
  const asset: any = {
    version: 1, id, name,
    description: String(raw.description || "").trim().slice(0, LIMITS.descLen),
    tags, source: raw.source || o.source || "user",
    type: raw.type || (tracks.length ? "keyframe" : "gesture"),
    duration: +duration.toFixed(3), loop: !!raw.loop,
    intensity, emotionCompatibility, cooldown, priority,
    aiEnabled: raw.aiEnabled !== false, requires, tracks,
  };
  const hasParamTrack = tracks.some((t: any) => t.kind === "param");
  const srcModel = String(raw.sourceModelId || o.sourceModelId || "").trim().slice(0, 200);
  if (srcModel) asset.sourceModelId = srcModel;
  if (hasParamTrack) asset.modelScoped = true;
  return { ok: true, asset: asset as MotionAsset };
}

export const ROLE_FOR_FIELD: Record<string, string> = {
  ax: "angleX", ay: "angleY", az: "angleZ",
  ex: "eyeBallX", ey: "eyeBallY",
  bodyX: "bodyAngleX", bodyY: "bodyAngleY", bodyZ: "bodyAngleZ",
  mouthForm: "mouthForm", mouthOpen: "mouthOpenY",
  smileL: "eyeLSmile", smileR: "eyeRSmile",
  browLY: "browLY", browRY: "browRY", browLF: "browLForm", browRF: "browRForm",
};

export function rolesToParamTracks(asset: MotionAsset, roleMap: Record<string, string>, ranges: Record<string, { min: number; max: number; def: number }>): MotionAsset {
  if (!asset || !Array.isArray((asset as any).tracks)) return asset;
  const REF_HALF = 30;
  const out: any[] = [];
  for (const tr of (asset as any).tracks) {
    if (tr.kind === "param" || !tr.target) { out.push(tr); continue; }
    const role = ROLE_FOR_FIELD[tr.target];
    const id = role && roleMap ? roleMap[role] : null;
    const range = id && ranges ? ranges[id] : null;
    if (!id || !range || !isFiniteNum(range.min) || !isFiniteNum(range.max)) { out.push(tr); continue; }
    const half = FIELD_BOUNDS[tr.target] === 1 ? 1 : REF_HALF;
    const def = isFiniteNum(range.def) ? range.def : (range.min + range.max) / 2;
    const keys = tr.keys.map((k: any) => {
      const frac = clamp(k.v / half, -1, 1);
      const span = frac >= 0 ? (range.max - def) : (def - range.min);
      const key: any = { t: k.t, v: +(def + frac * span).toFixed(4) };
      if (k.easing) key.easing = k.easing;
      return key;
    });
    out.push({ kind: "param", param: id, interp: tr.interp || "linear", keys, min: range.min, max: range.max, label: tr.target });
  }
  return Object.assign({}, asset, { tracks: out, modelScoped: out.some((t: any) => t.kind === "param") });
}

export function summaryForLLM(asset: MotionAsset): any {
  const compatible = Object.entries((asset as any).emotionCompatibility || {}).filter(([, v]: any) => v >= 0.5).map(([k]) => k);
  return { id: (asset as any).id, description: (asset as any).description || (asset as any).name, tags: (asset as any).tags || [], compatibleEmotions: compatible, source: (asset as any).source, duration: (asset as any).duration };
}

export function validateMotion(asset: MotionAsset): string[] {
  // strict validation for tests — don't auto-fix duration like sanitizeMotionAsset does
  const errors: string[] = [];
  if (!asset.id) errors.push("id is required");
  if (asset.id && asset.id.length > LIMITS.idLen) errors.push("id too long");
  if ((asset.duration as any) < LIMITS.durationMin || (asset.duration as any) > LIMITS.durationMax) errors.push("duration out of range");
  if (!asset.tracks?.length) errors.push("at least one track required");
  if (asset.tracks && asset.tracks.length > LIMITS.tracksMax) errors.push("too many tracks");
  for (const track of (asset.tracks ?? []) as any[]) {
    if (!track.keys?.length) continue;
    if (track.keys.length > LIMITS.keysPerTrackMax) errors.push(`track ${track.target ?? track.param}: too many keyframes`);
    if (track.kind === "role" && track.target && !normalizeTarget(track.target)) errors.push(`unknown target: ${track.target}`);
    for (const key of (track as any).keys) { if (!Number.isFinite(key.t) || key.t < 0) errors.push("invalid keyframe time"); if (!Number.isFinite(key.v)) errors.push("invalid keyframe value"); }
  }
  return errors;
}
