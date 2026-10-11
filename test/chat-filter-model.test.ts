// Test model murni panel Filter Chat (src/client/shell/chat-filter.ts):
// konversi textarea ↔ daftar kata. Logika filter aslinya di Rust
// (core/src/chat_filter.rs) — batas di sini harus senada dengan sanitasi
// save_chat_filter di config.rs.

import { describe, expect, test } from "bun:test";
import { WORD_MAX_CHARS, WORDS_MAX, wordsFromTextarea, wordsToTextarea } from "../src/client/shell/chat-filter";

describe("chat-filter model", () => {
  test("wordsFromTextarea: trim, buang kosong, satu per baris", () => {
    expect(wordsFromTextarea("slot\njudol\n\n  iklan  \n")).toEqual(["slot", "judol", "iklan"]);
    expect(wordsFromTextarea("")).toEqual([]);
    expect(wordsFromTextarea("   \n\t\n")).toEqual([]);
  });

  test("wordsFromTextarea: dedupe case-insensitive, yang pertama menang", () => {
    expect(wordsFromTextarea("Slot\nSLOT\nslot gacor")).toEqual(["Slot", "slot gacor"]);
    expect(wordsFromTextarea("JUDOL\njudol")).toEqual(["JUDOL"]);
  });

  test("wordsFromTextarea: cap 200 kata × 100 char", () => {
    const many = Array.from({ length: WORDS_MAX + 10 }, (_, i) => `kata${i}`).join("\n");
    expect(wordsFromTextarea(many)).toHaveLength(WORDS_MAX);
    expect(wordsFromTextarea(many)[0]).toBe("kata0");
    const long = "x".repeat(WORD_MAX_CHARS + 50);
    expect(wordsFromTextarea(long)[0]).toHaveLength(WORD_MAX_CHARS);
    // Case-insensitive dedupe tetap jalan pada kata yang sudah terpotong.
    expect(wordsFromTextarea(`${long}\n${"x".repeat(300)}`)).toHaveLength(1);
  });

  test("wordsToTextarea: array string saja, lainnya diabaikan", () => {
    expect(wordsToTextarea(["a", "b"])).toBe("a\nb");
    expect(wordsToTextarea([])).toBe("");
    expect(wordsToTextarea(undefined)).toBe("");
    expect(wordsToTextarea(["a", 5, null, "b"])).toBe("a\nb");
  });

  test("round-trip textarea → config → textarea stabil", () => {
    const raw = "Slot\njudol\niklan";
    expect(wordsToTextarea(wordsFromTextarea(raw))).toBe(raw);
  });
});
