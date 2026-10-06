/**
 * client/agent/panel/workbench-model.ts — Model murni tampilan Agent
 * Workbench (rebuild clean-slate 2026-10, bahasa visual ala harness).
 *
 * TIDAK menyentuh DOM/jaringan. Mengubah blok transcript (reducer lama
 * tetap sumber kebenaran) + status server menjadi daftar item aktifitas
 * siap-render: baris tool tunggal/grup, kartu todo, kartu perubahan,
 * narasi, subagent, marker sistem, jawaban final. Grup selesai otomatis
 * collapse; grup/ tool berjalan terbuka — keputusan collapse ada di sini
 * supaya bisa diuji tanpa DOM.
 */

import type { Block } from "./transcript";
import { t } from "../../i18n/index";

export type ToolBlock = Extract<Block, { kind: "tool" }>;

/** Keluarga tool untuk pengelompokan otomatis (pola harness: Explore /
 *  Terminal / Changes). Lainnya = single. */
export type ToolFamily = "explore" | "terminal" | "changes" | null;

const EXPLORE_TOOLS = new Set(["list_dir", "read_file", "search_code", "git_diff", "memory_recall"]);
const TERMINAL_TOOLS = new Set(["run_command"]);
const CHANGES_TOOLS = new Set(["write_file", "edit_file", "delete_file"]);

export function toolFamily(name: string): ToolFamily {
  if (EXPLORE_TOOLS.has(name)) return "explore";
  if (TERMINAL_TOOLS.has(name)) return "terminal";
  if (CHANGES_TOOLS.has(name)) return "changes";
  return null;
}

/** Grup terminal bila semua kartu sudah done/error (bukan running). */
export function toolRunIsTerminal(run: Array<{ status: string }>): boolean {
  return run.length > 0 && run.every((b) => b.status !== "running");
}

/** Label semantik satu tool — verb ringkas bahasa kerja (i18n). */
export function toolKindLabel(name: string, running: boolean): string {
  const key = "wb.tool." + name;
  const label = t(key);
  const known = label !== key;
  const base = known ? label : name;
  return running ? t("wb.tool.running") + " " + base : base;
}

/** Ringkas argumen jadi teks utama baris (path/command/query). */
export function toolPrimaryText(name: string, args: any): string {
  if (args == null) return "";
  if (typeof args === "string") return args.slice(0, 140);
  if (typeof args !== "object") return String(args).slice(0, 140);
  const a = args as Record<string, unknown>;
  const first =
    a.path ?? a.command ?? a.query ?? a.key ?? a.url ??
    (Array.isArray(a.todos) ? (a.todos as any[]).map((x) => x?.task ?? "").filter(Boolean).join("; ") : undefined);
  return (typeof first === "string" ? first : first != null ? String(first) : "").slice(0, 140);
}

// ═══════════════════════════════════════════════════════════════════
// Item aktifitas — satu node render di stream
// ═══════════════════════════════════════════════════════════════════

export type GroupItem = {
  kind: "group";
  key: string;
  family: "explore" | "terminal" | "changes";
  blocks: ToolBlock[];
  running: boolean;
  /** Collapse otomatis: grup selesai dilipat, kecuali user membukanya. */
  collapsed: boolean;
};

export type ToolItem = { kind: "tool"; key: string; block: ToolBlock; collapsed: boolean };

export type PlanStep = { id: string; task: string; status: string; note?: string };

export type TodoItem = { kind: "todo"; key: string; steps: PlanStep[] };

export type ChangeFiles = {
  path: string;
  kind: string;
  added: number;
  removed: number;
  measured: boolean;
};
export type ChangesItem = {
  kind: "changes";
  key: string;
  files: ChangeFiles[];
  added: number;
  removed: number;
};

export type ActivityItem =
  | { kind: "user"; key: string; block: Extract<Block, { kind: "user" }> }
  | { kind: "note"; key: string; block: Extract<Block, { kind: "agent" | "speak" }> }
  | { kind: "final"; key: string; block: Extract<Block, { kind: "final" }> }
  | { kind: "subagent"; key: string; block: Extract<Block, { kind: "subagent" }> }
  | { kind: "marker"; key: string; text: string; variant?: "ok" | "err" | "warn" }
  | ToolItem
  | GroupItem
  | TodoItem
  | ChangesItem;

const GROUP_MIN = 2;

/**
 * Ubah blok jadi item aktifitas. Blok approval tidak lewat sini (zona
 * kontrol). Grup: ≥2 tool sekeluarga yang BERurutan. Collapse: grup selesai
 * dilipat (kecuali dipaksa buka lewat expandedKeys); tool tunggal dilipat
 * bila selesai — yang berjalan selalu terbuka.
 */
export function buildActivityItems(
  blocks: Block[],
  expanded: Set<string>,
): ActivityItem[] {
  const items: ActivityItem[] = [];
  let i = 0;
  const keyOf = (b: Block) => String(b.id);
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.kind === "approval") { i++; continue; }
    if (b.kind === "user") {
      items.push({ kind: "user", key: keyOf(b), block: b });
      i++;
      continue;
    }
    if (b.kind === "tool") {
      const fam = toolFamily(b.name);
      // Kumpulkan run berurutan sekeluarga.
      if (fam) {
        const run: ToolBlock[] = [b];
        let j = i + 1;
        while (j < blocks.length) {
          const nb = blocks[j];
          if (nb.kind !== "tool" || toolFamily(nb.name) !== fam) break;
          run.push(nb);
          j++;
        }
        if (run.length >= GROUP_MIN) {
          const key = "g" + b.id;
          const running = !toolRunIsTerminal(run);
          items.push({
            kind: "group", key, family: fam, blocks: run, running,
            collapsed: !running && !expanded.has(key),
          });
          i = j;
          continue;
        }
      }
      const key = keyOf(b);
      items.push({
        kind: "tool", key, block: b,
        collapsed: b.status !== "running" && !expanded.has(key),
      });
      i++;
      continue;
    }
    if (b.kind === "agent" || b.kind === "speak") {
      items.push({ kind: "note", key: keyOf(b), block: b });
      i++;
      continue;
    }
    if (b.kind === "final") {
      items.push({ kind: "final", key: keyOf(b), block: b });
      i++;
      continue;
    }
    if (b.kind === "subagent") {
      items.push({ kind: "subagent", key: keyOf(b), block: b });
      i++;
      continue;
    }
    if (b.kind === "changes") {
      const cb = b as Extract<Block, { kind: "changes" }>;
      items.push({
        kind: "changes", key: keyOf(b),
        files: cb.files.map((f) => ({
          path: f.path, kind: String(f.kind), added: f.added, removed: f.removed,
          measured: true,
        })),
        added: cb.added, removed: cb.removed,
      });
      i++;
      continue;
    }
    if (b.kind === "status") {
      items.push({
        kind: "marker", key: keyOf(b), text: b.text,
        variant: b.variant,
      });
      i++;
      continue;
    }
    i++;
  }
  return items;
}

/** Kartu todo dari plan server (sumber kebenaran status.plan). Null bila kosong. */
export function buildTodoItem(plan: any[] | undefined | null, expanded: Set<string>): TodoItem | null {
  const steps = (Array.isArray(plan) ? plan : [])
    .map((p, idx): PlanStep => ({
      id: String(p?.id ?? idx),
      task: String(p?.task ?? "").trim(),
      status: String(p?.status ?? "pending"),
      note: p?.note ? String(p.note) : undefined,
    }))
    .filter((s) => s.task);
  if (!steps.length) return null;
  return { kind: "todo", key: "plan", steps };
}

/** Fraksi selesai utk header todo: "2/5". */
export function planFraction(steps: PlanStep[]): { done: number; total: number } {
  return {
    done: steps.filter((s) => s.status === "done").length,
    total: steps.length,
  };
}

/** Langkah berjalan (in_progress) teratas — tampil di header todo. */
export function planCurrent(steps: PlanStep[]): string {
  return (steps.find((s) => s.status === "in_progress") || {}).task || "";
}

/** Path file → { dir, name } utk render kartu perubahan. */
export function splitPath(path: string): { dir: string; name: string } {
  const p = String(path || "").replace(/\\/g, "/");
  const cut = Math.max(p.lastIndexOf("/"), 0);
  return { dir: cut ? p.slice(0, cut) : "", name: p.slice(cut + (cut ? 1 : 0)) || p };
}

/** Ringkas daftar argumen tool utk header grup: "3 perintah" / "4 berkas". */
export function groupSummary(family: "explore" | "terminal" | "changes", n: number, failed: number): string {
  const noun = t(family === "terminal" ? "wb.group.cmds" : family === "changes" ? "wb.group.files" : "wb.group.lookups");
  const base = t("wb.group.count", { n }) + " " + noun;
  return failed > 0 ? base + ", " + t("wb.group.failed", { n: failed }) : base;
}
