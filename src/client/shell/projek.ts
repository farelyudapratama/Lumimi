/**
 * client/shell/projek.ts — Rail projek shell (activity bar → rail kiri).
 * Isi #projek-rail dibangun di sini (TS, di-bundle sebagai
 * window.__shellProjek) — BUKAN legacy JS (aturan AGENTS.md).
 *
 * Isi: indikator project (nama = basename workdir, klik = salin path) +
 * riwayat sesi assistant (list/new/switch/delete via /api/assistant/
 * sessions*). Setelah switch sukses, dispatch event DOM
 * `agent:session-changed` — panel agent yang menangkap (hydrate transcript).
 */

import { createLifecycle } from "../lifecycle";
import { httpBase } from "../transport";
import {
  WORKSPACE_CEIL,
  WORKSPACE_FLOOR,
  clampWorkspaceBasis,
  tameStoredWorkspaceBasis,
  workspaceFloor,
} from "./workspace";

// Basis API: httpBase() DINAMIS (embedded/exe → loopback via IPC server_port;
// dev → location.origin). Dulu `location.origin` mentah — di exe origin
// halaman = aset ter-embed (tauri://localhost) sehingga rail sesi gagal
// diam-diam. Diperbarui saat start + tiap siklus poll (initLoopback bisa
// selesai setelah module load).
let API = httpBase();
const LS_KEY = "live2d.projekRail.open";
let activeDestroy: (() => void) | null = null;

type SessionItem = { id: string; name: string; workDir: string; ts: number; count: number };
type SessionsResp = { active: string; sessions: SessionItem[] };

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function getT() {
  const i = window.__i18n;
  return (k: string, v?: Record<string, string | number>) => (i ? i.t(k, v) : k);
}

async function fetchJSON(url: string, init?: RequestInit): Promise<any> {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || "HTTP " + r.status);
  return d;
}

export function startProjekRail(): () => void {
  activeDestroy?.();
  // Segarkan basis API (initLoopback async bisa selesai setelah module load).
  API = httpBase();
  const lifecycle = createLifecycle();
  const requestSignal = lifecycle.controller().signal;
  const requestJSON = (url: string, init?: RequestInit) =>
    fetchJSON(url, { ...init, signal: requestSignal });
  const t = getT();
  const railEl = document.getElementById("projek-rail");
  const btnEl = document.getElementById("btn-projek-rail");
  if (!railEl || !btnEl) {
    lifecycle.destroy();
    return () => {};
  }
  const rail: HTMLElement = railEl;
  const btn = btnEl as HTMLButtonElement;

  let destroyed = false;
  let drawGeneration = 0;
  let open = false;
  try {
    const saved = localStorage.getItem(LS_KEY);
    // Rail kini POPUP melayang (menutupi stage) — tidak membuka sendiri
    // bila user belum pernah memilih; pilihan tersimpan tetap dihormati.
    open = saved === "1";
  } catch {
    open = false;
  }

  function setOpen(v: boolean): void {
    open = v;
    if (!open) drawGeneration++;
    rail.classList.toggle("hidden", !open);
    btn.classList.toggle("active", open);
    btn.setAttribute("aria-pressed", open ? "true" : "false");
    try { localStorage.setItem(LS_KEY, open ? "1" : "0"); } catch {}
    if (open) void draw();
    // Rail masuk/keluar mengubah ruang kolom lain — clamp workspace ulang
    // (initWorkspaceW = deklarasi fungsi, hoisted dari blok gutter bawah).
    initWorkspaceW();
  }

  /** Gambar seluruh isi rail: kartu project + daftar sesi. */
  async function draw(): Promise<void> {
    if (destroyed || !open) return;
    const generation = ++drawGeneration;
    const stale = () => destroyed || !open || generation !== drawGeneration;
    rail.textContent = "";
    rail.appendChild(el("div", "prj-title", t("shell.projek.title")));

    // ── Kartu project (workdir aktif dari /status) ──
    let workDir = "";
    try {
      const st = await requestJSON(API + "/api/assistant/status");
      workDir = String(st.workDir || "");
    } catch {}
    if (stale()) return;
    const card = el("button", "prj-card") as HTMLButtonElement;
    card.type = "button";
    if (workDir) {
      const nm = workDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || workDir;
      card.appendChild(el("span", "name", nm));
      card.appendChild(el("span", "path", workDir));
      card.setAttribute("title", t("shell.projek.copyTip"));
      card.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(workDir);
          const old = card.querySelector(".path")?.textContent;
          const p = card.querySelector(".path");
          if (p) p.textContent = t("shell.projek.copied");
          setTimeout(() => { if (p) p.textContent = old || workDir; }, 1200);
        } catch {}
      });
    } else {
      card.appendChild(el("span", "name", t("shell.projek.noProject")));
    }
    rail.appendChild(card);

    // ── Daftar sesi assistant ──
    rail.appendChild(el("div", "prj-title", t("as.sess.title")));
    const head = el("div", "note-row");
    const newBtn = el("button", "mini-btn", t("as.sess.new")) as HTMLButtonElement;
    newBtn.type = "button";
    newBtn.addEventListener("click", () => { void newSession(); });
    head.appendChild(newBtn);
    rail.appendChild(head);

    const listBox = el("div", "prj-sess");
    rail.appendChild(listBox);
    let data: SessionsResp;
    try {
      data = await requestJSON(API + "/api/assistant/sessions");
    } catch (e: any) {
      if (stale()) return;
      listBox.appendChild(el("div", "prj-empty", "✗ " + (e?.message || e)));
      return;
    }
    if (stale()) return;
    if (!data.sessions?.length) {
      listBox.appendChild(el("div", "prj-empty", t("as.sess.empty")));
      return;
    }
    for (const s of data.sessions) {
      listBox.appendChild(sessionRow(s, data.active === s.id));
    }
  }

  function sessionRow(s: SessionItem, active: boolean): HTMLElement {
    const t2 = getT();
    const row = el("button", "prj-sess-item" + (active ? " active" : "")) as HTMLButtonElement;
    row.type = "button";
    row.appendChild(el("span", "nm", s.name));
    row.appendChild(el("span", "meta", t2("as.sess.count", { n: s.count })));
    const del = el("span", "del", "✕");
    del.setAttribute("title", t2("as.sess.delete"));
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(t2("as.sess.deleteTip", { name: s.name }))) void removeSession(s.id);
    });
    row.appendChild(del);
    row.addEventListener("click", () => { void switchSession(s.id); });
    return row;
  }

  function notifySessionChanged(): void {
    window.dispatchEvent(new CustomEvent("agent:session-changed"));
  }

  async function newSession(): Promise<void> {
    try {
      await requestJSON(API + "/api/assistant/sessions/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      notifySessionChanged();
      await draw();
    } catch (e: any) {
      alert(e?.message || String(e));
    }
  }

  async function switchSession(id: string): Promise<void> {
    try {
      await requestJSON(API + "/api/assistant/sessions/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      notifySessionChanged();
      await draw();
    } catch (e: any) {
      alert(e?.message || String(e));
    }
  }

  async function removeSession(id: string): Promise<void> {
    try {
      await requestJSON(API + "/api/assistant/sessions/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      notifySessionChanged();
      await draw();
    } catch (e: any) {
      alert(e?.message || String(e));
    }
  }

  const onBtn = () => setOpen(!open);
  lifecycle.listen(btn, "click", onBtn);

  // Sesi bisa berubah dari luar (CLI menulis store) → segarkan saat rail
  // terbuka tiap 8 dtk (murah: satu GET ringan).
  lifecycle.interval(() => { API = httpBase(); if (open) void draw(); }, 8000);

  // ── Indikator status agent GLOBAL (di activity bar) ─────────────
  // Dot kecil pada tombol Assistant: user melihat agent hidup/nunggu izin
  // tanpa membuka panel mana pun. Poll ringan 4 dtk, selalu jalan.
  const asBtn = document.querySelector('#mode-switch button[data-mode="assistant"]') as HTMLElement | null;
  async function refreshAgentBadge(): Promise<void> {
    if (!asBtn) return;
    let st: {
      running?: boolean;
      busy?: boolean;
      pendingApprovals?: unknown[];
      lastEvent?: { type?: string; label?: string } | null;
    };
    try {
      st = await requestJSON(API + "/api/assistant/status");
    } catch { return; } // server lewat — biarkan badge terakhir
    const pending = Array.isArray(st.pendingApprovals) ? st.pendingApprovals.length : 0;
    const state = !st.running ? "off" : pending > 0 ? "approval" : st.busy ? "busy" : "idle";
    asBtn.dataset.agent = state;
    const stateLabel = state === "approval" ? t("as.status.approval")
      : state === "busy" ? t("as.status.busy")
      : state === "idle" ? t("as.status.idle")
      : t("as.status.off");
    // Jangan timpa tooltip nama mode — gabungkan: nama tetap terbaca
    // (screen reader/rail tooltip) plus status agent sebagai informasi.
    asBtn.setAttribute("title", t("top.tabTip.assistant") + " · " + stateLabel);

    // Stage chip hanya saat ada kerja/izin — idle sengaja sunyi.
    const chip = document.getElementById("stage-agent-chip");
    const chipText = chip?.querySelector(".sac-text") as HTMLElement | null;
    if (chip && chipText) {
      const show = state === "busy" || state === "approval";
      chip.classList.toggle("hidden", !show);
      chip.dataset.state = state;
      if (show) {
        const raw = String(st.lastEvent?.label || "")
          .replace(/\{[\s\S]*$/, "")
          .replace(/\s+/g, " ")
          .trim();
        chipText.textContent = raw ? stateLabel + " — " + raw.slice(0, 48) : stateLabel;
      }
    }
  }
  if (asBtn) {
    void refreshAgentBadge();
    lifecycle.interval(() => { void refreshAgentBadge(); }, 4000);
  }

  // ── Resize workspace agent gabungan (drag gutter; dobel-klik = reset) ──
  const gutter = document.getElementById("sb-gutter");
  const workspace = document.getElementById("agent-workspace");
  const LS_W = "live2d.agentWorkspace.w";
  const LEGACY_LS_W = "live2d.sidebar.w";
  // .app tetap flex ROW dari 1025px ke atas (hanya ≤1024 yang jadi kolom
  // penuh — di sana splitter disembunyikan dan tak ada ukuran inline).
  // ≥1500px: 4 kolom sejajar; 1025–1499px: tech pane bertumpuk di bawah
  // percakapan (media query) — splitter tetap mengatur lebar workspace.
  const MIN_DESKTOP_W = 1025;
  const ROW_TECH_SIDE_W = 1500;
  function measureOccupied(): number {
    // Kolom kiri + gutter + padding .app (2×10) + gap 10 antar kolom yang
    // terlihat (gutter display:none ≤1499 → otomatis terhitung 0).
    let kids = 0;
    let gutterW = 0;
    const app = workspace?.parentElement;
    if (app) {
      for (const k of Array.from(app.children) as HTMLElement[]) {
        if (k === workspace) continue;
        if (k.offsetWidth > 0) kids++;
        if (k.id === "sb-gutter") gutterW = k.offsetWidth;
      }
    }
    const left = document.getElementById("left-workspace")?.offsetWidth ?? 300;
    return left + gutterW + 20 + kids * 10;
  }
  function wsFloor(): number {
    // Floor 722 (tech 340 + gap + percakapan min) hanya saat tech tampil DI
    // SAMPING percakapan (≥1500). Bertumpuk → percakapan saja → 372.
    const techSide =
      workspace!.classList.contains("agent-wide") &&
      window.innerWidth >= ROW_TECH_SIDE_W;
    return workspaceFloor(techSide);
  }
  function applyWorkspaceW(px: number | null): void {
    if (!workspace) return;
    if (px == null || window.innerWidth < MIN_DESKTOP_W) {
      workspace.style.flexBasis = "";
      return;
    }
    const clamped = clampWorkspaceBasis(px, window.innerWidth, measureOccupied(), wsFloor());
    workspace.style.flexBasis = clamped == null ? "" : clamped + "px";
  }
  function storedWorkspaceW(): number | null {
    if (!workspace) return null;
    try {
      let raw = localStorage.getItem(LS_W);
      if (raw == null) {
        const legacy = Number(localStorage.getItem(LEGACY_LS_W));
        if (legacy >= 320 && legacy <= 900) {
          raw = String(Math.max(WORKSPACE_FLOOR, Math.min(WORKSPACE_CEIL, legacy + 340)));
          localStorage.setItem(LS_W, raw);
          localStorage.removeItem(LEGACY_LS_W);
        }
      }
      const w = Number(raw);
      if (!(w >= WORKSPACE_FLOOR && w <= WORKSPACE_CEIL)) return null;
      if (window.innerWidth < MIN_DESKTOP_W) return w;
      // Nilai tersimpan di-tame saat dibaca: preferensi lama yang lebar
      // (warisan drag/migrasi di viewport lain) tidak boleh menjadikan
      // stage strip tiap maximize — stage dijaga ≥45% ruang panel.
      return tameStoredWorkspaceBasis(w, window.innerWidth, measureOccupied(), wsFloor());
    } catch {
      return null;
    }
  }
  function initWorkspaceW(): void {
    applyWorkspaceW(storedWorkspaceW());
  }
  if (gutter && workspace) {
    let dragging = false;
    const onResize = () => {
      if (window.innerWidth < MIN_DESKTOP_W) {
        dragging = false;
        document.body.classList.remove("sb-resizing");
      }
      initWorkspaceW();
    };
    const onMouseDown = (e: Event) => {
      const mouse = e as MouseEvent;
      if (window.innerWidth < MIN_DESKTOP_W) return;
      dragging = true;
      document.body.classList.add("sb-resizing");
      mouse.preventDefault();
    };
    const onMouseMove = (e: Event) => {
      const mouse = e as MouseEvent;
      if (!dragging) return;
      applyWorkspaceW(window.innerWidth - mouse.clientX - 10 /* padding .app */);
    };
    const onMouseUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("sb-resizing");
      const w = parseInt(workspace.style.flexBasis, 10);
      if (w >= WORKSPACE_FLOOR && w <= WORKSPACE_CEIL) {
        try { localStorage.setItem(LS_W, String(w)); } catch {}
      }
    };
    const onDoubleClick = () => {
      applyWorkspaceW(null);
      try { localStorage.removeItem(LS_W); } catch {}
    };
    lifecycle.listen(gutter, "mousedown", onMouseDown);
    lifecycle.listen(window, "mousemove", onMouseMove);
    lifecycle.listen(window, "mouseup", onMouseUp);
    lifecycle.listen(gutter, "dblclick", onDoubleClick);
    lifecycle.listen(window, "resize", onResize);
    initWorkspaceW();
  }

  setOpen(open);

  const destroyProjekRail = () => {
    if (destroyed) return;
    destroyed = true;
    drawGeneration++;
    lifecycle.destroy();
    document.body.classList.remove("sb-resizing");
    rail.textContent = "";
    if (activeDestroy === destroyProjekRail) activeDestroy = null;
  };
  activeDestroy = destroyProjekRail;
  return destroyProjekRail;
}
