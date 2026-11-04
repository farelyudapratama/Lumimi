/**
 * Unit test otak pet (src/client/pet/brain.ts) — murni, jaringan di-stub.
 * Klaim model-agnostic: keputusan divalidasi terhadap daftar kemampuan
 * yang diiklankan; LLM tak bisa menyuntik id di luar daftar.
 */
import { describe, expect, it } from "bun:test";
import {
  IDLE_ACTIONS,
  createDozeGovernor,
  localDecision,
  normalizeDecision,
  requestDecision,
} from "../src/client/pet/brain";

describe("pet brain — normalizeDecision", () => {
  const valid = new Set(["TapBody", "Idle"]);

  it("keputusan sah diterima, holdMs di-clamp 800..8000", () => {
    const d = normalizeDecision(
      { action: "gaze-shift", motion: "TapBody", holdMs: 50000 },
      valid,
    );
    expect(d?.action).toBe("gaze-shift");
    expect(d?.motion).toBe("TapBody");
    expect(d?.holdMs).toBe(8000);
  });

  it("aksi di luar kosakata ditolak (LLM tak bisa mengarang)", () => {
    expect(normalizeDecision({ action: "dance-wildly" }, valid)).toBeNull();
    expect(normalizeDecision({ action: "" }, valid)).toBeNull();
    expect(normalizeDecision(null, valid)).toBeNull();
    expect(normalizeDecision("settle", valid)).toBeNull();
  });

  it("motion di luar kemampuan model dibuang (bukan error)", () => {
    const d = normalizeDecision({ action: "settle", motion: "NotExist" }, valid);
    expect(d?.motion).toBeNull();
  });

  it("invariansi rename: kosakata aksi tetap sama setelah nama model diganti", () => {
    // aksi adalah kosakata semantik — tak bergantung nama grup/id param.
    expect([...IDLE_ACTIONS]).toEqual(["settle", "gaze-shift", "micro-fidget"]);
  });
});

describe("pet brain — requestDecision", () => {
  const req = {
    state: { idleMs: 1000 },
    capabilities: {
      actions: [...IDLE_ACTIONS],
      emotions: ["normal"],
      gazes: ["face-user"],
      motions: [{ id: "Idle", description: "" }],
    },
  };

  it("engine=true + keputusan sah → dikembalikan", async () => {
    const post = async () => ({
      engine: true,
      decision: { action: "settle", holdMs: 2000, confidence: 0.9 },
    });
    const d = await requestDecision(post, req);
    expect(d?.action).toBe("settle");
  });

  it("engine=false → null (pemanggil jatuh ke siklus lokal)", async () => {
    const post = async () => ({ engine: false, error: "tanpa koneksi behavior" });
    expect(await requestDecision(post, req)).toBeNull();
  });

  it("HTTP gagal / melempar → null (tidak pernah melempar)", async () => {
    const post = async () => {
      throw new Error("500");
    };
    expect(await requestDecision(post, req)).toBeNull();
  });
});

describe("pet brain — localDecision (fallback deterministik)", () => {
  it("bergantian settle → gaze-shift → micro-fidget → gaze-shift", () => {
    expect(localDecision(0).action).toBe("settle");
    expect(localDecision(1).action).toBe("gaze-shift");
    expect(localDecision(2).action).toBe("micro-fidget");
    expect(localDecision(3).action).toBe("gaze-shift");
    expect(localDecision(4).action).toBe("settle");
  });

  it("rng di-inject → holdMs deterministik", () => {
    expect(localDecision(0, () => 0.5).holdMs).toBe(3000);
  });
});

describe("pet brain — governor doze (histeresis)", () => {
  it("awake 9 menit tetap awake; ≥10 menit → doze", () => {
    let fired = 0;
    const g = createDozeGovernor({ onEnter: () => fired++ });
    for (let t = 0; t < 9 * 60 * 1000; t += 1000) {
      expect(g.update(t, t)).toBe("awake");
    }
    expect(g.update(10 * 60 * 1000, 10 * 60 * 1000)).toBe("doze");
    expect(fired).toBe(1);
  });

  it("doze bangun saat input kembali (sinceMovement < threshold)", () => {
    let exited = 0;
    const g = createDozeGovernor({ onExit: () => exited++ });
    g.update(10 * 60 * 1000, 10 * 60 * 1000);
    expect(g.state()).toBe("doze");
    expect(g.update(10 * 60 * 1000 + 1, 500)).toBe("awake");
    expect(exited).toBe(1);
  });

  it("belum ada sampel (null) → tetap awake (pet baru bangun)", () => {
    const g = createDozeGovernor();
    expect(g.update(999 * 60 * 1000, null)).toBe("awake");
  });
});
