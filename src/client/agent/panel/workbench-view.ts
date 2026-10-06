/**
 * client/agent/panel/workbench-view.ts — Lapisan DOM Agent Workbench
 * (rebuild clean-slate 2026-10). Semua bentuk tampilan mengikuti bahasa
 * visual harness: satu spine aktifitas, baris tool satu baris (icon + kind
 * + ringkasan + chevron), grup tool dengan rail indent, kartu todo/perubahan,
 * jawaban final tanpa bubble, kartu approval bernomor pin di atas composer,
 * composer input-surface, dan dock presence Live2D di kanan.
 *
 * View TIDAK memegang state aplikasi: state lipat/ekspansi dipegang
 * orchestrator (Set key), re-render idempoten per key (signature di dataset).
 */

import { parseMarkdown, parseInlines } from "./md";
import type { MdToken, MdInline } from "./md";
import {
  buildActivityItems, toolKindLabel, toolPrimaryText, groupSummary, splitPath,
} from "./workbench-model";
import type {
  ActivityItem, GroupItem, ToolItem, TodoItem, ChangesItem, ToolBlock, PlanStep,
} from "./workbench-model";
import { t } from "../../i18n/index";

// ═══════════════════════════════════════════════════════════════════
// Ikon — lucide 16px, stroke currentColor (satu sumber path)
// ═══════════════════════════════════════════════════════════════════

const ICON_PATHS: Record<string, string[]> = {
  chevron: ["m9 18 6-6-6-6"],
  sparkles: ["M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"],
  terminal: ["m4 17 6-6-6-6", "M12 19h8"],
  search: ["M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "m21 21-4.3-4.3"],
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
  pen: ["M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"],
  fileplus: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M15 2v4h4", "M12 12v6", "M9 15h6"],
  fileminus: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M15 2v4h4", "M9 15h6"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M10 11v6", "M14 11v6"],
  check: ["M20 6 9 17l-5-5"],
  circle: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"],
  loader: ["M21 12a9 9 0 1 1-6.219-8.56"],
  keyboard: ["M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z", "M6 10h.01", "M10 10h.01", "M14 10h.01", "M18 10h.01", "M7 14h10"],
  arrowup: ["m5 12 7-7 7 7", "M12 19V5"],
  arrowdown: ["M12 5v14", "m19 12-7 7-7-7"],
  square: ["M6 6h12v12H6z"],
  book: ["M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z", "M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"],
  gitcompare: ["M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M13 6h3a2 2 0 0 1 2 2v7", "M11 18H8a2 2 0 0 1-2-2V9"],
  globe: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "M2 12h20"],
  listtodo: ["M3 5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z", "m3 17 2 2 4-4", "M13 6h8", "M13 12h8", "M13 17h8"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  copy: ["M8 8h12v12H8z", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"],
  wrench: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"],
  bot: ["M12 8V4H8", "M4 10a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"],
  rotate: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
  panelright: ["M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z", "M15 3v18"],
  clock: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "M12 6v6l4 2"],
  warn: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2", "M12 9v4", "M12 17h.01"],
  diff: ["M6 3v12", "m3 6 3-3 3 3", "M18 21V9", "m15 18 3 3 3-3", "M3 12h6", "M15 12h6"],
};

function icon(name: string): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICON_PATHS[name] || ICON_PATHS.circle) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ═══════════════════════════════════════════════════════════════════
// Markdown → DOM (wb-final)
// ═══════════════════════════════════════════════════════════════════

function buildInlines(parent: HTMLElement, inlines: MdInline[]): void {
  for (const inl of inlines) {
    if (inl.t === "text") parent.appendChild(document.createTextNode(inl.text));
    else if (inl.t === "code") {
      const c = el("code", "wb-code-inline");
      c.textContent = inl.text;
      parent.appendChild(c);
    } else if (inl.t === "bold") {
      const b = el("strong");
      b.textContent = inl.text;
      parent.appendChild(b);
    } else if (inl.t === "italic") {
      const i = el("em");
      i.textContent = inl.text;
      parent.appendChild(i);
    } else if (inl.t === "link") {
      const a = el("a");
      a.href = inl.href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = inl.text;
      parent.appendChild(a);
    }
  }
}

function buildMarkdown(parent: HTMLElement, tokens: MdToken[]): void {
  for (const tk of tokens) {
    if (tk.t === "h") {
      const h = el(("h" + Math.min(Math.max(tk.level, 1), 3)) as "h1");
      buildInlines(h, tk.inlines);
      parent.appendChild(h);
    } else if (tk.t === "p") {
      const p = el("p");
      buildInlines(p, tk.inlines);
      parent.appendChild(p);
    } else if (tk.t === "code") {
      const pre = el("pre");
      const code = el("code");
      code.textContent = tk.text;
      pre.appendChild(code);
      parent.appendChild(pre);
    } else if (tk.t === "quote") {
      const q = el("blockquote");
      buildInlines(q, tk.inlines);
      parent.appendChild(q);
    } else if (tk.t === "ul" || tk.t === "ol") {
      const list = el(tk.t);
      for (const item of tk.items) {
        const li = el("li");
        buildInlines(li, item);
        list.appendChild(li);
      }
      parent.appendChild(list);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// View
// ═══════════════════════════════════════════════════════════════════

export type DockTab = "progress" | "review" | "term" | "browser" | "memory";

export type ApprovalView = {
  apId: string;
  tool: string;
  args: any;
  plan: boolean;
};

export type ReviewEntryView = { path: string; kind: string; added: number; removed: number; measured: boolean };
export type TermEntryView = { cmd: string; result: string | null; error: boolean };
export type QueueEntryView = { taskId: string; prompt: string };
export type MemoryEntryView = { key: string; value: string };

export type StateView = {
  state: string;
  what: string;
  elapsedMs: number;
  stepsDone: number;
  stepsTotal: number;
  filesTouched: number;
};

export type ViewDeps = {
  /** Kirim teks sebagai tugas baru. */
  onSend: (text: string) => void;
  onStop: () => void;
  onReset: () => void;
  onCancel: () => void;
  onMemory: () => void;
  onDockToggle: () => void;
  onWorkdirCommit: (value: string) => void;
  onApprove: (apId: string, ok: boolean, always: boolean) => void;
  onToggle: (key: string) => void;
  onToggleChanges: (key: string) => void;
  onToggleTodo: () => void;
  onJumpBottom: () => void;
  onCancelTask: (taskId: string) => void;
  onRevert: (path: string) => void;
  onRefreshReview: () => void;
  onForget: (key: string) => void;
  onTab: (tab: DockTab) => void;
  toolLevel: (name: string) => "safe" | "mutating" | null;
  /** Tool yang kartu izinnya sedang pending — kartu berjalan berubah jadi
   *  "menunggu izin…" (jangan mengecoh user bahwa tool sedang jalan). */
  awaitingTools: () => string[];
  agentName: string;
};

export function createWorkbenchView(root: HTMLElement, browserMount: HTMLElement | null, deps: ViewDeps) {
  // ── Kerangka statis (dibangun sekali) ──────────────────────────
  root.textContent = "";

  const header = el("header", "wb-header");
  const headerMain = el("div", "wb-header-main");
  const headerDot = el("span", "wb-dot");
  headerDot.dataset.state = "off";
  const headerTask = el("div", "wb-header-task is-empty");
  const headerWhat = el("span", "wb-header-what");
  headerWhat.hidden = true;
  const headerElapsed = el("span", "wb-header-elapsed");
  const headerActions = el("div", "wb-header-actions");
  headerMain.append(headerDot, headerTask, headerWhat, headerElapsed);
  header.append(headerMain, headerActions);
  root.appendChild(header);

  const streamWrap = el("div", "wb-stream");
  const streamCol = el("div", "wb-col");
  streamWrap.appendChild(streamCol);
  const jump = el("button", "wb-jump");
  jump.type = "button";
  jump.append(icon("arrowdown"), el("span", "", t("wb.jump")));
  jump.addEventListener("click", () => deps.onJumpBottom());
  streamWrap.appendChild(jump);
  const emptyWrap = buildEmpty();
  root.appendChild(streamWrap);
  root.appendChild(emptyWrap);

  const controls = el("div", "wb-controls");
  const composerZone = el("div", "wb-composer-zone");
  root.appendChild(controls);
  root.appendChild(composerZone);

  const composer = buildComposer();
  composerZone.appendChild(composer.root);

  // ── Dock tabs & panes (isi #agent-tech dibangun di sini) ───────
  let dockBody: HTMLElement | null = null;
  let dockTabs: HTMLElement | null = null;
  if (browserMount) {
    const dock = browserMount;
    dock.textContent = "";
    dockTabs = el("div", "wb-docktabs");
    dockBody = el("div", "wb-dockbody");
    dock.appendChild(dockTabs);
    dock.appendChild(dockBody);
  }

  // Kapsul presence saat dock terlipat: dot keadaan + label — satu-satunya
  // jejak karakter di layar; klik membuka dock lagi.
  const capsule = el("button", "wb-dock-capsule");
  capsule.type = "button";
  const capsuleDot = el("span", "wb-dot");
  const capsuleText = el("span", "", t("wb.dock.show"));
  capsule.append(capsuleDot, capsuleText);
  capsule.addEventListener("click", () => deps.onDockToggle());
  document.body.appendChild(capsule);

  // ── State lokal view ───────────────────────────────────────────
  /** key item → { node, sig } untuk re-render idempoten. */
  const nodes = new Map<string, { node: HTMLElement; sig: string }>();
  let emptyVisible = false;
  let activeTab: DockTab = "progress";
  let composerBusy = false;
  const tabButtons = new Map<DockTab, HTMLElement>();
  const tabBadges = new Map<DockTab, HTMLElement>();

  // ── Util ───────────────────────────────────────────────────────
  function sigOf(item: ActivityItem, extra: string): string {
    switch (item.kind) {
      case "tool": {
        const b = item.block;
        return `t${b.status}|${b.result == null ? "" : b.result.length}|${b.durMs ?? ""}|${item.collapsed}|${b.summary}|${extra}`;
      }
      case "group":
        return `g${item.family}|${item.blocks.map((b) => b.status + (b.result == null ? "" : ":" + b.result.length)).join(",")}|${item.collapsed}|${extra}`;
      case "note":
        return `n${item.block.kind}|${item.block.text.length}|${"streaming" in item.block ? item.block.streaming : ""}`;
      case "final":
        return `f${item.block.text.length}`;
      case "todo":
        return `p${item.steps.map((s) => s.status).join(",")}|${item.key}`;
      case "changes":
        return `c${item.files.length}|${item.added}|${item.removed}`;
      case "user":
        return `u${item.block.text.length}`;
      case "subagent":
        return `s${item.block.state}|${item.block.text.length}`;
      case "marker":
        return `m${item.text}|${item.variant || ""}`;
    }
  }

  // ═══ Builder baris ═══════════════════════════════════════════

  function buildUser(item: Extract<ActivityItem, { kind: "user" }>): HTMLElement {
    const row = el("div", "wb-user");
    const bubble = el("div", "wb-user-bubble");
    bubble.textContent = item.block.text;
    row.appendChild(bubble);
    return row;
  }

  /** Kepala baris tool/grup: icon + kind + ringkasan + chevron. */
  function toolHead(o: {
    iconName: string;
    kind: string;
    running: boolean;
    waiting?: boolean;
    error?: boolean;
    summary: string;
    pill?: string | null;
    dur?: number | null;
    open?: boolean;
  }): HTMLElement {
    const head = el("button", "wb-trow-head" + (o.open ? " is-open" : ""));
    head.type = "button";
    const ico = el("span", "wb-trow-ico");
    ico.appendChild(icon(o.iconName));
    const kind = el("span", "wb-trow-kind" + (o.waiting ? " is-wait" : o.running ? " is-running" : o.error ? " is-error" : ""));
    if (o.running && !o.waiting) kind.classList.add("wb-anim-text");
    kind.textContent = o.kind;
    head.append(ico, kind);
    if (o.summary) {
      const sum = el("span", "wb-trow-sum");
      sum.textContent = o.summary;
      head.appendChild(sum);
    }
    if (o.pill) head.appendChild(el("span", "wb-trow-pill", o.pill));
    if (o.error) {
      const badge = el("span", "wb-trow-badge");
      badge.appendChild(icon("warn"));
      head.appendChild(badge);
    }
    if (o.dur != null && o.dur >= 0) {
      head.appendChild(el("span", "wb-trow-dur", formatDur(o.dur)));
    }
    const chev = el("span", "wb-trow-chev");
    chev.appendChild(icon("chevron"));
    head.appendChild(chev);
    return head;
  }

  function toolBody(b: ToolBlock): HTMLElement {
    const body = el("div", "wb-trow-body");
    const argsText = b.argsText != null ? b.argsText : (b.summary || "");
    if (argsText.trim()) {
      body.appendChild(el("div", "wb-io-label", t("wb.io.args")));
      const pre = el("pre");
      pre.textContent = argsText;
      body.appendChild(pre);
    }
    if (b.result != null) {
      body.appendChild(el("div", "wb-io-label", t("wb.io.result")));
      const pre = el("pre", b.status === "error" ? "is-err" : "");
      pre.textContent = b.result;
      body.appendChild(pre);
    } else if (b.status === "running") {
      const run = el("div", "wb-term-run");
      if (deps.awaitingTools().includes(b.name)) {
        run.appendChild(el("span", "wb-io-wait", "⏳ " + t("wb.io.waitPerm")));
      } else {
        const sp = el("span", "wb-spin");
        sp.appendChild(icon("loader"));
        run.append(sp, el("span", "", t("wb.io.running")));
      }
      body.appendChild(run);
    }
    return body;
  }

  const FAMILY_ICON: Record<string, string> = {
    explore: "search", terminal: "terminal", changes: "pen",
  };
  function toolIcon(name: string): string {
    if (name === "run_command") return "terminal";
    if (name === "write_file") return "fileplus";
    if (name === "edit_file") return "pen";
    if (name === "delete_file") return "fileminus";
    if (name === "list_dir" || name === "read_file") return "folder";
    if (name === "search_code" || name === "git_diff") return "search";
    if (name.startsWith("memory")) return "book";
    if (name.startsWith("motion")) return "wrench";
    return "wrench";
  }

  function buildTool(item: ToolItem, expandedKeys: Set<string>): HTMLElement {
    const row = el("div", "wb-trow");
    row.dataset.key = item.key;
    const b = item.block;
    const running = b.status === "running";
    const error = b.status === "error";
    const lvl = deps.toolLevel(b.name);
    const waiting = running && deps.awaitingTools().includes(b.name);
    const head = toolHead({
      iconName: toolIcon(b.name),
      kind: waiting ? t("wb.tool.waiting") + " " + (toolKindLabel(b.name, false)) : toolKindLabel(b.name, running),
      running,
      waiting,
      error,
      summary: b.summary || toolPrimaryText(b.name, b.args),
      pill: lvl === "mutating" ? t("wb.lvl.mutating") : null,
      dur: b.durMs ?? null,
      open: !item.collapsed,
    });
    head.addEventListener("click", () => deps.onToggle(item.key));
    row.appendChild(head);
    if (!item.collapsed) row.appendChild(toolBody(b));
    return row;
  }

  function buildGroup(item: GroupItem, expandedKeys: Set<string>): HTMLElement {
    const row = el("div", "wb-grp");
    row.dataset.key = item.key;
    const failed = item.blocks.filter((b) => b.status === "error").length;
    const kind = t(item.family === "terminal" ? "wb.group.terminal" : item.family === "changes" ? "wb.group.changes" : "wb.group.explore");
    const head = toolHead({
      iconName: FAMILY_ICON[item.family],
      kind: item.running ? kind + " · " + t("wb.tool.running") : kind,
      running: item.running,
      error: failed > 0 && !item.running,
      summary: groupSummary(item.family, item.blocks.length, failed),
      open: !item.collapsed,
    });
    head.addEventListener("click", () => deps.onToggle(item.key));
    row.appendChild(head);
    if (!item.collapsed) {
      const kids = el("div", "wb-grp-kids");
      for (const b of item.blocks) {
        const kid = el("div", "wb-trow");
        kid.dataset.key = item.key + ":" + b.id;
        const kb = deps.toolLevel(b.name) === "mutating" ? t("wb.lvl.mutating") : null;
        const kWaiting = b.status === "running" && deps.awaitingTools().includes(b.name);
        const khead = toolHead({
          iconName: toolIcon(b.name),
          kind: kWaiting ? t("wb.tool.waiting") + " " + toolKindLabel(b.name, false) : toolKindLabel(b.name, b.status === "running"),
          running: b.status === "running",
          waiting: kWaiting,
          error: b.status === "error",
          summary: b.summary || toolPrimaryText(b.name, b.args),
          dur: b.durMs ?? null,
          open: true,
        });
        khead.addEventListener("click", () => deps.onToggle(item.key + ":" + b.id));
        kid.appendChild(khead);
        const open = expandedKeys.has(item.key + ":" + b.id);
        if (open) kid.appendChild(toolBody(b));
        kids.appendChild(kid);
      }
      row.appendChild(kids);
    }
    return row;
  }

  function buildNote(item: Extract<ActivityItem, { kind: "note" }>): HTMLElement {
    const row = el("div", "wb-note");
    row.dataset.key = item.key;
    const streaming = item.block.kind === "agent" && item.block.streaming;
    if (streaming) row.classList.add("is-open");
    const head = el("div", "wb-note-head");
    head.appendChild(icon("sparkles"));
    const kindEl = el("span", "wb-note-kind" + (streaming ? " wb-anim-text" : ""));
    kindEl.textContent = streaming ? t("wb.note.thinking") : item.block.kind === "speak" ? t("wb.note.speak") : t("wb.note.thought");
    head.appendChild(kindEl);
    const chev = el("span", "wb-note-chev");
    chev.appendChild(icon("chevron"));
    head.appendChild(chev);
    row.appendChild(head);
    const body = el("div", "wb-note-body");
    body.textContent = item.block.text;
    row.appendChild(body);
    // Narasi selesai: klik head untuk buka/tutup isi.
    if (!streaming) {
      head.style.cursor = "pointer";
      head.addEventListener("click", () => row.classList.toggle("is-open"));
    }
    return row;
  }

  function buildTodo(item: TodoItem, open: boolean): HTMLElement {
    const card = el("div", "wb-todo");
    card.dataset.key = item.key;
    const done = item.steps.filter((s) => s.status === "done").length;
    const head = el("div", "wb-todo-head");
    const kindEl = el("span", "wb-todo-kind");
    kindEl.appendChild(icon("listtodo"));
    head.appendChild(kindEl);
    head.appendChild(el("span", "wb-todo-kind", t("wb.todo.title")));
    head.appendChild(el("span", "wb-todo-frac", `${done}/${item.steps.length}`));
    const cur = item.steps.find((s) => s.status === "in_progress");
    if (cur && open) head.appendChild(el("span", "wb-todo-cur", cur.task));
    head.style.cursor = "pointer";
    head.addEventListener("click", () => deps.onToggleTodo());
    card.appendChild(head);
    if (open) {
      for (const s of item.steps) {
        const row = el("div", "wb-todo-row");
        row.dataset.status = s.status;
        row.appendChild(icon(s.status === "done" ? "check" : s.status === "failed" ? "x" : s.status === "in_progress" ? "loader" : "circle"));
        const txt = el("span", "wb-todo-txt");
        txt.textContent = s.task + (s.note ? " — " + s.note : "");
        row.appendChild(txt);
        card.appendChild(row);
      }
    } else {
      // Dilipat: satu baris langkah berjalan.
      const row = el("div", "wb-todo-row");
      row.dataset.status = cur ? "in_progress" : "pending";
      row.appendChild(icon(cur ? "loader" : "circle"));
      row.appendChild(el("span", "wb-todo-txt", cur ? cur.task : t("wb.todo.none")));
      card.appendChild(row);
    }
    return card;
  }

  function statSpan(added: number, removed: number): HTMLElement {
    const s = el("span", "wb-chg-stats");
    if (added > 0) s.appendChild(el("span", "add", "+" + added));
    if (added > 0 && removed > 0) s.appendChild(document.createTextNode(" "));
    if (removed > 0) s.appendChild(el("span", "del", "−" + removed));
    return s;
  }

  function buildChanges(item: ChangesItem, open: boolean, onOpen: () => void): HTMLElement {
    const card = el("div", "wb-chg");
    card.dataset.key = item.key;
    const head = el("button", "wb-chg-head");
    head.type = "button";
    head.appendChild(el("span", "wb-chg-title", t("wb.chg.title", { n: item.files.length })));
    head.appendChild(statSpan(item.added, item.removed));
    const chev = el("span", "wb-trow-chev" + (open ? " is-open" : ""));
    chev.appendChild(icon("chevron"));
    head.appendChild(chev);
    head.addEventListener("click", onOpen);
    card.appendChild(head);
    if (open) {
      const rows = el("div", "wb-chg-rows");
      for (const f of item.files) {
        const row = el("div", "wb-chg-row");
        const path = el("span", "wb-chg-path");
        const { dir, name } = splitPath(f.path);
        if (dir) path.appendChild(el("span", "fdir", dir + "/"));
        path.appendChild(el("span", "fname", name));
        path.title = f.path;
        row.appendChild(path);
        row.appendChild(statSpan(f.added, f.removed));
        rows.appendChild(row);
      }
      card.appendChild(rows);
    }
    return card;
  }

  function buildSubagent(item: Extract<ActivityItem, { kind: "subagent" }>): HTMLElement {
    const row = el("div", "wb-sub" + (item.block.state === "done" ? " is-done" : ""));
    row.dataset.key = item.key;
    const head = el("div", "wb-sub-head");
    const ico = el("span", "wb-trow-ico");
    ico.appendChild(icon("bot"));
    head.appendChild(ico);
    head.appendChild(el("span", "wb-sub-name", item.block.name));
    head.appendChild(el("span", "wb-sub-text", item.block.text));
    row.appendChild(head);
    return row;
  }

  function buildMarker(item: Extract<ActivityItem, { kind: "marker" }>): HTMLElement {
    const row = el("div", "wb-mark");
    row.dataset.key = item.key;
    if (item.variant) row.dataset.variant = item.variant;
    const span = el("span");
    span.appendChild(icon(
      item.variant === "err" ? "warn" : item.variant === "ok" ? "check" : item.variant === "warn" ? "warn" : "clock",
    ));
    span.appendChild(el("span", "", item.text));
    row.appendChild(span);
    return row;
  }

  function buildFinal(item: Extract<ActivityItem, { kind: "final" }>): HTMLElement {
    const row = el("div", "wb-final");
    row.dataset.key = item.key;
    buildMarkdown(row, parseMarkdown(item.block.text));
    const actions = el("div", "wb-final-actions");
    const copy = el("button", "wb-iconbtn");
    copy.type = "button";
    copy.title = t("wb.copy");
    copy.appendChild(icon("copy"));
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(item.block.text).catch(() => {});
    });
    actions.appendChild(copy);
    row.appendChild(actions);
    return row;
  }

  // ═══ Sync stream (reconcile keyed) ═══════════════════════════

  function renderItems(
    items: ActivityItem[],
    expanded: Set<string>,
    changesOpen: Set<string>,
    todoOpen: boolean,
  ): void {
    const rendered: Array<{ key: string; node: HTMLElement }> = [];
    const fresh = new Map<string, { node: HTMLElement; sig: string }>();
    for (const item of items) {
      const extra = item.kind === "group"
        ? String(item.blocks.filter((b) => expanded.has(item.key + ":" + b.id)).length)
        : "";
      const sig = sigOf(item, extra);
      const prev = nodes.get(item.key);
      let node: HTMLElement;
      if (prev && prev.sig === sig) {
        node = prev.node;
      } else {
        switch (item.kind) {
          case "user": node = buildUser(item); break;
          case "tool": node = buildTool(item, expanded); break;
          case "group": node = buildGroup(item, expanded); break;
          case "note": node = buildNote(item); break;
          case "final": node = buildFinal(item); break;
          case "subagent": node = buildSubagent(item); break;
          case "marker": node = buildMarker(item); break;
          case "changes": {
            const open = changesOpen.has(item.key);
            node = buildChanges(item, open, () => deps.onToggleChanges(item.key));
            break;
          }
          case "todo": node = buildTodo(item, todoOpen); break;
        }
        node.dataset.key = item.key;
        if (!node.hasAttribute("data-wb-in")) node.setAttribute("data-wb-in", "");
      }
      fresh.set(item.key, { node, sig });
      rendered.push({ key: item.key, node });
    }
    nodes.clear();
    for (const [k, v] of fresh) nodes.set(k, v);
    // Reconcile urutan anak streamCol — cocokkan KEY **dan SIG**: key sama
    // tapi sig beda berarti node basi (mis. note streaming jadi final,
    // tool running jadi done) WAJIB diganti, bukan dilewati.
    const sigByKey = new Map<string, string>();
    for (const item of items) {
      const extra = item.kind === "group"
        ? String(item.blocks.filter((b) => expanded.has(item.key + ":" + b.id)).length)
        : "";
      sigByKey.set(item.key, sigOf(item, extra));
    }
    const byKey = new Map(rendered.map((r) => [r.key, r.node]));
    const seen = new Set<string>();
    let cursor = streamCol.firstElementChild as HTMLElement | null;
    for (const r of rendered) {
      seen.add(r.key);
      const node = byKey.get(r.key)!;
      node.dataset.sig = sigByKey.get(r.key) ?? "";
      if (cursor === node) {
        cursor = cursor.nextElementSibling as HTMLElement | null;
        continue;
      }
      if (cursor && cursor.dataset?.key === r.key) {
        const next = cursor.nextElementSibling as HTMLElement | null;
        streamCol.insertBefore(node, cursor);
        cursor.remove();
        cursor = next;
      } else {
        streamCol.insertBefore(node, cursor);
      }
    }
    while (cursor) {
      const next = cursor.nextElementSibling as HTMLElement | null;
      const k = cursor.dataset?.key;
      if (!k || !seen.has(k)) cursor.remove();
      cursor = next;
    }
    // Streaming note terakhir: auto-scroll mengikuti teks.
    const last = rendered[rendered.length - 1];
    if (last) {
      const n = last.node;
      if (n.classList.contains("wb-note") && n.classList.contains("is-open") ||
          n.classList.contains("wb-final")) {
        stickBottom();
      }
    }
  }

  // ── Empty state ────────────────────────────────────────────────
  function buildEmpty(): HTMLElement {
    const wrap = el("div", "wb-empty");
    wrap.hidden = true;
    const title = el("div", "wb-empty-title", t("wb.empty.title", { name: deps.agentName }));
    const sub = el("div", "wb-empty-sub", t("wb.empty.sub"));
    const list = el("div", "wb-empty-list");
    const sugg: Array<[string, string]> = [
      ["folder", "as.quick.explore"],
      ["wrench", "as.quick.fix"],
      ["diff", "as.quick.review"],
      ["sparkles", "as.quick.summary"],
    ];
    for (const [ic, key] of sugg) {
      const b = el("button", "wb-empty-row");
      b.type = "button";
      b.appendChild(icon(ic));
      b.appendChild(el("span", "", t(key)));
      b.addEventListener("click", () => deps.onSend(t(key)));
      list.appendChild(b);
    }
    wrap.append(title, sub, list);
    return wrap;
  }

  function setEmpty(visible: boolean): void {
    if (emptyVisible === visible) return;
    emptyVisible = visible;
    emptyWrap.hidden = !visible;
    streamWrap.hidden = visible;
    controls.hidden = visible;
  }

  // ── Header ─────────────────────────────────────────────────────
  function iconBtn(name: string, title: string, onClick: () => void, variant?: string): HTMLButtonElement {
    const b = el("button", "wb-iconbtn" + (variant ? "" : ""));
    b.type = "button";
    if (variant) b.dataset.variant = variant;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.appendChild(icon(name));
    b.addEventListener("click", onClick);
    return b;
  }

  headerActions.append(
    iconBtn("book", t("as.memoryBtn"), () => deps.onMemory()),
    iconBtn("rotate", t("as.resetTip"), () => deps.onReset()),
  );
  const stopBtn = iconBtn("square", t("as.stop"), () => deps.onStop(), "danger");
  const cancelBtn = iconBtn("x", t("as.cancel"), () => deps.onCancel(), "danger");
  stopBtn.hidden = true;
  cancelBtn.hidden = true;
  const dockBtn = iconBtn("panelright", t("wb.dock.hide"), () => deps.onDockToggle());
  headerActions.append(stopBtn, cancelBtn, dockBtn);

  function setHeader(o: { sv: StateView | null; task: string; streaming: boolean; liveTask: boolean; dockCollapsed: boolean }): void {
    const sv = o.sv;
    headerDot.dataset.state = sv ? sv.state : "off";
    if (sv && (sv.state === "thinking" || sv.state === "executing")) headerDot.classList.add("wb-dot-spin");
    else headerDot.classList.remove("wb-dot-spin");
    headerTask.textContent = o.task || t("wb.header.idle", { name: deps.agentName });
    headerTask.classList.toggle("is-empty", !o.task);
    if (sv && sv.what && (sv.state === "executing" || sv.state === "waitingApproval" || sv.state === "waitingPlan")) {
      headerWhat.textContent = sv.what;
      headerWhat.hidden = false;
    } else {
      headerWhat.hidden = true;
    }
    headerElapsed.textContent = sv && sv.elapsedMs > 0 ? formatDur(sv.elapsedMs) : "";
    stopBtn.hidden = !o.streaming;
    cancelBtn.hidden = !o.liveTask || o.streaming;
    dockBtn.title = o.dockCollapsed ? t("wb.dock.show") : t("wb.dock.hide");
    capsuleDot.dataset.state = headerDot.dataset.state;
    capsuleText.textContent = o.task || headerTask.textContent || t("wb.header.idle", { name: deps.agentName });
  }

  // ── Controls: kartu approval ───────────────────────────────────
  type ApprUi = { apId: string; card: HTMLElement; sel: number; options: Array<{ label: string; sub: string; ok: boolean; always: boolean }> };
  const apprCards = new Map<string, ApprUi>();
  let keyHandler: ((e: KeyboardEvent) => void) | null = null;

  function apprOptionRow(ui: ApprUi, idx: number): HTMLElement {
    const opt = ui.options[idx];
    const row = el("button", "wb-appr-opt" + (ui.sel === idx ? " is-sel" : ""));
    row.type = "button";
    row.dataset.idx = String(idx);
    row.appendChild(el("span", "num", String(idx + 1) + "."));
    const col = el("span");
    col.style.display = "flex";
    col.style.flexDirection = "column";
    const l1 = el("span", "lbl", opt.label);
    col.appendChild(l1);
    if (opt.sub) col.appendChild(el("span", "sub", opt.sub));
    row.appendChild(col);
    row.addEventListener("click", () => {
      ui.sel = idx;
      paintSel(ui);
    });
    row.addEventListener("dblclick", () => confirmAppr(ui));
    return row;
  }

  function paintSel(ui: ApprUi): void {
    ui.card.querySelectorAll(".wb-appr-opt").forEach((n, i) => n.classList.toggle("is-sel", i === ui.sel));
  }

  function confirmAppr(ui: ApprUi): void {
    const opt = ui.options[ui.sel];
    if (!opt) return;
    deps.onApprove(ui.apId, opt.ok, opt.always);
  }

  function ensureKeyHandler(): void {
    if (keyHandler || !apprCards.size) return;
    keyHandler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
      if (e.key === "Tab") {
        e.preventDefault();
        for (const ui of apprCards.values()) {
          ui.sel = (ui.sel + (e.shiftKey ? -1 : 1) + ui.options.length) % ui.options.length;
          paintSel(ui);
        }
        return;
      }
      const idx = Number(e.key);
      if (idx >= 1 && idx <= 9) {
        for (const ui of apprCards.values()) {
          if (idx <= ui.options.length) { ui.sel = idx - 1; paintSel(ui); }
        }
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        for (const ui of apprCards.values()) confirmAppr(ui);
      }
    };
    document.addEventListener("keydown", keyHandler);
  }

  function releaseKeyHandler(): void {
    if (keyHandler && !apprCards.size) {
      document.removeEventListener("keydown", keyHandler);
      keyHandler = null;
    }
  }

  function approvalOptions(ap: ApprovalView): ApprUi["options"] {
    if (ap.plan) {
      return [
        { label: t("wb.appr.approvePlan"), sub: "", ok: true, always: false },
        { label: t("as.deny"), sub: "", ok: false, always: false },
      ];
    }
    const kindLabel = toolKindLabel(ap.tool, false);
    const mutating = deps.toolLevel(ap.tool) === "mutating" || ap.tool === "run_command";
    const opts: ApprUi["options"] = [{ label: t("as.allow"), sub: t("wb.appr.once"), ok: true, always: false }];
    // Selalu izinkan memakai label semantik tool — key as.approve.always
    // menerima {what}; fallback wb.appr.alwaysPlain bila tak ada variabel.
    if (mutating) {
      const always = t("as.approve.always", { what: kindLabel });
      opts.push({
        label: always.includes("{what}") ? t("wb.appr.alwaysPlain") : always,
        sub: t("wb.appr.alwaysSub"), ok: true, always: true,
      });
    }
    opts.push({ label: t("as.deny"), sub: "", ok: false, always: false });
    return opts;
  }

  function buildApprovalCard(ap: ApprovalView): HTMLElement {
    const card = el("div", "wb-appr");
    card.dataset.apid = ap.apId;
    const titleRow = el("div", "wb-appr-title");
    titleRow.appendChild(el("span", "", ap.plan ? t("as.approve.planTitle") : t("as.approve.title")));
    titleRow.appendChild(el("span", "wb-trow-pill", ap.plan ? t("wb.appr.planTag") : ap.tool));
    card.appendChild(titleRow);

    const toolCard = el("div", "wb-appr-tool");
    const toolHeadEl = el("div", "wb-appr-tool-head");
    const ico = el("span", "wb-trow-ico");
    ico.appendChild(icon(ap.plan ? "listtodo" : toolIcon(ap.tool)));
    toolHeadEl.appendChild(ico);
    const kindLabel = ap.plan ? t("wb.appr.planTag") : toolKindLabel(ap.tool, false);
    toolHeadEl.appendChild(el("span", "wb-trow-kind", kindLabel));
    const args = ap.args || {};
    const primary = ap.plan ? "" : (String(args.command ?? args.path ?? args.query ?? args.key ?? "").trim());
    if (primary) {
      const s = el("span", "wb-trow-sum");
      s.textContent = primary;
      toolHeadEl.appendChild(s);
    }
    toolCard.appendChild(toolHeadEl);
    if (ap.plan && Array.isArray(args.todos) && args.todos.length) {
      for (const s of args.todos as PlanStep[]) {
        const row = el("div", "wb-todo-row");
        row.dataset.status = String(s?.status || "pending");
        row.appendChild(icon(String(s?.status) === "done" ? "check" : "circle"));
        row.appendChild(el("span", "wb-todo-txt", String(s?.task || "")));
        toolCard.appendChild(row);
      }
    } else if (!ap.plan) {
      const pre = el("pre");
      try { pre.textContent = JSON.stringify(args, null, 2); } catch { pre.textContent = String(args); }
      toolCard.appendChild(pre);
    }
    card.appendChild(toolCard);

    const optsWrap = el("div", "wb-appr-opts");
    card.appendChild(optsWrap);

    const ui: ApprUi = { apId: ap.apId, card, sel: 0, options: approvalOptions(ap) };
    ui.options.forEach((_, idx) => optsWrap.appendChild(apprOptionRow(ui, idx)));

    const foot = el("div", "wb-appr-foot");
    const hint = el("span", "wb-appr-hint");
    hint.appendChild(icon("keyboard"));
    const hintTxt = el("span");
    hintTxt.innerHTML = "";
    hintTxt.textContent = t("wb.appr.hint");
    hint.appendChild(hintTxt);
    const confirm = el("button", "wb-btn");
    confirm.dataset.variant = "primary";
    confirm.type = "button";
    confirm.appendChild(el("span", "", t("wb.appr.confirm")));
    confirm.addEventListener("click", () => confirmAppr(ui));
    foot.append(hint, confirm);
    card.appendChild(foot);
    return card;
  }

  function setControls(list: ApprovalView[]): void {
    const wanted = new Set(list.map((a) => a.apId));
    for (const [id, ui] of [...apprCards]) {
      if (!wanted.has(id)) {
        ui.card.remove();
        apprCards.delete(id);
      }
    }
    for (const ap of list) {
      if (!apprCards.has(ap.apId)) {
        const card = buildApprovalCard(ap);
        apprCards.set(ap.apId, { apId: ap.apId, card, sel: 0, options: approvalOptions(ap) });
      }
    }
    // Susun ulang DOM sesuai urutan list.
    const byId = new Map(list.map((a) => [a.apId, apprCards.get(a.apId)!.card]));
    controls.replaceChildren(...list.map((a) => byId.get(a.apId)!));
    controls.hidden = emptyVisible || list.length === 0;
    ensureKeyHandler();
    releaseKeyHandler();
  }

  // ── Composer ───────────────────────────────────────────────────
  function buildComposer() {
    const root = el("div", "wb-composer");
    const input = el("textarea") as HTMLTextAreaElement;
    input.rows = 1;
    input.placeholder = t("wb.composer.ph", { name: deps.agentName });
    root.appendChild(input);

    const bar = el("div", "wb-composer-bar");
    const lead = el("div", "wb-composer-lead");
    const wdChip = el("button", "wb-chip");
    wdChip.type = "button";
    wdChip.title = t("as.workdir");
    const wdIco = el("span", "wb-chip-ico");
    wdIco.appendChild(icon("folder"));
    const wdTxt = el("span");
    wdTxt.textContent = t("wb.workdir.none");
    wdChip.append(wdIco, wdTxt);
    wdChip.addEventListener("click", () => {
      // Inline edit: chip diganti input sementara; Enter/blur commit.
      const inp = el("input") as HTMLInputElement;
      inp.type = "text";
      inp.value = wdTxt.dataset.full || "";
      inp.placeholder = t("as.workdirPh");
      inp.style.cssText = "flex:1;min-width:0;background:transparent;border:none;color:inherit;font:inherit;font-size:12px;outline:none;";
      wdChip.replaceWith(inp);
      inp.focus();
      const commit = () => {
        const v = inp.value.trim();
        deps.onWorkdirCommit(v);
        inp.replaceWith(wdChip);
      };
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") inp.replaceWith(wdChip);
      });
      inp.addEventListener("blur", commit);
    });
    lead.appendChild(wdChip);

    const tail = el("div", "wb-composer-tail");
    const send = el("button", "wb-send");
    send.type = "submit";
    send.title = t("wb.composer.send");
    send.setAttribute("aria-label", t("wb.composer.send"));
    send.appendChild(icon("arrowup"));
    tail.appendChild(send);

    bar.append(lead, tail);
    root.appendChild(bar);

    const hintRow = el("div", "wb-composer-hint");
    hintRow.appendChild(el("span", "", ""));
    hintRow.appendChild(el("span", "", t("wb.composer.keys")));
    root.appendChild(hintRow);

    const submit = () => {
      const v = input.value.trim();
      if (!v || composerBusy) return;
      input.value = "";
      grow();
      deps.onSend(v);
    };
    const grow = () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 200) + "px";
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    input.addEventListener("input", grow);
    send.addEventListener("click", submit);

    return {
      root, input, send,
      setWorkdir(v: string | null | undefined): void {
        wdTxt.textContent = v || t("wb.workdir.none");
        wdTxt.dataset.full = v || "";
        if (v) { wdTxt.style.direction = "rtl"; wdTxt.title = v; }
        else wdTxt.style.direction = "";
      },
      setBusy(busy: boolean, streaming: boolean): void {
        composerBusy = busy;
        input.disabled = busy;
        send.innerHTML = "";
        if (streaming) {
          send.dataset.kind = "stop";
          send.appendChild(icon("square"));
          send.title = t("wb.composer.stop");
        } else {
          delete send.dataset.kind;
          send.appendChild(icon("arrowup"));
          send.title = t("wb.composer.send");
        }
      },
      focus(): void { input.focus(); },
    };
  }

  // ── Dock ───────────────────────────────────────────────────────
  const TAB_DEFS: Array<{ id: DockTab; icon: string; label: string }> = [
    { id: "progress", icon: "listtodo", label: "wb.tab.progress" },
    { id: "review", icon: "gitcompare", label: "wb.tab.review" },
    { id: "term", icon: "terminal", label: "wb.tab.term" },
    { id: "browser", icon: "globe", label: "wb.tab.browser" },
    { id: "memory", icon: "book", label: "wb.tab.memory" },
  ];

  if (dockTabs) {
    for (const def of TAB_DEFS) {
      const b = el("button", "wb-docktab");
      b.type = "button";
      b.title = t(def.label);
      b.setAttribute("aria-label", t(def.label));
      b.appendChild(icon(def.icon));
      b.appendChild(el("span", "wb-tab-label", t(def.label)));
      const badge = el("span", "wb-tab-badge");
      badge.hidden = true;
      b.appendChild(badge);
      b.addEventListener("click", () => deps.onTab(def.id));
      tabButtons.set(def.id, b);
      tabBadges.set(def.id, badge);
      dockTabs.appendChild(b);
    }
    paintTabs();
  }

  function paintTabs(): void {
    for (const [id, btn] of tabButtons) btn.classList.toggle("is-active", id === activeTab);
  }

  function setTab(tab: DockTab): void {
    activeTab = tab;
    paintTabs();
  }

  function dockSection(title: string, meta?: string): { head: HTMLElement; body: HTMLElement } {
    const sec = el("div", "wb-dock-sec");
    const head = el("div", "wb-dock-sec-head");
    head.appendChild(el("span", "", title));
    if (meta) head.appendChild(el("span", "wb-dock-sec-meta", meta));
    const body = el("div");
    sec.append(head, body);
    return { head, body };
  }

  function setDock(o: {
    sv: StateView | null;
    plan: any[];
    queue: QueueEntryView[];
    review: ReviewEntryView[];
    term: TermEntryView[];
    memory: MemoryEntryView[];
    filesTouched: number;
  }): void {
    if (!dockBody) return;
    dockBody.replaceChildren();
    const sv = o.sv;
    if (activeTab === "progress") {
      // Garis keadaan presence (di bawah stage, di atas tab).
      const done = (Array.isArray(o.plan) ? o.plan : []).filter((p) => p?.status === "done").length;
      const total = Array.isArray(o.plan) ? o.plan.length : 0;
      if (total) {
        const sec = dockSection(t("wb.tab.progress"), `${done}/${total}`);
        for (const p of o.plan) {
          const row = el("div", "wb-dock-row");
          row.dataset.status = String(p?.status || "pending");
          row.appendChild(icon(
            p?.status === "done" ? "check" : p?.status === "failed" ? "x" : p?.status === "in_progress" ? "loader" : "circle",
          ));
          row.appendChild(el("span", "txt", String(p?.task || "")));
          sec.body.appendChild(row);
        }
        dockBody.appendChild(sec.head);
        dockBody.appendChild(sec.body);
      }
      if (o.queue.length) {
        const sec = dockSection(t("as.queue"), t("as.queue.count", { n: o.queue.length }));
        for (const q of o.queue) {
          const row = el("div", "wb-dock-row");
          row.dataset.status = "pending";
          row.appendChild(icon("clock"));
          row.appendChild(el("span", "txt", q.prompt));
          const act = el("button", "row-act");
          act.type = "button";
          act.title = t("as.queue.cancel");
          act.appendChild(icon("x"));
          act.addEventListener("click", () => deps.onCancelTask(q.taskId));
          row.appendChild(act);
          sec.body.appendChild(row);
        }
        dockBody.appendChild(sec.head);
        dockBody.appendChild(sec.body);
      }
      if (!total && !o.queue.length) {
        dockBody.appendChild(el("div", "wb-dock-empty", t("wb.dock.empty")));
      }
      return;
    }
    if (activeTab === "review") {
      if (!o.review.length) {
        dockBody.appendChild(el("div", "wb-dock-empty", t("as.review.empty")));
        return;
      }
      const sec = dockSection(t("wb.tab.review"), String(o.review.length));
      for (const f of o.review) {
        const row = el("button", "wb-rev-row");
        row.type = "button";
        const path = el("span", "wb-chg-path");
        const { dir, name } = splitPath(f.path);
        if (dir) path.appendChild(el("span", "fdir", dir + "/"));
        path.appendChild(el("span", "fname", name));
        path.title = f.path + (f.measured ? "" : " (" + t("as.review.touched") + ")");
        row.appendChild(path);
        row.appendChild(statSpan(f.added, f.removed));
        if (f.measured) {
          const act = el("span", "rev-act");
          act.title = t("as.review.revert");
          act.appendChild(icon("rotate"));
          act.addEventListener("click", (e) => {
            e.stopPropagation();
            deps.onRevert(f.path);
          });
          row.appendChild(act);
        }
        sec.body.appendChild(row);
      }
      dockBody.appendChild(sec.head);
      dockBody.appendChild(sec.body);
      return;
    }
    if (activeTab === "term") {
      if (!o.term.length) {
        dockBody.appendChild(el("div", "wb-dock-empty", t("as.term.empty")));
        return;
      }
      for (const e of [...o.term].reverse()) {
        const row = el("div", "wb-term-row");
        row.appendChild(el("div", "wb-term-cmd", "$ " + e.cmd));
        if (e.result == null) {
          const run = el("div", "wb-term-run");
          const sp = el("span", "wb-spin");
          sp.appendChild(icon("loader"));
          run.append(sp, el("span", "", t("as.term.running")));
          row.appendChild(run);
        } else {
          const out = el("div", "wb-term-out" + (e.error ? " is-err" : ""));
          out.textContent = e.result;
          row.appendChild(out);
        }
        dockBody.appendChild(row);
      }
      return;
    }
    if (activeTab === "memory") {
      if (!o.memory.length) {
        dockBody.appendChild(el("div", "wb-dock-empty", t("as.memEmpty")));
        return;
      }
      for (const m of o.memory) {
        const row = el("div", "wb-mem-row");
        row.appendChild(el("span", "wb-mem-key", m.key));
        row.appendChild(el("span", "wb-mem-val", m.value));
        const act = el("button", "rev-act");
        act.type = "button";
        act.title = t("as.memForget");
        act.appendChild(icon("trash"));
        act.addEventListener("click", () => deps.onForget(m.key));
        row.appendChild(act);
        dockBody.appendChild(row);
      }
      return;
    }
    // browser: mount dikendalikan panel browser luar — pastikan tergantung.
    if (activeTab === "browser") {
      const pane = el("div", "wb-browser-pane");
      if (browserMount && browserMount.querySelector("#as-browser-root")) {
        pane.appendChild(browserMount.querySelector("#as-browser-root")!);
      }
      dockBody.appendChild(pane);
    }
  }

  function setTabBadges(o: { review: number; queue: number }): void {
    const rb = tabBadges.get("review");
    if (rb) { rb.hidden = !o.review; rb.textContent = String(o.review); }
    const pb = tabBadges.get("progress");
    if (pb) { pb.hidden = !o.queue; pb.textContent = String(o.queue); }
  }

  function ensureBrowserMount(): HTMLElement | null {
    if (!browserMount) return null;
    let m = browserMount.querySelector("#as-browser-root") as HTMLElement | null;
    if (!m) {
      m = el("div");
      m.id = "as-browser-root";
      browserMount.appendChild(m);
    }
    return m;
  }

  // ── Scroll helpers ─────────────────────────────────────────────
  let pinned = true;
  streamWrap.addEventListener("scroll", () => {
    const near = streamWrap.scrollHeight - streamWrap.scrollTop - streamWrap.clientHeight < 80;
    pinned = near;
    jump.classList.toggle("show", !near);
  });

  function stickBottom(): void {
    if (!pinned) return;
    streamWrap.scrollTop = streamWrap.scrollHeight;
  }

  function scrollToBottom(): void {
    pinned = true;
    streamWrap.scrollTop = streamWrap.scrollHeight;
    jump.classList.remove("show");
  }

  function setStreamPinned(): void { pinned = true; }

  return {
    renderItems, setHeader, setControls, setEmpty, setDock, setTab, setTabBadges,
    composer, stickBottom, scrollToBottom, setStreamPinned,
    ensureBrowserMount, headerElapsed, headerDot,
    destroy(): void {
      if (keyHandler) document.removeEventListener("keydown", keyHandler);
      keyHandler = null;
      capsule.remove();
      root.textContent = "";
      if (browserMount) browserMount.textContent = "";
      nodes.clear();
    },
  };
}

function formatDur(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(2, "0");
  const sss = String(ss).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}

// Re-export agar orchestrator cukup satu import untuk tipe model.
export { buildActivityItems };
export type { ActivityItem };
