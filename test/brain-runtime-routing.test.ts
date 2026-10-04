/**
 * brain-runtime-routing.test.ts — TAHAP A migrasi: output Animation Director
 * diarahkan ke Character Runtime DI BELAKANG TOGGLE (default MATI, perilaku
 * legacy tidak berubah).
 *
 * Yang diuji:
 *   1. resolveCharacterRuntime (fungsi murni): toggle nyala + runtime
 *      ter-attach → runtime; selain itu null (legacy). Toggle yang melempar
 *      pun dianggap legacy (speech tidak boleh mati karena runtime).
 *   2. skipDirectorOutputs di applyActions: pose/aksesori/property defensif
 *      tetap jalan, keluaran director (emotion/motion/paramDrive/gesture)
 *      dilewati.
 *   3. Jalur think() penuh (pola companion-concurrency.test.ts):
 *      - toggle nyala → keluaran director jadi intent yang di-submit ke
 *        runtime, apply legacy untuk bidang itu dilewati, speech tetap jalan.
 *      - toggle mati (default) → tanpa submit, legacy jalan persis seperti
 *        dulu.
 *      - submit melempar → fail-safe: apply legacy untuk segmen itu, speech
 *        TETAP jalan.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { AgentBrain, resolveCharacterRuntime } from "../src/client/agent/brain";

const g = globalThis as any;
const ORIG = { window: g.window, document: g.document, fetch: g.fetch };
afterAll(() => {
  g.window = ORIG.window;
  g.document = ORIG.document;
  g.fetch = ORIG.fetch;
});

const PROFILE = {
  emotions: [],
  nativeExpressions: [],
  accessories: [],
  properties: [],
  gestures: [],
  motionCatalog: [],
  userNote: "",
  sheet: null,
  roleIds: {},
  paramRange: {},
} as any;

/** Runtime palsu: merekam submit; bisa dipaksa melempar (uji fail-safe). */
function makeFakeRuntime(opts: { throwOnSubmit?: boolean } = {}) {
  const submits: any[] = [];
  return {
    submits,
    submit(intent: any) {
      if (opts.throwOnSubmit) throw new Error("bridge meledak");
      submits.push(intent);
      return { mode: "overlay", reason: "tes", intentId: intent.id };
    },
  };
}

function makeHarness(routing: { on?: boolean; runtime?: any } = {}) {
  const speakLog: Array<{ text: string; onDone?: () => void; opts?: any }> = [];
  const legacy = {
    setExpression: [] as any[],
    playGesture: [] as any[],
    playMotion: [] as any[],
    applyParamDrive: [] as any[],
    setAIPose: [] as any[],
    setAccessory: [] as any[],
  };
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
      setAIPose: (...a: any[]) => legacy.setAIPose.push(a),
      setExpression: (...a: any[]) => legacy.setExpression.push(a),
      playMotion: (...a: any[]) => {
        legacy.playMotion.push(a);
        return false;
      },
      playGesture: (...a: any[]) => {
        legacy.playGesture.push(a);
        return true;
      },
      setAccessory: (...a: any[]) => legacy.setAccessory.push(a),
      applyParamDrive: (...a: any[]) => legacy.applyParamDrive.push(a),
      // Seam TAHAP A (bridge production di app.js): toggle + runtime.
      isRuntimeRouting: () => routing.on === true,
      getCharacterRuntime: () => routing.runtime ?? null,
    },
    __addChat: () => {},
    __appEvents: { idleSpeak: true, quietMs: 0 },
  };
  g.document = { getElementById: () => null };

  const chatDs: Array<{ promise: Promise<any>; resolve: (v: any) => void }> = [];
  g.fetch = async (url: string) => {
    // Endpoint companion memory/intent (fitur 2026-10-04): jawaban netral
    // (tanpa memori, intent chat) — alur think() lama tetap yang diuji.
    if (url.includes("/api/companion/memory")) {
      return { ok: true, json: async () => ({ entries: [] }) };
    }
    if (url.includes("/api/companion/intent")) {
      return { ok: true, json: async () => ({ isTask: false, task: "" }) };
    }
    if (url.includes("/api/animate-text")) {
      // Satu segmen director: emosi + gesture (tanpa motion/paramDrive).
      return {
        ok: true,
        json: async () => ({
          segments: [
            { text: "Hai ada apa?", emotion: "senang", gesture: "nod", motion: null },
          ],
        }),
      };
    }
    // /api/chat — dikendalikan test (deferred).
    let resolve!: (v: any) => void;
    const promise = new Promise<any>((res) => {
      resolve = res;
    });
    chatDs.push({ promise, resolve });
    return promise;
  };

  const brain = new AgentBrain();
  (brain as any).capProfile = PROFILE; // skip loadProfile di jalur think

  return {
    brain,
    speakLog,
    legacy,
    get locks() {
      return locks;
    },
    get unlocks() {
      return unlocks;
    },
    resolveChat: (i: number) =>
      chatDs[i].resolve({ ok: true, json: async () => ({ reply: "Balasan dari LLM." }) }),
    settle: () => new Promise((r) => setTimeout(r, 5)),
  };
}

describe("resolveCharacterRuntime — keputusan route (murni)", () => {
  test("toggle mati → null (legacy) walau runtime ada", () => {
    const rt = makeFakeRuntime();
    const agent = { isRuntimeRouting: () => false, getCharacterRuntime: () => rt };
    expect(resolveCharacterRuntime(agent)).toBe(null);
  });

  test("toggle nyala + runtime ter-attach → runtime", () => {
    const rt = makeFakeRuntime();
    const agent = { isRuntimeRouting: () => true, getCharacterRuntime: () => rt };
    expect(resolveCharacterRuntime(agent)).toBe(rt);
  });

  test("toggle nyala tanpa runtime → null (belum ter-attach)", () => {
    const agent = { isRuntimeRouting: () => true, getCharacterRuntime: () => null };
    expect(resolveCharacterRuntime(agent)).toBe(null);
    const tanpaGetter = { isRuntimeRouting: () => true };
    expect(resolveCharacterRuntime(tanpaGetter)).toBe(null);
  });

  test("toggle melempar → null (fail-safe, jangan matikan speech)", () => {
    const agent = {
      isRuntimeRouting: () => {
        throw new Error("bridge belum siap");
      },
      getCharacterRuntime: () => makeFakeRuntime(),
    };
    expect(resolveCharacterRuntime(agent)).toBe(null);
  });
});

describe("applyActions skipDirectorOutputs — bidang defensif tetap jalan", () => {
  test("pose/aksesori/property di-apply, keluaran director dilewati", () => {
    const h = makeHarness({});
    (h.brain as any).applyActions(
      {
        emotion: "senang",
        gesture: "nod",
        motion: "wave",
        paramDrive: { ParamA: 1 },
        head: { x: 5, y: 5 },
        accessories: { AccGlasses: 1 },
        property: "accessory",
      } as any,
      0,
      "teks",
      { skipDirectorOutputs: true },
    );
    expect(h.legacy.playGesture.length).toBe(0);
    expect(h.legacy.playMotion.length).toBe(0);
    expect(h.legacy.applyParamDrive.length).toBe(0);
    expect(
      h.legacy.setExpression.some((a: any[]) => a[0] === "user:senang"),
    ).toBe(false);
    // Bidang defensif (bukan keluaran director) tetap jalan.
    expect(h.legacy.setAIPose.length).toBe(1);
    expect(h.legacy.setAccessory.length).toBe(1);
    expect(h.legacy.setExpression.some((a: any[]) => a[0] === "accessory")).toBe(true);
  });
});

describe("TAHAP A routing di playSegments dua-fase (reaksi vs speech)", () => {
  test("toggle nyala → reaksi langsung, intent deferred ke onAudioStart", async () => {
    const rt = makeFakeRuntime();
    const h = makeHarness({ on: true, runtime: rt });
    const p = h.brain.think("Halo");
    await h.settle();
    expect(h.speakLog.length).toBe(0); // chat masih menunggu
    h.resolveChat(0);
    await h.settle(); // director pass (fetch langsung terjawab) → playSegments

    // Speech tidak berubah: satu segmen tetap diputar kelas companion.
    expect(h.speakLog.length).toBe(1);
    expect(h.speakLog[0].text).toBe("Hai ada apa?");
    expect(h.speakLog[0].opts?.cls).toBe("companion");
    expect(h.locks).toBe(1);
    expect(typeof h.speakLog[0].opts?.onAudioStart).toBe("function");

    // PRE-SPEECH: reaksi legacy langsung (expression), intent BELUM di-submit.
    expect(h.legacy.setExpression.length).toBe(1);
    expect(h.legacy.setExpression[0][0]).toBe("user:senang");
    expect(rt.submits.length).toBe(0);
    expect(h.legacy.playGesture.length).toBe(0);
    expect(h.legacy.playMotion.length).toBe(0);

    // SPEECH: audio mulai → intent di-submit, legacy motion/gesture tetap dilewati.
    h.speakLog[0].opts?.onAudioStart?.();
    expect(rt.submits.length).toBe(2);
    expect(rt.submits[0]).toMatchObject({
      kind: "expression",
      id: "senang",
      domains: ["affect"],
      source: "director",
    });
    expect(rt.submits[1]).toMatchObject({
      kind: "action",
      id: "nod",
      domains: ["head", "body"],
      source: "director",
    });
    expect(typeof rt.submits[1].durationMs).toBe("number");
    expect(h.legacy.playGesture.length).toBe(0);
    expect(h.legacy.playMotion.length).toBe(0);
    expect(h.legacy.applyParamDrive.length).toBe(0);

    // Jangan biarkan timer chain hidup sampai test berikutnya.
    h.speakLog[0].onDone?.();
    await new Promise((r) => setTimeout(r, 200));
    expect(h.unlocks).toBe(1);
    await p;
  });

  test("toggle mati (default) → reaksi langsung, speech-motion deferred", async () => {
    const rt = makeFakeRuntime();
    const h = makeHarness({ on: false, runtime: rt });
    const p = h.brain.think("Halo");
    await h.settle();
    h.resolveChat(0);
    await h.settle();

    expect(rt.submits.length).toBe(0); // runtime tidak pernah disentuh
    // PRE-SPEECH: emosi langsung (reaksi), gesture DITUNDA sampai audio.
    expect(h.legacy.setExpression.length).toBe(1);
    expect(h.legacy.setExpression[0][0]).toBe("user:senang");
    expect(h.legacy.playGesture.length).toBe(0);
    // Speech tetap sama.
    expect(h.speakLog.length).toBe(1);
    expect(h.speakLog[0].text).toBe("Hai ada apa?");

    // SPEECH: audio mulai → gesture jalan.
    h.speakLog[0].opts?.onAudioStart?.();
    expect(h.legacy.playGesture.length).toBe(1);
    expect(h.legacy.playGesture[0][0]).toBe("nod");

    h.speakLog[0].onDone?.();
    await new Promise((r) => setTimeout(r, 200));
    expect(h.unlocks).toBe(1);
    await p;
  });

  test("submit melempar → reaksi tetap jalan, fallback legacy saat audio", async () => {
    const rt = makeFakeRuntime({ throwOnSubmit: true });
    const h = makeHarness({ on: true, runtime: rt });
    const p = h.brain.think("Halo");
    await h.settle();
    h.resolveChat(0);
    await h.settle();

    // PRE-SPEECH: reaksi legacy tetap tampil walau runtime akan gagal nanti.
    expect(h.legacy.setExpression.length).toBe(1);
    expect(h.legacy.playGesture.length).toBe(0);
    expect(rt.submits.length).toBe(0);
    // Speech TIDAK mati karena runtime.
    expect(h.speakLog.length).toBe(1);
    expect(h.speakLog[0].text).toBe("Hai ada apa?");

    // SPEECH: submit gagal → fallback legacy speechOnly (gesture jalan).
    h.speakLog[0].opts?.onAudioStart?.();
    expect(rt.submits.length).toBe(0); // submit gagal sebelum merekam
    expect(h.legacy.playGesture.length).toBe(1);

    h.speakLog[0].onDone?.();
    await new Promise((r) => setTimeout(r, 200));
    expect(h.unlocks).toBe(1);
    await p;
  });
});
