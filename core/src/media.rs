//! Media TTS in-process — memanggil `live2d_engine::tts` (SuperTonic) LANGSUNG,
//! tanpa sidecar HTTP. Ini bagian dari tujuan single-exe: TTS dijalankan di
//! proses Rust yang sama, bukan diproxy ke engine.exe.
//!
//! Model diambil dari `~/.cache/supertonic3` (berbagi dengan Python) atau
//! `engines/models/supertonic3`. STT (whisper) di belakang feature engine-stt.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use live2d_engine::tts::SuperTonic;
use live2d_engine::wav;

use crate::config;
use crate::paths::AppPaths;

// Model TTS dimuat sekali (4 ONNX mahal) lalu di-cache. Synth = kerja blocking
// CPU → dijalankan di spawn_blocking; Mutex menjaga akses serial.
static TTS_ENGINE: OnceLock<Mutex<Option<SuperTonic>>> = OnceLock::new();

/// Direktori model SuperTonic: cache Python bila lengkap, else engines/models.
fn tts_model_dir(paths: &AppPaths) -> PathBuf {
    if let Some(home) = dirs_home() {
        let shared = home.join(".cache").join("supertonic3");
        if shared.join("onnx").join("vocoder.onnx").exists() {
            return shared;
        }
    }
    paths.root.join("engines").join("models").join("supertonic3")
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// True bila model TTS sudah ada di disk (siap dipakai in-process).
pub fn tts_model_ready(paths: &AppPaths) -> bool {
    tts_model_dir(paths).join("onnx").join("vocoder.onnx").exists()
}

/// Sintesis TTS in-process (SuperTonic). Return (WAV bytes, mime) atau error.
/// Blocking di-offload ke spawn_blocking.
pub async fn synth_tts(paths: &AppPaths, text: &str, voice: &str, lang: &str) -> Result<(Vec<u8>, &'static str), String> {
    if text.trim().is_empty() {
        return Err("teks kosong".into());
    }
    let model_dir = tts_model_dir(paths);
    if !model_dir.join("onnx").join("vocoder.onnx").exists() {
        return Err(format!(
            "model SuperTonic belum ada di {} — unduh dulu (on-demand belum diport ke core)",
            model_dir.display()
        ));
    }
    let text = text.to_string();
    let voice = voice.to_string();
    let lang = lang.to_string();
    tokio::task::spawn_blocking(move || -> Result<(Vec<u8>, &'static str), String> {
        let cell = TTS_ENGINE.get_or_init(|| Mutex::new(None));
        let mut guard = cell.lock().map_err(|_| "lock TTS")?;
        if guard.is_none() {
            *guard = Some(SuperTonic::load(&model_dir)?);
        }
        let eng = guard.as_mut().unwrap();
        let style = SuperTonic::load_style(&model_dir, &voice)?;
        let lang_opt = if lang.is_empty() { None } else { Some(lang.as_str()) };
        let samples = eng.synthesize(&text, &style, 8, 1.05, 0.3, lang_opt)?;
        Ok((wav::encode_pcm16(&samples, eng.sample_rate()), "audio/wav"))
    })
    .await
    .map_err(|e| format!("task TTS gagal: {e}"))?
}

/// Voice + lang default dari config.tts (fallback F1 / id).
pub fn tts_voice_lang(config_path: &Path) -> (String, String) {
    let cfg = config::load(config_path);
    let tts = cfg.get("tts").cloned().unwrap_or_default();
    let voice = tts.get("voice").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("F1").to_string();
    let lang = tts.get("lang").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("id").to_string();
    (voice, lang)
}

// ── STT in-process (whisper) — di belakang feature engine-stt (cmake+LLVM) ──
#[cfg(feature = "engine-stt")]
static STT_ENGINE: OnceLock<Mutex<Option<live2d_engine::stt::Whisper>>> = OnceLock::new();

/// Path model GGML whisper: engines/models/ggml-<name>.bin (release) atau
/// engine/models/ggml-<name>.bin (dev). None bila tak ada.
#[cfg(feature = "engine-stt")]
fn stt_model_path(paths: &AppPaths, name: &str) -> Option<PathBuf> {
    let clean: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-').collect();
    for base in [paths.root.join("engines").join("models"), paths.root.join("engine").join("models")] {
        let p = base.join(format!("ggml-{clean}.bin"));
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Transkripsi STT in-process (whisper). `audio_wav` = byte WAV; lang mis "id".
/// Hanya tersedia bila di-compile dgn feature engine-stt.
#[cfg(feature = "engine-stt")]
pub async fn transcribe_stt(paths: &AppPaths, audio_wav: Vec<u8>, lang: String, model_name: String) -> Result<String, String> {
    let model_path = stt_model_path(paths, &model_name)
        .ok_or_else(|| format!("model whisper ggml-{model_name}.bin belum ada (unduh dulu)"))?;
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let (samples, sr) = live2d_engine::wav::decode_pcm16(&audio_wav)?;
        let cell = STT_ENGINE.get_or_init(|| Mutex::new(None));
        let mut guard = cell.lock().map_err(|_| "lock STT")?;
        if guard.is_none() {
            *guard = Some(live2d_engine::stt::Whisper::load(&model_path)?);
        }
        let lang_opt = if lang.is_empty() { None } else { Some(lang.as_str()) };
        guard.as_ref().unwrap().transcribe(&samples, sr, lang_opt)
    })
    .await
    .map_err(|e| format!("task STT gagal: {e}"))?
}

/// STT provider + model dari config.stt (fallback local / base).
pub fn stt_provider_model(config_path: &Path) -> (String, String, String) {
    let stt = stt_section(config_path);
    let provider = stt.get("provider").and_then(|v| v.as_str()).unwrap_or("local").to_string();
    let model = stt.get("engineModel").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("base").to_string();
    (provider, model, stt_lang_of(&stt))
}

/// Section stt dari config (config::load sudah backfill default per key).
fn stt_section(config_path: &Path) -> serde_json::Value {
    config::load(config_path).get("stt").cloned().unwrap_or_default()
}

/// Bahasa whisper dari config.stt: "indonesian" → "id", selain itu apa adanya
/// ("auto" berarti biarkan deteksi sendiri).
fn stt_lang_of(stt: &serde_json::Value) -> String {
    let raw = stt.get("language").and_then(|v| v.as_str()).unwrap_or("auto");
    if raw == "indonesian" { "id" } else { raw }.to_string()
}

/// Konfigurasi provider "openai" dari config.stt: (endpoint, api_key, model, lang).
/// endpoint kosong → resmi OpenAI (lihat `transcription_url`); model dari
/// `stt.apiModel` (fallback "whisper-1") — field `model` milik provider browser.
pub fn stt_openai_config(config_path: &Path) -> (String, String, String, String) {
    let stt = stt_section(config_path);
    let endpoint = stt.get("endpoint").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let api_key = stt.get("apiKey").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let model = stt.get("apiModel").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("whisper-1").to_string();
    (endpoint, api_key, model, stt_lang_of(&stt))
}

/// URL endpoint transkripsi dari base URL `stt.endpoint`. Kosong → resmi OpenAI.
/// Base yang sudah memuat path `/audio/transcriptions` dipakai apa adanya (user
/// tempel URL lengkap), selain itu base dianggap memuat `/v1` dan path ditempel.
pub fn transcription_url(endpoint: &str) -> String {
    let base = endpoint.trim().trim_end_matches('/');
    if base.is_empty() {
        return "https://api.openai.com/v1/audio/transcriptions".into();
    }
    if base.ends_with("/audio/transcriptions") {
        return base.to_string();
    }
    format!("{base}/audio/transcriptions")
}

/// Rakit body multipart/form-data untuk /audio/transcriptions: part file (WAV)
/// + model + language. Part language DILEWATI bila "auto"/kosong (API OpenAI
/// tidak mengenal "auto" — tanpa field berarti deteksi sendiri). Return
/// (content_type, body).
pub fn build_transcription_body(boundary: &str, model: &str, lang: &str, wav: &[u8]) -> (String, Vec<u8>) {
    let mut b = Vec::with_capacity(wav.len() + 512);
    let push = |b: &mut Vec<u8>, s: &str| b.extend_from_slice(s.as_bytes());
    push(&mut b, &format!("--{boundary}\r\n"));
    push(&mut b, "Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n");
    push(&mut b, "Content-Type: audio/wav\r\n\r\n");
    b.extend_from_slice(wav);
    push(&mut b, &format!("\r\n--{boundary}\r\n"));
    push(&mut b, "Content-Disposition: form-data; name=\"model\"\r\n\r\n");
    push(&mut b, &format!("{model}\r\n"));
    if !lang.is_empty() && lang != "auto" {
        push(&mut b, &format!("--{boundary}\r\n"));
        push(&mut b, "Content-Disposition: form-data; name=\"language\"\r\n\r\n");
        push(&mut b, &format!("{lang}\r\n"));
    }
    push(&mut b, &format!("--{boundary}--\r\n"));
    (format!("multipart/form-data; boundary={boundary}"), b)
}

/// Parse respons JSON transcription: `{"text": "..."}` → teks ter-trim.
pub fn parse_transcription_response(body: &str) -> Result<String, String> {
    let j: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| format!("respon bukan JSON: {}", body.chars().take(200).collect::<String>()))?;
    match j.get("text").and_then(|v| v.as_str()) {
        Some(t) => Ok(t.trim().to_string()),
        None => Err(format!("respon tanpa \"text\": {}", body.chars().take(200).collect::<String>())),
    }
}

/// Transkripsi via server OpenAI-compatible (`/v1/audio/transcriptions`).
/// HANYA dipanggil bila user eksplisit menyetel `stt.provider: "openai"` di
/// config.json (cloud, tidak pernah default — audio diunggah ke endpoint itu).
pub async fn transcribe_openai(endpoint: &str, api_key: &str, model: &str, lang: &str, audio_wav: Vec<u8>) -> Result<String, String> {
    // Boundary unik per request (pid + nanos); body WAV tak mungkin memuatnya.
    let boundary = format!(
        "----lumimi-stt-{:x}{:x}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let (content_type, body) = build_transcription_body(&boundary, model, lang, &audio_wav);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("client HTTP: {e}"))?;
    let resp = client
        .post(transcription_url(endpoint))
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", content_type)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("gagal menghubungi endpoint: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if status >= 400 {
        return Err(format!("HTTP {status}: {}", text.chars().take(300).collect::<String>()));
    }
    parse_transcription_response(&text)
}

/// Daftar voice style tersedia (nama file voice_styles/*.json), untuk katalog.
pub fn tts_voices(paths: &AppPaths) -> Vec<String> {
    let dir = tts_model_dir(paths).join("voice_styles");
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    out.push(stem.to_string());
                }
            }
        }
    }
    out.sort();
    out
}

// ── TTS multi-provider (port `src/server/index.ts` Bun, Batch A) ──
// `config.tts = { provider, endpoint, apiKey, voice, model, style, format, lang }`
// - "supertonic"/"native": in-process (fungsi `synth_tts` di atas, tanpa endpoint/key)
// - "browser": tak pernah sampai server (speechSynthesis di klien)
// - "gradio": endpoint Gradio Space (base saja, mis. http://127.0.0.1:7860)
// - "openai": API kompatibel OpenAI `POST <base>/v1/audio/speech`
// - "elevenlabs": API ElevenLabs `v1/text-to-speech/{voice}`
// - "gemini": Google Gemini TTS (Interactions API → generateContent)
// - "custom": `POST {text}` → audio biner ATAU JSON {audio|audioBase64|url}

/// Konfigurasi TTS satu provider (disimpan di `config.json` → `tts`).
#[derive(Debug, Clone, Default)]
pub struct TtsConfig {
    pub provider: String,
    pub endpoint: String,
    pub api_key: String,
    pub voice: String,
    pub model: String,
    pub style: String,
    pub format: String,
    pub lang: String,
}

fn vs(v: &serde_json::Value, k: &str) -> String {
    v.get(k)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Baca `TtsConfig` dari file config (section `tts` utuh).
pub fn tts_config(config_path: &Path) -> TtsConfig {
    let stored = config::load(config_path);
    let tts = stored.get("tts").cloned().unwrap_or_default();
    tts_config_from_value(&tts, &serde_json::Value::Null)
}

/// Gabung config tersimpan + draft form (tombol Tes / body `tts`).
/// `apiKey` kosong atau termask (`•`) = pertahankan yang tersimpan —
/// pola yang sama dengan koneksi LLM, kunci plaintext tak pernah lewat UI.
pub fn tts_config_from_value(stored_tts: &serde_json::Value, draft: &serde_json::Value) -> TtsConfig {
    let d = if draft.is_object() { draft } else { &serde_json::Value::Null };
    let pick = |k: &str| {
        let v = vs(d, k);
        if v.is_empty() { vs(stored_tts, k) } else { v }
    };
    let mut key = vs(d, "apiKey");
    if key.is_empty() || key.contains('•') {
        key = vs(stored_tts, "apiKey");
    }
    TtsConfig {
        provider: pick("provider"),
        endpoint: pick("endpoint"),
        api_key: key,
        voice: pick("voice"),
        model: pick("model"),
        style: pick("style"),
        format: {
            let f = pick("format");
            if f.is_empty() { "mp3".to_string() } else { f }
        },
        lang: {
            let l = pick("lang");
            if l.is_empty() { "id".to_string() } else { l }
        },
    }
}

/// Prompt Gemini TTS: gaya via preamble + label transkrip eksplisit —
/// tanpa ini model bisa MEMBACAKAN catatan gaya (anti "director's notes").
pub fn gemini_prompt(text: &str, style: &str) -> String {
    let s = style.trim();
    if s.is_empty() {
        return text.to_string();
    }
    let note = s.strip_suffix(':').unwrap_or(s);
    format!(
        "TTS the following. Direction for the performance: {note}\n\nTranscript (speak ONLY this text verbatim, do not read the direction):\n{text}"
    )
}

/// Bungkus PCM mentah (L16 mono LE, mis. 24kHz dari Gemini) jadi WAV —
/// elemen `<audio>` browser tak bisa memutar PCM tanpa header RIFF.
pub fn pcm_to_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let channels: u32 = 1;
    let bits: u32 = 16;
    let block_align = channels * bits / 8;
    let mut h = vec![0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes());
    h[22..24].copy_from_slice(&(channels as u16).to_le_bytes());
    h[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    h[28..32].copy_from_slice(&(sample_rate * block_align).to_le_bytes());
    h[32..34].copy_from_slice(&(block_align as u16).to_le_bytes());
    h[34..36].copy_from_slice(&(bits as u16).to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&(pcm.len() as u32).to_le_bytes());
    h.extend_from_slice(pcm);
    h
}

/// Base endpoint OpenAI-compat: buang akhiran path yang sering ikut
/// tersimpan dari provider lain (`/v1/tts`, `/tts`, `/v1/audio/speech`, `/v1`).
pub fn openai_base(endpoint: &str) -> String {
    let mut b = endpoint.trim().trim_end_matches('/').to_string();
    for suffix in ["/v1/audio/speech", "/v1/tts", "/audio/speech", "/tts", "/v1"] {
        if b.len() > suffix.len() && b.to_lowercase().ends_with(suffix) {
            b.truncate(b.len() - suffix.len());
            break;
        }
    }
    b.trim_end_matches('/').to_string()
}

fn b64_to_bytes(b64: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    let clean = b64.split(',').next_back().unwrap_or(b64);
    // `data:audio/...;base64,` prefix dibuang caller via split di atas
    // (ambil segmen terakhir); di sini terima base64 murni.
    let raw = if let Some(idx) = b64.find(',') { &b64[idx + 1..] } else { clean };
    base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|e| format!("base64 rusak: {e}"))
}

/// Parse respons Gemini TTS → (PCM bytes, sample rate).
/// Interactions API: `output_audio {data, mimeType}`; fallback lama
/// generateContent: `candidates[0].content.parts[].inlineData`.
fn parse_gemini_audio(j: &serde_json::Value) -> Result<(Vec<u8>, u32), String> {
    let out = j.get("output_audio").or_else(|| j.get("interaction").and_then(|i| i.get("output_audio")));
    let inline = j
        .get("candidates")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .and_then(|parts| parts.iter().find_map(|p| p.get("inlineData")));
    let part = match (out, inline) {
        (Some(o), _) if o.get("data").and_then(|d| d.as_str()).is_some() => o,
        (_, Some(i)) => i,
        (Some(o), _) => o,
        _ => &serde_json::Value::Null,
    };
    let data = part.get("data").and_then(|d| d.as_str()).unwrap_or("");
    if data.is_empty() {
        let detail = j
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .map(|m| format!(": {m}"))
            .unwrap_or_default();
        return Err(format!("respons Gemini tanpa audio{detail}"));
    }
    let mime = part
        .get("mimeType")
        .or_else(|| part.get("mime_type"))
        .and_then(|m| m.as_str())
        .unwrap_or("audio/L16;codec=pcm;rate=24000");
    let rate: u32 = mime
        .split("rate=")
        .nth(1)
        .and_then(|r| r.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok())
        .unwrap_or(24000);
    Ok((b64_to_bytes(data)?, rate))
}

fn http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("client HTTP: {e}"))
}

async fn http_err_text(resp: reqwest::Response) -> String {
    let status = resp.status().as_u16();
    let detail = resp.text().await.unwrap_or_default();
    let short: String = detail.chars().take(300).collect();
    if short.is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {short}")
    }
}

/// Gemini TTS: Interactions API (docs utama) → generateContent (model 2.5).
/// Docs: 3.1 kadang mengembalikan token teks → HTTP 500 acak, WAJIB retry.
async fn gemini_tts(model: &str, voice_name: &str, prompt: String, api_key: &str) -> Result<(Vec<u8>, u32), String> {
    let client = http_client(60)?;
    let attempts: Vec<(String, serde_json::Value)> = vec![
        (
            "https://generativelanguage.googleapis.com/v1beta/interactions".to_string(),
            serde_json::json!({
                "model": model,
                "input": prompt,
                "response_format": { "type": "audio" },
                "generation_config": { "speech_config": [{ "voice": voice_name }] },
            }),
        ),
        (
            format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
                urlencoding_path(model)
            ),
            serde_json::json!({
                "contents": [{ "parts": [{ "text": prompt }] }],
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": voice_name } } },
                },
            }),
        ),
    ];
    let mut last_err = "Gemini TTS gagal".to_string();
    for round in 0..3 {
        if round > 0 {
            tokio::time::sleep(Duration::from_millis(700 * round as u64)).await;
        }
        for (url, body) in &attempts {
            match client
                .post(url)
                .header("Content-Type", "application/json")
                .header("x-goog-api-key", api_key)
                .body(body.to_string())
                .send()
                .await
            {
                Err(e) => last_err = format!("gagal menghubungi Gemini: {e}"),
                Ok(r) if !r.status().is_success() => {
                    let status = r.status().as_u16();
                    last_err = format!("Gemini {}", http_err_text(r).await);
                    // 400/404 di endpoint ini → coba endpoint berikutnya;
                    // 500/503 (error acak menurut docs) → ulangi putaran berikut.
                    if status == 400 || status == 404 {
                        continue;
                    }
                    break;
                }
                Ok(r) => match r.json::<serde_json::Value>().await {
                    Err(e) => last_err = format!("respons Gemini bukan JSON: {e}"),
                    Ok(j) => match parse_gemini_audio(&j) {
                        Ok(out) => return Ok(out),
                        Err(e) => last_err = e,
                    },
                },
            }
        }
    }
    Err(last_err)
}

fn urlencoding_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Sintesis audio untuk SEMUA provider. Return (bytes, mime).
/// `paths` hanya dipakai jalur native (model SuperTonic di disk).
pub async fn tts_audio_for(
    paths: &AppPaths,
    cfg: &TtsConfig,
    text: &str,
) -> Result<(Vec<u8>, String), String> {
    if text.trim().is_empty() {
        return Err("teks kosong".into());
    }
    let provider = cfg.provider.trim().to_lowercase();
    let endpoint = cfg.endpoint.trim().to_string();
    let api_key = cfg.api_key.trim().to_string();

    // Native SuperTonic in-process — default proyek (tanpa endpoint/key).
    if provider.is_empty() || provider == "supertonic" || provider == "native" {
        let voice = if cfg.voice.is_empty() { "F1" } else { cfg.voice.as_str() };
        let lang = if cfg.lang.is_empty() { "id" } else { cfg.lang.as_str() };
        return synth_tts(paths, text, voice, lang)
            .await
            .map(|(buf, mime)| (buf, mime.to_string()));
    }
    if provider == "browser" {
        return Err("provider 'browser' disintesis di klien (speechSynthesis), bukan server".into());
    }
    if provider == "gradio" {
        if endpoint.is_empty() {
            return Err("tts endpoint belum diisi".into());
        }
        let base = endpoint.trim_end_matches('/');
        let client = http_client(60)?;
        let r1 = client
            .post(format!("{base}/gradio_api/call/generate_api"))
            .header("Content-Type", "application/json")
            .body(serde_json::json!({ "data": [text] }).to_string())
            .send()
            .await
            .map_err(|e| format!("gradio call gagal: {e}"))?;
        if !r1.status().is_success() {
            return Err(format!("gradio call {}", http_err_text(r1).await));
        }
        let j1: serde_json::Value = r1.json().await.map_err(|e| format!("respons gradio bukan JSON: {e}"))?;
        let ev = j1.get("event_id").and_then(|e| e.as_str()).unwrap_or("");
        if ev.is_empty() {
            return Err("gradio tanpa event_id".into());
        }
        let r2 = client
            .get(format!("{base}/gradio_api/call/generate_api/{ev}"))
            .send()
            .await
            .map_err(|e| format!("gradio event gagal: {e}"))?;
        if !r2.status().is_success() {
            return Err(format!("gradio event {}", http_err_text(r2).await));
        }
        let sse = r2.text().await.unwrap_or_default();
        let mut audio_url: Option<String> = None;
        for line in sse.lines().rev() {
            let ln = line.trim();
            if let Some(data) = ln.strip_prefix("data:") {
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                if let Ok(j) = serde_json::from_str::<serde_json::Value>(data) {
                    let fd = if j.is_array() { j.get(0).cloned().unwrap_or_default() } else { j };
                    if let Some(u) = fd.get("url").and_then(|u| u.as_str()) {
                        audio_url = Some(u.to_string());
                        break;
                    }
                    if let Some(p) = fd.get("path").and_then(|p| p.as_str()) {
                        audio_url = Some(format!("{base}/gradio_api/file{p}"));
                        break;
                    }
                }
            }
        }
        let mut url = audio_url.ok_or_else(|| "no audio url from gradio".to_string())?;
        if !url.starts_with("http://") && !url.starts_with("https://") {
            url = format!("{base}{url}");
        }
        let audio = client.get(&url).send().await.map_err(|e| format!("unduh audio gradio gagal: {e}"))?;
        if !audio.status().is_success() {
            return Err(format!("unduh audio gradio {}", http_err_text(audio).await));
        }
        let mime = audio
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("audio/wav")
            .to_string();
        let buf = audio.bytes().await.map_err(|e| format!("baca audio gradio: {e}"))?.to_vec();
        return Ok((buf, mime));
    }
    if provider == "openai" {
        if endpoint.is_empty() {
            return Err("endpoint belum diisi".into());
        }
        let base = openai_base(&endpoint);
        let client = http_client(60)?;
        let style = cfg.style.trim().to_string();
        let mut model = if cfg.model.is_empty() { "tts-1".to_string() } else { cfg.model.clone() };
        let mut voice = if cfg.voice.is_empty() { "alloy".to_string() } else { cfg.voice.clone() };
        let mut fmt = if cfg.format.is_empty() { "mp3".to_string() } else { cfg.format.clone() };
        // Server OpenAI-compat tak semua sama: sebagian menolak mp3, sebagian
        // tak punya model/voice default ("tts-1"/"alloy"). Perbaiki SATU hal
        // per kegagalan (format → model → voice), maks 4 percobaan.
        for _ in 0..4 {
            let mut payload = serde_json::json!({
                "model": model, "voice": voice, "input": text, "response_format": fmt,
            });
            if !style.is_empty()
                && (model.contains("gpt-4o-mini-tts") || model.contains("gpt-4o") && model.contains("tts") || model.contains("gpt-4") && model.contains("tts"))
            {
                payload["instructions"] = serde_json::Value::String(style.clone());
            }
            let mut req = client
                .post(format!("{base}/v1/audio/speech"))
                .header("Content-Type", "application/json")
                .body(payload.to_string());
            if !api_key.is_empty() {
                req = req.header("Authorization", format!("Bearer {api_key}"));
            }
            match req.send().await {
                Ok(r) if r.status().is_success() => {
                    let mime = r
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("audio/mpeg")
                        .to_string();
                    let buf = r.bytes().await.map_err(|e| format!("baca audio openai: {e}"))?.to_vec();
                    return Ok((buf, mime));
                }
                Ok(r) => {
                    let msg = http_err_text(r).await;
                    let low = msg.to_lowercase();
                    if fmt != "wav" && low.contains("response_format") {
                        fmt = "wav".to_string();
                        continue;
                    }
                    if cfg.model.is_empty() && low.contains("model") {
                        if let Some(m) = server_loaded_model(&client, &base).await {
                            if m != model {
                                model = m;
                                continue;
                            }
                        }
                    }
                    if cfg.voice.is_empty() && low.contains("voice") {
                        if let Some(vv) = first_server_voice(&client, &base).await {
                            if vv != voice {
                                voice = vv;
                                continue;
                            }
                        }
                    }
                    return Err(msg);
                }
                Err(e) => return Err(format!("gagal menghubungi endpoint: {e}")),
            }
        }
        return Err("gagal sintesis setelah retry otomatis".into());
    }
    if provider == "elevenlabs" {
        if api_key.is_empty() {
            return Err("apiKey ElevenLabs belum diisi".into());
        }
        let voice = if cfg.voice.is_empty() { "21m00Tcm4TlvDq8ikWAM" } else { cfg.voice.as_str() };
        let model = if cfg.model.is_empty() { "eleven_multilingual_v2" } else { cfg.model.as_str() };
        let url = if endpoint.is_empty() {
            format!(
                "https://api.elevenlabs.io/v1/text-to-speech/{}?output_format=mp3_44100_128",
                urlencoding_path(voice)
            )
        } else {
            endpoint.trim_end_matches('/').to_string()
        };
        let client = http_client(60)?;
        let r = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("xi-api-key", api_key.as_str())
            .body(serde_json::json!({ "text": text, "model_id": model }).to_string())
            .send()
            .await
            .map_err(|e| format!("gagal menghubungi ElevenLabs: {e}"))?;
        if !r.status().is_success() {
            return Err(http_err_text(r).await);
        }
        let mime = r
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("audio/mpeg")
            .to_string();
        let buf = r.bytes().await.map_err(|e| format!("baca audio elevenlabs: {e}"))?.to_vec();
        return Ok((buf, mime));
    }
    if provider == "gemini" {
        if api_key.is_empty() {
            return Err("apiKey Gemini belum diisi".into());
        }
        let model = if cfg.model.is_empty() { "gemini-2.5-flash-preview-tts" } else { cfg.model.as_str() };
        let voice_name = if cfg.voice.is_empty() { "Kore" } else { cfg.voice.as_str() };
        let (pcm, rate) = gemini_tts(model, voice_name, gemini_prompt(text, &cfg.style), &api_key).await?;
        return Ok((pcm_to_wav(&pcm, rate), "audio/wav".to_string()));
    }
    // custom — POST {text} (+apiKey bila diisi) → audio biner / JSON {audio|audioBase64|url}
    if endpoint.is_empty() {
        return Err("endpoint belum diisi".into());
    }
    let client = http_client(60)?;
    let mut req = client
        .post(endpoint.as_str())
        .header("Content-Type", "application/json");
    if !api_key.is_empty() {
        req = req
            .header("Authorization", format!("Bearer {api_key}"))
            .header("x-api-key", api_key.as_str())
            .header("xi-api-key", api_key.as_str());
    }
    let mut payload = serde_json::json!({ "text": text });
    if !api_key.is_empty() {
        payload["apiKey"] = serde_json::Value::String(api_key.clone());
    }
    let r = req
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| format!("gagal menghubungi endpoint: {e}"))?;
    if !r.status().is_success() {
        return Err(http_err_text(r).await);
    }
    let ctype = r
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if ctype.contains("json") {
        let j: serde_json::Value = r.json().await.map_err(|e| format!("respons custom bukan JSON: {e}"))?;
        if let Some(a) = j.get("audio").and_then(|a| a.as_str()) {
            if a.starts_with("data:audio") {
                return Ok((b64_to_bytes(a)?, "audio/mpeg".to_string()));
            }
            return Ok((b64_to_bytes(a)?, "audio/wav".to_string()));
        }
        if let Some(a) = j.get("audioBase64").and_then(|a| a.as_str()) {
            return Ok((b64_to_bytes(a)?, "audio/wav".to_string()));
        }
        let url = j
            .get("url")
            .or_else(|| j.get("audioUrl"))
            .and_then(|u| u.as_str())
            .map(str::to_string);
        if let Some(u) = url {
            let a = client.get(&u).send().await.map_err(|e| format!("unduh audio custom gagal: {e}"))?;
            if !a.status().is_success() {
                return Err(format!("unduh audio {}", http_err_text(a).await));
            }
            let mime = a
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("audio/wav")
                .to_string();
            let buf = a.bytes().await.map_err(|e| format!("baca audio custom: {e}"))?.to_vec();
            return Ok((buf, mime));
        }
        return Err("JSON respons tidak berisi audio (audio/audioBase64/url)".into());
    }
    let mime = if ctype.is_empty() { "audio/wav".to_string() } else { ctype };
    let buf = r.bytes().await.map_err(|e| format!("baca audio custom: {e}"))?.to_vec();
    Ok((buf, mime))
}

async fn server_loaded_model(client: &reqwest::Client, base: &str) -> Option<String> {
    let r = client.get(format!("{base}/v1/health")).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let j: serde_json::Value = r.json().await.ok()?;
    let m = j.get("model")?.as_str()?.trim().to_string();
    if m.is_empty() { None } else { Some(m) }
}

async fn first_server_voice(client: &reqwest::Client, base: &str) -> Option<String> {
    let r = client.get(format!("{base}/v1/styles")).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let j: serde_json::Value = r.json().await.ok()?;
    let arr = if j.is_array() { j.as_array().cloned().unwrap_or_default() } else { vec![] };
    let arr = if arr.is_empty() {
        j.get("styles").and_then(|s| s.as_array()).cloned().unwrap_or_default()
    } else {
        arr
    };
    for v in arr {
        if let Some(s) = v.as_str() {
            if !s.trim().is_empty() {
                return Some(s.trim().to_string());
            }
        }
        if let Some(n) = v.get("name").and_then(|n| n.as_str()) {
            if !n.trim().is_empty() {
                return Some(n.trim().to_string());
            }
        }
    }
    None
}

// ── Cache audio TTS (in-memory) ──
// Kunci = hash(config TTS + teks). Segmen per-kalimat yang di-prefetch
// klien tidak memanggil API berbayar dua kali; TTL 30 menit, maks 200 entri.
static TTS_CACHE: OnceLock<Mutex<HashMap<String, (Vec<u8>, String, Instant)>>> = OnceLock::new();
const TTS_CACHE_TTL: Duration = Duration::from_secs(30 * 60);
const TTS_CACHE_MAX: usize = 200;

fn tts_cache_key(cfg: &TtsConfig, text: &str) -> String {
    let s = serde_json::json!([
        cfg.provider, cfg.endpoint, cfg.api_key, cfg.voice,
        cfg.model, cfg.style, cfg.format, cfg.lang, text,
    ])
    .to_string();
    // FNV-1a 64-bit (stabil lintas proses, murah, cukup untuk kunci cache).
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}_{}", text.len())
}

/// Sintesis via cache (hit → tanpa request ulang ke provider berbayar).
pub async fn tts_audio_cached(
    paths: &AppPaths,
    cfg: &TtsConfig,
    text: &str,
) -> Result<(Vec<u8>, String), String> {
    let key = tts_cache_key(cfg, text);
    if let Some(cell) = TTS_CACHE.get() {
        if let Ok(mut guard) = cell.lock() {
            if let Some((buf, mime, at)) = guard.get(&key) {
                if at.elapsed() < TTS_CACHE_TTL {
                    return Ok((buf.clone(), mime.clone()));
                }
                guard.remove(&key);
            }
        }
    }
    let out = tts_audio_for(paths, cfg, text).await?;
    let cell = TTS_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut guard) = cell.lock() {
        if guard.len() >= TTS_CACHE_MAX {
            // Evict entri terlama (satu saja, murah).
            if let Some(oldest) = guard.iter().min_by_key(|(_, (_, _, at))| *at).map(|(k, _)| k.clone()) {
                guard.remove(&oldest);
            }
        }
        guard.insert(key, (out.0.clone(), out.1.clone(), Instant::now()));
    }
    Ok(out)
}

// ── Katalog voice/model per provider (untuk dropdown UI) ──
// Gemini & OpenAI: katalog statis resmi. ElevenLabs: ditarik live dari
// akun (butuh apiKey). OpenAI-compatible: `GET <endpoint>/v1/audio/voices`
// bila server mendukung, gagal = daftar kosong (UI pakai input bebas).

fn id_name_list(ids: &[(&str, &str)]) -> Vec<serde_json::Value> {
    ids.iter()
        .map(|(id, name)| serde_json::json!({ "id": id, "name": name }))
        .collect()
}

pub const GEMINI_TTS_VOICES: &[(&str, &str)] = &[
    ("Zephyr", "Zephyr — Bright"), ("Puck", "Puck — Upbeat"), ("Charon", "Charon — Informative"),
    ("Kore", "Kore — Firm"), ("Fenrir", "Fenrir — Excitable"), ("Leda", "Leda — Youthful"),
    ("Orus", "Orus — Firm"), ("Aoede", "Aoede — Breezy"), ("Callirrhoe", "Callirrhoe — Easy-going"),
    ("Autonoe", "Autonoe — Bright"), ("Enceladus", "Enceladus — Breathy"), ("Iapetus", "Iapetus — Clear"),
    ("Umbriel", "Umbriel — Easy-going"), ("Algieba", "Algieba — Smooth"), ("Despina", "Despina — Smooth"),
    ("Erinome", "Erinome — Clear"), ("Algenib", "Algenib — Gravelly"), ("Rasalgethi", "Rasalgethi — Informative"),
    ("Laomedeia", "Laomedeia — Upbeat"), ("Achernar", "Achernar — Soft"), ("Alnilam", "Alnilam — Firm"),
    ("Schedar", "Schedar — Even"), ("Gacrux", "Gacrux — Mature"), ("Pulcherrima", "Pulcherrima — Forward"),
    ("Achird", "Achird — Friendly"), ("Zubenelgenubi", "Zubenelgenubi — Casual"),
    ("Vindemiatrix", "Vindemiatrix — Gentle"), ("Sadachbia", "Sadachbia — Lively"),
    ("Sadaltager", "Sadaltager — Knowledgeable"), ("Sulafat", "Sulafat — Warm"),
];
pub const GEMINI_TTS_MODELS: &[(&str, &str)] = &[
    ("gemini-3.1-flash-tts-preview", "Gemini 3.1 Flash TTS (terbaru, dukung tag audio)"),
    ("gemini-2.5-flash-preview-tts", "Gemini 2.5 Flash TTS (cepat)"),
    ("gemini-2.5-pro-preview-tts", "Gemini 2.5 Pro TTS (kualitas)"),
];
pub const OPENAI_TTS_VOICES: &[(&str, &str)] = &[
    ("marin", "marin — rekomendasi kualitas"), ("cedar", "cedar — rekomendasi kualitas"),
    ("alloy", "alloy — netral"), ("ash", "ash — netral"), ("ballad", "ballad — lembut"),
    ("coral", "coral — hangat"), ("echo", "echo — maskulin"), ("fable", "fable — naratif (Inggris)"),
    ("nova", "nova — feminin energik"), ("onyx", "onyx — dalam"), ("sage", "sage — tenang"),
    ("shimmer", "shimmer — lembut"), ("verse", "verse — fleksibel"),
];
pub const OPENAI_TTS_MODELS: &[(&str, &str)] = &[
    ("gpt-4o-mini-tts", "gpt-4o-mini-tts (paling ekspresif + gaya)"),
    ("tts-1", "tts-1 (cepat)"),
    ("tts-1-hd", "tts-1-hd (kualitas)"),
];
pub const OPENAI_TTS_STYLES: &[&str] = &[
    "Bicara santai dan ramah seperti teman ngobrol.",
    "Bicara ceria dan penuh semangat.",
    "Bicara tenang dan menenangkan.",
    "Bicara dengan aksen Indonesia yang natural.",
    "Bicara seperti karakter anime perempuan yang genit.",
    "Bicara pelan-pelan seperti dongeng sebelum tidur.",
];
pub const GEMINI_TTS_STYLES: &[&str] = &[
    "Bicara ceria dan penuh senyum, tempo santai [excitedly].",
    "Bicara pelan dan hangat seperti berbisik [whispers].",
    "Bicara cepat dan penuh semangat seperti presenter radio [excitedly].",
    "Bicara santai seperti teman ngobrol, aksen Indonesia natural.",
    "Bicara malu-malu dan lembut, sedikit gemetar [trembling].",
    "Bicara tegas dan serius, tempo sedang [serious].",
];
pub const ELEVENLABS_TTS_MODELS: &[(&str, &str)] = &[
    ("eleven_multilingual_v2", "Multilingual v2 (29 bahasa, paling stabil)"),
    ("eleven_turbo_v2_5", "Turbo v2.5 (cepat, murah)"),
    ("eleven_flash_v2_5", "Flash v2.5 (tercepat)"),
];

/// Katalog `{voices, models, styles}` untuk dropdown UI. Tak pernah error —
/// provider tanpa katalog (gradio/custom) balas kosong (UI pakai input bebas).
pub async fn tts_catalog(provider: &str, api_key: &str, endpoint: &str) -> serde_json::Value {
    use serde_json::json;
    let p = provider.trim().to_lowercase();
    if p.is_empty() || p == "supertonic" || p == "native" {
        // Diisi pemanggil dari voice_styles (lihat get_tts_options); di sini
        // fallback statis bila model belum ada di disk.
        return json!({
            "voices": id_name_list(&[
                ("F1","F1"),("F2","F2"),("F3","F3"),("F4","F4"),("F5","F5"),
                ("M1","M1"),("M2","M2"),("M3","M3"),("M4","M4"),("M5","M5"),
            ]),
            "models": [{ "id": "supertonic-3", "name": "SuperTonic 3 (native)" }],
            "styles": [],
        });
    }
    if p == "gemini" {
        let mut models = id_name_list(GEMINI_TTS_MODELS);
        // Key tersedia → tarik daftar model live, hanya yang -tts- (docs:
        // `GET /v1beta/models`). Gagal = diam, pakai statis.
        if !api_key.is_empty() {
            if let Ok(client) = http_client(15) {
                if let Ok(r) = client
                    .get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200")
                    .header("x-goog-api-key", api_key)
                    .send()
                    .await
                {
                    if r.status().is_success() {
                        if let Ok(j) = r.json::<serde_json::Value>().await {
                            let ids: Vec<String> = j
                                .get("models")
                                .and_then(|m| m.as_array())
                                .cloned()
                                .unwrap_or_default()
                                .iter()
                                .filter_map(|m| m.get("name")?.as_str())
                                .map(|n| n.trim_start_matches("models/").to_string())
                                .filter(|id| id.to_lowercase().contains("tts"))
                                .collect();
                            if !ids.is_empty() {
                                models = ids
                                    .iter()
                                    .map(|id| {
                                        let name = GEMINI_TTS_MODELS
                                            .iter()
                                            .find(|(i, _)| i == id)
                                            .map(|(_, n)| *n)
                                            .unwrap_or(id.as_str());
                                        json!({ "id": id, "name": name })
                                    })
                                    .collect();
                            }
                        }
                    }
                }
            }
        }
        return json!({
            "voices": id_name_list(GEMINI_TTS_VOICES),
            "models": models,
            "styles": GEMINI_TTS_STYLES,
        });
    }
    if p == "openai" {
        // Endpoint bukan resmi OpenAI (Kokoro dkk) → coba tarik daftarnya.
        if !endpoint.is_empty() && !endpoint.to_lowercase().contains("api.openai.com") {
            let base = openai_base(endpoint);
            if let Ok(client) = http_client(15) {
                let mut req = client.get(format!("{base}/v1/audio/voices"));
                if !api_key.is_empty() {
                    req = req.header("Authorization", format!("Bearer {api_key}"));
                }
                if let Ok(r) = req.send().await {
                    if r.status().is_success() {
                        if let Ok(j) = r.json::<serde_json::Value>().await {
                            let arr = if j.is_array() {
                                j.as_array().cloned().unwrap_or_default()
                            } else {
                                j.get("voices").and_then(|v| v.as_array()).cloned().unwrap_or_default()
                            };
                            let list: Vec<serde_json::Value> = arr
                                .iter()
                                .filter_map(|v| {
                                    if let Some(s) = v.as_str() {
                                        if s.trim().is_empty() { None } else { Some(json!({ "id": s, "name": s })) }
                                    } else {
                                        let id = v.get("id").or_else(|| v.get("name"))?.as_str()?.trim().to_string();
                                        if id.is_empty() { return None; }
                                        let name = v.get("name").and_then(|n| n.as_str()).unwrap_or(&id).to_string();
                                        Some(json!({ "id": id, "name": name }))
                                    }
                                })
                                .collect();
                            if !list.is_empty() {
                                return json!({ "voices": list, "models": [], "styles": [] });
                            }
                        }
                    }
                }
                // Server tanpa /v1/audio/voices (mis. supertonic serve):
                // katalog voice di /v1/styles, model aktif di /v1/health.
                if let Ok(s) = client.get(format!("{base}/v1/styles")).send().await {
                    if s.status().is_success() {
                        if let Ok(j) = s.json::<serde_json::Value>().await {
                            let arr = if j.is_array() {
                                j.as_array().cloned().unwrap_or_default()
                            } else {
                                j.get("styles").and_then(|v| v.as_array()).cloned().unwrap_or_default()
                            };
                            let list: Vec<serde_json::Value> = arr
                                .iter()
                                .filter_map(|v| {
                                    if let Some(s) = v.as_str() {
                                        if s.trim().is_empty() { None } else { Some(json!({ "id": s, "name": s })) }
                                    } else {
                                        let n = v.get("name").or_else(|| v.get("id"))?.as_str()?.trim().to_string();
                                        if n.is_empty() { return None; }
                                        Some(json!({ "id": n, "name": n }))
                                    }
                                })
                                .collect();
                            let mut models = vec![];
                            if let Ok(hp) = client.get(format!("{base}/v1/health")).send().await {
                                if hp.status().is_success() {
                                    if let Ok(hj) = hp.json::<serde_json::Value>().await {
                                        if let Some(m) = hj.get("model").and_then(|m| m.as_str()) {
                                            if !m.trim().is_empty() {
                                                models.push(json!({ "id": m, "name": format!("{m} (dimuat di server)") }));
                                            }
                                        }
                                    }
                                }
                            }
                            if !list.is_empty() {
                                return json!({ "voices": list, "models": models, "styles": [] });
                            }
                        }
                    }
                }
                return json!({ "voices": [], "models": [], "styles": [] });
            }
        }
        return json!({
            "voices": id_name_list(OPENAI_TTS_VOICES),
            "models": id_name_list(OPENAI_TTS_MODELS),
            "styles": OPENAI_TTS_STYLES,
        });
    }
    if p == "elevenlabs" {
        let models = id_name_list(ELEVENLABS_TTS_MODELS);
        if api_key.is_empty() {
            return json!({ "voices": [], "models": models, "styles": [] });
        }
        if let Ok(client) = http_client(15) {
            if let Ok(r) = client
                .get("https://api.elevenlabs.io/v1/voices")
                .header("xi-api-key", api_key)
                .send()
                .await
            {
                if r.status().is_success() {
                    if let Ok(j) = r.json::<serde_json::Value>().await {
                        let voices: Vec<serde_json::Value> = j
                            .get("voices")
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default()
                            .iter()
                            .filter_map(|v| {
                                let id = v.get("voice_id")?.as_str()?.trim().to_string();
                                if id.is_empty() {
                                    return None;
                                }
                                let name = v.get("name").and_then(|n| n.as_str()).unwrap_or(&id).to_string();
                                let accent = v
                                    .get("labels")
                                    .and_then(|l| l.get("accent"))
                                    .and_then(|a| a.as_str())
                                    .unwrap_or("");
                                let name = if accent.is_empty() { name } else { format!("{name} — {accent}") };
                                Some(json!({ "id": id, "name": name }))
                            })
                            .collect();
                        return json!({ "voices": voices, "models": models, "styles": [] });
                    }
                } else {
                    let status = r.status().as_u16();
                    return json!({ "voices": [], "models": models, "styles": [], "error": format!("HTTP {status}") });
                }
            }
        }
        return json!({ "voices": [], "models": models, "styles": [] });
    }
    // gradio / custom / browser / tak dikenal — tanpa katalog (UI input bebas).
    json!({ "voices": [], "models": [], "styles": [] })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcription_url_join_benar() {
        assert_eq!(transcription_url(""), "https://api.openai.com/v1/audio/transcriptions");
        assert_eq!(
            transcription_url("https://api.groq.com/openai/v1"),
            "https://api.groq.com/openai/v1/audio/transcriptions"
        );
        // trailing slash dibersihkan sebelum ditempel
        assert_eq!(
            transcription_url("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/audio/transcriptions"
        );
        // URL lengkap tempelan user dipakai apa adanya
        assert_eq!(
            transcription_url("https://host.example/v1/audio/transcriptions"),
            "https://host.example/v1/audio/transcriptions"
        );
    }

    #[test]
    fn body_multipart_isi_benar() {
        let wav = vec![0x52u8, 0x49, 0x46, 0x46, 0x00, 0x01];
        let (ct, body) = build_transcription_body("BOUNDRY", "whisper-1", "id", &wav);
        assert!(ct.starts_with("multipart/form-data; boundary=BOUNDRY"));
        let s = String::from_utf8_lossy(&body);
        assert!(s.contains("name=\"file\"; filename=\"audio.wav\""));
        assert!(s.contains("name=\"model\"\r\n\r\nwhisper-1\r\n"));
        assert!(s.contains("name=\"language\"\r\n\r\nid\r\n"));
        assert!(s.ends_with("--BOUNDRY--\r\n"));
        // byte WAV utuh ada di body
        let pos = s.find("audio/wav\r\n\r\n").unwrap() + "audio/wav\r\n\r\n".len();
        assert_eq!(&body[pos..pos + wav.len()], &wav[..]);
    }

    #[test]
    fn body_multipart_auto_tanpa_language() {
        let (_ct, body) = build_transcription_body("B", "whisper-1", "auto", &[]);
        let s = String::from_utf8_lossy(&body);
        assert!(!s.contains("name=\"language\""));
        let (_ct, body) = build_transcription_body("B", "whisper-1", "", &[]);
        assert!(!String::from_utf8_lossy(&body).contains("name=\"language\""));
    }

    #[test]
    fn parse_respons_transkripsi() {
        assert_eq!(parse_transcription_response(r#"{"text":" halo dunia "}"#).unwrap(), "halo dunia");
        assert_eq!(parse_transcription_response(r#"{"text":""}"#).unwrap(), "");
        let e = parse_transcription_response("bukan json").unwrap_err();
        assert!(e.contains("bukan JSON"), "{e}");
        let e = parse_transcription_response(r#"{"beda":1}"#).unwrap_err();
        assert!(e.contains("tanpa \"text\""), "{e}");
    }

    #[test]
    fn config_openai_baca_dan_default() {
        let dir = std::env::temp_dir().join(format!("l2dmedtest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        std::fs::write(
            &f,
            r#"{"stt":{"provider":"openai","endpoint":"https://api.groq.com/openai/v1","apiKey":" sk-test123 ","apiModel":"whisper-large-v3-turbo"}}"#,
        )
        .unwrap();
        let (endpoint, key, model, lang) = stt_openai_config(&f);
        assert_eq!(endpoint, "https://api.groq.com/openai/v1");
        assert_eq!(key, "sk-test123"); // trim
        assert_eq!(model, "whisper-large-v3-turbo");
        // file tanpa apiModel → fallback whisper-1; language hilang → auto
        std::fs::write(&f, r#"{"stt":{"provider":"openai","apiKey":"sk-x"}}"#).unwrap();
        let (endpoint, key, model, lang) = stt_openai_config(&f);
        assert_eq!(endpoint, "");
        assert_eq!(key, "sk-x");
        assert_eq!(model, "whisper-1");
        assert_eq!(lang, "auto");
        // file hilang sama sekali → default utuh (default_config: language
        // "indonesian" → "id")
        let (_e, key, model, lang) = stt_openai_config(&dir.join("tak-ada.json"));
        assert_eq!(key, "");
        assert_eq!(model, "whisper-1");
        assert_eq!(lang, "id");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn openai_base_buang_akhiran_path() {
        assert_eq!(openai_base("http://127.0.0.1:8880"), "http://127.0.0.1:8880");
        assert_eq!(openai_base("http://127.0.0.1:8880/"), "http://127.0.0.1:8880");
        assert_eq!(openai_base("http://127.0.0.1:8880/v1"), "http://127.0.0.1:8880");
        assert_eq!(
            openai_base("http://127.0.0.1:8880/v1/audio/speech"),
            "http://127.0.0.1:8880"
        );
        assert_eq!(openai_base("https://api.openai.com/v1"), "https://api.openai.com");
    }

    #[test]
    fn gemini_prompt_tanpa_dan_dengan_gaya() {
        assert_eq!(gemini_prompt("halo", ""), "halo");
        assert_eq!(gemini_prompt("halo", "  "), "halo");
        let p = gemini_prompt("halo dunia", "Bicara ceria:");
        assert!(p.contains("Direction for the performance: Bicara ceria"));
        assert!(p.contains("halo dunia"));
        assert!(p.contains("speak ONLY this text verbatim"));
    }

    #[test]
    fn pcm_to_wav_header_benar() {
        let pcm = vec![0x01u8, 0x02, 0x03, 0x04];
        let wav = pcm_to_wav(&pcm, 24000);
        assert_eq!(wav.len(), 48);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(&wav[44..], &[0x01, 0x02, 0x03, 0x04]);
        let rate = u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]);
        assert_eq!(rate, 24000);
    }

    #[test]
    fn parse_gemini_interactions_dan_generate_content() {
        // Interactions API: output_audio {data, mimeType}
        let j: serde_json::Value = serde_json::from_str(
            r#"{"output_audio":{"data":"AQI=","mimeType":"audio/L16;codec=pcm;rate=24000"}}"#,
        )
        .unwrap();
        let (pcm, rate) = parse_gemini_audio(&j).unwrap();
        assert_eq!(pcm, vec![0x01, 0x02]);
        assert_eq!(rate, 24000);
        // Fallback generateContent: candidates inlineData
        let j: serde_json::Value = serde_json::from_str(
            r#"{"candidates":[{"content":{"parts":[{"inlineData":{"data":"AQI=","mimeType":"audio/L16;rate=16000"}}]}}]}"#,
        )
        .unwrap();
        let (pcm, rate) = parse_gemini_audio(&j).unwrap();
        assert_eq!(pcm, vec![0x01, 0x02]);
        assert_eq!(rate, 16000);
        // Tanpa audio → error jelas
        let j: serde_json::Value = serde_json::from_str(r#"{"error":{"message":"boom"}}"#).unwrap();
        let e = parse_gemini_audio(&j).unwrap_err();
        assert!(e.contains("tanpa audio") && e.contains("boom"), "{e}");
    }

    #[test]
    fn tts_config_merge_dan_mask() {
        let stored: serde_json::Value = serde_json::from_str(
            r#"{"provider":"gemini","apiKey":"sk-asli123","voice":"Kore","model":"m1","endpoint":"","style":"","format":"","lang":""}"#,
        )
        .unwrap();
        // Draft kosong → pakai tersimpan
        let c = tts_config_from_value(&stored, &serde_json::Value::Null);
        assert_eq!(c.provider, "gemini");
        assert_eq!(c.api_key, "sk-asli123");
        assert_eq!(c.format, "mp3"); // default
        assert_eq!(c.lang, "id"); // default
        // Draft termask → tetap tersimpan
        let draft: serde_json::Value = serde_json::from_str(r#"{"apiKey":"sk-a••••••••i123","voice":"Zephyr"}"#).unwrap();
        let c = tts_config_from_value(&stored, &draft);
        assert_eq!(c.api_key, "sk-asli123");
        assert_eq!(c.voice, "Zephyr");
        // Draft kunci baru → menang
        let draft: serde_json::Value = serde_json::from_str(r#"{"apiKey":"sk-baru"}"#).unwrap();
        let c = tts_config_from_value(&stored, &draft);
        assert_eq!(c.api_key, "sk-baru");
    }

    #[test]
    fn tts_cache_key_deterministik_dan_beda_teks() {
        let cfg = TtsConfig { provider: "gemini".into(), api_key: "k".into(), ..Default::default() };
        assert_eq!(tts_cache_key(&cfg, "halo"), tts_cache_key(&cfg, "halo"));
        assert_ne!(tts_cache_key(&cfg, "halo"), tts_cache_key(&cfg, "halo dunia"));
        let mut cfg2 = cfg.clone();
        cfg2.voice = "Zephyr".into();
        assert_ne!(tts_cache_key(&cfg, "halo"), tts_cache_key(&cfg2, "halo"));
    }

    #[tokio::test]
    async fn tts_katalog_statis_tanpa_jaringan() {
        // Gemini tanpa key → statis (tanpa fetch live)
        let cat = tts_catalog("gemini", "", "").await;
        assert_eq!(cat["voices"].as_array().unwrap().len(), GEMINI_TTS_VOICES.len());
        assert!(!cat["models"].as_array().unwrap().is_empty());
        assert_eq!(cat["styles"].as_array().unwrap().len(), GEMINI_TTS_STYLES.len());
        // OpenAI resmi → statis
        let cat = tts_catalog("openai", "", "").await;
        assert_eq!(cat["voices"].as_array().unwrap().len(), OPENAI_TTS_VOICES.len());
        assert_eq!(cat["models"].as_array().unwrap().len(), OPENAI_TTS_MODELS.len());
        // ElevenLabs tanpa key → voices kosong, model default ada
        let cat = tts_catalog("elevenlabs", "", "").await;
        assert!(cat["voices"].as_array().unwrap().is_empty());
        assert_eq!(cat["models"].as_array().unwrap().len(), ELEVENLABS_TTS_MODELS.len());
        // gradio/custom → kosong (UI input bebas)
        for p in ["gradio", "custom", "browser", "aneh"] {
            let cat = tts_catalog(p, "", "").await;
            assert!(cat["voices"].as_array().unwrap().is_empty(), "{p}");
            assert!(cat["models"].as_array().unwrap().is_empty(), "{p}");
        }
    }
}
