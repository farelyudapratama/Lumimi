/**
 * engine/native-clips.ts — klip motion native per-FILE (bukan per-grup).
 *
 * Sumber kebenaran: `FileReferences.Motions` manifest model (hasil adopsi
 * klip yatim + deklarasi rigger). Model-agnostic: id/nama klip diturunkan
 * dari grup Cubism dan stem nama file — tidak ada nama model atau grup yang
 * dipaksakan. Grup "" (nama kosong) sah di Cubism dan tetap diproses —
 * dulu klipnya tidak pernah bisa dimainkan karena registry skip grup kosong.
 *
 * Skema id (back-compat terjaga):
 * - grup bernama dengan TEPAT 1 klip → `motion_<grup>` (paritas perilaku lama)
 * - sisanya → `motion_<stem>` (+ akhiran _2, _3… bila bentrok), karena stem
 *   lebih bermakna bagi LLM dan Motion Studio daripada `motion_<grup>_<n>`.
 */

export interface NativeClip {
  id: string;
  /** Stem file / nama sintetis — tampilan untuk LLM & Motion Studio. */
  name: string;
  /** Grup framework tempat klip terdaftar (bisa string kosong). */
  group: string;
  /** Index klip di dalam grupnya. */
  index: number;
  /** Path file relatif manifest (absen pada fallback tanpa manifest). */
  file?: string;
  /** Detik, dari Meta.Duration klip (absen bila tidak terbaca). */
  duration?: number;
  /** Meta.Loop — klip loop tidak pernah selesai sendiri di framework. */
  loop?: boolean;
}

export function sanitizeClipId(raw: string): string {
  const s = String(raw || "").replace(/[^\p{L}\p{N}_-]/gu, "_");
  return s.length ? s : "klip";
}

function clipStem(clip: { Name?: unknown; File?: unknown }): string | null {
  const name = typeof clip.Name === "string" ? clip.Name.trim() : "";
  if (name) return name;
  const file = typeof clip.File === "string" ? clip.File : "";
  const base = file.split("/").pop() || "";
  if (!/\.motion3\.json$/i.test(base)) return null;
  return base.replace(/\.motion3\.json$/i, "");
}

function assignIds(
  clips: {
    group: string;
    index: number;
    stem: string;
    file?: string;
    duration?: number;
    loop?: boolean;
  }[],
  aliases?: Record<string, string>,
): NativeClip[] {
  const countByGroup = new Map<string, number>();
  for (const c of clips)
    countByGroup.set(c.group, (countByGroup.get(c.group) || 0) + 1);
  const used = new Set<string>();
  const out: NativeClip[] = [];
  for (const c of clips) {
    // Alias (rename via overlay) mengganti basis id + nama tampilan; grup &
    // index native TETAP asli — playback exact tidak ikut berubah.
    const alias =
      c.file && aliases && Object.prototype.hasOwnProperty.call(aliases, c.file)
        ? String(aliases[c.file]).trim()
        : "";
    // Grup bernama 1-klip memakai id berbasis grup (paritas registerNativeGroups lama);
    // sisanya berbasis stem — lebih bermakna dan tetap unik lewat dedupe.
    const single = c.group !== "" && (countByGroup.get(c.group) || 0) === 1;
    const base = alias || (single ? c.group : c.stem);
    let id = "motion_" + sanitizeClipId(base);
    for (let n = 2; used.has(id); n++) id = "motion_" + sanitizeClipId(base) + "_" + n;
    used.add(id);
    const entry: NativeClip = { id, name: alias || c.stem, group: c.group, index: c.index };
    if (c.file !== undefined) entry.file = c.file;
    if (typeof c.duration === "number" && c.duration > 0) entry.duration = c.duration;
    if (c.loop) entry.loop = true;
    out.push(entry);
  }
  return out;
}

function clipMetaOf(
  clip: { duration?: unknown; loop?: unknown },
  file: string | undefined,
  metaByFile?: Record<string, { duration?: number; loop?: boolean }>,
): { duration?: number; loop?: boolean } {
  const meta = (file ? (metaByFile || {})[file] : undefined) || {};
  const duration =
    typeof meta.duration === "number" && meta.duration > 0
      ? meta.duration
      : typeof clip.duration === "number" && clip.duration > 0
        ? clip.duration
        : undefined;
  const loop = meta.loop === true || clip.loop === true;
  return { duration, loop };
}

/** Bangun daftar klip dari FileReferences.Motions (objek grup → klip[]).
 * metaByFile (opsional) = File → {duration, loop} dari discovery server.
 * aliases (opsional) = File → nama tampilan (overlay rename non-destruktif:
 * file model tidak pernah disentuh, hanya id/nama registry yang mengikuti). */
export function buildNativeClips(
  motions: unknown,
  metaByFile?: Record<string, { duration?: number; loop?: boolean }>,
  aliases?: Record<string, string>,
): NativeClip[] {
  if (!motions || typeof motions !== "object" || Array.isArray(motions)) return [];
  const clips: {
    group: string;
    index: number;
    stem: string;
    file?: string;
    duration?: number;
    loop?: boolean;
  }[] = [];
  for (const [group, arr] of Object.entries(motions as Record<string, unknown>)) {
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i] as { Name?: unknown; File?: unknown; duration?: unknown; loop?: unknown } | null;
      if (!c || typeof c !== "object") continue;
      const file = typeof c.File === "string" ? c.File : undefined;
      if (!file) continue;
      const stem = clipStem(c);
      if (!stem) continue;
      const meta = clipMetaOf(c, file, metaByFile);
      clips.push({ group, index: i, stem, file, duration: meta.duration, loop: meta.loop });
    }
  }
  return assignIds(clips, aliases);
}

/** Fallback tanpa manifest: definitions facade ({grup: array-dummy} dari
 * framework) — hanya grup + jumlah klip, tanpa nama file. */
export function buildNativeClipsFromCounts(definitions: unknown): NativeClip[] {
  if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) return [];
  const clips: { group: string; index: number; stem: string }[] = [];
  for (const [group, arr] of Object.entries(definitions as Record<string, unknown>)) {
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const stem =
        group !== "" ? (arr.length === 1 ? group : group + "_" + (i + 1)) : "klip_" + (i + 1);
      clips.push({ group, index: i, stem });
    }
  }
  return assignIds(clips);
}
