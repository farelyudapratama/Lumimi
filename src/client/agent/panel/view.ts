/**
 * client/agent/panel/view.ts — Renderer DOM panel agent (Fase 3.5 Workbench).
 *
 * HIERARKI INFORMASI (mental model: agent workbench + companion presence):
 *   1. statebar      — keadaan ambient (Siap/Menyusun/Menunggu…) + toggle.
 *   2. TASK header   — objek kerja aktif: teks tugas + status live + plan.
 *   3. WORK region   — worklog eksekusi per giliran (segmen collapsible:
 *                      baris tool, narasi kerja, perubahan file).
 *   4. CONVERSATION  — percakapan user↔agent sebagai strip ringkas di bawah;
 *                      BUKAN lagi kanvas utama.
 *   5. Decision bar  — kartu approval sebagai titik kontrol eksekusi,
 *                      pinned tepat di atas composer.
 *
 * Rekonsiliasi keyed: setiap blok punya id+rev; elemen dibangun ulang hanya
 * bila rev berubah — teks yang sedang streaming tidak memicu rebuild panel.
 * Anggaran render dijaga: warna solid + hairline, tanpa blur/gradient.
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

/** Kartu approval untuk zona kontrol eksekusi (dari /status, sumber kebenaran). */
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

/** Badge level tool di header kartu: "auto" (mint) / "izin" (amber). */
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
  // ── Skeleton panel ──────────────────────────────────────────────
  // Garis keadaan = anchor harness: state machine + objek kerja + elapsed +
  // hitungan, dengan kontrol lipat di ujung kanan + chip allowlist sesi.
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
  let lastSv: AgentStateView | null = null;
  let lastUi: { compact: boolean; stageHidden: boolean; allowlist?: string[] } = { compact: false, stageHidden: false };
  lifecycle.interval(() => paintStateElapsed(), 1000); // detik berjalan tanpa poll

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

  /** Chip allowlist sesi: hanya tool mutating yang relevan (safe tak pernah
   *  menggerbangi). Jawaban atas "kok tadi sekali izin sekarang bebas?". */
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
    lastUi = ui;
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

  // ── Dua wilayah utama workbench ─────────────────────────────────
  // WORK: worklog eksekusi (kartu tool/status/changes/narasi per giliran).
  // CONVERSATION: strip percakapan user↔agent — turun hierarki, tetap ada.
  const work = el("div", "as-work");
  work.setAttribute("aria-live", "polite");
  const workEmpty = el("div", "as-wempty", t("as.work.empty"));
  const conv = el("div", "as-conv");
  conv.setAttribute("aria-live", "polite");

  // Zona kontrol eksekusi: kartu approval pinned di atas composer — bagian
  // dari kontrol kerja agent, bukan pesan yang tenggelam di transkrip.
  const controls = el("div", "as-controls empty");
  const ctlHead = el("div", "as-controls-hd", "⏸ " + t("as.decision.waiting"));
  const ctlRendered = new Map<string, HTMLElement>();

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
  // Panel teknis bisa dipadatkan tanpa menghilangkan fungsinya. Pilihan user
  // persisten; workspace ikut mengecil sehingga ruang kembali ke panggung.
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

  /** Tab teknis aktif (panel membaca untuk menggambar halaman saat poll). */
  function activeTab(): TechnicalTab {
    return curTab;
  }

  const taskBox = el("div", "as-task hidden");
  const queueBox = el("div", "as-queue hidden");
  const memBox = el("div", "as-plan as-membox hidden");

  root.appendChild(statusbar);
  root.appendChild(taskBox);
  root.appendChild(queueBox);
  root.appendChild(memBox);
  root.appendChild(work);
  root.appendChild(conv);
  root.appendChild(controls);
  if (techRoot) {
    techRoot.appendChild(tabsBar);
    techRoot.appendChild(reviewPage);
    techRoot.appendChild(termPage);
    techRoot.appendChild(browserPage);
    try { setTechCollapsed(localStorage.getItem("live2d.agentTech.collapsed") === "1"); }
    catch { setTechCollapsed(false); }
  }
  tabBtns.review.classList.add("active");

  // ── Rekonsiliasi transcript ─────────────────────────────────────
  const rendered = new Map<number, { el: HTMLElement; rev: number }>();
  const openTools = new Set<number>(); // state expand kartu tool per blok id
  const openDiffs = new Set<string>(); // state expand diff (key: `${id}:${path}`)

  // ── Diff & ringkasan perubahan file ─────────────────────────────
  /** Kartu diff satu file: header stat, body berisi hunk (collapsible). */
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
    hd.appendChild(el("span", "as-chev", "▾"));
    const bd = el("div", "as-diff-bd");
    if (!ch.hunks.length) {
      bd.appendChild(el("div", "as-clipped", t(ch.clipped ? "as.diff.tooBig" : "as.diff.empty")));
    } else {
      let shown = 0;
      let truncated = false;
      for (const h of ch.hunks) {
        if (shown >= MAX_RENDER_ROWS) { truncated = true; break; }
        bd.appendChild(el("div", "as-diff-h",
          "@@ -" + h.aStart + " +" + h.bStart + " @@"));
        for (const r of h.rows) {
          if (shown >= MAX_RENDER_ROWS) { truncated = true; break; }
          const sign = r.t === "add" ? "+" : r.t === "del" ? "−" : " ";
          bd.appendChild(el("div", "as-diff-ln " + r.t, sign + r.text));
          shown++;
        }
      }
      if (truncated || ch.clipped) {
        bd.appendChild(el("span", "as-clipped", t("as.diff.clipped")));
      }
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

  /**
   * Kartu approval untuk decision bar. Dua gate TETAP berbeda (Fase 2):
   * kartu PLAN (setujui rencana kerja sebelum eksekusi) vs kartu IZIN TOOL
   * (mutating tunggal, bisa membawa checkbox "selalu izinkan" — allowlist
   * sesi di core).
   */
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
        try {
          return ap.args == null ? "" : JSON.stringify(ap.args, null, 2);
        } catch {
          return String(ap.args);
        }
      })();
      // Mutasi file → pratinjau diff (terbuka) agar keputusan Allow/Deny
      // berbasis isi, bukan JSON mentah.
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

  /**
   * Decision bar: kartu approval pinned (sumber kebenaran = pendingApprovals
   * dari /status) + header "menunggu keputusan". Kosong → tersembunyi total.
   */
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

  /** Kartu ringkasan giliran: "N file berubah +a −r" + baris per file. */
  function buildChanges(b: Extract<Block, { kind: "changes" }>): HTMLElement {
    const w = el("div", "as-blk as-chg");
    const hd = el("div", "as-chg-hd");
    hd.appendChild(el("span", "as-chg-ttl", t("as.chg.files", { n: b.files.length })));
    const stat = el("span", "as-diff-stat");
    stat.appendChild(el("span", "add", "+" + b.added));
    stat.appendChild(el("span", "del", "−" + b.removed));
    hd.appendChild(stat);
    w.appendChild(hd);
    for (const f of b.files) {
      const rowWrap = el("div", "as-chg-item");
      const row = el("button", "as-chg-row") as HTMLButtonElement;
      row.type = "button";
      row.appendChild(el("span", "as-chg-kind", f.kind));
      row.appendChild(el("span", "as-chg-path", f.path));
      const st = el("span", "as-diff-stat");
      st.appendChild(el("span", "add", "+" + f.added));
      st.appendChild(el("span", "del", "−" + f.removed));
      row.appendChild(st);
      const key = b.id + ":" + f.path;
      const body = buildDiff(f, key);
      row.addEventListener("click", () => {
        body.classList.toggle("open");
        if (body.classList.contains("open")) openDiffs.add(key);
        else openDiffs.delete(key);
      });
      rowWrap.appendChild(row);
      rowWrap.appendChild(body);
      w.appendChild(rowWrap);
    }
    return w;
  }

  function nearBottom(elm: HTMLElement): boolean {
    return elm.scrollHeight - elm.scrollTop - elm.clientHeight < 60;
  }
  function stickTo(elm: HTMLElement): void {
    elm.scrollTop = elm.scrollHeight;
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
      case "tool": {
        const w = el("div", "as-blk as-tool");
        w.dataset.status = b.status;
        const hd = el("button", "as-tool-hd") as HTMLButtonElement;
        hd.type = "button";
        hd.appendChild(el("span", "as-dot"));
        hd.appendChild(el("span", "as-tool-name", b.name));
        const lvBadge = levelBadge(t, deps.toolLevel, b.name);
        if (lvBadge) hd.appendChild(lvBadge);
        if (b.summary) hd.appendChild(el("span", "as-tool-sum", b.summary));
        // Durasi eksekusi (mono, di tepi kanan sebelum chevron) — dari client
        // clock; kartu hasil hydrate history tidak memilikinya.
        if (typeof b.durMs === "number" && b.status !== "running") {
          hd.appendChild(el("span", "as-tool-dur", formatDuration(b.durMs)));
        }
        hd.appendChild(el("span", "as-chev", "▾"));
        const bd = el("div", "as-tool-bd");
        if (b.change) {
          // Mutasi file: diff lebih bermakna daripada JSON argumen mentah.
          bd.appendChild(buildDiff(b.change, String(b.id) + ":" + b.change.path));
        } else if (b.argsText != null) {
          bd.appendChild(el("div", "as-lbl", t("as.tool.args")));
          bd.appendChild(el("pre", "as-tool-args", b.argsText));
        }
        if (b.result != null) {
          bd.appendChild(el("div", "as-lbl", t("as.tool.result")));
          const pre = el("pre", "as-tool-res", b.result);
          if (b.status === "done") {
            pre.appendChild(el("span", "as-clipped", t("as.tool.clipped")));
          }
          bd.appendChild(pre);
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
      case "approval": {
        // Kartu approval TIDAK dirender di aliran — semua kartu tampil di
        // decision bar (renderControls), pinned di atas composer.
        return buildApprovalCard({ apId: b.apId, tool: b.tool, args: b.args, plan: b.plan });
      }
      case "subagent": {
        const w = el("div", "as-blk as-sub");
        w.dataset.state = b.state;
        w.appendChild(el("span", "as-sub-name", b.name));
        w.appendChild(el("span", "as-sub-text", b.text));
        return w;
      }
      case "changes": {
        return buildChanges(b);
      }
    }
  }

  /** Baris narasi kerja (agent bicara DI TENGAH eksekusi) — kutipan redup,
   *  bukan bubble chat. */
  function buildWorkNote(b: Extract<Block, { kind: "agent" }>): HTMLElement {
    const w = el("div", "as-note");
    const txt = el("span", "as-note-txt", b.text);
    w.appendChild(txt);
    if (b.streaming) w.classList.add("streaming");
    return w;
  }

  /** Render satu blok ke wilayah tertentu (keyed by id+rev). */
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

  // ── Worklog eksekusi (segmen giliran) ────────────────────────────
  // Satu segmen = satu giliran kerja. Segmen AKTIF tampil penuh (header
  // "kerja aktif" + baris-baris kegiatan); segmen selesai menyusut jadi satu
  // baris ringkas (progressive disclosure). Pilihan lipat user menang.
  const wsegs = new Map<string, {
    wrap: HTMLElement;
    body: HTMLElement;
    sig: string;
    userToggled: boolean | null;
  }>();

  function renderWorkSegment(seg: WorkSegment, seen: Set<number>, order: number): void {
    const state = seg.open ? "open" : seg.interrupted ? "interrupted" : "completed";
    const workSig = seg.work.map((b) => b.id + ":" + (b.kind === "tool" ? b.status : b.kind) + ":" + b.rev).join(",");
    const sig = state + "|" + workSig;
    let g = wsegs.get(seg.key);
    if (!g) {
      const wrap = el("div", "as-wseg");
      const hd = el("button", "as-wseg-hd") as HTMLButtonElement;
      hd.type = "button";
      hd.appendChild(el("span", "as-wseg-state"));
      hd.appendChild(el("span", "as-wseg-task"));
      hd.appendChild(el("span", "as-wseg-cnt"));
      hd.appendChild(el("span", "as-wseg-dur"));
      hd.appendChild(el("span", "as-chev", "▾"));
      const body = el("div", "as-wseg-work");
      hd.addEventListener("click", () => {
        const isOpen = wrap.classList.contains("open");
        wrap.classList.toggle("open", !isOpen);
        wrap.classList.toggle("closed", isOpen);
        if (g) g.userToggled = !isOpen;
      });
      wrap.append(hd, body);
      g = { wrap, body, sig: "", userToggled: null };
      wsegs.set(seg.key, g);
      work.appendChild(wrap);
    }
    // Jaga urutan segmen = urutan blok (appendChild hanya saat perlu agar
    // fokus/scroll tidak terganggu tiap render).
    if (work.children[order] !== g.wrap) work.insertBefore(g.wrap, work.children[order] ?? null);
    if (g.sig !== sig) {
      const st = g.wrap.querySelector(".as-wseg-state") as HTMLElement;
      st.textContent = seg.open ? t("as.work.current") : seg.interrupted ? t("as.seg.interrupted") : t("as.seg.completed");
      g.wrap.dataset.state = seg.open ? "open" : seg.interrupted ? "interrupted" : "completed";
      // Snippet tugas: konteks segmen selesai (task text di conv tidak
      // bersebelahan lagi — ringkasan harus bisa berdiri sendiri).
      const snippet = (seg.trigger?.text ?? "").trim().slice(0, 64);
      (g.wrap.querySelector(".as-wseg-task") as HTMLElement).textContent = snippet;
      const toolCount = seg.toolsOk + seg.toolsFail;
      (g.wrap.querySelector(".as-wseg-cnt") as HTMLElement).textContent = toolCount === 0 ? "" :
        seg.toolsFail > 0
          ? t("as.seg.countFail", { ok: seg.toolsOk, fail: seg.toolsFail })
          : t("as.seg.count", { n: toolCount });
      (g.wrap.querySelector(".as-wseg-dur") as HTMLElement).textContent = seg.open
        ? (seg.startedAt ? formatDuration(Date.now() - seg.startedAt) : "")
        : (seg.startedAt && seg.endedAt ? formatDuration(seg.endedAt - seg.startedAt) : "");
      const openNow = g.userToggled != null ? g.userToggled : seg.open;
      g.wrap.classList.toggle("open", openNow);
      g.wrap.classList.toggle("closed", !openNow);
      g.sig = sig;
    }
    for (const b of seg.work) renderInto(g.body, b, seen);
  }

  function render(blocks: Block[]): void {
    const stickWork = nearBottom(work);
    const stickConv = nearBottom(conv);
    const segs = computeSegments(blocks);
    const seen = new Set<number>();
    let order = 0;
    for (const seg of segs) {
      if (!seg.trigger) {
        // Blok leading (sebelum user pertama): status/awal sesi → work;
        // narasi/final → conv.
        for (const b of seg.work) {
          seen.add(b.id);
          if (b.kind === "final" || b.kind === "speak") renderInto(conv, b, seen);
          else renderInto(work, b, seen);
        }
        if (seg.final) renderInto(conv, seg.final, seen);
        continue;
      }
      seen.add(seg.trigger.id);
      renderInto(conv, seg.trigger, seen);
      if (seg.work.length) {
        renderWorkSegment(seg, seen, order);
        order++;
      }
      if (seg.final) {
        seen.add(seg.final.id);
        renderInto(conv, seg.final, seen);
      }
    }
    // Buang blok yang sudah tidak ada (approval reconcile, dsb.).
    for (const [id, cur] of [...rendered]) {
      if (!seen.has(id)) {
        cur.el.remove();
        rendered.delete(id);
        openTools.delete(id);
        const pref = id + ":";
        for (const k of [...openDiffs]) if (k.startsWith(pref)) openDiffs.delete(k);
      }
    }
    // Buang segmen yang hilang + padatkan urutan.
    let expected = 0;
    for (const seg of segs) {
      if (!seg.work.length) continue;
      const g = wsegs.get(seg.key);
      if (g && work.children[expected] !== g.wrap) work.insertBefore(g.wrap, work.children[expected] ?? null);
      expected++;
    }
    for (const [key, g] of [...wsegs]) {
      if (!segs.some((s) => s.key === key)) {
        g.wrap.remove();
        wsegs.delete(key);
      }
    }
    // Empty state work region: jujur tapi tenang — bukan kartu kosong.
    workEmpty.remove();
    if (!work.children.length) work.appendChild(workEmpty);
    if (stickWork) stickTo(work);
    if (stickConv) stickTo(conv);
    // Kunci scroll: konten menyusut (blok dibuang) tidak boleh meninggalkan
    // scrollTop nyangkut di ruang kosong.
    for (const elm of [work, conv]) {
      const max = Math.max(0, elm.scrollHeight - elm.clientHeight);
      if (elm.scrollTop > max) elm.scrollTop = max;
    }
  }

  // ── Halaman Review (daftar perubahan file sesi) ─────────────────
  function renderReview(
    entries: Array<{ path: string; kind: string; added: number; removed: number; measured: boolean }>,
    opts: { canRevert: boolean; onRevert: (path: string) => void; onRefresh: () => void },
  ): void {
    reviewPage.textContent = "";
    const bar = el("div", "as-page-bar");
    // Judul jumlah file hanya saat ada isinya — "0 file tersentuh" berdampingan
    // dengan pesan kosong itu dua kali mengatakan hal yang sama.
    if (entries.length) {
      const ttl = el("span", "as-page-ttl", t("as.review.title", { n: entries.length }));
      bar.appendChild(ttl);
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
      // Stat +a −r hanya untuk entri TERUKUR (dari kartu changes). Entri
      // "tersentuh" dari server tidak punya angka — menampilkan +0 −0 itu
      // bohong bagi user.
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

  // ── Kartu TASK (objek kerja utama) ───────────────────────────────
  /**
   * Header kerja: teks tugas besar + status live (state, objek, elapsed) +
   * checklist plan dengan langkah aktif. Tanpa task & plan → tersembunyi;
   * orientasi kosong ditangani empty-state work region.
   */
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
    const head = el("div", "as-task-head");
    head.appendChild(el("span", "as-task-label", t("as.task")));
    if (hasPlan) {
      const done = plan.filter((p) => p.status === "done").length;
      head.appendChild(el("span", "as-task-prog", t("as.plan.progress", { done, total: plan.length })));
    }
    taskBox.appendChild(head);
    if (tsk) {
      taskBox.appendChild(el("div", "as-task-text", tsk));
    }
    // Status live menempel di task — jawaban instan "sekarang di mana?"
    // tanpa membaca percakapan.
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
      // Langkah aktif disorot di atas checklist — jawaban langsung atas
      // "sekarang sedang di langkah mana" tanpa memindai daftar.
      const active = plan.find((p) => p.status === "in_progress");
      if (active) {
        taskBox.appendChild(el("div", "as-task-step", "▸ " + String(active.task ?? "")));
      }
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
  /**
   * Daftar task yang menunggu slot (parked, drain FIFO). Tiap baris punya
   * tombol batal per-task (§11) → deps.onCancelTask(taskId). Kotak hilang
   * bila antrean kosong — hanya muncul saat benar-benar ada yang mengantre.
   */
  function renderQueue(parked: Array<{ taskId: string; prompt: string }>): void {
    queueBox.textContent = "";
    if (!parked || !parked.length) {
      queueBox.classList.add("hidden");
      return;
    }
    queueBox.classList.remove("hidden");
    const head = el("div", "as-task-head");
    head.appendChild(el("span", "as-task-label", t("as.queue")));
    head.appendChild(el("span", "as-task-prog", t("as.queue.count", { n: parked.length })));
    queueBox.appendChild(head);
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
    openDiffs.clear();
    wsegs.clear();
    work.textContent = "";
    conv.textContent = "";
  }

  function destroy(): void {
    lifecycle.destroy();
  }

  return { render, renderTask, renderQueue, renderMemory, hideMemory, renderStateLine, renderControls, clearTranscript, setTab, activeTab, renderReview, renderTerm, destroy };
}

export type PanelView = ReturnType<typeof createPanelView>;
