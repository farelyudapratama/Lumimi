/**
 * pet/react — resolusi reaksi SEMANTIK (model-agnostic).
 *
 * Aturan MODEL-AGNOSTIC-RULES: tidak ada id grup/nama model hardcode. Verb
 * semantik (kosakata motion-taxonomy VERBS + fallback "touch") dicocokkan
 * fuzzy ke grup motion / nama ekspresi yang BENAR-BENAR dimiliki model.
 * Tidak ada yang cocok → null (pemanggil degradasi diam: bubble saja).
 * Pola sama dengan brain.ts expressReplyOverlay — di sini versi murni yang
 * bisa diuji.
 */

/** Verb → urutan preferensi (petama yang cocok dipakai). */
export const REACTION_VERBS: Record<string, string[]> = {
  boop: ["surprised", "happy", "touch"],
  pat: ["happy", "shy", "touch"],
  grab: ["surprised", "sad", "touch"],
  wave: ["wave", "happy", "touch"],
  greet: ["wave", "happy", "touch"],
};

/** Sinonim keyword per verb — fuzzy match dua arah (lowercase). */
const VERB_SYNONYMS: Record<string, string[]> = {
  wave: ["wave", "hello", "greet", "bye", "hi", "sayhi"],
  happy: ["happy", "smile", "joy", "laugh", "fun", "senang"],
  surprised: ["surprise", "shock", "startle", "kaget"],
  sad: ["sad", "cry", "down", "sedih"],
  shy: ["shy", "blush", "embarrass", "malu"],
  touch: ["tap", "touch", "body", "poke", "flick"],
};

function synonymsOf(verb: string): string[] {
  return [verb, ...(VERB_SYNONYMS[verb] ?? [])];
}

function fuzzyHit(name: string, keys: string[]): boolean {
  const n = name.toLowerCase();
  return keys.some((k) => n.includes(k) || k.includes(n));
}

/**
 * Grup motion pertama yang cocok untuk verb. definitions = map grup →
 * daftar klip (dari facade internalModel.motionManager.definitions —
 * hanya grup dengan ≥1 klip yang dipertimbangkan).
 */
export function resolveMotionForVerb(
  definitions: Record<string, unknown[]> | undefined | null,
  verb: string,
): string | null {
  if (!definitions) return null;
  const keys = synonymsOf(verb);
  for (const group of Object.keys(definitions)) {
    const count = (definitions[group] || []).length;
    if (count <= 0) continue;
    if (fuzzyHit(group, keys)) return group;
  }
  return null;
}

/** Nama ekspresi pertama yang cocok untuk verb (facade.expressions). */
export function resolveExpressionForVerb(
  expressions: { Name?: string; name?: string }[] | undefined | null,
  verb: string,
): string | null {
  if (!expressions) return null;
  const keys = synonymsOf(verb);
  for (const e of expressions) {
    const n = String(e.Name ?? e.name ?? "");
    if (!n) continue;
    if (fuzzyHit(n, keys)) return n;
  }
  return null;
}

/**
 * Pilih baris acak tanpa mengulang yang terakhir (bubble reaksi).
 * lines boleh kosong → null.
 */
export function pickLine(lines: string[], avoid?: string): string | null {
  const pool = lines.filter((l) => l && l !== avoid);
  if (pool.length === 0) return lines[0] ?? null;
  return pool[Math.floor(Math.random() * pool.length)];
}
