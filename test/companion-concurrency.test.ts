/**
 * companion-concurrency.test.ts — Fase 3 rework arsitektur (§6, §32–34
 * ARSITEKTUR-TARGET): MERGE saat thinking, stale/generation protection,
 * epoch model-load, precedence proactive vs input user.
 *
 * Harness: AgentBrain diinstansiasi langsung (pola llm-roles.test.ts);
 * window/document/fetch di-mock per-harness dan DIPULIHKAN di afterAll
 * (bun test berbagi satu proses). fetch mock = deferred yang dikendalikan
 * test; balasan memakai directive ([EMOTION:…]) supaya Pass-2 director
 * tidak menambah fetch baru.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { AgentBrain } from "../src/client/agent/brain";

type Deferred = {
  promise: Promise<any>;
  resolve: (v: any) => void;
  reject: (e: any) => void;
};
const defer = (): Deferred => {
  let resolve!: (v: any) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<any>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const g = globalThis as any;
const ORIG = { window: g.window, document: g.document, fetch: g.fetch };
const ORIG_TIMEOUT = AgentBrain.REQUEST_TIMEOUT_MS;
afterAll(() => {
  g.window = ORIG.window;
  g.document = ORIG.document;
  g.fetch = ORIG.fetch;
  AgentBrain.REQUEST_TIMEOUT_MS = ORIG_TIMEOUT;
});

const PROFILE = {
  emotions: ["senang", "normal"],
  nativeExpressions: [],
  accessories: [],
  properties: [],
  gestures: ["nod"],
  motionCatalog: [],
  userNote: "",
  sheet: null,
  roleIds: {},
  paramRange: {},
} as any;

function makeHarness(
  opts: {
    rejectOnAbort?: boolean;
    /** Respons /api/mode untuk gate proactive (§17–18). */
    mode?: { active: string; assistant?: { busy?: boolean } };
    /** /api/mode melempar → uji fail-open. */
    modeFails?: boolean;
    /** Jeda sebelum /api/mode dijawab → uji think menggulingkan gate. */
    modeDelay?: number;
    /** Keadaan toggle #toggle-brain (default: nyala). */
    brainOn?: boolean;
  } = {},
) {
  const calls: Array<{ url: string; init?: any; d: Deferred }> = [];
  const speakLog: Array<{ text: string; onDone?: () => void; opts?: any }> = [];
  const chatLog: Array<{ role: string; text: string }> = [];
  const capsDeferreds: Deferred[] = [];
  let locks = 0;
  let unlocks = 0;

  g.window = {
    __live2dAgent: {
      isReady: () => true,
      speak: (text: string, onDone?: () => void, opts?: any) =>
        speakLog.push({ text, onDone, opts }),
      lockAI: () => {
        locks++;
      },
      unlockAI: () => {
        unlocks++;
      },
      setGazeIntent: () => {},
      setAIPose: () => {},
      setExpression: () => {},
      playMotion: () => false,
      playGesture: () => false,
      setAccessory: () => {},
      getCapabilityProfile: () => {
        const d = defer();
        capsDeferreds.push(d);
        return d.promise;
      },
    },
    __addChat: (role: string, text: string) => chatLog.push({ role, text }),
    __appEvents: { idleSpeak: true, quietMs: 0 },
  };
  g.document = {
    // Gate proactive membaca toggle Mode Otak dari DOM — elemen yang sama
    // dengan submitUtterance di app.js.
    getElementById: (id: string) =>
      id === "toggle-brain" ? { checked: opts.brainOn ?? true } : null,
  };
  g.fetch = async (url: string, init?: any) => {
    // Endpoint companion memory/intent (fitur 2026-10-04): dijawab netral —
    // tanpa memori, intent chat — supaya alur think() identik dengan dulu.
    if (url.includes("/api/companion/memory/extract"))
      return { ok: true, json: async () => ({ entries: [], added: 0 }) };
    if (url.includes("/api/companion/memory"))
      return { ok: true, json: async () => ({ entries: [] }) };
    if (url.includes("/api/companion/intent"))
      return { ok: true, json: async () => ({ isTask: false, task: "" }) };
    if (url.includes("/api/mode")) {
      if (opts.modeFails) throw new Error("server restart");
      if (opts.modeDelay) await new Promise((r) => setTimeout(r, opts.modeDelay));
      const mode =
        opts.mode ?? { active: "stage", assistant: { busy: false } };
      return { ok: true, json: async () => mode };
    }
    // Pass-2 director (selalu dipakai untuk reply 1-segmen) dijawab otomatis
    // supaya tiap balasan chat = tepat satu fetch /api/chat yang dikendalikan
    // test.
    if (url.includes("/api/animate-text")) {
      return {
        ok: true,
        json: async () => ({ emotion: "normal", gesture: null, motion: null }),
      };
    }
    const d = defer();
    calls.push({ url, init, d });
    if (opts.rejectOnAbort && init?.signal) {
      init.signal.addEventListener("abort", () =>
        d.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    }
    return d.promise;
  };

  const brain = new AgentBrain();
  (brain as any).capProfile = PROFILE; // skip loadProfile di jalur think

  return {
    brain,
    calls,
    speakLog,
    chatLog,
    capsDeferreds,
    get locks() {
      return locks;
    },
    get unlocks() {
      return unlocks;
    },
    chatCalls: () => calls.filter((c) => c.url.includes("/api/chat")),
    resolveChat: (i: number, reply: string) =>
      calls[i].d.resolve({ ok: true, json: async () => ({ reply }) }),
    tick: (ms = 0) => new Promise((r) => setTimeout(r, ms)),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

/** Selesaikan seluruh chain segmen: panggil onDone tiap segmen sampai
 *  tidak ada segmen baru (jeda antar segmen 180ms). */
async function drainChain(h: ReturnType<typeof makeHarness>) {
  let i = 0;
  for (;;) {
    h.speakLog[i]?.onDone?.();
    const before = h.speakLog.length;
    await h.tick(200);
    if (h.speakLog.length === before || i++ > 10) break;
  }
}

describe("§6 MERGE — pesan baru saat masih mikir", () => {
  test("request lama di-abort, dua teks masuk satu fetch, satu balasan", async () => {
    const h = makeHarness();
    const b = h.brain as any;
    const p1 = h.brain.think("Pesan A");
    await settle();
    expect(h.chatCalls().length).toBe(1);

    b.think("Pesan B"); // pesan baru SAAT masih mikir
    await settle();
    expect(h.chatCalls().length).toBe(2); // bukan 3 — tidak ada fetch ganda
    expect(h.calls[0].init.signal.aborted).toBe(true); // fetch lama dibatalkan

    const body = JSON.parse(h.calls[1].init.body);
    expect(body.messages.map((m: any) => m.content)).toEqual([
      "Pesan A",
      "Pesan B",
    ]); // A+B berurutan di satu request (merge stateless)

    // Balasan telat dari fetch lama (nekat balik setelah abort) → dibuang.
    h.resolveChat(0, "[EMOTION:senang] Balasan STALE yang telat.");
    await settle();
    expect(h.speakLog.some((s) => s.text.includes("STALE"))).toBe(false);
    expect(h.chatLog.some((c) => c.text.includes("STALE"))).toBe(false);

    // Balasan fetch baru → satu-satunya yang diputar.
    h.resolveChat(1, "[EMOTION:senang] Balasan GABUNGAN untuk keduanya.");
    await settle();
    expect(h.speakLog.filter((s) => s.text.includes("GABUNGAN")).length).toBe(1);
    for (const s of h.speakLog) s.onDone?.(); // selesaikan chain
    await h.tick(200); // jeda antar segmen 180ms
    expect(b.busy).toBe(false); // hanya generasi terbaru yang me-reset
    expect(b._reactiveState().gen).toBe(2);
    // Tidak ada pesan error fallback — merge bukan error.
    expect(h.chatLog.some((c) => c.text.includes("Maaf, aku"))).toBe(false);
    await p1;
  });

  test("race double-entry mati: busy diset sinkron sebelum await", async () => {
    const h = makeHarness();
    const b = h.brain as any;
    b.think("Pertama");
    b.think("Kedua"); // satu tick, tanpa jeda — dulu bisa lolos bareng
    await settle();
    // Retrieve memori menambah satu await sebelum fetch chat: think pertama
    // kini gugur di gen-guard SEBELUM fetch chat dimulai (tidak ada request
    // sia-sia yang di-abort) — tetap SATU fetch menjawab KEDUA teks.
    expect(h.chatCalls().length).toBe(1);
    expect((b.busy = b.busy)).toBe(true); // masih thinking
    h.resolveChat(0, "[EMOTION:senang] jawaban final.");
    await settle();
    const body = JSON.parse(h.chatCalls()[0].init.body);
    expect(body.messages.some((m: any) => m.content === "Pertama")).toBe(true);
    expect(body.messages.some((m: any) => m.content === "Kedua")).toBe(true);
    expect(h.speakLog.some((s) => s.text.includes("harus dibuang"))).toBe(false);
    expect(h.speakLog.some((s) => s.text.includes("jawaban final"))).toBe(true);
  });
});

describe("§18 precedence — proactive tunduk pada input user", () => {
  test("reactEvent saat think busy → skip; think menggulingkan reactEvent", async () => {
    const h = makeHarness();
    const b = h.brain as any;
    b.think("Pertanyaan user");
    await settle();
    expect(h.chatCalls().length).toBe(1);

    // Event proactive datang saat user thinking → tidak boleh ada fetch baru.
    b.reactEvent("idle");
    await settle();
    expect(h.chatCalls().length).toBe(1);

    // Sebaliknya: reactEvent jalan duluan → think user menggulingkannya.
    const h2 = makeHarness();
    const b2 = h2.brain as any;
    b2.reactEvent("idle");
    await settle();
    expect(h2.chatCalls().length).toBe(1);
    b2.think("Halo, tanya sesuatu");
    await settle();
    expect(h2.chatCalls().length).toBe(2);
    expect(h2.calls[0].init.signal.aborted).toBe(true);
    h2.resolveChat(0, "[EMOTION:senang] balasan event yang telat.");
    h2.resolveChat(1, "[EMOTION:senang] balasan untuk user.");
    await settle();
    expect(h2.speakLog.some((s) => s.text.includes("balasan event"))).toBe(false);
    expect(h2.speakLog.some((s) => s.text.includes("balasan untuk user"))).toBe(true);
    expect(h2.chatLog.some((c) => c.text.includes("Maaf, aku"))).toBe(false);
  });
});

describe("§32 timeout — request menggantung tidak membekukan brain", () => {
  test("lewat batas waktu → fallback diucapkan, busy lepas", async () => {
    AgentBrain.REQUEST_TIMEOUT_MS = 15; // dipulihkan afterAll
    const h = makeHarness({ rejectOnAbort: true });
    const b = h.brain as any;
    b.think("Pertanyaan yang menjemput");
    await h.tick(60); // biarkan timeout meledak
    expect(h.chatLog.some((c) => c.text.includes("Maaf, aku"))).toBe(true);
    expect(b.busy).toBe(false);
    expect(h.speakLog.some((s) => s.opts?.cls === "companion")).toBe(true);
  });
});

describe("§34 epoch — profil model lama tidak menimpa model baru", () => {
  test("loadProfile selesai setelah invalidate → hasil dibuang", async () => {
    const h = makeHarness();
    const b = h.brain as any;
    b.capProfile = null; // paksa jalur loadProfile
    const p = b.loadProfile();
    await settle();
    expect(h.capsDeferreds.length).toBe(1);
    b.invalidateCapabilityProfile(); // model berganti di tengah menunggu
    h.capsDeferreds[0].resolve(PROFILE); // profil model LAMA telat datang
    await p;
    expect(b.capProfile).toBe(null); // tidak menimpa — epoch sudah berganti

    // Load berikutnya (model baru) minta profil segar.
    const p2 = b.loadProfile();
    await settle();
    expect(h.capsDeferreds.length).toBe(2);
    h.capsDeferreds[1].resolve(PROFILE);
    await p2;
    expect(b.capProfile).toEqual(PROFILE);
  });
});

describe("§17–18 policy gate proactive", () => {
  test("mode aktif vtuber → event idle ditekan, tanpa LLM/speech, busy lepas", async () => {
    const h = makeHarness({ mode: { active: "vtuber", assistant: { busy: false } } });
    await h.brain.reactEvent("idle");
    await settle();
    expect(h.chatCalls().length).toBe(0);
    expect(h.speakLog.length).toBe(0);
    expect((h.brain as any).busy).toBe(false);
  });

  test("worker task berjalan (assistant.busy) → ditekan walau mode stage", async () => {
    const h = makeHarness({ mode: { active: "stage", assistant: { busy: true } } });
    await h.brain.reactEvent("idle");
    await settle();
    expect(h.chatCalls().length).toBe(0);
    expect(h.speakLog.length).toBe(0);
    expect((h.brain as any).busy).toBe(false);
  });

  test("Mode Otak mati → ditekan walau mode stage & worker idle (§18 Brain OFF)", async () => {
    const h = makeHarness({ brainOn: false });
    await h.brain.reactEvent("idle");
    await settle();
    expect(h.chatCalls().length).toBe(0);
    expect((h.brain as any).busy).toBe(false);
  });

  test("semua lolos → event jalan; bicara bersambung kelas companion_proactive (tier 1)", async () => {
    const h = makeHarness(); // stage + worker idle + brain nyala
    const p = h.brain.reactEvent("idle");
    await settle();
    expect(h.chatCalls().length).toBe(1);
    h.resolveChat(0, "[EMOTION:senang] Hai, lama tidak bicara!");
    await settle();
    expect(h.speakLog.length).toBe(1);
    expect(h.speakLog[0].opts?.cls).toBe("companion_proactive");
    await drainChain(h);
    expect((h.brain as any).busy).toBe(false);
    await p;
  });

  test("/api/mode tak terbaca → fail-open (event tetap boleh jalan)", async () => {
    const h = makeHarness({ modeFails: true });
    const p = h.brain.reactEvent("idle");
    await settle();
    expect(h.chatCalls().length).toBe(1);
    h.resolveChat(0, "[EMOTION:normal] Tetap jalan.");
    await settle();
    expect(h.speakLog.length).toBe(1);
    await drainChain(h);
    await p;
  });

  test("think datang saat gate masih menunggu → think menang, event senyap", async () => {
    const h = makeHarness({ modeDelay: 150 });
    const b = h.brain as any;
    b.reactEvent("idle"); // gate menunggu /api/mode 150ms
    await settle();
    expect(h.chatCalls().length).toBe(0); // belum sampai LLM
    b.think("Pesan user penting"); // datang di tengah gate → gen naik
    await settle();
    expect(h.chatCalls().length).toBe(1); // hanya fetch think
    expect(JSON.parse(h.calls[0].init.body).messages.at(-1).content).toBe(
      "Pesan user penting",
    );
    h.resolveChat(0, "[EMOTION:senang] Balasan untuk user.");
    await settle();
    expect(h.speakLog.some((s) => s.text.includes("Balasan untuk user"))).toBe(true);
    expect(h.speakLog.every((s) => s.opts?.cls !== "companion_proactive")).toBe(true);
    await drainChain(h);
    expect(b.busy).toBe(false);
    expect(b._reactiveState().gen).toBe(2);
  });
});

describe("selesai alami — kontrak chain tidak regresi (Fase 2)", () => {
  test("satu think penuh: reply diputar, lockAI/unlockAI seimbang", async () => {
    const h = makeHarness();
    const b = h.brain as any;
    const p = h.brain.think("Hai apa kabar?");
    await settle();
    expect(h.chatCalls().length).toBe(1);
    h.resolveChat(0, "[EMOTION:senang] Hai juga! Kabar baik nih.");
    await settle();
    expect(h.locks).toBe(1);
    expect(h.speakLog.length).toBe(1);
    expect(h.speakLog[0].opts?.cls).toBe("companion");
    // Balasan dua kalimat dipecah per segmen — drain semuanya sampai akhir
    // chain (unlockAI sekali-saja, kontrak Fase 2).
    await drainChain(h);
    expect(h.unlocks).toBe(1); // unlock SEKALI di akhir chain
    expect(b.busy).toBe(false);
    expect(b._reactiveState().gen).toBe(1);
    await p;
  });
});
