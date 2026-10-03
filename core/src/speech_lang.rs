//! speech_lang.rs — Terjemahan teks-bicara per bahasa suara.
//!
//! Kasus: user menyetel "Bahasa suara" TETAP (mis. ja-JP) sementara balasan
//! karakter tetap bahasa user. Supaya suara natural, teks diterjemahkan ke
//! bahasa suara SEBELUM masuk TTS — teks di bubble tetap bahasa user. LLM
//! role "chat". Teks yang SUDAH berbahasa target tidak diterjemahkan (hemat +
//! deterministik). Gagal = teks asli (terjemahan = peningkatan, bukan kritis).
//!
//! Catatan port: cache LRU TS dihilangkan (optimisasi, bukan kontrak) — hasil
//! identik, hanya bisa memanggil LLM lebih sering untuk frasa berulang.

use std::path::Path;

use crate::llm::{self, ChatMessage};

/// Basis bahasa dari kode BCP-47 (ja-JP → "ja").
pub fn speech_lang_of(tts_lang: &str) -> String {
    tts_lang.split('-').next().unwrap_or("").to_lowercase()
}

/// true bila bahasa suara TETAP (bukan "auto"/kosong): `xx` atau `xx-YY…`.
pub fn tts_lang_is_fixed(tts_lang: &str) -> bool {
    let s = tts_lang;
    let mut parts = s.split('-');
    let head = match parts.next() {
        Some(h) => h,
        None => return false,
    };
    if head.len() != 2 || !head.chars().all(|c| c.is_ascii_lowercase()) {
        return false;
    }
    for seg in parts {
        let n = seg.len();
        if !(2..=8).contains(&n) || !seg.chars().all(|c| c.is_ascii_alphanumeric()) {
            return false;
        }
    }
    true
}

const ID_WORDS: &[&str] = &[
    "yang", "dan", "di", "ke", "dari", "untuk", "dengan", "ini", "itu", "aku", "kamu", "kita",
    "saya", "tidak", "bisa", "sudah", "akan", "ada", "juga", "tapi", "kalau", "gak", "nggak",
    "banget", "ya", "kok", "dong", "deh", "sih",
];

/// Deteksi bahasa teks (heuristik skrip, tanpa jaringan). Cermin dari
/// detectTextLang() app.js — keputusan harus sama untuk teks yang sama.
pub fn detect_speech_lang_base(text: &str) -> String {
    let t = text;
    let has = |lo: char, hi: char| t.chars().any(|c| c >= lo && c <= hi);
    if has('\u{3040}', '\u{30ff}') {
        return "ja".into(); // kana selalu Jepang
    }
    if has('\u{4e00}', '\u{9fff}') {
        return "zh".into(); // hanzi (tanpa kana) → Mandarin
    }
    if has('\u{ac00}', '\u{d7af}') {
        return "ko".into();
    }
    if t.chars().any(|c| c.is_ascii_alphabetic()) {
        let lower = t.to_lowercase();
        let words: Vec<&str> = lower
            .split(|c: char| !c.is_ascii_alphabetic())
            .filter(|w| !w.is_empty())
            .collect();
        if words.is_empty() {
            return "en".into();
        }
        let hits = words.iter().filter(|w| ID_WORDS.contains(w)).count();
        return if hits as f64 / words.len() as f64 >= 0.2 { "id".into() } else { "en".into() };
    }
    "id".into()
}

fn lang_name(target: &str, tts_lang: &str) -> String {
    match target {
        "id" => "Indonesian (Bahasa Indonesia)".into(),
        "ja" => "Japanese".into(),
        "en" => "English".into(),
        "zh" => "Mandarin Chinese".into(),
        "ko" => "Korean".into(),
        _ => tts_lang.to_string(),
    }
}

fn strip_quotes(s: &str) -> String {
    s.trim().trim_matches(|c| c == '"' || c == '\u{201c}' || c == '\u{201d}' || c == '\'').trim().to_string()
}

/// Terjemahkan satu baris ke bahasa `tts_lang` via LLM role "chat".
/// Teks sudah berbahasa target / gagal → teks asli.
/// Bahasa target yang deteksinya andal (skrip tulisan unik). Untuk target
/// latin (id/en/...) heuristik tidak bisa dipercaya — hasil terjemahan
/// diterima apa adanya, tanpa penalti tebakan salah.
fn deteksi_andal(target: &str) -> bool {
    matches!(target, "ja" | "zh" | "ko")
}

pub async fn translate_for_speech(config_path: &Path, text: &str, tts_lang: &str) -> String {
    let src = text.trim().to_string();
    let target = speech_lang_of(tts_lang);
    if src.is_empty() || target.is_empty() {
        return src;
    }
    if detect_speech_lang_base(&src) == target {
        return src; // sudah bahasa target
    }
    let name = lang_name(&target, tts_lang);
    let sys = format!(
        "You adapt a spoken line for a text-to-speech voice. Translate the text into {name} \
         — natural, conversational, same tone and register, similar length. \
         Output ONLY the translated line: no quotes, no explanation, no romaji. \
         If it is already in {name}, output it unchanged."
    );
    let clipped: String = src.chars().take(2000).collect();
    let messages = [ChatMessage { role: "user".into(), content: clipped.clone() }];
    let first = match llm::llm_for_role(config_path, "chat", &messages, &sys).await {
        Ok(ok) => strip_quotes(&ok.reply),
        Err(_) => return src, // gagal = teks asli (bukan jalur kritis)
    };
    if first.is_empty() {
        return src;
    }
    // Model kadang melenceng (balasan bukan bahasa target, atau campuran) —
    // inilah sumber suara "nyampur". Untuk target ber-skrip unik deteksinya
    // pasti: cek, lalu minta ulang SEKALI dengan penegasan. Tetap meleset →
    // teks asli (jangan bunuh jalur suara karena terjemahan).
    if !deteksi_andal(&target) || detect_speech_lang_base(&first) == target {
        return first;
    }
    let sys2 = format!(
        "{sys} Your previous answer was NOT in {name}. Answer again with ONLY the full line in {name}."
    );
    let messages2 = [ChatMessage {
        role: "user".into(),
        content: format!("{clipped}\n\nPrevious wrong answer: {first}"),
    }];
    match llm::llm_for_role(config_path, "chat", &messages2, &sys2).await {
        Ok(ok2) => {
            let out = strip_quotes(&ok2.reply);
            if !out.is_empty() && detect_speech_lang_base(&out) == target {
                out
            } else {
                src
            }
        }
        Err(_) => src,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deteksi_skrip() {
        assert_eq!(detect_speech_lang_base("こんにちは"), "ja");
        assert_eq!(detect_speech_lang_base("你好世界"), "zh");
        assert_eq!(detect_speech_lang_base("안녕하세요"), "ko");
        assert_eq!(detect_speech_lang_base("aku suka kamu dan dia"), "id");
        assert_eq!(detect_speech_lang_base("hello world this is a test"), "en");
    }

    #[test]
    fn fixed_lang() {
        assert!(tts_lang_is_fixed("ja"));
        assert!(tts_lang_is_fixed("ja-JP"));
        assert!(tts_lang_is_fixed("id-ID"));
        assert!(!tts_lang_is_fixed(""));
        assert!(!tts_lang_is_fixed("auto"));
        assert!(!tts_lang_is_fixed("Japanese"));
        assert_eq!(speech_lang_of("ja-JP"), "ja");
        assert_eq!(speech_lang_of("en-US"), "en");
        assert_eq!(speech_lang_of("auto"), "auto");
        assert_eq!(speech_lang_of(""), "");
    }

    #[test]
    fn target_skrip_andal_untuk_validasi() {
        // Validasi + retry hanya untuk target ber-skrip unik (deteksi pasti);
        // target latin (heuristik lemah) diterima apa adanya — hindari retry
        // palsu atas terjemahan yang sebenarnya benar.
        assert!(deteksi_andal("ja"));
        assert!(deteksi_andal("zh"));
        assert!(deteksi_andal("ko"));
        assert!(!deteksi_andal("id"));
        assert!(!deteksi_andal("en"));
    }

    #[tokio::test]
    async fn teks_sudah_target_tidak_diterjemah() {
        // target "id", teks jelas Indonesia → dikembalikan apa adanya tanpa LLM.
        let p = std::path::Path::new("/tmp/none-config.json");
        let out = translate_for_speech(p, "aku suka kamu dan dia", "id-ID").await;
        assert_eq!(out, "aku suka kamu dan dia");
        // ttsLang tidak fixed → dipakai pemanggil, tapi target kosong tetap aman:
        assert_eq!(translate_for_speech(p, "halo", "").await, "halo");
    }

    #[tokio::test]
    async fn gagal_llm_degrade_ke_teks_asli() {
        // Port tts-speech TS: LLM gagal (config tanpa provider aktif) → teks
        // asli balik, TANPA panic — jalur suara tidak pernah mati karena terjemah.
        let p = std::path::Path::new("/tmp/none-config.json");
        let out = translate_for_speech(p, "hello there friend", "ja-JP").await;
        assert_eq!(out, "hello there friend");
        // kosong → kosong, tanpa LLM
        assert_eq!(translate_for_speech(p, "   ", "ja-JP").await, "");
    }

    #[test]
    fn strip_kutip_hasil_terjemahan() {
        // Padanan TS "kutip pembuka/penutup dibuang" (output LLM dikutip).
        assert_eq!(strip_quotes("  \u{201c}Halo semua\u{201d} "), "Halo semua");
        assert_eq!(strip_quotes("\"hi\""), "hi");
        assert_eq!(strip_quotes("tanpa kutip"), "tanpa kutip");
    }
}
