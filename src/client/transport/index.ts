/**
 * client/transport — SEAM TUNGGAL komunikasi frontend↔backend.
 *
 * Arsitektur (satu binary, satu proses):
 * - Produksi: halaman di-embed di Lumimi.exe (origin lokal tauri.localhost).
 *   Domain yang SUDAH migrasi → perintah IPC (`invoke`) langsung ke logika
 *   `live2d_core` dalam proses yang sama (tanpa HTTP). Domain yang BELUM →
 *   HTTP loopback proses-sendiri (adapter yang sama melayani CLI/OBS/dev).
 *   Port loopback TIDAK diasumsikan dan SELALU di-handshake: IPC
 *   `server_port` + `server_token` dulu, lalu /api/version diverifikasi
 *   (core_version + instance == token); bila gagal → probe 8310..8399 dengan
 *   syarat token cocok (sinkron pick_port shell). Server asing ATAU instalasi
 *   Lumimi lain tidak pernah ditempeli — token deterministik per root app.
 *   Fetch yang kena kegagalan koneksi re-resolve port sekali lalu diulang
 *   (self-heal — dulu "browser bisa, exe engga" saat server tergeser dari
 *   8310). Dev browser (`cargo run -p live2d-core` + browser): tanpa
 *   __TAURI__ → semuanya HTTP same-origin.
 *
 * Aturan: tiap domain yang migrasi IPC memakai fungsi bernama di sini
 * (modeGet/modeSet/…) dengan HTTP sebagai jembatan transisi (+ console.warn)
 * sampai migrasinya terbukti — lalu jembatan dicabut per-domain. JANGAN
 * menambah fetch mentah ke domain yang sudah punya helper.
 */

/**
 * Origin backend HTTP. DERIVED, bukan literal — dev: halaman disajikan server
 * yang sama (location.origin benar); embedded: loopback proses-sendiri
 * (port via initLoopback, default 8310). Literal hanya fallback file://.
 * Pola ini WAJIB sama dengan static/js/app.js (dijaga
 * test/legacy/test-api-origin.js).
 */
export function apiBase(): string {
  return httpBase();
}

let loopPort: number | null = null;
let loopToken: string | null = null;
let loopInit: Promise<number | null> | null = null;

/** True bila berjalan di dalam shell Lumimi (withGlobalTauri). */
export function isEmbedded(): boolean {
  return typeof (globalThis as any).__TAURI__ !== "undefined";
}

/**
 * Rentang probe HARUS sinkron dengan kandidat port shell
 * (agent-shell/src/main.rs::pick_port): server bisa tergeser dari 8310 bila
 * port diduduki aplikasi asing. Dulu ini penyebab "browser bisa, exe engga" —
 * browser dibuka di URL port yang benar, frontend exe terjebak di default.
 */
const PROBE_FIRST = 8310;
const PROBE_LAST = 8399;
const PROBE_TIMEOUT_MS = 700;

/**
 * Handshake: apakah port ini benar server milik instalasi kita? /api/version
 * harus membalas `core_version` (bentuk khas Lumimi) DAN `instance` yang
 * cocok dengan token dari shell (server_token). Tanpa token (shell lama /
 * anomali), bentuk `core_version` saja diterima — tetap jauh lebih kuat
 * daripada menebak dari pola JSON /api/mode.
 */
async function portIsOurs(p: number, token: string | null): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch("http://127.0.0.1:" + p + "/api/version", {
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(to);
    }
    if (!res.ok) return false;
    const d = await res.json().catch(() => null);
    if (!d || typeof d !== "object") return false;
    if (typeof d.core_version !== "string" || !d.core_version) return false;
    if (token !== null) return d.instance === token;
    return true;
  } catch {
    return false;
  }
}

async function resolveLoopbackOnce(): Promise<number | null> {
  let token: string | null = null;
  try {
    const t = (globalThis as any).__TAURI__;
    const inv = t?.core?.invoke ?? t?.invoke;
    if (typeof inv === "function") {
      try {
        const tk = await inv("server_token");
        if (typeof tk === "string" && tk) {
          token = tk;
          loopToken = tk;
        }
      } catch {
        // command lama tanpa server_token → fallback bentuk-saja
      }
      const p = await inv("server_port");
      if (typeof p === "number" && p > 0 && p < 65536) {
        if (await portIsOurs(p, token)) return p;
        // Port milik shell ternyata TIDAK menjawab sebagai server kita
        // (asing naik belakangan?) — jangan pernah dipakai; lanjut probe.
      }
    }
  } catch {
    // IPC gagal → jatuh ke probe (embedded saja)
  }
  // Dev/browser tanpa IPC: location.origin sudah benar by construction —
  // memprobe justru bisa menemukan instance Lumimi lain dan menyesatkan.
  if (!isEmbedded()) return null;
  return probeLoopback(loopToken);
}

/**
 * Probe rentang port (sinkron pick_port shell) dengan handshake token —
 * server asing atau instalasi Lumimi lain di port manapun akan DITOLAK.
 */
async function probeLoopback(token: string | null): Promise<number | null> {
  for (let p = PROBE_FIRST; p <= PROBE_LAST; p++) {
    if (await portIsOurs(p, token)) return p;
  }
  return null;
}

/**
 * Temukan port loopback (di-cache selamanya begitu KETEMU dan lolos
 * handshake). Embedded: command `server_port` + `server_token` ke shell,
 * bila gagal/ditolak → probe rentang port; dev: null (= pakai
 * location.origin). Kegagalan TIDAK di-cache — panggilan berikutnya
 * mencoba lagi, supaya exe tidak terjebak port default selamanya bila IPC
 * atau server belum siap saat boot. Aman dipanggil berkali-kali; tak
 * pernah melempar.
 */
export function initLoopback(): Promise<number | null> {
  if (loopPort !== null) return Promise.resolve(loopPort);
  if (!loopInit) {
    loopInit = resolveLoopbackOnce().then((p) => {
      if (p === null) loopInit = null; // batal cache — boleh dicoba ulang
      else loopPort = p;
      return p;
    });
  }
  return loopInit;
}

/** Basis HTTP sinkron. Embedded → loopback (port cache/default); dev → origin. */
export function httpBase(): string {
  if (isEmbedded()) return "http://127.0.0.1:" + (loopPort ?? 8310);
  return typeof location !== "undefined" && /^https?:$/.test(location.protocol)
    ? location.origin
    : "http://127.0.0.1:8310";
}

/** Panggil command IPC; `undefined` di luar shell / bila gagal. */
export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | undefined> {
  try {
    const t = (globalThis as any).__TAURI__;
    const fn = t?.core?.invoke ?? t?.invoke;
    if (typeof fn !== "function") return undefined;
    return (await fn(cmd, args)) as T;
  } catch {
    return undefined;
  }
}

/** URL absolut untuk sebuah path API relatif ("/api/...", "/model/..."). */
export function apiUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const base = httpBase();
  return path.startsWith("/") ? base + path : base + "/" + path;
}

/**
 * fetch terpusat ke backend HTTP. Semua call-site frontend lewat sini
 * (atau getJson/postJson) alih-alih `fetch("/api/..")` langsung.
 *
 * Self-heal khusus exe: kegagalan KONEKSI (fetch menolak, bukan HTTP error)
 * di port default bisa berarti port belum ter-resolve saat boot atau server
 * berada di port geseran shell. Re-resolve loopback sekali, lalu ulang
 * request HANYA bila basis benar-benar berganti — kalau tetap, retry hanya
 * mengulang ke port yang sama (mati). Dev/browser tidak disentuh: origin
 * halaman = server, retry tidak akan mengubah apa pun.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(apiUrl(path), init);
  } catch (e) {
    if (!isEmbedded() || init?.signal?.aborted) throw e;
    const prev = httpBase();
    loopPort = null;
    loopInit = null;
    const p = await initLoopback().catch(() => null);
    if (p === null || httpBase() === prev) throw e;
    return fetch(apiUrl(path), init);
  }
}

/** Fasad transport — HTTP (adapter) + helper IPC per-domain yang termigrasi. */
export const transport = {
  apiBase,
  apiUrl,
  fetch: apiFetch,
  isEmbedded,
  initLoopback,
  httpBase,
  invoke,

  /** GET JSON. */
  async getJson<T = any>(path: string, init?: RequestInit): Promise<T> {
    const r = await apiFetch(path, init);
    if (!r.ok) throw new Error("HTTP " + r.status + " " + path);
    return (await r.json()) as T;
  },

  /** POST JSON → JSON. */
  async postJson<T = any>(path: string, body: unknown, init?: RequestInit): Promise<T> {
    const r = await apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + path);
    return (await r.json()) as T;
  },

  /**
   * GET /api/mode — domain MODE (migrasi IPC #1). Embedded → command
   * `get_mode` (direct core); dev → HTTP. Jembatan HTTP sementara sampai
   * migrasi terbukti (lihat console).
   */
  async modeGet<T = any>(): Promise<T> {
    if (isEmbedded()) {
      const r = await invoke<T>("get_mode");
      if (r !== undefined) return r;
      console.warn("[transport] get_mode IPC gagal — jembatan HTTP (transisi)");
    }
    return this.getJson<T>("/api/mode");
  },

  /**
   * POST /api/mode — domain MODE (migrasi IPC #1). Embedded → command
   * `set_mode`; dev → HTTP. Jembatan HTTP sementara (lihat console).
   */
  async modeSet<T = any>(mode: string): Promise<T> {
    if (isEmbedded()) {
      try {
        const r = await invoke<T>("set_mode", { mode });
        if (r !== undefined) return r;
      } catch (e) {
        console.warn("[transport] set_mode IPC gagal — jembatan HTTP (transisi):", (e as Error)?.message ?? e);
      }
    }
    return this.postJson<T>("/api/mode", { mode });
  },

  /**
   * Import folder model lewat dialog folder NATIVE (domain model-import,
   * migrasi IPC). Hanya hidup di shell Lumimi (exe): dialog dibuka Rust (rfd)
   * dan folder DISALIN langsung di disk oleh core — tanpa upload base64
   * lewat WebView (folder model ber-tekstur 4K melampaui batas body HTTP dan
   * WebView2 memutus koneksi: "Failed to fetch"). Dev browser → undefined
   * (call-site jatuh ke alur webkitdirectory + HTTP).
   */
  async modelImportDialog(
    name?: string,
  ): Promise<{ ok: boolean; cancelled?: boolean; name?: string; path?: string; error?: string } | undefined> {
    if (!isEmbedded()) return undefined;
    const r = await invoke<{
      ok: boolean;
      cancelled?: boolean;
      name?: string;
      path?: string;
      error?: string;
    }>("import_model_dialog", { name: name || undefined });
    if (r === undefined) {
      console.warn("[transport] import_model_dialog IPC gagal — jembatan HTTP/webkitdirectory (transisi)");
      return undefined;
    }
    return r;
  },

  /**
   * Versi core — Embedded → command `core_version`; dev → HTTP /api/version.
   * Non-blokir (indikator judul saja).
   */
  async coreVersion(): Promise<string | undefined> {
    if (isEmbedded()) {
      const v = await invoke<string>("core_version");
      if (typeof v === "string" && v) return v;
    }
    try {
      const r = await this.getJson<{ core_version?: string }>("/api/version");
      return r?.core_version;
    } catch {
      return undefined;
    }
  },
};

export type Transport = typeof transport;

/** Reset cache loopback — HANYA untuk unit test. */
export function _resetLoopbackForTest(): void {
  loopPort = null;
  loopToken = null;
  loopInit = null;
}
