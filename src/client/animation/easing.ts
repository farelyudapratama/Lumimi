/**
 * animation/easing.ts — Cubic easing functions for keyframe interpolation.
 */

export type EasingMode = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "stepped";

export function ease(t: number, mode: EasingMode): number {
  switch (mode) {
    case "stepped": return 0;
    case "ease-in": return t * t * t;
    case "ease-out": return 1 - Math.pow(1 - t, 3);
    case "ease-in-out":
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case "linear":
    default: return t;
  }
}

/**
 * Clamp a value to a range.
 */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
