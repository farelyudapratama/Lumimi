/**
 * client/agent/panel/registry.ts — Registry perubahan file + log terminal
 * untuk tab Review/Terminal panel agent (murni, tanpa DOM/jaringan — diuji
 * langsung dengan bun test).
 *
 * Sumber data sama dengan transcript: event SSE tool_call/tool_result yang
 * lewat panel. Registry DI LUAR transcript supaya transcript tetap murni
 * merekam giliran, sedangkan registry hidup sepanjang sesi panel (lintas
 * giliran) — itu yang ditampilkan tab Review.
 */

import { changeFromTool } from "./diff";
import type { FileChange } from "./diff";
import { t } from "../../i18n/index";

/** Entri Review: perubahan terukur atau sekadar "tersentuh" (dari server). */
export type ReviewEntry =
  | { path: string; kind: FileChange["kind"]; added: number; removed: number; measured: true }
  | { path: string; kind: "touched"; added: 0; removed: 0; measured: false };

export class ChangeRegistry {
  private byPath = new Map<string, FileChange>();
  /** Path yang diketahui server tersentuh tapi tak terukur di client. */
  private touchedOnly = new Set<string>();

  /** Catat mutasi dari satu tool_call (tanpa efek bila bukan mutasi file). */
  record(name: string, args: any): void {
    const ch = changeFromTool(name, args);
    if (ch) {
      this.byPath.set(ch.path, ch);
      this.touchedOnly.delete(ch.path);
    }
  }

  /** Tool gagal → buang perubahan path bila sesuai (tidak jadi terjadi). */
  fail(name: string, args: any): void {
    if (name !== "write_file" && name !== "edit_file" && name !== "delete_file") return;
    const path = args && typeof args === "object" ? String((args as any).path || "") : "";
    if (path) this.byPath.delete(path);
  }

  /**
   * Gabungkan daftar filesTouched dari /status (server) — path yang belum
   * terukur di client tetap tampil sebagai "touched" (mis. hasil sesi CLI).
   */
  mergeTouched(paths: string[] | undefined): void {
    for (const p of paths || []) {
      const path = String(p || "");
      if (path && !this.byPath.has(path)) this.touchedOnly.add(path);
    }
  }

  list(): ReviewEntry[] {
    const out: ReviewEntry[] = [...this.byPath.values()].map((c): ReviewEntry => ({
      path: c.path, kind: c.kind, added: c.added, removed: c.removed, measured: true,
    }));
    for (const path of this.touchedOnly) {
      out.push({ path, kind: "touched", added: 0, removed: 0, measured: false });
    }
    return out;
  }

  clear(): void {
    this.byPath.clear();
    this.touchedOnly.clear();
  }
}

/** Entri terminal: perintah + hasil (null = masih jalan). */
export type TermEntry = { cmd: string; result: string | null; error: boolean };

export class TermLog {
  private entries: TermEntry[] = [];
  private static MAX = 80;

  get length(): number {
    return this.entries.length;
  }

  /** tool_call run_command — mulai entri. */
  start(cmd: string): void {
    this.entries.push({ cmd: String(cmd || ""), result: null, error: false });
    if (this.entries.length > TermLog.MAX) this.entries.shift();
  }

  /** tool_result run_command — isi entri terakhir yang masih jalan. */
  end(text: string): void {
    const error = /^ERROR/.test(text);
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].result === null) {
        this.entries[i].result = text;
        this.entries[i].error = error;
        return;
      }
    }
    // hasil tanpa entri (mis. panel dibuka saat tool jalan) → catat saja
    this.entries.push({ cmd: t("as.term.continued"), result: text, error });
    if (this.entries.length > TermLog.MAX) this.entries.shift();
  }

  list(): TermEntry[] {
    return this.entries.slice();
  }

  clear(): void {
    this.entries = [];
  }
}
