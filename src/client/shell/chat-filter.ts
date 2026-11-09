//! chat-filter.ts — Panel "Filter Chat" (tab AI): blocklist kata + mesin
//! keputusan (Jev/Laya via role "moderation", atau LLM lain yang ditandai
//! role itu) untuk menahan komentar penonton spam/melanggar sebelum diproses
//! AI VTuber. Panel ini hanya mengedit section `chatFilter` di
//! data/config.json via POST /api/config action "saveChatFilter" — logika
//! filternya jalan di core Rust (core/src/chat_filter.rs), dipasang di
//! spawn_run setelah gerbang dedup/cooldown scheduler.

import { t } from "../i18n/index";
import { connectionRequest } from "./llm-connections-model";

export type ChatFilterCfg = {
  enabled: boolean;
  useDecision: boolean;
  words: string[];
  extraRules: string;
};

// Batas yang sama dengan sanitasi save_chat_filter di core (config.rs).
export const WORDS_MAX = 200;
export const WORD_MAX_CHARS = 100;

/** Textarea blocklist → daftar kata bersih: trim, buang kosong, unik
 * case-insensitive (yang pertama menang), cap 200×100 char. Dedupe dijalankan
 * pada nilai hasil-truncate supaya tidak ada duplikat tersimpan. */
export function wordsFromTextarea(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const word = line.trim();
    if (!word) continue;
    const value = [...word].slice(0, WORD_MAX_CHARS).join("");
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= WORDS_MAX) break;
  }
  return out;
}

/** Daftar kata dari config → teks textarea (satu per baris). */
export function wordsToTextarea(words: unknown): string {
  if (!Array.isArray(words)) return "";
  return words.filter((w): w is string => typeof w === "string").join("\n");
}

export function startChatFilter(): () => void {
  const host = document.getElementById("chatfilter-box");
  if (!host) return () => {};
  const enabledEl = host.querySelector<HTMLInputElement>("#cf-enabled");
  const decisionEl = host.querySelector<HTMLInputElement>("#cf-useDecision");
  const wordsEl = host.querySelector<HTMLTextAreaElement>("#cf-words");
  const extraEl = host.querySelector<HTMLTextAreaElement>("#cf-extraRules");
  const statusEl = host.querySelector<HTMLElement>("#cf-save-status");
  const saveBtnEl = host.querySelector<HTMLButtonElement>("#btn-cf-save");
  if (!enabledEl || !decisionEl || !wordsEl || !extraEl || !statusEl || !saveBtnEl) return () => {};
  // Rebind non-null: TS tidak mempertahankan narrowing ke dalam closure.
  const enabled = enabledEl;
  const useDecision = decisionEl;
  const words = wordsEl;
  const extra = extraEl;
  const status = statusEl;
  const saveBtn = saveBtnEl;

  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  async function load() {
    try {
      const data = await connectionRequest<{ chatFilter?: Partial<ChatFilterCfg> }>("/api/config");
      const cf = data.chatFilter ?? {};
      enabled.checked = cf.enabled === true;
      useDecision.checked = cf.useDecision === true;
      words.value = wordsToTextarea(cf.words);
      extra.value = typeof cf.extraRules === "string" ? cf.extraRules : "";
      status.textContent = "";
    } catch (e) {
      status.textContent = t("cf.loadFailed", { error: errText(e) });
    }
  }

  async function save() {
    saveBtn.disabled = true;
    try {
      const payload: ChatFilterCfg = {
        enabled: enabled.checked,
        useDecision: useDecision.checked,
        words: wordsFromTextarea(words.value),
        extraRules: extra.value.trim(),
      };
      await connectionRequest("/api/config", { action: "saveChatFilter", chatFilter: payload });
      status.textContent = t("sys.saved");
    } catch (e) {
      status.textContent = t("cf.saveFailed", { error: errText(e) });
    } finally {
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener("click", () => {
    void save();
  });
  void load();
  return () => {};
}
