/**
 * Unit test pipeline chat pet (src/client/pet/chat.ts) — semua fetch
 * di-stub (aturan repo: TIDAK ada test jaringan).
 */
import { describe, expect, it } from "bun:test";
import {
  chatReply,
  directorSegments,
  sanitizeSegments,
  segmentTextFallback,
  sttText,
} from "../src/client/pet/chat";

function sseResponse(frames: string, status = 200): Response {
  return new Response(frames, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("pet chat — sttText", () => {
  it("respons {text} di-trim; kosong → null", async () => {
    const ok = async (): Promise<Response> =>
      new Response(JSON.stringify({ text: "  halo pet  " }), { status: 200 });
    expect(await sttText(ok, new Uint8Array([1]))).toBe("halo pet");
    const empty = async (): Promise<Response> =>
      new Response(JSON.stringify({ text: "  " }), { status: 200 });
    expect(await sttText(empty, new Uint8Array([1]))).toBeNull();
  });

  it("HTTP error / melempar → null (fail-soft)", async () => {
    const bad = async (): Promise<Response> => new Response("err", { status: 500 });
    expect(await sttText(bad, new Uint8Array([1]))).toBeNull();
    const boom = async (): Promise<Response> => {
      throw new Error("offline");
    };
    expect(await sttText(boom, new Uint8Array([1]))).toBeNull();
  });
});

describe("pet chat — chatReply (SSE)", () => {
  it("done.reply dipakai; tanpa done → gabungan delta", async () => {
    const a = async (): Promise<Response> =>
      sseResponse('data: {"type":"done","ok":true,"reply":"Halo!"}\n\n');
    expect(await chatReply(a, "sys", [{ role: "user", content: "hai" }], "")).toBe("Halo!");
    const b = async (): Promise<Response> =>
      sseResponse('data: {"type":"delta","text":"Ha"}\n\ndata: {"type":"delta","text":"lo"}\n\n');
    expect(await chatReply(b, "sys", [], "")).toBe("Halo");
  });

  it("server mati → null, tidak melempar", async () => {
    const boom = async (): Promise<Response> => {
      throw new Error("down");
    };
    expect(await chatReply(boom, "sys", [], "")).toBeNull();
  });
});

describe("pet chat — sanitizeSegments & directorSegments", () => {
  const caps = {
    emotions: ["senang", "normal"],
    motions: [{ id: "TapBody", description: "" }],
  };

  it("motion/emosi di luar capabilities dibuang (LLM tak bisa mengarang)", () => {
    const segs = sanitizeSegments(
      [
        { text: "A", emotion: "kangen", motion: "NotExist" },
        { text: "B", emotion: "senang", motion: "TapBody", intensity: 5 },
        { text: "  ", emotion: "senang" },
      ],
      caps,
    );
    expect(segs).toEqual([
      { text: "A", actions: { emotion: "normal", motion: null, intensity: 0.8, durationMs: undefined } },
      { text: "B", actions: { emotion: "senang", motion: "TapBody", intensity: 1, durationMs: undefined } },
    ]);
  });

  it("director gagal → fallback 1 segmen netral dengan teks penuh", async () => {
    const boom = async (): Promise<never> => {
      throw new Error("500");
    };
    const segs = await directorSegments(boom, "halo dunia", caps);
    expect(segs).toEqual([{ text: "halo dunia", actions: { emotion: "normal", intensity: 0.5 } }]);
    expect(segmentTextFallback("  ")).toEqual([]);
  });

  it("director berhasil tapi kosong → fallback", async () => {
    const empty = async (): Promise<{ segments?: unknown[] }> => ({ segments: [] });
    const segs = await directorSegments(empty, "teks", caps);
    expect(segs.length).toBe(1);
    expect(segs[0].text).toBe("teks");
  });
});
