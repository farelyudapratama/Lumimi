/**
 * engine/mouth-candidates.ts — kandidat parameter mulut untuk Lab Mulut.
 *
 * MURNI (tanpa DOM/localStorage) supaya bisa dites bun. Klasifikasi di sini
 * adalah DUGAAN dari nama/elemen manifest — bukan kebenaran. Kebenaran
 * kepemilikan ditentukan user lewat eksperimen (marks), hasilnya yang nanti
 * jadi kebijakan ownership. Nama model yang di-mangle (m_001) tidak menghasil
 * dugaan nama, tapi tetap masuk lewat evidence role/manifest/manual.
 *
 * Dua tahap pencocokan nama (mencegah false positive lintas-fitur):
 *   tahap a — param "berbau mulut"? token mulut/lip/vokal, latin pakai batas
 *             kata (jangan kena "clip"/"eyelid"), CJK pakai substring;
 *   tahap b — sub-fungsi: vowel → width(openX) → open → width → form → lip.
 */

export type MouthBucket = "open" | "width" | "form" | "vowel" | "lip" | "other";

export type Evidence = "role" | "manifest" | "name" | "manual";

/** Putusan user dari eksperimen — sumber kebijakan ownership nantinya. */
export type MouthVerdict = "lipsync" | "expression" | "ignore";

export interface ParamLike {
  id: string;
  label?: string;
  userNote?: string;
  min?: number;
  max?: number;
  def?: number;
}

export interface CandidateCtx {
  /** Id hasil role-mapping model aktif: {mouthOpenY, mouthOpenX, mouthForm}. */
  roleIds?: Record<string, string | undefined>;
  /** Id grup resmi LipSync dari manifest model (model3.json). */
  officialLipSyncIds?: string[];
  /** Id yang ditambahkan user secara manual di Lab. */
  manualIds?: string[];
}

export interface MouthCandidate {
  id: string;
  bucket: MouthBucket;
  evidence: Evidence[];
  /** Token nama yang kena, atau sumber non-nama ("role"/"manifest"/"manual"). */
  matchedBy: string;
  min: number;
  max: number;
  def: number;
  label?: string;
  note?: string;
}

export type Marks = Record<string, MouthVerdict>;

/** Role apertur yang dikenal — bucket-nya IKUT role, bukan nama param.
 * mouthForm sengaja terdaftar: lab harus menampilkannya supaya user bisa
 * membuktikan sendiri bahwa form milik ekspresi, bukan lipsync. */
const ROLE_BUCKETS: Array<[string, MouthBucket]> = [
  ["mouthOpenY", "open"],
  ["mouthOpenX", "width"],
  ["mouthForm", "form"],
];

export const BUCKET_ORDER: MouthBucket[] = ["open", "width", "form", "vowel", "lip", "other"];

const CJK_RE = /[^\x00-\x7F]/;

/** Token berbau mulut (tahap a). Latin diuji dengan batas kata supaya
 * "Clip" tidak kena "lip"; CJK cukup substring. */
const MOUTHISH_LATIN = [
  "mouth", "mulut", "lip", "bibir", "vowel", "vocal", "phoneme", "viseme", "fonem",
  "tongue", "lidah", "teeth", "tooth", "gigi",
];
const MOUTHISH_CJK = ["口", "唇", "嘴", "舌", "歯", "母音"];

const BUCKET_TOKENS: Array<[MouthBucket, string[]]> = [
  ["vowel", ["vowel", "vocal", "phoneme", "viseme", "fonem", "母音"]],
  ["open", ["open", "buka", "開", "开"]],
  ["width", ["wide", "width", "lebar", "幅", "宽"]],
  ["form", ["form", "smile", "senyum", "shape", "frown", "pout", "形", "笑"]],
  ["lip", ["lip", "bibir", "唇"]],
];

/** Ujung nama vokal tunggal setelah token mulut: ParamMouthA, Mouth_I, 口A.
 * "ParamMouthOpenY" tidak kena (berakhir "Y", bukan vokal a-i-u-e-o). */
const TRAILING_VOWEL_RE = /(?:mouth|mulut|lip|bibir|vowel|viseme|口|唇|嘴)[_\- ]?[aiueo]$/i;

function hasToken(id: string, token: string): boolean {
  if (CJK_RE.test(token)) return id.includes(token);
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Dibatasi non-huruf (snake/kebab/spasi) ATAU hump CamelCase — "MouthWide"
  // harus kena, "ClipX" tidak boleh kena token "lip".
  if (new RegExp(`(?:^|[^A-Za-z])${esc}(?:[^A-Za-z]|$)`, "i").test(id)) return true;
  const Hump = token.charAt(0).toUpperCase() + token.slice(1);
  return new RegExp(`(?<=[a-z])${Hump}`).test(id);
}

/** Dugaan bucket dari nama saja. null = nama tidak bicara (bukan kegagalan). */
export function classifyByName(id: string): { bucket: MouthBucket; matchedBy: string } | null {
  const mouthish =
    MOUTHISH_LATIN.some((t) => hasToken(id, t)) ||
    MOUTHISH_CJK.some((t) => id.includes(t));
  if (!mouthish) return null;

  if (TRAILING_VOWEL_RE.test(id)) return { bucket: "vowel", matchedBy: "vokal-akhir" };
  if (/(?:^|[^A-Za-z])open[_\- ]?x(?:[^A-Za-z]|$)|(?<=[a-z])open[_\- ]?x/i.test(id))
    return { bucket: "width", matchedBy: "openX" };
  for (const [bucket, tokens] of BUCKET_TOKENS) {
    for (const t of tokens) {
      if (hasToken(id, t)) return { bucket, matchedBy: t };
    }
  }
  return { bucket: "other", matchedBy: "mulut-lain" };
}

function rank(ev: Evidence[]): number {
  // Semakin banyak sumber, semakin ke atas di bucket yang sama.
  return -ev.length;
}

export function collectMouthCandidates(
  params: ParamLike[] | undefined,
  ctx: CandidateCtx = {},
): MouthCandidate[] {
  const out = new Map<string, MouthCandidate>();

  const put = (c: MouthCandidate) => {
    const prev = out.get(c.id);
    if (!prev) {
      out.set(c.id, c);
      return;
    }
    // Gabung evidence; bucket evidence kuat (role) menang atas nama.
    for (const e of c.evidence) if (!prev.evidence.includes(e)) prev.evidence.push(e);
    if (c.evidence.includes("role")) {
      prev.bucket = c.bucket;
      prev.matchedBy = c.matchedBy;
    }
  };

  const metaOf = (id: string): ParamLike =>
    (params || []).find((p) => p && p.id === id) || { id };

  const base = (p: ParamLike) => ({
    min: typeof p.min === "number" ? p.min : 0,
    max: typeof p.max === "number" ? p.max : 1,
    def: typeof p.def === "number" ? p.def : 0,
    label: p.label,
    note: p.userNote,
  });

  for (const p of params || []) {
    if (!p || !p.id) continue;
    const ev: Evidence[] = [];
    let bucket: MouthBucket | null = null;
    let matchedBy = "";
    const nm = classifyByName(p.id);
    if (nm) {
      ev.push("name");
      bucket = nm.bucket;
      matchedBy = nm.matchedBy;
    }
    if (ctx.officialLipSyncIds?.includes(p.id)) {
      ev.push("manifest");
      if (!bucket) {
        bucket = "other";
        matchedBy = "manifest";
      }
    }
    const roleHit = ROLE_BUCKETS.find(([role]) => ctx.roleIds?.[role] === p.id);
    if (roleHit) {
      ev.push("role");
      bucket = roleHit[1];
      matchedBy = roleHit[0];
    }
    if (!ev.length || !bucket) continue;
    put({ id: p.id, bucket, evidence: ev, matchedBy, ...base(p) });
  }

  // Role ter-resolve yang tak ada di daftar params (sheet basi) — tetap
  // ditampilkan dengan rentang netral supaya eksperimen bisa jalan.
  for (const [role, bucket] of ROLE_BUCKETS) {
    const id = ctx.roleIds?.[role];
    if (!id || out.has(id)) continue;
    put({
      id,
      bucket,
      evidence: ["role"],
      matchedBy: role,
      min: 0,
      max: 1,
      def: 0,
    });
  }

  // Id manual user — param eksotis tanpa nama berbau mulut.
  for (const id of ctx.manualIds || []) {
    if (!id || out.has(id)) continue;
    const p = metaOf(id);
    const nm = classifyByName(id);
    put({
      id,
      bucket: nm?.bucket ?? "other",
      evidence: ["manual"],
      matchedBy: "manual",
      ...base(p),
      label: p.label,
      note: p.userNote,
    });
  }

  return [...out.values()].sort(
    (a, b) =>
      BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) ||
      rank(a.evidence) - rank(b.evidence) ||
      (a.id < b.id ? -1 : 1),
  );
}

/** Gabung patch verdict ke marks tersimpan — entri undefined/hapus kunci. */
export function mergeMarks(prev: Marks, patch: Marks): Marks {
  const out: Marks = { ...prev };
  for (const [id, v] of Object.entries(patch)) {
    if (v) out[id] = v;
    else delete out[id];
  }
  return out;
}
