/**
 * test/role-mapping.test.ts — jaminan MODEL-AGNOSTIC untuk role mapping &
 * skala referensi, diuji LANGSUNG terhadap modul sumber kebenaran
 * src/client/engine/role-mapping.ts (bukan lagi salinan port — duplikat di
 * guard legacy test-role-mapping.js / test-param-scaling.js dipensiunkan).
 *
 * Kelas cacat yang difalsifikasi: fitur yang bergantung pada NAMA, ANGKA,
 * atau URUTAN yang bebas dipilih rigger. Kegagalannya senyap — karakter jadi
 * datar/salah gerak tanpa satu pun error.
 */
import {
  ROLE_KEYWORDS,
  GROUP_PATTERNS,
  REF_HALF,
  DEGREE_ROLES,
  refHalfFor,
  pickFromGroup,
  mapRoles,
  toActual,
  roleClampActual,
  normToRange,
  roleDefaultOf,
  writeRef,
  devToActual,
  detectAccessories,
  type ParamRange,
} from "../src/client/engine/role-mapping";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

/** Rig = peta role → range; fungsi write memakai matematika modul TS. */
function makeRig(ranges: Record<string, ParamRange>) {
  const get = (role: string) => ranges[role] || null;
  return {
    write: (role: string, vRef: number) => writeRef(role, vRef, get(role)),
    toActual: (role: string, vRef: number) => toActual(role, vRef, get(role)),
    clampActual: (role: string, v: number) => roleClampActual(role, v, get(role)),
    pokeRoleNorm: (role: string, t: number) => normToRange(t, get(role)),
    roleDefault: (role: string) => roleDefaultOf(get(role)),
  };
}

describe("role mapping — model-agnostic", () => {
  // ── A. Regresi: urutan grup LipSync tidak boleh meng-alias mouthOpenY ──
  test("mouthOpenY memilih param OPEN, bukan indeks 0", () => {
    const params = new Set(["ParamMouthForm", "ParamMouthOpenY", "ParamAngleX"]);
    const official = { lipSyncIds: ["ParamMouthForm", "ParamMouthOpenY"], eyeBlinkIds: [] };
    const r = mapRoles(params, official);
    expect(r.mouthOpenY).toBe("ParamMouthOpenY");
    expect(r.mouthOpenY).not.toBe(r.mouthForm);
  });

  test("urutan grup dibalik memberi hasil IDENTIK (bukti bebas-urutan)", () => {
    const params = new Set(["ParamMouthForm", "ParamMouthOpenY"]);
    const a = mapRoles(params, { lipSyncIds: ["ParamMouthForm", "ParamMouthOpenY"], eyeBlinkIds: [] });
    const b = mapRoles(params, { lipSyncIds: ["ParamMouthOpenY", "ParamMouthForm"], eyeBlinkIds: [] });
    expect(a.mouthOpenY).toBe(b.mouthOpenY);
  });

  // ── B. Regresi: urutan grup EyeBlink tidak boleh menukar L/R ──
  test("rigger yang menulis R dulu tidak menukar mata", () => {
    const params = new Set(["ParamEyeLOpen", "ParamEyeROpen"]);
    const r = mapRoles(params, { eyeBlinkIds: ["ParamEyeROpen", "ParamEyeLOpen"], lipSyncIds: [] });
    expect(r.eyeLOpen).toBe("ParamEyeLOpen");
    expect(r.eyeROpen).toBe("ParamEyeROpen");
  });

  // ── C. Regresi: id bernomor tidak boleh membawa makna ──
  test("Param91 tidak diklaim sebagai blush (ekor model lain tetap ekor)", () => {
    const params = new Set(["Param91", "ParamAngleX", "ParamMouthForm"]);
    const r = mapRoles(params, null);
    expect(r.blush).toBeUndefined();
  });

  test("cheek PUFF bukan blush", () => {
    const params = new Set(["ParamCheekPuffR", "ParamCheekPuffL"]);
    expect(mapRoles(params, null).blush).toBeUndefined();
  });

  test("param blush sungguhan tetap ditemukan", () => {
    const r = mapRoles(new Set(["ParamBlush", "Param91"]), null);
    expect(r.blush).toBe("ParamBlush");
  });

  // ── D. Invariansi penggantian nama: rig sama dalam 4 kosakata ──
  test("EN/JA/ZH/meledak (m_001) resolve konsisten", () => {
    const schemes = {
      english: { angleX: "ParamAngleX", mouthOpen: "ParamMouthOpenY", mouthForm: "ParamMouthForm", eyeL: "ParamEyeLOpen", eyeR: "ParamEyeROpen" },
      japanese: { angleX: "頭の左右", mouthOpen: "口開き", mouthForm: "口形", eyeL: "左目の開閉", eyeR: "右目の開閉" },
      chinese: { angleX: "头部左右", mouthOpen: "张嘴", mouthForm: "嘴形", eyeL: "左眼开闭", eyeR: "右眼开闭" },
    };
    for (const [name, s] of Object.entries(schemes)) {
      const params = new Set(Object.values(s));
      const official = { lipSyncIds: [s.mouthForm, s.mouthOpen], eyeBlinkIds: [s.eyeR, s.eyeL] };
      const r = mapRoles(params, official);
      expect(r.mouthOpenY).toBeTruthy();
      expect(r.mouthOpenY).not.toBe(r.mouthForm);
      expect(r.angleX).toBe(s.angleX);
      expect(r.eyeLOpen).toBe(s.eyeL);
      expect(r.eyeROpen).toBe(s.eyeR);
    }
  });

  // ── E. Model opaque: resolve NIHIL, bukan menebak ──
  test("m_001..m_020 resolve ke nol role (tanpa positif palsu)", () => {
    const params = new Set(Array.from({ length: 20 }, (_, i) => `m_${String(i).padStart(3, "0")}`));
    const r = mapRoles(params, null);
    expect(Object.keys(r).length).toBe(0);
  });

  test("grup resmi menyelamatkan model opaque: satu anggota dipakai", () => {
    const params = new Set(["m_001", "m_002", "m_003"]);
    const r = mapRoles(params, { lipSyncIds: ["m_002"], eyeBlinkIds: [] });
    expect(r.mouthOpenY).toBe("m_002");
  });

  test("grup opaque ambigu (2 anggota tanpa sinyal nama) tidak ditebak", () => {
    const params = new Set(["m_001", "m_002"]);
    const r = mapRoles(params, { lipSyncIds: ["m_001", "m_002"], eyeBlinkIds: [] });
    expect(r.mouthOpenY).toBeUndefined();
  });

  // ── F. Metadata Groups tidak boleh menyuntik param yang tak dimiliki ──
  test("id dari Groups yang tak ada di model ditolak", () => {
    const params = new Set(["ParamMouthForm"]);
    const r = mapRoles(params, { lipSyncIds: ["ParamMouthOpenY"], eyeBlinkIds: [] });
    expect(r.mouthOpenY).not.toBe("ParamMouthOpenY");
  });

  // ── G. Deteksi aksesoris terukur, bukan daftar ──
  test("param toggle bernomor terdeteksi di penomoran mana pun", () => {
    const withAcc = [
      { id: "Param91", min: 0, max: 1, def: 0 },
      { id: "Param92", min: 0, max: 1, def: 0 },
      { id: "Param52", min: 0, max: 1, def: 0 },
      { id: "ParamAngleX", min: -30, max: 30, def: 0 },
    ];
    const roles = mapRoles(new Set(withAcc.map((p) => p.id)), null);
    expect(detectAccessories(withAcc, roles)).toEqual(["Param91", "Param92", "Param52"]);

    const other = [
      { id: "Param7", min: 0, max: 1, def: 0 },
      { id: "Param300", min: 0, max: 1, def: 0 },
    ];
    const roles2 = mapRoles(new Set(other.map((p) => p.id)), null);
    expect(detectAccessories(other, roles2)).toEqual(["Param7", "Param300"]);
  });

  test("model tanpa aksesoris → nol; role tidak bocor jadi aksesoris", () => {
    const noAcc = [
      { id: "ParamMouthForm", min: -1, max: 1, def: 0 },
      { id: "ParamMouthOpenY", min: 0, max: 1, def: 0 },
    ];
    const roles = mapRoles(new Set(noAcc.map((p) => p.id)), null);
    expect(detectAccessories(noAcc, roles)).toEqual([]);

    const roleShaped = [{ id: "Param91", min: 0, max: 1, def: 0 }];
    expect(detectAccessories(roleShaped, { blush: "Param91" })).toEqual([]);
  });

  // ── I. Guard sumber: tabel bebas id bernomor ──
  test("ROLE_KEYWORDS bebas id bernomor", () => {
    const offenders: string[] = [];
    for (const role in ROLE_KEYWORDS)
      for (const kw of ROLE_KEYWORDS[role])
        if (/^Param\d+$/i.test(kw)) offenders.push(`${role}:${kw}`);
    expect(offenders).toEqual([]);
  });

  test("app.js tidak lagi memuat tabel sendiri (sumber kebenaran = modul TS)", () => {
    const src = readFileSync(join(__dirname, "..", "static", "js", "app.js"), "utf8");
    const kwBlock = src.slice(src.indexOf("const ROLE_KEYWORDS"), src.indexOf("const GROUP_PATTERNS"));
    const kwCode = kwBlock.split("\n").map((l) => l.replace(/\r$/, "").replace(/\/\/.*$/, "")).join("\n");
    expect(kwCode.match(/'Param\d+'/g) || []).toEqual([]);
  });
});

describe("param scaling — skala referensi tidak bocor asumsi model", () => {
  // Tiga rig: referensi, kecil (derajat), dan hostile (persen, mata
  // terbalik, default non-nol).
  const REFERENCE = makeRig({
    angleX: { min: -30, max: 30, def: 0 },
    eyeBallX: { min: -1, max: 1, def: 0 },
    eyeLOpen: { min: 0, max: 1, def: 1 },
    breath: { min: 0, max: 1, def: 0 },
    mouthOpenY: { min: 0, max: 1, def: 0 },
  });
  const SMALL = makeRig({
    angleX: { min: -10, max: 10, def: 0 },
    eyeBallX: { min: -0.5, max: 0.5, def: 0 },
    eyeLOpen: { min: 0, max: 1, def: 1 },
    breath: { min: 0, max: 1, def: 0 },
    mouthOpenY: { min: 0, max: 1, def: 0 },
  });
  const HOSTILE = makeRig({
    angleX: { min: -90, max: 90, def: 0 },
    eyeBallX: { min: -10, max: 10, def: 0 },
    eyeLOpen: { min: 0, max: 100, def: 100 }, // persen, istirahat TERBUKA
    breath: { min: 0, max: 100, def: 0 },
    mouthOpenY: { min: 0, max: 100, def: 20 }, // istirahat sedikit terbuka
  });

  test("A: skala referensi mereproduksi dirinya di rig referensi", () => {
    expect(REFERENCE.write("angleX", -30)).toBe(-30);
    expect(REFERENCE.write("angleX", 0)).toBe(0);
    expect(REFERENCE.write("eyeBallX", 1)).toBe(1); // gaze pakai ±1, bukan ±30
  });

  test("B: intent yang sama menskala PROPORSIONAL lintas rig", () => {
    for (const [name, rig, expectMax] of [["reference", REFERENCE, 30], ["small", SMALL, 10], ["hostile", HOSTILE, 90]] as const) {
      expect(rig.write("angleX", 30)).toBe(expectMax);
      expect(rig.write("angleX", 15)).toBe(expectMax / 2);
    }
    // Rig kecil tidak digiring ke ±30 (over-rotate), rig besar tidak dicap 30 (under-rotate).
    expect(Math.abs(SMALL.write("angleX", 30))).toBe(10);
    expect(Math.abs(HOSTILE.write("angleX", 30))).toBe(90);
  });

  test("C: gaze tidak tergencet referensi derajat", () => {
    for (const [name, rig, r] of [["reference", REFERENCE, 1], ["small", SMALL, 0.5], ["hostile", HOSTILE, 10]] as const) {
      expect(rig.write("eyeBallX", 1)).toBe(r);
    }
    expect(Math.abs(HOSTILE.write("eyeBallX", 1))).toBeGreaterThan(1);
  });

  test("D: penulis ternormalisasi (kedip/napas/lip-sync) hormati range nyata", () => {
    expect(HOSTILE.pokeRoleNorm("eyeLOpen", 0)).toBe(0);
    expect(HOSTILE.pokeRoleNorm("eyeLOpen", 1)).toBe(100); // bukan literal 1 = 1% terbuka
    expect(HOSTILE.pokeRoleNorm("breath", 1)).toBe(100);
    const talkPeak = HOSTILE.pokeRoleNorm("mouthOpenY", 0.75);
    expect(talkPeak).toBe(75);
    expect(talkPeak).toBeGreaterThan(1); // literal 0.75 = mata-mata terpejam
  });

  test("E: nilai istirahat dari default MODEL, bukan 0", () => {
    expect(HOSTILE.roleDefault("eyeLOpen")).toBe(100);
    expect(HOSTILE.roleDefault("mouthOpenY")).toBe(20);
    expect(makeRig({}).roleDefault("mouthOpenY")).toBe(0);
  });

  test("F: clamp tidak pernah lolos dari range deklarasi model", () => {
    for (const [name, rig, lo, hi] of [["reference", REFERENCE, -30, 30], ["small", SMALL, -10, 10], ["hostile", HOSTILE, -90, 90]] as const) {
      expect(rig.write("angleX", 999)).toBe(hi);
      expect(rig.write("angleX", -999)).toBe(lo);
    }
    expect(HOSTILE.pokeRoleNorm("eyeLOpen", 5)).toBe(100);
    expect(HOSTILE.pokeRoleNorm("eyeLOpen", -5)).toBe(0);
  });

  test("G: range asimetris — midpoint yang benar, bukan 0", () => {
    const ASYM = makeRig({ angleX: { min: -10, max: 40, def: 15 } });
    expect(ASYM.write("angleX", 0)).toBe(15);
    expect(ASYM.write("angleX", 30)).toBe(40);
    expect(ASYM.write("angleX", -30)).toBe(-10);
  });

  test("H: tanpa info range → degradasi aman, tidak liar", () => {
    const BLIND = makeRig({});
    expect(BLIND.write("angleX", 999)).toBe(30);
    expect(BLIND.write("eyeBallX", 999)).toBe(1);
  });

  // ── J. Sheet nyata di disk: semua tulisan role mendarat di dalam range ──
  test("sheet nyata: write(role, ±ref) selalu di dalam range & tidak mati", () => {
    const { readdirSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const dir = join(__dirname, "..", "data", "sheets");
    let checked = 0;
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
        let d: any;
        try { d = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
        const byId: Record<string, any> = {};
        (d.params || []).forEach((p: any) => { byId[p.id] = p; });
        const ranges: Record<string, ParamRange> = {};
        for (const [role, id] of Object.entries(d.roleIds || {})) {
          const p = (d.paramRange || {})[id as string] || byId[id as string];
          if (p && typeof p.min === "number" && typeof p.max === "number")
            ranges[role] = { min: p.min, max: p.max, def: p.def };
        }
        if (!Object.keys(ranges).length) continue;
        checked++;
        const rig = makeRig(ranges);
        for (const [role, r] of Object.entries(ranges)) {
          for (const vRef of [-refHalfFor(role), 0, refHalfFor(role)]) {
            const out = rig.write(role, vRef);
            expect(Number.isNaN(out)).toBe(false);
            expect(out).toBeGreaterThanOrEqual(r.min - 1e-9);
            expect(out).toBeLessThanOrEqual(r.max + 1e-9);
          }
          if (r.max !== r.min)
            expect(approx(rig.write(role, refHalfFor(role)), rig.write(role, 0))).toBe(false);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  // ── Konstanta inti tetap bernilai historis ──
  test("REF_HALF=30 & DEGREE_ROLES utuh", () => {
    expect(REF_HALF).toBe(30);
    expect(DEGREE_ROLES.has("angleX")).toBe(true);
    expect(DEGREE_ROLES.has("mouthOpenY")).toBe(false);
    expect(refHalfFor("bodyAngleZ")).toBe(30);
    expect(refHalfFor("breath")).toBe(1);
    expect(pickFromGroup(["ParamMouthOpenY"], GROUP_PATTERNS.mouthOpenY)).toBe("ParamMouthOpenY");
  });
});

// ── K. devToActual — deviasi-dari-default untuk field ekspresi v2 ──
describe("devToActual — 0 = default milik model, bukan midpoint", () => {
  const rig = (role: string, r: ParamRange | null) => ({
    dev: (v: number) => devToActual(role, v, r),
  });

  test("rig default non-nol: 0 diam di default, +1 max, -1 min", () => {
    // Senyum mata 0..100, default 80 — midpoint (50) akan melihat mata
    // "setengah senyum permanen" saat track pulang ke 0. Default yang benar.
    const R = rig("eyeLSmile", { min: 0, max: 100, def: 80 });
    expect(R.dev(0)).toBe(80);
    expect(R.dev(1)).toBe(100);
    expect(R.dev(-1)).toBe(0);
    expect(R.dev(0.5)).toBe(90);
    expect(R.dev(-0.5)).toBe(40);
  });

  test("rig default nol simetris: identik dengan peta midpoint", () => {
    const R = rig("mouthOpenY", { min: 0, max: 1, def: 0 });
    expect(R.dev(0)).toBe(0);
    expect(R.dev(1)).toBe(1);
    expect(R.dev(-1)).toBe(0); // def == min → sisi bawah runtuh (aman)
  });

  test("tanpa range → degradasi clamp ±1, tidak liar", () => {
    const B = rig("mouthOpenY", null);
    expect(B.dev(3)).toBe(1);
    expect(B.dev(-3)).toBe(-1);
  });

  test("invarian rename: role lain dengan range sama menghasilkan nilai sama", () => {
    const a = devToActual("mouthOpenY", 0.8, { min: 0, max: 50, def: 5 });
    const b = devToActual("m_001", 0.8, { min: 0, max: 50, def: 5 });
    expect(a).toBe(b);
  });
});
