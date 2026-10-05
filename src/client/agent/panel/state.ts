/**
 * state.ts — derivasi state machine agent untuk garis keadaan (Fase 3).
 *
 * Murni dari data /api/assistant/status + jam client: tidak ada DOM, semua
 * keputusan diuji unit. Kontrak keadaan (urutan prioritas):
 *   off            → runtime tidak hidup
 *   waitingPlan    → kartu approval rencana menunggu (Fase 2)
 *   waitingApproval→ kartu izin tool menunggu (Fase 1)
 *   executing      → busy + event bus terakhir tool_call_start (label = tool)
 *   thinking       → busy tanpa tool aktif
 *   idle           → runtime hidup, tidak busy
 *
 * Elapsed memakai jam server untuk event/approval (loopback, mesin yang
 * sama) dan jam client untuk fase thinking (busySinceMs dari panel).
 */

export type AgentState =
  | "off"
  | "waitingPlan"
  | "waitingApproval"
  | "executing"
  | "thinking"
  | "idle";

export type AgentStateView = {
  state: AgentState;
  /** Objek pekerjaan konkret: nama tool / perintah / "rencana kerja". */
  what: string;
  /** Berapa lama berada di keadaan ini (0 bila tidak relevan). */
  elapsedMs: number;
  stepsDone: number;
  stepsTotal: number;
  filesTouched: number;
};

type StatusInput = {
  running?: boolean;
  busy?: boolean;
  pendingApprovals?: Array<{ id: string; tool: string; args: any; kind?: string | null; ts?: number | null }>;
  plan?: any[];
  notes?: { filesTouched?: string[] };
  lastEvent?: { seq?: number; type: string; label: string; ts: number } | null;
};

function approvalElapsed(ts: unknown, nowMs: number): number {
  return typeof ts === "number" && ts > 0 ? Math.max(0, nowMs - ts) : 0;
}

export function deriveAgentState(st: StatusInput, busySinceMs: number, nowMs: number): AgentStateView {
  const plan = Array.isArray(st.plan) ? st.plan : [];
  const sv: AgentStateView = {
    state: "off",
    what: "",
    elapsedMs: 0,
    stepsDone: plan.filter((p) => p?.status === "done").length,
    stepsTotal: plan.length,
    filesTouched: st.notes?.filesTouched?.length ?? 0,
  };
  if (!st.running) return sv;

  const pend = st.pendingApprovals ?? [];
  const planAp = pend.find((a) => a?.kind === "plan");
  if (planAp) {
    sv.state = "waitingPlan";
    sv.what = "rencana kerja";
    sv.elapsedMs = approvalElapsed(planAp.ts, nowMs);
    return sv;
  }
  if (pend.length) {
    sv.state = "waitingApproval";
    const ap = pend[pend.length - 1];
    sv.what = ap.tool;
    if (ap.tool === "run_command" && typeof ap.args?.command === "string") {
      sv.what = "run_command · " + String(ap.args.command).trim().slice(0, 60);
    }
    sv.elapsedMs = approvalElapsed(ap.ts, nowMs);
    return sv;
  }

  if (!st.busy) {
    sv.state = "idle";
    return sv;
  }
  const ev = st.lastEvent;
  if (ev && ev.type === "tool_call_start") {
    sv.state = "executing";
    sv.what = ev.label;
    sv.elapsedMs = approvalElapsed(ev.ts, nowMs);
    return sv;
  }
  sv.state = "thinking";
  sv.elapsedMs = busySinceMs > 0 ? Math.max(0, nowMs - busySinceMs) : 0;
  return sv;
}
