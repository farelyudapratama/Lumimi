/**
 * shared/config.ts — Config management with atomic writes + queue.
 */
import { Config, Connection } from "./types";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";

const DEFAULT_CONFIG: Config = {
  activeId: null,
  connections: [],
  // TTS default: SuperTonic native (in-process di core Rust, model on-demand).
  // Provider lain (browser/gradio/openai/elevenlabs/gemini/custom) tetap bisa
  // dipilih user; hanya default install baru yang native.
  tts: { provider: "supertonic", endpoint: "", voice: "F1" },
  events: {
    idleSpeak: true,
    idleMs: 1_800_000,
    idleRepeatMs: 1_800_000,
    awaySpeak: true,
    returnSpeak: true,
    awayHiddenMs: 10_000,
    quietMs: 1_800_000,
  },
  camera: {
    enabled: false,
    fps: 0.4,
    presenceThreshold: 0.4,
    device: "webgpu",
    model: "Xenova/facial_emotions_image_detection",
    moodGraceMs: 20_000,
    moodDebounceMs: 5000,
    moodStableTicks: 2,
  },
  motion: { enabled: false, gain: 1.5 },
  // Bahasa UI + bahasa balasan AI. "auto" = user belum memilih → klien
  // mendeteksi navigator.language saat first-run dan menulis nilai konkret;
  // server memperlakukan "auto" sebagai "id". (Pola backfill sama dengan stt:
  // seksi baru di DEFAULT_CONFIG otomatis terisi ke config.json lama.)
  i18n: { lang: "auto" },
  // STT dua arah (push-to-talk, Whisper lokal di browser — audio tidak di-upload).
  // device "" = auto (webgpu bila ada, lalu wasm); language "auto" = deteksi sendiri.
  stt: {
    provider: "local",          // in-process native (Whisper via whisper-rs di core)
    engineModel: "base",         // model GGML native (setara whisper-base browser)
    model: "Xenova/whisper-base", // dipakai bila provider "browser"
    language: "indonesian",
    autoSend: true,
    silenceMs: 1500,
    maxMs: 30_000,
    device: "",
    endpoint: "",                // (openai) base URL transcription; kosong = resmi OpenAI
    apiKey: "",                  // (openai) kunci — plaintext di config.json, dimask ke UI
    apiModel: "whisper-1",       // (openai) nama model API
  },
};

export const KNOWN_EVENT_KEYS = ["idleSpeak","idleMs","idleRepeatMs","awaySpeak","returnSpeak","awayHiddenMs","quietMs"];

export function mergeEventsIntoConfig(prev: any, incoming: any): any {
  const base = (typeof prev === "object" && prev) ? prev : {};
  const merged = Object.assign({}, base.events || {}, incoming || {});
  const clean: Record<string, unknown> = {};
  for (const k of KNOWN_EVENT_KEYS) if (k in merged) (clean as any)[k] = (merged as any)[k];
  return Object.assign({}, base, { events: clean });
}

const _writeQueues = new Map<string, Promise<void>>();

function writeJsonAtomic(file: string, obj: unknown) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "." + file.split(/[\\/]/).pop() + "." + process.pid + "." + Date.now() + ".tmp");
  const text = JSON.stringify(obj, null, 2);
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw e;
  }
}

function queueJsonWrite(file: string, obj: unknown): Promise<void> {
  const prev = _writeQueues.get(file) || Promise.resolve();
  const done = prev.then(() => writeJsonAtomic(file, obj), () => writeJsonAtomic(file, obj));
  const tail = done.catch(() => {});
  _writeQueues.set(file, tail);
  tail.then(() => { if (_writeQueues.get(file) === tail) _writeQueues.delete(file); });
  return done;
}

/**
 * Merge daftar koneksi per-id: snapshot runtime (testStatus/lastError dari
 * llmWithFallback) menang atas file untuk field yang dia punya, TAPI field
 * yang hanya ada di file — mis. maxTokens/stream/roles yang diedit tangan
 * saat server berjalan — tidak boleh lenyap. Koneksi baru di salah satu
 * sumber tetap masuk; urutan mengikuti snapshot runtime.
 */
export function mergeConnectionsById(base: unknown, over: unknown): Connection[] {
  const b = Array.isArray(base) ? (base as Connection[]) : [];
  const o = Array.isArray(over) ? (over as Connection[]) : [];
  if (!b.length) return o;
  if (!o.length) return b;
  const byId = new Map(b.map((c) => [c.id, c] as const));
  const out: Connection[] = [];
  const seen = new Set<string>();
  for (const c of o) {
    const f = byId.get(c.id);
    out.push(f ? { ...f, ...c } : c);
    seen.add(c.id);
  }
  for (const c of b) if (!seen.has(c.id)) out.push(c);
  return out;
}

export class ConfigManager {
  private path: string;
  private cache: Config | null = null;
  private runtimeOverrides: Partial<Config> = {};

  constructor(dataDir: string) {
    this.path = join(dataDir, "config.json");
    this.ensureDefault();
  }

  private ensureDefault(): void {
    if (!existsSync(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(DEFAULT_CONFIG, null, 2));
      console.log("  (config.json tidak ditemukan — membuat default)");
    }
  }

  load(): Config {
    try {
      const base = JSON.parse(readFileSync(this.path, "utf8"));
      // Section yang belum ada di file user (mis. `stt` pada config lama) diisi
      // dari default; section yang sudah ada tetap milik user utuh.
      this.cache = {
        ...DEFAULT_CONFIG,
        ...base,
        ...this.runtimeOverrides,
        // connections JANGAN ditimpa mentah-mentah oleh runtime override —
        // kalau tidak, edit manual di config.json (maxTokens, stream, roles)
        // hilang setiap kali proses server menyimpan snapshot lamanya.
        // Merge per-id: snapshot runtime menang untuk field miliknya
        // (testStatus/lastError), field yang hanya ada di file tetap hidup.
        connections: mergeConnectionsById((base as any).connections, (this.runtimeOverrides as any).connections),
        activeId: this.runtimeOverrides.activeId ?? (base as any).activeId,
      };
    } catch {
      this.cache = { ...this.runtimeOverrides } as Config;
    }
    return this.cache as Config;
  }

  get connections(): Connection[] {
    const cfg = this.load();
    return Array.isArray(cfg.connections) ? cfg.connections : [];
  }

  get activeConnection(): Connection | null {
    const conns = this.connections;
    if (!conns.length) return null;
    const cfg = this.load();
    return conns.find((c) => c.id === cfg.activeId) ?? conns[0] ?? null;
  }

  get events() { return this.load().events; }
  get camera() { return this.load().camera; }
  get motion() { return this.load().motion; }

  saveConnections(conns: Connection[], activeId: string | null): void {
    let prev: any = {};
    try { prev = JSON.parse(readFileSync(this.path, "utf8")); } catch {}
    const data = Object.assign({}, prev, { activeId: activeId ?? conns[0]?.id ?? null, connections: conns });
    this.runtimeOverrides = { activeId: data.activeId, connections: data.connections };
    try { writeJsonAtomic(this.path, data); } catch (e: any) { console.warn("[config] gagal menyimpan:", e.message); }
  }

  saveEvents(events: any): void {
    let prev: any = {};
    try { prev = JSON.parse(readFileSync(this.path, "utf8")); } catch {}
    const data = mergeEventsIntoConfig(prev, events);
    try { writeJsonAtomic(this.path, data); } catch (e: any) { console.warn("[config] gagal menyimpan events:", e.message); }
  }

  // TTS section utuh milik user; merge agar field lama (apiKey/voice/model)
  // tidak hilang saat UI lama cuma mengirim {endpoint}.
  saveTTS(tts: any): void {
    let prev: any = {};
    try { prev = JSON.parse(readFileSync(this.path, "utf8")); } catch {}
    const merged = Object.assign({}, prev.tts || {}, tts || {});
    const data = Object.assign({}, prev, { tts: merged });
    try { writeJsonAtomic(this.path, data); } catch (e: any) { console.warn("[config] gagal menyimpan tts:", e.message); }
  }

  // i18n section utuh milik user (lang: "auto" | "id" | "en").
  saveI18n(i18n: any): void {
    let prev: any = {};
    try { prev = JSON.parse(readFileSync(this.path, "utf8")); } catch {}
    const merged = Object.assign({}, prev.i18n || {}, i18n || {});
    const data = Object.assign({}, prev, { i18n: merged });
    try { writeJsonAtomic(this.path, data); } catch (e: any) { console.warn("[config] gagal menyimpan i18n:", e.message); }
  }

  // Koneksi stream VTuber (provider/channel/videoId/apiKey/persona/…).
  // Merge per-field: start dengan provider lain (mis. mock) tidak boleh
  // menghapus channel/key YouTube yang tersimpan. apiKey yang datang sudah
  // TERMASK dari UI (pola sama dengan connections) — nilai asli hanya ada
  // di config.json, tidak pernah balik ke HTTP.
  saveVtuberConn(conn: any): void {
    let prev: any = {};
    try { prev = JSON.parse(readFileSync(this.path, "utf8")); } catch {}
    const next = Object.assign({}, prev.vtuber || {});
    for (const k of ["provider", "channel", "videoId", "apiKey", "persona", "cooldownMs", "respondChat", "respondDonation"]) {
      if (conn[k] === undefined) continue;
      if (k === "apiKey") {
        const v = String(conn[k] || "").trim();
        // Masked / placeholder / kosong = pertahankan yang tersimpan.
        if (!v || v.includes("••••") || v.startsWith("MASUKKAN")) continue;
      }
      next[k] = conn[k];
    }
    const data = Object.assign({}, prev, { vtuber: next });
    try { writeJsonAtomic(this.path, data); } catch (e: any) { console.warn("[config] gagal menyimpan koneksi vtuber:", e.message); }
  }

  atomicWriteRaw(file: string, obj: unknown): Promise<void> { return queueJsonWrite(file, obj); }

  maskKey(k: string): string {
    if (!k || k.startsWith("MASUKKAN")) return k || "";
    return k.slice(0, 6) + "••••••••" + k.slice(-4);
  }
}

export { queueJsonWrite, writeJsonAtomic, DEFAULT_CONFIG };
