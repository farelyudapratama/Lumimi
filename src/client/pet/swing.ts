/**
 * pet/swing — pendulum teredam untuk model yang diangkat/digotog.
 *
 * Port sederhana fisika swing REAKyndred (geometry.js: zeta 0.14, g 9.81,
 * integrasi fixed-step, sudut tampil di-clamp tanh). Panjang tali = 2/3
 * tinggi model (REAKyndred), dikonversi ke meter lewat asumsi tinggi badan
 * — ukuran inilah satu-satunya "angka fisika" di sini, bukan param Live2D.
 *
 * Masukan: akselerasi pivot (px/s², dari senses/window) dikonversi m/s²
 * dengan pxPerMetre. Murni & deterministik — diuji bun test.
 */

export const SWING_DEFAULTS = {
  /** Redaman (REAKyndred zeta 0.14 — berayun beberapa kali lalu tenang). */
  zeta: 0.14,
  /** Gravitasi m/s². */
  g: 9.81,
  /** Panjang tali sebagai fraksi tinggi model (REAKyndred 2/3). */
  lenFrac: 2 / 3,
  /** Tinggi badan asumsi (m) — untuk konversi px↔m. */
  bodyMetres: 1.4,
  /** Clamp akselerasi pivot (m/s², REAKyndred 25). */
  accelClamp: 25,
  /** Clamp sudut tampil (rad) — REAKyndred tanh 38°. */
  maxAngle: (38 * Math.PI) / 180,
  /** Substep integrasi (s) — deterministik. */
  subStep: 1 / 240,
} as const;

export interface SwingState {
  /** Sudut tali dari vertikal (rad, positif = ke kanan). */
  phi: number;
  /** Kecepatan sudut (rad/s). */
  omega: number;
}

export interface SwingInput {
  /** Akselerasi pivot horizontal (px/s²) — dari senses/window. */
  axPx: number;
  /** Tinggi model terkini (px) — untuk panjang tali. */
  heightPx: number;
  /** Delta waktu (s) sejak step terakhir. */
  dt: number;
}

export interface SwingOptions extends Partial<typeof SWING_DEFAULTS> {}

/**
 * Satu langkah fisika: integrasi semi-implisit Euler per substep (kecepatan
 * diperbarui dulu, posisi pakai kecepatan baru — stabil untuk pendulum
 * teredam). Persamaan pivot berakselerasi horizontal:
 *   φ'' = -(g/L)·sin φ − (a/L)·cos φ − 2ζ√(g/L)·φ'
 */
export function swingStep(
  s: SwingState,
  input: SwingInput,
  opts: SwingOptions = {},
): SwingState & { shownAngle: number } {
  const c = { ...SWING_DEFAULTS, ...opts };
  const pxPerMetre = Math.max(1, input.heightPx / c.bodyMetres);
  const L = Math.max(0.05, (input.heightPx * c.lenFrac) / pxPerMetre); // m
  const a = Math.max(-c.accelClamp, Math.min(c.accelClamp, input.axPx / pxPerMetre));
  const w0 = Math.sqrt(c.g / L); // frekuensi natural
  let phi = s.phi;
  let omega = s.omega;
  let left = Math.max(0, input.dt);
  while (left > 0) {
    const h = Math.min(c.subStep, left);
    left -= h;
    const alpha =
      -(c.g / L) * Math.sin(phi) -
      (a / L) * Math.cos(phi) -
      2 * c.zeta * w0 * omega;
    omega += alpha * h;
    phi += omega * h;
  }
  // Sudut tampil: tanh clamp — besar tetap terbatas, tak pernah melompat.
  const shownAngle = c.maxAngle * Math.tanh(phi / c.maxAngle);
  return { phi, omega, shownAngle };
}

export function initialSwingState(): SwingState {
  return { phi: 0, omega: 0 };
}

/** Reset ayun (dipakai saat model dilepas & sudah mendarat / tenang). */
export function calmSwing(s: SwingState): SwingState {
  return { phi: s.phi * 0.5, omega: 0 };
}
