/**
 * pet/brain — keputusan idle + siklus doze untuk Desktop Pet.
 *
 * Keputusan idle: POST /api/behavior/decide (role LLM "behavior",
 * behavior.rs) — output bertipe {action, emotion, gaze, motion, holdMs}
 * yang kosakatanya KITA yang iklankan dari kemampuan nyata model
 * (Model-Agnostic: LLM tak bisa mengarang di luar daftar). engine=false /
 * gagal → siklus deterministik lokal (pet tetap hidup tanpa LLM).
 *
 * Doze: governor murni (histeresis idle) — masuk tidur setelah user pergi
 * (tak ada gerakan kursor), bangun saat input kembali. Efek mata ditulis
 * pet-entry via roles.ts (role space), bukan di sini — modul ini bebas DOM.
 */

/** Aksi idle bawaan (idle-safe, dari behavior.rs DEFAULT_ACTIONS). */
export const IDLE_ACTIONS = ["settle", "gaze-shift", "micro-fidget"] as const;

/** Emosi kosakata director/behavior (Indonesia, protokol antar-komponen). */
export const IDLE_EMOTIONS = ["senang", "sedih", "malu", "kaget", "normal"] as const;

export interface BehaviorDecision {
  action: string;
  emotion?: string | null;
  gaze?: string | null;
  motion?: string | null;
  holdMs?: number | null;
  confidence?: number | null;
}

export interface DecideRequest {
  state: { idleMs: number; lastActionMs?: number; timeOfDay?: string };
  capabilities: {
    actions: string[];
    emotions: string[];
    gazes: string[];
    motions: { id: string; description: string }[];
  };
}

/** Bentuk respons /api/behavior/decide (behavior.rs handle_decide). */
export interface DecideResponse {
  decision?: Partial<BehaviorDecision>;
  engine?: boolean;
  error?: string;
}

/** PostJSON injectable (transport.postJson) supaya test bisa stub. */
export type PostJson = <T = any>(path: string, body: unknown) => Promise<T>;

/** Validasi & normalisasi keputusan (cermin validate() behavior.rs sisi TS). */
export function normalizeDecision(raw: unknown, validMotions: Set<string>): BehaviorDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Partial<BehaviorDecision>;
  const action = String(d.action ?? "").trim();
  if (!action || !IDLE_ACTIONS.includes(action as (typeof IDLE_ACTIONS)[number])) return null;
  const motion = d.motion && validMotions.has(String(d.motion)) ? String(d.motion) : null;
  const hold = Number(d.holdMs);
  return {
    action,
    emotion: typeof d.emotion === "string" && d.emotion ? d.emotion : null,
    gaze: typeof d.gaze === "string" && d.gaze ? d.gaze : null,
    motion,
    holdMs: Number.isFinite(hold) ? Math.min(8000, Math.max(800, hold)) : null,
    confidence: typeof d.confidence === "number" ? d.confidence : null,
  };
}

/**
 * Minta keputusan ke /api/behavior/decide. Gagal / engine=false / keputusan
 * tak valid → null (pemanggil jatuh ke siklus lokal). Tidak pernah melempar.
 */
export async function requestDecision(
  post: PostJson,
  req: DecideRequest,
): Promise<BehaviorDecision | null> {
  try {
    const res = await post<DecideResponse>("/api/behavior/decide", req);
    if (!res || res.engine === false) return null;
    const valid = new Set(req.capabilities.motions.map((m) => m.id));
    return normalizeDecision(res.decision, valid);
  } catch {
    return null;
  }
}

/** RNG injectable (default Math.random) — test pakai seeder. */
export type Rng = () => number;

/**
 * Siklus lokal deterministik (fallback tanpa LLM): bergantian
 * settle → gaze-shift → micro-fidget dengan hold 2–4 dtk. Tanpa nama/id
 * model — murni kosakata aksi.
 */
export function localDecision(iteration: number, rng: Rng = Math.random): BehaviorDecision {
  const seq: BehaviorDecision["action"][] = ["settle", "gaze-shift", "micro-fidget", "gaze-shift"];
  const action = seq[iteration % seq.length];
  return {
    action,
    gaze: action === "settle" ? "face-user" : "glance",
    holdMs: 2000 + Math.floor(rng() * 2000),
    confidence: 0,
  };
}

// ── Governor doze (murni, histeresis) ────────────────────────────────────

export const IDLE_DEFAULTS = {
  /** User pergi (tak ada gerakan kursor) selama ini → doze. */
  dozeAfterMs: 10 * 60 * 1000,
};

export type AwakeState = "awake" | "doze";

export interface DozeGovernor {
  /** Update tiap detik; return keadaan baru. */
  update(nowMs: number, sinceMovementMs: number | null): AwakeState;
  state(): AwakeState;
}

export function createDozeGovernor(
  opts: { onEnter?: () => void; onExit?: () => void; dozeAfterMs?: number } = {},
): DozeGovernor {
  const afterMs = opts.dozeAfterMs ?? IDLE_DEFAULTS.dozeAfterMs;
  let st: AwakeState = "awake";
  return {
    update(nowMs, sinceMovementMs) {
      void nowMs;
      // null = belum ada sampel sama sekali (pet baru bangun) → tetap awake.
      const idle = sinceMovementMs ?? 0;
      if (st === "awake" && idle >= afterMs) {
        st = "doze";
        opts.onEnter?.();
      } else if (st === "doze" && idle < afterMs) {
        st = "awake";
        opts.onExit?.();
      }
      return st;
    },
    state() {
      return st;
    },
  };
}
