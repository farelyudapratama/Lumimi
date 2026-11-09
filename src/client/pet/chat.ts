/**
 * pet/chat — pipeline giliran suara pet: STT → chat → director → TTS.
 *
 * Semua primitif jaringan di-inject (transport) supaya bisa diuji bun test
 * dengan fetch stub (aturan repo: TIDAK ada test yang memanggil jaringan).
 * Orkestrasi audio/lip-sync ada di pet-entry (DOM); modul ini murni alur
 * data:
 *
 *   WAV mic → POST /api/stt {text}
 *           → POST /api/chat-stream (SSE, role chat) balasan
 *           → POST /api/animate-text (director, capabilities nyata model)
 *           → per segmen: POST /api/tts → Blob audio
 */

import { readSseStream } from "../agent/panel/stream";

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
export type PostJson = <T = any>(path: string, body: unknown) => Promise<T>;

/** Segmen hasil director (bentuk sama dengan ParsedSegment brain.ts). */
export interface Segment {
  text: string;
  actions: {
    emotion?: string | null;
    motion?: string | null;
    intensity?: number;
    durationMs?: number;
  };
}

// ── STT ──────────────────────────────────────────────────────────────────

/** POST /api/stt (audio/wav) → teks. Gagal → null (fail-soft). */
export async function sttText(apiFetch: ApiFetch, wav: Uint8Array): Promise<string | null> {
  try {
    const r = await apiFetch("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav as unknown as BodyInit,
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { text?: string };
    const t = String(d.text ?? "").trim();
    return t || null;
  } catch {
    return null;
  }
}

// ── Chat (SSE) ───────────────────────────────────────────────────────────

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Balasan chat companion (SSE, role "chat"). Idle timeout 45 dtk di-reset
 * per event — bukan timeout absolut (aturan stream LLM). Gagal → null.
 */
export async function chatReply(
  apiFetch: ApiFetch,
  system: string,
  history: ChatTurn[],
  memoryBlock: string,
): Promise<string | null> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), 45_000);
  };
  try {
    arm();
    const resp = await apiFetch("/api/chat-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: history.map((t) => ({ role: t.role, content: t.content })),
        system,
      }),
      signal: ctrl.signal,
    });
    let streamed = "";
    let finalReply = "";
    await readSseStream(resp, (ev) => {
      arm();
      if (ev.type === "delta" && typeof ev.text === "string") streamed += ev.text;
      if (ev.type === "done") {
        finalReply = typeof ev.reply === "string" ? ev.reply : "";
      }
    }, ctrl.signal);
    const out = (finalReply || streamed).trim();
    return out || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Director (topologi ekspresi per segmen) ──────────────────────────────

/** Fallback deterministik: seluruh teks jadi satu segmen netral. */
export function segmentTextFallback(text: string): Segment[] {
  const t = text.trim();
  return t ? [{ text: t, actions: { emotion: "normal", intensity: 0.5 } }] : [];
}

export interface DirectorCapabilities {
  emotions: string[];
  motions: { id: string; description: string }[];
}

/** Emosi/gesture/motion di luar capabilities dibuang director — dan di sini. */
export function sanitizeSegments(raw: unknown, caps: DirectorCapabilities): Segment[] {
  const validMotion = new Set(caps.motions.map((m) => m.id));
  const validEmotion = new Set(caps.emotions);
  const out: Segment[] = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    const seg = s as { text?: unknown; emotion?: unknown; motion?: unknown; intensity?: unknown; durationMs?: unknown };
    const text = String(seg.text ?? "").trim();
    if (!text) continue;
    const motion = typeof seg.motion === "string" && validMotion.has(seg.motion) ? seg.motion : null;
    const emotion = typeof seg.emotion === "string" && validEmotion.has(seg.emotion) ? seg.emotion : "normal";
    const intensity = typeof seg.intensity === "number" ? Math.min(1, Math.max(0.3, seg.intensity)) : 0.8;
    const durationMs = typeof seg.durationMs === "number" ? seg.durationMs : undefined;
    out.push({ text, actions: { emotion, motion, intensity, durationMs } });
  }
  return out.length ? out : [];
}

/** POST /api/animate-text → segmen; gagal → fallback 1 segmen netral. */
export async function directorSegments(
  post: PostJson,
  text: string,
  caps: DirectorCapabilities,
  characterName?: string,
): Promise<Segment[]> {
  try {
    const res = await post<{ segments?: unknown }>("/api/animate-text", {
      text,
      capabilities: {
        emotions: caps.emotions,
        // Pet tanpa gesture library — kosong, director tak akan mengarang.
        gestures: [],
        motions: caps.motions,
        expressionAssetsPoor: caps.motions.length === 0,
      },
      characterName: characterName || "",
    });
    const segs = sanitizeSegments(res?.segments, caps);
    return segs.length ? segs : segmentTextFallback(text);
  } catch {
    return segmentTextFallback(text);
  }
}

// ── TTS ──────────────────────────────────────────────────────────────────

/** POST /api/tts → blob audio (SuperTonic in-process / provider user). */
export async function ttsBlob(
  apiFetch: ApiFetch,
  text: string,
  ttsLang?: string,
): Promise<Blob | null> {
  try {
    const r = await apiFetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ttsLang ? { text, ttsLang } : { text }),
    });
    if (!r.ok) return null;
    return await r.blob();
  } catch {
    return null;
  }
}
