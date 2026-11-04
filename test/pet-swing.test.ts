/**
 * Unit test fisika swing pet (src/client/pet/swing.ts) — deterministik.
 * Klaim: redaman zeta meluruhkan ayun, impuls akselerasi menggerakkan sudut,
 * sudut tampil selalu dalam clamp tanh (±38°).
 */
import { describe, expect, it } from "bun:test";
import { SWING_DEFAULTS, calmSwing, initialSwingState, swingStep } from "../src/client/pet/swing";

describe("pet swing — pendulum teredam", () => {
  it("tanpa dorongan & mulai nol → tetap diam", () => {
    let s = initialSwingState();
    for (let i = 0; i < 60; i++) {
      s = swingStep(s, { axPx: 0, heightPx: 400, dt: 1 / 60 });
    }
    expect(Math.abs(s.phi)).toBeLessThan(1e-9);
  });

  it("dorongan akselerasi membangkitkan ayun", () => {
    let s = initialSwingState();
    let maxShown = 0;
    for (let i = 0; i < 60; i++) {
      s = swingStep(s, { axPx: 400, heightPx: 400, dt: 1 / 60 });
      maxShown = Math.max(maxShown, Math.abs(s.phi));
    }
    expect(maxShown).toBeGreaterThan(0.05);
  });

  it("redaman zeta: ayun meluruh setelah dorongan berhenti", () => {
    let s = initialSwingState();
    for (let i = 0; i < 30; i++) {
      s = swingStep(s, { axPx: 600, heightPx: 400, dt: 1 / 60 });
    }
    const peak = Math.abs(s.phi);
    for (let i = 0; i < 600; i++) { // 10 detik tenang
      s = swingStep(s, { axPx: 0, heightPx: 400, dt: 1 / 60 });
    }
    expect(Math.abs(s.phi)).toBeLessThan(peak * 0.2);
    expect(Math.abs(s.omega)).toBeLessThan(peak);
  });

  it("sudut tampil TIDAK PERNAH melebihi clamp ±38° walau phi besar", () => {
    let s = { phi: 50, omega: 100 }; // keadaan ekstrem
    for (let i = 0; i < 120; i++) {
      const r = swingStep(s, { axPx: 0, heightPx: 400, dt: 1 / 60 });
      expect(Math.abs(r.shownAngle)).toBeLessThanOrEqual(SWING_DEFAULTS.maxAngle + 1e-9);
      s = { phi: r.phi, omega: r.omega };
    }
  });

  it("deterministik: input sama → hasil identik", () => {
    const run = (): number => {
      let s = initialSwingState();
      for (let i = 0; i < 120; i++) {
        s = swingStep(s, { axPx: 200 + (i % 7) * 50, heightPx: 400, dt: 1 / 60 });
      }
      return s.phi;
    };
    expect(run()).toBe(run());
  });

  it("model tinggi (panjang tali panjang) berayun lebih lambat daripada kecil", () => {
    // periode ~ 2π√(L/g): L besar → sudut maksimum lebih tercapai per waktu sama
    const swing = (h: number): number => {
      let s = initialSwingState();
      for (let i = 0; i < 60; i++) {
        s = swingStep(s, { axPx: 300, heightPx: h, dt: 1 / 60 });
      }
      return Math.abs(s.phi);
    };
    const kecil = swing(200);
    const besar = swing(800);
    expect(besar).toBeLessThan(kecil);
  });

  it("calmSwing: omega nol, phi dibagi dua", () => {
    const s = calmSwing({ phi: 0.4, omega: 2 });
    expect(s.omega).toBe(0);
    expect(s.phi).toBeCloseTo(0.2, 10);
  });

  it("invariansi: input fisika tidak menyentuh id param/nama model", () => {
    // Kunci model-agnostic: antarmuka hanya angka.
    const r = swingStep(initialSwingState(), { axPx: 100, heightPx: 300, dt: 0.016 });
    expect(typeof r.shownAngle).toBe("number");
  });
});
