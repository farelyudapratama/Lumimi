//! Klien LLM multi-provider. Provider: openai-compatible, groq, openai, gemini,
//! anthropic, mock. Role routing (chat/motion/sheet/assistant) + fallback/cooldown
//! + persist ke config. Streaming (SSE) di lib.rs (chat-stream/ask-stream).

use std::path::Path;

use serde_json::{json, Value};

use crate::config;

const DEFAULT_TIMEOUT_S: u64 = 60;

/// Pesan chat sederhana.
#[derive(Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

impl ChatMessage {
    pub fn from_value(v: &Value) -> Option<Self> {
        Some(Self {
            role: v.get("role").and_then(|x| x.as_str())?.to_string(),
            content: v.get("content").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        })
    }
}

/// Satu gambar untuk pesan multimodal (critic visual / probe — PLAN
/// PLAN-MOTION-PIPELINE 2d/4d). `data` = base64 TANPA prefix `data:`.
#[derive(Clone)]
pub struct LlmImage {
    pub mime: String,
    pub data: String,
}

/// Role koneksi untuk pemanggilan ber-gambar. Harus ditandai EKSPLISIT di
/// koneksi (wildcard tidak dipakai) agar gambar tidak pernah terkirim ke
/// model teks. Model di koneksi itu sendiri harus mendukung input gambar.
pub const ROLE_MOTION_VISION: &str = "motion-vision";

fn default_model(provider: &str) -> &'static str {
    match provider {
        "gemini" => "gemini-2.0-flash",
        "groq" => "llama-3.3-70b-versatile",
        "openai" => "gpt-4o-mini",
        "anthropic" => "claude-3-5-haiku-latest",
        _ => "",
    }
}

fn clean_key(k: &str) -> String {
    k.chars()
        .filter(|&c| {
            let u = c as u32;
            !(u <= 0x1F || u == 0x7F || u == 0xA0 || (0x200B..=0x200D).contains(&u) || u == 0xFEFF)
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// Error LLM dengan status HTTP (untuk classify).
#[derive(Debug)]
pub struct LlmError {
    pub status: u16,
    pub message: String,
}

/// Error transient jaringan (bukan kuota/auth): koneksi putus, timeout, atau
/// gateway 5xx. Layak DICOBA-ULANG di koneksi yang sama tanpa cooldown panjang —
/// satu blip `error sending request` jangan sampai membunuh loop motion multi-langkah.
pub fn is_transient(status: u16, text: &str) -> bool {
    let lower = text.to_lowercase();
    matches!(status, 0 | 408 | 502 | 503 | 504 | 522 | 524)
        || lower.contains("error sending request")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("connection reset")
        || lower.contains("connection closed")
        || lower.contains("dns")
}

/// Klasifikasi error → (fallback?, cooldown_ms). Padanan ERROR_RULES/classifyError.
pub fn classify_error(status: u16, text: &str) -> (bool, u64) {
    let lower = text.to_lowercase();
    let text_rules: &[(&str, u64)] = &[
        ("no credentials", 120_000),
        ("request not allowed", 5000),
        ("improperly formed request", 120_000),
        ("rate limit", 0),
        ("too many requests", 0),
        ("quota exceeded", 0),
        ("capacity", 0),
        ("overloaded", 0),
    ];
    for (t, cd) in text_rules {
        if lower.contains(t) {
            return (true, if *cd == 0 { 30_000 } else { *cd });
        }
    }
    let cd = match status {
        401 | 402 | 403 | 404 => 120_000,
        429 => 30_000,
        _ => 30_000,
    };
    (true, cd)
}

fn build_chat_messages(messages: &[ChatMessage], system: &str) -> Vec<Value> {
    let mut out = Vec::new();
    if !system.is_empty() {
        out.push(json!({ "role": "system", "content": system }));
    }
    for m in messages {
        if m.role == "system" {
            continue;
        }
        let role = if m.role == "user" { "user" } else { "assistant" };
        out.push(json!({ "role": role, "content": m.content }));
    }
    out
}

/// Bangun konten pesan openai-shape: string bila tanpa gambar (byte-identical
/// dengan jalur teks), array content-part bila ada gambar.
pub(crate) fn openai_content(content: &str, images: &[LlmImage]) -> Value {
    if images.is_empty() {
        return json!(content);
    }
    let mut parts = vec![json!({ "type": "text", "text": content })];
    for img in images {
        parts.push(json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{};base64,{}", img.mime, img.data) }
        }));
    }
    Value::Array(parts)
}

/// Bangun parts gemini-shape untuk pesan terakhir (teks + inline_data).
pub(crate) fn gemini_parts(content: &str, images: &[LlmImage]) -> Value {
    let mut parts = vec![json!({ "text": content })];
    for img in images {
        parts.push(json!({ "inline_data": { "mime_type": img.mime, "data": img.data } }));
    }
    Value::Array(parts)
}

/// Bangun konten anthropic-shape: string bila tanpa gambar, block array bila ada.
pub(crate) fn anthropic_content(content: &str, images: &[LlmImage]) -> Value {
    if images.is_empty() {
        return json!(content);
    }
    let mut blocks = vec![json!({ "type": "text", "text": content })];
    for img in images {
        blocks.push(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": img.mime, "data": img.data }
        }));
    }
    Value::Array(blocks)
}

/// Sisipkan gambar ke pesan `user` TERAKHIR dari daftar pesan yang sudah
/// jadi Value (`{role, content}`). Menyediakan closure pembentuk konten agar
/// satu implementasi dipakai tiga provider.
fn attach_images(msgs: &mut [Value], images: &[LlmImage], shape: &str) {
    if images.is_empty() {
        return;
    }
    let Some(last) = msgs.iter_mut().rev().find(|m| m.get("role").and_then(|v| v.as_str()) == Some("user")) else {
        return;
    };
    let content = last.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
    last["content"] = match shape {
        "gemini" => gemini_parts(&content, images),
        "anthropic" => anthropic_content(&content, images),
        _ => openai_content(&content, images),
    };
}

/// Panggil endpoint SystemOne (Jev cloud / Laya lokal — keduanya kompatibel):
/// POST {base}/v1/systemone dengan {state, model, questions}. BUKAN endpoint
/// chat — mesin keputusan mengembalikan jawaban tertipe per kunci pertanyaan
/// (noul/choice/score) + confidence. baseUrl koneksi (fallback: api.typesafe.ai)
/// — untuk Laya lokal isi mis. http://127.0.0.1:8000. apiKey boleh kosong untuk
/// server lokal.
pub async fn call_systemone(conn: &Value, state: &Value, questions: &Value) -> Result<Value, LlmError> {
    let api_key = clean_key(conn.get("apiKey").and_then(|v| v.as_str()).unwrap_or(""));
    let base = {
        let b = conn.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("").trim().trim_end_matches('/').to_string();
        if b.is_empty() { "https://api.typesafe.ai".to_string() } else { b }
    };
    let model = {
        let m = conn.get("model").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if m.is_empty() { "jev-latest".to_string() } else { m }
    };
    let body = json!({ "state": state, "model": model, "questions": questions });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(DEFAULT_TIMEOUT_S))
        .build()
        .map_err(|e| LlmError { status: 0, message: e.to_string() })?;
    let mut req = client
        .post(format!("{base}/v1/systemone"))
        .header("Content-Type", "application/json");
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }
    let resp = req.json(&body).send().await.map_err(|e| LlmError { status: 0, message: e.to_string() })?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if status >= 400 {
        return Err(LlmError { status, message: text.chars().take(300).collect() });
    }
    serde_json::from_str(&text).map_err(|_| LlmError {
        status,
        message: format!("respon bukan JSON: {}", text.chars().take(200).collect::<String>()),
    })
}

/// Probe koneksi SystemOne untuk tombol "Test" — pertanyaan noul trivial.
/// Return nama model yang menjawab (mis. "jev-1.13.0").
pub async fn systemone_probe(conn: &Value) -> Result<String, LlmError> {
    let q = json!({ "sanity": { "type": "noul", "instructions": "Sinyal uji koneksi. Jawab ya." } });
    let j = call_systemone(conn, &json!("ping"), &q).await?;
    Ok(j.get("model").and_then(|v| v.as_str()).unwrap_or("ok").to_string())
}

/// Panggil satu koneksi LLM (non-stream). Return teks balasan atau LlmError.
/// `images` (opsional) ditempel ke pesan user terakhir — kosong = jalur teks
/// murni byte-identical dengan sebelumnya.
pub async fn call_llm(conn: &Value, messages: &[ChatMessage], client_system: &str, images: &[LlmImage]) -> Result<String, LlmError> {
    call_llm_tools(conn, messages, client_system, images, &[]).await
}

/// Koneksi yang pernah MENOLAK param `tools` (server OpenAI-shape tanpa
/// dukungan function calling) → jangan kirim `tools` lagi untuk base+model
/// yang sama. In-memory per proses; setiap provider tetap dicoba dulu.
static NO_NATIVE_TOOLS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> = std::sync::OnceLock::new();

fn no_tools_key(conn: &Value) -> String {
    let base = conn.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let model = conn.get("model").and_then(|v| v.as_str()).unwrap_or("");
    format!("{base}|{model}")
}

fn native_tools_ditolak(key: &str) -> bool {
    NO_NATIVE_TOOLS.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new())).lock().map(|m| m.contains(key)).unwrap_or(false)
}

fn tandai_native_tools_ditolak(key: &str) {
    if let Ok(mut m) = NO_NATIVE_TOOLS.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new())).lock() {
        m.insert(key.to_string());
    }
}

/// Badan error 400 menandakan server menolak PARAM `tools` itu sendiri
/// (bukan generation model) → layak diulang tanpa `tools`.
fn server_menolak_param_tools(body: &str) -> bool {
    let l = body.to_lowercase();
    ["tools is not supported", "tool_choice is not supported", "does not support tools", "does not support function", "function calling is not supported", "unknown field: tools", "unknown parameter: tools", "unrecognized request argument", "extra_forbidden", "tools.unsupported"]
        .iter()
        .any(|t| l.contains(t))
}

/// Cari string `failed_generation` di mana pun dalam pohon JSON error
/// (provider beda-beda menyarangnya) — berisi generation model yang ditolak.
/// String berisi JSON bersarang (proxy membungkus error provider) di-parse
/// ulang lalu ditelusuri, berbatas kedalaman.
fn cari_failed_generation(v: &Value, depth: u8) -> Option<String> {
    if depth > 4 {
        return None;
    }
    match v {
        Value::Object(o) => {
            if let Some(fg) = o.get("failed_generation").and_then(|x| x.as_str()) {
                return Some(fg.to_string());
            }
            for val in o.values() {
                if let Some(f) = cari_failed_generation(val, depth + 1) {
                    return Some(f);
                }
            }
            None
        }
        Value::Array(a) => a.iter().find_map(|x| cari_failed_generation(x, depth + 1)),
        Value::String(s) if s.contains("failed_generation") => {
            let inner: Value = serde_json::from_str(s.trim()).ok().or_else(|| crate::jsonx::extract_json_object_loose(s))?;
            cari_failed_generation(&inner, depth + 1)
        }
        _ => None,
    }
}

/// Ubah panggilan tool dari pesan native OpenAI-shape (`message.tool_calls`)
/// jadi balasan kanonik protokol teks kita. SATU tool per giliran: panggilan
/// pertama dikonversi; sisa (bila model mem-batch) diabaikan — model akan
/// menerbitkan ulang setelah melihat hasil tool pertama.
pub(crate) fn tool_calls_to_reply(msg: &Value) -> Option<String> {
    let calls = msg.get("tool_calls")?.as_array()?;
    for tc in calls {
        let name = tc.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let args_v = tc.pointer("/function/arguments").cloned().unwrap_or(json!({}));
        let args_str = match &args_v {
            // OpenAI wire-format: arguments = STRING berisi JSON.
            Value::String(s) => s.trim().to_string(),
            // Proxy tertentu mengirim objek langsung.
            v => v.to_string(),
        };
        let args_json = if args_str.is_empty() {
            "{}".to_string()
        } else {
            match serde_json::from_str::<Value>(&args_str) {
                Ok(v) if v.is_object() => v.to_string(),
                _ => crate::jsonx::extract_json_object_loose(&args_str).map(|v| v.to_string()).unwrap_or_else(|| "{}".into()),
            }
        };
        return Some(format!("TOOL: {name} {args_json}"));
    }
    None
}

/// Salvage: provider menolak generation native tool-call (mis. Groq
/// "Tool choice is none, but model called a tool") tetapi melampirkan
/// generation yang gagal berisi JSON panggilannya. Dikonversi ke balasan
/// kanonik supaya satu giliran model tidak terbuang percuma.
pub(crate) fn salvage_tool_call_from_error(body: &str) -> Option<String> {
    let root: Value = serde_json::from_str(body).ok()?;
    let failed = cari_failed_generation(&root, 0)?;
    let obj = serde_json::from_str::<Value>(failed.trim()).ok().or_else(|| crate::jsonx::extract_json_object_loose(&failed))?;
    let name = obj.get("name").and_then(|v| v.as_str())?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let args = obj.get("arguments").cloned().unwrap_or(json!({}));
    let args_json = if args.is_object() { args.to_string() } else { json!({ "value": args }).to_string() };
    Some(format!("TOOL: {name} {args_json}"))
}

/// `call_llm` + pendaftaran `tools` native (openai-shape). Model terlatih
/// FC memanggil tool lewat jalur native yang VALID di provider; balasannya
/// dikonversi ke `TOOL: …` kanonik. Model protokol-teks tetap bisa memakai
/// `TOOL: …` di content. Provider yang menolak param `tools` dicoba ulang
/// tanpa `tools` sekali lalu diingat (kompatibilitas universal).
pub async fn call_llm_tools(conn: &Value, messages: &[ChatMessage], client_system: &str, images: &[LlmImage], tools: &[Value]) -> Result<String, LlmError> {
    let provider = conn.get("provider").and_then(|v| v.as_str()).unwrap_or("openai-compatible").to_lowercase();
    let api_key = clean_key(conn.get("apiKey").and_then(|v| v.as_str()).unwrap_or(""));
    let model = {
        let m = conn.get("model").and_then(|v| v.as_str()).unwrap_or("");
        if m.is_empty() { default_model(&provider).to_string() } else { m.to_string() }
    };
    let temp = conn.get("temperature").and_then(|v| v.as_f64()).unwrap_or(0.8);
    let max_t = conn.get("maxTokens").and_then(|v| v.as_u64()).unwrap_or(2048);
    let sys = {
        let sp = conn.get("systemPrompt").and_then(|v| v.as_str()).unwrap_or("");
        [sp, client_system].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n\n")
    };

    if provider == "mock" {
        let last = messages.iter().rev().find(|m| m.role == "user").map(|m| m.content.clone()).unwrap_or_default();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        // Gambar ikut dilaporkan supaya jalur vision bisa diuji tanpa jaringan.
        let note = if images.is_empty() { String::new() } else { format!(" [{} gambar diterima]", images.len()) };
        return Ok(format!(
            "Halo! Kamu bilang: \"{last}\".{note} (Mode mock — isi apiKey di config.json untuk LLM sungguhan.)"
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(DEFAULT_TIMEOUT_S))
        .build()
        .map_err(|e| LlmError { status: 0, message: e.to_string() })?;

    if provider == "openai-compatible" || provider == "groq" || provider == "openai" {
        let base = match provider.as_str() {
            "groq" => "https://api.groq.com/openai/v1".to_string(),
            "openai" => "https://api.openai.com/v1".to_string(),
            _ => {
                let b = conn.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("").trim_end_matches('/').to_string();
                if b.is_empty() {
                    return Err(LlmError { status: 0, message: "baseUrl belum diisi untuk openai-compatible".into() });
                }
                b
            }
        };
        let msgs_val = build_chat_messages(messages, &sys);
        let key = no_tools_key(conn);
        // `tools` native: kirim bila ada katalog & koneksi tidak pernah menolak.
        let mut with_tools = !tools.is_empty() && !native_tools_ditolak(&key);
        loop {
            let mut msgs_val = msgs_val.clone();
            attach_images(&mut msgs_val, images, "openai");
            let mut body = json!({
                "model": model,
                "messages": msgs_val,
                "temperature": temp,
                "max_tokens": max_t,
                "stream": false
            });
            if with_tools {
                body["tools"] = json!(tools);
                body["tool_choice"] = json!("auto");
            }
            let resp = client
                .post(format!("{base}/chat/completions"))
                .header("Authorization", format!("Bearer {api_key}"))
                .json(&body)
                .send()
                .await
                .map_err(|e| LlmError { status: 0, message: e.to_string() })?;
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            if status >= 400 {
                // 1) Generation native tool-call ditolak provider tapi JSON-nya
                //    dilampirkan → selamatkan, jangan buang giliran model.
                if let Some(reply) = salvage_tool_call_from_error(&text) {
                    return Ok(reply);
                }
                // 2) Server menolak param `tools` itu sendiri → ulang tanpa
                //    `tools` dan ingat koneksi ini (protokol teks tetap jalan).
                if with_tools && server_menolak_param_tools(&text) {
                    tandai_native_tools_ditolak(&key);
                    with_tools = false;
                    continue;
                }
                return Err(LlmError { status, message: text.chars().take(300).collect() });
            }
            let j: Value = serde_json::from_str(&text).map_err(|_| LlmError { status, message: format!("respon bukan JSON: {}", text.chars().take(200).collect::<String>()) })?;
            // Native function-calling: model memanggil tool lewat jalur resmi
            // provider → konversi ke baris `TOOL: …` kanonik untuk loop agent.
            if let Some(reply) = j.pointer("/choices/0/message").and_then(tool_calls_to_reply) {
                return Ok(reply);
            }
            let msg = j.pointer("/choices/0/message");
            let mut content = msg.and_then(|m| m.get("content")).and_then(|v| v.as_str()).unwrap_or("");
            // Model reasoning: sebagian provider menaruh teks di reasoning_content/
            // reasoning dan membiarkan content kosong (budget output habis untuk
            // berpikir). Tanpa fallback ini, loop agent melihat balasan hampa →
            // "(kosong)"/berhenti. Fallback HANYA saat content kosong.
            if content.trim().is_empty() {
                content = msg
                    .and_then(|m| m.get("reasoning_content").or_else(|| m.get("reasoning")))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
            }
            if content.trim().is_empty() {
                return Err(LlmError { status, message: format!("{provider} kosong: {}", text.chars().take(200).collect::<String>()) });
            }
            return Ok(content.trim().to_string());
        }
    }

    if provider == "gemini" {
        let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}");
        let mut contents: Vec<Value> = messages.iter().filter(|m| m.role != "system").map(|m| {
            let role = if m.role == "user" { "user" } else { "model" };
            json!({ "role": role, "parts": [{ "text": m.content }] })
        }).collect();
        attach_images(&mut contents, images, "gemini");
        let mut body = json!({
            "contents": contents,
            "generationConfig": { "temperature": temp, "maxOutputTokens": max_t, "candidateCount": 1 }
        });
        if !sys.is_empty() {
            body["systemInstruction"] = json!({ "parts": [{ "text": sys }] });
        }
        let resp = client.post(url).json(&body).send().await.map_err(|e| LlmError { status: 0, message: e.to_string() })?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        if status >= 400 {
            return Err(LlmError { status, message: text.chars().take(300).collect() });
        }
        let j: Value = serde_json::from_str(&text).map_err(|_| LlmError { status, message: "respon bukan JSON".into() })?;
        let parts = j.pointer("/candidates/0/content/parts").and_then(|v| v.as_array());
        let content: String = parts.map(|arr| arr.iter().filter_map(|p| p.get("text").and_then(|t| t.as_str())).collect::<String>()).unwrap_or_default();
        if content.is_empty() {
            return Err(LlmError { status, message: "Gemini kosong".into() });
        }
        return Ok(content.trim().to_string());
    }

    if provider == "anthropic" {
        let mut msgs: Vec<Value> = messages.iter().filter(|m| m.role != "system").map(|m| json!({ "role": m.role, "content": m.content })).collect();
        attach_images(&mut msgs, images, "anthropic");
        let mut body = json!({ "model": model, "messages": msgs, "max_tokens": max_t.min(4096), "temperature": temp });
        if !sys.is_empty() {
            body["system"] = json!(sys);
        }
        let resp = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|e| LlmError { status: 0, message: e.to_string() })?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        if status >= 400 {
            return Err(LlmError { status, message: text.chars().take(300).collect() });
        }
        let j: Value = serde_json::from_str(&text).map_err(|_| LlmError { status, message: "respon bukan JSON".into() })?;
        let content: String = j.get("content").and_then(|v| v.as_array()).map(|arr| arr.iter().filter_map(|p| p.get("text").and_then(|t| t.as_str())).collect()).unwrap_or_default();
        if content.is_empty() {
            return Err(LlmError { status, message: "Anthropic kosong".into() });
        }
        return Ok(content.trim().to_string());
    }

    Err(LlmError { status: 0, message: format!("provider tidak dikenal: {provider}") })
}

/// Streaming: kirim delta teks lewat `tx` selagi mengalir, kembalikan teks
/// penuh. Wire-format OpenAI (openai-compatible/groq/openai) benar-benar
/// mengalir; provider lain (gemini/anthropic/mock) → satu delta utuh.
/// Padanan callLLMStream. Timeout senyap 60s (reset tiap chunk) via reqwest.
pub async fn call_llm_stream(
    conn: &Value,
    messages: &[ChatMessage],
    client_system: &str,
    tx: &tokio::sync::mpsc::UnboundedSender<String>,
) -> Result<String, LlmError> {
    use futures_util::StreamExt;

    let provider = conn.get("provider").and_then(|v| v.as_str()).unwrap_or("openai-compatible").to_lowercase();
    if provider != "openai-compatible" && provider != "groq" && provider != "openai" {
        // provider tanpa jalur stream → satu delta.
        let full = call_llm(conn, messages, client_system, &[]).await?;
        let _ = tx.send(full.clone());
        return Ok(full);
    }
    let api_key = clean_key(conn.get("apiKey").and_then(|v| v.as_str()).unwrap_or(""));
    let model = {
        let m = conn.get("model").and_then(|v| v.as_str()).unwrap_or("");
        if m.is_empty() { default_model(&provider).to_string() } else { m.to_string() }
    };
    let temp = conn.get("temperature").and_then(|v| v.as_f64()).unwrap_or(0.8);
    let max_t = conn.get("maxTokens").and_then(|v| v.as_u64()).unwrap_or(2048);
    let sys = {
        let sp = conn.get("systemPrompt").and_then(|v| v.as_str()).unwrap_or("");
        [sp, client_system].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n\n")
    };
    let base = match provider.as_str() {
        "groq" => "https://api.groq.com/openai/v1".to_string(),
        "openai" => "https://api.openai.com/v1".to_string(),
        _ => {
            let b = conn.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("").trim_end_matches('/').to_string();
            if b.is_empty() {
                return Err(LlmError { status: 0, message: "baseUrl belum diisi untuk openai-compatible".into() });
            }
            b
        }
    };
    let body = json!({
        "model": model,
        "messages": build_chat_messages(messages, &sys),
        "temperature": temp,
        "max_tokens": max_t,
        "stream": true
    });
    // read_timeout = timeout SENYAP per-chunk (bukan total) — reasoning panjang
    // tak dibunuh, diam 60s dibunuh.
    let client = reqwest::Client::builder()
        .read_timeout(std::time::Duration::from_secs(DEFAULT_TIMEOUT_S))
        .build()
        .map_err(|e| LlmError { status: 0, message: e.to_string() })?;
    let resp = client
        .post(format!("{base}/chat/completions"))
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| LlmError { status: 0, message: e.to_string() })?;
    let status = resp.status().as_u16();
    if status >= 400 {
        let t = resp.text().await.unwrap_or_default();
        return Err(LlmError { status, message: t.chars().take(200).collect() });
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut raw = String::new();
    let mut full = String::new();
    // Akumulator reasoning terpisah: dipakai HANYA bila content stream kosong
    // (model reasoning yang menaruh semua di reasoning_content) supaya balasan
    // tak hampa.
    let mut reasoning = String::new();
    let handle_line = |line: &str, full: &mut String, reasoning: &mut String| {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("data:") {
            let payload = rest.trim();
            if payload.is_empty() || payload == "[DONE]" {
                return;
            }
            if let Ok(obj) = serde_json::from_str::<Value>(payload) {
                let piece = obj
                    .pointer("/choices/0/delta/content")
                    .or_else(|| obj.pointer("/choices/0/message/content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !piece.is_empty() {
                    full.push_str(piece);
                    let _ = tx.send(piece.to_string());
                }
                let think = obj
                    .pointer("/choices/0/delta/reasoning_content")
                    .or_else(|| obj.pointer("/choices/0/delta/reasoning"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !think.is_empty() {
                    reasoning.push_str(think);
                }
            }
        }
    };
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| LlmError { status: 0, message: e.to_string() })?;
        let s = String::from_utf8_lossy(&bytes);
        buf.push_str(&s);
        raw.push_str(&s);
        while let Some(idx) = buf.find('\n') {
            let line: String = buf[..idx].trim_end_matches('\r').to_string();
            buf = buf[idx + 1..].to_string();
            handle_line(&line, &mut full, &mut reasoning);
        }
    }
    if !buf.trim().is_empty() {
        handle_line(&buf.clone(), &mut full, &mut reasoning);
    }
    // relay aneh: minta stream, balas satu JSON utuh non-SSE.
    if full.trim().is_empty() {
        if let Ok(j) = crate::jsonx::extract_json(&raw) {
            let text = j
                .pointer("/choices/0/message/content")
                .or_else(|| j.pointer("/choices/0/delta/content"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !text.is_empty() {
                full.push_str(text);
                let _ = tx.send(text.to_string());
            }
        }
    }
    // Content kosong tapi ada reasoning → pakai reasoning sebagai balasan
    // (lebih baik daripada hampa; loop agent bisa membaca tool call di dalamnya).
    if full.trim().is_empty() && !reasoning.trim().is_empty() {
        full.push_str(reasoning.trim());
        let _ = tx.send(reasoning.trim().to_string());
    }
    if full.trim().is_empty() {
        return Err(LlmError { status, message: format!("{provider} stream kosong") });
    }
    Ok(full.trim().to_string())
}

/// True bila koneksi melayani role (roles kosong = wildcard). Padanan connHasRole.
pub fn conn_has_role(conn: &Value, role: &str) -> bool {
    let roles = config::normalize_roles(&conn.get("roles").cloned().unwrap_or(Value::Null));
    roles.is_empty() || roles.iter().any(|r| r == role)
}

fn enabled(conn: &Value) -> bool {
    conn.get("enabled").and_then(|v| v.as_bool()) != Some(false)
}

/// Urutan kandidat untuk role: eksplisit dulu, lalu wildcard. Kosong = pakai
/// default (semua). Padanan orderForRole (mengembalikan indeks ke `conns`).
pub fn order_for_role(role: &str, conns: &[Value]) -> Vec<usize> {
    let usable: Vec<usize> = (0..conns.len()).filter(|&i| enabled(&conns[i])).collect();
    let matching: Vec<usize> = usable.iter().cloned().filter(|&i| conn_has_role(&conns[i], role)).collect();
    if matching.is_empty() {
        return Vec::new();
    }
    let explicit: Vec<usize> = usable
        .iter()
        .cloned()
        .filter(|&i| config::normalize_roles(&conns[i].get("roles").cloned().unwrap_or(Value::Null)).iter().any(|r| r == role))
        .collect();
    let mut out = explicit.clone();
    for i in matching {
        if !explicit.contains(&i) {
            out.push(i);
        }
    }
    out
}

/// True bila ADA koneksi enabled dengan `role` DITANDAI EKSPLISIT (bukan
/// wildcard). Dipakai role yang tak boleh membajak koneksi chat umum karena
/// jalannya periodik/berbiaya (mis. "behavior" yang tick tiap beberapa detik,
/// "motion-vision" yang butuh model gambar). Tanpa penanda eksplisit,
/// pemanggil memilih fallback lokal ketimbang memakai koneksi aktif diam-diam.
pub fn has_explicit_role(config_path: &Path, role: &str) -> bool {
    let cfg = config::load(config_path);
    let conns = cfg.get("connections").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    conns.iter().filter(|c| enabled(c)).any(|c| {
        config::normalize_roles(&c.get("roles").cloned().unwrap_or(Value::Null))
            .iter()
            .any(|r| r == role)
    })
}

/// Hasil pemanggilan LLM: teks + id koneksi terpakai.
#[derive(Debug)]
pub struct LlmOk {
    pub reply: String,
    pub used: String,
}

/// llmForRole + llmWithFallback digabung: pilih kandidat per role, coba
/// berurutan (skip rate-limited), update status + persist ke config.
pub async fn llm_for_role(
    config_path: &Path,
    role: &str,
    messages: &[ChatMessage],
    client_system: &str,
) -> Result<LlmOk, (u16, String)> {
    llm_for_role_tools(config_path, role, messages, client_system, &[]).await
}

/// `llm_for_role` + katalog `tools` native (openai-shape) — dipakai loop
/// agent agar model native FC (gpt-oss dkk.) memanggil tool lewat jalur
/// yang valid di provider. Provider lain tetap lewat protokol teks.
pub async fn llm_for_role_tools(
    config_path: &Path,
    role: &str,
    messages: &[ChatMessage],
    client_system: &str,
    tools: &[Value],
) -> Result<LlmOk, (u16, String)> {
    let cfg = config::load(config_path);
    let mut conns: Vec<Value> = cfg.get("connections").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let active_id = cfg.get("activeId").and_then(|v| v.as_str()).map(String::from);

    if conns.iter().all(|c| !enabled(c)) {
        return Err((400, "Semua connection dinonaktifkan — aktifkan di panel ⚙️.".into()));
    }

    // urutan: order_for_role bila ada; else active dulu lalu sisanya.
    let mut order = order_for_role(role, &conns);
    if order.is_empty() {
        let mut o: Vec<usize> = Vec::new();
        if let Some(aid) = &active_id {
            if let Some(i) = conns.iter().position(|c| c.get("id").and_then(|v| v.as_str()) == Some(aid.as_str()) && enabled(c)) {
                o.push(i);
            }
        }
        for i in 0..conns.len() {
            if enabled(&conns[i]) && !o.contains(&i) {
                o.push(i);
            }
        }
        order = o;
    }

    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut last_err = String::from("Semua connection gagal");
    for &i in &order {
        // skip bila masih rate-limited.
        if let Some(until) = conns[i].get("rateLimitedUntil").and_then(|v| v.as_str()) {
            if parse_iso_ms(until).map(|t| t > now_ms).unwrap_or(false) {
                continue;
            }
        }
        // Coba koneksi ini; ulang beberapa kali untuk error transient jaringan
        // (koneksi putus/timeout) sebelum pindah — supaya blip tunggal tak
        // membunuh loop multi-langkah. Error non-transient (auth/kuota) langsung.
        let mut attempt = 0u32;
        let outcome = loop {
            match call_llm_tools(&conns[i], messages, client_system, &[], tools).await {
                Ok(reply) => break Ok(reply),
                Err(e) => {
                    if is_transient(e.status, &e.message) && attempt < 2 {
                        attempt += 1;
                        tokio::time::sleep(std::time::Duration::from_millis(500 * attempt as u64)).await;
                        continue;
                    }
                    break Err(e);
                }
            }
        };
        match outcome {
            Ok(reply) => {
                let id = conns[i].get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if let Some(o) = conns[i].as_object_mut() {
                    o.insert("testStatus".into(), json!("success"));
                    o.insert("lastError".into(), json!(""));
                    o.insert("rateLimitedUntil".into(), Value::Null);
                }
                let _ = config::save_connections(config_path, conns, json!(active_id));
                return Ok(LlmOk { reply, used: id });
            }
            Err(e) => {
                let (fallback, cooldown) = classify_error(e.status, &e.message);
                last_err = format!("LLM error: {}", e.message);
                if let Some(o) = conns[i].as_object_mut() {
                    o.insert("testStatus".into(), json!("error"));
                    o.insert("lastError".into(), json!(e.message));
                    // Error transient (jaringan) TIDAK di-cooldown panjang: ask
                    // berikutnya boleh langsung coba lagi.
                    if fallback && !is_transient(e.status, &e.message) {
                        o.insert("rateLimitedUntil".into(), json!(iso_from_ms(now_ms + cooldown as u128)));
                    }
                }
                // lanjut ke kandidat berikutnya bila fallback.
            }
        }
    }
    let _ = config::save_connections(config_path, conns, json!(active_id));
    Err((502, last_err))
}

/// Panggil LLM dengan gambar (multimodal, role `motion-vision`). HANYA
/// koneksi bertanda EKSPLISIT `roles:["motion-vision"]` yang dipakai —
/// wildcard sengaja di-skip supaya gambar tidak pernah terkirim ke model
/// teks. Fallback + cooldown + persist status sama dengan `llm_for_role`.
pub async fn llm_for_vision(
    config_path: &Path,
    system: &str,
    text: &str,
    images: &[LlmImage],
) -> Result<LlmOk, (u16, String)> {
    let cfg = config::load(config_path);
    let mut conns: Vec<Value> = cfg.get("connections").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let active_id = cfg.get("activeId").and_then(|v| v.as_str()).map(String::from);

    let order: Vec<usize> = (0..conns.len()).filter(|&i| {
        enabled(&conns[i])
            && config::normalize_roles(&conns[i].get("roles").cloned().unwrap_or(Value::Null)).iter().any(|r| r == ROLE_MOTION_VISION)
    }).collect();
    if order.is_empty() {
        return Err((400, "belum ada koneksi dengan role motion-vision — tandai satu koneksi di panel ⚙️ (modelnya harus mendukung input gambar)".into()));
    }

    let msgs = vec![ChatMessage { role: "user".into(), content: text.to_string() }];
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut last_err = String::from("Semua connection vision gagal");
    for &i in &order {
        if let Some(until) = conns[i].get("rateLimitedUntil").and_then(|v| v.as_str()) {
            if parse_iso_ms(until).map(|t| t > now_ms).unwrap_or(false) {
                continue;
            }
        }
        match call_llm(&conns[i], &msgs, system, images).await {
            Ok(reply) => {
                let id = conns[i].get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if let Some(o) = conns[i].as_object_mut() {
                    o.insert("testStatus".into(), json!("success"));
                    o.insert("lastError".into(), json!(""));
                    o.insert("rateLimitedUntil".into(), Value::Null);
                }
                let _ = config::save_connections(config_path, conns, json!(active_id));
                return Ok(LlmOk { reply, used: id });
            }
            Err(e) => {
                let (fallback, cooldown) = classify_error(e.status, &e.message);
                last_err = format!("LLM vision error: {}", e.message);
                if let Some(o) = conns[i].as_object_mut() {
                    o.insert("testStatus".into(), json!("error"));
                    o.insert("lastError".into(), json!(e.message));
                    if fallback {
                        o.insert("rateLimitedUntil".into(), json!(iso_from_ms(now_ms + cooldown as u128)));
                    }
                }
            }
        }
    }
    let _ = config::save_connections(config_path, conns, json!(active_id));
    Err((502, last_err))
}

fn parse_iso_ms(s: &str) -> Option<u128> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis().max(0) as u128)
}

/// ISO8601 UTC dari epoch ms (padanan new Date(ms).toISOString()).
fn iso_from_ms(ms: u128) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_sesuai_rules() {
        assert_eq!(classify_error(429, "").0, true);
        assert_eq!(classify_error(401, "").1, 120_000);
        assert_eq!(classify_error(200, "rate limit hit").1, 30_000);
        assert_eq!(classify_error(500, "overloaded").1, 30_000);
    }

    #[test]
    fn tool_calls_native_jadi_balasan_kanonik() {
        // Wire-format OpenAI: arguments = string JSON.
        let msg = json!({
            "role": "assistant",
            "tool_calls": [
                { "id": "c1", "type": "function",
                  "function": { "name": "browser_open", "arguments": "{\"url\":\"https://news.google.com\"}" } }
            ]
        });
        let r = tool_calls_to_reply(&msg).unwrap();
        assert!(r.starts_with("TOOL: browser_open "), "{r}");
        assert!(r.contains("news.google.com"), "{r}");
        // Proxy tertentu: arguments = objek langsung.
        let msg2 = json!({ "tool_calls": [ { "function": { "name": "list_dir", "arguments": { "path": "." } } } ] });
        assert_eq!(tool_calls_to_reply(&msg2).unwrap(), r#"TOOL: list_dir {"path":"."}"#);
        // Tanpa tool_calls → None (jalur teks biasa).
        assert!(tool_calls_to_reply(&json!({ "role": "assistant", "content": "halo" })).is_none());
        // arguments string rusak → fallback {} (loop memberi tahu model).
        let rusak = json!({ "tool_calls": [ { "function": { "name": "browser_open", "arguments": "{url tanpa kutip" } } ] });
        assert_eq!(tool_calls_to_reply(&rusak).unwrap(), "TOOL: browser_open {}");
    }

    #[test]
    fn salvage_failed_generation_dari_error_400() {
        // Bentuk Groq: error.message berisi JSON bersarang dgn failed_generation.
        let body = r#"{"error":{"message":"[400]: {\"error\":{\"message\":\"Tool choice is none, but model called a tool\",\"code\":\"tool_use_failed\",\"failed_generation\":\"{\\\"name\\\": \\\"browser_open\\\", \\\"arguments\\\": {\\\"url\\\": \\\"https://news.google.com\\\"}}\"}}"}}"#;
        let r = salvage_tool_call_from_error(body).unwrap();
        assert!(r.starts_with("TOOL: browser_open "), "{r}");
        assert!(r.contains("news.google.com"), "{r}");
        // failed_generation langsung di root error (bentuk proxy lain).
        let body2 = r#"{"error":{"code":"tool_use_failed","failed_generation":"{\"name\":\"list_dir\",\"arguments\":{\"path\":\"src\"}}"}}"#;
        assert_eq!(salvage_tool_call_from_error(body2).unwrap(), r#"TOOL: list_dir {"path":"src"}"#);
        // Bukan error tool-call → None.
        assert!(salvage_tool_call_from_error(r#"{"error":{"message":"unauthorized"}}"#).is_none());
        assert!(salvage_tool_call_from_error("bukan json").is_none());
    }

    #[test]
    fn penolakan_param_tools_terdeteksi() {
        assert!(server_menolak_param_tools(r#"{"error":{"message":"tools is not supported by this endpoint"}}"#));
        assert!(server_menolak_param_tools("Unknown field: tools"));
        assert!(!server_menolak_param_tools(r#"{"error":{"message":"Tool choice is none, but model called a tool"}}"#));
        assert!(!server_menolak_param_tools("rate limit"));
    }

    #[test]
    fn transient_terdeteksi() {
        // Blip jaringan → transient (dicoba-ulang, tanpa cooldown panjang).
        assert!(is_transient(0, "error sending request for url (https://x/v1/chat/completions)"));
        assert!(is_transient(503, "service unavailable"));
        assert!(is_transient(0, "operation timed out"));
        // Auth/kuota → BUKAN transient (jangan diulang buta).
        assert!(!is_transient(401, "unauthorized"));
        assert!(!is_transient(429, "rate limit"));
        assert!(!is_transient(400, "bad request"));
    }

    #[test]
    fn role_routing_eksplisit_dulu() {
        let conns = vec![
            json!({ "id": "a", "roles": [] }),                 // wildcard
            json!({ "id": "b", "roles": ["chat"] }),           // eksplisit chat
            json!({ "id": "c", "roles": ["motion"] }),         // bukan chat
        ];
        let order = order_for_role("chat", &conns);
        // eksplisit (b) dulu, lalu wildcard (a); c tak masuk
        assert_eq!(order, vec![1, 0]);
        // role tanpa penanda → kosong (pakai default di pemanggil)
        assert_eq!(order_for_role("sheet", &conns), vec![0]); // a wildcard cocok
    }

    #[tokio::test]
    async fn mock_provider_balas() {
        let conn = json!({ "id": "m", "provider": "mock" });
        let msgs = vec![ChatMessage { role: "user".into(), content: "tes".into() }];
        let r = call_llm(&conn, &msgs, "", &[]).await.unwrap();
        assert!(r.contains("tes"));
        assert!(r.contains("mock"));
    }

    #[tokio::test]
    async fn llm_for_role_pakai_mock() {
        let dir = std::env::temp_dir().join(format!("l2dllm-{}-{}", std::process::id(), now()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        std::fs::write(&f, r#"{"activeId":"m","connections":[{"id":"m","provider":"mock"}]}"#).unwrap();
        let msgs = vec![ChatMessage { role: "user".into(), content: "halo".into() }];
        let ok = llm_for_role(&f, "chat", &msgs, "").await.unwrap();
        assert_eq!(ok.used, "m");
        assert!(ok.reply.contains("halo"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn payload_gambar_bentuk_benar() {
        let img = LlmImage { mime: "image/jpeg".into(), data: "QUJD".into() };
        let imgs = vec![img.clone()];

        // openai: teks murni → string; dengan gambar → array content-part.
        assert_eq!(openai_content("hai", &[]), json!("hai"));
        let c = openai_content("hai", &imgs);
        assert_eq!(c[0]["type"], "text");
        assert_eq!(c[1]["type"], "image_url");
        assert_eq!(c[1]["image_url"]["url"], "data:image/jpeg;base64,QUJD");

        // gemini: inline_data; anthropic: source base64.
        let g = gemini_parts("hai", &imgs);
        assert_eq!(g[1]["inline_data"]["mime_type"], "image/jpeg");
        let a = anthropic_content("hai", &imgs);
        assert_eq!(a[1]["source"]["media_type"], "image/jpeg");

        // attach_images: hanya pesan user TERAKHIR, tanpa gambar tak berubah.
        let mut msgs = vec![
            json!({ "role": "user", "content": "a" }),
            json!({ "role": "assistant", "content": "b" }),
            json!({ "role": "user", "content": "c" }),
        ];
        attach_images(&mut msgs, &imgs, "openai");
        assert_eq!(msgs[0]["content"], json!("a"));
        assert_eq!(msgs[2]["content"][0]["text"], "c");
        let mut tanpa = vec![json!({ "role": "user", "content": "a" })];
        attach_images(&mut tanpa, &[], "openai");
        assert_eq!(tanpa[0]["content"], json!("a"));
    }

    #[tokio::test]
    async fn vision_tolak_tanpa_koneksi_eksplisit() {
        let dir = std::env::temp_dir().join(format!("l2dllmv0-{}-{}", std::process::id(), now()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        // wildcard saja → vision MENOLAK (gambar tak boleh ke model teks).
        std::fs::write(&f, r#"{"activeId":"m","connections":[{"id":"m","provider":"mock"}]}"#).unwrap();
        let err = llm_for_vision(&f, "", "lihat", &[]).await.unwrap_err();
        assert_eq!(err.0, 400);
        assert!(err.1.contains("motion-vision"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn vision_pakai_koneksi_bertanda() {
        let dir = std::env::temp_dir().join(format!("l2dllmv-{}-{}", std::process::id(), now()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        std::fs::write(
            &f,
            r#"{"activeId":"teks","connections":[
                {"id":"teks","provider":"mock"},
                {"id":"mata","provider":"mock","roles":["motion-vision"]}
            ]}"#,
        )
        .unwrap();
        let img = LlmImage { mime: "image/jpeg".into(), data: "QUJD".into() };
        let ok = llm_for_vision(&f, "kamu penilai", "nilai ini", &[img]).await.unwrap();
        assert_eq!(ok.used, "mata");
        assert!(ok.reply.contains("[1 gambar diterima]"), "{}", ok.reply);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn now() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
    }
}


