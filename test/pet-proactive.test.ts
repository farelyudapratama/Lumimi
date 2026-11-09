/**
 * Unit test proaktif pet (src/client/pet/proactive.ts) — budget & teks,
 * waktu di-inject, jaringan di-stub (aturan repo: tak ada test jaringan).
 */
import { describe, expect, it } from "bun:test";
import {
  PROACTIVE_DEFAULTS,
  createBudget,
  eventTurn,
  fetchProactiveLine,
} from "../src/client/pet/proactive";

describe("pet proactive — budget", () => {
  function make(now: number, stamps: number[] = []) {
    const saved: { stamps: number[] }[] = [];
    const b = createBudget({
      now: () => now,
      load: () => ({ stamps }),
      save: (s) => saved.push(s),
    });
    return { b, saved };
  }

  it("budget 3/jam: 3× record → canFire false", () => {
    // minGap diperkecil supaya yang diuji murni BUDGET (gap diuji test lain).
    let now = 1_000_000;
    const b = createBudget({ now: () => now, minGapMs: 1000, hourMs: 60_000 });
    expect(b.canFire(null, 1000)).toBe(true);
    b.record();
    now += 1500;
    expect(b.canFire(null, 1000)).toBe(true);
    b.record();
    now += 1500;
    expect(b.canFire(null, 1000)).toBe(true);
    b.record();
    now += 1500;
    expect(b.canFire(null, 1000)).toBe(false);
    // jendela bergulir: semua stamp keluar → slot bebas lagi.
    now += 62_000;
    expect(b.canFire(null, 1000)).toBe(true);
  });

  it("masa tenang setelah interaksi: baru disentuh → diam", () => {
    const { b } = make(1_000_000);
    const Q = PROACTIVE_DEFAULTS.quietAfterInteractionMs;
    expect(b.canFire(Q - 1000, 1000)).toBe(false);
    expect(b.canFire(Q + 1000, 1000)).toBe(true);
  });

  it("user tak hadir (kursor lama tak bergerak) → tidak mengomentari ruangan kosong", () => {
    const { b } = make(1_000_000);
    const P = PROACTIVE_DEFAULTS.presenceWindowMs;
    expect(b.canFire(null, P + 1)).toBe(false);
    expect(b.canFire(null, P - 1)).toBe(true);
    expect(b.canFire(null, null)).toBe(false);
  });

  it("gap minimum antar komentar", () => {
    let now = 1_000_000;
    const b = createBudget({ now: () => now });
    b.record();
    now += PROACTIVE_DEFAULTS.minGapMs - 1000;
    expect(b.canFire(null, 100)).toBe(false);
    now += 2000;
    expect(b.canFire(null, 100)).toBe(true);
  });

  it("persist: save dipanggil saat record; load memulihkan stamps", () => {
    const { b, saved } = make(1_000_000, []);
    b.record();
    expect(saved).toEqual([{ stamps: [1_000_000] }]);
    // instance baru dengan load → budget terpakai terbawa
    const { b: b2 } = make(1_000_000 + 1000, [1_000_000, 1_000_000, 1_000_000]);
    expect(b2.canFire(null, 100)).toBe(false);
    expect(b2.remaining()).toBe(0);
  });
});

describe("pet proactive — turn & fetch", () => {
  it("eventTurn: protokol [EVENT:] dengan/tanpa detail", () => {
    expect(eventTurn("idle_long")).toBe("[EVENT:idle_long]");
    expect(eventTurn("late_night", "jam 2")).toBe("[EVENT:late_night] jam 2");
  });

  it("fetchProactiveLine: SSE done.reply dipakai; gagal → null", async () => {
    const sse = (frames: string): Response =>
      new Response(frames, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const ok = async (_p: string, _i?: RequestInit): Promise<Response> =>
      sse('data: {"type":"delta","text":"Halo"}\n\ndata: {"type":"done","ok":true,"reply":"Masih semangat?"}\n\n');
    const line = await fetchProactiveLine(ok, "idle_long");
    expect(line).toBe("Masih semangat?");

    const fail = async (_p: string, _i?: RequestInit): Promise<Response> => {
      throw new Error("server mati");
    };
    expect(await fetchProactiveLine(fail, "idle_long")).toBeNull();
  });
});
