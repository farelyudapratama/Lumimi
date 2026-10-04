/**
 * shared/llm-client.ts — Multi-provider LLM client.
 * Supports: openai-compatible, gemini, groq, openai, anthropic, mock.
 */
import type { ChatMessage, Connection, LLMProvider } from "./types";

const TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface ErrorRule { text?: string; status?: number; cooldownMs?: number; backoff?: boolean; }

const ERROR_RULES: ErrorRule[] = [
  { text: "no credentials", cooldownMs: 120_000 },
  { text: "request not allowed", cooldownMs: 5000 },
  { text: "improperly formed request", cooldownMs: 120_000 },
  { text: "rate limit", backoff: true },
  { text: "too many requests", backoff: true },
  { text: "quota exceeded", backoff: true },
  { text: "capacity", backoff: true },
  { text: "overloaded", backoff: true },
  { status: 401, cooldownMs: 120_000 },
  { status: 402, cooldownMs: 120_000 },
  { status: 403, cooldownMs: 120_000 },
  { status: 404, cooldownMs: 120_000 },
  { status: 429, backoff: true },
];

function classifyError(status: number, text: string): { shouldFallback: boolean; cooldownMs: number } {
  const lower = (text || "").toLowerCase();
  for (const rule of ERROR_RULES) {
    if (rule.text && lower.includes(rule.text)) return { shouldFallback: true, cooldownMs: rule.cooldownMs ?? 30_000 };
    if (rule.status && rule.status === status) return { shouldFallback: true, cooldownMs: rule.cooldownMs ?? 30_000 };
  }
  return { shouldFallback: true, cooldownMs: 30_000 };
}

const DEFAULT_MODELS: Record<string, string> = {
  gemini: "gemini-2.0-flash",
  groq: "llama-3.3-70b-versatile",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
};

function cleanKey(key: string): string {
  return String(key ?? "").replace(/[\u0000-\u001F\u007F\u00A0\u200B\u200C\u200D\uFEFF]+/g, "").trim();
}

function buildChatMessages(messages: ChatMessage[], system: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "system") continue;
    out.push({ role: m.role === "user" ? "user" : "assistant", content: m.content });
  }
  return out;
}

function toGeminiContents(messages: ChatMessage[]) {
  return messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.content }] }));
}

// Bun-native fetch with timeout + size cap. `idle` = timeout di-reset setiap
// kali body mengalir (dipakai saat conn.stream=true): gateway stream lambat
// (faucet + model reasoning bisa >60 dtk TOTAL tapi tak pernah diam >60 dtk)
// tidak boleh dibunuh oleh batas absolut — yang membunuh adalah SENYAP.
async function postJson(urlStr: string, body: string, headers: Record<string, string> = {}, opts: { idle?: boolean } = {}): Promise<any> {
  const controller = new AbortController();
  let timedOut = false;
  let to = setTimeout(() => { timedOut = true; controller.abort(new Error(`timeout: LLM tidak merespon dalam ${TIMEOUT_MS / 1000}s`)); }, TIMEOUT_MS);
  const reset = () => { if (!timedOut) { clearTimeout(to); to = setTimeout(() => { timedOut = true; controller.abort(new Error(`timeout: LLM senyap ${TIMEOUT_MS / 1000}s`)); }, TIMEOUT_MS); } };
  try {
    const resp = await fetch(urlStr, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      signal: controller.signal,
    });
    let text: string;
    if (opts.idle && resp.body) {
      // Baca stream manual supaya setiap chunk yang datang meng-reset timer.
      const reader = resp.body.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) { chunks.push(value); reset(); }
      }
      const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }
      text = new TextDecoder().decode(merged);
    } else {
      text = await resp.text();
    }
    // Cap 2 MB dihitung dalam BYTE (bukan karakter) — balasan CJK bisa 3x lebih
    // besar dalam byte daripada panjang stringnya.
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("respon LLM terlalu besar");
    const json = extractJSON(text);
    if (!resp.ok) {
      const e: any = new Error(`HTTP ${resp.status}: ${json?.error?.message ?? text.slice(0, 200)}`);
      e.statusCode = resp.status;
      throw e;
    }
    return json;
  } finally { clearTimeout(to); }
}

/**
 * Parse respons LLM yang toleran terhadap proxy tidak standar. Kasus nyata
 * (relay openai-compatible lokal): meski request tidak meminta stream, proxy
 * membalas Content-Type: text/event-stream dengan SATU JSON utuh yang
 * ditempel langsung ekornya `data: [DONE]` — JSON.parse murni gagal padahal
 * datanya lengkap. Tiga lapis: JSON murni → kumpulkan payload "data:" (chunk
 * delta streaming digabung) → potong objek pertama yang seimbang kurungnya.
 */
export function extractJSON(text: string): any {
  // Body kosong = kasus berbeda dari "bukan JSON": provider memutus/mematikan
  // respons diam-diam (faucet kering, relay tanpa status). Pesannya harus
  // mengarahkan ke tindakan, bukan sekadar menyebut JSON.
  if (!String(text || "").trim())
    throw new Error("respon KOSONG dari provider — relay/faucet mungkin kehabisan kuota atau memutus koneksi diam-diam; coba lagi sebentar atau pakai koneksi lain");
  try { return JSON.parse(text); } catch {}
  // 1) Body berbentuk SSE: ambil semua payload baris "data:".
  const dataLines: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)[ \t]*data:[ \t]*([^\n]*)/g)) {
    const p = m[1].trim();
    if (p && p !== "[DONE]") dataLines.push(p);
  }
  if (dataLines.length) {
    // Baris yang rusak (respons terpotong di tengah chunk) di-LEWATI, bukan
    // menggagalkan semuanya — konten parsial lebih berguna daripada error.
    const objs = dataLines
      .map((d) => { try { return JSON.parse(d); } catch { return null; } })
      .filter((o): o is any => o !== null);
    if (objs.length) {
      if (objs.length === 1) return objs[0];
      const merged: any = { choices: [{ message: { role: "assistant", content: "" } }] };
      for (const o of objs) {
        const c = o?.choices?.[0];
        const piece = c?.delta?.content ?? c?.message?.content ?? "";
        if (piece) merged.choices[0].message.content += piece;
        if (o?.usage) merged.usage = o.usage;
      }
      return merged;
    }
  }
  // 2) JSON utuh + sampah setelahnya: potong objek pertama yang seimbang
  //    kurung kurawalnya (string-aware, agar "}" di dalam teks tidak menghitung).
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (!depth) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  throw new Error("respon bukan JSON: " + text.slice(0, 200));
}

/**
 * Salvage array-of-objects dari balasan yang TERPOTONG (finishReason
 * MAX_TOKENS / koneksi putus di tengah array): satu per satu objek `{…}`
 * level-atas yang SELESAI di-parse; objek terakhir yang terpotong diabaikan.
 * Bukan pengganti parse utuh — ini penyelamat supaya 11 preset utuh tidak
 * dibuang hanya karena preset ke-12 kebelah. String-aware (koma/tanda kutip
 * di dalam string tidak dihitung sebagai kurung).
 */
export function salvageJSONArrayOfObjects(text: string): any[] {
  const src = String(text || "");
  const start = src.indexOf("[");
  if (start < 0) return [];
  const out: any[] = [];
  let depth = 0, objStart = -1, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") { if (depth === 0) objStart = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try { out.push(JSON.parse(src.slice(objStart, i + 1))); } catch { /* objek rusak → lewati */ }
        objStart = -1;
      } else if (depth < 0) break;   // kurung lebih tutup — struktur aneh, berhenti
    }
  }
  return out;
}

/**
 * Ekstraksi array-of-objects yang TAHAN model kecil (analyze-sheet /
 * classify-params). Urutan strategi:
 *  1. Parse langsung (array) — kasus sehat.
 *  2. Parse langsung (objek pembungkus: {presets:[…]}/{classifications:[…]}) —
 *     sebagian model membungkus meski diminta array telanjang.
 *  3. Pindai SEMUA blok `[…]` seimbang (string-aware), ambil kandidat
 *     TERAKHIR yang isinya array-of-objects — model kecil sering MENGULANG
 *     prompt (echo), dan contoh format ada di AWAL prompt; jawaban asli
 *     ada setelahnya. Mengambil array pertama = mengambil contoh dari prompt.
 *  4. salvageJSONArrayOfObjects — balasan terpotong di tengah array.
 */
export function extractJSONArrayLoose(text: string): any[] {
  const src = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  if (!src) return [];
  const looksLikeRecords = (a: any): a is any[] =>
    Array.isArray(a) &&
    a.length > 0 &&
    a.every((it) => it && typeof it === "object" && !Array.isArray(it));
  try {
    const direct = JSON.parse(src);
    if (looksLikeRecords(direct)) return direct;
    if (direct && typeof direct === "object") {
      for (const v of Object.values(direct as Record<string, unknown>)) {
        if (looksLikeRecords(v)) return v;
      }
    }
  } catch { /* lanjut pemindaian */ }
  const cands: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "[") { if (depth === 0) start = i; depth++; }
    else if (ch === "]") {
      depth--;
      if (depth === 0 && start >= 0) { cands.push(src.slice(start, i + 1)); start = -1; }
    }
  }
  for (let i = cands.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(cands[i]);
      if (looksLikeRecords(parsed)) return parsed;
      if (parsed && typeof parsed === "object") {
        for (const v of Object.values(parsed as Record<string, unknown>)) {
          if (looksLikeRecords(v)) return v;
        }
      }
    } catch { /* kandidat rusak → kandidat berikutnya */ }
  }
  return salvageJSONArrayOfObjects(src);
}

/**
 * Saudara extractJSONArrayLoose untuk balasan berupa SATU objek JSON
 * (motions/analyze, motions/generate). Pindai semua blok `{…}` seimbang
 * (string-aware), ambil kandidat TERAKHIR yang berhasil di-parse — model
 * kecil yang meng-echo prompt membawa TEMPLATE instruksi di awal (sering
 * bukan JSON valid, mis. `"<emosi>": 0.0-1.0`), jawaban asli ada setelahnya.
 * Null bila tidak ada yang bisa diparse.
 */
export function extractJSONObjectLoose(text: string): Record<string, unknown> | null {
  const src = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  if (!src) return null;
  try {
    const direct = JSON.parse(src);
    if (direct && typeof direct === "object" && !Array.isArray(direct))
      return direct as Record<string, unknown>;
  } catch { /* lanjut pemindaian */ }
  const cands: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) { cands.push(src.slice(start, i + 1)); start = -1; }
    }
  }
  for (let i = cands.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(cands[i]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch { /* kandidat rusak → kandidat berikutnya */ }
  }
  return null;
}

export async function callLLM(conn: Connection, messages: ChatMessage[], clientSystem: string = ""): Promise<string> {
  const provider = (conn.provider ?? "openai-compatible").toLowerCase() as LLMProvider;
  const apiKey = cleanKey(conn.apiKey);
  const model = conn.model || DEFAULT_MODELS[provider] || "";
  const temp = conn.temperature ?? 0.8;
  const maxT = conn.maxTokens ?? 2048;
  const sys = [conn.systemPrompt, clientSystem].filter(Boolean).join("\n\n");

  if (provider === "openai-compatible" || provider === "groq" || provider === "openai") {
    let base: string;
    if (provider === "openai-compatible") {
      base = (conn.baseUrl ?? "").replace(/\/+$/, "");
      if (!base) throw new Error("baseUrl belum diisi untuk openai-compatible");
    } else if (provider === "groq") base = "https://api.groq.com/openai/v1";
    else base = "https://api.openai.com/v1";
    // `stream` EKSPLISIT: false = default aman (sebagian relay salah paham
    // "field absen" sebagai stream mode dan membalas body event-stream rusak);
    // true = opt-in untuk gateway yang memotong generasi lambat — bytes yang
    // mengalir mencegah idle-timeout, dan extractJSON merakit ulang chunk-nya.
    const body = JSON.stringify({ model, messages: buildChatMessages(messages, sys), temperature: temp, max_tokens: maxT, stream: conn.stream === true });
    const r = await postJson(base + "/chat/completions", body, { Authorization: "Bearer " + apiKey }, { idle: conn.stream === true });
    const text = r?.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error(provider + " kosong: " + JSON.stringify(r).slice(0, 200));
    return text.trim();
  }
  if (provider === "mock") {
    const last = messages.filter((m) => m.role === "user").pop()?.content ?? "";
    await new Promise((r) => setTimeout(r, 300));
    return `Halo! Kamu bilang: "${last}". (Mode mock — isi apiKey di config.json untuk LLM sungguhan.)`;
  }
  if (provider === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = JSON.stringify({ systemInstruction: sys ? { parts: [{ text: sys }] } : undefined, contents: toGeminiContents(messages), generationConfig: { temperature: temp, maxOutputTokens: maxT, candidateCount: 1 } });
    const r = await postJson(url, body);
    const cand = r?.candidates?.[0];
    const text = cand?.content?.parts?.map((p: any) => p.text).join("") ?? "";
    if (!text) {
      // finishReason MAX_TOKENS + text kosong = seluruh budget habis untuk
      // "thinking" internal gemini-2.5 sebelum satu pun teks keluar — naikkan
      // maxTokens pada koneksi ini, bukan sekadar "coba lagi".
      const hint = cand?.finishReason === "MAX_TOKENS"
        ? " (finishReason=MAX_TOKENS: budget token habis untuk thinking — perbesar maxTokens di koneksi ini)"
        : "";
      throw new Error("Gemini kosong" + hint + ": " + JSON.stringify(r).slice(0, 200));
    }
    return text.trim();
  }
  if (provider === "anthropic") {
    const body = JSON.stringify({ model, system: sys || undefined, messages: messages.filter((m) => m.role !== "system"), max_tokens: Math.min(maxT, 4096), temperature: temp });
    const r = await postJson("https://api.anthropic.com/v1/messages", body, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" });
    const text = (r?.content ?? []).map((p: any) => p.text ?? "").join("");
    if (!text) throw new Error("Anthropic kosong: " + JSON.stringify(r).slice(0,200));
    return text.trim();
  }
  throw new Error("provider tidak dikenal: " + provider);
}

export interface LLMResult { reply: string; used: string; }

// Body kosong / bukan-JSON itu kegagalan TRANSIEN relay (faucet kering sesaat,
// respons terpotong) — tidak layak cooldown 30 detik di percobaan pertama.
// Coba sekali lagi koneksi yang sama secara senyap; gagal kedua kali baru
// diperlakukan seperti error biasa (cooldown + fallback).
async function callWithOneRetry(conn: Connection, messages: ChatMessage[], clientSystem: string): Promise<string> {
  try {
    return await callLLM(conn, messages, clientSystem);
  } catch (e: any) {
    if (/respon KOSONG|respon bukan JSON/.test(String(e?.message || "")))
      return await callLLM(conn, messages, clientSystem);
    throw e;
  }
}

// ── Streaming ──────────────────────────────────────────────────
export type StreamDelta = (chunk: string) => void;

/**
 * LLM dengan streaming token. Wire-format OpenAI (openai, groq,
 * openai-compatible) benar-benar mengalir; provider lain belum punya jalur
 * stream di sini — jawaban utuh dikirim sebagai SATU delta supaya pemanggil
 * tetap seragam. Return = teks balasan lengkap.
 */
export async function callLLMStream(conn: Connection, messages: ChatMessage[], clientSystem: string, onDelta: StreamDelta): Promise<string> {
  const provider = (conn.provider ?? "openai-compatible").toLowerCase() as LLMProvider;
  if (provider !== "openai-compatible" && provider !== "groq" && provider !== "openai") {
    const text = await callLLM(conn, messages, clientSystem);
    onDelta(text);
    return text;
  }
  let base: string;
  if (provider === "openai-compatible") {
    base = (conn.baseUrl ?? "").replace(/\/+$/, "");
    if (!base) throw new Error("baseUrl belum diisi untuk openai-compatible");
  } else if (provider === "groq") base = "https://api.groq.com/openai/v1";
  else base = "https://api.openai.com/v1";
  const apiKey = cleanKey(conn.apiKey);
  const model = conn.model || DEFAULT_MODELS[provider] || "";
  const temp = conn.temperature ?? 0.8;
  const maxT = conn.maxTokens ?? 2048;
  const sys = [conn.systemPrompt, clientSystem].filter(Boolean).join("\n\n");
  const body = JSON.stringify({ model, messages: buildChatMessages(messages, sys), temperature: temp, max_tokens: maxT, stream: true });

  // Timeout senyap (bukan total): setiap byte yang datang meng-reset —
  // reasoning panjang tidak boleh dibunuh, diam 60 dtk boleh.
  const controller = new AbortController();
  let timedOut = false;
  let to: ReturnType<typeof setTimeout> = setTimeout(() => { timedOut = true; controller.abort(new Error("timeout: LLM senyap 60s")); }, TIMEOUT_MS);
  const reset = () => { if (!timedOut) { clearTimeout(to); to = setTimeout(() => { timedOut = true; controller.abort(new Error("timeout: LLM senyap 60s")); }, TIMEOUT_MS); } };

  const readerLog = conn.name || conn.id;
  let emitted = 0;
  try {
    const resp = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      const e: any = new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`);
      e.statusCode = resp.status;
      throw e;
    }
    if (!resp.body) throw new Error("stream tidak tersedia dari provider ini");
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let raw = "";
    let full = "";
    const handleLine = (line: string) => {
      const m = /^[ \t]*data:[ \t]*(.*)$/.exec(line);
      if (!m) return;
      const payload = m[1].trim();
      if (!payload || payload === "[DONE]") return;
      let obj: any;
      try { obj = JSON.parse(payload); } catch { return; } // chunk rusak → lewati
      const piece = obj?.choices?.[0]?.delta?.content ?? obj?.choices?.[0]?.message?.content ?? "";
      if (piece) { full += piece; emitted += piece.length; onDelta(piece); }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const s = dec.decode(value, { stream: true });
        buf += s; raw += s;
        reset();
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          handleLine(line);
        }
      }
    }
    if (buf.trim()) handleLine(buf);
    // Relay aneh (disebut di extractJSON): minta stream, balas satu JSON
    // utuh non-SSE — rakit dari raw lalu kirim sebagai satu delta.
    if (!full.trim()) {
      try {
        const j = extractJSON(raw);
        const text = j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.delta?.content ?? "";
        if (text) { full = text; emitted += text.length; onDelta(text); }
      } catch {}
    }
    if (!full.trim()) throw new Error(provider + " stream kosong");
    return full.trim();
  } catch (e: any) {
    // Sebagian teks sudah tercetak ke user: JANGAN biarkan fallback mengulang
    // dari awal di koneksi lain (teks jadi dobel) — tandai dan lempar.
    if (emitted > 0) { e.emitted = emitted; throw e; }
    throw e;
  } finally { clearTimeout(to); void readerLog; }
}

async function callStreamWithOneRetry(conn: Connection, messages: ChatMessage[], clientSystem: string, onDelta: StreamDelta): Promise<string> {
  try {
    return await callLLMStream(conn, messages, clientSystem, onDelta);
  } catch (e: any) {
    if (e?.emitted > 0) throw e;
    if (/respon KOSONG|respon bukan JSON/.test(String(e?.message || "")))
      return await callLLMStream(conn, messages, clientSystem, onDelta);
    throw e;
  }
}

// ── Multi-LLM role routing ─────────────────────────────────────
// Satu LLM "serba bisa" menerima seluruh konteks (termasuk dulu: tabel
// parameter) di prompt-nya, dan itu menurunkan mutu balasan teks. Dengan tag
// role, prompt berat pindah ke connection yang memang bertugas memetakan
// gerak, dan user bisa memakai "yang murah untuk gerak, yang pintar untuk
// teks". Role kanonik SENGAJA kecil — tambah role baru berarti menambah
// entri di sini + satu checkbox di UI, bukan sistem baru. "memory" = keputusan
// latar companion (intent chat→agent, kompresi sesi, ekstraksi memori —
// core/src/companion_memory.rs); fallback koneksi aktif bila tak dibind.
export const LLM_ROLES = ["chat", "motion", "sheet", "assistant", "motion-vision", "behavior", "memory"];

/** Bersihkan field `roles`: buang non-string, trim/lowercase, dedupe,
 *  drop role tak dikenal (dengan warning — jangan gagalkan boot). */
export function normalizeRoles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string") continue;
    const k = r.trim().toLowerCase();
    if (!k) continue;
    if (!LLM_ROLES.includes(k)) {
      console.warn("[roles] role tidak dikenal diabaikan:", k);
      continue;
    }
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** true kalau connection ini boleh dipakai untuk `role`.
 *  Absen/invalid/kosong = wildcard (semua role) — kompatibel mundur mutlak. */
export function connHasRole(conn: Connection | null | undefined, role: string): boolean {
  const roles = normalizeRoles(conn && conn.roles);
  if (!roles.length) return true;
  return roles.includes(role);
}

/**
 * Urutan kandidat untuk sebuah role: connection yang MENANDAI role ini
 * secara eksplisit diutamakan di atas wildcard, supaya menandai satu
 * connection sebagai 'motion' benar-benar mengarahkan trafik motion ke sana.
 * Kosong berarti "pakai urutan default llmWithFallback" (aktif dulu).
 */
export function orderForRole(role: string, conns: Connection[]): Connection[] {
  const usable = conns.filter((c) => c.enabled !== false);
  const matching = usable.filter((c) => connHasRole(c, role));
  if (!matching.length) {
    console.warn("[roles] tidak ada connection untuk role \"" + role + "\" — pakai semua connection");
    return [];
  }
  const explicit = usable.filter((c) => normalizeRoles(c.roles).includes(role));
  return explicit.concat(matching.filter((c) => !explicit.includes(c)));
}

export function llmWithFallback(
  getConnections: () => Connection[],
  getActive: () => Connection | null,
  persist: (conns: Connection[]) => void,
  messages: ChatMessage[],
  clientSystem: string = "",
  order?: Connection[],
  call: (conn: Connection) => Promise<string> = (c) => callWithOneRetry(c, messages, clientSystem)
): Promise<LLMResult> {
  return new Promise((resolve, reject) => {
    // PENTING: `allConns` (daftar utuh) yang dipersist — memfilter dulu lalu
    // mempersist akan MENGHAPUS koneksi nonaktif dari config.json.
    const allConns = getConnections();
    const conns = allConns.filter((c) => c.enabled !== false);
    if (!conns.length) { const e: any = new Error("Semua connection sedang dinonaktifkan — aktifkan lagi di panel ⚙️ AI Connections."); e.httpStatus = 400; e.kind = "no-connections"; return reject(e); }
    const activeRaw = getActive();
    const active = activeRaw && activeRaw.enabled === false ? null : activeRaw;
    // `order` opsional: daftar connection yang SUDAH diurutkan (mis. hasil
    // orderForRole). Bila tidak diberikan, perilaku lama dipertahankan persis:
    // active dulu, lalu sisanya urut config.
    const order2 = (Array.isArray(order) && order.length)
      ? order.filter(Boolean)
      : [active, ...conns.filter((c) => c !== active)].filter(Boolean) as Connection[];
    let idx = 0;
    (function tryNext() {
      if (idx >= order2.length) { const e: any = new Error("Semua connection gagal (cek panel ⚙️ AI Connections)."); e.httpStatus = 502; e.kind = "all-failed"; return reject(e); }
      const conn = order2[idx++];
      if (conn.rateLimitedUntil && new Date(conn.rateLimitedUntil).getTime() > Date.now()) return tryNext();
      call(conn).then((reply) => {
        conn.testStatus = "success"; (conn as any).lastError = ""; conn.rateLimitedUntil = null as any;
        persist(allConns);
        resolve({ reply, used: conn.id });
      }).catch((err) => {
        const status = err.statusCode ?? 0;
        const cls = classifyError(status, err.message);
        conn.testStatus = "error"; (conn as any).lastError = err.message;
        if (cls.shouldFallback) conn.rateLimitedUntil = new Date(Date.now() + (cls.cooldownMs || 30000)).toISOString() as any;
        persist(allConns);
        if (cls.shouldFallback && idx < order2.length) tryNext();
        else { const e: any = new Error("LLM error [" + (conn.name || conn.id) + "]: " + err.message); e.httpStatus = 502; e.kind = "llm-error"; e.conn = conn; reject(e); }
      });
    })();
  });
}

export { classifyError };
