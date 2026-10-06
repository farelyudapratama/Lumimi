/**
 * test/agent-panel.test.ts — Unit test panel agent hasil remake (ala ZCode).
 * Menguji bagian murni: parser SSE + protokol fallback, reducer transcript
 * (supresi live/follow, metamorfosis approval, hydrate), dan direktur akting
 * (mapping per-event + cooldown).
 */
import { describe, it, expect } from "bun:test";
import { drainSse, decideFallback } from "../src/client/agent/panel/stream";
import type { AsSseEvent } from "../src/client/agent/panel/stream";
import {
  Transcript,
  CONTINUATION_PROMPT,
  stripToolLine,
  parseToolLabel,
  historyNeedsSync,
  computeSegments,
  formatDuration,
} from "../src/client/agent/panel/transcript";
import { deriveAgentState } from "../src/client/agent/panel/state";
import { diffLines, changeFromTool } from "../src/client/agent/panel/diff";
import { parseMarkdown, parseInlines } from "../src/client/agent/panel/md";
import { ChangeRegistry, TermLog } from "../src/client/agent/panel/registry";
import { makeActor } from "../src/client/agent/panel/actor";
import { toolRunIsTerminal } from "../src/client/agent/panel/view";

// ═══════════════════════════════════════════════════════════════
// Hierarki activity — grup selesai otomatis collapse
// ═══════════════════════════════════════════════════════════════

describe("toolRunIsTerminal", () => {
  it("true bila semua tool done/error", () => {
    expect(toolRunIsTerminal([{ status: "done" }, { status: "error" }])).toBe(true);
  });
  it("false bila masih ada running atau grup kosong", () => {
    expect(toolRunIsTerminal([{ status: "done" }, { status: "running" }])).toBe(false);
    expect(toolRunIsTerminal([])).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// stream.ts
// ═══════════════════════════════════════════════════════════════

describe("drainSse", () => {
  it("mengurai satu event utuh", () => {
    const { events, rest } = drainSse('data: {"type":"delta","text":"hi"}\n\n');
    expect(events).toEqual([{ type: "delta", text: "hi" }]);
    expect(rest).toBe("");
  });

  it("menyimpan potongan belum lengkap di rest", () => {
    const { events, rest } = drainSse('data: {"type":"delta","text":"a"}\n\ndata: {"type":"del');
    expect(events.length).toBe(1);
    expect(rest).toBe('data: {"type":"del');
  });

  it("menggabungkan buffer yang terpotong di tengah event", () => {
    const a = drainSse('data: {"type":"tool_call","name":"write_fil');
    expect(a.events.length).toBe(0);
    const b = drainSse(a.rest + 'e","args":{"path":"x"}}\n\n');
    expect(b.events).toEqual([{ type: "tool_call", name: "write_file", args: { path: "x" } }]);
  });

  it("melewati frame rusak tanpa melempar", () => {
    const { events } = drainSse("data: {rusak\n\ndata: {\"type\":\"delta\",\"text\":\"x\"}\n\n");
    expect(events).toEqual([{ type: "delta", text: "x" }]);
  });

  it("mengurai done dengan reply", () => {
    const { events } = drainSse('data: {"type":"done","ok":true,"reply":"selesai"}\n\n');
    expect(events[0].type).toBe("done");
    expect((events[0] as any).reply).toBe("selesai");
  });

  it("melewati komentar heartbeat ': ka' dari server tanpa jadi event", () => {
    // Server mengirim ": ka\n\n" tiap 5 dtk (anti idleTimeout) — parser wajib
    // mengabaikannya, event sesudahnya tetap terbaca.
    const { events, rest } = drainSse(
      ": ka\n\ndata: {\"type\":\"delta\",\"text\":\"x\"}\n\n: ka\n\n",
    );
    expect(events).toEqual([{ type: "delta", text: "x" }]);
    expect(rest).toBe("");
  });

  it("GOLDEN frame ask-stream lib.rs (ber-type) terparse utuh", () => {
    // Kontrak lib.rs post_assistant_ask_stream — persis byte yang di-emit
    // server. Dulu server mengirim {delta}/{done} TANPA type dan parser
    // membuang semuanya → streaming panel mati diam-diam (bug Fase 3).
    const buf =
      'data: {"type":"delta","text":"Lumi"}\n\n' +
      'data: {"type":"done","ok":true,"reply":"Lumi","paused":false}\n\n';
    const { events } = drainSse(buf);
    expect(events.length).toBe(2);
    expect(events[0]).toEqual({ type: "delta", text: "Lumi" });
    expect(events[1]).toEqual({ type: "done", ok: true, reply: "Lumi", paused: false });
  });

  it("GOLDEN frame done error (guard ask / LLM gagal) membawa ok:false", () => {
    const { events } = drainSse(
      'data: {"type":"done","ok":false,"error":"agent sedang menunggu keputusanmu di panel — setujui atau tolak dulu"}\n\n',
    );
    expect(events[0].type).toBe("done");
    expect((events[0] as any).ok).toBe(false);
    expect((events[0] as any).error).toContain("keputusan");
  });
});

describe("decideFallback (protokol dua-kasus)", () => {
  it("Kasus B: sudah ada event → follow, jangan kirim ulang", () => {
    expect(decideFallback({ receivedAnyEvent: true, busyNow: false })).toBe("follow");
    expect(decideFallback({ receivedAnyEvent: true, busyNow: true })).toBe("follow");
  });

  it("Kasus A: tanpa event + server tidak busy → resend sekali", () => {
    expect(decideFallback({ receivedAnyEvent: false, busyNow: false })).toBe("resend");
  });

  it("Kasus A: tanpa event tapi server busy → follow (request sudah sampai)", () => {
    expect(decideFallback({ receivedAnyEvent: false, busyNow: true })).toBe("follow");
  });
});

// ═══════════════════════════════════════════════════════════════
// transcript.ts
// ═══════════════════════════════════════════════════════════════

function sse(ev: AsSseEvent) {
  return ev;
}

describe("Transcript — mode live (SSE)", () => {
  it("delta menumpuk jadi blok agent streaming; delta kosong no-op", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.applySse(sse({ type: "delta", text: "" }));
    tr.applySse(sse({ type: "delta", text: "Oke, " }));
    tr.applySse(sse({ type: "delta", text: "kucek." }));
    const agent = tr.blocks.find((b) => b.kind === "agent") as any;
    expect(agent.text).toBe("Oke, kucek.");
    expect(agent.streaming).toBe(true);
  });

  it("tool_call memangkas baris TOOL: dan membuat kartu running", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.applySse(sse({ type: "delta", text: "Kucek dulu.\nTOOL: list_dir {}" }));
    tr.applySse(sse({ type: "tool_call", name: "list_dir", args: {} }));
    const agent = tr.blocks.find((b) => b.kind === "agent") as any;
    expect(agent.text).toBe("Kucek dulu.");
    const tool = tr.blocks.find((b) => b.kind === "tool") as any;
    expect(tool.name).toBe("list_dir");
    expect(tool.status).toBe("running");
    expect(tool.argsText).not.toBeNull();
  });

  it("tool_result mengisi kartu; prefix ERROR → status error", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.applySse(sse({ type: "tool_call", name: "read_file", args: { path: "a.ts" } }));
    tr.applySse(sse({ type: "tool_result", name: "read_file", text: "isi file" }));
    let tool = tr.blocks.find((b) => b.kind === "tool") as any;
    expect(tool.result).toBe("isi file");
    expect(tool.status).toBe("done");

    tr.applySse(sse({ type: "tool_call", name: "run_command", args: { command: "bun test" } }));
    tr.applySse(sse({ type: "tool_result", name: "run_command", text: "ERROR: exit 1" }));
    tool = tr.blocks.filter((b) => b.kind === "tool").pop() as any;
    expect(tool.status).toBe("error");
  });

  it("approval: blok dibuat sekali per id, dibuang lewat reconcileApprovals", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.applySse(sse({ type: "tool_call", name: "write_file", args: { path: "x" } }));
    tr.applySse(sse({ type: "approval", id: "ap_1", tool: "write_file", args: { path: "x" } }));
    tr.applySse(sse({ type: "approval", id: "ap_1", tool: "write_file", args: { path: "x" } }));
    expect(tr.blocks.filter((b) => b.kind === "approval").length).toBe(1);

    tr.reconcileApprovals(["ap_1"]);
    expect(tr.blocks.some((b) => b.kind === "approval")).toBe(true);
    tr.reconcileApprovals([]);
    expect(tr.blocks.some((b) => b.kind === "approval")).toBe(false);
  });

  it("ensureApproval: kartu plan dari /status meng-upgrade kartu SSE yang datang duluan", () => {
    const tr = new Transcript();
    tr.beginLive();
    // Jalur SSE membuat kartu tanpa konteks plan (event bus tidak membawanya).
    tr.applySse(sse({ type: "approval", id: "ap_plan", tool: "update_plan", args: { todos: [] } }));
    expect(tr.blocks.find((b) => b.kind === "approval")?.plan).toBeUndefined();
    // /status (sumber kebenaran) menandai kind=plan → upgrade di tempat, tanpa dobel kartu.
    const changed = tr.ensureApproval("ap_plan", "update_plan", { todos: [{ id: "1", task: "baca", status: "pending" }] }, true);
    expect(changed).toBe(false);
    const blocks = tr.blocks.filter((b) => b.kind === "approval");
    expect(blocks.length).toBe(1);
    expect(blocks[0].plan).toBe(true);
    // Kartu plan baru langsung terbawa saat belum ada dari SSE.
    expect(tr.ensureApproval("ap_plan2", "update_plan", { todos: [] }, true)).toBe(true);
    expect(tr.blocks.find((b) => b.kind === "approval" && b.apId === "ap_plan2")?.plan).toBe(true);
    // Kartu izin tool biasa tidak terpengaruh.
    expect(tr.ensureApproval("ap_tool", "write_file", { path: "x" }, false)).toBe(true);
    expect(tr.blocks.find((b) => b.kind === "approval" && b.apId === "ap_tool")?.plan).toBeUndefined();
  });

  it("metamorfosis approval klien lain → kartu tool ringkas running", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.applySse(sse({ type: "approval", id: "ap_2", tool: "run_command", args: { command: "bun test" } }));
    tr.resolveApprovalVisual("ap_2", true);
    expect(tr.blocks.some((b) => b.kind === "approval")).toBe(false);
    const tool = tr.blocks.find((b) => b.kind === "tool") as any;
    expect(tool.name).toBe("run_command");
    expect(tool.status).toBe("running");
    expect(tool.summary).toContain("klien lain");
  });

  it("done: teks yang mengalir == reply → jadi SATU blok final (dedupe)", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.applySse(sse({ type: "delta", text: "Selesai. Dua file ditulis." }));
    tr.applySse(sse({ type: "done", ok: true, reply: "Selesai. Dua file ditulis." }));
    expect(tr.blocks.filter((b) => b.kind === "final").length).toBe(1);
    expect(tr.blocks.some((b) => b.kind === "agent")).toBe(false);
  });

  it("done: reply ⏳ (pause approval) → status, BUKAN bubble final", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.applySse(sse({ type: "delta", text: "Tulis file ya." }));
    tr.applySse(sse({ type: "tool_call", name: "write_file", args: {} }));
    tr.applySse(sse({ type: "approval", id: "ap_3", tool: "write_file", args: {} }));
    tr.applySse(sse({ type: "done", ok: true, reply: "\n\n⏳ Aku butuh izinmu untuk write_file — cek panel Assistant." }));
    expect(tr.blocks.some((b) => b.kind === "final")).toBe(false);
    const st = tr.blocks.find((b) => b.kind === "status") as any;
    expect(st.variant).toBe("warn");
  });

  it("done gagal → status error", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.applySse(sse({ type: "done", ok: false, error: "boom" }));
    const st = tr.blocks.find((b) => b.kind === "status") as any;
    expect(st.variant).toBe("err");
  });

  it("speak → blok speak", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.applySse(sse({ type: "speak", text: "Sudah beres~" }));
    expect(tr.blocks.some((b) => b.kind === "speak")).toBe(true);
  });
});

describe("Transcript — supresi live/follow (bus)", () => {
  it("live: tool_call_start/end bus DIRENDER (SSE ask-stream tak membawa tool event)", () => {
    const tr = new Transcript();
    tr.beginLive();
    const sig = tr.applyBus({ seq: 1, type: "tool_call_start", label: 'list_dir {"path":"."}', ts: 0 });
    const tool = tr.blocks.find((b) => b.kind === "tool") as any;
    expect(tool).toBeTruthy();
    expect(tool.name).toBe("list_dir");
    tr.applyBus({ seq: 2, type: "tool_call_end", label: "list_dir → 12 entri", ts: 1 });
    const tool2 = tr.blocks.find((b) => b.kind === "tool") as any;
    expect(tool2.status).toBe("done");
    expect(tool2.result).toBe("12 entri");
    void sig;
  });

  it("live: thinking/final/error tetap disupresi (padanannya dari SSE delta/done)", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.applyBus({ seq: 1, type: "thinking_start", label: "", ts: 0 });
    tr.applyBus({ seq: 2, type: "final_answer", label: "", ts: 1 });
    tr.applyBus({ seq: 3, type: "error", label: "boom", ts: 2 });
    expect(tr.blocks.length).toBe(0);
  });

  it("follow: tool_call_start/end bus dirender sebagai kartu (aktivitas CLI)", () => {
    const tr = new Transcript();
    tr.applyBus({ seq: 1, type: "tool_call_start", label: 'list_dir {"path":"."}', ts: 0 });
    let tool = tr.blocks.find((b) => b.kind === "tool") as any;
    expect(tool.name).toBe("list_dir");
    expect(tool.status).toBe("running");
    tr.applyBus({ seq: 2, type: "tool_call_end", label: "list_dir → 12 entri", ts: 1 });
    tool = tr.blocks.find((b) => b.kind === "tool") as any;
    expect(tool.status).toBe("done");
    expect(tool.result).toBe("12 entri");
  });

  it("verification & subagent tetap dirender di mode live", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.applyBus({ seq: 1, type: "verification_result", label: "gagal: build error", ts: 0 });
    tr.applyBus({ seq: 2, type: "subagent_spawned", label: "sub1: riset folder", ts: 1 });
    tr.applyBus({ seq: 3, type: "subagent_completed", label: "sub1: 3 file ditemukan", ts: 2 });
    const st = tr.blocks.find((b) => b.kind === "status") as any;
    expect(st.variant).toBe("err");
    const sub = tr.blocks.find((b) => b.kind === "subagent") as any;
    expect(sub.name).toBe("sub1");
    expect(sub.state).toBe("done");
    expect(tr.blocks.filter((b) => b.kind === "subagent").length).toBe(1);
  });

  it("plan_updated memberi sinyal refresh-status tanpa blok baru", () => {
    const tr = new Transcript();
    const sig = tr.applyBus({ seq: 1, type: "plan_updated", label: "2/5 selesai", ts: 0 });
    expect(sig).toContain("refresh-status");
    expect(tr.blocks.length).toBe(0);
  });
});

describe("Transcript — hydrate dari /history", () => {
  it("prompt internal lanjutan approval difilter", () => {
    const tr = new Transcript();
    const n = tr.syncFromHistory([
      { role: "user", content: CONTINUATION_PROMPT },
      { role: "assistant", content: "Lanjutan selesai." },
    ]);
    expect(n).toBe(1);
    expect(tr.blocks.some((b) => b.kind === "user")).toBe(false);
  });

  it("tool '[name] hasil' → kartu; MENUNGGU PERSETUJUAN → kartu running", () => {
    const tr = new Transcript();
    tr.syncFromHistory([
      { role: "tool", content: "[read_file] isinya" },
      { role: "tool", content: "MENUNGGU PERSETUJUAN: write_file {\"path\":\"x\"} (id ap_9)" },
    ]);
    const tools = tr.blocks.filter((b) => b.kind === "tool") as any[];
    expect(tools[0].name).toBe("read_file");
    expect(tools[0].result).toBe("isinya");
    expect(tools[1].name).toBe("write_file");
    expect(tools[1].status).toBe("running");
  });

  it("dedupe by key: pesan yang sama tidak dirender dua kali", () => {
    const tr = new Transcript();
    tr.appendUser("cekin");
    const n = tr.syncFromHistory([{ role: "user", content: "cekin" }]);
    expect(n).toBe(0);
    expect(tr.blocks.filter((b) => b.kind === "user").length).toBe(1);
  });

  it("kartu live bus yang masih running diisi hasil hydrate, bukan ditumpuk", () => {
    const tr = new Transcript();
    tr.applyBus({ seq: 1, type: "tool_call_start", label: 'read_file {"path":"a.txt"}', ts: 0 });
    expect(tr.blocks.filter((b) => b.kind === "tool").length).toBe(1);
    tr.syncFromHistory([{ role: "tool", content: "[read_file] isinya" }]);
    const tools = tr.blocks.filter((b) => b.kind === "tool") as any[];
    expect(tools.length).toBe(1); // satu panggilan = satu kartu
    expect(tools[0].status).toBe("done");
    expect(tools[0].result).toBe("isinya");
  });

  it("kartu live yang sudah berhasil (fresh) tidak diduplikasi hydrate", () => {
    const tr = new Transcript();
    tr.applyBus({ seq: 1, type: "tool_call_start", label: "list_dir {}", ts: 0 });
    tr.applyBus({ seq: 2, type: "tool_call_end", label: "list_dir → 3 entri", ts: 1 });
    tr.syncFromHistory([{ role: "tool", content: "[list_dir] 3 entri" }]);
    expect(tr.blocks.filter((b) => b.kind === "tool").length).toBe(1);
  });

  it("tool di giliran/sesi lampau (kartu basi) tetap dirender hydrate", () => {
    const tr = new Transcript();
    tr.syncFromHistory([{ role: "tool", content: "[list_dir] lama" }]);
    tr.syncFromHistory([{ role: "tool", content: "[list_dir] baru" }]);
    const tools = tr.blocks.filter((b) => b.kind === "tool") as any[];
    expect(tools.length).toBe(2); // kartu hydrate tanpa `at` selalu dirender
  });

  it("narasi live tidak diduplikasi hydrate setelah stream selesai", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.applySse({ type: "delta", text: "Aku cek dulu foldernya." } as any);
    tr.applySse({ type: "tool_call", name: "list_dir", args: { path: "." } } as any);
    tr.applySse({ type: "done", ok: true, reply: "Selesai." } as any);
    tr.endLive();
    tr.syncFromHistory([
      { role: "assistant", content: "Aku cek dulu foldernya." },
      { role: "tool", content: "[list_dir] 3 entri" },
      { role: "assistant", content: "Selesai." },
    ]);
    const talks = tr.blocks.filter((b) => b.kind === "agent" || b.kind === "final");
    expect(talks.length).toBe(2); // narasi + final — tanpa kembaran hydrate
  });
});

describe("stripToolLine & parseToolLabel", () => {
  it("buang baris TOOL: multi-baris json", () => {
    expect(stripToolLine("Kalimat.\nTOOL: write_file {\"a\":1}")).toBe("Kalimat.");
    expect(stripToolLine("TOOL: list_dir {}")).toBe("");
  });
  it("buang panggilan TOOL: inline di tengah baris (kebocoran reasoning)", () => {
    expect(stripToolLine('Kami perlu menulis file.TOOL: write_file {"path":"x"} segera.'))
      .toBe("Kami perlu menulis file. segera.");
    expect(stripToolLine('prolog TOOL: read_file {"path":"a/b.txt"} epilog')).toBe("prolog epilog");
  });
  it("parse label bus tool", () => {
    expect(parseToolLabel('read_file {"path":"x"}').name).toBe("read_file");
    expect(parseToolLabel("bukan format").name).toBe("tool");
  });
});

// ═══════════════════════════════════════════════════════════════
// diff.ts — kalkulasi diff client-side
// ═══════════════════════════════════════════════════════════════

describe("diffLines", () => {
  it("identik → tanpa perubahan", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.hunks.length).toBe(0);
  });

  it("satu baris diganti → 1 add 1 del dalam satu hunk (konteks ter-trim)", () => {
    const d = diffLines("a\nb\nc\nd\ne", "a\nb\nC\nd\ne");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.hunks.length).toBe(1);
    // prefix/suffix sudah dipangkas → hunk hanya del+add, tanpa ctx
    expect(d.hunks[0].rows.map((r) => r.t).sort()).toEqual(["add", "del"]);
    // prefix 2 baris (a,b) → hunk mulai di baris ke-3 (1-based)
    expect(d.hunks[0].bStart).toBe(3);
  });

  it("konteks di dalam file tetap ada di sekitar perubahan", () => {
    const oldT = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12";
    const neuT = "1\nX\n3\n4\n5\n6\n7\n8\n9\n10\nY\n12";
    const d = diffLines(oldT, neuT);
    expect(d.hunks.length).toBe(2);
    // hunk pertama: konteks 2 baris di bawah perubahan (baris 3..4)
    expect(d.hunks[0].rows.some((r) => r.t === "ctx" && r.text === "3")).toBe(true);
    // perubahan di baris baru ke-2 (prefix "1" ter-trim dari konteks)
    expect(d.hunks[0].bStart).toBe(2);
  });

  it("file besar tapi mirip → diff tetap penuh (trim prefix/suffix)", () => {
    const big = Array.from({ length: 2500 }, (_, i) => "l" + i).join("\n");
    const d = diffLines(big, big + "\nextra");
    expect(d.clipped).toBe(false);
    expect(d.added).toBe(1);
  });

  it("dua gugus perubahan jauh → dua hunk", () => {
    const oldT = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12";
    const neuT = "1\nX\n3\n4\n5\n6\n7\n8\n9\n10\nY\n12";
    const d = diffLines(oldT, neuT);
    expect(d.hunks.length).toBe(2);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(2);
  });

  it("file terlalu besar → clipped, hanya stat", () => {
    const a1 = Array.from({ length: 1500 }, (_, i) => "a" + i).join("\n");
    const b1 = Array.from({ length: 1500 }, (_, i) => "b" + i).join("\n");
    const d = diffLines(a1, b1);
    expect(d.clipped).toBe(true);
    expect(d.hunks.length).toBe(0);
    expect(d.added).toBe(1500);
    expect(d.removed).toBe(1500);
  });

  it("teks kosong → full add", () => {
    const d = diffLines("", "baris1\nbaris2");
    expect(d.added).toBe(2);
    expect(d.removed).toBe(0);
  });
});

describe("changeFromTool", () => {
  it("write_file → kind write, full tambahan", () => {
    const c = changeFromTool("write_file", { path: "a.ts", content: "satu\ndua" });
    expect(c).not.toBeNull();
    expect(c!.kind).toBe("write");
    expect(c!.added).toBe(2);
  });

  it("edit_file → diff old→new", () => {
    const c = changeFromTool("edit_file", { path: "b.ts", old: "x\ny", new: "x\nz" });
    expect(c!.kind).toBe("edit");
    expect(c!.added).toBe(1);
    expect(c!.removed).toBe(1);
  });

  it("delete_file → clipped, removed tak tersedia", () => {
    const c = changeFromTool("delete_file", { path: "c.ts" });
    expect(c!.kind).toBe("delete");
    expect(c!.clipped).toBe(true);
    expect(c!.hunks.length).toBe(0);
  });

  it("tool lain / argumen tanpa path → null", () => {
    expect(changeFromTool("list_dir", { path: "." })).toBeNull();
    expect(changeFromTool("write_file", {})).toBeNull();
    expect(changeFromTool("read_file", null)).toBeNull();
  });
});

describe("Transcript — pelacakan perubahan per giliran", () => {
  it("tool_call mutasi membawa change; done → kartu changes lalu reset", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.appendUser("tulis ya");
    tr.applySse(sse({ type: "tool_call", name: "write_file", args: { path: "a.ts", content: "satu\ndua" } }));
    tr.applySse(sse({ type: "tool_result", name: "write_file", text: "OK" }));
    const tool = tr.blocks.find((b) => b.kind === "tool") as any;
    expect(tool.change).not.toBeNull();
    expect(tool.change.added).toBe(2);

    tr.applySse(sse({ type: "delta", text: "Beres." }));
    tr.applySse(sse({ type: "done", ok: true, reply: "Beres." }));
    const chg = tr.blocks.find((b) => b.kind === "changes") as any;
    expect(chg).toBeDefined();
    expect(chg.files.length).toBe(1);
    expect(chg.files[0].path).toBe("a.ts");
    expect(chg.added).toBe(2);
    expect(chg.removed).toBe(0);

    // giliran baru: tracking reset — done tanpa mutasi tidak membuat kartu
    tr.appendUser("cuma tanya");
    tr.applySse(sse({ type: "delta", text: "ya" }));
    tr.applySse(sse({ type: "done", ok: true, reply: "ya" }));
    expect(tr.blocks.filter((b) => b.kind === "changes").length).toBe(1);
  });

  it("tool_result ERROR → change dibuang dari kartu & ringkasan", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.applySse(sse({ type: "tool_call", name: "edit_file", args: { path: "b.ts", old: "x", new: "y" } }));
    tr.applySse(sse({ type: "tool_result", name: "edit_file", text: "ERROR: old tidak ditemukan" }));
    const tool = tr.blocks.find((b) => b.kind === "tool") as any;
    expect(tool.change).toBeNull();
    tr.applySse(sse({ type: "done", ok: true, reply: "gagal edit" }));
    expect(tr.blocks.some((b) => b.kind === "changes")).toBe(false);
  });

  it("dua mutasi pada path sama → ringkasan memakai versi terakhir", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.applySse(sse({ type: "tool_call", name: "write_file", args: { path: "a.ts", content: "dulu" } }));
    tr.applySse(sse({ type: "tool_result", name: "write_file", text: "OK" }));
    tr.applySse(sse({ type: "tool_call", name: "edit_file", args: { path: "a.ts", old: "dulu", new: "satu\ndua\ntiga" } }));
    tr.applySse(sse({ type: "tool_result", name: "edit_file", text: "OK" }));
    tr.applySse(sse({ type: "done", ok: true, reply: "ok" }));
    const chg = tr.blocks.find((b) => b.kind === "changes") as any;
    expect(chg.files.length).toBe(1);
    expect(chg.files[0].kind).toBe("edit");
    expect(chg.added).toBe(3);
  });

  it("done ⏳ (pause approval) → ringkasan ditunda, tracking lanjut", () => {
    const tr = new Transcript();
    tr.beginLive();
    tr.applySse(sse({ type: "tool_call", name: "write_file", args: { path: "a.ts", content: "x" } }));
    tr.applySse(sse({ type: "approval", id: "ap_10", tool: "write_file", args: { path: "a.ts" } }));
    tr.applySse(sse({ type: "done", ok: true, reply: "⏳ butuh izin" }));
    expect(tr.blocks.some((b) => b.kind === "changes")).toBe(false);
    // approval disetujui klien lain → change masuk lagi ke tracking giliran
    tr.resolveApprovalVisual("ap_10", true);
    tr.applySse(sse({ type: "tool_result", name: "write_file", text: "OK" }));
    tr.applySse(sse({ type: "done", ok: true, reply: "selesai" }));
    const chg = tr.blocks.find((b) => b.kind === "changes") as any;
    expect(chg).toBeDefined();
    expect(chg.files.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// md.ts — parser markdown mini
// ═══════════════════════════════════════════════════════════════

describe("parseMarkdown", () => {
  it("heading, paragraf, dan urutan blok terjaga", () => {
    const tk = parseMarkdown("# Judul\n\nparagraf satu\nlanjutan\n## Sub");
    expect(tk.map((x) => x.t)).toEqual(["h", "p", "h"]);
    expect(tk[0]).toMatchObject({ t: "h", level: 1 });
    expect(tk[1]).toMatchObject({ t: "p" });
    expect(tk[2]).toMatchObject({ t: "h", level: 2 });
  });

  it("fenced code utuh, tanpa inline parsing di dalamnya", () => {
    const tk = parseMarkdown("```ts\nconst a = `x`;\n# bukan heading\n```");
    expect(tk.length).toBe(1);
    expect(tk[0].t).toBe("code");
    expect((tk[0] as any).lang).toBe("ts");
    expect((tk[0] as any).text).toContain("# bukan heading");
  });

  it("list ul/ol + lanjutan item terindentasi", () => {
    const tk = parseMarkdown("- satu\n- dua\n  lanjutan\n1. eks\n2. ye");
    expect(tk.map((x) => x.t)).toEqual(["ul", "ol"]);
    expect((tk[0] as any).items.length).toBe(2);
    expect((tk[0] as any).items[1][1]).toMatchObject({ t: "text", text: " lanjutan" });
  });

  it("blockquote digabung antar baris", () => {
    const tk = parseMarkdown("> baris satu\n> baris dua");
    expect(tk[0].t).toBe("quote");
    expect((tk[0] as any).inlines[0].text).toContain("baris satu\nbaris dua");
  });

  it("inline: code, bold, italic, link http saja", () => {
    const inl = parseInlines("kode `x=1` dan **tebal** serta *miring* plus [tautan](https://a.b)");
    expect(inl.map((x) => x.t)).toEqual(["text", "code", "text", "bold", "text", "italic", "text", "link"]);
    expect(inl.find((x) => x.t === "link")).toMatchObject({ href: "https://a.b", text: "tautan" });

    // href non-http → TIDAK jadi link token
    const evil = parseInlines("[x](javascript:alert(1))");
    expect(evil.some((x) => x.t === "link")).toBe(false);
  });

  it("snake_case dan asterisk di tengah kata tidak jadi italic", () => {
    const inl = parseInlines("snake_case_var dan a*b*c tetap text");
    expect(inl.every((x) => x.t === "text")).toBe(true);
  });
});

describe("Transcript — tugas berjalan (kartu TASK)", () => {
  it("appendUser menyetel currentTask; transcript baru = kosong", () => {
    const tr = new Transcript();
    expect(tr.currentTask()).toBe("");
    tr.appendUser("Bikin fitur auth");
    expect(tr.currentTask()).toBe("Bikin fitur auth");
    // giliran berikutnya menimpa
    tr.appendUser("Sekarang perbaiki test");
    expect(tr.currentTask()).toBe("Sekarang perbaiki test");
  });

  it("syncFromHistory: user terakhir di history = tugas berjalan", () => {
    const tr = new Transcript();
    tr.syncFromHistory([
      { role: "user", content: "tugas lama" },
      { role: "assistant", content: "sudah" },
      { role: "user", content: "tugas baru" },
    ]);
    expect(tr.currentTask()).toBe("tugas baru");
    // prompt internal lanjutan tidak jadi task
    const tr2 = new Transcript();
    tr2.syncFromHistory([{ role: "user", content: CONTINUATION_PROMPT }]);
    expect(tr2.currentTask()).toBe("");
  });

  it("fallback currentTask membaca blok user terakhir bila cache task kosong", () => {
    const tr = new Transcript();
    tr.appendUser("tugas dari blok nyata");
    (tr as any).task = ""; // simulasi hydrate lama/cache terlewat
    expect(tr.currentTask()).toBe("tugas dari blok nyata");
  });
});

// ═══════════════════════════════════════════════════════════════
// registry.ts — ChangeRegistry (tab Review) & TermLog (tab Terminal)
// ═══════════════════════════════════════════════════════════════

describe("ChangeRegistry", () => {
  it("rekam mutasi sukses; ERROR membuang path terkait", () => {
    const r = new ChangeRegistry();
    r.record("write_file", { path: "a.ts", content: "x\ny" });
    r.record("edit_file", { path: "b.ts", old: "1", new: "2" });
    r.fail("edit_file", { path: "b.ts" });
    const list = r.list();
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ path: "a.ts", kind: "write", added: 2, measured: true });
  });

  it("path sama ditulis ulang → satu entri versi terakhir", () => {
    const r = new ChangeRegistry();
    r.record("write_file", { path: "a.ts", content: "dulu" });
    r.record("edit_file", { path: "a.ts", old: "dulu", new: "kini" });
    const list = r.list();
    expect(list.length).toBe(1);
    expect(list[0].kind).toBe("edit");
  });

  it("mergeTouched: path server tak terukur → entri 'touched'; jadi terukur saat dicatat", () => {
    const r = new ChangeRegistry();
    r.mergeTouched(["cli-only.ts", "a.ts"]);
    let list = r.list();
    expect(list.length).toBe(2);
    expect(list.find((e) => e.path === "cli-only.ts")).toMatchObject({ kind: "touched", measured: false });

    r.record("write_file", { path: "a.ts", content: "z" });
    list = r.list();
    expect(list.find((e) => e.path === "a.ts")).toMatchObject({ kind: "write", measured: true });
    expect(list.length).toBe(2); // touched "a.ts" tak dobel
  });

  it("tool non-mutasi & args rusak diabaikan", () => {
    const r = new ChangeRegistry();
    r.record("list_dir", { path: "." });
    r.record("write_file", null);
    expect(r.list().length).toBe(0);
  });
});

describe("TermLog", () => {
  it("start→end mengisi entri; ERROR menandai error", () => {
    const t = new TermLog();
    t.start("bun test");
    t.start("bun run build");
    t.end("ERROR: exit 1");
    const list = t.list();
    expect(list.length).toBe(2);
    expect(list[0]).toMatchObject({ cmd: "bun test", result: null });
    expect(list[1]).toMatchObject({ cmd: "bun run build", result: "ERROR: exit 1", error: true });
  });

  it("end tanpa entri berjalan → entri '(lanjutan)'", () => {
    const t = new TermLog();
    t.end("hasil yatim");
    expect(t.list()).toEqual([{ cmd: "(lanjutan)", result: "hasil yatim", error: false }]);
  });

  it("cap 80 entri — terlama dibuang", () => {
    const t = new TermLog();
    for (let i = 0; i < 85; i++) t.start("cmd-" + i);
    const list = t.list();
    expect(list.length).toBe(80);
    expect(list[0].cmd).toBe("cmd-5");
  });
});

// ═══════════════════════════════════════════════════════════════
// actor.ts — direktur akting (mapping per-event + cooldown)
// ═══════════════════════════════════════════════════════════════

function makeTestActor() {
  const calls: { gaze: string[]; emotion: string[]; spoke: string[]; quips: string[] } = {
    gaze: [], emotion: [], spoke: [], quips: [],
  };
  let clock = 100000; // jauh di atas semua cooldown awal (lastQuip/lastMotion = 0)
  const actor = makeActor({
    L: {
      setGazeIntent: (g: string) => calls.gaze.push(g),
      expressEmotion: (e: string) => calls.emotion.push(e),
    },
    t: (k: string) => k,
    post: async (_p: string, body: any) => {
      calls.quips.push(String(body?.event));
      return { quip: "" };
    },
    speakAsCharacter: (s: string) => calls.spoke.push(s),
    now: () => clock,
    // Timer fallback nyata — dipersingkat agar test bisa menunggunya.
    fallbackMs: 10,
  });
  return { actor, calls, tick: (ms: number) => { clock += ms; } };
}

const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("actor — mapping per-event", () => {
  it("verification gagal → kesal + quip LLM; lolos → senang tanpa komentar", async () => {
    const { actor, calls, tick } = makeTestActor();
    actor.onActivity({ type: "verification_result", label: "gagal: build error" });
    expect(calls.emotion).toContain("kesal");
    expect(calls.spoke.length).toBe(0); // LLM dulu — belum ada yang bicara
    await waitMs(30); // quip kosong → timer fallback menggugat template
    expect(calls.spoke).toEqual(["as.actor.error"]);
    tick(3000);
    calls.spoke.length = 0;
    actor.onActivity({ type: "verification_result", label: "lolos: build bersih" });
    expect(calls.emotion).toContain("senang");
    expect(calls.spoke.length).toBe(0); // lolos → tanpa komentar
  });

  it("quip LLM menang — template tidak diucapkan", async () => {
    const calls: { spoke: string[] } = { spoke: [] };
    let clock = 100000;
    const actor = makeActor({
      t: (k: string) => k,
      post: async () => ({ quip: "dia lagi baca config nih" }),
      speakAsCharacter: (s: string) => calls.spoke.push(s),
      now: () => clock,
      fallbackMs: 10,
    });
    actor.onActivity({ type: "tool_call_start", label: "read_file package.json" });
    await waitMs(5);
    expect(calls.spoke).toEqual(["dia lagi baca config nih"]); // quip saja
    await waitMs(30);
    expect(calls.spoke.length).toBe(1); // template DIBATALKAN
  });

  it("label event asli dikirim ke prompt quip — komentar spesifik, bukan generik", async () => {
    const { actor, calls } = makeTestActor();
    actor.onActivity({ type: "tool_call_start", label: "read_file package.json {}" });
    expect(calls.quips[0]).toContain("read_file package.json");
  });

  it("plan_revised → gaze think + quip revised (fallback saat gagal)", async () => {
    const { actor, calls, tick } = makeTestActor();
    actor.onActivity({ type: "plan_revised", label: "tambah item" });
    expect(calls.gaze).toContain("think");
    expect(calls.spoke.length).toBe(0);
    await waitMs(30);
    expect(calls.spoke).toEqual(["as.actor.revised"]);
    tick(16000); // lepas cooldown quip
    calls.spoke.length = 0;
    actor.onActivity({ type: "plan_revised", label: "ubah arah" });
    expect(calls.quips.length).toBe(2);
  });

  it("permission_resolved: disetujui → lega; ditolak → TANPA reaksi", () => {
    const { actor, calls, tick } = makeTestActor();
    actor.onActivity({ type: "permission_resolved", label: "disetujui: write_file" });
    expect(calls.emotion).toContain("senang");
    const emotionAfter = calls.emotion.length;
    const gazeAfter = calls.gaze.length;
    tick(3000);
    actor.onActivity({ type: "permission_resolved", label: "ditolak: delete_file" });
    expect(calls.emotion.length).toBe(emotionAfter);
    expect(calls.gaze.length).toBe(gazeAfter);
  });

  it("subagent_completed → reaksi ringan; spawned → quip (fallback saat gagal)", async () => {
    const { actor, calls, tick } = makeTestActor();
    actor.onActivity({ type: "subagent_spawned", label: "sub1: riset" });
    expect(calls.spoke.length).toBe(0);
    await waitMs(30);
    expect(calls.spoke).toEqual(["as.actor.tool"]);
    tick(3000);
    actor.onActivity({ type: "subagent_completed", label: "sub1: 3 file" });
    expect(calls.emotion).toContain("senang");
    expect(calls.spoke.length).toBe(1); // tidak bertambah
  });

  it("cooldown motion: dua tool beruntun → reaksi kedua ditahan", () => {
    const { actor, calls, tick } = makeTestActor();
    actor.onActivity({ type: "tool_call_start", label: "list_dir {}" });
    const gazeAfterFirst = calls.gaze.length;
    actor.onActivity({ type: "tool_call_end", label: "list_dir → x" });
    expect(calls.gaze.length).toBe(gazeAfterFirst); // dalam 2,5 dtk → ditahan
    tick(2600);
    actor.onActivity({ type: "tool_call_start", label: "read_file {}" });
    expect(calls.gaze.length).toBeGreaterThan(gazeAfterFirst);
  });

  it("cooldown quip 15 dtk: dalam cooldown → DIAM (tanpa template, tanpa quip)", async () => {
    const { actor, calls, tick } = makeTestActor();
    actor.onActivity({ type: "thinking_start", label: "tugas" });
    expect(calls.quips.length).toBe(1);
    await waitMs(30); // fallback pertama bicara
    calls.spoke.length = 0;
    tick(5000);
    actor.onActivity({ type: "tool_call_start", label: "list_dir {}" });
    expect(calls.quips.length).toBe(1); // masih cooldown — quip tak diminta
    expect(calls.spoke.length).toBe(0); // dan BUKAN template juga
    tick(16000); // lepas cooldown
    actor.onActivity({ type: "tool_call_start", label: "read_file {}" });
    expect(calls.quips.length).toBe(2);
  });

  it("quip gagal (reject) → template segera, tanpa menunggu timer", async () => {
    const calls: { spoke: string[] } = { spoke: [] };
    let clock = 100000;
    const actor = makeActor({
      t: (k: string) => k,
      post: async () => { throw new Error("LLM mati"); },
      speakAsCharacter: (s: string) => calls.spoke.push(s),
      now: () => clock,
      fallbackMs: 10_000, // timer panjang — template harus datang dari catch
    });
    actor.onActivity({ type: "error", label: "boom" });
    await waitMs(5);
    expect(calls.spoke).toEqual(["as.actor.error"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Re-sync history — tugas dari luar panel (hand-off companion/CLI)
// ═══════════════════════════════════════════════════════════════

describe("historyNeedsSync", () => {
  it("sync saat historyCount berubah (task eksternal masuk/selesai)", () => {
    expect(historyNeedsSync(4, -1, false)).toBe(true); // pertama kali
    expect(historyNeedsSync(5, 4, false)).toBe(true); // tugas baru dari companion
    expect(historyNeedsSync(4, 4, false)).toBe(false); // tidak berubah
  });

  it("tidak sync saat panel sedang live-stream ask sendiri", () => {
    expect(historyNeedsSync(9, 4, true)).toBe(false);
  });

  it("historyCount tidak tersedia → tidak sync", () => {
    expect(historyNeedsSync(null, 4, false)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Work segment per giliran (Fase 3 — pola work-segment harness)
// ═══════════════════════════════════════════════════════════════

function mkBlocks(): any[] {
  return [
    { kind: "user", id: 1, rev: 1, text: "perbaiki bug port", at: 1000 },
    { kind: "agent", id: 2, rev: 1, text: "kucek dulu.", streaming: false, at: 1100 },
    { kind: "tool", id: 3, rev: 1, name: "read_file", args: null, summary: "", argsText: null, result: "isi", status: "done", at: 1200 },
    { kind: "tool", id: 4, rev: 1, name: "edit_file", args: null, summary: "", argsText: null, result: "ERROR: x", status: "error", at: 1300 },
    { kind: "changes", id: 5, rev: 1, files: [{ path: "a.ts", kind: "edit", added: 1, removed: 0, hunks: [] }], added: 1, removed: 0, at: 1400 },
    { kind: "final", id: 6, rev: 1, text: "selesai.", at: 1500 },
  ];
}

describe("computeSegments", () => {
  it("giliran lengkap: user → work → final = completed dengan hitungan & waktu", () => {
    const segs = computeSegments(mkBlocks());
    expect(segs.length).toBe(1);
    const s = segs[0];
    expect(s.key).toBe("1");
    expect(s.trigger.text).toBe("perbaiki bug port");
    expect(s.final?.kind).toBe("final");
    expect(s.open).toBe(false);
    expect(s.interrupted).toBe(false);
    expect(s.toolsOk).toBe(1);
    expect(s.toolsFail).toBe(1);
    expect(s.changes).toBe(1);
    expect(s.startedAt).toBe(1000);
    expect(s.endedAt).toBe(1500);
  });

  it("segmen tanpa final: terakhir = open, di tengah = interrupted", () => {
    const segs = computeSegments([
      { kind: "user", id: 1, rev: 1, text: "a", at: 1 },
      { kind: "tool", id: 2, rev: 1, name: "grep", args: null, summary: "", argsText: null, result: "x", status: "done", at: 2 },
      { kind: "user", id: 3, rev: 1, text: "b", at: 3 },
      { kind: "tool", id: 4, rev: 1, name: "grep", args: null, summary: "", argsText: null, result: null, status: "running", at: 4 },
    ] as any);
    expect(segs.length).toBe(2);
    expect(segs[0].interrupted).toBe(true);
    expect(segs[0].open).toBe(false);
    expect(segs[1].open).toBe(true);
    expect(segs[1].interrupted).toBe(false);
  });

  it("approval dibuang dari segmen (hidup di zona kontrol)", () => {
    const blocks = mkBlocks();
    blocks.splice(2, 0, { kind: "approval", id: 99, rev: 1, apId: "ap_9", tool: "edit_file", args: {} });
    const segs = computeSegments(blocks);
    expect(segs[0].work.some((b: any) => b.kind === "approval")).toBe(false);
    expect(segs[0].toolsOk).toBe(1);
  });

  it("blok leading sebelum user pertama = segmen pre tanpa trigger", () => {
    const segs = computeSegments([
      { kind: "status", id: 9, rev: 1, text: "boot", at: 1 },
      { kind: "user", id: 10, rev: 1, text: "halo", at: 2 },
    ] as any);
    expect(segs.length).toBe(2);
    expect(segs[0].key).toBe("pre");
    expect(segs[0].trigger).toBeNull();
    expect(segs[1].key).toBe("10");
  });

  it("blok hasil hydrate tanpa at: startedAt/endedAt undefined (durasi tak diarakan)", () => {
    const blocks = mkBlocks().map((b) => { const { at, ...rest } = b; return rest; });
    const segs = computeSegments(blocks);
    expect(segs[0].startedAt).toBeUndefined();
    expect(segs[0].endedAt).toBeUndefined();
  });
});

describe("formatDuration", () => {
  it("mm:ss dan h:mm:ss, negatif → 00:00", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(134_000)).toBe("02:14");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
    expect(formatDuration(-5)).toBe("00:00");
  });
});

// ═══════════════════════════════════════════════════════════════
// State line — state machine agent (Fase 3)
// ═══════════════════════════════════════════════════════════════

describe("deriveAgentState", () => {
  const NOW = 1_000_000;
  const base = { plan: [], notes: { filesTouched: [] }, pendingApprovals: [] };

  it("runtime mati → off apa pun kondisinya", () => {
    const sv = deriveAgentState({ ...base, running: false, busy: true }, NOW - 9000, NOW);
    expect(sv.state).toBe("off");
    expect(sv.elapsedMs).toBe(0);
  });

  it("waitingPlan: approval rencana menang di atas kartu tool lain", () => {
    const sv = deriveAgentState({
      ...base,
      running: true,
      busy: false,
      pendingApprovals: [
        { id: "a", tool: "write_file", args: {}, ts: NOW - 1000 },
        { id: "b", tool: "update_plan", args: { todos: [] }, kind: "plan", ts: NOW - 5000 },
      ],
    }, 0, NOW);
    expect(sv.state).toBe("waitingPlan");
    expect(sv.what).toBe("rencana kerja");
    expect(sv.elapsedMs).toBe(5000);
  });

  it("waitingApproval: run_command membawa perintahnya sebagai what", () => {
    const sv = deriveAgentState({
      ...base,
      running: true,
      busy: false,
      pendingApprovals: [{ id: "a", tool: "run_command", args: { command: "cargo test --workspace" }, ts: NOW - 61_000 }],
    }, 0, NOW);
    expect(sv.state).toBe("waitingApproval");
    expect(sv.what).toContain("cargo test --workspace");
    expect(sv.elapsedMs).toBe(61_000);
  });

  it("executing: busy + event tool_call_start terakhir", () => {
    const sv = deriveAgentState({
      ...base,
      running: true,
      busy: true,
      lastEvent: { seq: 9, type: "tool_call_start", label: "run_command", ts: NOW - 30_000 },
    }, NOW - 40_000, NOW);
    expect(sv.state).toBe("executing");
    expect(sv.what).toBe("run_command");
    expect(sv.elapsedMs).toBe(30_000);
  });

  it("executing: label bus kaya 'name {json}' ditampilkan sebagai nama tool saja", () => {
    const sv = deriveAgentState({
      ...base,
      running: true,
      busy: true,
      lastEvent: { seq: 9, type: "tool_call_start", label: 'write_file {"path":"a.txt","content":"halo"}', ts: NOW - 2000 },
    }, 0, NOW);
    expect(sv.state).toBe("executing");
    expect(sv.what).toBe("write_file");
    expect(sv.what).not.toContain("{");
  });

  it("thinking: busy tanpa tool aktif — elapsed dari busySince (client)", () => {
    const sv = deriveAgentState({
      ...base,
      running: true,
      busy: true,
      lastEvent: { seq: 9, type: "final_answer", label: "", ts: NOW - 999_999 },
    }, NOW - 7000, NOW);
    expect(sv.state).toBe("thinking");
    expect(sv.elapsedMs).toBe(7000);
  });

  it("idle: runtime hidup tanpa busy; hitungan plan & berkas ikut", () => {
    const sv = deriveAgentState({
      running: true,
      busy: false,
      pendingApprovals: [],
      plan: [{ status: "done" }, { status: "in_progress" }, { status: "pending" }],
      notes: { filesTouched: ["a.ts", "b.ts"] },
    }, 0, NOW);
    expect(sv.state).toBe("idle");
    expect(sv.stepsDone).toBe(1);
    expect(sv.stepsTotal).toBe(3);
    expect(sv.filesTouched).toBe(2);
  });
});
