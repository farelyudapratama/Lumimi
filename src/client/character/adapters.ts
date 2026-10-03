/**
 * character/adapters.ts — Adapter murni: output keputusan existing → Intent
 * semantik milik Character Runtime (kontrak di ./runtime.ts).
 *
 * Sumber keputusan yang dinormalkan:
 *   - Director (core/src/director.rs handle_animate_text): array segmen
 *     {text, emotion, gesture, motion, intensity, paramDrive, durationMs}.
 *   - Behavior (core/src/behavior.rs fallback_decision/validate): satu objek
 *     {action, emotion, gaze, motion, holdMs, confidence, note}.
 *
 * Aturan adapter:
 *   - MURNI: tanpa DOM/fetch/localStorage, tidak pernah throw (input null,
 *     kosong, atau tipe salah → hasil kosong + catatan dropped).
 *   - Tidak mengubah pemanggil mana pun: ini fungsi pemetaan saja; runtime
 *     yang mengarbitrase (R1–R10 di runtime.ts).
 *   - Model-agnostic: id yang lewat adalah id SEMANTIK (emosi/gesture/klip).
 *     paramDrive (param mentah model) TIDAK PERNAH jadi intent — keputusan
 *     model dilarang menyentuh param Live2D langsung (aturan repo), jadi ia
 *     dicatat di dropped dengan alasan policy.
 *   - intensity & gaze tidak termasuk kontrak Intent → diabaikan diam-diam.
 */
import type { Domain, Intent, IntentKind, IntentSource } from "./runtime";

/** Satu field keputusan yang dibuang adapter + alasannya (bahan log/UI). */
export interface DroppedField {
  field: string;
  reason: string;
}

export interface AdapterResult {
  intents: Intent[];
  dropped: DroppedField[];
}

/** Fallback durasi action Director (ms) — selaras default backend. */
const DEFAULT_DIRECTOR_MS = 2500;
/** Fallback holdMs behavior (ms) — selaras clamp default backend. */
const DEFAULT_BEHAVIOR_MS = 2500;
/** Durasi mikro gaze-shift/micro-fidget bila holdMs absen (ms). */
const DEFAULT_MICRO_MS = 2000;

/** Aksi behavior yang dikenal adapter (kosakata core/src/behavior.rs). */
const KNOWN_BEHAVIOR_ACTIONS: ReadonlySet<string> = new Set([
  "idle-clip",
  "settle",
  "gaze-shift",
  "micro-fidget",
]);

/** String non-kosong (trim) atau null — total terhadap tipe apa pun. */
function nonEmpty(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

/** Angka ms positif valid atau fallback — durasi dari keputusan tak dipercaya mentah. */
function durMs(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Rakit Intent + stempel `at` bila pemanggil memberi now (ms). */
function makeIntent(
  kind: IntentKind,
  id: string,
  domains: Domain[],
  priority: number,
  source: IntentSource,
  durationMs: number | undefined,
  nowMs?: number,
): Intent {
  const intent: Intent = { kind, id, domains, priority, source };
  if (durationMs !== undefined) intent.durationMs = durationMs;
  if (nowMs !== undefined) intent.at = nowMs;
  return intent;
}

/**
 * Director → Intents. Tiap segmen boleh berkontribusi: emotion menjadi
 * expression persisten, gesture menjadi action berdurasi tetap, motion
 * (klip user) menjadi action berdurasi segmen. "normal"/kosong tidak
 * menghasilkan apa pun (netral). Selalu return objek utuh.
 */
export function directorToIntents(segments: unknown, nowMs?: number): AdapterResult {
  const out: AdapterResult = { intents: [], dropped: [] };
  if (!Array.isArray(segments)) return out;
  for (const seg of segments) {
    if (seg === null || typeof seg !== "object" || Array.isArray(seg)) continue;
    const s = seg as Record<string, unknown>;

    // emotion → expression tanpa durationMs (berlaku sampai diganti).
    const emotion = nonEmpty(s.emotion);
    if (emotion && emotion !== "normal") {
      out.intents.push(
        makeIntent("expression", emotion, ["affect"], 60, "director", undefined, nowMs),
      );
    }

    // gesture → action tubuh/kepala; durasi tetap (segmen tidak memberi durasi khusus).
    const gesture = nonEmpty(s.gesture);
    if (gesture) {
      out.intents.push(
        makeIntent("action", gesture, ["head", "body"], 80, "director", DEFAULT_DIRECTOR_MS, nowMs),
      );
    }

    // motion (klip Motion Studio milik user) → action berdurasi segmen.
    const motion = nonEmpty(s.motion);
    if (motion) {
      out.intents.push(
        makeIntent(
          "action",
          motion,
          ["head", "body"],
          80,
          "director",
          durMs(s.durationMs, DEFAULT_DIRECTOR_MS),
          nowMs,
        ),
      );
    }

    // paramDrive = param mentah model dari keputusan LLM → policy melarang;
    // dicatat sebagai dropped, bukan diteruskan. Null berarti tak ada usulan.
    if (s.paramDrive !== null && s.paramDrive !== undefined) {
      out.dropped.push({ field: "paramDrive", reason: "raw-param-ditolak-policy" });
    }
    // intensity: bukan bagian kontrak Intent → diabaikan diam-diam.
  }
  return out;
}

/**
 * Keputusan behavior (idle) → Intent. Satu keputusan menghasilkan MAKSIMAL
 * satu intent: idle-clip mempriorasikan klip, lalu emosi; settle/gaze-shift/
 * micro-fidget jadi action berdurasi holdMs. action kosong/di luar kosakata →
 * dropped "action-tak-dikenal" (keputusan tidak diteruskan apa adanya).
 */
export function behaviorToIntents(d: unknown, nowMs?: number): AdapterResult {
  const out: AdapterResult = { intents: [], dropped: [] };
  const obj: Record<string, unknown> =
    d !== null && typeof d === "object" && !Array.isArray(d)
      ? (d as Record<string, unknown>)
      : {};

  const action = nonEmpty(obj.action);
  if (!action || !KNOWN_BEHAVIOR_ACTIONS.has(action)) {
    out.dropped.push({ field: "action", reason: "action-tak-dikenal" });
    return out;
  }

  if (action === "idle-clip") {
    const motion = nonEmpty(obj.motion);
    if (motion) {
      out.intents.push(
        makeIntent(
          "action",
          motion,
          ["body"],
          50,
          "behavior",
          durMs(obj.holdMs, DEFAULT_BEHAVIOR_MS),
          nowMs,
        ),
      );
      return out;
    }
    const emotion = nonEmpty(obj.emotion);
    if (emotion) {
      out.intents.push(
        makeIntent("expression", emotion, ["affect"], 50, "behavior", undefined, nowMs),
      );
      return out;
    }
    // idle-clip tanpa klip & tanpa emosi → tidak ada yang bisa diekspresikan.
    out.dropped.push({ field: "action", reason: "idle-clip-tanpa-target" });
    return out;
  }

  if (action === "settle") {
    out.intents.push(
      makeIntent(
        "action",
        "settle",
        ["gaze"],
        40,
        "behavior",
        durMs(obj.holdMs, DEFAULT_BEHAVIOR_MS),
        nowMs,
      ),
    );
    return out;
  }

  // gaze-shift / micro-fidget: gerak halus pandang + kepala, durasi mikro.
  out.intents.push(
    makeIntent(
      "action",
      action,
      ["gaze", "head"],
      40,
      "behavior",
      durMs(obj.holdMs, DEFAULT_MICRO_MS),
      nowMs,
    ),
  );
  return out;
}

/** Saring param apertur dari konteks param yang dikirim ke Director:
 * keputusan model tidak pernah MELIHAT param bukaan mulut — kepemilikannya
 * lipsync; Director yang menyentuhnya berujung freeze (SET 900 > lipsync 450).
 * Ini lapisan pencegahan di sumber; gerbang tulis tetap ada di bridge. */
export function dropApertureParamCtx<T extends { id: string }>(
  ctx: T[],
  apertureIds: string[],
): T[] {
  if (!apertureIds.length) return ctx.slice();
  const owned = new Set(apertureIds);
  return ctx.filter((p) => !owned.has(p.id));
}
