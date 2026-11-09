/**
 * pet/hit — hit-area model untuk punch-through & sentuhan.
 *
 * Model-agnostic: area disimpulkan dari AABB facade (`getBounds()` — 4 pojok
 * box lokal diproyeksikan ke koordinat CSS stage, Live2DView.ts) plus pad.
 * Tidak ada nama model/id param di sini. Per-drawable (vertex akurat) adalah
 * penyempurnaan nanti; AABB cukup untuk punch-through dan grab.
 */

export interface AABB {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Besarkan AABB sebesar pad px di semua sisi (tidak pernah negatif). */
export function expandAABB(b: AABB, pad: number): AABB {
  return {
    x: b.x - pad,
    y: b.y - pad,
    width: b.width + pad * 2,
    height: b.height + pad * 2,
  };
}

/** Titik (CSS px) di dalam AABB? */
export function aabbContains(b: AABB, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

/**
 * Konversi kursor fisik layar (dari event `pet://cursor` shell) → CSS px
 * jendela pet. W = window luar; decorations off → border 0, jadi
 * client = (fisik - origin jendela fisik) / scaleFactor.
 * Murni — diuji tanpa jendela.
 */
export function physicalToClient(
  cursor: { x: number; y: number },
  winOrigin: { x: number; y: number },
  scaleFactor: number,
): { x: number; y: number } {
  const s = scaleFactor > 0 ? scaleFactor : 1;
  return { x: (cursor.x - winOrigin.x) / s, y: (cursor.y - winOrigin.y) / s };
}
