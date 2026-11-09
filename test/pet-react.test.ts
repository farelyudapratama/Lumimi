/**
 * Unit test resolusi reaksi pet (src/client/pet/react.ts) + punch-through.
 * Invariansi nama: resolusi harus tetap benar setelah nama grup diganti
 * (renamed/alias) — dipakai untuk menguji fuzzy match dua arah.
 */
import { describe, expect, it } from "bun:test";
import { createPunchController } from "../src/client/pet/punch";
import { REACTION_VERBS, pickLine, resolveExpressionForVerb, resolveMotionForVerb } from "../src/client/pet/react";

describe("pet react — resolusi motion semantik", () => {
  const defs = {
    TapBody: [{}, {}],
    Idle: [{}],
    Greeting: [{}],
    M_001: [{}], // nama asing/hashed — tak cocok apa pun (baik)
  };

  it("verb wave cocok ke grup ber-nama wave/greet", () => {
    expect(resolveMotionForVerb(defs, "wave")).toBe("Greeting");
  });

  it("fallback 'touch' menyentuh grup TapBody (via rantai REACTION_VERBS)", () => {
    const found = REACTION_VERBS.boop
      .map((v) => resolveMotionForVerb(defs, v))
      .find(Boolean);
    expect(found).toBe("TapBody");
  });

  it("grup kosong diabaikan meski namanya cocok", () => {
    expect(resolveMotionForVerb({ Happy: [] }, "happy")).toBeNull();
  });

  it("definitions kosong/null → null (degradasi diam)", () => {
    expect(resolveMotionForVerb({}, "happy")).toBeNull();
    expect(resolveMotionForVerb(null, "happy")).toBeNull();
  });

  it("invariansi rename: grup diganti nama apa pun yang mengandung sinonim tetap ketemu", () => {
    expect(resolveMotionForVerb({ m_happy_wave_renamed: [{}] }, "happy")).toBe(
      "m_happy_wave_renamed",
    );
    expect(resolveMotionForVerb({ "Wave say-hi (copy) 2": [{}] } as Record<string, unknown[]>, "wave")).toBeTruthy();
  });

  it("resolusi ekspresi: fuzzy dua arah", () => {
    const exprs = [{ Name: "smile_soft" }, { Name: "angry" }];
    expect(resolveExpressionForVerb(exprs, "happy")).toBe("smile_soft");
    expect(resolveExpressionForVerb(exprs, "sad")).toBeNull();
  });
});

describe("pet react — pickLine", () => {
  it("tidak mengulang baris terakhir bila ada alternatif", () => {
    const lines = ["a", "b"];
    const picked = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const l = pickLine(lines, "a");
      if (l) picked.add(l);
    }
    expect(picked.has("a")).toBe(false);
    expect(picked.has("b")).toBe(true);
  });

  it("satu-satunya baris tetap dikembalikan walau sama dengan avoid", () => {
    expect(pickLine(["satu"], "satu")).toBe("satu");
  });

  it("kosong → null", () => {
    expect(pickLine([])).toBeNull();
  });
});

describe("pet punch — histeresis punch-through", () => {
  const bounds = { x: 100, y: 100, width: 200, height: 200 };
  function make(ct0: boolean) {
    const ignoreLog: boolean[] = [];
    let ct = ct0;
    const p = createPunchController({
      setIgnore: (on) => ignoreLog.push(on),
      getBounds: () => bounds,
      getClickThrough: () => ct,
      enterPad: 4,
      exitPad: 24,
    });
    return { p, ignoreLog, setCt: (v: boolean) => { ct = v; } };
  }

  it("click-through OFF: jendela menerima input; koreksi sekali, tanpa toggle berulang", () => {
    const { p, ignoreLog } = make(false);
    p.feed(150, 150);
    p.feed(500, 500);
    p.feed(150, 150);
    expect(p.receivingInput()).toBe(true);
    expect(ignoreLog).toEqual([false]); // sekali koreksi dari asumsi awal
  });

  it("kursor masuk model → menerima input; keluar jauh → kembali tembus", () => {
    const { p, ignoreLog } = make(true);
    expect(p.feed(500, 500)).toBe(false); // jauh di luar (sudah tembus, tanpa toggle)
    expect(ignoreLog).toEqual([]);
    expect(p.feed(150, 150)).toBe(true); // di atas model
    expect(ignoreLog).toEqual([false]);
    expect(p.feed(250, 250)).toBe(true); // tetap (tanpa toggle berulang)
    expect(ignoreLog).toEqual([false]);
    expect(p.feed(600, 600)).toBe(false); // keluar > exitPad
    expect(ignoreLog).toEqual([false, true]);
  });

  it("histeresis keluar: tepi luar ≤ exitPad masih dianggap di dalam (tanpa flip-flop)", () => {
    const { p } = make(true);
    p.feed(150, 150); // masuk
    expect(p.feed(100 + 200 + 20, 150)).toBe(true); // 20 px luar tepi kanan
    expect(p.feed(100 + 200 + 40, 150)).toBe(false); // 40 px → keluar
  });

  it("enter pad kecil (dari keadaan tembus): 3 px luar tepi masuk, 9 px tidak", () => {
    const a = make(true);
    expect(a.p.feed(100 - 3, 150)).toBe(true); // dalam pad masuk
    const b = make(true);
    expect(b.p.feed(100 - 9, 150)).toBe(false); // di luar pad masuk
  });

  it("bounds null (model belum siap) → tetap menembus penuh", () => {
    const ignoreLog: boolean[] = [];
    const p = createPunchController({
      setIgnore: (on) => ignoreLog.push(on),
      getBounds: () => null,
      getClickThrough: () => true,
    });
    p.feed(150, 150);
    expect(p.receivingInput()).toBe(false);
    expect(ignoreLog).toEqual([]); // asumsi awal = menembus, tanpa toggle
  });

  it("urutan realistis panel: menerima → klik-tembus dinyalakan → force menembus", () => {
    const { p, ignoreLog, setCt } = make(false);
    p.feed(150, 150); // normal, menerima input
    expect(p.receivingInput()).toBe(true);
    setCt(true);
    p.force(true); // baseline tembus penuh; punch membuka lubang nanti
    expect(p.receivingInput()).toBe(false);
    expect(ignoreLog).toEqual([false, true]);
  });

  it("openInput() saat klik-tembus dimatikan: jendela menerima input", () => {
    const { p, ignoreLog } = make(true);
    p.feed(150, 150); // lubang terbuka
    expect(p.receivingInput()).toBe(true);
    p.openInput();
    expect(p.receivingInput()).toBe(true);
    expect(ignoreLog).toEqual([false]); // force(true) no-op dari awal; feed buka; openInput tetap buka
  });
});
