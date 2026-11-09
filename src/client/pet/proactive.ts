/**
 * pet/proactive — komentar unprompted ber-budget untuk Desktop Pet.
 *
 * Ala director REAKyndred (UNPROMPTED_PER_HOUR=3 + cooldown per line) tapi
 * versi Lumimi: budget 3/jam, masa tenang 30 menit setelah interaksi
 * sentuh, dan sumber teks = /api/chat-stream (role chat) dengan turn
 * sintetis [EVENT:...]. Loop ini MILIK pet — sengaja TIDAK memakai
 * proactiveAllowed() brain.ts yang menolak mode non-stage.
 *
 * Budget dipersist (localStorage via injectable) supaya restart jendela
 * pet tidak meng-reset anggaran. Murni — waktu & penyimpanan di-inject.
 * Konsumsi SSE memakai readSseStream panel (parser yang sama, tanpa
 * duplikasi); guard timeout memakai IDLE timeout (reset per event), bukan
 * timeout absolut — aturan repo untuk stream LLM.
 */

import { readSseStream, type AsSseEvent } from "../agent/panel/stream";

export const PROACTIVE_DEFAULTS = {
  /** Maks komentar unprompted per jam bergulir. */
  maxPerHour: 3,
  /** Masa tenang setelah interaksi sentuh sebelum boleh nyahat lagi. */
  quietAfterInteractionMs: 30 * 60 * 1000,
  /** Komentar hanya saat user "hadir": gerakan kursor dalam jendela ini. */
  presenceWindowMs: 5 * 60 * 1000,
  /** Jeda antar komentar (bukan cuma budget). */
  minGapMs: 20 * 60 * 1000,
  /** Jendela budget bergulir. */
  hourMs: 60 * 60 * 1000,
} as const;

export interface BudgetStore {
  /** Timestamp komentar terakhir (ms epoch/monotonic bebas — konsisten). */
  stamps: number[];
}

export interface BudgetOpts extends Partial<typeof PROACTIVE_DEFAULTS> {
  now(): number;
  load?(): BudgetStore | null;
  save?(s: BudgetStore): void;
}

export interface Budget {
  /** Boleh komentar sekarang? (budget + tenang + hadir + gap). */
  canFire(sinceInteractionMs: number | null, sinceMovementMs: number | null): boolean;
  /** Catat komentar baru. */
  record(): void;
  /** Sisa anggaran jam ini (log/telemetri). */
  remaining(): number;
}

export function createBudget(opts: BudgetOpts): Budget {
  const c = { ...PROACTIVE_DEFAULTS, ...opts };
  let stamps: number[] = (opts.load?.()?.stamps ?? []).filter((t) => Number.isFinite(t));

  const persist = (): void => {
    try {
      opts.save?.({ stamps: stamps.slice(-16) });
    } catch {}
  };

  return {
    canFire(sinceInteractionMs, sinceMovementMs) {
      const now = c.now();
      // Prune jendela bergulir.
      stamps = stamps.filter((t) => now - t < c.hourMs);
      if (stamps.length >= c.maxPerHour) return false;
      if (sinceInteractionMs !== null && sinceInteractionMs < c.quietAfterInteractionMs) return false;
      // User harus HADIR (gerakan kursor segar) — mengomentari ruangan
      // kosong itu mengganggu.
      if (sinceMovementMs === null || sinceMovementMs > c.presenceWindowMs) return false;
      const last = stamps.length ? stamps[stamps.length - 1] : -Infinity;
      if (now - last < c.minGapMs) return false;
      return true;
    },
    record() {
      stamps.push(c.now());
      persist();
    },
    remaining() {
      const now = c.now();
      stamps = stamps.filter((t) => now - t < c.hourMs);
      return Math.max(0, c.maxPerHour - stamps.length);
    },
  };
}

// ── Sumber teks: /api/chat-stream (SSE) ──────────────────────────────────

/** Sistem prompt companion pet: balasan SATU kalimat pendek. */
export const PET_SYSTEM_PROMPT =
  "Kamu adalah pet desktop kecil yang tinggal di layar pemakai. " +
  "Balas HANYA SATU kalimat pendek (maksimal 20 kata), hangat dan playful, " +
  "tanpa format, tanpa tanda kutip. Jangan menawarkan bantuan berlebihan.";

/** Turn sintetis — protokol [EVENT:] sama dengan brain.ts reactEvent. */
export function eventTurn(event: string, detail?: string): string {
  return detail ? `[EVENT:${event}] ${detail}` : `[EVENT:${event}]`;
}

/** Fetch injectable (transport.apiFetch) — test pakai Response stub. */
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Idle timeout stream (reset per event) — bukan timeout absolut. */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;

/**
 * Minta satu komentar proaktif. Konteks memori (fail-soft) diselipkan agar
 * komentar terasa kenal pada user. Gagal → null. Tidak pernah melempar.
 */
export async function fetchProactiveLine(
  apiFetch: ApiFetch,
  event: string,
): Promise<string | null> {
  // Konteks memori (fail-soft).
  let memory = "";
  try {
    const r = await apiFetch("/api/companion/memory?limit=3");
    if (r.ok) {
      const m = (await r.json()) as { entries?: { text?: string }[] };
      const lines = (m?.entries ?? []).map((e) => String(e.text ?? "")).filter(Boolean);
      if (lines.length) memory = "Konteks kenangan: " + lines.join("; ");
    }
  } catch {}

  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    // globalThis (bukan window): modul ini juga dipakai bun test.
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), STREAM_IDLE_TIMEOUT_MS);
  };
  try {
    armIdle();
    const resp = await apiFetch("/api/chat-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: eventTurn(event, memory || undefined) }],
        system: PET_SYSTEM_PROMPT,
      }),
      signal: ctrl.signal,
    });
    let streamed = "";
    let finalReply = "";
    await readSseStream(resp, (ev: AsSseEvent) => {
      armIdle(); // reset idle timeout per event
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
