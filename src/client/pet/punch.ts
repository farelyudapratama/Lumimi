/**
 * pet/punch — "punch-through": lubang klik di atas model.
 *
 * Saat klik-tembus ON, SELURUH jendela menembus klik (setIgnoreCursorEvents
 * true) — pet jadi hantu yang tak bisa disentuh. Punch membolongkan itu:
 * kursor di atas model → ignore=false (jendela menangkap input), keluar →
 * true lagi. Pola persis patch REAKyndred (getHitBounds + poller), tapi di
 * sini tanpa poller: keputusan diambil tiap sampel kursor dari event push,
 * dan toggle hanya dipanggil SAAT keadaan berubah (histeresis, bukan tiap
 * frame).
 *
 * Keadaan dilacak: `ignoring` = apakah jendela sedang menembus klik.
 * - Klik-tembus OFF → selalu ignore=false (jendela normal).
 * - Klik-tembus ON → ignore = kursor TIDAK di atas model (pad histeresis:
 *   masuk pakai enterPad kecil, keluar perlu melewati exitPad besar).
 *
 * Murni: setter di-inject, keputusan dihitung — diuji tanpa jendela.
 */

import { aabbContains, expandAABB, type AABB } from "./hit";

export interface PunchOptions {
  /** Set ignore-cursor-events jendela (Tauri setIgnoreCursorEvents). */
  setIgnore(on: boolean): void;
  /** AABB model terkini (CSS px) — dibaca tiap keputusan. */
  getBounds(): AABB | null;
  /** Klik-tembus menyala? (sumber kebenaran: server via /api/pet/state). */
  getClickThrough(): boolean;
  /** Pad masuk area (px) — kecil, biar pinggir model tetap tembus. */
  enterPad?: number;
  /** Pad keluar area (px) — lebih besar, cegah flip-flop di tepi. */
  exitPad?: number;
}

export interface PunchController {
  /**
   * Keputusan dari sampel kursor (CSS px). Return = apakah jendela SEDANG
   * menerima input (lubang terbuka / klik-tembus mati).
   */
  feed(x: number, y: number): boolean;
  /** Jendela sedang menerima input (tidak menembus)? */
  receivingInput(): boolean;
  /** Paksa keadaan ignore (mis. klik-tembus baru dinyalakan → true). */
  force(ignoring: boolean): void;
  /** Jendela dipaksa menerima input (klik-tembus mati / tutup lubang). */
  openInput(): void;
}

export function createPunchController(opts: PunchOptions): PunchController {
  const enterPad = opts.enterPad ?? 4;
  const exitPad = opts.exitPad ?? 20;
  // Asumsi awal: jendela menembus (kondisi normal pet baru bangun dengan
  // klik-tembus ON). Toggle nyata hanya bila keputusan berubah dari ini.
  let ignoring = true;
  const apply = (v: boolean): void => {
    if (v === ignoring) return;
    ignoring = v;
    opts.setIgnore(v);
  };
  return {
    feed(x: number, y: number): boolean {
      if (!opts.getClickThrough()) {
        apply(false); // jendela normal — selalu menerima input
        return true;
      }
      const b = opts.getBounds();
      if (!b) {
        apply(true); // model belum siap → tetap menembus penuh
        return false;
      }
      const pad = ignoring ? enterPad : exitPad;
      const inside = aabbContains(expandAABB(b, pad), x, y);
      apply(!inside);
      return !ignoring;
    },
    receivingInput() {
      return !ignoring;
    },
    force(v: boolean) {
      apply(v);
    },
    openInput() {
      apply(false);
    },
  };
}
