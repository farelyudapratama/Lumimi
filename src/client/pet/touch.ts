/**
 * pet/touch — detektor sentuhan: grab / boop / pat.
 *
 * Semua THRESHOLD ala REAKyndred (geometry.js) tapi disederhanakan untuk
 * Lumimi: grab = geser lurus ≥10 px; boop = tap singkat (<250 ms, travel
 * <6 px); pat = wiggle ≥3 balikan arah (stroke, bukan drag). Urutan
 * prioritas: pat mengalahkan grab (wiggle yang kebetulan jauh tetap pat),
 * grab mengunci drag sampai lepas.
 *
 * Murni — feed(x,y,down,t) → daftar event; diuji bun test tanpa DOM.
 */

export const TOUCH_DEFAULTS = {
  /** Jarak dari titik tekan untuk memulai grab (px, REAKyndred dragPx 10). */
  grabPx: 10,
  /** Durasi maksimum boop (ms). */
  boopMaxMs: 250,
  /** Travel maksimum boop (px). */
  boopMaxPx: 6,
  /** Balikan arah minimum untuk pat (REAKyndred wiggle ≥3 flips). */
  patFlips: 3,
  /** Perubahan dx minimum dihitung flip (px) — noise kursor diabaikan. */
  flipDeadPx: 2,
  /** Path minimum pat (px) — sentuhan gelisah tanpa jarak tak dihitung. */
  patMinPath: 30,
} as const;

export type TouchEvent =
  | { kind: "grab"; x: number; y: number }
  | { kind: "drag"; x: number; y: number; dx: number; dy: number }
  | { kind: "boop"; x: number; y: number }
  | { kind: "pat"; flips: number; path: number }
  | { kind: "release"; x: number; y: number; vx: number; vy: number; grabbed: boolean };

interface PressState {
  x0: number;
  y0: number;
  t0: number;
  lastX: number;
  lastY: number;
  lastT: number;
  path: number;
  flips: number;
  lastDx: number;
  grabbed: boolean;
  patDone: boolean;
  /** EMA kecepatan px/ms untuk lempar swing. */
  vx: number;
  vy: number;
}

export interface TouchDetector {
  feed(x: number, y: number, down: boolean, t: number): TouchEvent[];
  /** Sedang grab (drag aktif)? */
  isGrabbing(): boolean;
}

export function createTouchDetector(cfg: Partial<typeof TOUCH_DEFAULTS> = {}): TouchDetector {
  const c = { ...TOUCH_DEFAULTS, ...cfg };
  let press: PressState | null = null;
  return {
    isGrabbing() {
      return !!press?.grabbed;
    },
    feed(x: number, y: number, down: boolean, t: number): TouchEvent[] {
      const out: TouchEvent[] = [];
      if (down) {
        if (!press) {
          press = {
            x0: x, y0: y, t0: t, lastX: x, lastY: y, lastT: t,
            path: 0, flips: 0, lastDx: 0, grabbed: false,
            patDone: false, vx: 0, vy: 0,
          };
          return out;
        }
        const dx = x - press.lastX;
        const dy = y - press.lastY;
        const dt = Math.max(1, t - press.lastT);
        const step = Math.hypot(dx, dy);
        if (step <= 0) return out;
        press.path += step;
        // EMA kecepatan (px/ms) — dipakai sebagai lemparan saat release.
        const ivx = dx / dt, ivy = dy / dt;
        press.vx += (ivx - press.vx) * 0.4;
        press.vy += (ivy - press.vy) * 0.4;
        // Deteksi flip arah horizontal (wiggle = pat/stroke).
        if (press.lastDx !== 0 && Math.abs(dx) >= c.flipDeadPx) {
          if (Math.sign(dx) !== Math.sign(press.lastDx)) press.flips++;
        }
        if (Math.abs(dx) >= c.flipDeadPx) press.lastDx = dx;
        if (!press.grabbed && !press.patDone) {
          const dist = Math.hypot(x - press.x0, y - press.y0);
          if (press.flips >= c.patFlips && press.path >= c.patMinPath) {
            // Wiggle dulu → ini stroke (pat), grab dibatalkan selamanya.
            press.patDone = true;
            out.push({ kind: "pat", flips: press.flips, path: press.path });
          } else if (dist >= c.grabPx && press.flips < c.patFlips) {
            press.grabbed = true;
            out.push({ kind: "grab", x, y });
          }
        }
        if (press.grabbed && !press.patDone) {
          out.push({ kind: "drag", x, y, dx, dy });
        }
        press.lastX = x;
        press.lastY = y;
        press.lastT = t;
        return out;
      }
      // up
      if (!press) return out;
      const dur = t - press.t0;
      if (!press.grabbed && !press.patDone) {
        if (dur <= c.boopMaxMs && press.path <= c.boopMaxPx) {
          out.push({ kind: "boop", x, y });
        }
      }
      out.push({
        kind: "release", x, y,
        vx: press.vx, vy: press.vy, grabbed: press.grabbed,
      });
      press = null;
      return out;
    },
  };
}
