/**
 * shared/types.ts — Single source of truth for all data shapes.
 * Server and client both import from here.
 */

// ── Config ─────────────────────────────────────────────────────
export interface Connection {
  id: string;
  name: string;
  provider: LLMProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number;
  // Stream mode (SSE): bytes mengalir kontinu sehingga gateway agresif
  // (mis. faucet yang memotong generasi lambat lalu menagih token tanpa
  // hasil) tidak kehilangan jawaban panjang. Parser klien merakit ulang
  // chunk delta jadi jawaban penuh; non-stream tetap default.
  stream?: boolean;
  // Peran FUNGSIONAL koneksi ini (multi-LLM role routing). Array kosong atau
  // field absen = WILDCARD — boleh dipakai untuk semua peran (config lama
  // tetap jalan tanpa diedit). Daftar sah: LLM_ROLES di llm-client.ts.
  roles?: string[];
  testStatus: "idle" | "success" | "error";
  // false = dimatikan sementara: dilewati semua pemilihan koneksi (fallback &
  // role routing) tanpa menghapus konfigurasinya. undefined = aktif.
  enabled?: boolean;
  lastError?: string;
  rateLimitedUntil?: string;
}

export type LLMProvider =
  | "openai-compatible"
  | "openai"
  | "gemini"
  | "groq"
  | "anthropic"
  // Mesin KEPUTUSAN terstruktur (Jev cloud / Laya lokal) — bukan provider teks.
  // Dipakai koneksi role "behavior": POST {baseUrl}/v1/systemone. Tak punya
  // /chat/completions; jangan dipilih untuk role chat/motion/sheet/assistant.
  | "systemone"
  | "mock";

export interface Config {
  activeId: string | null;
  connections: Connection[];
  // Mesin suara karakter. provider: "browser" (speechSynthesis, default) |
  // "gradio" | "openai" | "elevenlabs" | "gemini" | "custom". endpoint/apiKey
  // hanya untuk provider remote; apiKey disimpan plaintext di config.json
  // (sama seperti connections) dan DIMASK saat dikirim ke UI.
  // format: bentuk audio yang diminta dari server OpenAI-compat (default "mp3";
  // pakai "wav" untuk server yang tak mendukung mp3, mis. supertonic serve).
  tts: { provider?: string; endpoint: string; apiKey?: string; voice?: string; model?: string; style?: string; hematRequest?: boolean; format?: "mp3" | "wav" | "flac" | "ogg" };
  events: EventConfig;
  camera: CameraConfig;
  motion: MotionConfig;
  stt: SttConfig;
  // Bahasa UI & bahasa balasan AI. "auto" = belum dipilih (server
  // memperlakukannya sebagai "id"); klien menulis nilai konkret saat
  // first-run / ganti bahasa di panel pengaturan.
  i18n: I18nConfig;
  // Koneksi stream VTuber tersimpan (prefill form Stream Settings). apiKey
  // plaintext di config.json (sama seperti connections/tts), DIMASK ke UI.
  // Opsional: config lama tanpa field ini valid.
  vtuber?: { provider?: string; channel?: string; videoId?: string; apiKey?: string; persona?: string; cooldownMs?: number; respondChat?: boolean; respondDonation?: boolean };
}

export interface I18nConfig {
  lang: "auto" | "id" | "en";
}

export interface EventConfig {
  idleSpeak: boolean;
  idleMs: number;
  idleRepeatMs: number;
  awaySpeak: boolean;
  returnSpeak: boolean;
  awayHiddenMs: number;
  quietMs: number;
}

export interface CameraConfig {
  enabled: boolean;
  fps: number;
  presenceThreshold: number;
  device: string;
  model: string;
  moodGraceMs: number;
  moodDebounceMs: number;
  moodStableTicks: number;
}

export interface MotionConfig {
  enabled: boolean;
  gain: number;
}

// STT dua arah — Whisper lokal di browser (push-to-talk, audio tidak di-upload).
export interface SttConfig {
  // Provider transkripsi:
  //   "local"   → whisper in-process di server Rust core (whisper-rs) — DEFAULT proyek
  //   "browser" → Whisper transformers.js in-browser (audio tak keluar tab)
  //   "openai"  → server OpenAI-compatible /v1/audio/transcriptions (cloud)
  provider?: string;
  model: string;       // (browser) repo HF, mis. Xenova/whisper-base
  engineModel?: string; // (local) nama model GGML whisper, mis. "base"|"tiny"|"small"
  endpoint?: string;   // (openai) base URL server transcription; kosong = resmi OpenAI
  apiKey?: string;     // (openai) kunci — plaintext di config.json, DIMASK ke UI
  apiModel?: string;   // (openai) nama model API, mis. "whisper-1" | "whisper-large-v3-turbo"
  language: string;    // "indonesian" | "auto" | kode bahasa Whisper lain
  autoSend: boolean;   // true = kirim otomatis; false = isi input untuk direview
  silenceMs: number;   // auto-stop setelah sekian ms senyap (sempat bicara)
  maxMs: number;       // batas keras durasi rekaman
  device: string;      // (browser) "" = auto (webgpu → wasm) | "wasm" = paksa CPU
}

// ── Model / Sheet ──────────────────────────────────────────────
export interface ParamInfo {
  id: string;
  min: number;
  max: number;
  def: number;
  group: string;
  label: string;
  userNote?: string;
  estimated?: boolean;
}

export interface PartInfo {
  id: string;
  opacity: number;
}

export interface RoleMapping {
  role: string;
  paramId: string;
}

export interface SheetPreset {
  name: string;
  category: PresetCategory;
  values: Record<string, number>;
  parts?: Record<string, number>;
  source?: "user" | "ai";
  suggestion?: boolean;
}

export type PresetCategory = "emosi" | "properti" | "aksesoris" | "gerak";

export interface CharacterSheet {
  schemaVersion: number;
  params: ParamInfo[];
  parts: PartInfo[];
  paramGroups: { user: Record<string, string>; ai: Record<string, string> };
  presets: { user: Record<PresetCategory, SheetPreset[]>; ai: Record<PresetCategory, SheetPreset[]> };
  userNote: string;
  config: Record<string, unknown>;
}

// ── Motion ─────────────────────────────────────────────────────
export interface MotionTrack {
  kind: "role" | "param";
  param?: string;         // for kind=param
  target?: string;        // for kind=role (ax, ay, bodyX, etc.)
  interp: EasingMode;
  keys: Keyframe[];
  label?: string;
  min?: number;
  max?: number;
}

export interface Keyframe {
  t: number;
  v: number;
  easing?: EasingMode;
}

export type EasingMode = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "stepped";

export interface MotionAsset {
  version: number;
  id: string;
  name: string;
  description: string;
  tags: string[];
  source: "builtin" | "native" | "user";
  type: string;
  duration: number;
  loop: boolean;
  intensity: { min: number; max: number; default: number };
  emotionCompatibility: Record<string, number>;
  cooldown: number;
  priority: number;
  aiEnabled: boolean;
  requires: string[];
  tracks: MotionTrack[];
  sourceModelId?: string;
}

// ── LLM ────────────────────────────────────────────────────────
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LLMResponse {
  reply: string;
  used: string;
}

// ── Agent Directives ───────────────────────────────────────────
export type DirectiveType =
  | "EMOTION" | "EXPR" | "HEAD" | "EYES" | "MOUTH"
  | "BODY" | "ACC" | "PROP" | "PROPERTY" | "GESTURE"
  | "MOTION" | "INTENSITY";

export interface ParsedActions {
  emotion?: string;
  head?: { x: number; y: number };
  eyes?: { x: number; y: number };
  mouth?: { form: number; open: number };
  body?: { x: number; y: number; z: number };
  accessories?: Record<string, number>;
  property?: string;
  gesture?: string;
  motion?: string;
  intensity?: number;
  // Param mentah model yang disetel director untuk ekspresi lebih menjiwai
  // (id NYATA milik model → nilai sudah tervalidasi & di-clamp ke range oleh
  // server). Ditulis lewat applyParamDrive dan dilepas saat balasan selesai.
  paramDrive?: Record<string, number>;
  // Perkiraan durasi ucapan segment (ms) — dipakai sebagai fitToMs motion.
  durationMs?: number;
}

export interface ParsedSegment {
  text: string;
  actions: ParsedActions;
}

// ── API ────────────────────────────────────────────────────────
export interface APIResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface CapabilityProfile {
  emotions: string[];
  nativeExpressions: string[];
  accessories: string[];
  properties: string[];
  gestures: string[];
  motionCatalog: MotionAsset[];
  sheet: CharacterSheet | null;
  userNote: string;
  roleIds: Record<string, string>;
  paramRange: Record<string, { min: number; max: number; def: number }>;
}
