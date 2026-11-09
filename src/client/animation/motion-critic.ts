// motion-critic.ts — RENCANA backlog Fase 4c/4d (critic numerik + laporan terpetakan).
//
// Hanya membaca kurva (memberi skor & temuan), tidak mengubah asset.
// Sampling evaluateAsset per ~25 ms; threshold persentil dari klip native
// (opsional), fallback heuristik.

import { evaluateAsset } from "./motion-dsl";

export interface CriticFinding {
  kind: string;
  beatId?: string;
  role?: string;
  t?: number;
  value?: number;
  threshold?: number;
  message: string;
  severity: "info" | "warn" | "error";
}

export interface CriticReport {
  score: number;          // 0..100 (makin tinggi makin baik)
  findings: CriticFinding[];
  jerkP90?: number;
  heuristic: boolean;
  sampledPoints: number;
}

function isNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const s = [...sorted].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}

export function jerkSeries(values: number[], dt: number): number[] {
  const out: number[] = [];
  if (values.length < 3 || dt <= 0) return out;
  for (let i = 1; i < values.length - 1; i++) {
    const d2 = (values[i + 1] - 2 * values[i] + values[i - 1]) / (dt * dt);
    out.push(Math.abs(d2));
  }
  return out;
}

export interface CriticOptions {
  nativeJerkSamples?: number[]; // distribusi jerk dari klip native model
  pThreshold?: number; // default 0.9
  dt?: number; // detik, default 0.025
  holdEndTargets?: Set<string>;
}

export function critiqueMotionAsset(asset: any, opts: CriticOptions = {}): CriticReport {
  const findings: CriticFinding[] = [];
  const dt = opts.dt && opts.dt > 0 ? opts.dt : 0.025;
  const p = opts.pThreshold ?? 0.9;
  const duration = Math.max(0.2, Number(asset?.duration) || 1) ;
  const steps = Math.max(2, Math.ceil(duration / dt));
  let pointer = 0;
  const seriesByRole: Record<string, number[]> = {};
  const targetRoles = new Set<string>();
  for (const tr of (asset?.tracks || [])) targetRoles.add(tr.target);

  for (let i = 0; i <= steps; i++) {
    const t = Math.min(duration, i * dt);
    const out: any = evaluateAsset(asset, t, undefined, null, null);
    for (const role of targetRoles) {
      const v = out && (out.roles?.[role] ?? out[role]);
      if (!isNum(v)) continue;
      (seriesByRole[role] = seriesByRole[role] || []).push(v);
    }
  }

  // Jerk per role.
  let jerkP90: number | undefined;
  const heuristic = !(opts.nativeJerkSamples && opts.nativeJerkSamples.length);
  let p90 = NaN;
  if (heuristic) {
    p90 = 5; // fallback global
  } else {
    const s = [...(opts.nativeJerkSamples as number[])].sort((a, b) => a - b);
    p90 = percentile(s, p);
    if (!isNum(p90)) p90 = 5;
  }
  jerkP90 = p90;
  let violations = 0;
  for (const role of targetRoles) {
    const arr = seriesByRole[role] || [];
    const js = jerkSeries(arr, dt);
    for (let i = 0; i < js.length; i++) {
      if (js[i] > p90) {
        violations++;
        findings.push({
          kind: "jerk",
          role,
          t: (i + 1) * dt,
          value: js[i],
          threshold: p90,
          message: `jerk melonjak di ${(i + 1) * dt}s, role ${role}, ${js[i].toFixed(2)} > ${p90.toFixed(2)}`,
          severity: js[i] > p90 * 2 ? "error" : "warn",
        });
      }
    }
  }

  // End-stuck: nilai akhir != nilai awal (kecuali holdEnd eksplisit).
  for (const tr of (asset?.tracks || [])) {
    const ks = tr.keys || [];
    if (ks.length < 2) continue;
    const first = ks[0]?.v;
    const last = ks[ks.length - 1]?.v;
    const hold = !!(tr.holdEnd || asset?.holdEnd || (opts.holdEndTargets && opts.holdEndTargets.has(tr.target)));
    if (isNum(first) && isNum(last) && Math.abs(first - last) > 1e-6 && !hold) {
      findings.push({
        kind: "endStuck",
        role: tr.target,
        beatId: tr.beatId,
        message: `nilai akhir != default untuk ${tr.target} (${first} -> ${last})`,
        severity: "warn",
      });
    }
  }

  // Bound violation dari safeRange (jika ada di asset meta) — best effort
  // Discontinuity antar-keyframe bersebelahan (lonjakan > 50% rentang).
  for (const tr of (asset?.tracks || [])) {
    const ks = (tr.keys || []).slice().sort((a: any, b: any) => a.t - b.t);
    for (let i = 1; i < ks.length; i++) {
      const dtK = Math.max(1e-6, ks[i].t - ks[i - 1].t);
      const dv = Math.abs(ks[i].v - ks[i - 1].v);
      // crude discontinuity: perubahan > 10 per detik
      if (dv / dtK > 10) {
        findings.push({
          kind: "discontinuity",
          role: tr.target,
          beatId: tr.beatId,
          t: ks[i].t,
          value: dv / dtK,
          message: `lonjakan curam di ${ks[i].t}s pada ${tr.target}`,
          severity: "warn",
        });
      }
    }
  }

  // Contention: dua track rebutan field yang sama.
  const targetCount: Record<string, number> = {};
  for (const tr of (asset?.tracks || [])) targetCount[tr.target] = (targetCount[tr.target] || 0) + 1;
  for (const t of Object.keys(targetCount)) {
    if (targetCount[t] > 1) {
      findings.push({ kind: "contention", role: t, message: `dua track rebutan ${t}`, severity: "error" });
    }
  }

  // Output physics gate: track target ada di physicsOutputs (asset.meta).
  const phys = ((asset?.meta && asset.meta.physicsOutputs) || asset?.physicsOutputs) as string[] | undefined;
  if (Array.isArray(phys)) {
    for (const tr of (asset?.tracks || [])) {
      if (phys.includes(tr.target)) {
        findings.push({ kind: "physicsOutput", role: tr.target, message: `track untuk output physics ${tr.target} (seharusnya dilarang)`, severity: "error" });
      }
    }
  }

  const penalty = findings.reduce((acc, f) => acc + (f.severity === "error" ? 15 : f.severity === "warn" ? 7 : 2), 0);
  const score = clamp(100 - penalty, 0, 100);
  return {
    score,
    findings,
    jerkP90,
    heuristic,
    sampledPoints: (steps + 1) * targetRoles.size,
  };
}

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }

export function MotionCritic() { return { critique: (a: any, o?: CriticOptions) => critiqueMotionAsset(a, o) }; }
export function critiqueMotion(asset: any, opts?: CriticOptions) { return critiqueMotionAsset(asset, opts); }
export function critique(asset: any, opts?: CriticOptions) { return critiqueMotionAsset(asset, opts); }

export default { critiqueMotionAsset, MotionCritic, critique, critiqueMotion };