/**
 * client/agent/panel/view.ts — Presentation layer Agent Workbench (Fase 4).
 *
 * Rebuild berdasarkan analisis source renderer ZCode (app.asar:
 * styles-Qlp0Bew7.js / styles-C8Nayk5k.css) — prinsip struktural yang
 * diadopsi, BUKAN branding-nya:
 *
 *   1. Satu permukaan + satu spine: struktur dari tipografi, indentasi,
 *      dan ritme jarak — kotak hanya untuk PENGENCULIAN (decision bar)
 *      dan DATA (diff/output pre).
 *   2. Aktivitas = baris tipis (ledger), bukan kartu. Baris selesai nyaris
 *      tanpa chrome (chevron muncul saat hover); yang aktif satu-satunya
 *      yang di-emphasize.
 *   3. Agregasi otomatis: run tool se-jenis (jelajah/terminal) ≥3 berurutan
 *      dilipat jadi satu baris grup yang bisa dibuka.
 *   4. Turn: giliran AKTIF terbuka penuh; selesai menyusut jadi header
 *      kalimat ber-snippet; detail kembali lewat klik (persisten).
 *   5. Progressive disclosure konten panjang: clip + mask fade + tombol
 *      pil "tampilkan semua" — bukan scrollbar dalam scrollbar.
 *   6. RESULT dipromosikan: jawaban final turn terakhir tampil sebagai
 *      region sendiri (markdown + meta turn), dikeluarkan dari strip
 *      conversation agar tidak tampil dobel.
 *
 * Rekonsiliasi keyed: setiap blok punya id+rev; elemen dibangun ulang hanya
 * bila rev berubah — streaming tidak memicu rebuild panel.
 */

import { createLifecycle } from "../../lifecycle";
import type { Block } from "./transcript";
import { computeSegments, formatDuration } from "./transcript";
import type { WorkSegment } from "./transcript";
import { changeFromTool, MAX_RENDER_ROWS } from "./diff";
import type { FileChange } from "./diff";
import { parseMarkdown } from "./md";
import type { MdInline, MdToken } from "./md";
import type { AgentStateView } from "./state";

export type PlanItem = { id?: string; task: string; status: string; note?: string };
export type TechnicalTab = "review" | "term" | "browser";

/** Kartu approval untuk decision bar (dari /status, sumber kebenaran). */
export type ApprovalView = { apId: string; tool: string; args: any; plan?: boolean };

/** Grup aktivitas hanya perlu terbuka selama minimal satu tool masih berjalan. */
export function toolRunIsTerminal(run: Array<{ status: string }>): boolean {
  return run.length > 0 && run.every((tool) => tool.status !== "running");
}

export type PanelViewDeps = {
  t: (key: string, vars?: Record<string, string | number>) => string;
  onApprove: (apId: string, approve: boolean, always?: boolean) => void;
  /** Dipanggil saat user pindah tab teknis; transcript selalu tetap terlihat. */
  onTabChange?: (tab: TechnicalTab) => void;
  /** Level tool ("safe"|"mutating") untuk badge; null = tak diketahui. */
  toolLevel?: (name: string) => "safe" | "mutating" | null;
  /** Batalkan task tertentu dari antrean (§11 cancel per-task). */
  onCancelTask?: (taskId: string) => void;
  /** Lipat/buka presence dock Live2D (body class + persist di panel). */
  onToggleStageDock?: () => void;
  /** Ringkas/kembalikan transkrip (class pada as-conv + persist di panel). */
  onToggleCompact?: () => void;
};

/** Keluarga tool untuk agregasi otomatis (padanan explore/terminal grouping
 *  ZCode). Semua tool se-keluarga dalam SATU turn digrup (narasi di antaranya
 *  tidak memutus — padanan filter reasoning ZCode); keluarga dengan ≥2 tool
 *  jadi grup kolaps. Tool mutating/visual TIDAK pernah digrup. */
const EXPLORE_TOOLS = new Set(["list_dir", "read_file", "search_code", "git_diff", "memory_recall"]);
const TERMINAL_TOOLS = new Set(["run_command"]);
const AS_GROUP_MIN = 2;

function toolFamily(name: string): "explore" | "terminal" | null {
  if (EXPLORE_TOOLS.has(name)) return "explore";
  if (TERMINAL_TOOLS.has(name)) return "terminal";
  return null;
}

/** Badge level tool di header baris: "auto" (mint) / "izin" (amber). */
function levelBadge(t: PanelViewDeps["t"], toolLevel: PanelViewDeps["toolLevel"], name: string): HTMLElement | null {
  const lvl = toolLevel?.(name);
  if (!lvl) return null;
  const b = el("span", "as-lvl" + (lvl === "safe" ? " safe" : " mutating"),
    t(lvl === "safe" ? "as.lvl.safe" : "as.lvl.mutating"));
  return b;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ── Render markdown (token data → DOM via textContent; tanpa innerHTML) ──
function buildInlines(parent: HTMLElement, inlines: MdInline[]): void {
  for (const inl of inlines) {
    switch (inl.t) {
      case "text": parent.appendChild(document.createTextNode(inl.text)); break;
      case "code": parent.appendChild(el("code", "as-md-code", inl.text)); break;
      case "bold": parent.appendChild(el("strong", "", inl.text)); break;
      case "italic": parent.appendChild(el("em", "", inl.text)); break;
      case "link": {
        // Hanya http(s) yang jadi anchor; lainnya teks biasa.
        const a = el("a", "as-md-link", inl.text) as HTMLAnchorElement;
        a.href = inl.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        parent.appendChild(a);
        break;
      }
    }
  }
}

function buildMd(tokens: MdToken[]): HTMLElement {
  const root = el("div", "as-md");
  for (const tk of tokens) {
    switch (tk.t) {
      case "h": root.appendChild(el("div", "as-md-h as-md-h" + tk.level)); buildInlines(root.lastChild as HTMLElement, tk.inlines); break;
      case "p": {
        const p = el("div", "as-md-p");
        buildInlines(p, tk.inlines);
        root.appendChild(p);
        break;
      }
      case "code": root.appendChild(el("pre", "as-md-pre", tk.text)); break;
      case "quote": {
        const q = el("div", "as-md-quote");
        buildInlines(q, tk.inlines);
        root.appendChild(q);
        break;
      }
      case "ul":
      case "ol": {
        const list = el(tk.t === "ul" ? "ul" : "ol", "as-md-list");
        for (const item of tk.items) {
          const li = el("li");
          buildInlines(li, item);
          list.appendChild(li);
        }
        root.appendChild(list);
      }
    }
  }
  return root;
}

export function createPanelView(root: HTMLElement, techRoot: HTMLElement | null, deps: PanelViewDeps) {
  const lifecycle = createLifecycle();
  const t = deps.t;

  // ── Skeleton workbench ──────────────────────────────────────────
  // Hierarki: HEAD (TASK/TURN + PLAN) → STREAM (aktivitas) → RESULT →
  // DECISION (approval) → CONVERSATION. Satu permukaan; kotak hanya untuk
  // decision bar dan blok data.
  const head = el("div", "as-head");

  // Baris 1 head: keadaan ambient + kontrol (dibangun renderStateLine).
  const statusbar = el("div", "as-statebar");
  const stDot = el("span", "as-state-dot");
  const stWord = el("span", "as-state-word");
  const stWhat = el("span", "as-state-what");
  const stElapsed = el("span", "as-state-elapsed");
  const stCounts = el("span", "as-state-counts");
  const stAllow = el("span", "as-state-allow") as HTMLElement;
  stAllow.hidden = true;
  const btnCompact = el("button", "as-state-btn") as HTMLButtonElement;
  const btnDock = el("button", "as-state-btn") as HTMLButtonElement;
  btnCompact.type = "button";
  btnDock.type = "button";
  statusbar.append(stDot, stWord, stWhat, stElapsed, stCounts, stAllow, btnCompact, btnDock);

  // Baris 2-3 head: task + plan (dibangun renderTask).
  const taskBox = el("div", "as-task hidden");
  head.append(statusbar, taskBox);

  // STREAM: timeline aktivitas per giliran (turn).
  const stream = el("div", "as-stream");
  stream.setAttribute("aria-live", "polite");
  const streamEmpty = el("div", "as-stream-empty", t("as.work.empty"));

  // RESULT: jawaban final giliran terakhir dipromosikan.
  const resultBox = el("div", "as-result hidden");
  const resultHead = el("div", "as-result-hd");
  resultHead.appendChild(el("span", "as-result-label", t("as.result.label")));
  const resultMeta = el("span", "as-result-meta");
  resultHead.appendChild(resultMeta);
  const resultBody = el("div", "as-result-body");
  resultBox.append(resultHead, resultBody);

  // DECISION: kartu approval — satu-satunya permukaan elevated.
  const controls = el("div", "as-controls empty");
  const ctlHead = el("div", "as-controls-hd", "⏸ " + t("as.decision.waiting"));
  const ctlRendered = new Map<string, HTMLElement>();

  // CONVERSATION: strip chat (user pill kanan, agent prosa kiri).
  const conv = el("div", "as-conv");
  conv.setAttribute("aria-live", "polite");

  root.append(head, stream, resultBox, controls, conv);

  let lastSv: AgentStateView | null = null;
  lifecycle.interval(() => paintStateElapsed(), 1000);

  function paintStateElapsed(): void {
    if (!lastSv) return;
    const live = lastSv.state === "thinking" || lastSv.state === "executing"
      || lastSv.state === "waitingPlan" || lastSv.state === "waitingApproval";
    stElapsed.textContent = live && lastSv.elapsedMs > 0 ? formatDuration(lastSv.elapsedMs) : "";
  }

  const stateWordKey: Record<AgentStateView["state"], string> = {
    off: "as.state.off",
    idle: "as.state.idle",
    thinking: "as.state.thinking",
    executing: "as.state.executing",
    waitingPlan: "as.state.waitingPlan",
    waitingApproval: "as.state.waitingApproval",
  };

  /** Chip allowlist sesi: hanya tool mutating yang relevan. */
  function paintAllowChip(list: string[] | undefined): void {
    const mutating = [...new Set((list || [])
      .map((a) => a.split(":")[0])
      .filter((n) => deps.toolLevel?.(n) === "mutating"))];
    stAllow.hidden = mutating.length === 0;
    if (!mutating.length) { stAllow.textContent = ""; stAllow.title = ""; return; }
    stAllow.textContent = mutating.length === 1
      ? t("as.allowChip1", { name: mutating[0] })
      : t("as.allowChipN", { n: mutating.length });
    stAllow.title = t("as.allowChipTitle") + "\n" + mutating.join("\n");
  }

  function renderStateLine(sv: AgentStateView, ui: { compact: boolean; stageHidden: boolean; allowlist?: string[] }): void {
    lastSv = sv;
    statusbar.dataset.state = sv.state;
    stWord.textContent = t(stateWordKey[sv.state]);
    stWhat.textContent = sv.what;
    stWhat.hidden = !sv.what;
    paintStateElapsed();
    stCounts.textContent = [
      sv.stepsTotal > 0 ? t("as.state.steps", { done: sv.stepsDone, total: sv.stepsTotal }) : "",
      sv.filesTouched > 0 ? t("as.state.files", { n: sv.filesTouched }) : "",
    ].filter(Boolean).join(" · ");
    paintAllowChip(ui.allowlist);
    btnCompact.textContent = ui.compact ? t("as.compact.expand") : t("as.compact.collapse");
    btnDock.textContent = ui.stageHidden ? t("as.dock.show") : t("as.dock.hide");
    btnDock.title = btnDock.textContent;
    conv.classList.toggle("compact", ui.compact);
  }
  lifecycle.listen(btnCompact, "click", () => deps.onToggleCompact?.());
  lifecycle.listen(btnDock, "click", () => deps.onToggleStageDock?.());

  // ── Tab teknis: Review / Terminal / Browser ──────────────────────
  let curTab: TechnicalTab = "review";
  const tabsBar = el("div", "as-tabs");
  const tabBtns: Record<TechnicalTab, HTMLButtonElement> = {} as any;
  for (const name of ["review", "term", "browser"] as TechnicalTab[]) {
    const btn = el("button", "as-tab") as HTMLButtonElement;
    btn.type = "button";
    btn.dataset.tab = name;
    btn.textContent = t(name === "review" ? "as.tab.review" : name === "term" ? "as.tab.terminal" : "as.tab.browser");
    lifecycle.listen(btn, "click", () => setTab(name));
    tabBtns[name] = btn;
    tabsBar.appendChild(btn);
  }
  const techCollapse = el("button", "as-tech-collapse", "›") as HTMLButtonElement;
  techCollapse.type = "button";
  techCollapse.title = t("as.tech.collapse");
  techCollapse.setAttribute("aria-label", t("as.tech.collapse"));
  tabsBar.appendChild(techCollapse);
  const techShell = techRoot?.closest("#agent-tech") as HTMLElement | null;
  const agentWorkspace = techRoot?.closest("#agent-workspace") as HTMLElement | null;
  function setTechCollapsed(on: boolean): void {
    techShell?.classList.toggle("collapsed", on);
    agentWorkspace?.classList.toggle("tech-collapsed", on);
    techCollapse.textContent = on ? "‹" : "›";
    techCollapse.title = t(on ? "as.tech.expand" : "as.tech.collapse");
    techCollapse.setAttribute("aria-label", techCollapse.title);
    techCollapse.setAttribute("aria-expanded", on ? "false" : "true");
    try { localStorage.setItem("live2d.agentTech.collapsed", on ? "1" : "0"); } catch {}
  }
  lifecycle.listen(techCollapse, "click", () => setTechCollapsed(!techShell?.classList.contains("collapsed")));

  const reviewPage = el("div", "as-page as-review");
  const termPage = el("div", "as-page as-term hidden");
  const browserPage = el("div", "as-page as-browser hidden");
  const browserMount = el("div");
  browserMount.id = "as-browser-root";
  browserPage.appendChild(browserMount);

  function setTab(name: TechnicalTab): void {
    curTab = name;
    for (const k of ["review", "term", "browser"] as TechnicalTab[]) {
      tabBtns[k].classList.toggle("active", k === name);
    }
    reviewPage.classList.toggle("hidden", name !== "review");
    termPage.classList.toggle("hidden", name !== "term");
    browserPage.classList.toggle("hidden", name !== "browser");
    deps.onTabChange?.(name);
  }

  function activeTab(): TechnicalTab {
    return curTab;
  }

  const queueBox = el("div", "as-queue hidden");
  const memBox = el("div", "as-plan as-membox hidden");
  root.appendChild(queueBox);
  root.appendChild(memBox);
  if (techRoot) {
    techRoot.appendChild(tabsBar);
    techRoot.appendChild(reviewPage);
    techRoot.appendChild(termPage);
    techRoot.appendChild(browserPage);
    try { setTechCollapsed(localStorage.getItem("live2d.agentTech.collapsed") === "1"); }
    catch { setTechCollapsed(false); }
  }
  tabBtns.review.classList.add("active");

  // ── Rekonsiliasi keyed ──────────────────────────────────────────
  const rendered = new Map<number, { el: HTMLElement; rev: number }>();
  const openTools = new Set<number>();      // detail tool terbuka
  const outFull = new Set<number>();        // output "tampilkan semua"
  const openGroups = new Set<string>();     // grup agregasi dibuka user
  const openDiffs = new Set<string>();      // diff terbuka (key `${id}:${path}`)
  const openChanges = new Set<string>();    // daftar file changes terbuka

  function nearBottom(elm: HTMLElement): boolean {
    return elm.scrollHeight - elm.scrollTop - elm.clientHeight < 60;
  }
  function stickTo(elm: HTMLElement): void {
    elm.scrollTop = elm.scrollHeight;
  }

  // ── Diff (blok data — tetap ber-background) ─────────────────────
  function buildDiff(ch: FileChange, key: string, openByDefault = false): HTMLElement {
    const w = el("div", "as-diff");
    w.dataset.kind = ch.kind;
    const hd = el("button", "as-diff-hd") as HTMLButtonElement;
    hd.type = "button";
    hd.appendChild(el("span", "as-diff-kind", ch.kind));
    hd.appendChild(el("span", "as-diff-path", ch.path));
    const stat = el("span", "as-diff-stat");
    stat.appendChild(el("span", "add", "+" + ch.added));
    stat.appendChild(el("span", "del", "−" + ch.removed));
    hd.appendChild(stat);
    const bd = el("div", "as-diff-bd");
    if (!ch.hunks.length) {
      bd.appendChild(el("div", "as-clipped", t(ch.clipped ? "as.diff.tooBig" : "as.diff.empty")));
    } else {
      let shown = 0;
      let truncated = false;
      for (const h of ch.hunks) {
        if (shown >= MAX_RENDER_ROWS) { truncated = true; break; }
        bd.appendChild(el("div", "as-diff-h", "@@ -" + h.aStart + " +" + h.bStart + " @@"));
        for (const r of h.rows) {
          if (shown >= MAX_RENDER_ROWS) { truncated = true; break; }
          const sign = r.t === "add" ? "+" : r.t === "del" ? "−" : " ";
          bd.appendChild(el("div", "as-diff-ln " + r.t, sign + r.text));
          shown++;
        }
      }
      if (truncated || ch.clipped) bd.appendChild(el("span", "as-clipped", t("as.diff.clipped")));
    }
    if (openByDefault || openDiffs.has(key)) w.classList.add("open");
    hd.addEventListener("click", () => {
      w.classList.toggle("open");
      if (w.classList.contains("open")) openDiffs.add(key);
      else openDiffs.delete(key);
    });
    w.appendChild(hd);
    w.appendChild(bd);
    return w;
  }

  /** Output panjang → clip + fade + pil "tampilkan semua" (bukan scrollbar
   *  dalam — pola Wfn ZCode). Deterministik dari ukuran teks. */
  function buildOutput(text: string, key: number): HTMLElement {
    const wrap = el("div", "as-out");
    wrap.appendChild(el("pre", "as-tool-res", text));
    const long = text.length > 600 || text.split("\n").length > 9;
    if (long && !outFull.has(key)) {
      wrap.classList.add("clipped");
      const more = el("button", "as-out-more", t("as.show.more")) as HTMLButtonElement;
      more.type = "button";
      more.addEventListener("click", () => {
        outFull.add(key);
        wrap.classList.remove("clipped");
        more.remove();
      });
      wrap.appendChild(more);
    }
    return wrap;
  }

  // ── Decision bar (approval) ─────────────────────────────────────
  function buildApprovalCard(ap: ApprovalView): HTMLElement {
    const w = el("div", "as-blk as-appr");
    const hd = el("div", "as-appr-hd");
    const isPlan = ap.plan === true;
    hd.appendChild(el("span", "as-appr-ttl", isPlan ? t("as.approve.planTitle") : t("as.approve.title")));
    if (!isPlan) {
      hd.appendChild(el("span", "as-tool-name", ap.tool));
      const apBadge = levelBadge(t, deps.toolLevel, ap.tool);
      if (apBadge) hd.appendChild(apBadge);
    }
    w.appendChild(hd);
    if (isPlan) {
      const list = el("div", "as-plan as-appr-plan");
      const todos = Array.isArray(ap.args?.todos) ? ap.args.todos : [];
      for (const p of todos) {
        const row = el("div", "as-plan-item");
        row.appendChild(el("span", "st " + (p.status ?? "pending"), p.status ?? "pending"));
        row.appendChild(el("span", "", String(p.task ?? "") + (p.note ? " — " : "")));
        if (p.note) row.appendChild(el("span", "note", p.note));
        list.appendChild(row);
      }
      w.appendChild(list);
    } else {
      const argsText = (() => {
        try { return ap.args == null ? "" : JSON.stringify(ap.args, null, 2); }
        catch { return String(ap.args); }
      })();
      const preview = changeFromTool(ap.tool, ap.args);
      if (preview && preview.hunks.length) {
        w.appendChild(buildDiff(preview, "appr:" + ap.apId, true));
      } else if (argsText) {
        w.appendChild(el("pre", "as-tool-args", argsText));
      }
    }
    const row = el("div", "as-appr-row");
    const ok = el("button", "mini-btn as-appr-ok", t("as.allow")) as HTMLButtonElement;
    ok.type = "button";
    const no = el("button", "mini-btn as-appr-no", t("as.deny")) as HTMLButtonElement;
    no.type = "button";
    let always: HTMLInputElement | null = null;
    if (!isPlan) {
      const what = ap.tool === "run_command" ? t("as.approve.thisCommand") : ap.tool;
      always = document.createElement("input") as HTMLInputElement;
      always.type = "checkbox";
      const alwaysRow = el("label", "as-appr-always") as HTMLLabelElement;
      alwaysRow.append(always, document.createTextNode(t("as.approve.always", { what })));
      w.appendChild(alwaysRow);
    }
    ok.addEventListener("click", () => {
      ok.disabled = true;
      no.disabled = true;
      deps.onApprove(ap.apId, true, isPlan ? false : !!always?.checked);
    });
    no.addEventListener("click", () => {
      ok.disabled = true;
      no.disabled = true;
      if (always) always.checked = false;
      deps.onApprove(ap.apId, false);
    });
    row.appendChild(ok);
    row.appendChild(no);
    w.appendChild(row);
    return w;
  }

  function renderControls(list: ApprovalView[]): void {
    const sig = list.map((a) => a.apId + ":" + a.tool + ":" + (a.plan ? "p" : "t")).join(",");
    if (!list.length) {
      controls.classList.add("empty");
      if (ctlHead.parentElement === controls) ctlHead.remove();
      for (const [, node] of [...ctlRendered]) node.remove();
      ctlRendered.clear();
      return;
    }
    controls.classList.remove("empty");
    if (ctlHead.parentElement !== controls) controls.insertBefore(ctlHead, controls.firstChild);
    const seen = new Set<string>();
    for (const ap of list) {
      seen.add(ap.apId);
      const key = ap.apId + ":" + ap.tool + ":" + (ap.plan ? "p" : "t");
      let node = ctlRendered.get(key);
      if (!node) {
        node = buildApprovalCard(ap);
        ctlRendered.set(key, node);
      }
      controls.appendChild(node);
    }
    for (const [key, node] of [...ctlRendered]) {
      if (!seen.has(key.split(":")[0])) {
        node.remove();
        ctlRendered.delete(key);
      }
    }
  }

  // ── Baris aktivitas ─────────────────────────────────────────────
  /** Baris tool (frameless): dot status + nama mono + ringkasan redup +
   *  durasi; chevron hanya muncul saat hover/terbuka. Detail terbuka =
   *  zona indentasi milik baris di atasnya. */
  function buildToolRow(b: Extract<Block, { kind: "tool" }>): HTMLElement {
    const w = el("div", "as-trow");
    w.dataset.status = b.status;
    const hd = el("button", "as-trow-hd") as HTMLButtonElement;
    hd.type = "button";
    hd.appendChild(el("span", "as-dot"));
    hd.appendChild(el("span", "as-trow-name", b.name));
    const lvBadge = levelBadge(t, deps.toolLevel, b.name);
    if (lvBadge) hd.appendChild(lvBadge);
    if (b.summary) hd.appendChild(el("span", "as-trow-sum", b.summary));
    if (typeof b.durMs === "number" && b.status !== "running") {
      hd.appendChild(el("span", "as-trow-dur", formatDuration(b.durMs)));
    }
    hd.appendChild(el("span", "as-chev", "▸"));
    const bd = el("div", "as-trow-bd");
    if (b.change) {
      bd.appendChild(buildDiff(b.change, String(b.id) + ":" + b.change.path));
    } else if (b.argsText != null) {
      bd.appendChild(el("div", "as-lbl", t("as.tool.args")));
      bd.appendChild(el("pre", "as-tool-args", b.argsText));
    }
    if (b.result != null) {
      bd.appendChild(el("div", "as-lbl", t("as.tool.result")));
      bd.appendChild(buildOutput(b.result, b.id));
    }
    if (openTools.has(b.id)) w.classList.add("open");
    hd.addEventListener("click", () => {
      w.classList.toggle("open");
      if (w.classList.contains("open")) openTools.add(b.id);
      else openTools.delete(b.id);
    });
    w.appendChild(hd);
    w.appendChild(bd);
    return w;
  }

  /** Baris grup agregat: run tool se-keluarga dilipat jadi satu baris.
   *  Ada tool berjalan di dalamnya → grup terbuka otomatis. */
  function buildGroupRow(kind: "explore" | "terminal", items: Extract<Block, { kind: "tool" }>[]): HTMLElement {
    const key = kind + ":" + items[0].id;
    const w = el("div", "as-tgroup");
    w.dataset.kind = kind;
    const anyRunning = items.some((i) => i.status === "running");
    const anyFail = items.some((i) => i.status === "error");
    w.dataset.status = anyRunning ? "running" : anyFail ? "error" : "done";
    const hd = el("button", "as-tgroup-hd") as HTMLButtonElement;
    hd.type = "button";
    hd.appendChild(el("span", "as-dot"));
    hd.appendChild(el("span", "as-tgroup-label", t(kind === "explore" ? "as.group.explore" : "as.group.terminal")));
    hd.appendChild(el("span", "as-tgroup-cnt", t("as.seg.count", { n: items.length })));
    hd.appendChild(el("span", "as-chev", "▸"));
    const bd = el("div", "as-tgroup-bd");
    const open = openGroups.has(key) || (anyRunning && !openGroups.has("-" + key));
    if (open) w.classList.add("open");
    hd.addEventListener("click", () => {
      // toggle + catat preferensi eksplisit user (menang atas auto)
      const isOpen = w.classList.contains("open");
      w.classList.toggle("open", !isOpen);
      if (openGroups.has(key)) openGroups.delete(key);
      else openGroups.add(key);
      if (anyRunning) {
        // tandai bahwa user sudah memilih — auto-open tidak menimpa
        if (isOpen) openGroups.add("-" + key);
        else openGroups.delete("-" + key);
      }
    });
    w.appendChild(hd);
    w.appendChild(bd);
    return w;
  }

  /** Ringkasan perubahan file per giliran — baris hasil, file di bawahnya
   *  dengan diff sebagai blok data. */
  function buildChanges(b: Extract<Block, { kind: "changes" }>): HTMLElement {
    const w = el("div", "as-chg");
    const hd = el("button", "as-chg-hd") as HTMLButtonElement;
    hd.type = "button";
    hd.appendChild(el("span", "as-chg-ttl", t("as.chg.files", { n: b.files.length })));
    const stat = el("span", "as-diff-stat");
    stat.appendChild(el("span", "add", "+" + b.added));
    stat.appendChild(el("span", "del", "−" + b.removed));
    hd.appendChild(stat);
    const key = String(b.id);
    const open = openChanges.has(key);
    if (open) w.classList.add("open");
    const list = el("div", "as-chg-list");
    for (const f of b.files) {
      const item = el("div", "as-chg-item");
      const row = el("div", "as-chg-row");
      row.appendChild(el("span", "as-chg-kind", f.kind));
      row.appendChild(el("span", "as-chg-path", f.path));
      const st = el("span", "as-diff-stat");
      st.appendChild(el("span", "add", "+" + f.added));
      st.appendChild(el("span", "del", "−" + f.removed));
      row.appendChild(st);
      const dkey = b.id + ":" + f.path;
      const body = buildDiff(f, dkey);
      row.addEventListener("click", () => {
        body.classList.toggle("open");
        if (body.classList.contains("open")) openDiffs.add(dkey);
        else openDiffs.delete(dkey);
      });
      item.appendChild(row);
      item.appendChild(body);
      list.appendChild(item);
    }
    if (open) list.classList.add("open");
    hd.addEventListener("click", () => {
      const isOpen = list.classList.contains("open");
      list.classList.toggle("open", !isOpen);
      if (isOpen) openChanges.delete(key);
      else openChanges.add(key);
    });
    w.appendChild(hd);
    w.appendChild(list);
    return w;
  }

  function buildBlock(b: Block): HTMLElement {
    switch (b.kind) {
      case "user": {
        const w = el("div", "as-blk as-user");
        w.appendChild(el("span", "as-who", t("as.you")));
        w.appendChild(el("div", "as-txt", b.text));
        return w;
      }
      case "agent": {
        const w = el("div", "as-blk as-agent");
        const txt = el("div", "as-txt", b.text);
        if (b.streaming) txt.appendChild(el("span", "as-caret"));
        w.appendChild(txt);
        return w;
      }
      case "final": {
        const w = el("div", "as-blk as-agent as-final");
        w.appendChild(el("span", "as-who", t("as.agentName")));
        w.appendChild(buildMd(parseMarkdown(b.text)));
        return w;
      }
      case "speak": {
        const w = el("div", "as-blk as-speak");
        w.appendChild(el("span", "as-who", t("as.speakTag")));
        w.appendChild(el("div", "as-txt", b.text));
        return w;
      }
      case "status": {
        const w = el("div", "as-blk as-status" + (b.variant ? " " + b.variant : ""));
        w.textContent = b.text;
        return w;
      }
      case "tool":
        return buildToolRow(b);
      case "approval": {
        // Kartu approval TIDAK dirender di aliran — semua di decision bar.
        return buildApprovalCard({ apId: b.apId, tool: b.tool, args: b.args, plan: b.plan });
      }
      case "subagent": {
        const w = el("div", "as-blk as-sub");
        w.dataset.state = b.state;
        w.appendChild(el("span", "as-sub-name", b.name));
        w.appendChild(el("span", "as-sub-text", b.text));
        return w;
      }
      case "changes":
        return buildChanges(b);
    }
  }

  /** Narasi kerja (agent bicara DI TENGAH eksekusi) — baris redup. */
  function buildWorkNote(b: Extract<Block, { kind: "agent" }>): HTMLElement {
    const w = el("div", "as-note");
    w.appendChild(el("span", "as-note-txt", b.text));
    if (b.streaming) w.classList.add("streaming");
    return w;
  }

  /** Render satu blok ke parent tertentu (keyed by id+rev; pindah parent
   *  otomatis lewat appendChild). */
  function renderInto(parent: HTMLElement, b: Block, seen: Set<number>): HTMLElement {
    seen.add(b.id);
    const cur = rendered.get(b.id);
    if (cur && cur.rev === b.rev) {
      if (cur.el.parentElement !== parent) parent.appendChild(cur.el);
      return cur.el;
    }
    const node = b.kind === "agent" ? buildWorkNote(b) : buildBlock(b);
    if (cur) {
      cur.el.replaceWith(node);
      cur.el = node;
      cur.rev = b.rev;
    } else {
      rendered.set(b.id, { el: node, rev: b.rev });
    }
    parent.appendChild(node);
    return node;
  }

  // ── STREAM: turn per giliran ────────────────────────────────────
  type TurnState = {
    wrap: HTMLElement;
    body: HTMLElement;
    sig: string;
    userToggled: boolean | null;
  };
  const turns = new Map<string, TurnState>();
  const groups = new Map<string, { wrap: HTMLElement; body: HTMLElement; sig: string }>();

  /** Susun isi turn: baris tunggal + grup agregat per keluarga. Semua tool
   *  se-keluarga dalam turn dikumpulkan ke SATU grup di posisi tool pertama
   *  keluarga itu (narasi di antaranya tidak memutus grup — padanan ZCode
   *  yang memfilter reasoning dari grouping). */
  type StreamItem =
    | { kind: "row"; b: Block }
    | { kind: "group"; family: "explore" | "terminal"; items: Extract<Block, { kind: "tool" }>[] };

  function planStreamItems(work: Block[]): StreamItem[] {
    // Hitung per keluarga dulu.
    const famCount = new Map<"explore" | "terminal", number>();
    for (const b of work) {
      if (b.kind !== "tool") continue;
      const f = toolFamily(b.name);
      if (f) famCount.set(f, (famCount.get(f) ?? 0) + 1);
    }
    const consumed = new Set<"explore" | "terminal">();
    const items: StreamItem[] = [];
    for (const b of work) {
      if (b.kind !== "tool") { items.push({ kind: "row", b }); continue; }
      const f = toolFamily(b.name);
      if (!f || (famCount.get(f) ?? 0) < AS_GROUP_MIN || consumed.has(f)) {
        items.push({ kind: "row", b });
        continue;
      }
      // Posisi tool PERTAMA keluarga ini → keluarkan grup berisi semua tool
      // se-keluarga (urutan kronologis di dalam grup).
      const all = work.filter((w): w is Extract<Block, { kind: "tool" }> => w.kind === "tool" && toolFamily(w.name) === f);
      consumed.add(f);
      items.push({ kind: "group", family: f, items: all });
    }
    return items;
  }

  function renderTurn(seg: WorkSegment, seen: Set<number>, order: number): void {
    const state = seg.open ? "open" : seg.interrupted ? "interrupted" : "completed";
    const workSig = seg.work.map((b) => b.id + ":" + (b.kind === "tool" ? b.status : b.kind) + ":" + b.rev).join(",");
    const sig = state + "|" + workSig;
    let g = turns.get(seg.key);
    if (!g) {
      const wrap = el("div", "as-turn");
      const hd = el("button", "as-turn-hd") as HTMLButtonElement;
      hd.type = "button";
      const main = el("div", "as-turn-main");
      main.append(el("span", "as-turn-task"), el("div", "as-turn-meta"));
      hd.appendChild(el("span", "as-turn-state"));
      hd.appendChild(main);
      hd.appendChild(el("span", "as-chev", "▸"));
      const body = el("div", "as-turn-bd");
      hd.addEventListener("click", () => {
        const isOpen = wrap.classList.contains("open");
        wrap.classList.toggle("open", !isOpen);
        wrap.classList.toggle("closed", isOpen);
        if (g) g.userToggled = !isOpen;
      });
      wrap.append(hd, body);
      g = { wrap, body, sig: "", userToggled: null };
      turns.set(seg.key, g);
      stream.appendChild(wrap);
    }
    if (stream.children[order] !== g.wrap) stream.insertBefore(g.wrap, stream.children[order] ?? null);
    if (g.sig !== sig) {
      const stEl = g.wrap.querySelector(".as-turn-state") as HTMLElement;
      stEl.textContent = seg.open ? t("as.work.current") : seg.interrupted ? t("as.seg.interrupted") : t("as.seg.completed");
      g.wrap.dataset.state = state;
      const snippet = (seg.trigger?.text ?? "").trim().slice(0, 72);
      (g.wrap.querySelector(".as-turn-task") as HTMLElement).textContent = snippet;
      const meta = g.wrap.querySelector(".as-turn-meta") as HTMLElement;
      meta.textContent = "";
      const toolCount = seg.toolsOk + seg.toolsFail;
      if (toolCount > 0) {
        meta.appendChild(el("span", "as-turn-cnt",
          seg.toolsFail > 0
            ? t("as.seg.countFail", { ok: seg.toolsOk, fail: seg.toolsFail })
            : t("as.seg.count", { n: toolCount })));
      }
      meta.appendChild(el("span", "as-turn-dur", seg.open
        ? (seg.startedAt ? formatDuration(Date.now() - seg.startedAt) : "")
        : (seg.startedAt && seg.endedAt ? formatDuration(seg.endedAt - seg.startedAt) : "")));
      // Turn AKTIF default terbuka; selesai collapse — pilihan user menang.
      const openNow = g.userToggled != null ? g.userToggled : seg.open;
      g.wrap.classList.toggle("open", openNow);
      g.wrap.classList.toggle("closed", !openNow);
      g.sig = sig;
    }
    // Isi turn: baris + grup agregat.
    const items = planStreamItems(seg.work);
    let childOrder = 0;
    for (const item of items) {
      if (item.kind === "group") {
        const gkey = item.family + ":" + item.items[0].id;
        const sigG = item.items.map((b) => b.id + ":" + b.status + ":" + b.rev).join(",");
        let gr = groups.get(gkey);
        if (!gr) {
          const node = buildGroupRow(item.family, item.items);
          gr = { wrap: node, body: node.querySelector(".as-tgroup-bd") as HTMLElement, sig: "" };
          groups.set(gkey, gr);
        }
        if (gr.sig !== sigG) {
          const anyRunning = item.items.some((i2) => i2.status === "running");
          const anyFail = item.items.some((i2) => i2.status === "error");
          gr.wrap.dataset.status = anyRunning ? "running" : anyFail ? "error" : "done";
          const cnt = gr.wrap.querySelector(".as-tgroup-cnt") as HTMLElement;
          if (cnt) cnt.textContent = t("as.seg.count", { n: item.items.length });
          for (const tb of item.items) renderInto(gr.body, tb, seen);
          gr.sig = sigG;
        } else {
          // Anak grup di-skip (sig sama) — tetap TANDAI seen, kalau tidak
          // cleanup akhir render menganggapnya mati dan menghapusnya
          // (sumber flip-flop grup hilang/muncul antar poll).
          for (const tb of item.items) seen.add(tb.id);
        }
        if (g.body.children[childOrder] !== gr.wrap) g.body.insertBefore(gr.wrap, g.body.children[childOrder] ?? null);
        childOrder++;
      } else {
        renderInto(g.body, item.b, seen);
        childOrder++;
      }
    }
    // Rapikan urutan anak sesuai items (row/group campuran).
    const wanted: HTMLElement[] = [];
    for (const item of items) {
      if (item.kind === "group") {
        const gkey = item.family + ":" + item.items[0].id;
        const gr = groups.get(gkey);
        if (gr) wanted.push(gr.wrap);
      } else {
        const cur = rendered.get(item.b.id);
        if (cur) wanted.push(cur.el);
      }
    }
    wanted.forEach((elm, idx) => {
      if (g.body.children[idx] !== elm) g.body.insertBefore(elm, g.body.children[idx] ?? null);
    });
  }

  // ── RENDER utama ────────────────────────────────────────────────
  function render(blocks: Block[]): void {
    const stickStream = nearBottom(stream);
    const stickConv = nearBottom(conv);
    const segs = computeSegments(blocks);

    // Promosi RESULT: final terakhir; meta dari turn yang memuatnya.
    let promoted: Extract<Block, { kind: "final" }> | null = null;
    let promotedSeg: WorkSegment | null = null;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === "final") { promoted = b; break; }
    }
    if (promoted) {
      promotedSeg = segs.find((s) => s.final === promoted) ?? null;
    }

    const seen = new Set<number>();
    // 1) STREAM: turn per segmen ber-work; leading block non-final ke stream.
    let order = 0;
    for (const seg of segs) {
      if (!seg.trigger) {
        for (const b of seg.work) {
          if (b.kind === "speak") continue;
          renderInto(stream, b, seen);
        }
        continue;
      }
      if (seg.work.length) {
        renderTurn(seg, seen, order);
        order++;
      }
    }
    // Buang turn yang hilang + rapikan urutan.
    const wantedTurns: HTMLElement[] = [];
    for (const seg of segs) {
      if (seg.trigger && seg.work.length) {
        const g = turns.get(seg.key);
        if (g) wantedTurns.push(g.wrap);
      }
    }
    wantedTurns.forEach((elm, idx) => {
      if (stream.children[idx] !== elm) stream.insertBefore(elm, stream.children[idx] ?? null);
    });
    for (const [key, g] of [...turns]) {
      if (!segs.some((s) => s.key === key)) {
        g.wrap.remove();
        turns.delete(key);
      }
    }
    // Empty state stream.
    streamEmpty.remove();
    if (!stream.children.length) stream.appendChild(streamEmpty);

    // 2) RESULT: final terakhir + meta turn-nya.
    if (promoted) {
      resultBox.classList.remove("hidden");
      resultMeta.textContent = "";
      if (promotedSeg) {
        const toolCount = promotedSeg.toolsOk + promotedSeg.toolsFail;
        const bits: string[] = [];
        if (toolCount > 0) bits.push(t("as.seg.count", { n: toolCount }));
        if (promotedSeg.startedAt && promotedSeg.endedAt) bits.push(formatDuration(promotedSeg.endedAt - promotedSeg.startedAt));
        if (promotedSeg.changes > 0) bits.push(t("as.chg.files", { n: promotedSeg.changes }));
        resultMeta.textContent = bits.join(" · ");
      }
      renderInto(resultBody, promoted, seen);
      // Diff perubahan turn terakhir ikut tampil di result (bila ada).
    } else {
      resultBox.classList.add("hidden");
    }

    // 3) CONVERSATION: user/agent/speak + final SELAIN yang dipromosikan.
    for (const b of blocks) {
      if (b.kind === "user" || b.kind === "speak" || b.kind === "agent") {
        renderInto(conv, b, seen);
      } else if (b.kind === "final" && b !== promoted) {
        renderInto(conv, b, seen);
      }
    }
    // Buang blok yang sudah tidak ada.
    for (const [id, cur] of [...rendered]) {
      if (!seen.has(id)) {
        cur.el.remove();
        rendered.delete(id);
        openTools.delete(id);
        outFull.delete(id);
        const pref = id + ":";
        for (const k of [...openDiffs]) if (k.startsWith(pref)) openDiffs.delete(k);
      }
    }
    // Buang grup yatim (blok pertamanya hilang).
    for (const [key, g] of [...groups]) {
      const firstId = Number(key.split(":")[1]);
      if (!rendered.has(firstId)) {
        g.wrap.remove();
        groups.delete(key);
      }
    }
    if (stickStream) stickTo(stream);
    if (stickConv) stickTo(conv);
    for (const elm of [stream, conv]) {
      const max = Math.max(0, elm.scrollHeight - elm.clientHeight);
      if (elm.scrollTop > max) elm.scrollTop = max;
    }
  }

  // ── HEAD: task + plan ───────────────────────────────────────────
  function renderTask(task: string, plan: PlanItem[], sv: AgentStateView | null): void {
    taskBox.textContent = "";
    const tsk = String(task || "").trim();
    const hasPlan = !!(plan && plan.length);
    if (!tsk && !hasPlan) {
      taskBox.classList.add("hidden");
      taskBox.classList.remove("has-state");
      return;
    }
    taskBox.classList.remove("hidden");
    const headRow = el("div", "as-task-head");
    headRow.appendChild(el("span", "as-task-label", t("as.task")));
    if (hasPlan) {
      const done = plan.filter((p) => p.status === "done").length;
      headRow.appendChild(el("span", "as-task-prog", t("as.plan.progress", { done, total: plan.length })));
    }
    taskBox.appendChild(headRow);
    if (tsk) taskBox.appendChild(el("div", "as-task-text", tsk));
    if (sv) {
      taskBox.classList.add("has-state");
      taskBox.dataset.state = sv.state;
      const st = el("div", "as-task-status");
      st.appendChild(el("span", "as-task-dot"));
      st.appendChild(el("span", "as-task-stword", t(stateWordKey[sv.state])));
      if (sv.what) st.appendChild(el("span", "as-task-stwhat", sv.what));
      if (sv.elapsedMs > 0) st.appendChild(el("span", "as-task-stelapsed", formatDuration(sv.elapsedMs)));
      taskBox.appendChild(st);
    } else {
      taskBox.classList.remove("has-state");
    }
    if (hasPlan) {
      const active = plan.find((p) => p.status === "in_progress");
      if (active) taskBox.appendChild(el("div", "as-task-step", "▸ " + String(active.task ?? "")));
      const list = el("div", "as-task-list");
      for (const p of plan) {
        const row = el("div", "as-plan-item");
        row.appendChild(el("span", "st " + p.status, p.status));
        row.appendChild(el("span", "", p.task + (p.note ? " — " : "")));
        if (p.note) row.appendChild(el("span", "note", p.note));
        list.appendChild(row);
      }
      taskBox.appendChild(list);
    }
  }

  // ── Antrean task Worker (§9) ─────────────────────────────────────
  function renderQueue(parked: Array<{ taskId: string; prompt: string }>): void {
    queueBox.textContent = "";
    if (!parked || !parked.length) {
      queueBox.classList.add("hidden");
      return;
    }
    queueBox.classList.remove("hidden");
    const headRow = el("div", "as-task-head");
    headRow.appendChild(el("span", "as-task-label", t("as.queue")));
    headRow.appendChild(el("span", "as-task-prog", t("as.queue.count", { n: parked.length })));
    queueBox.appendChild(headRow);
    const list = el("div", "as-queue-list");
    parked.forEach((task, i) => {
      const row = el("div", "as-queue-item");
      row.appendChild(el("span", "as-queue-pos", String(i + 1)));
      row.appendChild(el("span", "as-queue-text", task.prompt || task.taskId));
      const btn = el("button", "as-queue-cancel") as HTMLButtonElement;
      btn.type = "button";
      btn.textContent = "✕";
      btn.title = t("as.queue.cancel");
      btn.setAttribute("aria-label", t("as.queue.cancel"));
      btn.addEventListener("click", () => deps.onCancelTask?.(task.taskId));
      row.appendChild(btn);
      list.appendChild(row);
    });
    queueBox.appendChild(list);
  }

  // ── Widget memory ───────────────────────────────────────────────
  function renderMemory(entries: Array<{ key: string; value: string }>, onForget: (key: string) => void): void {
    memBox.textContent = "";
    memBox.classList.remove("hidden");
    memBox.appendChild(el("div", "as-plan-ttl", t("as.memTitle")));
    if (!entries.length) {
      memBox.appendChild(el("div", "", t("as.memEmpty")));
      return;
    }
    for (const m of entries) {
      const row = el("div", "as-mem-row");
      row.appendChild(el("span", "k", "[" + m.key + "]"));
      row.appendChild(el("span", "", m.value));
      const forget = el("button", "mini-btn", t("as.memForget")) as HTMLButtonElement;
      forget.type = "button";
      forget.addEventListener("click", () => onForget(m.key));
      row.appendChild(forget);
      memBox.appendChild(row);
    }
  }

  function hideMemory(): void {
    memBox.classList.add("hidden");
    memBox.textContent = "";
  }

  function clearTranscript(): void {
    rendered.clear();
    openTools.clear();
    outFull.clear();
    openGroups.clear();
    openDiffs.clear();
    openChanges.clear();
    turns.clear();
    groups.clear();
    stream.textContent = "";
    resultBody.textContent = "";
    conv.textContent = "";
    resultBox.classList.add("hidden");
  }

  // ── Halaman Review (daftar perubahan file sesi) ─────────────────
  function renderReview(
    entries: Array<{ path: string; kind: string; added: number; removed: number; measured: boolean }>,
    opts: { canRevert: boolean; onRevert: (path: string) => void; onRefresh: () => void },
  ): void {
    reviewPage.textContent = "";
    const bar = el("div", "as-page-bar");
    if (entries.length) {
      bar.appendChild(el("span", "as-page-ttl", t("as.review.title", { n: entries.length })));
    }
    const refresh = el("button", "mini-btn", t("as.review.refresh")) as HTMLButtonElement;
    refresh.type = "button";
    refresh.addEventListener("click", () => opts.onRefresh());
    bar.appendChild(refresh);
    reviewPage.appendChild(bar);
    if (!entries.length) {
      reviewPage.appendChild(el("div", "as-page-empty", t("as.review.empty")));
      return;
    }
    for (const e of entries) {
      const row = el("div", "as-rev-row");
      row.appendChild(el("span", "as-chg-kind", e.measured ? e.kind : t("as.review.touched")));
      row.appendChild(el("span", "as-rev-path", e.path));
      if (e.measured) {
        const st = el("span", "as-diff-stat");
        st.appendChild(el("span", "add", "+" + e.added));
        st.appendChild(el("span", "del", "−" + e.removed));
        row.appendChild(st);
      }
      if (opts.canRevert) {
        const rv = el("button", "mini-btn as-rev-revert", t("as.review.revert")) as HTMLButtonElement;
        rv.type = "button";
        rv.addEventListener("click", () => opts.onRevert(e.path));
        row.appendChild(rv);
      }
      reviewPage.appendChild(row);
    }
  }

  // ── Halaman Terminal (log run_command) ──────────────────────────
  function renderTerm(entries: Array<{ cmd: string; result: string | null; error: boolean }>): void {
    termPage.textContent = "";
    const bar = el("div", "as-page-bar");
    bar.appendChild(el("span", "as-page-ttl", t("as.term.title", { n: entries.length })));
    termPage.appendChild(bar);
    if (!entries.length) {
      termPage.appendChild(el("div", "as-page-empty", t("as.term.empty")));
      return;
    }
    for (const e of entries) {
      const row = el("div", "as-term-row" + (e.error ? " err" : ""));
      row.appendChild(el("div", "as-term-cmd", "$ " + e.cmd));
      if (e.result != null) row.appendChild(el("pre", "as-term-res", e.result));
      else row.appendChild(el("div", "as-term-run", t("as.term.running")));
      termPage.appendChild(row);
    }
  }

  function destroy(): void {
    lifecycle.destroy();
  }

  return { render, renderTask, renderQueue, renderMemory, hideMemory, renderStateLine, renderControls, clearTranscript, setTab, activeTab, renderReview, renderTerm, destroy };
}

export type PanelView = ReturnType<typeof createPanelView>;
