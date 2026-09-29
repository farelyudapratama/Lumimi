// test/native-clips.test.ts — skema id & registrasi klip motion native per-file.
import { describe, it, expect } from "bun:test";
import {
  buildNativeClips,
  buildNativeClipsFromCounts,
  sanitizeClipId,
} from "../src/client/engine/native-clips";

describe("native-clips", () => {
  it("grup bernama 1-klip memakai id motion_<grup> (paritas perilaku lama)", () => {
    const clips = buildNativeClips({
      Idle: [{ File: "motions/mtn_01.motion3.json" }],
    });
    expect(clips).toHaveLength(1);
    expect(clips[0]).toEqual({
      id: "motion_Idle",
      name: "mtn_01",
      group: "Idle",
      index: 0,
      file: "motions/mtn_01.motion3.json",
    });
  });

  it("grup bernama string kosong tetap diproses — id dari stem file", () => {
    const clips = buildNativeClips({
      "": [
        { File: "motions/mtn_02.motion3.json" },
        { File: "motions/mtn_03.motion3.json" },
      ],
    });
    expect(clips.map((c) => c.id)).toEqual(["motion_mtn_02", "motion_mtn_03"]);
    expect(clips.map((c) => c.group)).toEqual(["", ""]);
    expect(clips.map((c) => c.index)).toEqual([0, 1]);
  });

  it("grup multi-klip bernama → id per-stem; grup 1-klip lain pakai id grup", () => {
    const clips = buildNativeClips({
      TapBody: [
        { File: "motions/tap_a.motion3.json" },
        { File: "motions/tap_b.motion3.json" },
      ],
      Other: [{ File: "motions/tap_a.motion3.json" }],
    });
    expect(clips.map((c) => c.id)).toEqual([
      "motion_tap_a",
      "motion_tap_b",
      "motion_Other",
    ]);
  });

  it("Name menang atas stem File; duration & loop dari discovery diteruskan", () => {
    const clips = buildNativeClips(
      { G: [{ Name: "lompat", File: "x/y.motion3.json" }] },
      { "x/y.motion3.json": { duration: 3.5, loop: true } },
    );
    // grup G 1-klip → id motion_G; name dari Name.
    expect(clips[0].id).toBe("motion_G");
    expect(clips[0].name).toBe("lompat");
    expect(clips[0].duration).toBe(3.5);
    expect(clips[0].loop).toBe(true);
    // meta tanpa loop → field loop tidak ada.
    const noLoop = buildNativeClips(
      { G: [{ Name: "lompat", File: "x/y.motion3.json" }] },
      { "x/y.motion3.json": { duration: 3.5 } },
    );
    expect(noLoop[0].loop).toBeUndefined();
    // duration tertulis langsung di entri manifest juga dihormati.
    const inline = buildNativeClips({
      G: [{ Name: "lompat", File: "x/y.motion3.json", duration: 2.25 }],
    });
    expect(inline[0].duration).toBe(2.25);
  });

  it("karakter non-URL-safe disanitasi; unicode dipertahankan", () => {
    expect(sanitizeClipId("跳び はねる!")).toBe("跳び_はねる_");
    expect(sanitizeClipId("")).toBe("klip");
    const clips = buildNativeClips({
      "": [{ File: "跳びはねる.motion3.json" }],
    });
    expect(clips[0].id).toBe("motion_跳びはねる");
  });

  it("klip tanpa File / bentuk aneh dilewati dengan aman", () => {
    expect(buildNativeClips(null)).toEqual([]);
    expect(buildNativeClips([])).toEqual([]);
    expect(buildNativeClips({ G: [{}, { Name: "x" }, "bukan objek"] })).toEqual([]);
    expect(buildNativeClips({ G: "bukan array" })).toEqual([]);
  });

  it("fallback buildFromCounts: tanpa nama file, id tetap stabil & unik", () => {
    const clips = buildNativeClipsFromCounts({
      Idle: [{}, {}],
      Tap: [{}],
      "": [{}, {}],
    });
    expect(clips.map((c) => c.id)).toEqual([
      "motion_Idle_1",
      "motion_Idle_2",
      "motion_Tap",
      "motion_klip_1",
      "motion_klip_2",
    ]);
    expect(clips.map((c) => c.index)).toEqual([0, 1, 0, 0, 1]);
  });

  it("model-agnostic: tidak ada asumsi nama grup/param — id murni turunan data", () => {
    // Nama diganti/lokal (mis. grup Indonesia, file hash) tetap menghasilkan
    // id yang benar berdasarkan data, bukan tabel hardcode. Grup "Gerakan
    // Idle" 1-klip → id dari grup (paritas); file m_001 jadi nama tampilan.
    const clips = buildNativeClips({
      "Gerakan Idle": [{ File: "m_001/m_001.motion3.json" }],
    });
    expect(clips[0].id).toBe("motion_Gerakan_Idle");
    expect(clips[0].name).toBe("m_001");
  });
});

describe("native-clips — alias rename (overlay non-destruktif)", () => {
  const motions = {
    Idle: [{ File: "motions/mtn_01.motion3.json" }],
    TapBody: [
      { File: "motions/tap_a.motion3.json" },
      { File: "motions/tap_b.motion3.json" },
    ],
  };

  it("alias per-file mengganti nama + basis id; grup & index tetap asli", () => {
    const clips = buildNativeClips(motions, undefined, {
      "motions/tap_a.motion3.json": "Lambaikan Tangan",
    });
    const a = clips.find((c) => c.file === "motions/tap_a.motion3.json");
    expect(a).toMatchObject({
      id: "motion_Lambaikan_Tangan",
      name: "Lambaikan Tangan",
      group: "TapBody",
      index: 0,
    });
    // Klip lain tidak tersentuh.
    const b = clips.find((c) => c.file === "motions/tap_b.motion3.json");
    expect(b).toMatchObject({ id: "motion_tap_b", name: "tap_b" });
  });

  it("alias menimpa basis id grup 1-klip yang biasanya motion_<grup>", () => {
    const clips = buildNativeClips(motions, undefined, {
      "motions/mtn_01.motion3.json": "Diam Santai",
    });
    const idle = clips.find((c) => c.file === "motions/mtn_01.motion3.json");
    expect(idle).toMatchObject({ id: "motion_Diam_Santai", name: "Diam Santai", group: "Idle" });
  });

  it("alias kosong/whitespace diabaikan (nama asli)", () => {
    const clips = buildNativeClips(motions, undefined, {
      "motions/tap_a.motion3.json": "   ",
    });
    const a = clips.find((c) => c.file === "motions/tap_a.motion3.json");
    expect(a).toMatchObject({ id: "motion_tap_a", name: "tap_a" });
  });

  it("tanpa alias = perilaku persis seperti sebelumnya", () => {
    const withUndef = buildNativeClips(motions);
    const withEmpty = buildNativeClips(motions, undefined, {});
    expect(withUndef).toEqual(withEmpty);
  });
});
