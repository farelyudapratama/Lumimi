/**
 * client/agent/panel/workbench.ts — Orchestrator Agent Workbench
 * (rebuild clean-slate 2026-10, menggantikan panel.ts).
 *
 * Kontrak mode (docs/MODES.md): workbench hanya LAYAR — runtime assistant
 * di server adalah layanan mandiri (CLI `bun run agent` memakai runtime
 * yang sama). destroy() melepas UI, TIDAK mematikan runtime.
 *
 * Sumber kebenaran (sama dengan kontrak lama, presentasi baru):
 *   - Kartu approval: satu-satunya sumber = pendingApprovals dari poll
 *     /status, keyed by apId. Event SSE/bus izin hanya pemicu refresh.
 *   - Plan: satu sumber = status.plan (kartu todo + progress dock).
 *   - Transcript: mode live (SSE) vs follow (bus). Protokol koneksi
 *     dua-kasus ada di stream.ts (decideFallback).
 *
 * Komposisi baru (CSS body.mode-agent): kolom kerja workbench (header
 * 48px + stream + approval + composer) = aplikasi utama; Live2D hadir
 * sebagai dock presence kanan (stage + tab Review/Terminal/Browser/Memory),
 * bisa dilipat jadi kapsul status.
 */

import { createLifecycle } from "../../lifecycle";
import { httpBase } from "../../transport";
import { deriveAgentState } from "./state";
import type { AgentStateView } from "./state";
import { createAssistantApi, bootThenPoll } from "./api";
import type { AssistantStatus } from "./api";
import { Transcript, historyNeedsSync } from "./transcript";
import type { Block } from "./transcript";
import { decideFallback, readSseStream, postJson } from "./stream";
import type { AsSseEvent } from "./stream";
import { ChangeRegistry, TermLog } from "./registry";
import { parseToolLabel } from "./transcript";
import { makeActor } from "./actor";
import { buildActivityItems, buildTodoItem } from "./workbench-model";
import { createWorkbenchView } from "./workbench-view";
import type { DockTab, ReviewEntryView } from "./workbench-view";

// Basis API panel: httpBase() DINAMIS — embedded (exe) → loopback proses
// sendiri via IPC `server_port`; dev → location.origin. Segarkan lagi di
// start() karena initLoopback bisa selesai setelah load.
let API = httpBase();
let assistantApi = createAssistantApi(API);
let activeDestroy: (() => void) | null = null;

/** Peta role→paramId untuk tool motion (motion_*). Inferensi role tetap
 *  sumber tunggal di engine (role-mapping.ts) — workbench hanya meneruskan
 *  hasilnya ke server. */
function collectRoleMap(): Record<string, string> {
  const out: Record<string, string> = {};
  const roleFor = window.MotionDSL?.ROLE_FOR_FIELD;
  const roleIdFor = window.__live2dAgent?.roleIdFor;
  if (!roleFor || !roleIdFor) return out;
  for (const field of Object.keys(roleFor)) {
    const id = roleIdFor(roleFor[field]);
    if (id) out[field] = id;
  }
  return out;
}

function getT() {
  const i = window.__i18n;
  return (k: string, v?: Record<string, string | number>) => (i ? i.t(k, v) : k);
}

/** Suara sebagai karakter — kelas speech menentukan hak preempt/queue
 *  (policy §15–16): narasi hasil akhir = konten (tier 1), quip/filler
 *  actor = dekoratif (tier 0). */
function speakAsCharacter(text: string, cls: string = "worker_actor"): void {
  if (!text) return;
  try { window.__addChat?.("agent", text); } catch {}
  try { window.__live2dAgent?.speak?.(text, undefined, { cls }); } catch {}
}

export function startWorkbench(): () => void {
  activeDestroy?.();
  API = httpBase();
  assistantApi = createAssistantApi(API);
  const t = getT();
  const root = document.getElementById("as-root");
  if (!root) return () => {};
  const rootEl: HTMLElement = root;
  // Dock teknis = #agent-tech (kolom kanan bawah dock presence);
  // #as-tech-root dipertahankan sebagai fallback lama.
  const techRootEl: HTMLElement | null =
    document.getElementById("agent-tech") || document.getElementById("as-tech-root");

  const lifecycle = createLifecycle();
  const requestSignal = lifecycle.controller().signal;
  let transcript = new Transcript();
  const registry = new ChangeRegistry();
  const termLog = new TermLog();
  const toolLevels = new Map<string, "safe" | "mutating">();
  let destroyBrowserPanel: (() => void) | null = null;
  let browserStarted = false;

  // State tampilan yang dipegang orchestrator (view tanpa state).
  const expanded = new Set<string>(); // key tool/grup terbuka (user klik)
  const changesOpen = new Set<string>(); // key kartu perubahan terbuka
  let todoOpen = true;
  let lastSv: AgentStateView | null = null;

  const agentName =
    document.querySelector(".sb-name")?.textContent?.trim() || t("as.agentName");

  const view = createWorkbenchView(rootEl, techRootEl, {
    agentName,
    onSend: (text) => send(text),
    onStop: () => { void stopAgent(); },
    onReset: () => { void resetAgent(); },
    onCancel: () => { void cancelTask(); },
    onMemory: () => {
      setTab(memoryLoaded ? "memory" : "progress");
      memoryLoaded = true;
      void loadMemory();
    },
    onDockToggle: () => toggleDock(),
    onWorkdirCommit: (v) => {
      void postJson(API + "/api/assistant/start", { workDir: v || undefined })
        .then((d) => {
          if (d?.warning) pushMarker("⚠ " + d.warning, "warn");
          else if (v) pushMarker(t("as.workdirSet", { dir: v }), "ok");
          render();
          refreshStatus();
        })
        .catch(() => {});
    },
    onApprove: (apId, ok, always) => approve(apId, ok, always),
    onToggle: (key) => {
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      render();
    },
    onToggleChanges: (key) => {
      if (changesOpen.has(key)) changesOpen.delete(key);
      else changesOpen.add(key);
      render();
    },
    onToggleTodo: () => {
      todoOpen = !todoOpen;
      render();
    },
    onJumpBottom: () => view.scrollToBottom(),
    onCancelTask: (taskId) => { void cancelTaskById(taskId); },
    onRevert: (path) => { void revertByPath(path); },
    onRefreshReview: () => { void refreshStatus(); },
    onForget: (key) => {
      void postJson(API + "/api/assistant/memory/forget", { key })
        .then(() => loadMemory())
        .catch(() => {});
    },
    onTab: (tab) => {
      setTab(tab);
      renderDock();
      if (tab === "browser") ensureBrowser();
      if (tab === "memory") { memoryLoaded = true; void loadMemory(); }
    },
    toolLevel: (name) => toolLevels.get(name) ?? null,
  });

  const actor = makeActor({
    L: window.__live2dAgent,
    t,
    post: (p, b) => postJson(API + p, b),
    speakAsCharacter,
  });

  let destroy = false;
  let lastSeq = 0;
  let prevBusy = false;
  let busySinceMs = 0;
  let currentPlan: any[] = [];
  let dockCollapsed = (() => {
    try { return localStorage.getItem("wb.dock.hidden") === "1"; } catch { return false; }
  })();
  let memoryLoaded = false;
  let memoryEntries: Array<{ key: string; value: string }> = [];
  let lastHistoryCount = -1;
  let liveAsk: { abort: AbortController; receivedAnyEvent: boolean } | null = null;
  let localApprovals = new Set<string>();
  let queuedApprovals: Array<{ id: string; ok: boolean; always: boolean }> = [];
  /** Kartu approval dari /status — sumber kebenaran zona kontrol. */
  let pendingApprovalViews: Array<{ apId: string; tool: string; args: any; plan: boolean }> = [];

  function applyDock(): void {
    document.body.classList.toggle("agent-dock-collapsed", dockCollapsed);
    try { localStorage.setItem("wb.dock.hidden", dockCollapsed ? "1" : "0"); } catch {}
  }

  function toggleDock(): void {
    dockCollapsed = !dockCollapsed;
    applyDock();
    renderHeader();
  }

  function setTab(tab: DockTab): void {
    view.setTab(tab);
  }

  function ensureBrowser(): void {
    if (browserStarted || !window.__browserPanel?.start) return;
    const mount = view.ensureBrowserMount();
    if (!mount) return;
    destroyBrowserPanel = window.__browserPanel.start() ?? null;
    browserStarted = true;
  }

  // ── Render ─────────────────────────────────────────────────────
  function renderHeader(): void {
    const streaming = !!liveAsk;
    view.setHeader({
      sv: lastSv,
      task: transcript.currentTask(),
      streaming,
      liveTask: !!(lastSv && lastSv.state !== "off" && lastSv.state !== "idle") || !!liveAsk,
      dockCollapsed,
    });
  }

  /** Sisipkan kartu todo di awal segmen aktif (setelah user terakhir). */
  function itemsForRender() {
    const items = buildActivityItems(transcript.blocks, expanded);
    const todo = buildTodoItem(currentPlan, expanded);
    if (!todo) return items;
    // Posisi: setelah user terakhir (segmen aktif); fallback: paling atas.
    let at = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === "user") { at = i + 1; break; }
    }
    return [...items.slice(0, at), todo, ...items.slice(at)];
  }

  function render(): void {
    view.setEmpty(transcript.blocks.length === 0 && !liveAsk);
    if (transcript.blocks.length || liveAsk) {
      view.renderItems(itemsForRender(), expanded, changesOpen, todoOpen);
    }
    view.composer.setBusy(!!liveAsk || isBusy(), !!liveAsk);
    renderHeader();
  }

  function isBusy(): boolean {
    return !!lastSv && (lastSv.state === "thinking" || lastSv.state === "executing");
  }

  function renderDock(): void {
    view.setDock({
      sv: lastSv,
      plan: currentPlan,
      queue: lastQueue,
      review: reviewEntries(),
      term: termLog.list(),
      memory: memoryEntries,
      filesTouched: lastFilesTouched,
    });
    view.setTabBadges({ review: reviewEntries().length, queue: lastQueue.length });
  }

  function reviewEntries(): ReviewEntryView[] {
    return registry.list().map((r) => ({
      path: r.path, kind: r.kind, added: r.added, removed: r.removed, measured: r.measured,
    }));
  }

  /** Status line kecil → marker timeline (bukan bubble). */
  function pushMarker(text: string, variant?: "ok" | "err" | "warn"): void {
    transcript.status(text, variant);
  }

  // ── Stream: ask & approve (protokol dua-kasus) ──────────────────
  function handleSse(ev: AsSseEvent): void {
    if (ev.type === "speak") {
      speakAsCharacter(ev.text, "worker_narration");
    }
    if (ev.type === "done" && ev.parked) {
      pushMarker(t("as.task.parked", { n: ev.position ?? 1 }), "warn");
      render();
      return;
    }
    if (ev.type === "tool_call") {
      if (ev.name === "run_command") {
        termLog.start(typeof ev.args?.command === "string" ? ev.args.command : "");
      } else {
        registry.record(ev.name, ev.args);
      }
    } else if (ev.type === "tool_result") {
      if (ev.name === "run_command") {
        termLog.end(ev.text);
      } else if (/^ERROR/.test(ev.text)) {
        const blocks = transcript.blocks.filter((b) => b.kind === "tool" && b.name === ev.name);
        const last = blocks[blocks.length - 1] as Extract<Block, { kind: "tool" }> | undefined;
        const path = last?.args && typeof last.args === "object" ? (last.args as any).path : null;
        registry.fail(ev.name, path ? { path } : null);
      }
    }
    transcript.applySse(ev);
    render();
    renderDock();
  }

  function finishLive(): void {
    liveAsk = null;
    transcript.endLive();
    pushTurnChangesMarker();
    render();
    refreshStatus();
    void syncHistory();
    if (queuedApprovals.length && !liveAsk) {
      const next = queuedApprovals.shift()!;
      localApprovals.add(next.id);
      transcript.resolveApprovalVisual(next.id, false);
      render();
      const body: Record<string, unknown> = { id: next.id, approve: next.ok };
      if (next.always) body.always = true;
      void runStream("/api/assistant/approve-stream", body, { path: "/api/assistant/approve", body });
    }
  }

  /** Path terukur saat giliran MULAI — dasar kartu ringkasan perubahan
   *  di akhir giliran (SSE tidak membawa event tool; data datang dari bus). */
  let turnStartPaths = new Set<string>();
  function snapshotTurnPaths(): void {
    turnStartPaths = new Set(registry.list().map((r) => r.path));
  }
  /** Ringkas perubahan giliran jadi marker ringkas (chrome rendah). */
  function pushTurnChangesMarker(): void {
    const now = registry.list().filter((r) => r.measured && !turnStartPaths.has(r.path));
    if (!now.length) return;
    let added = 0;
    let removed = 0;
    for (const f of now) { added += f.added; removed += f.removed; }
    const files = now.map((f) => f.path).join(", ");
    pushMarker(t("wb.chg.turn", { n: now.length, add: added, del: removed }) + " " + files, "ok");
  }

  async function runStream(
    path: string,
    body: Record<string, unknown>,
    fallback: { path: string; body: Record<string, unknown> },
  ): Promise<void> {
    const ac = new AbortController();
    liveAsk = { abort: ac, receivedAnyEvent: false };
    snapshotTurnPaths();
    transcript.beginLive();
    render();
    try {
      const r = await fetch(API + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      await readSseStream(r, (ev) => {
        if (liveAsk) liveAsk.receivedAnyEvent = true;
        handleSse(ev);
      }, ac.signal);
      finishLive();
    } catch (e) {
      const receivedAny = !!liveAsk?.receivedAnyEvent;
      const aborted = ac.signal.aborted;
      if (aborted) { finishLive(); return; }
      if (receivedAny) {
        // Kasus B: loop server pasti masih jalan — jangan kirim ulang.
        pushMarker(t("as.stream.dropped"), "warn");
        render();
        finishLive();
        return;
      }
      // Kasus A: belum ada event — cek status FRESH sebelum memutuskan.
      let busyNow = false;
      try { busyNow = !!(await assistantApi.status(requestSignal)).busy; } catch {}
      if (decideFallback({ receivedAnyEvent: false, busyNow }) === "resend") {
        try {
          const d = await postJson(API + fallback.path, fallback.body);
          if (d.parked) {
            pushMarker(t("as.task.parked", { n: d.position ?? 1 }), "warn");
          } else if (d.reply) {
            transcript.appendFinal(d.reply);
            if (d.speak) speakAsCharacter(d.speak, "worker_narration");
          }
        } catch (e2: any) {
          pushMarker("✗ " + (e2?.message || e2), "err");
        }
      } else {
        pushMarker(t("as.stream.dropped"), "warn");
      }
      render();
      finishLive();
    }
  }

  // ── Aksi workbench ─────────────────────────────────────────────
  function motionContext(): { model?: string; roleMap?: Record<string, string> } {
    const out: { model?: string; roleMap?: Record<string, string> } = {};
    const model = window.__live2dAgent?.modelKey?.();
    if (model) out.model = model;
    const roleMap = collectRoleMap();
    if (Object.keys(roleMap).length) out.roleMap = roleMap;
    return out;
  }

  function send(text: string): void {
    const txt = String(text || "").trim();
    if (!txt || liveAsk) return;
    transcript.appendUser(txt);
    // Tugas baru: buka giliran (auto-collapse grup selesai sudah di model).
    render();
    view.scrollToBottom();
    const ctx = motionContext();
    void runStream("/api/assistant/ask-stream", { text: txt, ...ctx }, { path: "/api/assistant/ask", body: { text: txt, ...ctx } });
  }

  function approve(apId: string, ok: boolean, always = false): void {
    if (liveAsk) {
      // Workbench sedang men-streaming giliran lain — antrekan keputusan.
      queuedApprovals.push({ id: apId, ok, always });
      return;
    }
    localApprovals.add(apId);
    transcript.resolveApprovalVisual(apId, false);
    render();
    const body: Record<string, unknown> = { id: apId, approve: ok };
    if (always) body.always = true;
    void runStream("/api/assistant/approve-stream", body, { path: "/api/assistant/approve", body });
  }

  async function loadMemory(): Promise<void> {
    try {
      const d = await fetch(API + "/api/assistant/memory").then((r) => r.json());
      memoryEntries = (d.entries || []).map((e: any) => ({ key: String(e.key ?? ""), value: String(e.value ?? "") }));
    } catch { memoryEntries = []; }
    renderDock();
  }

  async function stopAgent(): Promise<void> {
    try { await postJson(API + "/api/assistant/stop", {}); } catch {}
    liveAsk?.abort.abort();
    pushMarker(t("as.stopped"), "warn");
    render();
  }

  async function cancelTask(): Promise<void> {
    let accepted = false;
    try {
      const d = await postJson(API + "/api/assistant/cancel", {});
      accepted = !!d.accepted;
    } catch {}
    liveAsk?.abort.abort();
    pushMarker(accepted ? t("as.cancelSent") : t("as.cancelNone"), "warn");
    render();
    refreshStatus();
  }

  async function cancelTaskById(taskId: string): Promise<void> {
    if (!taskId) return;
    let accepted = false;
    try {
      const d = await postJson(API + "/api/assistant/cancel", { taskId });
      accepted = !!d.accepted;
    } catch {}
    pushMarker(accepted ? t("as.queue.cancelSent") : t("as.cancelNone"), "warn");
    render();
    refreshStatus();
  }

  async function resetAgent(): Promise<void> {
    try { await postJson(API + "/api/assistant/reset", {}); } catch {}
    transcript = new Transcript();
    registry.clear();
    termLog.clear();
    expanded.clear();
    changesOpen.clear();
    memoryLoaded = false;
    await syncHistory();
    pushMarker(t("as.resetDone"), "ok");
    render();
    renderDock();
  }

  async function revertByPath(path: string): Promise<void> {
    try {
      const entries: Array<{ id: string; path: string; reverted: boolean }> =
        await fetch(API + "/api/assistant/undo").then((r) => r.json()).then((d) => d.entries || []);
      const rec = entries.find((e) => e.path === path && !e.reverted);
      if (!rec) {
        pushMarker(t("as.review.revertNone", { path }), "warn");
        render();
        return;
      }
      const d = await postJson(API + "/api/assistant/revert", { id: rec.id });
      pushMarker(d.message || t("as.review.revertDone", { path }), "ok");
    } catch (e: any) {
      pushMarker("✗ " + (e?.message || e), "err");
    }
    render();
    refreshStatus();
    renderDock();
  }

  async function syncHistory(): Promise<void> {
    try {
      const hist = await assistantApi.history(requestSignal);
      if (destroy) return;
      transcript.syncFromHistory(hist);
      if (Array.isArray(hist)) lastHistoryCount = hist.length;
      render();
      renderDock();
    } catch {}
  }

  // ── Polling status (sumber kebenaran approval/plan/busy) ────────
  let lastQueue: Array<{ taskId: string; prompt: string }> = [];
  let lastFilesTouched = 0;

  async function refreshStatus(): Promise<void> {
    if (destroy) return;
    let st: AssistantStatus;
    try {
      st = await assistantApi.status(requestSignal);
    } catch {
      return;
    }
    if (st.busy && !prevBusy) busySinceMs = Date.now();
    if (!st.busy) busySinceMs = 0;
    lastSv = deriveAgentState(st, busySinceMs, Date.now());
    pendingApprovalViews = (st.pendingApprovals || []).map((a) => ({
      apId: a.id, tool: a.tool, args: a.args, plan: a.kind === "plan",
    }));
    currentPlan = st.plan || [];
    lastQueue = (st.parkedTasks || []).map((q) => ({ taskId: q.taskId, prompt: q.prompt }));
    lastFilesTouched = st.notes?.filesTouched?.length ?? 0;
    if (Array.isArray(st.tools) && st.tools.length) {
      toolLevels.clear();
      for (const tl of st.tools) toolLevels.set(tl.name, tl.level);
    }
    registry.mergeTouched(st.notes?.filesTouched || []);
    view.composer.setWorkdir(st.workDir || null);
    view.setControls(pendingApprovalViews);
    render();
    renderDock();
    // Rekonsiliasi approval: kartu hilang hanya lewat sini / resolve lokal.
    const pendingIds = (st.pendingApprovals || []).map((a) => a.id);
    for (const ap of st.pendingApprovals || []) {
      if (localApprovals.has(ap.id)) continue;
      transcript.ensureApproval(ap.id, ap.tool, ap.args, ap.kind === "plan");
    }
    const current = transcript.blocks
      .filter((b: Block): b is Extract<Block, { kind: "approval" }> => b.kind === "approval")
      .map((b) => b.apId);
    for (const apId of current) {
      if (pendingIds.includes(apId)) continue;
      if (localApprovals.has(apId)) continue;
      transcript.resolveApprovalVisual(apId, !!st.busy);
    }
    localApprovals = new Set([...localApprovals].filter((id) => pendingIds.includes(id)));
    transcript.reconcileApprovals(pendingIds);
    render();
    if (prevBusy && !st.busy && !liveAsk) await syncHistory();
    prevBusy = !!st.busy;
    const histCount = typeof st.historyCount === "number" ? st.historyCount : null;
    if (historyNeedsSync(histCount, lastHistoryCount, !!liveAsk)) {
      lastHistoryCount = histCount as number;
      await syncHistory();
    }
  }

  // ── Polling bus (actor + transcript) ────────────────────────────
  // Kebijakan presentasi workbench: bus BUKAN sumber kartu di mode follow —
  // konten sebenarnya (tool + hasil + jawaban final) dihidrat dari /history
  // (historyNeedsSync men-sync tiap historyCount berubah). Bus ke transcript
  // hanya membawa event yang TIDAK ada di history: verifikasi, subagent,
  // revisi plan, error. Duplikasi kartu "running tanpa hasil" dan marker
  // "berpikir…" tiap iterasi adalah noise ala chat, bukan harness.
  const BUS_LIVE = new Set([
    "tool_call_start", "tool_call_end", "verification_start", "verification_result",
    "plan_updated", "plan_revised", "subagent_spawned", "subagent_completed", "error",
  ]);
  const BUS_FOLLOW = new Set([
    "verification_start", "verification_result", "plan_updated", "plan_revised",
    "subagent_spawned", "subagent_completed", "error",
  ]);
  async function pollBus(): Promise<void> {
    if (destroy) return;
    let d: { latest?: number; busy?: boolean; events?: any[] };
    try {
      d = await assistantApi.events(lastSeq, requestSignal);
    } catch {
      return;
    }
    lastSeq = d.latest || lastSeq;
    let touched = false;
    for (const ev of d.events || []) {
      actor.onActivity(ev); // akting selalu (semua mode)
      const allowed = liveAsk ? BUS_LIVE : BUS_FOLLOW;
      if (!allowed.has(ev.type)) continue;
      // Registry perubahan file: label bus tool_call_start memuat args JSON
      // ("name {json}") — cukup utk mencatat mutasi (Review/dock badge).
      if (ev.type === "tool_call_start") {
        const { name } = parseToolLabel(ev.label || "");
        const brace = (ev.label || "").indexOf(" {");
        if (brace > 0) {
          try { registry.record(name, JSON.parse((ev.label || "").slice(brace + 1))); } catch {}
        }
      }
      const signals = transcript.applyBus(ev);
      touched = true;
      if (signals.includes("refresh-status")) refreshStatus();
    }
    if (touched) { render(); renderDock(); }
  }

  // ── Session rail: ganti sesi → hydrate ulang ────────────────────
  const onSessionChanged = () => {
    if (liveAsk) return;
    transcript = new Transcript();
    registry.clear();
    termLog.clear();
    expanded.clear();
    changesOpen.clear();
    void (async () => {
      await syncHistory();
      pushMarker(t("as.sess.loaded"), "ok");
      render();
      refreshStatus();
    })();
  };

  window.addEventListener("agent:session-changed", onSessionChanged);

  // ── Boot ────────────────────────────────────────────────────────
  void bootThenPoll(lifecycle, async (signal) => {
    let persona = "";
    try {
      const prof = await window.__live2dAgent?.getCapabilityProfile?.();
      persona = String(prof?.userNote || "").slice(0, 800);
    } catch {}
    try {
      const d = await postJson(API + "/api/assistant/start", {
        workDir: undefined,
        persona,
        model: window.__live2dAgent?.modelKey?.(),
        roleMap: collectRoleMap(),
      }, signal);
      if (!lifecycle.alive) return;
      if (d?.warning) pushMarker("⚠ " + d.warning, "warn");
      actor.setPersona(persona);
      await syncHistory();
      if (!lifecycle.alive) return;
      // Marker siap hanya untuk sesi yang benar-benar kosong — sesi dengan
      // history cukup dihidrate ulang tanpa noise baris sistem.
      if (!transcript.blocks.length) pushMarker(t("wb.boot.ready", { name: agentName }), "ok");
      render();
    } catch (e: any) {
      if (!lifecycle.alive) return;
      pushMarker(t("as.startFail", { msg: e?.message || e }), "err");
      render();
    }
    try {
      const d = await assistantApi.events(0, signal);
      lastSeq = d.latest || 0;
    } catch {}
  }, [
    { run: () => { void refreshStatus(); }, ms: 2000 },
    { run: () => { void pollBus(); }, ms: 1500 },
  ]);

  applyDock();
  view.composer.setBusy(false, false);
  view.composer.focus();
  render();
  renderDock();

  // ── Destroy: lepas UI saja (runtime tetap hidup) ────────────────
  const destroyPanel = () => {
    if (destroy) return;
    destroy = true;
    lifecycle.destroy();
    view.destroy();
    actor.stop();
    liveAsk?.abort.abort();
    window.removeEventListener("agent:session-changed", onSessionChanged);
    // mode-agent dipasang/cabut mode-runtime.js — di sini hanya dock lipat.
    document.body.classList.remove("agent-dock-collapsed");
    destroyBrowserPanel?.();
    if (activeDestroy === destroyPanel) activeDestroy = null;
  };
  activeDestroy = destroyPanel;
  return destroyPanel;
}
