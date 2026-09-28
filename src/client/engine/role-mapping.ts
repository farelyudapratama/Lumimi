/**
 * engine/role-mapping.ts — SATU sumber kebenaran role mapping & skala referensi.
 *
 * Kenapa modul ini ada: logika mapRoles + role-space math hidup di legacy
 * app.js (browser IIFE, tidak bisa diimpor) dan DUPLIKATNYA di guard
 * test-role-mapping.js / test-param-scaling.js ("keep in sync" manual —
 * resep copy-drift). Modul ini mengambil alih sebagai sumber kebenaran:
 *   - app.js memakainya lewat window.__roleMapping (wrapper tipis);
 *   - test/role-mapping.test.ts (bun test) mengujinya langsung.
 *
 * Aturan model-agnostic (lihat docs/MODEL-AGNOSTIC-RULES.md):
 *   - Tidak ada id bernomor (Param91) di tabel universal mana pun.
 *   - Makna TIDAK pernah diambil dari urutan array (lipSyncIds[0] dsb.) —
 *     anggota grup dipilih lewat pola nama (pickFromGroup), bukan indeks.
 *   - Menulis ke parameter HANYA lewat role space: nilai referensi
 *     (±30 derajat / ±1 ternormalisasi) dipetakan ke range milik model.
 *
 * Semua fungsi MURNI (tidak menyentuh state/DOM) agar bisa diuji & dipakai
 * server maupun client.
 */

// ── Tabel kosakata role ─────────────────────────────────────────────
// Prioritas pencarian: grup resmi (model3.json Groups, dipilih by-name) →
// id kanonik Cubism → keyword substring (EN/JA/ZH). JANGAN menambah id
// bernomor di sini — positif palsu pada rig lain gagalnya SENYAP.
export const ROLE_KEYWORDS: Record<string, string[]> = Object.freeze({
  angleX: [
    "ParamAngleX", "AngleX", "angle_x", "yaw", "turnx", "rotx",
    "頭", "头", "横向", "左右", "朝向x", "方向x",
  ],
  angleY: [
    "ParamAngleY", "AngleY", "angle_y", "pitch", "turny", "roty",
    "縦", "纵向", "上下", "朝向y", "方向y",
  ],
  angleZ: [
    "ParamAngleZ", "AngleZ", "angle_z", "roll", "tilt",
    "傾", "倾", "回転z", "旋转z", "歪",
  ],
  eyeBallX: [
    "ParamEyeBallX", "EyeBallX", "eyeball_x", "lookx",
    "瞳X", "瞳", "眼球", "目玉", "视x",
  ],
  eyeBallY: [
    "ParamEyeBallY", "EyeBallY", "eyeball_y", "looky",
    "瞳Y", "瞳", "眼球", "目玉", "视y",
  ],
  eyeLOpen: ["ParamEyeLOpen", "EyeLOpen", "eye_l_open", "左目", "左眼"],
  eyeROpen: ["ParamEyeROpen", "EyeROpen", "eye_r_open", "右目", "右眼"],
  eyeLSmile: ["ParamEyeLSmile", "EyeLSmile", "eye_l_smile", "左目笑", "左眼笑"],
  eyeRSmile: ["ParamEyeRSmile", "EyeRSmile", "eye_r_smile", "右目笑", "右眼笑"],
  eyeForm: ["ParamEyeForm", "EyeForm", "eye_form", "目形", "眼形"],
  mouthOpenY: [
    "ParamMouthOpenY", "MouthOpenY", "mouth_open", "口開", "张口", "张嘴",
  ],
  mouthForm: [
    "ParamMouthForm", "MouthForm", "mouth_form", "口角", "口形", "嘴形", "口型",
  ],
  mouthOpenX: ["ParamMouthOpenX", "MouthOpenX", "mouth_wide", "口幅", "嘴宽"],
  bodyAngleX: [
    "ParamBodyAngleX", "BodyAngleX", "body_angle_x", "bodyx", "体", "胴", "躯",
  ],
  bodyAngleY: [
    "ParamBodyAngleY", "BodyAngleY", "body_angle_y", "bodyy", "体", "胴", "躯",
  ],
  bodyAngleZ: [
    "ParamBodyAngleZ", "BodyAngleZ", "body_angle_z", "bodyz", "体", "胴", "躯",
  ],
  breath: ["ParamBreath", "Breath", "breath", "呼吸", "breathe", "息"],
  browLForm: ["ParamBrowLForm", "BrowLForm", "brow_l", "左眉", "眉"],
  browRForm: ["ParamBrowRForm", "BrowRForm", "brow_r", "右眉", "眉"],
  browLY: ["ParamBrowLY", "BrowLY", "brow_l_y", "左眉Y", "左眉上下"],
  browRY: ["ParamBrowRY", "BrowRY", "brow_r_y", "右眉Y", "右眉上下"],
  browLAngle: ["ParamBrowLAngle", "BrowLAngle", "brow_l_angle", "左眉角"],
  browRAngle: ["ParamBrowRAngle", "BrowRAngle", "brow_r_angle", "右眉角"],
  blush: [
    "ParamBlush", "Blush", "blush", "ParamCheekRed", "CheekRed",
    "頬紅", "ほお染め", "照れ", "脸红", "腮红", "害羞",
  ],
  // ear: jangan pakai substring "earl" telanjang — "pearl" berisi "earl"
  // (positif palsu senyap di rig aksesori). Patokan: keluarga kanonik
  // ParamEar* + token terpisah + CJK.
  ear: [
    "ParamEar", "ear_l", "ear_r", "earleft", "earright", "_ear", "耳",
  ],
});

// Pola pemilih anggota grup resmi. Grup model3.json (LipSync/EyeBlink)
// OTORITATIF soal keanggotaan tapi TIDAK soal urutan — pola ini memilih
// anggota yang paling "buka" (mouthOpenY) / paling kiri-kanan (eyeL/eyeR).
export const GROUP_PATTERNS: Record<string, RegExp[]> = Object.freeze({
  mouthOpenY: [
    /openy$/i, /mouthopen/i, /open/i, /口開|開口|口を開/, /张口|张嘴|开口/,
  ],
  eyeLOpen: [
    /eyelopen/i, /^parameyel.*open/i, /_l_?open/i, /left.*open/i, /左目|左眼/,
  ],
  eyeROpen: [
    /eyeropen/i, /^parameyer.*open/i, /_r_?open/i, /right.*open/i, /右目|右眼/,
  ],
});

export interface OfficialGroups {
  eyeBlinkIds: string[];
  lipSyncIds: string[];
}

/** Pilih satu id dari pool grup by-name (bukan by-indeks). */
export function pickFromGroup(
  list: string[] | null | undefined,
  patterns: RegExp[],
): string | null {
  if (!Array.isArray(list) || !list.length) return null;
  for (const re of patterns) {
    const hit = list.find((id) => typeof id === "string" && re.test(id));
    if (hit) return hit;
  }
  return null;
}

/**
 * Petakan parameter model → role. `official` = grup resmi dari manifest.
 * Urutan resolusi per role:
 *   1. grup resmi yang dimiliki model (by-name; satu-satunya anggota juga sah)
 *   2. id kanonik Cubism (`Param` + Role)
 *   3. keyword substring (lowercase, EN/JA/ZH)
 * Invarian yang dijaga: mouthOpenY tidak boleh alias ke mouthForm — kalau
 * bertabrakan, cari parameter "buka" lain, atau lepas mouthOpenY (jangan
 * menebak).
 */
export function mapRoles(
  paramSet: Set<string> | null | undefined,
  official?: Partial<OfficialGroups> | null,
): Record<string, string> {
  const ids: Record<string, string> = {};
  if (!paramSet || !paramSet.size) return ids;
  const list = Array.from(paramSet).map((id) => id.toLowerCase());
  const lowerToReal: Record<string, string> = {};
  Array.from(paramSet).forEach((id) => {
    lowerToReal[id.toLowerCase()] = id;
  });
  for (const role in ROLE_KEYWORDS) {
    if (official && GROUP_PATTERNS[role]) {
      const pool =
        role === "mouthOpenY" ? official.lipSyncIds : official.eyeBlinkIds;

      const owned = (pool || []).filter((id) => paramSet.has(id));
      const picked = pickFromGroup(owned, GROUP_PATTERNS[role]);
      if (picked) {
        ids[role] = picked;
        continue;
      }

      if (owned.length === 1) {
        ids[role] = owned[0];
        continue;
      }
    }

    const canonical =
      "Param" + role.charAt(0).toUpperCase() + role.slice(1);
    if (paramSet.has(canonical)) {
      ids[role] = canonical;
      continue;
    }

    let foundLower: string | null = null;
    for (const kw of ROLE_KEYWORDS[role]) {
      const lk = kw.toLowerCase();
      const hit = list.find((x) => x.includes(lk));
      if (hit) {
        foundLower = hit;
        break;
      }
    }
    if (foundLower) ids[role] = lowerToReal[foundLower];
  }

  if (ids.mouthOpenY && ids.mouthOpenY === ids.mouthForm) {
    const alt = Array.from(paramSet).find(
      (id) =>
        /open/i.test(id) &&
        /mouth|口|嘴/i.test(id) &&
        id !== ids.mouthForm,
    );
    if (alt) ids.mouthOpenY = alt;
    else delete ids.mouthOpenY;
  }
  return ids;
}

// ── Role space: skala referensi → range model ───────────────────────
// Semua gerak ditulis dalam skala referensi: ±30 untuk role derajat,
// ±1 (0..1) untuk role ternormalisasi. Fungsi di bawah memetakan nilai
// referensi itu ke range MIN..MAX milik model — rig 0..100, range
// terbalik, atau netral non-nol tetap bergerak benar, tanpa error.

export const REF_HALF = 30;

export const DEGREE_ROLES: ReadonlySet<string> = Object.freeze(
  new Set([
    "angleX", "angleY", "angleZ",
    "bodyAngleX", "bodyAngleY", "bodyAngleZ",
  ]),
);

export function refHalfFor(role: string): number {
  return DEGREE_ROLES.has(role) ? REF_HALF : 1;
}

export interface ParamRange {
  min: number;
  max: number;
  def: number;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** Nilai referensi vRef → nilai aktual di range model (midpoint-true). */
export function toActual(
  role: string,
  vRef: number,
  r: ParamRange | null | undefined,
): number {
  const RH = refHalfFor(role);
  if (!r) return clamp(vRef, -RH, RH);
  const mid = (r.max + r.min) / 2;
  const half = (r.max - r.min) / 2;
  return mid + (vRef / RH) * (half || RH);
}

/** Clamp ke range deklarasi model; tanpa range → fallback ±42. */
export function roleClampActual(
  role: string,
  v: number,
  r: ParamRange | null | undefined,
): number {
  if (!r) return clamp(v, -42, 42);
  return clamp(v, r.min, r.max);
}

/** t 0..1 → min..max milik model (tanpa range → clamp 0..1). */
export function normToRange(
  t: number,
  r: ParamRange | null | undefined,
): number {
  if (!r) return clamp(t, 0, 1);
  return r.min + clamp(t, 0, 1) * (r.max - r.min);
}

/**
 * v deviasi-dari-default (0 = pose istirahat, +1 = max, −1 = min) → nilai
 * aktual. Dipakai role yang semantiknya "efek" (senyum mata, buka mulut):
 * 0 wajib berarti diam-diam di default MILIK model, bukan midpoint — rig
 * dengan default non-nol tetap berhenti di pose aslinya saat track pulang
 * ke 0 (MODEL-AGNOSTIC-RULES: jangan asumsikan 0 sebagai tengah).
 * Tanda tangan disimetrikan dengan toActual supaya wrapper app.js seragam.
 */
export function devToActual(
  role: string,
  v: number,
  r: ParamRange | null | undefined,
): number {
  void role;
  if (!r) return clamp(v, -1, 1);
  const def = roleDefaultOf(r);
  const span = v >= 0 ? r.max - def : def - r.min;
  return def + v * (span || 0);
}

/** Nilai istirahat = default MILIK model, bukan 0. */
export function roleDefaultOf(r: ParamRange | null | undefined): number {
  return r && typeof r.def === "number" ? r.def : 0;
}

/**
 * Deteksi aksesoris TOGGLE — terukur dari bentuk parameter, bukan daftar:
 * range 0..1, default 0, bukan role apa pun, dan (untuk id kanonik)
 * bernomor/berkategoi "Kustom". Rig mana pun dengan penomoran bebas
 * menghasilkan deteksi yang sama.
 */
export function detectAccessories(
  params: Array<{ id: string; min: number; max: number; def: number }>,
  roleIds: Record<string, string>,
): string[] {
  const ROLE_ID_SET = new Set(Object.values(roleIds).filter(Boolean));
  return params
    .filter(
      (p) =>
        p.min >= 0 &&
        p.max <= 1 &&
        p.def === 0 &&
        !ROLE_ID_SET.has(p.id) &&
        !/physics/i.test(p.id) &&
        /^Param\d+$/.test(p.id),
    )
    .map((p) => p.id);
}

/** Tulis penuh: ref → actual → clamp (urutan wrapper app.js). */
export function writeRef(
  role: string,
  vRef: number,
  r: ParamRange | null | undefined,
): number {
  return roleClampActual(role, toActual(role, vRef, r), r);
}
