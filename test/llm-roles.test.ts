/**
 * llm-roles.test.ts — prompt-split pembicara (Fase 2).
 *
 * Routing role (normalizeRoles, connHasRole, orderForRole, llmWithFallback)
 * sudah pindah ke Rust (core/src/llm.rs :: order_for_role + tes-nya) dan TIDAK
 * lagi dipakai aplikasi. Yang tersisa di sini hanya prompt-split brain.
 */
import { describe, test, expect } from "bun:test";
import { AgentBrain } from "../src/client/agent/brain";
// formatParamNotes pindah ke Rust core (director.rs :: notes_cap_24_x_200 +
// param_notes_dan_persona) bersama arsip src/server/ — Batch A 2026-09-23.

describe("prompt-split: prompt pembicara lean, kosakata + aksesoris tetap", () => {
  const brain = new AgentBrain() as any;
  brain.capProfile = {
    emotions: ["senang", "sedih"],
    nativeExpressions: ["exp_a"],
    accessories: ["ParamCheek"],
    properties: [],
    gestures: ["nod", "wave_hi"],
    motionCatalog: [],
    userNote: "dia pemalu",
    sheet: {
      params: [
        { id: "ParamAngleX", label: "ParamAngleX", min: -30, max: 30, def: 0, group: "Sudut (Angle)", userNote: "geser kepala kiri kanan" },
      ],
    },
    roleIds: {},
    paramRange: {},
  };

  const prompt: string = brain.buildSystemPrompt("");

  test("TABEL parameter TIDAK ada lagi di prompt pembicara", () => {
    expect(prompt).not.toContain("DAFTAR PARAMETER LENGKAP");
    expect(prompt).not.toContain("-30..30");
  });

  test("userNote per-parameter TIDAK ada (ini inti perbaikannya)", () => {
    expect(prompt).not.toContain("geser kepala kiri kanan");
  });

  test("identitas karakter (userNote top-level) TETAP ada", () => {
    expect(prompt).toContain("dia pemalu");
  });

  test("PURE-TEXT: prompt pembicara tak lagi menyuntik directive/kosakata ekspresi", () => {
    // Topologi §104: Animation Director pemilik ekspresi tunggal. Chat LLM cukup
    // menulis teks — daftar emosi/gesture + format [EMOTION:]/[GESTURE:] dicabut.
    expect(prompt).not.toContain("[EMOTION:");
    expect(prompt).not.toContain("[GESTURE:");
    expect(prompt).not.toContain("FORMAT DIRECTIVE");
    expect(prompt).not.toContain("nod"); // nama gesture tak lagi di prompt
  });

  test("aksesoris (id param) tak lagi di prompt pembicara (director yang urus)", () => {
    expect(prompt).not.toContain("ParamCheek");
  });

  test("prompt materialnya jauh lebih ramping (<4000 char)", () => {
    expect(prompt.length).toBeLessThan(4000);
  });
});

