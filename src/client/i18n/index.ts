/**
 * client/i18n — penerjemah UI ringan (zero-dep: tanpa paket eksternal; satu
 * import internal diizinkan — seam transport — untuk mirror bahasa ke server
 * dengan basis yang selalu benar walau port server bergeser).
 *
 * Prinsip:
 *  - Bahasa "id" adalah IDENTITY/fallback: kunci tidak ketemu di kamus bahasa
 *    aktif → jatuh ke kamus id → baru ke nama kunci. UI tidak pernah crash
 *    karena kunci hilang (guard test menjaga parity & coverage).
 *  - Resolusi bahasa: localStorage("l2d.lang") → (kunjungan pertama) config
 *    i18n.lang bila sudah konkret → deteksi navigator.language → simpan.
 *  - Markup statis diterjemahkan lewat atribut:
 *      data-i18n       → textContent
 *      data-i18n-ph    → placeholder
 *      data-i18n-title → title (tooltip)
 *      data-i18n-aria  → aria-label
 *  - String runtime di JS legacy memanggil window.__i18n.t(kunci, vars).
 *  - "auto" pada config.i18n.lang artinya user belum memilih; server
 *    memperlakukannya sebagai "id" (server tidak bisa mendeteksi locale
 *    browser) — klien yang menulis pilihan konkret saat first-run.
 */
import { apiUrl, initLoopback } from "../transport";
import { DICT_ID } from "./dict-id";
import { DICT_EN } from "./dict-en";

export type Lang = "id" | "en";
export type I18nLang = Lang | "auto";

const DICTS: Record<Lang, Record<string, string>> = { id: DICT_ID, en: DICT_EN };
const LS_KEY = "l2d.lang";

let lang: Lang = "id";

function normalize(v: unknown): Lang | null {
  return v === "id" || v === "en" ? v : null;
}

function detectBrowserLang(): Lang {
  const nav = (typeof navigator !== "undefined" && navigator.language) || "";
  return nav.toLowerCase().startsWith("en") ? "en" : "id";
}

export function getLang(): Lang {
  return lang;
}

/** Ganti bahasa: tulis localStorage + mirror ke config (untuk bahasa AI di
 *  sisi server). Pemanggil (panel pengaturan) yang memutuskan reload halaman —
 *  app.js legacy punya banyak state modul, sweep tanpa reload tidak memadai. */
export function setLang(next: Lang): void {
  lang = normalize(next) ?? "id";
  try {
    localStorage.setItem(LS_KEY, lang);
  } catch {}
  persistToServer(lang);
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const raw = DICTS[lang][key] ?? DICTS.id[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

/** Terjemahkan seluruh subtree DOM (default: dokumen) sesuai atribut data-i18n*. */
export function apply(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(key);
  });
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i18n-ph]").forEach((el) => {
    const key = el.getAttribute("data-i18n-ph");
    if (key) el.placeholder = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => {
    const key = el.getAttribute("data-i18n-html");
    if (key) el.innerHTML = t(key); // statis & terpercaya — hanya untuk hint yang memuat <b>/<code>/<i>
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.getAttribute("data-i18n-title");
    if (key) el.title = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((el) => {
    const key = el.getAttribute("data-i18n-aria");
    if (key) el.setAttribute("aria-label", t(key));
  });
  document.documentElement.lang = lang;
}

function persistToServer(l: Lang): void {
  // Selesaikan basis dulu (embedded → IPC server_port; dev: no-op) supaya
  // mirror bahasa tidak melayang ke origin salah saat port server bergeser.
  // Gagal kirim = diam — localStorage tetap sumber keputusan bahasa.
  initLoopback()
    .catch(() => null)
    .then(() =>
      fetch(apiUrl("/api/config"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "saveI18n", i18n: { lang: l } }),
      }),
    )
    .catch(() => {});
}

/** Inisialisasi sinkron (bundle.js dieksekusi sebelum app.js, DOM sudah ter-parse):
 *  sweep statis langsung, lalu rekonsiliasi config secara async untuk kunjungan
 *  pertama (belum ada localStorage). Kunjungan berikutnya localStorage menang. */
export function init(): void {
  let stored: Lang | null = null;
  try {
    stored = normalize(localStorage.getItem(LS_KEY));
  } catch {}

  if (stored) {
    lang = stored;
  } else {
    lang = detectBrowserLang();
    try {
      localStorage.setItem(LS_KEY, lang);
    } catch {}
    persistToServer(lang);
  }
  apply();

  // Rekonsiliasi first-run: bila config sudah menyimpan pilihan konkret
  // (mis. dari mesin/browser lain), itu menang atas deteksi otomatis.
  // Basis API lewat seam (apiUrl) — relatif salah di origin embedded.
  initLoopback()
    .catch(() => null)
    .then(() => fetch(apiUrl("/api/config")))
    .then((r) => (r && r.ok ? r.json() : null))
    .then((cfg: any) => {
      if (stored) return; // repeat visit — localStorage adalah keputusan final
      const fromConfig = normalize(cfg?.i18n?.lang);
      if (fromConfig && fromConfig !== lang) {
        lang = fromConfig;
        apply();
      }
    })
    .catch(() => {});
}
