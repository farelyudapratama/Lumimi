/**
 * companion-memory.test.ts — sistem memory dua lapis companion (2026-10-04).
 *
 * Yang dikunci di sini:
 *   1. Session context (RAM): giliran penuh user+assistant jauh melebihi
 *      jendela terakhir; FIFO cap menggeser kursor ringkasan/ekstraksi.
 *   2. Kompresi bergulir: trigger → blok bertahap → ringkasan diterapkan.
 *   3. Retrieval potongan lama per-request (skor token, urut kronologis).
 *   4. buildContextMessages: potongan lama relevan + jendela terakhir —
 *      pengganti splice mentah 24-entry (HISTORY_LIMIT lama).
 *   5. looksTaskish sebagai gerbang RECALL saja — pesan tanpa isyarat
 *      permintaan tidak pernah dicek LLM; keyword TIDAK memutuskan routing.
 *   6. Jalur think() penuh (pola companion-concurrency.test.ts):
 *      chat biasa membawa memori + context dan balasan masuk history;
 *      permintaan tugas ter-route ke Agent (/api/assistant/ask) dengan
 *      konteks, TANPA /api/chat; worker busy → ack, tanpa ask; intent chat
 *      (isTask:false) tetap lewat jalur chat; housekeeping kompres sesi.
 *   7. clearSession mengosongkan sesi IN PLACE (referensi window.__agent.
 *      history tetap sah), long-term memory tidak tersentuh.
 */
import { describe, test, expect, afterAll } from "bun:test";
import {
  SessionContext,
  buildContextMessages,
  retrieveOlderTurns,
  scoreTurn,
  tokenize,
  sessionSummaryBlock,
  memoryBlock,
  looksTaskish,
  handoffAcks,
  composeHandoffText,
  RECENT_WINDOW,
  COMPRESS_TRIGGER,
  COMPRESS_CHUNK,
  EXTRACT_EVERY,
} from "../src/client/agent/companion-memory";
import { AgentBrain } from "../src/client/agent/brain";

const g = globalThis as any;
const ORIG = { window: g.window, document: g.document, fetch: g.fetch };
afterAll(() => {
  g.window = ORIG.window;
  g.document = ORIG.document;
  g.fetch = ORIG.fetch;
  AgentBrain.HOUSEKEEPING_DELAY_MS = 1500;
});

// ── 1. Tokenisasi & skor ───────────────────────────────────────────────

describe("tokenize / scoreTurn", () => {
  test("tokenisasi lintas-bahasa, buang token pendek", () => {
    expect(tokenize("Aku mau cari Restoran Jepang!")).toEqual([
      "aku", "mau", "cari", "restoran", "jepang",
    ]);
    expect(tokenize("ラーメンを食べる")).toEqual(["ラーメンを食べる"]);
    expect(tokenize("a ! ?")).toEqual([]);
  });

  test("scoreTurn: overlap proporsional, kosong = 0", () => {
    const t: any = { role: "user", content: "user mau cari restoran jepang" };
    expect(scoreTurn(t, ["restoran", "jepang"])).toBeGreaterThan(0);
    expect(scoreTurn(t, ["teh", "manis"])).toBe(0);
    expect(scoreTurn(t, [])).toBe(0);
  });
});

// ── 2. Session context ─────────────────────────────────────────────────

describe("SessionContext", () => {
  test("push user+assistant; FIFO cap menggeser kursor", () => {
    const c = new SessionContext();
    for (let i = 0; i < 40; i++) {
      c.pushUser("pesan " + i);
      c.pushAssistant("balasan " + i);
    }
    expect(c.turns.length).toBe(80);
    c.summaryUpTo = 40;
    c.advanceExtract(20);
    // Banjiri melewati cap → FIFO memotong depan, kursor ikut mundur.
    for (let i = 40; i < 220; i++) {
      c.pushUser("pesan " + i);
      c.pushAssistant("balasan " + i);
    }
    expect(c.turns.length).toBe(400);
    expect(c.summaryUpTo).toBeLessThan(40);
  });

  test("pendingCompress: trigger, blok bertahap, applyCompress", () => {
    const c = new SessionContext();
    for (let i = 0; i < RECENT_WINDOW + COMPRESS_TRIGGER; i++)
      c.pushUser("pesan " + i);
    expect(c.olderCount()).toBe(COMPRESS_TRIGGER);
    const block = c.pendingCompress();
    expect(block).not.toBeNull();
    expect(block!.turns.length).toBe(COMPRESS_TRIGGER);
    c.applyCompress("ringkasan percakapan", block!.turns.length);
    expect(c.summary).toBe("ringkasan percakapan");
    expect(c.summaryUpTo).toBe(COMPRESS_TRIGGER);
    // Tidak ada giliran lama baru → tidak ada blok kedua.
    expect(c.pendingCompress()).toBeNull();
    // Blok besar dipotong per chunk.
    const c2 = new SessionContext();
    for (let i = 0; i < RECENT_WINDOW + COMPRESS_CHUNK + 30; i++)
      c2.pushUser("pesan " + i);
    const b2 = c2.pendingCompress();
    expect(b2!.turns.length).toBe(COMPRESS_CHUNK);
  });

  test("pendingExtract / advanceExtract: semua giliran sejak kursor", () => {
    const c = new SessionContext();
    c.pushUser("satu");
    c.pushAssistant("dua");
    const b = c.pendingExtract();
    expect(b.length).toBe(2);
    c.advanceExtract(b.length);
    expect(c.pendingExtract()).toEqual([]);
    // Fakta baru layak segera diekstraksi tanpa menunggu jendela penuh.
    c.pushUser("fakta baru");
    expect(c.pendingExtract().length).toBe(1);
    c.advanceExtract(1);
    expect(c.pendingExtract()).toEqual([]);
  });

  test("reset in place — referensi array tetap sama", () => {
    const c = new SessionContext();
    const ref = c.turns;
    c.pushUser("halo");
    c.applyCompress("ada", 1);
    c.reset();
    expect(c.turns.length).toBe(0);
    expect(c.summary).toBe("");
    expect(c.turns).toBe(ref);
  });
});

// ── 3. Context assembly ────────────────────────────────────────────────

describe("buildContextMessages / blok prompt", () => {
  test("potongan lama relevan disisipkan sebelum jendela, kronologis", () => {
    const turns: any[] = [];
    turns.push({ role: "user", content: "aku suka makan ramen tonkotsu" });
    turns.push({ role: "assistant", content: "ramen enak sekali" });
    for (let i = 0; i < 40; i++)
      turns.push({ role: "user", content: "topik lain nomor " + i });
    const { messages, olderUsed } = buildContextMessages(turns, "ramen tonkotsu");
    expect(olderUsed.length).toBe(2); // dua giliran ramen di awal ditemukan
    expect(messages[0].content).toContain("ramen");
    expect(messages[messages.length - 1]).toEqual(turns[turns.length - 1]);
    // Jendela terakhir selalu utuh di ekor.
    expect(messages.length).toBe(RECENT_WINDOW + olderUsed.length);
  });

  test("sessionSummaryBlock + memoryBlock", () => {
    const s = sessionSummaryBlock("user sedang bangun proyek musik", [
      { role: "user", content: "pesan lama" },
    ] as any);
    expect(s).toContain("RINGKASAN PERCAKAPAN");
    expect(s).toContain("POTONGAN LAMA YANG RELEVAN");
    expect(sessionSummaryBlock("", [])).toBe("");
    const m = memoryBlock([
      { id: "m1", text: "User alergi seafood", tags: [], ts: 0 },
    ]);
    expect(m).toContain("MEMORI JANGKA PANJANG");
    expect(m).toContain("User alergi seafood");
    expect(memoryBlock([])).toBe("");
  });
});

// ── 4. Gerbang intent (recall) ─────────────────────────────────────────

describe("looksTaskish", () => {
  test("permintaan tugas lolos gerbang (recall tinggi)", () => {
    const yes = [
      "Aku mau cari restoran Jepang yang enak di sekitar sini.",
      "Tolong cariin dokumentasi tentang WebGPU.",
      "Coba cek kenapa fitur ini error.",
      "Carikan aku beberapa opsi hosting dan bandingkan.",
      "Aku mau file ini dirapihin.",
      "tolong bikinin route baru di express",
      "please find me the docs for bun test",
      "can you fix the login bug?",
      "bandingkan dua framework ini dong",
      "aku butuh export data ke csv",
    ];
    for (const t of yes) expect(looksTaskish(t)).toBe(true);
  });

  test("obrolan biasa tidak digerbangkan (hemat panggilan)", () => {
    const no = [
      "halo apa kabar?",
      "kamu lagi ngapain?",
      "restoran favoritmu apa?",
      "wah bagus juga ya",
      "aku suka lagu ini banget",
      "kenapa ya kok bisa gitu",
      "terima kasih ya sudah mau nemenin",
      "ok",
    ];
    for (const t of no) expect(looksTaskish(t)).toBe(false);
  });
});

// ── 5. Hand-off ────────────────────────────────────────────────────────

describe("composeHandoffText / handoffAcks", () => {
  test("teks tugas membawa ringkasan + memori + giliran terakhir", () => {
    const text = composeHandoffText({
      task: "cari dokumentasi WebGPU",
      summary: "user sedang belajar rendering web",
      memoryEntries: [{ id: "m1", text: "User pakai Windows 11", tags: [], ts: 0 }],
      recentTurns: [
        { role: "user", content: "aku mau cari dokumentasi WebGPU" },
      ],
      originalText: "aku mau cari dokumentasi WebGPU",
    });
    expect(text).toContain("KONTEKS PERCAKAPAN");
    expect(text).toContain("User pakai Windows 11");
    expect(text).toContain("cari dokumentasi WebGPU");
    expect(text).toContain("JANGAN tanya ulang");
  });

  test("ack per bahasa", () => {
    expect(handoffAcks("id").ok).toContain("kerjakan");
    expect(handoffAcks("en").ok).toContain("on it");
  });
});

// ── 6. Jalur think() penuh ─────────────────────────────────────────────

const PROFILE = {
  emotions: [], nativeExpressions: [], accessories: [], properties: [],
  gestures: [], motionCatalog: [], userNote: "", sheet: null,
  roleIds: {}, paramRange: {},
} as any;

interface Captured { url: string; body: any }

function makeHarness(opts: {
  memory?: any[];
  intent?: any;
  workerBusy?: boolean;
  intentFail?: boolean;
} = {}) {
  const speakLog: Array<{ text: string }> = [];
  const chatLog: any[] = [];
  const calls: Captured[] = [];
  const chatDs: Array<(v: any) => void> = [];

  g.window = {
    __live2dAgent: {
      isReady: () => true,
      speak: (text: string, onDone?: () => void, opts2?: any) => {
        speakLog.push({ text });
        opts2?.onAudioStart?.();
        setTimeout(() => onDone?.(), 0);
        return "OK";
      },
      lockAI: () => {},
      unlockAI: () => {},
      setExpression: () => {},
      setAIPose: () => {},
      playGesture: () => {},
      playMotion: () => true,
      applyParamDrive: () => {},
      releaseParamDrive: () => {},
      getExpressibleEmotions: () => ({}),
    },
    __addChat: (role: string, text: string) => chatLog.push({ role, text }),
    __appEvents: { idleSpeak: true, quietMs: 0 },
  };
  g.document = { getElementById: () => null };

  g.fetch = async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    const ok = (v: any) => ({ ok: true, json: async () => v });
    // URUTAN PENTING: /memory/extract sebelum /memory (substring).
    if (url.includes("/api/companion/memory/extract"))
      return ok({ entries: [], added: 0 });
    if (url.includes("/api/companion/memory"))
      return ok({ entries: opts.memory ?? [] });
    if (url.includes("/api/companion/intent")) {
      if (opts.intentFail)
        return { ok: false, status: 500, json: async () => ({ error: "LLM down" }) };
      return ok(opts.intent ?? { isTask: false, task: "" });
    }
    if (url.includes("/api/companion/summarize"))
      return ok({ summary: "ringkasan sesi terkompres", ok: true });
    if (url.includes("/api/assistant/status"))
      return ok({ running: true, busy: opts.workerBusy ?? false });
    if (url.includes("/api/assistant/ask"))
      return ok({ reply: "Sudah beres, hasilnya ada di panel.", paused: false });
    if (url.includes("/api/animate-text"))
      return ok({ segments: [{ text: body?.text ?? "baik", emotion: "normal", gesture: null, motion: null }] });
    // /api/chat — deferred dikendalikan test.
    return new Promise<any>((res) => chatDs.push(res));
  };

  const brain = new AgentBrain();
  (brain as any).capProfile = PROFILE;

  return {
    brain,
    calls,
    speakLog,
    chatLog,
    resolveChat: (reply: string) => {
      const r = chatDs.shift();
      if (!r) throw new Error("tidak ada deferred /api/chat");
      r({ ok: true, json: async () => ({ reply }) });
    },
    until: async (fn: () => boolean, ms = 2000) => {
      const t0 = Date.now();
      while (!fn()) {
        if (Date.now() - t0 > ms) throw new Error("timeout menunggu kondisi");
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    tick: (ms = 0) => new Promise((r) => setTimeout(r, ms)),
  };
}

const call = (h: ReturnType<typeof makeHarness>, part: string) =>
  h.calls.filter((c) => c.url.includes(part));

describe("brain × memory/routing", () => {
  afterAll(() => {
    AgentBrain.HOUSEKEEPING_DELAY_MS = 1500;
  });

  test("chat biasa: memori + context terkirim, balasan masuk history", async () => {
    AgentBrain.HOUSEKEEPING_DELAY_MS = 60_000; // housekeeping OFF untuk test ini
    const h = makeHarness({
      memory: [{ id: "m1", text: "User alergi seafood", tags: [], ts: 0 }],
    });
    const p = h.brain.think("halo, kabar baik?");
    await h.until(() => call(h, "/api/chat").length === 1);
    h.resolveChat("Kabar baik juga!");
    await p;
    await h.tick(30);
    const chat = call(h, "/api/chat")[0];
    expect(chat.body.messages.some((m: any) => m.role === "user")).toBe(true);
    expect(chat.body.system).toContain("MEMORI JANGKA PANJANG");
    expect(chat.body.system).toContain("User alergi seafood");
    // Balasan TIDAK pernah masuk history sebelumnya — sekarang wajib.
    expect(h.brain.history.some((m) => m.role === "assistant" && m.content === "Kabar baik juga!")).toBe(true);
    // Intent tidak diadu ke LLM untuk obrolan tanpa isyarat.
    expect(call(h, "/api/companion/intent").length).toBe(0);
  });

  test("permintaan tugas ter-route ke Agent dengan konteks, tanpa /api/chat", async () => {
    AgentBrain.HOUSEKEEPING_DELAY_MS = 60_000;
    const h = makeHarness({
      memory: [{ id: "m1", text: "User pakai Windows 11", tags: [], ts: 0 }],
      intent: { isTask: true, task: "cari dokumentasi WebGPU" },
    });
    const p = h.brain.think("tolong cariin dokumentasi WebGPU dong");
    await h.until(() => call(h, "/api/assistant/ask").length === 1);
    await p;
    await h.tick(30);
    expect(call(h, "/api/chat").length).toBe(0); // tidak dijawab companion
    const ask = call(h, "/api/assistant/ask")[0].body;
    expect(ask.text).toContain("PERMINTAAN USER");
    expect(ask.text).toContain("cari dokumentasi WebGPU");
    expect(ask.text).toContain("User pakai Windows 11");
    // Ack + hasil agent diumumkan companion.
    await h.until(() => h.speakLog.some((s) => s.text.includes("Sudah beres")));
    expect(h.speakLog.some((s) => s.text.includes("kerjakan"))).toBe(true);
  });

  test("worker sedang busy → ack ramah, tidak menumpuk ask", async () => {
    AgentBrain.HOUSEKEEPING_DELAY_MS = 60_000;
    const h = makeHarness({
      intent: { isTask: true, task: "cek error build" },
      workerBusy: true,
    });
    const p = h.brain.think("coba cek kenapa build error");
    await h.until(() => h.speakLog.length > 0);
    await p;
    await h.tick(30);
    expect(call(h, "/api/assistant/ask").length).toBe(0);
    expect(h.speakLog.some((s) => s.text.includes("belum beres"))).toBe(true);
  });

  test("kalimat ber-keyword tapi intent CHAT → tetap jalur chat", async () => {
    AgentBrain.HOUSEKEEPING_DELAY_MS = 60_000;
    const h = makeHarness({
      intent: { isTask: false, task: "" },
    });
    const p = h.brain.think("carikan ... eh maksudku, kamu suka makan cari makhluk apa?");
    await h.until(() => call(h, "/api/chat").length === 1);
    h.resolveChat("Aku suka kucing!");
    await p;
    await h.tick(30);
    expect(call(h, "/api/assistant/ask").length).toBe(0);
    expect(call(h, "/api/chat").length).toBe(1);
  });

  test("housekeeping: sesi panjang terkompres jadi ringkasan bergulir", async () => {
    AgentBrain.HOUSEKEEPING_DELAY_MS = 5;
    const h = makeHarness();
    const ctx = (h.brain as any).ctx as SessionContext;
    for (let i = 0; i < RECENT_WINDOW + COMPRESS_TRIGGER; i++) {
      ctx.pushUser("topik lama " + i);
      ctx.pushAssistant("oke " + i);
    }
    const p = h.brain.think("pesan penutup");
    await h.until(() => call(h, "/api/chat").length === 1);
    h.resolveChat("siap");
    await p;
    await h.until(() => ctx.summaryUpTo > 0);
    expect(ctx.summary).toBe("ringkasan sesi terkompres");
    const sum = call(h, "/api/companion/summarize")[0].body;
    expect(sum.turns.length).toBeGreaterThan(COMPRESS_TRIGGER - 1);
    expect(sum.turns.length).toBeLessThanOrEqual(COMPRESS_CHUNK);
  });

  test("ekstraksi long-term memory tiap EXTRACT_EVERY giliran user", async () => {
    AgentBrain.HOUSEKEEPING_DELAY_MS = 5;
    const h = makeHarness();
    const ctx = (h.brain as any).ctx as SessionContext;
    for (let i = 0; i < EXTRACT_EVERY - 1; i++) ctx.pushUser("fakta penting " + i);
    const p = h.brain.think("pesan pemicu");
    await h.until(() => call(h, "/api/chat").length === 1);
    h.resolveChat("noted");
    await p;
    // 6 giliran user sejak kursor (5 pra-push + 1 think) → ekstraksi jalan.
    await h.until(() => call(h, "/api/companion/memory/extract").length === 1);
    const ex = call(h, "/api/companion/memory/extract")[0].body;
    expect(ex.turns.length).toBeGreaterThanOrEqual(EXTRACT_EVERY);
  });

  test("clearSession in place, long-term memory tidak tersentuh", async () => {
    AgentBrain.HOUSEKEEPING_DELAY_MS = 60_000;
    const h = makeHarness();
    h.brain.history.push({ role: "user", content: "x" });
    const ref = h.brain.history;
    h.brain.clearSession();
    expect(h.brain.history.length).toBe(0);
    expect(h.brain.history).toBe(ref); // array yang sama — kontrak app.js
  });

  test("lifecycle clear chat: sesi benar-benar kosong, long-term memory tetap tersedia", async () => {
    AgentBrain.HOUSEKEEPING_DELAY_MS = 60_000;
    const h = makeHarness({
      memory: [{ id: "m1", text: "User alergi seafood", tags: [], ts: 0 }],
    });
    const ctx = (h.brain as any).ctx as SessionContext;
    for (let i = 0; i < 30; i++) {
      ctx.pushUser("obrolan lama nomor " + i);
      ctx.pushAssistant("iya nomor " + i);
    }
    ctx.applyCompress("ringkasan sesi lama yang TIDAK boleh bocor setelah clear", 20);

    // Sebelum clear: ringkasan ikut di system prompt.
    let p = h.brain.think("halo");
    await h.until(() => call(h, "/api/chat").length === 1);
    h.resolveChat("oke");
    await p;
    await h.tick(20);
    expect(call(h, "/api/chat")[0].body.system).toContain("ringkasan sesi lama");

    // Clear → session context benar-benar kosong.
    h.brain.clearSession();
    expect(h.brain.history.length).toBe(0);
    expect(ctx.summary).toBe("");
    expect(ctx.summaryUpTo).toBe(0);

    // Setelah clear: TIDAK ada giliran lama, TIDAK ada ringkasan lama, tapi
    // long-term memory yang valid tetap mengalir ke prompt.
    p = h.brain.think("halo lagi nih");
    await h.until(() => call(h, "/api/chat").length === 2);
    h.resolveChat("halo juga");
    await p;
    await h.tick(20);
    const after = call(h, "/api/chat")[1].body;
    expect(after.messages.length).toBe(1); // hanya giliran baru
    expect(after.messages[0].content).toBe("halo lagi nih");
    expect(after.system).not.toContain("ringkasan sesi lama");
    expect(after.system).toContain("MEMORI JANGKA PANJANG");
    expect(after.system).toContain("User alergi seafood");
    // Writer endpoint memori tidak pernah dipanggil dengan isi sesi —
    // ringkasan tidak pernah otomatis jadi long-term memory.
    expect(
      h.calls.filter((c) => c.url.includes("/api/companion/memory") && c.body).length,
    ).toBe(0);
  });

  test("intent classifier gagal (HTTP 500) → companion tetap chat normal (fail-soft)", async () => {
    AgentBrain.HOUSEKEEPING_DELAY_MS = 60_000;
    const h = makeHarness({ intentFail: true });
    const p = h.brain.think("tolong cek ini bentar ya"); // gate lolos, LLM mati
    await h.until(() => call(h, "/api/chat").length === 1);
    h.resolveChat("Baik, aku cek!");
    await p;
    await h.tick(20);
    expect(call(h, "/api/assistant/ask").length).toBe(0);
    expect(call(h, "/api/chat").length).toBe(1);
    expect(h.speakLog.some((s) => s.text === "Baik, aku cek!")).toBe(true);
  });

  test("false-positive/ambiguous: keyword ada, tapi TIDAK di-handoff ke Agent", async () => {
    AgentBrain.HOUSEKEEPING_DELAY_MS = 60_000;
    const cases = [
      "aku bikin kopi dulu ya, sebentar", // "bikin" = kegiatan user sendiri
      "kemarin aku cek email lama-lama", // narasi masa lalu
      "bisa tolong jelaskan maksud lagu ini?", // minta penjelasan verbal
      "aku cari-cari buku lama, ternyata udah kejual", // cerita santai
      "tolong inget ya besok aku meeting pagi", // curhat/ingatan, bukan tugas kerja
    ];
    for (const text of cases) {
      const h = makeHarness({ intent: { isTask: false, task: "" } });
      const p = h.brain.think(text);
      await h.until(() => call(h, "/api/chat").length === 1);
      h.resolveChat("oh iya, lalu?");
      await p;
      await h.tick(10);
      expect(call(h, "/api/assistant/ask").length).toBe(0);
      expect(call(h, "/api/chat").length).toBe(1);
    }
  });

  test("sesi sangat panjang: fakta awal tetap ditemukan via retrieval + ringkasan", () => {
    const ctx = new SessionContext();
    ctx.pushUser("kode rahasia proyekku adalah LAZ-7742, catat baik-baik");
    ctx.pushAssistant("oke, kucatat baik-baik!");
    for (let i = 0; i < 150; i++) {
      ctx.pushUser("obrolan basa-basi nomor " + i + " tentang cuaca dan musik");
      ctx.pushAssistant("hehe iya betul");
    }
    // Kompresi berulang (simulasi housekeeping bertahap) sampai tidak ada lagi.
    let guard = 0;
    for (;;) {
      const block = ctx.pendingCompress();
      if (!block || guard++ > 50) break;
      ctx.applyCompress("ringkasan: user mengobrol santai soal cuaca dan musik", block.turns.length);
    }
    expect(ctx.summaryUpTo).toBeGreaterThan(0);
    const { messages, olderUsed } = buildContextMessages(
      ctx.turns,
      "ingat nggak kode rahasia proyekku?",
    );
    // Fakta dari giliran PERTAMA ditemukan kembali lewat retrieval.
    expect(olderUsed.some((t) => t.content.includes("LAZ-7742"))).toBe(true);
    expect(messages.some((m) => m.content.includes("LAZ-7742"))).toBe(true);
    // Ringkasan tetap terpisah dan giliran terakhir tetap utuh di ekor.
    expect(messages[messages.length - 1].content).toContain("hehe iya betul");
  });
});
