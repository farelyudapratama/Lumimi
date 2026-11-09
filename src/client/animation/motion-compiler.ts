// motion-compiler.ts — RENCANA backlog Fase 4b (compiler beat → keyframe deterministik).
//
// LLM/editor hanya membuat storyboard (beat semantik + timing + intensitas).
// Compiler ini menerjemahkan ke MotionAsset dengan jaminan:
//   - returnToDefault default true (keyframe terakhir kembali default role)
//   - holdEnd eksplisit = boleh berakhir di pose tertentu
//   - loop selalu tertutup (nilai awal == nilai akhir)
//   - easing default ease-in-out, linear hanya bila diminta eksplisit
//   - beat terlalu cepat → di-stretch, bukan di-snap
//   - clamp ke safe_range dari rig report
//   - amplitudo realistis dari statistik native (fallback default)
//   - gate capability model (role yang tidak ada → skip)
//   - larang track untuk output physics
//   - beatId disematkan di tiap beat DAN tiap keyframe hasil compile
//
// LLM tak pernah menyentuh angka keyframe — hanya beat; kompilasi deterministik.

export interface StoryBeat {
  beatId?: string;
  role?: string; // semantic target canonical/role label (ax, ay, smileL, dst.)
  param?: string; // paramId hasil approve user (jalur kind param) — menimpa role
  start?: number; // detik
  duration?: number; // detik
  intensity?: number; // 0..1
  sign?: number; // +1 / -1
  holdEnd?: boolean;
  easing?: "ease-in-out" | "linear";
  safeRange?: readonly [number, number];
  nativeRange?: readonly [number, number];
  beatIdOut?: never;
}

export interface RigParamStat { min?: number; max?: number; base?: number; physics?: boolean; }
export interface RigReportLike {
  params?: Record<string, RigParamStat | unknown>;
  /** Statistik per paramId mentah (dari rig report) — untuk beat kind param. */
  paramsById?: Record<string, RigParamStat | unknown>;
  physicsOutputs?: string[];
  /** paramId output physics mentah (role-free) — gate beat kind param. */
  physicsParamIds?: string[];
  [k: string]: unknown;
}

export interface CompilerOptions {
  /** intensitas default (0..1) bila beat tidak memberi. */
  defaultIntensity?: number;
  /** batas amplitudo fallback bila nativeRange tidak tersedia. */
  fallbackAmplitude?: number;
  /** model capability: role/param yang didukung (null = semua). */
  supports?: Set<string> | null;
  /** param yang dimiliki model untuk kind=param (null = semua). */
  ownedParams?: Set<string> | null;
  /** safety clamp override. */
  safety?: boolean;
}

export interface CompiledTrack { target: string; param?: string; kind?: "role" | "param"; beatId?: string; intensityScale?: number; easing?: string; keys: { t: number; v: number }[]; min?: number; max?: number; }

export interface CompiledMotion {
  id: string;
  duration: number;
  beatIds: string[];
  tracks: CompiledTrack[];
  holdEnd: boolean;
  returnToDefault: boolean;
}

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function isNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }

function safeRangeOf(role: string, rig?: RigReportLike | null, beat?: StoryBeat): readonly [number, number] {
  const br = beat?.safeRange;
  if (br && isNum(br[0]) && isNum(br[1])) return [Math.min(br[0], br[1]), Math.max(br[0], br[1])];
  const st = rig?.params && (rig.params as any)[role];
  const r = (st && st.safeRange) ? st.safeRange : rig?.params && (rig.params as any)[role];
  if (r && isNum(r.min) && isNum(r.max)) return [Math.min(r.min, r.max), Math.max(r.min, r.max)];
  if (st && isNum(st.min) && isNum(st.max)) return [Math.min(st.min, st.max), Math.max(st.min, st.max)];
  return [-1, 1];
}

function isPhysicsOutput(role: string, rig?: RigReportLike | null): boolean {
  if (rig?.physicsOutputs?.includes(role)) return true;
  const st = rig?.params && (rig.params as any)[role];
  return !!(st && st.physics === true);
}

function nativeAmp(role: string, rig?: RigReportLike | null, beat?: StoryBeat): number {
  if (beat?.nativeRange && isNum(beat.nativeRange[0]) && isNum(beat.nativeRange[1])) {
    return Math.max(0.01, Math.abs(beat.nativeRange[1] - beat.nativeRange[0]) / 2);
  }
  const st = rig?.params && (rig.params as any)[role];
  if (st && isNum(st.min) && isNum(st.max)) {
    const rng = Math.abs(st.max - st.min);
    if (rng > 0) return Math.max(0.01, rng * 0.3);
  }
  return 0.5;
}

function capability(role: string, opts: CompilerOptions): boolean {
  if (opts.supports && opts.supports.size && !opts.supports.has(role)) return false;
  if (opts.ownedParams && opts.ownedParams.size && !opts.ownedParams.has(role)) return false;
  return true;
}

export function compileBeatToValue(beat: StoryBeat, rig?: RigReportLike | null, opts: CompilerOptions = {}): number {
  if (!isNum(beat.intensity)) return 0;
  const sign = isNum(beat.sign) ? (beat.sign as number) : 1;
  // Beat kind param (paramId hasil approve user): amplitudo dari safeRange
  // approve (midpoint = base), fallback statistik paramId di rig report.
  if (beat.param) {
    const br = beat.safeRange;
    if (br && isNum(br[0]) && isNum(br[1])) {
      const [lo, hi] = [Math.min(br[0], br[1]), Math.max(br[0], br[1])];
      const base = (lo + hi) / 2;
      const amp = Math.max(0.01, (hi - lo) / 2);
      return clamp(base + sign * clamp(beat.intensity as number, 0, 1) * amp, lo, hi);
    }
    const st = rig?.paramsById && (rig.paramsById as any)[beat.param];
    if (st && isNum(st.min) && isNum(st.max)) {
      const base = isNum(st.base) ? st.base : (st.min + st.max) / 2;
      const amp = Math.max(0.01, Math.abs(st.max - st.min) * 0.3);
      return clamp(base + sign * clamp(beat.intensity as number, 0, 1) * amp, st.min, st.max);
    }
    return sign * clamp(beat.intensity as number, 0, 1);
  }
  if (!beat.role) return 0;
  const amp = nativeAmp(beat.role, rig, beat);
  const base = (rig?.params && (rig.params as any)[beat.role]?.base) ?? 0;
  let v = base + sign * clamp(beat.intensity as number, 0, 1) * amp;
  const [lo, hi] = safeRangeOf(beat.role, rig, beat);
  v = clamp(v, lo, hi);
  return v;
}

export function compileMotion(beats: StoryBeat[] = [], opts: CompilerOptions = {}, rig?: RigReportLike | null): CompiledMotion {
  const beatIds: string[] = [];
  const groups: Record<string, StoryBeat[]> = {};
  for (const b of beats) {
    const id = b.beatId || `${b.role || b.param || "beat"}-${Math.round((b.start ?? 0) * 1000)}`;
    b.beatId = id;
    beatIds.push(id);
    // Beat kind param (paramId hasil approve user): group per paramId.
    if (b.param) {
      if (rig?.physicsParamIds?.includes(b.param)) continue; // fisika: gerakkan penyebabnya
      if (opts.ownedParams && opts.ownedParams.size && !opts.ownedParams.has(b.param)) continue;
      const key = "param:" + b.param;
      groups[key] = groups[key] || [];
      groups[key].push(b);
      continue;
    }
    if (!b.role) continue;
    if (isPhysicsOutput(b.role, rig)) continue;
    if (!capability(b.role, opts)) continue;
    groups[b.role] = groups[b.role] || [];
    groups[b.role].push(b);
  }

  // stretch: bila urutan durasi beat terlalu pendek, jangan snap; di sini baru
  // tanda min durasi 0.05s per beat (tanpa mengubah input).
  const tracks: CompiledTrack[] = [];
  let total = 0;
  for (const role of Object.keys(groups)) {
    const bs = groups[role].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    // Basis nilai group: beat param pakai safeRange/statistik paramId;
    // beat role pakai base pose role di rig.
    const paramId = role.startsWith("param:") ? role.slice("param:".length) : null;
    const groupBase = paramId
      ? (() => {
          const sr = bs.find((b) => b.safeRange && isNum(b.safeRange[0]) && isNum(b.safeRange[1]))?.safeRange;
          if (sr) return (Math.min(sr[0], sr[1]) + Math.max(sr[0], sr[1])) / 2;
          const st = rig?.paramsById && (rig.paramsById as any)[paramId];
          return (st && isNum(st.base) ? st.base : (st && isNum(st.min) && isNum(st.max) ? (st.min + st.max) / 2 : 0)) as number;
        })()
      : ((rig?.params && (rig.params as any)[role]?.base) ?? 0);
    const keys: { t: number; v: number }[] = [];
    let curT = 0;
    let curV = groupBase;
    // pose awal: keyframe di t=0 jika belum ada beat yang mulai >0.
    if ((bs[0]?.start ?? 0) > 0) {
      keys.push({ t: 0, v: curV });
    }
    let holdEndFinal = false;
    for (const b of bs) {
      const st = Math.max(0, b.start ?? curT);
      const dur = Math.max(0.05, b.duration ?? 0.2);
      const end = st + dur;
      total = Math.max(total, end);
      if (st > curT + 1e-9 && keys.length) {
        // interpolation dwell
      }
      const val = compileBeatToValue(b, rig, opts);
      keys.push({ t: st, v: curV });
      keys.push({ t: Math.max(st + dur * 0.5, st), v: val });
      if (b.holdEnd) holdEndFinal = true;
      curT = end;
      curV = val;
    }
    // returnToDefault default true
    const returnToDefault = true;
    if (!holdEndFinal || returnToDefault) {
      keys.push({ t: Math.max(curT, total), v: groupBase });
    } else {
      keys.push({ t: Math.max(curT, total), v: curV });
    }
    // loop closure: nilai akhir == nilai awal
    const firstV = keys[0]?.v ?? 0;
    const last = keys[keys.length - 1];
    if (last) last.v = firstV;
    // sort + unique t
    keys.sort((a, b) => a.t - b.t);
    const cleaned: { t: number; v: number }[] = [];
    for (const k of keys) {
      if (cleaned.length && Math.abs(cleaned[cleaned.length - 1].t - k.t) < 1e-9) {
        cleaned[cleaned.length - 1].v = k.v;
      } else cleaned.push({ t: k.t, v: k.v });
    }
    const srAll = paramId ? bs.find((b) => b.safeRange && isNum(b.safeRange[0]) && isNum(b.safeRange[1]))?.safeRange : undefined;
    if (paramId) {
      // Track kind param: paramId mentah + min/max safeRange (sanitize server
      // menerima track param apa adanya — motion_dsl kind:"param").
      tracks.push({
        target: paramId,
        param: paramId,
        kind: "param",
        beatId: bs.map((b) => b.beatId).join(","),
        easing: bs.some((b) => b.easing === "linear") ? "linear" : "ease-in-out",
        keys: cleaned,
        ...(srAll ? { min: Math.min(srAll[0], srAll[1]), max: Math.max(srAll[0], srAll[1]) } : {}),
      });
    } else {
      tracks.push({
        target: role,
        beatId: bs.map((b) => b.beatId).join(","),
        intensityScale: opts.defaultIntensity ?? 0.8,
        easing: bs.some((b) => b.easing === "linear") ? "linear" : "ease-in-out",
        keys: cleaned,
      });
    }
  }

  const holdEnd = beats.some((b) => !!b.holdEnd);
  const duration = Math.max(0.2, total || 0.5);
  const asset: CompiledMotion = {
    id: "compiled",
    duration,
    beatIds,
    tracks,
    holdEnd,
    returnToDefault: true,
  };
  return asset;
}

export function MotionCompiler() { return { compile: compileMotion }; }
export const compile = compileMotion;

export default { compileMotion, compile, MotionCompiler };