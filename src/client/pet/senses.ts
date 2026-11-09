/**
 * pet/senses — keadaan kursor & input untuk Desktop Pet.
 *
 * Sumber data: event push `pet://cursor` dari shell (pet_native.rs —
 * GetCursorPos + GetAsyncKeyState, koordinat FISIK layar). pet-entry
 * mengonversi ke CSS px lalu menyuntikkannya ke sini. Modul ini MURNI:
 * tak menyentuh DOM/IPC, hanya menghitung kinematika — supaya bisa diuji
 * bun test tanpa jendela.
 *
 * Kenapa thread shell, bukan polling IPC dari rAF: aturan
 * ARCHITECTURE-TAURI-RUST.md — render loop / per-frame TIDAK PERNAH lewat
 * IPC. Stream kursor = stream input, gerak/param tetap 100% lokal.
 */

/** Satu sampel kursor dalam koordinat CSS client (px) + tombol kiri. */
export interface CursorSample {
  x: number;
  y: number;
  down: boolean;
  /** ms, kapan pun — relatif antar-sampel saja yang dipakai. */
  t: number;
}

/** Keadaan kursor terkini + kinematika (kecepatan/akselerasi px/s). */
export interface Kinematics {
  x: number;
  y: number;
  down: boolean;
  /** px/s, EMA — bukan beda mentah (kursor native berisik). */
  vx: number;
  vy: number;
  /** px/s², EMA dari perubahan kecepatan. */
  ax: number;
  ay: number;
  /** ms sejak sampel terakhir (dihitung saat state(now) dipanggil). */
  sinceInputMs: number;
}

export const SENSES_DEFAULTS = {
  /** Faktor EMA kecepatan (0..1) — besar = responsif, kecil = halus. */
  velAlpha: 0.5,
  /** Faktor EMA akselerasi. */
  accelAlpha: 0.35,
  /** dianggap diam bila speed di bawah ini (px/s). */
  restSpeed: 4,
};

export interface SensesOptions extends Partial<typeof SENSES_DEFAULTS> {}

export interface Senses {
  /** Suntik sampel baru (CSS px). */
  feed(s: CursorSample): Kinematics;
  /**
   * Keadaan terkini. `nowMs` (opsional) menghitung sinceInputMs TERKINI —
   * penting saat kursor berhenti total (tidak ada sampel baru masuk):
   * waktu-idle harus tetap tumbuh, bukan beku di nilai feed terakhir.
   */
  state(nowMs?: number): Kinematics;
  /** Waktu (ms sampel) sampel terakhir; null bila belum ada. */
  lastSampleMs(): number | null;
}

export function createSenses(opts: SensesOptions = {}): Senses {
  const cfg = { ...SENSES_DEFAULTS, ...opts };
  let cur: Kinematics = {
    x: 0, y: 0, down: false,
    vx: 0, vy: 0, ax: 0, ay: 0,
    sinceInputMs: 0,
  };
  let last: CursorSample | null = null;
  return {
    feed(s) {
      if (last) {
        const dt = Math.max(1, s.t - last.t) / 1000; // detik
        const ivx = (s.x - last.x) / dt;
        const ivy = (s.y - last.y) / dt;
        // EMA kecepatan lalu akselerasi (dari perubahan kecepatan instan).
        const pvx = cur.vx, pvy = cur.vy;
        cur.vx = cur.vx + (ivx - cur.vx) * cfg.velAlpha;
        cur.vy = cur.vy + (ivy - cur.vy) * cfg.velAlpha;
        cur.ax = cur.ax + ((cur.vx - pvx) / dt - cur.ax) * cfg.accelAlpha;
        cur.ay = cur.ay + ((cur.vy - pvy) / dt - cur.ay) * cfg.accelAlpha;
      }
      last = s;
      cur.x = s.x;
      cur.y = s.y;
      cur.down = s.down;
      cur.sinceInputMs = 0;
      return { ...cur };
    },
    state(nowMs?: number) {
      const k = { ...cur };
      if (nowMs != null && last) k.sinceInputMs = Math.max(0, nowMs - last.t);
      return k;
    },
    lastSampleMs() {
      return last ? last.t : null;
    },
  };
}

/**
 * EMA kecepatan = diam? Dipakai touch (bedakan tap vs drag pelan) dan swing
 * (hanya dorong saat benar-benar digerakkan).
 */
export function isResting(k: Kinematics): boolean {
  return Math.hypot(k.vx, k.vy) < SENSES_DEFAULTS.restSpeed;
}
