/**
 * speech-motion-sync.test.ts — Dua fase sinkronisasi motion↔audio.
 *
 * Kontrak yang dijaga:
 * 1. PRE-SPEECH: applyActions(reactionOnly) langsung — expression/pose/
 *    paramDrive jalan SEGERA (karakter hidup saat TTS loading), motion/
 *    gesture TIDAK jalan.
 * 2. SPEECH: applyActions(speechOnly) hanya dari onAudioStart — motion/
 *    gesture jalan saat audio benar-benar bunyi, bukan saat speak() dipanggil.
 * 3. playSegments: tiap segmen mengikuti audio-start-nya sendiri; preempt
 *    sebelum audio → motion tidak jalan; SUPPRESS → chain maju (tidak bocor).
 * 4. estimateSpeechMs tetap boleh untuk fitToMs, bukan jangkar mulai.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { AgentBrain } from "../src/client/agent/brain";
import { estimateSpeechMs } from "../src/shared/speech-timing";

const g = globalThis as any;
const ORIG = { window: g.window, document: g.document, fetch: g.fetch };
afterAll(() => {
  g.window = ORIG.window;
  g.document = ORIG.document;
  g.fetch = ORIG.fetch;
});

function makeHarness() {
  const speakLog: Array<{ text: string; onDone?: () => void; opts?: any }> = [];
  const legacy = {
    setExpression: [] as any[],
    setAIPose: [] as any[],
    playMotion: [] as any[],
    playGesture: [] as any[],
    applyParamDrive: [] as any[],
  };
  let locks = 0;
  let unlocks = 0;
  g.window = {
    __live2dAgent: {
      isReady: () => true,
      speak: (text: string, onDone?: () => void, opts?: any) => {
        speakLog.push({ text, onDone, opts });
        return "ALLOW";
      },
      lockAI: () => locks++,
      unlockAI: () => unlocks++,
      setGazeIntent: () => {},
      setAIPose: (...a: any[]) => legacy.setAIPose.push(a),
      setExpression: (...a: any[]) => legacy.setExpression.push(a),
      getExpressibleEmotions: () => ({ senang: "native" }),
      playMotion: (...a: any[]) => {
        legacy.playMotion.push(a);
        return true;
      },
      playGesture: (...a: any[]) => {
        legacy.playGesture.push(a);
        return true;
      },
      applyParamDrive: (...a: any[]) => legacy.applyParamDrive.push(a),
      releaseParamDrive: () => {},
      isRuntimeRouting: () => false,
      getCharacterRuntime: () => null,
    },
    __addChat: () => {},
    __appEvents: { idleSpeak: true, quietMs: 0 },
  };
  g.document = { getElementById: () => null };
  g.fetch = async () => ({ ok: true, json: async () => ({ segments: [] }) });
  return { brain: new AgentBrain(), speakLog, legacy, get locks() { return locks; }, get unlocks() { return unlocks; } };
}

describe("applyActions dua fase", () => {
  test("reactionOnly: expression/pose/paramDrive jalan, motion/gesture tidak", () => {
    const h = makeHarness();
    (h.brain as any).applyActions(
      { emotion: "senang", head: { x: 5, y: 5 }, motion: "m1", gesture: "g1", paramDrive: { P1: 1 } } as any,
      0, "halo", { reactionOnly: true },
    );
    expect(h.legacy.setExpression.length).toBe(1);
    expect(h.legacy.setAIPose.length).toBe(1);
    expect(h.legacy.applyParamDrive.length).toBe(1);
    expect(h.legacy.playMotion.length).toBe(0);
    expect(h.legacy.playGesture.length).toBe(0);
  });

  test("speechOnly: hanya motion/gesture, tanpa expression/pose/paramDrive", () => {
    const h = makeHarness();
    (h.brain as any).applyActions(
      { emotion: "senang", head: { x: 5, y: 5 }, motion: "m1", gesture: "g1", paramDrive: { P1: 1 } } as any,
      0, "halo halo halo", { speechOnly: true },
    );
    expect(h.legacy.setExpression.length).toBe(0);
    expect(h.legacy.setAIPose.length).toBe(0);
    expect(h.legacy.applyParamDrive.length).toBe(0);
    expect(h.legacy.playMotion.length).toBe(1);
    // fitToMs tetap dihitung dari estimasi (bukan jangkar mulai).
    expect(h.legacy.playMotion[0][1].fitToMs).toBe(estimateSpeechMs("halo halo halo"));
    expect(h.legacy.playGesture.length).toBe(1);
  });

  test("default (tanpa flag): penuh untuk jalur visual-tanpa-audio", () => {
    const h = makeHarness();
    (h.brain as any).applyActions(
      { emotion: "senang", motion: "m1", gesture: "g1" } as any, 0, "halo",
    );
    expect(h.legacy.setExpression.length).toBe(1);
    expect(h.legacy.playMotion.length).toBe(1);
    expect(h.legacy.playGesture.length).toBe(1);
  });
});

describe("playSegments mengikuti audio-start masing-masing", () => {
  test("TTS lambat: motion tidak jalan sebelum onAudioStart", () => {
    const h = makeHarness();
    const segs = [
      { text: "Halo, apa kabar?", actions: { emotion: "senang", motion: "m1", gesture: "g1" } },
    ] as any;
    (h.brain as any).playSegments(segs, "companion");
    // PRE-SPEECH langsung.
    expect(h.locks).toBe(1);
    expect(h.legacy.setExpression.length).toBe(1);
    expect(h.legacy.playMotion.length).toBe(0);
    expect(h.legacy.playGesture.length).toBe(0);
    expect(h.speakLog.length).toBe(1);
    // Simulasi TTS lambat: audio baru mulai 10 dtk kemudian.
    expect(typeof h.speakLog[0].opts?.onAudioStart).toBe("function");
    h.speakLog[0].opts.onAudioStart();
    expect(h.legacy.playMotion.length).toBe(1);
    expect(h.legacy.playGesture.length).toBe(1);
    h.speakLog[0].onDone?.();
    return new Promise<void>((r) => setTimeout(() => {
      expect(h.unlocks).toBe(1);
      r();
    }, 200));
  });

  test("multi-segmen: segmen-2 tidak jalan sebelum audio-2 mulai", async () => {
    const h = makeHarness();
    const segs = [
      { text: "Pertama.", actions: { emotion: "senang", motion: "m1" } },
      { text: "Kedua.", actions: { emotion: "senang", motion: "m2" } },
    ] as any;
    (h.brain as any).playSegments(segs, "companion");
    expect(h.speakLog.length).toBe(1);
    expect(h.legacy.playMotion.length).toBe(0);
    // Audio segmen-1 mulai → motion m1.
    h.speakLog[0].opts.onAudioStart();
    expect(h.legacy.playMotion.length).toBe(1);
    expect(h.legacy.playMotion[0][0]).toBe("m1");
    // Selesai segmen-1 → segmen-2 reaksi, tapi motion m2 belum.
    h.speakLog[0].onDone?.();
    await new Promise((r) => setTimeout(r, 210));
    expect(h.speakLog.length).toBe(2);
    expect(h.legacy.playMotion.length).toBe(1);
    // Audio segmen-2 mulai → motion m2.
    h.speakLog[1].opts.onAudioStart();
    expect(h.legacy.playMotion.length).toBe(2);
    expect(h.legacy.playMotion[1][0]).toBe("m2");
    h.speakLog[1].onDone?.();
    await new Promise((r) => setTimeout(r, 210));
    expect(h.unlocks).toBe(1);
  });

  test("preempt sebelum audio → motion tidak pernah jalan, lock dilepas", async () => {
    const h = makeHarness();
    const segs = [{ text: "Halo.", actions: { emotion: "senang", motion: "m1" } }] as any;
    (h.brain as any).playSegments(segs, "companion");
    expect(h.legacy.playMotion.length).toBe(0);
    // Preempt saat TTS masih loading (sebelum audio).
    h.speakLog[0].opts.onPreempted();
    // Audio telat datang setelah preempt → harus diabaikan.
    h.speakLog[0].opts.onAudioStart();
    expect(h.legacy.playMotion.length).toBe(0);
    expect(h.unlocks).toBe(1);
  });

  test("SUPPRESS → chain maju tanpa bocor lock", async () => {
    const h2 = (() => {
      const base = makeHarness();
      (g.window.__live2dAgent as any).speak = (text: string, onDone?: () => void, opts?: any) => {
        base.speakLog.push({ text, onDone, opts });
        return "SUPPRESS";
      };
      return base;
    })();
    const segs = [{ text: "Halo.", actions: { emotion: "senang", motion: "m1" } }] as any;
    (h2.brain as any).playSegments(segs, "companion_proactive");
    expect(h2.speakLog.length).toBe(1);
    // SUPPRESS: tidak ada audio → tidak ada motion, tapi chain selesai.
    expect(h2.legacy.playMotion.length).toBe(0);
    await new Promise((r) => setTimeout(r, 210));
    expect(h2.unlocks).toBe(1);
  });
});
