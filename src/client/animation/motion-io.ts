/**
 * animation/motion-io.ts — konversi dua arah Motion Asset ↔ .motion3.json.
 *
 * Ekspor (toMotion3) memakai gerakan buatan Motion Studio/AI di luar
 * aplikasi (Live2D Viewer, engine lain); impor (motion3ToAsset) membuka
 * klip native model untuk diedit di Studio (native asli tak tersentuh —
 * hasil edit disimpan sebagai motion user). Metadata semantik Asset
 * (description/tags/emosi/intensity) tidak punya padanan di motion3.json:
 * sumber kebenaran tetap file .motion.json, .motion3.json hasil ekspor.
 *
 * Model-agnostic: track role di-resolve lewat roleMap + range milik model
 * AKTIF (pemanggil menyediakan; modul ini murni, tanpa id/range hardcode).
 * Sebaliknya, kurva native ber-id parameter mentah — impor menyimpannya
 * sebagai track kind:"param" terikat sourceModelId; parameter yang tak ada
 * di model lain dilewati anggun oleh runtime (paritas "track abu-abu").
 */
import type { MotionAsset, EasingMode } from "../../shared/types";
import { LIMITS, normalizeTarget, rolesToParamTracks, sanitizeMotionAsset } from "./motion-dsl";

// Tipe segmen motion3.json (spec Cubism).
const SEG_LINEAR = 0;
const SEG_BEZIER = 1;
const SEG_STEPPED = 2;
const SEG_INVERSE_STEPPED = 3;

// Easing DSL (easing.ts) → bentuk kontrol bezier setara gaya cubic-bezier
// CSS (fraksi Δt / Δv dari titik awal ruas). Linear/stepped punya segmen
// native sendiri; ease-* tidak — jadinya bezier.
const EASE_CONTROL: Partial<Record<EasingMode, [number, number, number, number]>> = {
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

const round4 = (v: number) => +Number(v).toFixed(4);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ── Ekspor: Motion Asset → motion3.json ──────────────────────────────

export interface ToMotion3Opts {
  /** role name (angleX, mouthOpenY, …) → parameter id milik model aktif. */
  roleMap: Record<string, string>;
  /** parameter id → range milik model (untuk mengonversi skala referensi). */
  ranges: Record<string, { min: number; max: number; def: number }>;
  /** detik; default mengikuti blend default runtime (120 ms / 250 ms). */
  fadeIn?: number;
  fadeOut?: number;
}

export interface ToMotion3Result {
  json: Record<string, unknown> | null;
  skipped: { target: string; reason: string }[];
  errors: string[];
}

export function toMotion3(asset: MotionAsset, opts: ToMotion3Opts): ToMotion3Result {
  const skipped: ToMotion3Result["skipped"] = [];
  const errors: string[] = [];
  if (!asset || !Array.isArray((asset as any).tracks)) {
    return { json: null, skipped, errors: ["motion tanpa tracks"] };
  }

  // Role → parameter (skala referensi → range model). Target field kanonik
  // dulu (alias SPEC seperti "angleX" dikanoniskan) — track role yang tak
  // terpetakan dilaporkan, jangan ditebak (aturan model-agnostic).
  const normalized: any = {
    ...(asset as any),
    tracks: (asset as any).tracks.map((tr: any) =>
      tr && tr.kind !== "param" && tr.target
        ? { ...tr, target: normalizeTarget(tr.target) || tr.target }
        : tr,
    ),
  };
  const resolved = rolesToParamTracks(normalized, opts.roleMap || {}, opts.ranges || {}) as any;
  for (const tr of resolved.tracks) {
    if (tr.kind !== "param") {
      skipped.push({
        target: String(tr.target || "?"),
        reason: "role tidak terpetakan ke parameter model ini",
      });
    }
  }

  const curves: Record<string, unknown>[] = [];
  let totalSegments = 0;
  let totalPoints = 0;
  let duration = 0;
  for (const tr of resolved.tracks) {
    if (tr.kind !== "param" || !Array.isArray(tr.keys)) continue;
    const keys = tr.keys.filter((k: any) => finite(k?.t) && finite(k?.v));
    if (!keys.length) continue;
    // Kurva motion3 diawali titik pertama [t0, v0] (format Cubism), sisanya
    // daftar segmen.
    const curve: unknown[] = [round4(keys[0].t), round4(keys[0].v)];
    totalPoints += 1;
    let segCount = 0;
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      const dt = b.t - a.t;
      const dv = b.v - a.v;
      if (dt <= 0) continue; // key duplikat-waktu — sudah di-merge sanitize
      const mode: EasingMode = a.easing || tr.interp || "linear";
      const ctrl = EASE_CONTROL[mode];
      if (mode === "stepped") {
        curve.push(SEG_STEPPED, round4(b.t), round4(b.v));
        totalPoints += 1;
      } else if (ctrl) {
        curve.push(
          SEG_BEZIER,
          round4(a.t + ctrl[0] * dt), round4(a.v + ctrl[1] * dv),
          round4(a.t + ctrl[2] * dt), round4(a.v + ctrl[3] * dv),
          round4(b.t), round4(b.v),
        );
        totalPoints += 3;
      } else {
        curve.push(SEG_LINEAR, round4(b.t), round4(b.v));
        totalPoints += 1;
      }
      segCount += 1;
    }
    if (segCount > 0) {
      curves.push({ Target: "Parameter", Id: tr.param, Segments: curve });
      totalSegments += segCount;
    }
    duration = Math.max(duration, keys[keys.length - 1].t);
  }

  if (!curves.length) {
    errors.push("tidak ada track yang bisa diekspor (role belum terpetakan / track kosong)");
    return { json: null, skipped, errors };
  }

  const json = {
    // Format native Cubism — urutan field mengikuti ekspor Cubism Animator.
    Version: 3,
    Meta: {
      Duration: round4(duration),
      Fps: 30,
      Loop: !!asset.loop,
      AreBeziersRestricted: true,
      CurveCount: curves.length,
      TotalSegmentCount: totalSegments,
      TotalPointCount: totalPoints,
      UserDataCount: 0,
      TotalUserDataSize: 0,
    },
    Curves: curves,
    FadeInTime: finite(opts.fadeIn) ? opts.fadeIn : 0.12,
    FadeOutTime: finite(opts.fadeOut) ? opts.fadeOut : 0.25,
  };
  return { json, skipped, errors };
}

// ── Impor: motion3.json → Motion Asset ───────────────────────────────

export interface FromMotion3Opts {
  id?: string;
  name?: string;
  sourceModelId?: string;
}

export interface FromMotion3Result {
  asset: MotionAsset | null;
  warnings: string[];
  errors: string[];
}

export function motion3ToAsset(raw: unknown, opts?: FromMotion3Opts): FromMotion3Result {
  const warnings: string[] = [];
  const errors: string[] = [];
  const doc = raw as any;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.Curves)) {
    return { asset: null, warnings, errors: ["bukan .motion3.json (Curves tidak ditemukan)"] };
  }
  const meta = doc.Meta && typeof doc.Meta === "object" ? doc.Meta : {};

  let warnedPart = false;
  let warnedInverse = false;
  let warnedUnknown = false;
  const tracks: any[] = [];
  let rawKeyCount = 0;
  for (const c of doc.Curves) {
    if (!c || typeof c !== "object") continue;
    const target = String(c.Target || "");
    if (/^partopacity$/i.test(target)) {
      if (!warnedPart) {
        warnings.push("kurva PartOpacity dilewati — editor belum mendukung track part");
        warnedPart = true;
      }
      continue;
    }
    // "Model" dan "Parameter" sama-sama kurva parameter di parser Cubism.
    const id = typeof c.Id === "string" ? c.Id.trim() : "";
    if (!id) continue;
    const segs = Array.isArray(c.Segments) ? c.Segments : null;
    if (!segs || !segs.length) continue;
    const keys = curveSegmentsToKeys(segs, warnings, {
      onInverse() {
        if (!warnedInverse) {
          warnings.push("segmen inverse-stepped diemulasi sebagai lompatan di awal ruas");
          warnedInverse = true;
        }
      },
      onUnknown(type: number) {
        if (!warnedUnknown) {
          warnings.push(`tipe segmen tidak dikenal (${type}) — sisa kurva itu dilewati`);
          warnedUnknown = true;
        }
      },
    });
    if (keys.length) {
      rawKeyCount += keys.length;
      tracks.push({ kind: "param", param: id.slice(0, 120), interp: "linear", keys });
    }
  }
  if (!tracks.length) {
    errors.push("tidak ada kurva parameter yang bisa dibaca");
    return { asset: null, warnings, errors };
  }

  const maxT = Math.max(...tracks.map((t) => t.keys[t.keys.length - 1].t));
  // id dari stem file / pilihan user — slug sama dengan saveDraft.
  const id =
    String(opts?.id || "")
      .replace(/[^A-Za-z0-9_\-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, LIMITS.idLen) || "impor_motion";
  const name = String(opts?.name || id).trim().slice(0, LIMITS.nameLen) || id;

  const rawAsset = {
    version: 1,
    id,
    name,
    description: "Impor klip motion native (.motion3.json)",
    tags: [],
    source: "user",
    type: "keyframe",
    // Gerbang sanitize membatasi 20 dtk — klip lebih panjang terpotong
    // (disorot di warning; klip native asli tetap utuh di model).
    duration: Math.min(Math.max(round4(maxT), LIMITS.durationMin), LIMITS.durationMax),
    loop: meta.Loop === true,
    intensity: { min: 0.3, max: 1.0, default: 0.8 },
    emotionCompatibility: {},
    cooldown: 0,
    priority: 60,
    aiEnabled: true,
    requires: [],
    tracks,
    sourceModelId: String(opts?.sourceModelId || "").slice(0, 200),
  };
  const sanitized = sanitizeMotionAsset(rawAsset, {
    requireTracks: true,
    source: "user",
    sourceModelId: rawAsset.sourceModelId,
  });
  if (!sanitized.ok) {
    return { asset: null, warnings, errors: sanitized.errors };
  }
  const afterKeys = sanitized.asset.tracks.reduce(
    (s: number, t: any) => s + (t.keys?.length || 0),
    0,
  );
  if (afterKeys < rawKeyCount) {
    warnings.push(`${rawKeyCount - afterKeys} keyframe di luar batas editor dibuang`);
  }
  if (maxT > LIMITS.durationMax) {
    warnings.push(`durasi native ${round4(maxT)} dtk dipotong ke ${LIMITS.durationMax} dtk`);
  }
  return { asset: sanitized.asset, warnings, errors };
}

/** Ubah daftar Segmen motion3 → keyframe DSL. Easing DSL menempel di key
 * AWAL ruas (paritas evalTrack: a.easing menjembatani a→b). */
function curveSegmentsToKeys(
  segs: unknown[],
  warnings: string[],
  notify: { onInverse(): void; onUnknown(type: number): void },
): any[] {
  // Format Cubism: Segments diawali DUA angka titik pertama [t0, v0], baru
  // deretan segmen. (Titik awal motion native praktis selalu t0=0, tapi
  // dibaca apa adanya biar setia.)
  const t0 = Number(segs[0]);
  const v0 = Number(segs[1]);
  if (!finite(t0) || !finite(v0)) return [];
  const keys: any[] = [{ t: round4(t0), v: round4(v0) }];
  let prev = keys[0];
  let i = 2;
  while (i < segs.length) {
    const type = Number(segs[i]);
    i += 1;
    if (type === SEG_LINEAR || type === SEG_STEPPED) {
      const t = Number(segs[i]);
      const v = Number(segs[i + 1]);
      i += 2;
      if (!finite(t) || !finite(v)) break;
      if (type === SEG_STEPPED) prev.easing = "stepped";
      prev = { t: round4(t), v: round4(v) };
      keys.push(prev);
    } else if (type === SEG_BEZIER) {
      const x1 = Number(segs[i]);
      const y1 = Number(segs[i + 1]);
      const x2 = Number(segs[i + 2]);
      const y2 = Number(segs[i + 3]);
      const t1 = Number(segs[i + 4]);
      const v1 = Number(segs[i + 5]);
      i += 6;
      if (![x1, y1, x2, y2, t1, v1].every(finite)) break;
      const mode = classifyBezier(prev.t, prev.v, t1, v1, x1, y1, x2, y2);
      if (mode) {
        if (mode !== "linear") prev.easing = mode;
        prev = { t: round4(t1), v: round4(v1) };
        keys.push(prev);
      } else {
        // Bezier non-baku: dipecah jadi ruas linear (sampling kubik) —
        // bentuk mendekati aslinya, tetap sah untuk evaluator DSL.
        const n = 8;
        for (let s = 1; s <= n; s++) {
          const u = s / n;
          const pt = cubicBezierAt(prev.t, prev.v, x1, y1, x2, y2, t1, v1, u);
          const k = { t: round4(pt[0]), v: round4(pt[1]) };
          if (s < n) keys.push(k);
          else prev = k;
        }
        keys.push(prev);
      }
    } else if (type === SEG_INVERSE_STEPPED) {
      const t = Number(segs[i]);
      const v = Number(segs[i + 1]);
      i += 2;
      if (!finite(t) || !finite(v)) break;
      notify.onInverse();
      // Nilai ujung berlaku SEJAK awal ruas: key duplikat-waktu digabung
      // sanitize (yang terbaru menang) → lompatan tepat di t awal ruas.
      keys.push({ t: prev.t, v: round4(v) });
      prev = { t: round4(t), v: round4(v) };
      keys.push(prev);
    } else {
      notify.onUnknown(type);
      break;
    }
  }
  return keys;
}

/** Kelaskan kontrol bezier ke mode easing DSL bila bentuknya dikenali
 * (ekspor Cubism biasanya terbatas pada pola ease); null = perlu subdividi. */
function classifyBezier(
  t0: number, v0: number, t1: number, v1: number,
  x1: number, y1: number, x2: number, y2: number,
): EasingMode | null {
  const dt = t1 - t0;
  const dv = v1 - v0;
  if (dt <= 0) return null;
  if (dv === 0) return "linear"; // ruas datar — semua easing setara
  const n1x = (x1 - t0) / dt;
  const n1y = (y1 - v0) / dv;
  const n2x = (x2 - t0) / dt;
  const n2y = (y2 - v0) / dv;
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.12;
  if (near(n1x, 0.42) && near(n1y, 0) && near(n2x, 1) && near(n2y, 1)) return "ease-in";
  if (near(n1x, 0) && near(n1y, 0) && near(n2x, 0.58) && near(n2y, 1)) return "ease-out";
  if (near(n1x, 0.42) && near(n1y, 0) && near(n2x, 0.58) && near(n2y, 1)) return "ease-in-out";
  if (near(n1x, n1y) && near(n2x, n2y)) return "linear";
  return null;
}

/** Titik kubik bezier (t,v) — untuk subdividi bezier non-baku. */
function cubicBezierAt(
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
  u: number,
): [number, number] {
  const iu = 1 - u;
  const a = iu * iu * iu;
  const b = 3 * iu * iu * u;
  const c = 3 * iu * u * u;
  const d = u * u * u;
  return [
    a * x0 + b * x1 + c * x2 + d * x3,
    a * y0 + b * y1 + c * y2 + d * y3,
  ];
}
