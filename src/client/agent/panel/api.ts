import type { Lifecycle } from "../../lifecycle";

export type AssistantStatus = {
  running?: boolean;
  busy?: boolean;
  workDir?: string | null;
  /** Panjang history runtime — sumber re-sync transcript untuk task yang
   *  disubmit di luar panel (hand-off companion / CLI). */
  historyCount?: number;
  /** kind: "plan" = kartu approval rencana kerja (Fase 2) — bukan izin tool. */
  pendingApprovals?: Array<{ id: string; tool: string; args: any; kind?: string | null }>;
  plan?: any[];
  notes?: { filesTouched?: string[] };
  tools?: Array<{ name: string; level: "safe" | "mutating" }>;
  /** Task identity Worker (§9): slot aktif + antrean menunggu (drain FIFO). */
  activeTask?: { taskId: string; status: string; prompt: string } | null;
  parkedTasks?: Array<{ taskId: string; prompt: string }>;
};

export function createAssistantApi(origin: string) {
  async function json<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(origin + path, { signal });
    return response.json() as Promise<T>;
  }
  return {
    status: (signal?: AbortSignal) => json<AssistantStatus>("/api/assistant/status", signal),
    history: (signal?: AbortSignal) => json<any[]>("/api/assistant/history", signal),
    events: (since: number, signal?: AbortSignal) =>
      json<{ latest?: number; busy?: boolean; events?: any[] }>("/api/assistant/events?since=" + since, signal),
  };
}

/** Jalankan poll hanya sesudah boot selesai dan lifecycle masih aktif. */
export async function bootThenPoll(
  lifecycle: Lifecycle,
  boot: (signal: AbortSignal) => Promise<void>,
  polls: Array<{ run: () => void; ms: number }>,
): Promise<void> {
  const request = lifecycle.controller();
  try { await boot(request.signal); } catch (error) {
    if (!request.signal.aborted) throw error;
  }
  if (!lifecycle.alive) return;
  for (const poll of polls) lifecycle.interval(poll.run, poll.ms);
  for (const poll of polls) poll.run();
}
