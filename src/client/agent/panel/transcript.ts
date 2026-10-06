/**
 * client/agent/panel/transcript.ts — Model murni transcript agent (reducer).
 * TIDAK menyentuh DOM/jaringan — diuji langsung dengan bun test.
 *
 * Sumber kebenaran (revisi remake):
 *   - Kartu approval di-rekonsiliasi panel dari pendingApprovals (/status)
 *     keyed by apId; blok approval di sini hanya refleksi yang dibuang saat
 *     id-nya tidak lagi pending. Event SSE/bus izin tidak menambah duplikat.
 *   - Plan TIDAK jadi blok transcript — widget terpisah dari status.plan.
 *   - Mode "live" (SSE kita terbuka): bus thinking/tool_call/permission/
 *     final_answer/error DISUPRESI dari transcript (tetap ke actor) karena
 *     padanannya datang dari SSE. Bus verification_x/subagent_x tetap masuk
 *     (tidak ada di SSE → nol duplikasi). Mode "follow": bus dirender semua
 *     sebagai kartu ringkas (aktivitas CLI / lanjutan approval).
 *   - Hydration dari /history memakai key dedupe (role+awal konten) dan
 *     memfilter prompt internal lanjutan approval.
 */

import type { AsSseEvent } from "./stream";
import { changeFromTool } from "./diff";
import type { FileChange } from "./diff";
import { t } from "../../i18n/index";

export type ToolStatus = "running" | "done" | "error";

type BlockBase =
  | { kind: "user"; id: number; rev: number; text: string }
  | { kind: "agent"; id: number; rev: number; text: string; streaming: boolean }
  | { kind: "final"; id: number; rev: number; text: string }
  | {
      kind: "tool";
      id: number;
      rev: number;
      name: string;
      args: any;
      /** Ringkasan satu baris utk header (dari SSE penuh atau label bus). */
      summary: string;
      /** Argumen lengkap (pretty JSON) bila tersedia; null bila label bus. */
      argsText: string | null;
      result: string | null;
      status: ToolStatus;
      /** Perubahan file bila tool mutasi file (diff dihitung dari args). */
      change?: FileChange | null;
      /** Durasi eksekusi (client clock) bila kartu ini pernah running lalu
       *  selesai; undefined untuk kartu hasil hydrate history. */
      durMs?: number;
      /** Kartu lahir dari bus live (panel terbuka) — hydrate history boleh
       *  mengisinya tapi tidak boleh menumpuk kartu kembar. */
      live?: boolean;
    }
  | { kind: "status"; id: number; rev: number; text: string; variant?: "ok" | "err" | "warn" }
  | { kind: "speak"; id: number; rev: number; text: string }
  | { kind: "approval"; id: number; rev: number; apId: string; tool: string; args: any; /** Kartu rencana (Fase 2): args.todos dirender sebagai rencana kerja, bukan argumen tool. */ plan?: boolean }
  | { kind: "subagent"; id: number; rev: number; name: string; state: "spawned" | "done"; text: string }
  /** Ringkasan perubahan file per giliran (ala "N files changed +a −r"). */
  | { kind: "changes"; id: number; rev: number; files: FileChange[]; added: number; removed: number };

/** Semua blok membawa cap waktu client (Date.now saat push) — bahan durasi
 *  segmen/durasi tool; blok hasil hydrate history tidak memilikinya. */
export type Block = BlockBase & { at?: number };

/** Event bus agent (bentuk AgentEvent di server/agent/bus.ts). */
export type BusEvent = { seq: number; type: string; label: string; ts: number };

/** Prompt internal yang server kirim setelah approval — bukan ucapan user. */
export const CONTINUATION_PROMPT = "Lanjutkan tugas berdasarkan hasil tool di atas.";

/** Tipe bus yang disupresi dari transcript saat mode live.
 *  tool_call_start/end & permission_request TIDAK disupresi: SSE ask-stream
 *  hanya membawa delta/done — aktivitas tool live justru datang dari bus
 *  (label kaya "name {args}" / "name → hasil"). final_answer/error/thinking
 *  tetap disupresi karena padanannya datang via SSE done/error. */
const SUPPRESSED_IN_LIVE = new Set([
  "thinking_start",
  "final_answer",
  "error",
]);

let nextId = 1;

export class Transcript {
  blocks: Block[] = [];
  /** live = SSE panel terbuka; follow = pantau bus (CLI/lanjutan). */
  mode: "follow" | "live" = "follow";
  /** key pesan yang sudah dirender (hydrate & sync dedupe). */
  private msgKeys = new Set<string>();
  private textBlockId: number | null = null;
  /** Perubahan file giliran berjalan (keyed by path; ditulis ulang per path). */
  private turnChanges = new Map<string, FileChange>();
  /** Tugas berjalan = pesan user terakhir (pusat perhatian kartu TASK). */
  private task = "";

  private push(b: any): any {
    const blk: any = { id: nextId++, rev: 1, at: Date.now(), ...b };
    this.blocks.push(blk);
    return blk;
  }

  private find(id: number): Block | undefined {
    return this.blocks.find((b) => b.id === id);
  }

  private touch(b: Block | undefined): void {
    if (b) (b as any).rev++;
  }

  private last(): Block | undefined {
    return this.blocks[this.blocks.length - 1];
  }

  private registerMsgKey(role: string, content: string): string {
    const key = role + ":" + String(content || "").slice(0, 160);
    this.msgKeys.add(key);
    return key;
  }

  private hasMsgKey(role: string, content: string): boolean {
    return this.msgKeys.has(role + ":" + String(content || "").slice(0, 160));
  }

  // ── Input dari user (panel) ─────────────────────────────────────
  appendUser(text: string): void {
    const t = String(text || "");
    if (!t) return;
    this.turnChanges.clear(); // giliran baru — mulai hitung perubahan dari nol
    this.task = t;
    this.push({ kind: "user", text: t });
    this.registerMsgKey("user", t);
  }

  /** Tugas berjalan (pesan user terakhir) — untuk kartu TASK hero. */
  currentTask(): string {
    if (this.task.trim()) return this.task;
    // Defense-in-depth hydrate: bila msgKeys membuat pesan user dilewati saat
    // sync kedua, TASK tetap bisa diturunkan dari blok transcript yang nyata.
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i];
      if (block.kind === "user" && block.text.trim() && block.text.trim() !== CONTINUATION_PROMPT) {
        return block.text;
      }
    }
    return "";
  }

  /** Garis sistem singkat (status sesi, error lokal, dsb.). */
  status(text: string, variant?: "ok" | "err" | "warn"): void {
    this.push({ kind: "status", text, variant });
  }

  /** Bubble jawaban final dari jalur fallback (POST /ask blocking). */
  appendFinal(text: string): void {
    const t0 = String(text || "").trim();
    if (!t0) return;
    this.push({ kind: "final", text: t0 });
    this.registerMsgKey("assistant", t0);
  }

  // ── Mode live (SSE) ─────────────────────────────────────────────
  beginLive(): void {
    this.mode = "live";
    this.finalizeText();
  }

  endLive(): void {
    this.mode = "follow";
    this.finalizeText();
    // Blok narasi live sudah terlihat (work note / final) — daftarkan key-nya
    // agar syncFromHistory tidak menduplikasinya jadi bubble conversation.
    for (const b of this.blocks) {
      if (b.kind === "agent" && !b.streaming && b.text.trim()) {
        this.registerMsgKey("assistant", b.text);
      }
    }
  }

  private currentText(): Block | undefined {
    if (this.textBlockId == null) return undefined;
    const b = this.find(this.textBlockId);
    if (b && b.kind === "agent" && b.streaming) return b;
    return undefined;
  }

  private finalizeText(): void {
    const b = this.currentText();
    if (b) {
      (b as any).streaming = false;
      this.touch(b);
    }
    this.textBlockId = null;
  }

  /** Terapkan satu event SSE (hanya dipanggil saat mode live). */
  applySse(ev: AsSseEvent): void {
    if (ev.type === "delta") {
      if (!ev.text) return; // delta "" pembuka = no-op
      let b = this.currentText();
      if (!b) {
        b = this.push({ kind: "agent", text: "", streaming: true });
        this.textBlockId = (b as any).id;
      }
      (b as any).text += ev.text;
      this.touch(b);
      return;
    }
    // event selain delta menutup blok teks yang sedang mengalir
    this.finalizeText();

    if (ev.type === "tool_call") {
      // teks sebelum TOOL: baris adalah kalimat rencana — sisakan, buang baris
      // TOOL: dari blok teks terakhir (model menuliskannya di delta).
      const prev = this.last();
      if (prev && prev.kind === "agent") {
        prev.text = stripToolLine(prev.text);
        this.touch(prev);
        if (!prev.text.trim()) this.blocks.pop();
      }
      const change = changeFromTool(ev.name, ev.args);
      if (change) this.turnChanges.set(change.path, change);
      this.push({
        kind: "tool",
        name: ev.name,
        args: ev.args ?? null,
        summary: argsSummary(ev.name, ev.args),
        argsText: prettyArgs(ev.args),
        result: null,
        status: "running",
        change,
      });
      return;
    }

    if (ev.type === "tool_result") {
      const card = this.findToolCard(ev.name);
      if (card) {
        card.result = ev.text;
        card.status = /^ERROR/.test(ev.text) ? "error" : "done";
        // Durasi eksekusi (client clock) — kartu tanpa `at` (hydrate) dilewati.
        if (typeof card.at === "number") card.durMs = Math.max(0, Date.now() - card.at);
        if (card.status === "error" && card.change) {
          // Gagal = tidak jadi — buang dari kartu & hitungan giliran.
          if (card.change.path) this.turnChanges.delete(card.change.path);
          card.change = null;
        }
        this.touch(card);
      } else {
        // hasil tanpa kartu (mis. hasil tool yang disetujui saat panel baru
        // dibuka) — render sebagai kartu ringkas berisi hasil saja.
        this.push({
          kind: "tool",
          name: ev.name,
          args: null,
          summary: "",
          argsText: null,
          result: ev.text,
          status: /^ERROR/.test(ev.text) ? "error" : "done",
        });
      }
      return;
    }

    if (ev.type === "approval") {
      // Kartu izin: satu-satunya sumber penghapusan = rekonsiliasi apId dari
      // /status (reconcileApprovals). Hindari dobel bila SSE mengulang id.
      const exists = this.blocks.some(
        (b) => b.kind === "approval" && b.apId === ev.id,
      );
      if (!exists) {
        this.push({ kind: "approval", apId: ev.id, tool: ev.tool, args: ev.args ?? null });
      }
      return;
    }

    if (ev.type === "speak") {
      if (ev.text) this.push({ kind: "speak", text: ev.text });
      return;
    }

    if (ev.type === "done") {
      if (ev.ok === false) {
        this.status(ev.error || t("as.bus.failed"), "err");
        return;
      }
      const reply = stripInlineTool(String(ev.reply || "").trim());
      if (/⏳/.test(reply)) {
        // jawaban pause approval — kartu izin sudah mewakili; jangan bubble.
        // Perubahan yang sudah terjadi TETAP dilacak untuk giliran lanjutan.
        this.status("⏳ " + reply.replace(/^[^\n]*⏳\s*/, "").trim(), "warn");
        return;
      }
      const cur = this.last();
      this.pushChangesSummary();
      if (reply) {
        if (cur && cur.kind === "agent") {
          // teks yang mengalir == jawaban final → jadikan final di tempat
          // (dedupe); kalau beda, teks server (sudah dibersihkan) menang.
          const blk: any = cur;
          blk.kind = "final";
          blk.text = reply;
          this.touch(blk);
        } else {
          this.push({ kind: "final", text: reply });
        }
        this.registerMsgKey("assistant", reply);
      } else if (cur && cur.kind === "agent") {
        const blk: any = cur;
        blk.kind = "final";
        this.touch(blk);
        this.registerMsgKey("assistant", blk.text);
      }
      return;
    }
  }

  // ── Rekonsiliasi approval dari /status (sumber kebenaran tunggal) ──
  /** Dorong kartu ringkasan perubahan giliran (ala "N files changed") bila ada. */
  private pushChangesSummary(): void {
    if (!this.turnChanges.size) return;
    const files = [...this.turnChanges.values()];
    let added = 0;
    let removed = 0;
    for (const f of files) {
      added += f.added;
      removed += f.removed;
    }
    this.push({ kind: "changes", files, added, removed });
    this.turnChanges.clear();
  }

  /** Buang blok approval yang id-nya tidak lagi pending. */
  reconcileApprovals(pendingIds: string[]): void {
    const alive = new Set(pendingIds);
    this.blocks = this.blocks.filter(
      (b) => !(b.kind === "approval" && !alive.has(b.apId)),
    );
  }

  /**
   * Pastikan kartu izin untuk apId ada (dibuat dari /status.pendingApprovals —
   * sumber kebenaran). Jalur ask-stream tak mengirim event SSE "approval", jadi
   * tanpa ini tombol Allow/Deny tak pernah muncul dan tugas mutating (mis.
   * motion_save) macet di "⚠ butuh izin". Idempoten by apId.
   */
  ensureApproval(apId: string, tool: string, args: any, plan = false): boolean {
    if (!apId) return false;
    const found = this.blocks.find((b) => b.kind === "approval" && b.apId === apId);
    if (found) {
      // Kartu dibuat duluan oleh jalur SSE tanpa konteks plan — /status adalah
      // sumber kebenaran: upgrade di tempat (render berikutnya membacanya).
      if (plan) (found as Extract<Block, { kind: "approval" }>).plan = true;
      return false;
    }
    this.push({ kind: "approval", apId, tool, args: args ?? null, plan: plan || undefined });
    return true;
  }

  /**
   * Pensiunkan kartu "berjalan" sisa hidrasi yang tak akan terisi: mode
   * follow, bukan kartu live, dan namanya tidak ada di daftar approval
   * aktif. Dipanggil panel dari refreshStatus (sumber kebenaran /status).
   * Kartu live (SSE berjalan) dan yang benar-benar menunggu izin tetap.
   */
  retireStaleRunning(activeNames: string[]): number {
    const active = new Set(activeNames);
    let n = 0;
    for (const b of this.blocks) {
      if (b.kind === "tool" && b.status === "running" && !b.live && !active.has(b.name)) {
        b.result = t("wb.io.noResult");
        b.status = "done";
        this.touch(b);
        n++;
      }
    }
    return n;
  }

  /** Tandai kartu izin yang disetujui: blok hilang, kartu tool jadi jangkar. */
  resolveApprovalVisual(apId: string, byOtherClient: boolean): void {
    const blk = this.blocks.find((b) => b.kind === "approval" && b.apId === apId);
    if (!blk) return;
    this.blocks = this.blocks.filter((b) => b !== blk);
    if (byOtherClient) {
      const b = blk as Extract<Block, { kind: "approval" }>;
      const change = changeFromTool(b.tool, b.args);
      if (change) this.turnChanges.set(change.path, change);
      this.push({
        kind: "tool",
        name: b.tool,
        args: b.args,
        summary: byOtherClient ? t("as.bus.approvedOther") : argsSummary(b.tool, b.args),
        argsText: prettyArgs(b.args),
        result: null,
        status: "running",
        change,
      });
    }
    // bila panel sendiri yang menyetujui: kartu tool dari tool_call SSE sudah
    // ada dan tetap "running" sampai tool_result dari approve-stream mengisi.
  }

  // ── Event bus (mode follow; sebagian juga di live) ───────────────
  /** Terapkan event bus. Kembalikan sinyal untuk panel (mis. refresh status). */
  applyBus(ev: BusEvent): string[] {
    const signals: string[] = [];
    if (this.mode === "live" && SUPPRESSED_IN_LIVE.has(ev.type)) return signals;

    switch (ev.type) {
      case "thinking_start":
        if (this.mode === "follow") this.status("▶ " + (ev.label || t("as.status.thinking")));
        break;
      case "tool_call_start": {
        const { name, summary } = parseToolLabel(ev.label);
        this.push({
          kind: "tool",
          name,
          args: null,
          summary,
          argsText: null,
          result: null,
          status: "running",
          live: true,
        });
        break;
      }
      case "tool_call_end": {
        const idx = ev.label.indexOf("→");
        const name = idx > 0 ? ev.label.slice(0, idx).trim() : parseToolLabel(ev.label).name;
        const res = idx > 0 ? ev.label.slice(idx + 1).trim() : "";
        const card = this.findToolCard(name);
        if (card && !card.result) {
          card.result = res || t("as.bus.empty");
          card.status = /^ERROR/.test(res) ? "error" : "done";
          this.touch(card);
        } else if (!card) {
          this.push({
            kind: "tool",
            name,
            args: null,
            summary: "",
            argsText: null,
            result: res || t("as.bus.empty"),
            status: /^ERROR/.test(res) ? "error" : "done",
          });
        }
        break;
      }
      case "permission_request":
        this.status(t("as.bus.needPermission", { label: ev.label || "?" }), "warn");
        signals.push("refresh-status");
        break;
      case "permission_resolved":
        signals.push("refresh-status");
        break;
      case "verification_start":
        this.status("⟳ " + (ev.label || t("as.bus.verifying")), "warn");
        break;
      case "verification_result":
        this.status(
          (/^gagal/i.test(ev.label) ? "✗ " : "✓ ") + ev.label,
          /^gagal/i.test(ev.label) ? "err" : "ok",
        );
        break;
      case "plan_updated":
      case "plan_revised":
        signals.push("refresh-status");
        break;
      case "subagent_spawned":
      case "subagent_completed": {
        const colon = ev.label.indexOf(":");
        const name = colon > 0 ? ev.label.slice(0, colon).trim() : "sub";
        const text = colon > 0 ? ev.label.slice(colon + 1).trim() : ev.label;
        const existing = [...this.blocks].reverse().find(
          (b) => b.kind === "subagent" && b.name === name,
        );
        if (existing && ev.type === "subagent_completed") {
          (existing as any).state = "done";
          (existing as any).text = text;
          this.touch(existing);
        } else if (!existing) {
          this.push({
            kind: "subagent",
            name,
            state: ev.type === "subagent_completed" ? "done" : "spawned",
            text,
          });
        }
        break;
      }
      case "final_answer":
        if (this.mode === "follow") this.status("✓ " + t("as.bus.done"), "ok");
        break;
      case "error":
        this.status("✗ " + (ev.label || t("as.bus.error")), "err");
        break;
    }
    return signals;
  }

  // ── Hydration / sync dari /api/assistant/history ─────────────────
  /**
   * Render pesan history yang BELUM dirender (dedupe by role+awal konten).
   * Prompt internal lanjutan approval difilter. Kembalikan jumlah blok baru.
   */
  syncFromHistory(msgs: Array<{ role: string; content: string }>): number {
    let added = 0;
    for (let i = 0; i < (msgs || []).length; i++) {
      const m = msgs[i];
      const role = m.role === "tool" ? "tool" : m.role;
      const content = String(m.content || "");
      if (!content.trim()) continue;
      if (role === "user" && content.trim() === CONTINUATION_PROMPT) continue;
      if (this.hasMsgKey(role, content)) continue;
      this.registerMsgKey(role, content);
      if (role === "user") {
        this.task = content; // tugas terakhir = user terakhir di history
        this.push({ kind: "user", text: content });
      } else if (role === "tool") {
        // Tool yang menunggu izin (sesi dibuka ulang saat approval pending)
        // → kartu "running" supaya tool_result dari approve-stream mengisi.
        const wait = /^MENUNGGU PERSETUJUAN:\s*([a-z_]+)/.exec(content);
        const waitPlan = /^MENUNGGU PERSETUJUAN RENCANA/.test(content);
        if (waitPlan) {
          // Gate rencana: jeda sistem — marker ringkas, bukan kartu tool.
          this.push({ kind: "status", text: t("as.bus.planWait"), variant: "warn" });
        } else if (wait && msgs.slice(i + 1).some((n) =>
          n.role === "tool" && String(n.content || "").startsWith("[" + wait[1] + "]"))) {
          // Hasil tool ini sudah ada di history setelahnya → kartu hasil
          // akan dirender saat pesan itu tercapai; jangan buat kartu
          // "berjalan" abadi.
        } else if (wait) {
          this.push({
            kind: "tool",
            name: wait[1],
            args: null,
            summary: "",
            argsText: null,
            result: null,
            status: "running",
          });
        } else {
          const m2 = /^\[([a-z_]+)\]\s*([\s\S]*)$/.exec(content);
          const name = m2 ? m2[1] : "tool";
          const result = m2 ? m2[2] : content;
          // Dedupe dengan kartu LIVE dari bus: kartu live running DIISI
          // hasilnya; kartu live yang sudah berhasil sudah mewakili tool ini
          // — jangan tumpuk dua kartu untuk satu panggilan. Kartu hydrate
          // biasa (giliran/sesi lampau) tetap dirender.
          const twin = this.findToolCardAny(name);
          if (twin?.live && !twin.result) {
            twin.result = result;
            twin.status = /^ERROR/.test(result) ? "error" : "done";
            if (typeof twin.at === "number") twin.durMs = Math.max(0, Date.now() - twin.at);
            this.touch(twin);
          } else if (!twin?.live) {
            this.push({
              kind: "tool",
              name,
              args: null,
              summary: "",
              argsText: null,
              result,
              status: /^ERROR/.test(content) ? "error" : "done",
            });
          }
        }
      } else {
        // Pesan assistant yang DIIKUTI pesan tool = narasi kerja di tengah
        // eksekusi (bukan jawaban giliran) — dirender sebagai note work
        // region supaya segmen giliran tetap terbentuk setelah hydrate;
        // jawaban penutup (diikuti user / akhir) tetap blok final.
        const next = msgs.slice(i + 1).find((n) => n.role === "tool" || n.role === "user");
        const isNarration = !!next && next.role === "tool";
        const text = stripInlineTool(content);
        this.push(isNarration ? { kind: "agent", text } : { kind: "final", text });
      }
      added++;
    }
    return added;
  }

  private findToolCard(name: string): Extract<Block, { kind: "tool" }> | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.kind === "tool" && b.name === name && !b.result) return b;
    }
    return undefined;
  }

  /** Kartu tool terakhir dengan nama sama, apa pun statusnya (untuk dedupe
   *  hydrate vs kartu live bus). */
  private findToolCardAny(name: string): Extract<Block, { kind: "tool" }> | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.kind === "tool" && b.name === name) return b;
    }
    return undefined;
  }
}

/** Buang baris `TOOL: name {…}` (format panggilan tool) dari teks yang mengalir.
 *  Juga buang panggilan TOOL: inline di tengah paragraf — model reasoning
 *  kerap menulis "…langkahnya.TOOL: write_file {…}" dalam SATU baris, yang
 *  lolos filter baris dan tampil mentah ke user. */
export function stripToolLine(text: string): string {
  const perLine = String(text || "")
    .replace(/^\s*TOOL:\s*[a-z_]+\s*\{[\s\S]*?\}\s*$/gim, "")
    .trimEnd();
  // Inline: satu tingkat braces bersarang cukup untuk argumen tool umum.
  return perLine.replace(/\s*TOOL:\s*[a-z_]+\s*\{(?:[^{}]*|\{[^{}]*\})*\}/g, "").trimEnd();
}

/** Bersihkan kebocoran directive TOOL dari teks final/history (padanan
 *  server strip_tool_directive, untuk kasus yang lolos di sana). */
export function stripInlineTool(text: string): string {
  return stripToolLine(text);
}

/** Ringkasan satu baris utk header kartu tool. */
export function argsSummary(name: string, args: any): string {
  if (args == null) return "";
  if (typeof args === "string") return args.slice(0, 120);
  const a = args as Record<string, unknown>;
  const nTasks = Array.isArray(a.tasks) ? (a.tasks as any[]).length : undefined;
  const nItems = Array.isArray(a.todos) ? (a.todos as any[]).length : undefined;
  const first =
    a.path ?? a.command ?? a.query ?? a.key ??
    (nTasks != null ? t("as.bus.nTask", { n: nTasks }) : undefined) ??
    (nItems != null ? t("as.bus.nItem", { n: nItems }) : undefined) ??
    Object.values(a)[0];
  if (typeof first === "string") return first.slice(0, 120);
  if (first != null) return String(first).slice(0, 120);
  return "";
}

/** JSON rapi utk isi kartu; null bila tak ada args. */
export function prettyArgs(args: any): string | null {
  if (args == null) return null;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/** Label bus "name {json…}" → { name, summary }. */
export function parseToolLabel(label: string): { name: string; summary: string } {
  const m = /^([a-z_]+)\s*(\{[\s\S]*)?$/.exec(String(label || "").trim());
  if (!m) return { name: "tool", summary: label };
  return { name: m[1], summary: (m[2] || "").slice(0, 120) };
}

/** Kebijakan re-sync history panel: tarik ulang saat panjang history berubah
 *  dan panel tidak sedang men-streaming ask sendiri. Menutup lubang tugas
 *  yang disubmit di LUAR panel (hand-off companion / CLI) — dulu transcript
 *  tetap "Belum ada tugas aktif" sampai task selesai. */
export function historyNeedsSync(
  histCount: number | null,
  lastCount: number,
  liveAsk: boolean,
): boolean {
  if (liveAsk) return false;
  if (histCount === null) return false;
  return histCount !== lastCount;
}

// ═══════════════════════════════════════════════════════════════════
// Work segment per giliran (Fase 3 — pola conversationTurnWorkSegments)
// ═══════════════════════════════════════════════════════════════════

/** Satu giliran kerja: input user → pekerjaan (tool/status/changes/narasi)
 *  → jawaban final. Murni dari blocks — diuji tanpa DOM. */
export type WorkSegment = {
  /** Kunci stabil untuk state lipat UI: id blok pemicu, atau "pre". */
  key: string;
  /** Blok user pembuka; null untuk blok leading sebelum user pertama. */
  trigger: Extract<Block, { kind: "user" }> | null;
  /** Blok pekerjaan (tool/status/changes/subagent/speak/narasi agent). */
  work: Block[];
  /** Jawaban final penutup giliran; null = belum selesai. */
  final: Block | null;
  /** Segmen terakhir yang belum ada final-nya (agent sedang/diam di dalamnya). */
  open: boolean;
  /** Segmen tanpa final yang BUKAN terakhir (stream putus/error/ganti arah). */
  interrupted: boolean;
  startedAt?: number;
  endedAt?: number;
  toolsOk: number;
  toolsFail: number;
  changes: number;
};

/**
 * Pecah transkrip jadi segmen giliran: blok `user` memulai segmen; blok
 * `final` menutupnya; blok approval tidak ikut (dirender di zona kontrol).
 * Segmen tanpa final = open bila terakhir, interrupted bila bukan.
 */
export function computeSegments(blocks: Block[]): WorkSegment[] {
  const segs: WorkSegment[] = [];
  let cur: WorkSegment | null = null;
  const flush = () => {
    if (cur && (cur.trigger || cur.work.length || cur.final)) segs.push(cur);
    cur = null;
  };
  const start = (trigger: WorkSegment["trigger"]) => {
    flush();
    cur = {
      key: trigger ? String(trigger.id) : "pre",
      trigger,
      work: [],
      final: null,
      open: false,
      interrupted: false,
      toolsOk: 0,
      toolsFail: 0,
      changes: 0,
    };
  };
  for (const b of blocks) {
    if (b.kind === "approval") continue; // zona kontrol eksekusi, bukan aliran
    if (b.kind === "user") {
      start(b);
      continue;
    }
    if (!cur) start(null); // blok leading sebelum user pertama
    if (b.kind === "final") {
      cur!.final = b;
      flush();
      continue;
    }
    cur!.work.push(b);
    if (b.kind === "tool") {
      if (b.status === "done") cur!.toolsOk++;
      else if (b.status === "error") cur!.toolsFail++;
    } else if (b.kind === "changes") {
      cur!.changes++;
    }
  }
  flush();
  // Post-proses: tanpa final → open (terakhir) / interrupted (bukan terakhir),
  // plus cap waktu dari blok (hydrate history tidak punya — biarkan undefined).
  const last = segs.length ? segs[segs.length - 1] : null;
  for (const s of segs) {
    const all = [s.trigger, ...s.work, s.final].filter(Boolean) as Block[];
    const dated = all.filter((b) => typeof b.at === "number") as Array<Block & { at: number }>;
    if (dated.length) {
      s.startedAt = dated[0].at;
      s.endedAt = s.final?.at;
    }
    if (!s.final) {
      if (s === last) s.open = true;
      else s.interrupted = true;
    }
  }
  return segs;
}

/** Durasi ringkas untuk state line / segmen: 02:14, 1:02:14. Murni. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
