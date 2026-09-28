/**
 * client/agent/panel/view.ts — Renderer DOM transcript agent.
 * Rekonsiliasi keyed: setiap blok punya id+rev; elemen dibangun ulang hanya
 * bila rev berubah — teks yang sedang streaming tidak memicu rebuild panel.
 * Anggaran render dijaga: warna solid + hairline, tanpa blur/gradient.
 */

import { createLifecycle } from "../../lifecycle";
import type { Block } from "./transcript";
import { changeFromTool, MAX_RENDER_ROWS } from "./diff";
import type { FileChange } from "./diff";
import { parseMarkdown } from "./md";
import type { MdInline, MdToken } from "./md";

export type PlanItem = { id?: string; task: string; status: string; note?: string };
export type TechnicalTab = "review" | "term" | "browser";

/** Grup aktivitas hanya perlu terbuka selama minimal satu tool masih berjalan. */
export function toolRunIsTerminal(run: Array<{ status: string }>): boolean {
  return run.length > 0 && run.every((tool) => tool.status !== "running");
}

export type PanelViewDeps = {
  t: (key: string, vars?: Record<string, string | number>) => string;
  onApprove: (apId: string, approve: boolean) => void;
  /** Dipanggil saat user pindah tab teknis; transcript selalu tetap terlihat. */
  onTabChange?: (tab: TechnicalTab) => void;
  /** Level tool ("safe"|"mutating") untuk badge; null = tak diketahui. */
  toolLevel?: (name: string) => "safe" | "mutating" | null;
  /** Batalkan task tertentu dari antrean (§11 cancel per-task). */
  onCancelTask?: (taskId: string) => void;
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
        break;
      }
    }
  }
  return root;
}

export function createPanelView(root: HTMLElement, techRoot: HTMLElement | null, deps: PanelViewDeps) {
  const lifecycle = createLifecycle();
  const t = deps.t;
  // ── Skeleton panel ──────────────────────────────────────────────
  const statusbar = el("div", "as-statusbar");
  const pill = el("span", "as-pill");
  const pillDot = el("span", "as-pill-dot");
  const pillLabel = el("span", "as-pill-label");
  let pillTimer: ReturnType<typeof setInterval> | null = null;
  let pillBusySince = 0;
  let pillPrevState: PillState | null = null;
  pill.appendChild(pillDot);
  pill.appendChild(pillLabel);
  statusbar.appendChild(pill);

  const tl = el("div", "as-tl");
  tl.setAttribute("aria-live", "polite");

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
  root.appendChild(tl);
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

  function nearBottom(): boolean {
    return tl.scrollHeight - tl.scrollTop - tl.clientHeight < 60;
  }
  function scrollToBottom(): void {
    tl.scrollTop = tl.scrollHeight;
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
        const w = el("div", "as-blk as-appr");
        const hd = el("div", "as-appr-hd");
        hd.appendChild(el("span", "as-appr-ttl", t("as.approve.title")));
        hd.appendChild(el("span", "as-tool-name", b.tool));
        const apBadge = levelBadge(t, deps.toolLevel, b.tool);
        if (apBadge) hd.appendChild(apBadge);
        w.appendChild(hd);
        const argsText = (() => {
          try {
            return b.args == null ? "" : JSON.stringify(b.args, null, 2);
          } catch {
            return String(b.args);
          }
        })();
        // Mutasi file → pratinjau diff (terbuka) agar keputusan Allow/Deny
        // berbasis isi, bukan JSON mentah.
        const preview = changeFromTool(b.tool, b.args);
        if (preview && preview.hunks.length) {
          w.appendChild(buildDiff(preview, "appr:" + b.apId, true));
        } else if (argsText) {
          w.appendChild(el("pre", "as-tool-args", argsText));
        }
        const row = el("div", "as-appr-row");
        const ok = el("button", "mini-btn as-appr-ok", t("as.allow")) as HTMLButtonElement;
        ok.type = "button";
        const no = el("button", "mini-btn as-appr-no", t("as.deny")) as HTMLButtonElement;
        no.type = "button";
        ok.addEventListener("click", () => {
          ok.disabled = true;
          no.disabled = true;
          deps.onApprove(b.apId, true);
        });
        no.addEventListener("click", () => {
          ok.disabled = true;
          no.disabled = true;
          deps.onApprove(b.apId, false);
        });
        row.appendChild(ok);
        row.appendChild(no);
        w.appendChild(row);
        return w;
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

  function render(blocks: Block[]): void {
    const stick = nearBottom();
    const seen = new Set<number>();
    let prev: HTMLElement | null = null;
    let i = 0;
    while (i < blocks.length) {
      const b = blocks[i];
      if (b.kind !== "tool") {
        seen.add(b.id);
        prev = renderOne(b, prev);
        i++;
        continue;
      }
      // Kumpulkan run tool berurutan; grup bila ≥2 (timeline ala coding-agent).
      let j = i;
      const run: Extract<Block, { kind: "tool" }>[] = [];
      while (j < blocks.length && blocks[j].kind === "tool") {
        run.push(blocks[j] as Extract<Block, { kind: "tool" }>);
        j++;
      }
      if (run.length >= 2) {
        for (const tb of run) seen.add(tb.id);
        prev = renderStepGroup(run, prev, seen);
      } else {
        seen.add(b.id);
        prev = renderOne(b, prev);
      }
      i = j;
    }
    for (const [id, cur] of rendered) {
      if (!seen.has(id)) {
        cur.el.remove();
        rendered.delete(id);
        openTools.delete(id);
        const pref = id + ":";
        for (const k of [...openDiffs]) if (k.startsWith(pref)) openDiffs.delete(k);
      }
    }
    pruneStepGroups(seen);
    if (stick) scrollToBottom();
  }

  /** Render satu blok ke posisi prev; kembalikan elemen terakhir. */
  function renderOne(b: Block, prev: HTMLElement | null): HTMLElement {
    const cur = rendered.get(b.id);
    if (cur && cur.rev === b.rev) return cur.el;
    const node = buildBlock(b);
    if (cur) {
      cur.el.replaceWith(node);
      cur.el = node;
      cur.rev = b.rev;
    } else {
      if (prev) prev.after(node);
      else tl.insertBefore(node, tl.firstChild);
      rendered.set(b.id, { el: node, rev: b.rev });
    }
    return node;
  }

  // State grup step. Grup yang masih bekerja terbuka; begitu semua tool
  // terminal (done/error) ia auto-collapse agar log tak menggeser TASK/chat.
  // Setelah user men-toggle manual, pilihan user menang atas auto-collapse.
  const stepGroups = new Map<string, {
    wrap: HTMLElement;
    body: HTMLElement;
    sig: string;
    userToggled: boolean;
  }>();

  /**
   * Bungkus run tool jadi grup collapsible. Kartu tool dirender normal di
   * dalam body — recon keyed tetap jalan; grup di-rebuild hanya bila
   * signature (urutan id + status + rev) berubah.
   */
  function renderStepGroup(
    run: Extract<Block, { kind: "tool" }>[],
    prev: HTMLElement | null,
    seen: Set<number>,
  ): HTMLElement {
    // Key stabil = id tool pertama. Jumlah child boleh bertambah selama live
    // tanpa membuat wrapper duplikat; signature tetap memuat seluruh child.
    const groupKey = String(run[0].id);
    const sig = run.map((b) => b.id + ":" + b.status + ":" + b.rev).join(",");
    let g = stepGroups.get(groupKey);
    const terminal = toolRunIsTerminal(run);
    if (g && g.sig !== sig) {
      // Rebuild dalam: body dikosongkan, kartu child dirender ulang.
      g.body.textContent = "";
      for (const tb of run) renderInto(g.body, tb, seen);
      g.sig = sig;
      updateStepHeader(g.wrap, run);
      // Grup yang selesai menutup otomatis, kecuali user sudah memilih state.
      if (!g.userToggled) g.wrap.classList.toggle("closed", terminal);
      return g.wrap;
    }
    if (!g) {
      const wrap = el("div", "as-step");
      const hd = el("button", "as-step-hd") as HTMLButtonElement;
      hd.type = "button";
      hd.appendChild(el("span", "as-step-icon", "⚡"));
      hd.appendChild(el("span", "as-step-ttl"));
      hd.appendChild(el("span", "as-step-cnt"));
      hd.appendChild(el("span", "as-chev", "▾"));
      const body = el("div", "as-step-bd");
      g = { wrap, body, sig: "", userToggled: false };
      hd.addEventListener("click", () => {
        wrap.classList.toggle("closed");
        if (g) g.userToggled = true;
      });
      wrap.appendChild(hd);
      wrap.appendChild(body);
      stepGroups.set(groupKey, g);
      if (prev) prev.after(wrap);
      else tl.insertBefore(wrap, tl.firstChild);
      for (const tb of run) renderInto(body, tb, seen);
      g.sig = sig;
      updateStepHeader(wrap, run);
      wrap.classList.toggle("closed", terminal);
    }
    return g.wrap;
  }

  /** renderOne yang menautkan ke parent tertentu (dipakai grup step). */
  function renderInto(parent: HTMLElement, b: Block, seen: Set<number>): void {
    seen.add(b.id);
    const cur = rendered.get(b.id);
    if (cur && cur.rev === b.rev) {
      if (cur.el.parentElement !== parent) parent.appendChild(cur.el);
      return;
    }
    const node = buildBlock(b);
    if (cur) {
      cur.el.replaceWith(node);
      cur.el = node;
      cur.rev = b.rev;
    } else {
      rendered.set(b.id, { el: node, rev: b.rev });
    }
    parent.appendChild(node);
  }

  /** Header grup: status gabungan + jumlah langkah nyata. */
  function updateStepHeader(wrap: HTMLElement, run: Extract<Block, { kind: "tool" }>[]): void {
    const last = run[run.length - 1];
    const terminal = toolRunIsTerminal(run);
    const hasError = run.some((tool) => tool.status === "error");
    wrap.dataset.status = hasError ? "error" : last.status;
    (wrap.querySelector(".as-step-ttl") as HTMLElement).textContent =
      t(terminal ? (hasError ? "as.step.failed" : "as.step.completed") : "as.step.title");
    (wrap.querySelector(".as-step-cnt") as HTMLElement).textContent =
      t("as.step.count", { n: run.length });
  }

  function pruneStepGroups(seenIds: Set<number>): void {
    for (const [ids, g] of stepGroups) {
      const first = Number(ids.split(",")[0]);
      if (!seenIds.has(first)) {
        g.wrap.remove();
        stepGroups.delete(ids);
      }
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
      const st = el("span", "as-diff-stat");
      st.appendChild(el("span", "add", "+" + e.added));
      st.appendChild(el("span", "del", "−" + e.removed));
      row.appendChild(st);
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

  // ── Kartu TASK (pusat perhatian) ────────────────────────────────
  /**
   * Hero card: apa yang agent kerjakan + checklist plan live. Hilang bila
   * tak ada task & tak ada plan (mode ngobrol biasa) — panel kembali polos.
   */
  function renderTask(task: string, plan: PlanItem[]): void {
    taskBox.textContent = "";
    const tsk = String(task || "").trim();
    const hasPlan = !!(plan && plan.length);
    if (!tsk && !hasPlan) {
      // TASK tetap hadir sebagai orientasi utama, tetapi empty state harus
      // jujur dan memberi tindakan berikutnya — bukan kartu kosong/fake task.
      taskBox.classList.remove("hidden");
      const head = el("div", "as-task-head");
      head.appendChild(el("span", "as-task-label", t("as.task")));
      taskBox.appendChild(head);
      taskBox.appendChild(el("div", "as-task-empty", t("as.task.empty")));
      return;
    }
    taskBox.classList.remove("hidden");
    if (tsk) {
      const head = el("div", "as-task-head");
      head.appendChild(el("span", "as-task-label", t("as.task")));
      if (hasPlan) {
        const done = plan.filter((p) => p.status === "done").length;
        head.appendChild(el("span", "as-task-prog", t("as.plan.progress", { done, total: plan.length })));
      }
      taskBox.appendChild(head);
      taskBox.appendChild(el("div", "as-task-text", tsk));
    } else if (hasPlan) {
      // tanpa task (mis. hydrate lama) — label plan saja
      const head = el("div", "as-task-head");
      head.appendChild(el("span", "as-task-label", t("as.planTitle")));
      const done = plan.filter((p) => p.status === "done").length;
      head.appendChild(el("span", "as-task-prog", t("as.plan.progress", { done, total: plan.length })));
      taskBox.appendChild(head);
    }
    if (hasPlan) {
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

  // ── Status pill ─────────────────────────────────────────────────
  type PillState = "off" | "idle" | "busy" | "busyOther" | "thinking" | "approval";
  function setPill(state: PillState): void {
    pill.dataset.state = state;
    const wasBusy = pillPrevState === "busy";
    pillPrevState = state;
    if (pillTimer) {
      clearInterval(pillTimer);
      pillTimer = null;
    }
    if (state !== "busy") {
      pillLabel.textContent = t(
        state === "off" ? "as.status.off"
          : state === "busyOther" ? "as.status.busyOther"
          : state === "thinking" ? "as.status.thinking"
          : state === "approval" ? "as.status.approval"
          : "as.status.idle",
      );
      return;
    }
    // Bekerja + hitungan waktu — bedakan "hidup dan maju" dari "macet
    // diam": <3 dtk cukup "bekerja…", setelah itu detik tampil. Acuan
    // waktu HANYA di-reset saat transisi masuk busy — refreshStatus
    // memanggil setPill("busy") tiap poll, jangan nol-kan ulang.
    if (!wasBusy) pillBusySince = Date.now();
    const paint = () => {
      const s = Math.floor((Date.now() - pillBusySince) / 1000);
      pillLabel.textContent =
        s < 3 ? t("as.status.busy") : t("as.status.busyTimer", { s });
    };
    paint();
    pillTimer = lifecycle.interval(paint, 1000);
  }

  function clearTranscript(): void {
    rendered.clear();
    openTools.clear();
    openDiffs.clear();
    stepGroups.clear();
    tl.textContent = "";
  }

  function destroy(): void {
    lifecycle.destroy();
    if (pillTimer) clearInterval(pillTimer);
    pillTimer = null;
  }

  return { render, renderTask, renderQueue, renderMemory, hideMemory, setPill, clearTranscript, setTab, activeTab, renderReview, renderTerm, destroy };
}

export type PanelView = ReturnType<typeof createPanelView>;
