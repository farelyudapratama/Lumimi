/**
 * test/character-runtime.test.ts — Unit test arbitrase CharacterRuntime (R1–R10).
 * Bridge palsu hanya merekam panggilan; waktu dikontrol manual lewat
 * bridge.now() dan injeksi nowMs ke tick() agar deterministik (tanpa DOM/jaringan).
 */
import { describe, it, expect } from "bun:test";
import { CharacterRuntime, DEFAULT_CONFIG } from "../src/client/character/runtime";
import type { CharacterBridge, Domain, Intent, RuntimeConfig } from "../src/client/character/runtime";

class FakeBridge implements CharacterBridge {
  calls: string[] = [];
  t = 1_000;
  now(): number {
    return this.t;
  }
  startBase(intent: Intent): unknown {
    this.calls.push(`startBase:${intent.id}`);
    return { k: "base" };
  }
  pauseBase(_handle: unknown, domains: Domain[]): void {
    this.calls.push(`pauseBase:${domains.join("+")}`);
  }
  resumeBase(_handle: unknown, domains: Domain[]): void {
    this.calls.push(`resumeBase:${domains.join("+")}`);
  }
  stopBase(_handle: unknown): void {
    this.calls.push("stopBase");
  }
  startAction(intent: Intent): unknown {
    this.calls.push(`startAction:${intent.id}`);
    return { k: intent.id };
  }
  stopAction(handle: unknown): void {
    this.calls.push(`stopAction:${(handle as { k: string }).k}`);
  }
  setExpression(intent: Intent): void {
    this.calls.push(`setExpression:${intent.id}`);
  }
  clearExpression(): void {
    this.calls.push("clearExpression");
  }
  count(call: string): number {
    return this.calls.filter((c) => c === call).length;
  }
  indexOf(call: string): number {
    return this.calls.indexOf(call);
  }
  lastIndexOf(call: string): number {
    return this.calls.lastIndexOf(call);
  }
}

function intent(partial: Partial<Intent> & { id: string }): Intent {
  return { kind: "action", domains: ["head"], priority: 60, source: "director", ...partial };
}

function makeRuntime(cfg?: Partial<RuntimeConfig>): { r: CharacterRuntime; b: FakeBridge } {
  const b = new FakeBridge();
  const r = new CharacterRuntime(cfg);
  r.attach(b);
  return { r, b };
}

describe("CharacterRuntime — R2 overlay", () => {
  it("intent tanpa konflik domain jalan bersama holder aktif", () => {
    const { r, b } = makeRuntime();
    r.setBase(intent({ id: "walk", kind: "base", domains: ["body"], priority: 0, source: "base" }));
    const d = r.submit(intent({ id: "wave", domains: ["head"], durationMs: 500 }));
    expect(d.mode).toBe("overlay");
    const s = r.snapshot();
    expect(s.actions).toHaveLength(1);
    expect(s.actions[0].status).toBe("active");
    expect(s.holders["body"]).toBe("walk");
    expect(s.holders["head"]).toBe("wave");
    expect(b.indexOf("startAction:wave")).toBeGreaterThanOrEqual(0);
  });
});

describe("CharacterRuntime — R3 override", () => {
  it("priority lebih tinggi pause base per-domain, resume otomatis saat TTL habis", () => {
    const { r, b } = makeRuntime();
    r.setBase(intent({ id: "walk", kind: "base", domains: ["head", "body"], priority: 0, source: "base" }));
    const d = r.submit(intent({ id: "look", priority: 80, domains: ["head"], durationMs: 500 }));
    expect(d.mode).toBe("override");
    expect(b.calls).toContain("pauseBase:head");
    let s = r.snapshot();
    expect(s.base?.status).toBe("paused");
    expect(s.holders["head"]).toBe("look");
    expect(s.holders["body"]).toBe("walk");

    s = r.tick(1_500); // expiresAt = 1000 + 500
    expect(b.calls).toContain("stopAction:look");
    expect(b.calls).toContain("resumeBase:head");
    expect(s.base?.status).toBe("running");
    expect(s.holders["head"]).toBe("walk");
  });

  it("action meng-override expression (affect); expression dikembalikan saat action selesai", () => {
    const { r, b } = makeRuntime();
    r.submit(intent({ id: "happy", kind: "expression", domains: ["affect"], priority: 60 }));
    expect(b.calls).toContain("setExpression:happy");
    r.submit(intent({ id: "shout", priority: 80, domains: ["affect"], durationMs: 400 }));
    expect(b.calls).toContain("clearExpression");
    let s = r.snapshot();
    expect(s.expression?.id).toBe("happy");
    expect(s.expression?.status).toBe("paused");
    expect(s.holders["affect"]).toBe("shout");

    s = r.tick(1_400);
    expect(b.count("setExpression:happy")).toBe(2); // set + restore
    expect(s.expression?.status).toBe("active");
    expect(s.holders["affect"]).toBe("happy");
  });

  it("base yang ter-pause sebagian tetap memegang domain sisanya", () => {
    const { r, b } = makeRuntime();
    r.setBase(intent({ id: "walk", kind: "base", domains: ["head", "body"], priority: 0, source: "base" }));
    r.submit(intent({ id: "look", priority: 80, domains: ["head"], durationMs: 5_000 }));
    r.submit(intent({ id: "sway", priority: 60, domains: ["body"], durationMs: 5_000 }));
    const s = r.snapshot();
    expect(b.calls).toContain("pauseBase:body");
    expect(s.base?.status).toBe("paused");
    expect(s.holders["head"]).toBe("look");
    expect(s.holders["body"]).toBe("sway");
  });
});

describe("CharacterRuntime — R4 queue", () => {
  it("priority sama berdurasi mengantre FIFO lalu di-admit saat slot kosong", () => {
    const { r, b } = makeRuntime();
    r.submit(intent({ id: "a1", durationMs: 500 }));
    const d = r.submit(intent({ id: "b1", durationMs: 500 }));
    expect(d.mode).toBe("queue");
    let s = r.snapshot();
    expect(s.actions.map((a) => [a.id, a.status])).toEqual([
      ["a1", "active"],
      ["b1", "queued"],
    ]);

    s = r.tick(1_500);
    expect(b.calls).toContain("stopAction:a1");
    expect(b.calls).toContain("startAction:b1");
    expect(s.actions).toHaveLength(1);
    expect(s.actions[0].id).toBe("b1");
    expect(s.actions[0].status).toBe("active");
    expect(s.actions[0].remainingMs).toBe(500); // admit ulang: TTL mulai dari tick
    expect(s.lastDecision?.mode).toBe("overlay");
    expect(s.lastDecision?.reason.startsWith("antrian admit:")).toBe(true);
  });

  it("action tanpa durasi → REJECT", () => {
    const { r } = makeRuntime();
    r.submit(intent({ id: "a1", domains: ["eyes"], durationMs: 500 }));
    const d = r.submit(intent({ id: "b1", domains: ["eyes"] }));
    expect(d.mode).toBe("reject");
    expect(d.reason).toContain("berdurasi");
  });
});

describe("CharacterRuntime — R5 reject", () => {
  it("priority lebih rendah ditolak dengan alasan", () => {
    const { r } = makeRuntime();
    r.submit(intent({ id: "a1", priority: 80, durationMs: 5_000 }));
    const d = r.submit(intent({ id: "b1", priority: 60, durationMs: 5_000 }));
    expect(d.mode).toBe("reject");
    expect(d.reason).toContain("60");
    expect(d.reason).toContain("80");
    expect(r.decisions().at(-1)?.mode).toBe("reject");
  });
});

describe("CharacterRuntime — R6 tie-break", () => {
  it("sourceRank lebih tinggi menang override pada priority sama", () => {
    const { r, b } = makeRuntime();
    r.submit(intent({ id: "dir1", source: "director", durationMs: 5_000 }));
    const d = r.submit(intent({ id: "man1", source: "manual", durationMs: 5_000 }));
    expect(d.mode).toBe("override");
    expect(b.calls).toContain("stopAction:dir1");
    expect(b.calls).toContain("startAction:man1");
    expect(r.snapshot().holders["head"]).toBe("man1");
  });

  it("umur menentukan pada seri: pendatang lebih muda kalah → queue", () => {
    const { r, b } = makeRuntime();
    r.submit(intent({ id: "old1", source: "manual", durationMs: 5_000 }));
    expect(r.decisions().at(-1)?.mode).toBe("overlay");
    b.t = 1_100; // pendatang lebih muda
    const d = r.submit(intent({ id: "new1", source: "manual", durationMs: 5_000 }));
    expect(d.mode).toBe("queue");
    expect(r.snapshot().actions.find((a) => a.id === "new1")?.status).toBe("queued");
  });
});

describe("CharacterRuntime — R7 tick", () => {
  it("TTL habis: stop action, kembalikan expression tertunda, admit antrian satu-satu", () => {
    const { r, b } = makeRuntime();
    r.setBase(intent({ id: "walk", kind: "base", domains: ["body", "affect"], priority: 0, source: "base" }));
    r.submit(intent({ id: "happy", kind: "expression", domains: ["affect"], priority: 60 }));
    expect(b.calls).toContain("pauseBase:affect");
    r.submit(intent({ id: "shout", priority: 80, domains: ["affect"], durationMs: 500 }));
    expect(b.calls).toContain("clearExpression");
    r.submit(intent({ id: "b1", domains: ["head"], durationMs: 5_000 }));
    b.t = 1_100;
    const dq = r.submit(intent({ id: "c1", domains: ["head"], durationMs: 5_000 }));
    expect(dq.mode).toBe("queue");

    const s = r.tick(1_500); // shout habis (exp 1500), b1 masih aktif (exp 6000)
    expect(b.lastIndexOf("setExpression:happy")).toBeGreaterThan(b.indexOf("stopAction:shout"));
    expect(b.count("setExpression:happy")).toBe(2);
    expect(s.expression?.status).toBe("active");
    expect(s.base?.status).toBe("paused"); // affect tetap dipegang expression
    expect(s.holders).toEqual({ body: "walk", affect: "happy", head: "b1" });
    expect(s.actions.map((a) => [a.id, a.status])).toEqual([
      ["b1", "active"],
      ["c1", "queued"],
    ]);

    r.releaseExpression();
    expect(b.calls).toContain("resumeBase:affect");
    expect(r.snapshot().base?.status).toBe("running");

    const s2 = r.tick(6_000); // b1 habis → c1 admit
    expect(b.calls).toContain("stopAction:b1");
    expect(b.calls).toContain("startAction:c1");
    expect(s2.actions.map((a) => a.id)).toEqual(["c1"]);
    expect(s2.holders["head"]).toBe("c1");
  });

  it("antrian dinilai ulang: ditolak bila holder lebih tinggi muncul", () => {
    const { r } = makeRuntime();
    r.submit(intent({ id: "a1", durationMs: 5_000 }));
    r.submit(intent({ id: "b1", durationMs: 5_000 })); // queue di belakang a1
    r.submit(intent({ id: "c1", priority: 80, durationMs: 5_000 })); // override a1
    expect(r.snapshot().holders["head"]).toBe("c1");
    const s = r.tick(1_100);
    expect(s.actions.map((a) => a.id)).toEqual(["c1"]);
    expect(s.lastDecision?.mode).toBe("reject");
    expect(s.lastDecision?.reason.startsWith("antrian ditolak:")).toBe(true);
    expect(s.lastDecision?.intentId).toBe("b1");
  });

  it("tick(nowMs) deterministik + remainingMs terhitung dari now injeksi", () => {
    const { r } = makeRuntime();
    r.submit(intent({ id: "a1", durationMs: 500 }));
    let s = r.tick(1_499);
    expect(s.actions[0].status).toBe("active");
    expect(s.actions[0].remainingMs).toBe(1);
    s = r.tick(1_500); // habis tepat pada expiresAt
    expect(s.actions).toHaveLength(0);
  });
});

describe("CharacterRuntime — R8 expression replace", () => {
  it("expression baru menggantikan slot tunggal tanpa konflik holder (log replace)", () => {
    const { r, b } = makeRuntime();
    r.submit(intent({ id: "e1", kind: "expression", domains: ["affect"], priority: 60 }));
    const d = r.submit(intent({ id: "e2", kind: "expression", domains: ["affect"], priority: 70 }));
    expect(d.mode).toBe("replace");
    expect(b.count("setExpression:e1")).toBe(1);
    expect(b.calls).toContain("setExpression:e2");
    expect(r.snapshot().expression?.id).toBe("e2");
    expect(r.decisions().at(-1)?.mode).toBe("replace");
  });

  it("ganti expression melepas domain base lama dan mengambil domain baru", () => {
    const { r, b } = makeRuntime();
    r.setBase(intent({ id: "walk", kind: "base", domains: ["affect", "head"], priority: 0, source: "base" }));
    r.submit(intent({ id: "e1", kind: "expression", domains: ["affect"], priority: 60 }));
    expect(b.calls).toContain("pauseBase:affect");
    r.submit(intent({ id: "e2", kind: "expression", domains: ["head"], priority: 60 }));
    expect(b.calls).toContain("resumeBase:affect");
    expect(b.calls).toContain("pauseBase:head");
    const s = r.snapshot();
    expect(s.holders["affect"]).toBe("walk");
    expect(s.holders["head"]).toBe("e2");
  });
});

describe("CharacterRuntime — R9 base", () => {
  it("setBase baru menggantikan base lama (stop via bridge, log replace)", () => {
    const { r, b } = makeRuntime();
    r.setBase(intent({ id: "walk1", kind: "base", domains: ["body", "head"], priority: 0, source: "base" }));
    const d = r.setBase(intent({ id: "walk2", kind: "base", domains: ["body"], priority: 0, source: "base" }));
    expect(d.mode).toBe("replace");
    expect(b.indexOf("stopBase")).toBeLessThan(b.indexOf("startBase:walk2"));
    const s = r.snapshot();
    expect(s.base?.id).toBe("walk2");
    expect(s.base?.status).toBe("running");
  });

  it("base baru langsung di-pause di domain yang dipegang action aktif", () => {
    const { r, b } = makeRuntime();
    r.setBase(intent({ id: "walk1", kind: "base", domains: ["body"], priority: 0, source: "base" }));
    r.submit(intent({ id: "dance", priority: 80, domains: ["body"], durationMs: 5_000 }));
    expect(r.snapshot().base?.status).toBe("paused");
    r.setBase(intent({ id: "walk2", kind: "base", domains: ["body", "eyes"], priority: 0, source: "base" }));
    const s = r.snapshot();
    expect(b.count("pauseBase:body")).toBe(2); // sekali untuk tiap base
    expect(s.base?.id).toBe("walk2");
    expect(s.base?.status).toBe("paused");
    expect(s.holders).toEqual({ body: "dance", eyes: "walk2" });
  });
});

describe("CharacterRuntime — R10 ring log", () => {
  it("maks 50 entri, terbaru di akhir, yang tertua terbuang", () => {
    const { r } = makeRuntime();
    for (let i = 1; i <= 60; i++) {
      r.submit(intent({ id: `e${i}`, kind: "expression", domains: ["affect"], priority: 60 }));
    }
    const log = r.decisions();
    expect(log).toHaveLength(50);
    expect(log[0].intentId).toBe("e11");
    expect(log[log.length - 1].intentId).toBe("e60");
    expect(log.every((e) => e.domains.includes("affect"))).toBe(true);
  });
});

describe("CharacterRuntime — apertur saat speech", () => {
  it("tanpa flags.aperture ditolak; dengan flags.aperture boleh klaim", () => {
    const { r } = makeRuntime();
    r.speechActive(true);
    const d1 = r.submit(intent({ id: "m1", domains: ["apertur"], durationMs: 500 }));
    expect(d1.mode).toBe("reject");
    expect(d1.reason).toContain("lipsync");
    const d2 = r.submit(intent({ id: "m2", domains: ["apertur"], durationMs: 500, flags: { aperture: true } }));
    expect(d2.mode).toBe("overlay");
    expect(r.snapshot().holders["apertur"]).toBe("m2");
  });

  it("sinyal speech/lipsync tercermin di snapshot", () => {
    const { r } = makeRuntime();
    r.speechActive(true);
    r.lipsyncActive(true);
    let s = r.snapshot();
    expect(s.speech.active).toBe(true);
    expect(s.lipsync.active).toBe(true);
    r.speechActive(false);
    r.lipsyncActive(false);
    s = r.snapshot();
    expect(s.speech.active).toBe(false);
    expect(s.lipsync.active).toBe(false);
  });
});

describe("CharacterRuntime — kapasitas maxActions", () => {
  it("slot penuh: antrian dan overlay ditolak, alasan menyebut kapasitas", () => {
    const { r } = makeRuntime({ maxActions: 2 });
    expect(r.submit(intent({ id: "a1", durationMs: 5_000 })).mode).toBe("overlay");
    expect(r.submit(intent({ id: "b1", durationMs: 5_000 })).mode).toBe("queue");
    const dFullQueue = r.submit(intent({ id: "c1", durationMs: 5_000 }));
    expect(dFullQueue.mode).toBe("reject");
    expect(dFullQueue.reason).toContain("penuh");
    const dFullOverlay = r.submit(intent({ id: "d1", domains: ["eyes"], durationMs: 5_000 }));
    expect(dFullOverlay.mode).toBe("reject");
    expect(dFullOverlay.reason).toContain("penuh");
    expect(r.snapshot().actions.map((a) => [a.id, a.status])).toEqual([
      ["a1", "active"],
      ["b1", "queued"],
    ]);
  });
});

describe("CharacterRuntime — reset", () => {
  it("stop semua slot via bridge, kosongkan antrian/log/sinyal", () => {
    const { r, b } = makeRuntime();
    r.setBase(intent({ id: "walk", kind: "base", domains: ["body"], priority: 0, source: "base" }));
    r.submit(intent({ id: "a1", durationMs: 5_000 }));
    r.submit(intent({ id: "b1", durationMs: 5_000 })); // queued
    r.submit(intent({ id: "e1", kind: "expression", domains: ["affect"], priority: 60 }));
    r.speechActive(true);
    r.reset();
    expect(b.calls).toContain("stopAction:a1");
    expect(b.calls).toContain("stopBase");
    expect(b.calls).toContain("clearExpression");
    expect(b.calls).not.toContain("stopAction:b1"); // yang mengantre belum punya handle
    const s = r.snapshot();
    expect(s.base).toBeNull();
    expect(s.actions).toEqual([]);
    expect(s.expression).toBeNull();
    expect(s.speech.active).toBe(false);
    expect(s.lipsync.active).toBe(false);
    expect(s.lastDecision).toBeNull();
    expect(r.decisions()).toEqual([]);
  });
});

describe("CharacterRuntime — ketahanan bridge", () => {
  it("jalan tanpa bridge maupun dengan bridge parsial (guard tiap panggilan)", () => {
    const bare = new CharacterRuntime();
    bare.setBase(intent({ id: "walk", kind: "base", priority: 0, source: "base" }));
    bare.submit(intent({ id: "a1", durationMs: 100 }));
    expect(bare.snapshot().actions).toHaveLength(1);
    expect(bare.decisions().length).toBeGreaterThanOrEqual(2);

    const partial = new CharacterRuntime();
    partial.attach({ now: () => 5 } as unknown as CharacterBridge);
    partial.setBase(intent({ id: "walk", kind: "base", priority: 0, source: "base" }));
    partial.submit(intent({ id: "a1", durationMs: 100 })); // startAction absen → handle null
    const s = partial.tick(200); // stopAction di-skip aman
    expect(s.actions).toHaveLength(0);
    expect(s.base?.status).toBe("running");
  });

  it("mengisi intent.at dari bridge.now() bila absen", () => {
    const { r, b } = makeRuntime();
    b.t = 1_234;
    const it_ = intent({ id: "a1", durationMs: 100 });
    r.submit(it_);
    expect(it_.at).toBe(1_234);
  });

  it("DEFAULT_CONFIG menjadi basis config parsial", () => {
    const { r } = makeRuntime({ maxActions: 2 });
    r.submit(intent({ id: "a1", source: "director", durationMs: 5_000 }));
    // sourceRank default tetap ikut: manual (3) > director (2) pada priority sama
    const d = r.submit(intent({ id: "a2", source: "manual", durationMs: 5_000 }));
    expect(DEFAULT_CONFIG.maxActions).toBe(3);
    expect(d.mode).toBe("override");
  });
});
