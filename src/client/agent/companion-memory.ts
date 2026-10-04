/**
 * agent/companion-memory.ts — Context sesi companion + logika memory.
 *
 * Dua lapisan (permintaan fitur 2026-10-04):
 *  1. SESSION CONTEXT — in-RAM, mati saat aplikasi ditutup. Menampung giliran
 *     user+assistant JAUH melebihi jendela terakhir: giliran lama tetap bisa
 *     di-retrieve per-request (skor tumpang-tindih token), dan yang semakin
 *     jauh dikompres menjadi ringkasan bergulir (dibuat LLM role "memory" di
 *     core, lihat core/src/companion_memory.rs). TIDAK ada persistensi.
 *  2. LONG-TERM MEMORY — persisten di core (data/companion-memory.json);
 *     modul ini hanya tipe + komposisi blok prompt-nya. Retrieval relevansi
 *     dilakukan server supaya semua surface (app utama, jendela pet, CLI)
 *     berbagi logika yang sama.
 *
 * Modul ini SENGAJA murni (tanpa fetch/DOM): semua keputusan teks bisa
 * dites langsung. Jaringan ada di brain.ts.
 */
import type { ChatMessage } from "../../shared/types";

// ── Konstanta perilaku (kebijakan, bukan config user) ──────────────────
/** Giliran terakhir yang SELALU utuh di context per request. */
export const RECENT_WINDOW = 16;
/** Batas potongan giliran lama yang disisipkan per request (retrieval). */
export const RETRIEVE_SESSION_LIMIT = 6;
/** Batas RAM sesi (FIFO) — giliran paling awal benar-benar dibuang di sini. */
export const SESSION_TURNS_CAP = 400;
/** Giliran di luar jendela sebelum kompresi mulai berjalan. */
export const COMPRESS_TRIGGER = 12;
/** Ukuran maks blok yang diringkas per panggilan LLM (bertahap). */
export const COMPRESS_CHUNK = 20;
/** Ekstraksi long-term memory tiap N giliran user (fail-soft, post-reply). */
export const EXTRACT_EVERY = 6;
/** Batas karakter isi satu giliran di RAM (paritas cap ask assistant). */
export const TURN_CONTENT_CAP = 4000;

export interface StoredTurn {
  role: "user" | "assistant";
  content: string;
}

export interface MemoryEntry {
  id: string;
  text: string;
  tags: string[];
  ts: number;
  score?: number;
}

// ── Tokenisasi & skor (cermin logika core, versi ringan) ───────────────

export function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const c of text.toLowerCase()) {
    if (/[a-z0-9\u00C0-\u024F\u3040-\u30FF\u3400-\u9FFF]/i.test(c)) {
      cur += c;
    } else if (cur.length >= 2) {
      out.push(cur);
      cur = "";
    } else {
      cur = "";
    }
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}

/** Skor kecocokan satu giliran terhadap query — tumpang-tindih token
 *  dinormalisasi; cukup untuk pemilihan potongan lama dalam satu sesi. */
export function scoreTurn(turn: StoredTurn, queryTokens: string[]): number {
  if (!queryTokens.length) return 0;
  const t = new Set(tokenize(turn.content));
  if (!t.size) return 0;
  let hit = 0;
  for (const q of new Set(queryTokens)) if (t.has(q)) hit++;
  return hit / (queryTokens.length + 1);
}

/** Pilih potongan lama paling relevan (return urut KRONOLOGIS supaya
 *  penyisipan ke messages tetap membentuk percakapan yang masuk akal). */
export function retrieveOlderTurns(
  older: StoredTurn[],
  query: string,
  limit: number,
): StoredTurn[] {
  if (!older.length || limit <= 0) return [];
  const qTokens = tokenize(query);
  const scored = older
    .map((t, idx) => ({ idx, t, s: scoreTurn(t, qTokens) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);
  scored.sort((a, b) => a.idx - b.idx);
  return scored.map((x) => x.t);
}

// ── Session context ────────────────────────────────────────────────────

export class SessionContext {
  /** Giliran penuh sesi — brain mengekspos array ini sebagai `history`. */
  readonly turns: StoredTurn[] = [];
  /** Ringkasan bergulir atas giliran [0 .. summaryUpTo). */
  summary = "";
  /** Jumlah giliran terdepan yang sudah tercakup ringkasan. */
  summaryUpTo = 0;
  /** Giliran sudah diekstraksi menjadi long-term memory. */
  private extractCursor = 0;

  pushUser(content: string): void {
    this.push({ role: "user", content });
  }
  pushAssistant(content: string): void {
    this.push({ role: "assistant", content });
  }

  private push(t: StoredTurn): void {
    const c = t.content.trim();
    if (!c) return;
    this.turns.push({ role: t.role, content: c.slice(0, TURN_CONTENT_CAP) });
    if (this.turns.length > SESSION_TURNS_CAP) {
      const cut = this.turns.length - SESSION_TURNS_CAP;
      this.turns.splice(0, cut);
      // Kursor ikut bergeser — ringkasan tetap mencakup region yang sama.
      this.summaryUpTo = Math.max(0, this.summaryUpTo - cut);
      this.extractCursor = Math.max(0, this.extractCursor - cut);
    }
  }

  /** Jumlah giliran di luar jendela terakhir. */
  olderCount(): number {
    return Math.max(0, this.turns.length - Math.min(RECENT_WINDOW, this.turns.length));
  }

  /** Blok yang layak diringkas sekarang (bertahap, max COMPRESS_CHUNK),
   *  atau null bila belum trigger. Blok = giliran TERCATAT-SEKALI region
   *  [summaryUpTo .. min(olderEnd, summaryUpTo+CHUNK)). */
  pendingCompress(): { prior: string; turns: StoredTurn[] } | null {
    const olderEnd = this.turns.length - Math.min(RECENT_WINDOW, this.turns.length);
    if (olderEnd - this.summaryUpTo < COMPRESS_TRIGGER) return null;
    const end = Math.min(olderEnd, this.summaryUpTo + COMPRESS_CHUNK);
    return { prior: this.summary, turns: this.turns.slice(this.summaryUpTo, end) };
  }

  /** Terapkan hasil ringkasan LLM. covered = panjang blok yang diringkas. */
  applyCompress(newSummary: string, covered: number): void {
    if (covered <= 0) return;
    this.summary = newSummary.trim().slice(0, 1600) || this.summary;
    this.summaryUpTo = Math.min(this.summaryUpTo + covered, this.turns.length);
  }

  /** Blok giliran sejak ekstraksi terakhir (termasuk yang masih di jendela —
   *  fakta penting layak segera dipromosikan, bukan menunggu jendela penuh). */
  pendingExtract(): StoredTurn[] {
    return this.turns.slice(Math.min(this.extractCursor, this.turns.length));
  }

  /** Maju kursor ekstraksi SETELAH sukses (gagal → dicoba lagi nanti). */
  advanceExtract(covered: number): void {
    this.extractCursor = Math.min(this.extractCursor + Math.max(0, covered), this.turns.length);
  }

  /** Bersihkan sesi IN PLACE — array `turns` tetap objek yang sama karena
   *  dikonsumsi lewat referensi (window.__agent.history). */
  reset(): void {
    this.turns.length = 0;
    this.summary = "";
    this.summaryUpTo = 0;
    this.extractCursor = 0;
  }
}

/** Rakit messages untuk POST /api/chat: potongan lama relevan (bila ada)
 *  + jendela terakhir, urut kronologis. Ganti splice mentah 24-entry lama. */
export function buildContextMessages(
  turns: StoredTurn[],
  query: string,
): { messages: ChatMessage[]; olderUsed: StoredTurn[] } {
  const recentCount = Math.min(RECENT_WINDOW, turns.length);
  const recentStart = turns.length - recentCount;
  const olderUsed = retrieveOlderTurns(
    turns.slice(0, recentStart),
    query,
    RETRIEVE_SESSION_LIMIT,
  );
  const messages: ChatMessage[] = [...olderUsed, ...turns.slice(recentStart)].map(
    (m) => ({ role: m.role, content: m.content }),
  );
  return { messages, olderUsed };
}

// ── Blok prompt tambahan ───────────────────────────────────────────────

/** Ringkasan sesi + catatan bahwa potongan lama mungkin disisipkan. */
export function sessionSummaryBlock(summary: string, olderUsed: StoredTurn[]): string {
  let s = "";
  if (summary.trim()) {
    s +=
      "\n\n=== RINGKASAN PERCAKAPAN (awal sesi ini, sudah dikompres) ===\n" +
      summary.trim() +
      "\n---";
  }
  if (olderUsed.length) {
    s +=
      "\n\n=== POTONGAN LAMA YANG RELEVAN (disisipkan otomatis dari awal sesi) ===\n" +
      "Pesan-pesan di bawah ini dari bagian awal percakapan — perlakukan sebagai\n" +
      "bagian dari konteks percakapanmu bersama user.\n---";
  }
  return s;
}

/** Long-term memory (dari interksi sebelumnya; retrieval server-side). */
export function memoryBlock(entries: MemoryEntry[]): string {
  if (!entries.length) return "";
  const lines = entries
    .slice(0, 8)
    .map((e) => `- ${e.text}`)
    .join("\n");
  return (
    "\n\n=== MEMORI JANGKA PANJANG (dari interaksi sebelumnya) ===\n" +
    "Ini hal yang sudah kamu ketahui tentang user — pakai sebagai konteks,\n" +
    "JANGAN tanya ulang atau pertanyakan asal-usulnya.\n" +
    lines +
    "\n---"
  );
}

// ── Intent routing: Chat/Pet → Agent ──────────────────────────────────

/**
 * Gerbang RECALL untuk keputusan intent: menentukan apakah pesan layak
 * diklasifikasikan LLM (role "memory"). Sengaja LONGGAR — false positive
 * hanya berarti +1 panggilan klasifikasi kecil; false negative berarti
 * permintaan tugas TIDAK pernah dicek. Kata kerja tunggal TIDAK PERNAH
 * memutuskan routing ( itu kerja LLM), jadi tidak melanggar "jangan keyword
 * saklek".
 */
export function looksTaskish(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length < 4) return false;
  const verbCue =
    /\b(tolong\w*|carik?an?|cari\w*|buat\w*|bikin\w*|kerjakan|rapikan|beres?in|perbaiki|periksa|cek|check|debug|fix|banding\w*|compare|kumpulkan|ringkas|rangkum|terjemah\w*|translate|siapkan|urus\w*|ganti\w*|tambah\w*|install|uninstall|jalankan|compile|build|deploy|export|impor|convert|download|unggah|upload|ingatkan|reminder|jadwalkan|refactor|konsolidasi|gabung\w*|pisah\w*|hapus\w*|bersih\w*|cariin)\b/;
  const openerCue =
    /(^|\s)(aku|gw|gue|saya|kami)\s+(mau|pengen|ingin|butuh|perlu|minta)\b|^(bisakah|bisa gak|bisa nggak|bisa tidak|coba)\b/;
  const enCue =
    /(^|\s)(can you|could you|please|pls|kindly|help me|i want|i need|i'?d like|make me|find me|look up|set up|clean up|fix the|debug the)\b|\b(search for|compare|look into|figure out|write (me )?a|create (me )?a|generate)\b/;
  return verbCue.test(t) || openerCue.test(t) || enCue.test(t);
}

/** Pilihan ucapan pengakuan hand-off (per UI lang) — konsisten dengan
 *  fallback bicara lain di brain yang memang hardcoded, bukan i18n chrome. */
export function handoffAcks(lang: string): { ok: string; busy: string; paused: string; failed: string } {
  if (lang === "en") {
    return {
      ok: "Okay, I'm on it — give me a moment.",
      busy: "Hold on, I'm still finishing the previous task. I'll take this one right after.",
      paused: "I need your permission to continue — please open the Assistant panel.",
      failed: "Hmm, something went wrong while I was working on it. Try again, okay?",
    };
  }
  return {
    ok: "Oke, aku kerjakan ya — tunggu sebentar.",
    busy: "Bentar ya, aku masih ada tugas yang belum beres. Yang ini ku kerjakan setelahnya.",
    paused: "Aku butuh izinmu buat lanjut — buka panel Assistant sebentar ya.",
    failed: "Hmm, ada yang gagal waktu aku kerjakan tadi. Coba lagi ya.",
  };
}

/** Rakit teks tugas yang dikirim ke Agent — konteks dari sesi + memori
 *  supaya user tidak perlu mengulang penjelasan (kelanjutan percakapan). */
export function composeHandoffText(opts: {
  task: string;
  summary: string;
  memoryEntries: MemoryEntry[];
  recentTurns: StoredTurn[];
  originalText: string;
}): string {
  const { task, summary, memoryEntries, recentTurns, originalText } = opts;
  const parts: string[] = [];
  parts.push("[Tugas dialihkan dari percakapan companion — user tidak lewat panel]");
  if (summary.trim()) {
    parts.push(
      "\nKONTEKS PERCAKAPAN (ringkasan sesi ini):\n" + summary.trim().slice(0, 1200),
    );
  }
  if (memoryEntries.length) {
    parts.push(
      "\nMEMORI PENGGUNA YANG RELEVAN:\n" +
        memoryEntries.slice(0, 5).map((e) => `- ${e.text}`).join("\n"),
    );
  }
  const recent = recentTurns
    .slice(-6)
    .map((t) => `${t.role}: ${t.content.slice(0, 300)}`)
    .join("\n");
  if (recent) {
    parts.push("\nGILIRAN TERAKHIR PERCAKAPAN:\n" + recent);
  }
  parts.push(
    "\nPERMINTAAN USER:\n" + (task.trim() || originalText).slice(0, 800),
  );
  parts.push(
    "\nKerjakan tugas di atas sekarang. Konteks di atas sudah mencakup maksud " +
      "user — JANGAN tanya ulang; kalau benar-benar kurang info, tanya SEKALI " +
      "lalu lanjutkan dengan asumsi yang masuk akal. Butuh fakta/preferensi " +
      "user lain? Panggil TOOL: memory_recall {\"query\": \"...\"} — itu memori " +
      "user lintas sesi yang bisa kamu akses sendiri.",
  );
  return parts.join("\n");
}
