//! live2d-core — Rust application core.
//!
//! Menyediakan **server HTTP in-process** (axum) yang, di dalam Tauri, melayani
//! `/api/*` + aset statis menggantikan server Bun rute demi rute — jalur menuju
//! SATU exe (`Lumimi.exe`) tanpa proses Bun terpisah. Wire tetap HTTP
//! loopback, jadi frontend & klien mandiri (CLI/OBS/HP) tak perlu berubah.
//!
//! Renderer Live2D/PixiJS TETAP di frontend TypeScript. Lihat
//! docs/ARCHITECTURE-TAURI-RUST.md.
//!
//! Backend penuh: /api/* + aset statis (arsip Bun src/server dihapus Batch A).

pub mod agent;
pub mod behavior;
pub mod browser;
pub mod config;
pub mod companion_memory;
pub mod director;
pub mod expressions;
pub mod jsonx;
pub mod llm;
pub mod media;
pub mod mode;
pub mod model;
pub mod motion_ai;
pub mod motion_analysis;
pub mod motion_dsl;
pub mod motion_files;
pub mod motion_taxonomy;
pub mod motion_validation;
pub mod motion_vision;
pub mod motions;
pub mod paths;
pub mod pet;
pub mod rescue;
pub mod sheet;
pub mod sheet_ai;
pub mod speech_lang;
pub mod static_serve;
pub mod vtuber;
pub mod vtuber_scheduler;

use axum::{
    body::Body,
    extract::State,
    http::{header, StatusCode, Uri},
    response::Response,
    routing::get,
    Json, Router,
};
use serde_json::json;

use paths::AppPaths;
use static_serve::{mime_for, safe_join, Resolved};

/// Versi core — dipakai endpoint `/api/version` (satu jalur HTTP).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Token identitas instalasi untuk handshake client↔server: frontend menolak
/// menempel ke port yang tidak membalas token ini, jadi port yang diduduki
/// server asing ATAU instalasi Lumimi lain (portabel lama vs installer, dev vs
/// exe) tidak pernah tertukar. Deterministik dari root app — BUKAN acak per
/// boot — supaya dobel-klik kedua pada instalasi yang sama tetap bisa attach
/// ke instance pertama (perilaku pick_port yang disengaja).
pub fn instance_token(paths: &AppPaths) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    paths
        .root
        .canonicalize()
        .unwrap_or_else(|_| paths.root.clone())
        .hash(&mut h);
    format!("lumimi-{:016x}", h.finish())
}

/// Placeholder Stage 0: bukti crate ter-link.
pub fn core_ready() -> bool {
    true
}

/// Batas body KHUSUS rute upload model (upload folder & import-zip). Folder
/// model ber-tekstur 4K berukuran puluhan-ratusan MB — JSON base64-nya
/// melampaui batas default axum (2 MB) sehingga server memutus koneksi di
/// tengah upload dan WebView2 melaporkan "Failed to fetch" (bukan 413 bersih).
/// Rute lain tetap memakai batas default.
const MODEL_UPLOAD_BODY_CAP: usize = 512 * 1024 * 1024;

/// Bangun router HTTP core. `/health` + `/api/version` + penyajian statis
/// (fallback) dari `static/` & `data/` sesuai AppPaths.
pub fn router(paths: AppPaths) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/version", get(version))
        .route("/api/config", get(get_config).post(post_config))
        .route("/api/test", axum::routing::post(post_test))
        .route("/api/chat", axum::routing::post(post_chat))
        .route("/api/chat-stream", axum::routing::post(post_chat_stream))
        .route("/api/tts", axum::routing::post(post_tts))
        .route("/api/tts/options", get(get_tts_options))
        .route("/api/tts/test", axum::routing::post(post_tts_test))
        .route("/api/tts/translate", axum::routing::post(post_tts_translate))
        .route("/api/stt", axum::routing::post(post_stt))
        .route("/api/media/status", axum::routing::get(get_media_status))
        .route("/api/media/download", axum::routing::post(post_media_download))
        .route("/api/media/delete", axum::routing::post(post_media_delete))
        .route("/api/mode", get(get_mode).post(post_mode))
        .route("/api/pet/launch", axum::routing::post(post_pet_launch))
        .route("/api/pet/close", axum::routing::post(post_pet_close))
        .route("/api/pet/clickthrough", axum::routing::post(post_pet_clickthrough))
        .route("/api/pet/state", get(get_pet_state))
        .route("/api/vtuber/start", axum::routing::post(post_vtuber_start))
        .route("/api/vtuber/stop", axum::routing::post(post_vtuber_stop))
        .route("/api/vtuber/overlay", axum::routing::post(post_vtuber_overlay))
        .route("/api/vtuber/events", get(get_vtuber_events))
        .route("/api/vtuber/mock-event", axum::routing::post(post_vtuber_mock_event))
        .route("/api/vtuber/conn", get(get_vtuber_conn))
        .route("/api/vtuber/config", axum::routing::post(post_vtuber_config))
        .route("/api/vtuber/operator", axum::routing::post(post_vtuber_operator))
        .route("/api/browser/status", get(get_browser_status))
        .route("/api/browser/screenshot", get(get_browser_screenshot))
        .route("/api/browser/open", axum::routing::post(post_browser_open))
        .route("/api/browser/navigate", axum::routing::post(post_browser_navigate))
        .route("/api/browser/history", axum::routing::post(post_browser_history))
        .route("/api/browser/inspect", axum::routing::post(post_browser_inspect))
        .route("/api/browser/click", axum::routing::post(post_browser_click))
        .route("/api/browser/point", axum::routing::post(post_browser_point))
        .route("/api/browser/type", axum::routing::post(post_browser_type))
        .route("/api/browser/focus", axum::routing::post(post_browser_focus))
        .route("/api/browser/close", axum::routing::post(post_browser_close))
        .route("/api/browser/grant", axum::routing::post(post_browser_grant))
        .route("/api/browser/engine", axum::routing::post(post_browser_engine))
        .route("/api/assistant/start", axum::routing::post(post_assistant_start))
        .route("/api/assistant/status", get(get_assistant_status))
        .route("/api/assistant/stop", axum::routing::post(post_assistant_stop))
        .route("/api/assistant/ask", axum::routing::post(post_assistant_ask))
        .route("/api/assistant/ask-stream", axum::routing::post(post_assistant_ask_stream))
        .route("/api/assistant/approve", axum::routing::post(post_assistant_approve))
        .route("/api/assistant/approve-stream", axum::routing::post(post_assistant_approve_stream))
        .route("/api/assistant/history", get(get_assistant_history))
        .route("/api/assistant/reset", axum::routing::post(post_assistant_reset))
        .route("/api/assistant/cancel", axum::routing::post(post_assistant_cancel))
        .route("/api/assistant/events", get(get_assistant_events))
        .route("/api/assistant/undo", get(get_assistant_undo))
        .route("/api/assistant/revert", axum::routing::post(post_assistant_revert))
        .route("/api/assistant/quip", axum::routing::post(post_assistant_quip))
        .route("/api/assistant/modify", axum::routing::post(post_assistant_modify))
        .route("/api/assistant/memory", get(get_memory))
        .route("/api/assistant/memory/forget", axum::routing::post(post_memory_forget))
        .route("/api/assistant/sessions", get(get_sessions))
        .route("/api/assistant/sessions/new", axum::routing::post(post_sessions_new))
        .route("/api/assistant/sessions/switch", axum::routing::post(post_sessions_switch))
        .route("/api/assistant/sessions/delete", axum::routing::post(post_sessions_delete))
        .route("/api/animate-text", axum::routing::post(post_animate_text))
        .route("/api/companion/memory", get(get_companion_memory).post(post_companion_memory))
        .route("/api/companion/memory/forget", axum::routing::post(post_companion_memory_forget))
        .route("/api/companion/memory/extract", axum::routing::post(post_companion_memory_extract))
        .route("/api/companion/intent", axum::routing::post(post_companion_intent))
        .route("/api/companion/summarize", axum::routing::post(post_companion_summarize))
        .route("/api/behavior/decide", axum::routing::post(post_behavior_decide))
        .route("/api/model/classify-params", axum::routing::post(post_classify_params))
        .route("/api/model/analyze-sheet", axum::routing::post(post_analyze_sheet))
        .route("/api/motions/analyze", axum::routing::post(post_motions_analyze))
        .route("/api/motions/generate", axum::routing::post(post_motions_generate))
        .route("/api/motions/validate", axum::routing::post(post_motions_validate))
        .route("/api/motions/verify", axum::routing::post(post_motions_verify))
        .route("/api/model/motion-taxonomy", get(get_motion_taxonomy).post(post_motion_taxonomy))
        .route("/api/models", get(get_models))
        .route("/api/model/path", get(get_model_path))
        .route("/api/sheet", get(get_sheet_h).post(post_sheet_h))
        .route("/api/model/expressions", get(get_expressions))
        .route("/api/model/motions", get(get_motions))
        .route("/api/model/motion-analysis", get(get_motion_analysis))
        .route(
            "/api/model/expressions-adoption",
            get(get_adoption).post(post_adoption),
        )
        .route("/api/model/files", get(get_model_files))
        .route("/api/model/avatar", get(get_model_avatar))
        .route(
            "/api/model/upload",
            axum::routing::post(post_model_upload)
                .layer(axum::extract::DefaultBodyLimit::max(MODEL_UPLOAD_BODY_CAP)),
        )
        .route(
            "/api/model/import-zip",
            axum::routing::post(post_import_zip)
                .layer(axum::extract::DefaultBodyLimit::max(MODEL_UPLOAD_BODY_CAP)),
        )
        .route("/api/model/{name}", axum::routing::delete(delete_model_h))
        .route("/api/motions", get(get_motions_list).post(post_motions_h))
        .route(
            "/api/motions/native-alias",
            get(get_native_alias_h).post(post_native_alias_h),
        )
        .route("/api/motions/{id}", get(get_motion_h).put(put_motion_h).delete(del_motion_h))
        // Adapter HTTP = eksternal/bridge (CLI, OBS, dev browser, + domain yang
        // belum migrasi IPC). Loopback saja; CORS permisif supaya frontend
        // ter-embed (origin tauri.localhost) tetap bisa memakainya.
        .layer(tower_http::cors::CorsLayer::permissive())
        .fallback(static_handler)
        .with_state(paths)
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "core": VERSION }))
}

async fn version(State(paths): State<AppPaths>) -> Json<serde_json::Value> {
    Json(json!({
        "core_version": VERSION,
        "engine": "rust-in-process",
        "instance": instance_token(&paths)
    }))
}

/// GET /api/config — apiKey dimask, roles dinormalisasi (padanan handler TS).
async fn get_config(State(paths): State<AppPaths>) -> Json<serde_json::Value> {
    Json(config::api_config_response(&paths.data_dir.join("config.json")))
}

/// POST /api/config — action add/update/delete/setActive/saveEvents/saveTTS/
/// saveI18n/save (padanan handleConfigPost). data/config.json gitignored.
async fn post_config(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let parsed: Option<serde_json::Value> = serde_json::from_slice(&body).ok();
    match parsed {
        Some(v) => {
            let (status, out) = config::handle_config_post(&paths.data_dir.join("config.json"), &v);
            json_raw(status, out)
        }
        None => json_status(StatusCode::BAD_REQUEST, json!({ "error": "body JSON rusak" })),
    }
}

/// POST /api/test {connection} — uji satu koneksi LLM (padanan
/// handleTestConnection TS). Hasil WAJIB menulis testStatus/lastError ke
/// koneksi tersimpan supaya badge panel ikut berubah; gagal test TIDAK
/// menyetel cooldown (itu hak classifier trafik nyata).
async fn post_test(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = match serde_json::from_slice(&body).ok() {
        Some(v) => v,
        None => return json_status(StatusCode::BAD_REQUEST, json!({ "error": "body JSON rusak" })),
    };
    let mut conn = v.get("connection").cloned().unwrap_or(json!({}));
    let cfg_path = paths.data_dir.join("config.json");
    let cfg = config::load(&cfg_path);
    let mut conns: Vec<serde_json::Value> = cfg
        .get("connections")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let active_id = cfg.get("activeId").cloned().unwrap_or(serde_json::Value::Null);
    let cid = conn.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let stored_idx = conns.iter().position(|c| c.get("id").and_then(|x| x.as_str()) == Some(cid.as_str()));
    // Kunci asli tersimpan menang (form hanya membawa mask/placeholder).
    if let Some(i) = stored_idx {
        if let Some(k) = conns[i].get("apiKey").cloned() {
            if let Some(o) = conn.as_object_mut() {
                o.insert("apiKey".into(), k);
            }
        }
    }
    let provider = conn.get("provider").and_then(|x| x.as_str()).unwrap_or("openai-compatible").to_lowercase();
    let key = conn.get("apiKey").and_then(|x| x.as_str()).unwrap_or("");
    // SystemOne lokal (Laya self-host) sah tanpa apiKey; cloud Jev tetap wajib.
    let base_url = conn.get("baseUrl").and_then(|x| x.as_str()).unwrap_or("").to_lowercase();
    let base_local = base_url.contains("localhost") || base_url.contains("127.0.0.1");
    let need_key = provider != "mock"
        && !(provider == "systemone" && base_local)
        && (key.is_empty() || key.starts_with("MASUKKAN"));
    if need_key {
        return json_status(StatusCode::BAD_REQUEST, json!({ "valid": false, "error": "apiKey belum diisi" }));
    }
    let probe = vec![llm::ChatMessage { role: "user".into(), content: "Reply with just: OK".into() }];
    // Provider SystemOne tidak punya /chat/completions — probe-nya pertanyaan
    // keputusan trivial (state + noul), bukan pesan chat.
    let probe_res = if provider == "systemone" {
        llm::systemone_probe(&conn).await
    } else {
        llm::call_llm(&conn, &probe, "", &[]).await
    };
    match probe_res {
        Ok(reply) => {
            if let Some(i) = stored_idx {
                if let Some(o) = conns[i].as_object_mut() {
                    o.insert("testStatus".into(), json!("success"));
                    o.insert("lastError".into(), json!(""));
                }
                let _ = config::save_connections(&cfg_path, conns, active_id);
            }
            let short: String = reply.chars().take(80).collect();
            json_status(StatusCode::OK, json!({ "valid": true, "reply": short }))
        }
        Err(e) => {
            if let Some(i) = stored_idx {
                if let Some(o) = conns[i].as_object_mut() {
                    o.insert("testStatus".into(), json!("error"));
                    o.insert("lastError".into(), json!(e.message.clone()));
                }
                let _ = config::save_connections(&cfg_path, conns, active_id);
            }
            json_status(StatusCode::OK, json!({ "valid": false, "error": e.message }))
        }
    }
}

/// POST /api/chat {messages, system} — LLM role "chat" (padanan handleChat).
async fn post_chat(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = match serde_json::from_slice(&body).ok() {
        Some(v) => v,
        None => return json_status(StatusCode::BAD_REQUEST, json!({ "error": "body JSON rusak" })),
    };
    let messages: Vec<llm::ChatMessage> = v
        .get("messages")
        .and_then(|m| m.as_array())
        .map(|arr| arr.iter().filter_map(llm::ChatMessage::from_value).collect())
        .unwrap_or_default();
    let system = v.get("system").and_then(|s| s.as_str()).unwrap_or("");
    let cfg_path = paths.data_dir.join("config.json");
    match llm::llm_for_role(&cfg_path, "chat", &messages, system).await {
        Ok(ok) => json_status(StatusCode::OK, json!({ "reply": ok.reply, "used": ok.used })),
        Err((status, msg)) => json_status(
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            json!({ "error": msg }),
        ),
    }
}

/// POST /api/tts {text, ttsLang?, tts?} — sintesis suara multi-provider.
/// `tts` opsional (tombol Tes memakai nilai form yang belum disimpan).
/// `ttsLang` tetap (mis. ja-JP) → teks diterjemahkan DULU di sini, satu titik
/// keputusan untuk semua jalur. Return audio biner (mime per provider).
async fn post_tts(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let text_raw = v.get("text").and_then(|s| s.as_str()).unwrap_or("");
    if text_raw.trim().is_empty() {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "no text" }));
    }
    let config_path = paths.data_dir.join("config.json");
    let stored = config::load(&config_path);
    let stored_tts = stored.get("tts").cloned().unwrap_or_default();
    let draft = v.get("tts").cloned().unwrap_or_default();
    let cfg = media::tts_config_from_value(&stored_tts, &draft);
    // "Bahasa suara" tetap → terjemahkan dulu (bubble/chat tetap teks asli).
    let tts_lang = v.get("ttsLang").and_then(|s| s.as_str()).unwrap_or("");
    let text = if speech_lang::tts_lang_is_fixed(tts_lang) {
        speech_lang::translate_for_speech(&config_path, text_raw, tts_lang).await
    } else {
        text_raw.to_string()
    };
    match media::tts_audio_cached(&paths, &cfg, &text).await {
        Ok((buf, mime)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Body::from(buf))
            .unwrap(),
        Err(e) => json_status(StatusCode::BAD_GATEWAY, json!({ "error": format!("TTS error: {e}") })),
    }
}

/// GET /api/tts/options?provider=…[&apiKey=…][&endpoint=…] — katalog
/// voice/model untuk dropdown UI. `apiKey` kosong/termask → pakai tersimpan.
async fn get_tts_options(
    State(paths): State<AppPaths>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let provider = q.get("provider").cloned().unwrap_or_default().to_lowercase();
    let api_key_q = q.get("apiKey").cloned().unwrap_or_default();
    let endpoint = q.get("endpoint").cloned().unwrap_or_default();
    // Kunci mask dari UI ("abcd••••wxyz") → pakai yang tersimpan.
    let mut real_key = api_key_q.trim().to_string();
    if real_key.is_empty() || real_key.contains('•') {
        let stored = config::load(&paths.data_dir.join("config.json"));
        real_key = stored
            .get("tts")
            .and_then(|t| t.get("apiKey"))
            .and_then(|k| k.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
    }
    if provider == "auto" || provider == "supertonic" || provider == "native" || provider.is_empty() {
        let mut voices = media::tts_voices(&paths);
        if voices.is_empty() {
            voices = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"].iter().map(|s| s.to_string()).collect();
        }
        let vlist: Vec<serde_json::Value> = voices.iter().map(|v| json!({ "id": v, "name": v })).collect();
        return json_status(StatusCode::OK, json!({
            "voices": vlist,
            "models": [{ "id": "supertonic-3", "name": "SuperTonic 3 (native)" }],
            "styles": [],
        }));
    }
    let cat = media::tts_catalog(&provider, &real_key, endpoint.trim()).await;
    json_status(StatusCode::OK, cat)
}

/// POST /api/tts/test {tts?} — sintesis kalimat uji provider AKTIF.
/// Sukses → audio uji biner (mime mengikuti provider) supaya tombol test
/// benar-benar TERDENGAR, bukan cuma label "OK"; gagal → JSON {ok:false,error}.
async fn post_tts_test(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let stored = config::load(&paths.data_dir.join("config.json"));
    let stored_tts = stored.get("tts").cloned().unwrap_or_default();
    let draft = v.get("tts").cloned().unwrap_or_default();
    let cfg = media::tts_config_from_value(&stored_tts, &draft);
    match media::tts_audio_cached(&paths, &cfg, "Tes suara. Halo!").await {
        Ok((buf, mime)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(buf))
            .unwrap(),
        Err(e) => json_status(StatusCode::BAD_GATEWAY, json!({ "ok": false, "error": e })),
    }
}

/// POST /api/tts/translate {text, ttsLang} — terjemahan teks-bicara (LLM chat).
async fn post_tts_translate(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let text: String = v.get("text").and_then(|s| s.as_str()).unwrap_or("").chars().take(2000).collect();
    let tts_lang = v.get("ttsLang").and_then(|s| s.as_str()).unwrap_or("");
    if text.trim().is_empty() {
        return json_status(StatusCode::OK, json!({ "text": "" }));
    }
    if !speech_lang::tts_lang_is_fixed(tts_lang) {
        return json_status(StatusCode::OK, json!({ "text": text }));
    }
    let out = speech_lang::translate_for_speech(&paths.data_dir.join("config.json"), &text, tts_lang).await;
    json_status(StatusCode::OK, json!({ "text": out }))
}

/// POST /api/assistant/start {workDir?, persona?}.
async fn post_assistant_start(body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let wd = v.get("workDir").and_then(|x| x.as_str()).unwrap_or("");
    // Konteks tool motion: model aktif + peta role→paramId dari klien
    // (sumber inferensi role tetap role-mapping.ts; server hanya melipat).
    let model = v.get("model").and_then(|x| x.as_str()).unwrap_or("");
    let role_map = v.get("roleMap").cloned().unwrap_or(serde_json::Value::Null);
    json_status(StatusCode::OK, agent::assistant::start(wd, model, role_map).await)
}

/// GET /api/assistant/status.
async fn get_assistant_status() -> Json<serde_json::Value> {
    Json(agent::assistant::status().await)
}

/// POST /api/assistant/stop.
async fn post_assistant_stop() -> Response {
    json_status(StatusCode::OK, agent::assistant::stop().await)
}

/// POST /api/assistant/ask {text} — jalankan tugas agent (loop penuh).
async fn post_assistant_ask(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    // Konteks motion di-refresh tiap ask (model bisa dimuat/ganti setelah panel hidup).
    let model = v.get("model").and_then(|x| x.as_str()).unwrap_or("");
    let role_map = v.get("roleMap").cloned().unwrap_or(serde_json::Value::Null);
    agent::assistant::set_model_context(model, role_map).await;
    let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("");
    let cfg = paths.data_dir.join("config.json");
    let r = agent::assistant::ask(&cfg, &paths.root, text).await;
    if r.ok {
        json_status(StatusCode::OK, json!({ "reply": r.reply, "paused": r.paused }))
    } else {
        json_status(StatusCode::BAD_GATEWAY, json!({ "error": r.error.unwrap_or_default() }))
    }
}

/// POST /api/assistant/ask-stream — SSE. Kosakata event dijaga sama panel
/// (stream.ts): emit `data:{delta}` (jawaban) lalu `data:{done,reply,paused}`.
/// (Belum true token-stream: loop menjalankan tool dulu, hasil final di-emit.)
async fn post_assistant_ask_stream(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use axum::response::IntoResponse;
    use futures_util::StreamExt;
    use tokio_stream::wrappers::UnboundedReceiverStream;

    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("").to_string();
    // Konteks motion di-refresh tiap ask (model bisa dimuat/ganti setelah panel hidup).
    let model = v.get("model").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let role_map = v.get("roleMap").cloned().unwrap_or(serde_json::Value::Null);
    agent::assistant::set_model_context(&model, role_map).await;
    let cfg = paths.data_dir.join("config.json");
    let root = paths.root.clone();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let r = agent::assistant::ask(&cfg, &root, &text).await;
        // Frame SSE WAJIB ber-field "type" — kontrak stream.ts (AsSseEvent):
        // parser panel membuang frame tanpa type, jadi dulu seluruh streaming
        // mati diam-diam dan panel hidup dari hydrate history saja.
        if r.ok {
            if !r.reply.is_empty() {
                let _ = tx.send(json!({ "type": "delta", "text": r.reply }).to_string());
            }
            let _ = tx.send(json!({ "type": "done", "ok": true, "reply": r.reply, "paused": r.paused }).to_string());
        } else {
            let _ = tx.send(json!({ "type": "done", "ok": false, "error": r.error.unwrap_or_default() }).to_string());
        }
    });
    let stream = UnboundedReceiverStream::new(rx).map(|d| Ok::<_, std::convert::Infallible>(Event::default().data(d)));
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// POST /api/assistant/approve {id, approve}.
async fn post_assistant_approve(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
    let approve_it = v.get("approve").and_then(|x| x.as_bool()).unwrap_or(false);
    let always = v.get("always").and_then(|x| x.as_bool()).unwrap_or(false);
    let cfg = paths.data_dir.join("config.json");
    let r = agent::assistant::approve(&cfg, &paths.root, id, approve_it, always).await;
    if r.ok {
        json_status(StatusCode::OK, json!({ "reply": r.reply, "paused": r.paused }))
    } else {
        json_status(StatusCode::BAD_REQUEST, json!({ "error": r.error.unwrap_or_default() }))
    }
}

/// POST /api/assistant/approve-stream — SSE. Mirror ask-stream: resume loop
/// setelah izin, emit `data:{delta}` lalu `data:{done,reply,paused}`.
async fn post_assistant_approve_stream(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use axum::response::IntoResponse;
    use futures_util::StreamExt;
    use tokio_stream::wrappers::UnboundedReceiverStream;

    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let approve_it = v.get("approve").and_then(|x| x.as_bool()).unwrap_or(false);
    let always = v.get("always").and_then(|x| x.as_bool()).unwrap_or(false);
    let cfg = paths.data_dir.join("config.json");
    let root = paths.root.clone();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let r = agent::assistant::approve(&cfg, &root, &id, approve_it, always).await;
        // Kontrak sama dengan ask-stream: frame ber-type (lihat stream.ts).
        if r.ok {
            if !r.reply.is_empty() {
                let _ = tx.send(json!({ "type": "delta", "text": r.reply }).to_string());
            }
            let _ = tx.send(json!({ "type": "done", "ok": true, "reply": r.reply, "paused": r.paused }).to_string());
        } else {
            let _ = tx.send(json!({ "type": "done", "ok": false, "error": r.error.unwrap_or_default() }).to_string());
        }
    });
    let stream = UnboundedReceiverStream::new(rx).map(|d| Ok::<_, std::convert::Infallible>(Event::default().data(d)));
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// GET /api/assistant/history.
async fn get_assistant_history() -> Json<serde_json::Value> {
    Json(agent::assistant::history().await)
}

/// POST /api/assistant/quip {persona?, event?} — komentar berkarakter singkat.
async fn post_assistant_quip(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let persona = v.get("persona").and_then(|x| x.as_str()).unwrap_or("");
    let event = v.get("event").and_then(|x| x.as_str()).unwrap_or("");
    let out = agent::assistant::quip(&paths.data_dir.join("config.json"), persona, event).await;
    json_status(StatusCode::OK, out)
}

/// POST /api/assistant/modify {taskId?, text} — ganti tugas (cancel + pengganti).
async fn post_assistant_modify(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let task_id = v.get("taskId").and_then(|x| x.as_str()).unwrap_or("");
    let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("");
    let out = agent::assistant::modify(&paths.data_dir.join("config.json"), &paths.root, task_id, text).await;
    let ok = out.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    json_status(if ok { StatusCode::OK } else { StatusCode::BAD_REQUEST }, out)
}

/// POST /api/assistant/reset — kosongkan riwayat (ditolak saat busy).
async fn post_assistant_reset() -> Response {
    json_status(StatusCode::OK, agent::assistant::reset().await)
}

/// POST /api/assistant/cancel — batal kooperatif.
async fn post_assistant_cancel() -> Response {
    json_status(StatusCode::OK, agent::assistant::cancel().await)
}

/// GET /api/assistant/events?since=N — bus aktivitas agent.
async fn get_assistant_events(uri: Uri) -> Json<serde_json::Value> {
    let since = uri
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("since=")))
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    Json(agent::assistant::events(since).await)
}

/// GET /api/assistant/undo — daftar snapshot mutasi.
async fn get_assistant_undo() -> Json<serde_json::Value> {
    Json(json!({ "entries": agent::assistant::undo_list().await }))
}

/// POST /api/assistant/revert {id} — kembalikan file ke snapshot.
async fn post_assistant_revert(body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
    match agent::assistant::revert(id).await {
        Ok(msg) => json_status(StatusCode::OK, json!({ "ok": true, "message": msg })),
        Err(e) => json_status(StatusCode::NOT_FOUND, json!({ "ok": false, "error": e })),
    }
}

/// GET /api/assistant/memory — daftar memory lintas sesi.
async fn get_memory(State(paths): State<AppPaths>) -> Json<serde_json::Value> {
    Json(json!({ "entries": agent::memory::memory_list(&paths.root) }))
}

/// POST /api/assistant/memory/forget {key}.
async fn post_memory_forget(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let key = v.get("key").and_then(|x| x.as_str()).unwrap_or("");
    let (status, out) = agent::memory::memory_delete(&paths.root, key);
    json_status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK), out)
}

// ── Companion memory (stage/chat & pet) — store + keputusan latar ──────

/// GET /api/companion/memory?q=&limit= — retrieval memori jangka panjang
/// (skor relevansi di sisi server supaya semua surface berbagi logika).
async fn get_companion_memory(
    State(paths): State<AppPaths>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let query = q.get("q").cloned().unwrap_or_default();
    let limit: usize = q
        .get("limit")
        .and_then(|l| l.parse().ok())
        .filter(|l: &usize| *l > 0)
        .unwrap_or(companion_memory::DEFAULT_RETRIEVE_LIMIT);
    json_status(
        StatusCode::OK,
        companion_memory::retrieve(&paths.data_dir, &query, limit),
    )
}

/// POST /api/companion/memory {entries:[{text,tags?}]} — tambah (dedupe di
/// store). Entry hasil ekstraksi LLM dari client, atau tulisan manual.
async fn post_companion_memory(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let items = v
        .get("entries")
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();
    json_status(
        StatusCode::OK,
        companion_memory::add_entries(&paths.data_dir, &items),
    )
}

/// POST /api/companion/memory/forget {id} | {all:true}.
async fn post_companion_memory_forget(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
    let all = v.get("all").and_then(|x| x.as_bool()).unwrap_or(false);
    let removed = companion_memory::forget(&paths.data_dir, id, all);
    json_status(StatusCode::OK, json!({ "removed": removed }))
}

/// POST /api/companion/memory/extract {turns:[{role,content}]} — ekstraksi
/// memori layak-ingat dari giliran sejak ekstraksi terakhir (LLM role
/// "memory"), langsung disimpan. Fail-soft → entries kosong.
async fn post_companion_memory_extract(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let turns = v
        .get("turns")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();
    let cfg = paths.data_dir.join("config.json");
    json_status(
        StatusCode::OK,
        companion_memory::extract_and_store(&cfg, &paths.data_dir, &turns).await,
    )
}

/// POST /api/companion/intent {text, summary?, recent?} — TUGAS atau OBROLAN?
/// Keputusan berdasar makna (LLM role "memory"); fail-soft → isTask:false.
async fn post_companion_intent(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("");
    let summary = v.get("summary").and_then(|x| x.as_str()).unwrap_or("");
    let recent = v
        .get("recent")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    let cfg = paths.data_dir.join("config.json");
    json_status(
        StatusCode::OK,
        companion_memory::decide_intent(&cfg, text, summary, &recent).await,
    )
}

/// POST /api/companion/summarize {summary?, turns:[{role,content}]} —
/// kompresi konteks sesi. Fail-soft → ringkasan lama dipertahankan.
async fn post_companion_summarize(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let prior = v.get("summary").and_then(|x| x.as_str()).unwrap_or("");
    let turns = v
        .get("turns")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();
    let cfg = paths.data_dir.join("config.json");
    json_status(
        StatusCode::OK,
        companion_memory::summarize_session(&cfg, prior, &turns).await,
    )
}

/// GET /api/assistant/sessions — daftar sesi (ringkasan).
async fn get_sessions(State(paths): State<AppPaths>) -> Json<serde_json::Value> {
    Json(agent::sessions::list(&paths.data_dir))
}

/// POST /api/assistant/sessions/new {workDir?} — buat sesi baru.
async fn post_sessions_new(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let work_dir = v.get("workDir").and_then(|x| x.as_str()).unwrap_or("");
    let rec = agent::sessions::create(&paths.data_dir, work_dir);
    json_status(StatusCode::OK, json!({ "ok": true, "session": rec }))
}

/// POST /api/assistant/sessions/switch {id}.
async fn post_sessions_switch(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
    match agent::sessions::switch_to(&paths.data_dir, id) {
        Some(rec) => json_status(StatusCode::OK, json!({ "ok": true, "session": rec })),
        None => json_status(StatusCode::NOT_FOUND, json!({ "error": "sesi tidak ada" })),
    }
}

/// POST /api/assistant/sessions/delete {id}.
async fn post_sessions_delete(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
    let (ok, new_active) = agent::sessions::remove(&paths.data_dir, id);
    if ok {
        json_status(StatusCode::OK, json!({ "ok": true, "newActive": new_active }))
    } else {
        json_status(StatusCode::NOT_FOUND, json!({ "error": "sesi tidak ada" }))
    }
}

/// GET /api/mode — status mode (kunci "active" dipakai probe shell Tauri).
async fn get_mode() -> Json<serde_json::Value> {
    Json(mode::status())
}

/// POST /api/mode {mode} — set mode aktif.
async fn post_mode(body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let (status, out) = mode::set_mode(&v);
    json_status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK), out)
}

// ── Pet overlay window ──────────────────────────────────────────────────────

async fn post_pet_launch(State(paths): State<AppPaths>) -> Response {
    json_status(StatusCode::OK, pet::launch(&paths.root, server_port()))
}

async fn post_pet_close() -> Response {
    json_status(StatusCode::OK, pet::close())
}

async fn post_pet_clickthrough(body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let on = v.get("on").and_then(|x| x.as_bool()).unwrap_or(false);
    json_status(StatusCode::OK, pet::set_click_through(on))
}

async fn get_pet_state() -> Response {
    json_status(StatusCode::OK, pet::status())
}

// ── Browser agent (CDP) ─────────────────────────────────────────────────────

fn browser_result(r: Result<serde_json::Value, String>) -> Response {
    match r {
        Ok(v) => json_status(StatusCode::OK, v),
        Err(e) => json_status(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

async fn get_browser_status(State(paths): State<AppPaths>) -> Response {
    json_status(StatusCode::OK, browser::status(&paths.root).await)
}

async fn get_browser_screenshot(uri: Uri) -> Response {
    let q = uri.query().unwrap_or("");
    let get = |k: &str| q.split('&').find_map(|kv| kv.strip_prefix(&format!("{k}="))).map(|s| s.to_string());
    let format = if get("format").as_deref() == Some("jpeg") { "jpeg" } else { "png" };
    let quality = get("quality").and_then(|s| s.parse::<u8>().ok()).unwrap_or(85);
    match browser::screenshot(format, quality).await {
        Ok((bytes, mime, w, h, ts)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Browser-Timestamp", ts.to_string())
            .header("X-Browser-Width", w.to_string())
            .header("X-Browser-Height", h.to_string())
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Body::from(bytes))
            .unwrap(),
        Err(e) => json_status(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

async fn post_browser_open(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("");
    let allow_private = v.get("allowPrivate").and_then(|x| x.as_bool()).unwrap_or(false);
    browser_result(browser::open(&paths.root, url, allow_private).await)
}

async fn post_browser_navigate(body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("");
    browser_result(browser::navigate(url).await)
}

async fn post_browser_history(body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let action = v.get("action").and_then(|x| x.as_str()).unwrap_or("");
    match browser::history(action).await {
        Ok(()) => json_status(StatusCode::OK, json!({ "ok": true, "action": action })),
        Err(e) => json_status(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

async fn post_browser_inspect(body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let cursor = v.get("cursor").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
    let max_chars = v.get("maxChars").and_then(|x| x.as_u64()).map(|n| n.clamp(1, 12_000) as usize).unwrap_or(12_000);
    let snapshot_id = v.get("snapshotId").and_then(|x| x.as_str()).filter(|s| !s.is_empty());
    browser_result(browser::inspect(cursor, max_chars, snapshot_id).await)
}

async fn post_browser_click(body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let sid = v.get("snapshotId").and_then(|x| x.as_str()).unwrap_or("");
    let r = v.get("ref").and_then(|x| x.as_str()).unwrap_or("");
    match browser::click(sid, r).await {
        Ok(()) => json_status(StatusCode::OK, json!({ "ok": true })),
        Err(e) => json_status(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

async fn post_browser_point(body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let x = v.get("x").and_then(|x| x.as_f64()).unwrap_or(f64::NAN);
    let y = v.get("y").and_then(|x| x.as_f64()).unwrap_or(f64::NAN);
    match browser::click_point(x, y).await {
        Ok(()) => json_status(StatusCode::OK, json!({ "ok": true, "x": x, "y": y })),
        Err(e) => json_status(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

async fn post_browser_type(body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let sid = v.get("snapshotId").and_then(|x| x.as_str()).unwrap_or("");
    let r = v.get("ref").and_then(|x| x.as_str()).unwrap_or("");
    let text = match v.get("text").and_then(|x| x.as_str()) {
        Some(t) if t.len() <= 32_768 => t,
        Some(_) => return json_status(StatusCode::BAD_REQUEST, json!({ "error": "text terlalu panjang" })),
        None => return json_status(StatusCode::BAD_REQUEST, json!({ "error": "text wajib berupa string" })),
    };
    let submit = v.get("submit").and_then(|x| x.as_bool()).unwrap_or(false);
    match browser::type_text(sid, r, text, submit).await {
        Ok(()) => json_status(StatusCode::OK, json!({ "ok": true, "chars": text.chars().count(), "submit": submit })),
        Err(e) => json_status(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

async fn post_browser_focus() -> Response {
    json_status(StatusCode::OK, json!({ "ok": browser::focus().await }))
}

async fn post_browser_close() -> Response {
    browser::close().await;
    json_status(StatusCode::OK, json!({ "ok": true }))
}

async fn post_browser_grant(body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let origin = v.get("origin").and_then(|x| x.as_str()).unwrap_or("");
    match browser::grant_private_origin(origin).await {
        Ok(o) => json_status(StatusCode::OK, json!({ "ok": true, "origin": o })),
        Err(e) => json_status(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

/// POST /api/browser/engine — pilih engine browser terkontrol
/// (auto = ikuti default Windows bila Edge/Chrome, atau edge/chrome eksplisit).
async fn post_browser_engine(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let engine = v.get("engine").and_then(|x| x.as_str()).unwrap_or("");
    match browser::set_engine(&paths.root, engine).await {
        Ok(v) => json_status(StatusCode::OK, v),
        Err(e) => json_status(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

// ── VTuber runtime ──────────────────────────────────────────────────────────

/// POST /api/vtuber/start — mulai runtime (kunci mode "vtuber"). apiKey masked/
/// kosong dari UI → pakai key asli tersimpan (padanan handleVtuberStart TS).
async fn post_vtuber_start(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let mut v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    mode::set_active("vtuber");
    let cfg_path = paths.data_dir.join("config.json");
    // Isi apiKey asli bila datang termask/kosong (form prefill placeholder saja).
    let incoming = v.get("apiKey").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    if incoming.is_empty() || incoming.contains("••••") {
        let saved = config::load(&cfg_path);
        if let Some(key) = saved.get("vtuber").and_then(|vt| vt.get("apiKey")).and_then(|k| k.as_str()) {
            v["apiKey"] = json!(key);
        }
    }
    let (ok, err) = vtuber::start(v.clone(), cfg_path.clone());
    if ok {
        // Persist koneksi stream (apiKey masked/kosong ditolak save_vtuber_conn).
        let _ = config::save_vtuber_conn(&cfg_path, &v);
        json_status(StatusCode::OK, json!({ "ok": true }))
    } else {
        json_status(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": err }))
    }
}

/// POST /api/vtuber/stop.
async fn post_vtuber_stop() -> Response {
    json_status(StatusCode::OK, vtuber::stop())
}

/// POST /api/vtuber/overlay — heartbeat Browser Source OBS.
async fn post_vtuber_overlay() -> Response {
    json_status(StatusCode::OK, vtuber::overlay_ping())
}

/// GET /api/vtuber/events?since=N — feed sejak cursor + flag overlay.
async fn get_vtuber_events(uri: Uri) -> Response {
    let since = uri
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("since=")))
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let mut out = vtuber::events(since);
    out["overlay"] = json!(vtuber::overlay_active());
    json_status(StatusCode::OK, out)
}

/// POST /api/vtuber/mock-event — injeksi chat/donasi/agent manual.
async fn post_vtuber_mock_event(body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    match vtuber::inject_event(&v) {
        Some(ev) => json_status(StatusCode::OK, ev),
        None => json_status(StatusCode::BAD_REQUEST, json!({ "error": "runtime tidak aktif" })),
    }
}

/// GET /api/vtuber/conn — koneksi stream tersimpan (apiKey TERMASK).
async fn get_vtuber_conn(State(paths): State<AppPaths>) -> Response {
    json_status(StatusCode::OK, config::vtuber_conn_masked(&paths.data_dir.join("config.json")))
}

/// POST /api/vtuber/config — ubah behavior JALAN + persist.
async fn post_vtuber_config(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let r = vtuber::set_config(&v);
    let _ = config::save_vtuber_conn(&paths.data_dir.join("config.json"), &v);
    json_status(StatusCode::OK, r)
}

/// POST /api/vtuber/operator — instruksi operator (§7).
async fn post_vtuber_operator(body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("");
    let (ok, err) = vtuber::operator_say(text);
    if ok {
        json_status(StatusCode::OK, json!({ "ok": true }))
    } else {
        json_status(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": err }))
    }
}

/// GET /api/media/status — ketersediaan mesin native (SuperTonic TTS, whisper
/// STT) untuk status UI. Model tidak dibundel & tidak diunduh otomatis: yang
/// dilaporkan apa adanya (tersedia/belum + path pencariannya).
async fn get_media_status(State(paths): State<AppPaths>) -> Response {
    let cfg_path = paths.data_dir.join("config.json");
    json_status(StatusCode::OK, media::media_status(&paths, &cfg_path))
}

/// POST /api/media/download {target: "supertonic"|"whisper", model?} — mulai
/// unduhan model native (per-engine terpisah, background). Idempoten bila
/// masih berjalan. Progres dibaca lewat /api/media/status → `downloads`.
async fn post_media_download(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let target = v.get("target").and_then(|x| x.as_str()).unwrap_or("");
    let model = v.get("model").and_then(|x| x.as_str()).unwrap_or("base");
    if target.is_empty() {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "target kosong (supertonic|whisper)" }));
    }
    match media::start_media_download(paths, target, model) {
        Ok(()) => json_status(StatusCode::ACCEPTED, json!({ "ok": true })),
        Err(e) => json_status(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

/// POST /api/media/delete {target: "supertonic"|"whisper", model?} — hapus
/// model native dari SEMUA lokasi yang dikenal (padanan tombol hapus di panel
/// mesin native). Return {deleted: [{path, bytes}], freed_bytes}.
async fn post_media_delete(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let target = v.get("target").and_then(|x| x.as_str()).unwrap_or("");
    let model = v.get("model").and_then(|x| x.as_str()).unwrap_or("");
    if target.is_empty() {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "target kosong (supertonic|whisper)" }));
    }
    match media::delete_media_model(&paths, target, model) {
        Ok(rep) => json_status(StatusCode::OK, rep),
        Err(e) => json_status(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

/// POST /api/stt — transkripsi audio WAV. Provider "local" = whisper in-process
/// (butuh build feature engine-stt); tanpa feature → 503. Provider "openai" =
/// cloud OpenAI-compatible, HANYA bila user eksplisit menyetelnya di config.
async fn post_stt(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let cfg_path = paths.data_dir.join("config.json");
    let (provider, model, lang) = media::stt_provider_model(&cfg_path);
    // "auto" = resolusi di klien (native bila tersedia, else browser); di
    // server diperlakukan sama dengan "local" supaya pemanggil lama tetap jalan.
    let provider = if provider == "auto" || provider.is_empty() { "local".to_string() } else { provider };
    if body.is_empty() {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "audio kosong" }));
    }
    if provider == "openai" {
        let (endpoint, api_key, oai_model, oai_lang) = media::stt_openai_config(&cfg_path);
        if api_key.is_empty() {
            return json_status(StatusCode::BAD_REQUEST, json!({ "error": "stt.apiKey belum diisi di config.json (provider openai)" }));
        }
        return match media::transcribe_openai(&endpoint, &api_key, &oai_model, &oai_lang, body.to_vec()).await {
            Ok(text) => json_status(StatusCode::OK, json!({ "text": text })),
            Err(e) => json_status(StatusCode::BAD_GATEWAY, json!({ "error": format!("STT error: {e}") })),
        };
    }
    if provider != "local" {
        return json_status(StatusCode::NOT_IMPLEMENTED, json!({ "error": format!("STT provider '{provider}' belum diport ke core") }));
    }
    #[cfg(feature = "engine-stt")]
    {
        match media::transcribe_stt(&paths, body.to_vec(), lang, model).await {
            Ok(text) => json_status(StatusCode::OK, json!({ "text": text })),
            Err(e) => json_status(StatusCode::BAD_GATEWAY, json!({ "error": format!("STT error: {e}") })),
        }
    }
    #[cfg(not(feature = "engine-stt"))]
    {
        let _ = (model, lang);
        json_status(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "STT native tidak dikompilasi (build dgn --features engine-stt)" }))
    }
}

/// POST /api/chat-stream — SSE token streaming (role "chat"). Emit event
/// `data:{"delta":"..."}` per token lalu `data:{"done":true,"reply":"..."}`.
/// Machinery streaming (dasar untuk assistant); fallback: coba kandidat sampai
/// ada yang mulai emit, tanpa fallback setelah token pertama keluar.
async fn post_chat_stream(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use axum::response::IntoResponse;
    use futures_util::StreamExt;
    use tokio_stream::wrappers::UnboundedReceiverStream;

    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let messages: Vec<llm::ChatMessage> = v
        .get("messages")
        .and_then(|m| m.as_array())
        .map(|arr| arr.iter().filter_map(llm::ChatMessage::from_value).collect())
        .unwrap_or_default();
    let system = v.get("system").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let cfg_path = paths.data_dir.join("config.json");

    // channel: kirim event JSON string ke SSE.
    let (ev_tx, ev_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let cfg = config::load(&cfg_path);
        let conns: Vec<serde_json::Value> = cfg.get("connections").and_then(|x| x.as_array()).cloned().unwrap_or_default();
        let mut order = llm::order_for_role("chat", &conns);
        if order.is_empty() {
            let active = cfg.get("activeId").and_then(|x| x.as_str());
            let mut o = Vec::new();
            if let Some(aid) = active {
                if let Some(i) = conns.iter().position(|c| c.get("id").and_then(|x| x.as_str()) == Some(aid)) {
                    o.push(i);
                }
            }
            for i in 0..conns.len() {
                if !o.contains(&i) {
                    o.push(i);
                }
            }
            order = o;
        }
        // token channel dari LLM.
        let mut emitted_any = false;
        let mut last_err = String::from("semua koneksi gagal");
        for &i in &order {
            let (tok_tx, mut tok_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            let conn = conns[i].clone();
            let msgs = messages.clone();
            let sysc = system.clone();
            // jalankan LLM stream; forward token → SSE selagi datang.
            let ev_tx2 = ev_tx.clone();
            let forwarder = tokio::spawn(async move {
                while let Some(tok) = tok_rx.recv().await {
                    let _ = ev_tx2.send(json!({ "delta": tok }).to_string());
                }
            });
            let res = llm::call_llm_stream(&conn, &msgs, &sysc, &tok_tx).await;
            drop(tok_tx);
            let _ = forwarder.await;
            match res {
                Ok(full) => {
                    let _ = ev_tx.send(json!({ "done": true, "reply": full }).to_string());
                    emitted_any = true;
                    break;
                }
                Err(e) => {
                    last_err = e.message;
                    // fallback hanya bila belum ada token yang keluar (di sini:
                    // call_llm_stream error → asumsikan belum emit ke user).
                }
            }
        }
        if !emitted_any {
            let _ = ev_tx.send(json!({ "done": true, "error": last_err }).to_string());
        }
    });

    let stream = UnboundedReceiverStream::new(ev_rx).map(|data| Ok::<_, std::convert::Infallible>(Event::default().data(data)));
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// POST /api/animate-text — director emosi/gesture per segment (role "motion").
async fn post_animate_text(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = match serde_json::from_slice(&body).ok() {
        Some(v) => v,
        None => return json_status(StatusCode::BAD_REQUEST, json!({ "error": "body JSON rusak" })),
    };
    let out = director::handle_animate_text(&paths.data_dir.join("config.json"), &v).await;
    json_status(StatusCode::OK, out)
}

/// POST /api/behavior/decide — keputusan perilaku idle tertipe (role "behavior").
async fn post_behavior_decide(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = match serde_json::from_slice(&body).ok() {
        Some(v) => v,
        None => return json_status(StatusCode::BAD_REQUEST, json!({ "error": "body JSON rusak" })),
    };
    let out = behavior::handle_decide(&paths.data_dir.join("config.json"), &v).await;
    json_status(StatusCode::OK, out)
}

/// POST /api/model/classify-params — klasifikasi parameter rig (role "sheet").
async fn post_classify_params(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = match serde_json::from_slice(&body).ok() {
        Some(v) => v,
        None => return json_status(StatusCode::BAD_REQUEST, json!({ "error": "body JSON rusak" })),
    };
    let out = sheet_ai::classify_params(&paths.data_dir.join("config.json"), &v).await;
    json_status(StatusCode::OK, out)
}

/// POST /api/model/analyze-sheet — usul preset pose (role "sheet").
async fn post_analyze_sheet(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = match serde_json::from_slice(&body).ok() {
        Some(v) => v,
        None => return json_status(StatusCode::BAD_REQUEST, json!({ "error": "body JSON rusak" })),
    };
    let out = sheet_ai::analyze_sheet(&paths.data_dir.join("config.json"), &v).await;
    json_status(StatusCode::OK, out)
}

/// POST /api/motions/analyze — tebak makna motion (role "motion").
async fn post_motions_analyze(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = match serde_json::from_slice(&body).ok() {
        Some(v) => v,
        None => return json_status(StatusCode::BAD_REQUEST, json!({ "error": "body JSON rusak" })),
    };
    let (status, out) = motion_ai::analyze_motion(&paths.data_dir.join("config.json"), &v).await;
    json_raw(status, out)
}

/// GET /api/models — daftar folder model yang punya `.model3.json` (terurut).
async fn get_models(State(paths): State<AppPaths>) -> Json<serde_json::Value> {
    Json(json!({ "models": model::list_models(&paths.model_dir) }))
}

/// GET /api/model/path?name=X — path .model3.json relatif ke data/ (atau 404).
async fn get_model_path(
    State(paths): State<AppPaths>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let name = q.get("name").map(String::as_str).unwrap_or("");
    match model::model_path_rel(&paths.data_dir, &paths.model_dir, name) {
        Some(rel) => json_status(StatusCode::OK, json!({ "path": rel })),
        None => json_status(StatusCode::NOT_FOUND, json!({ "error": "not found" })),
    }
}

/// GET /api/sheet?name=X — cache sheet karakter (tandai _stale bila versi lama).
async fn get_sheet_h(
    State(paths): State<AppPaths>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let name = q.get("name").map(String::as_str).unwrap_or("default");
    let (status, body) = sheet::get_sheet(&paths.sheets_dir, name);
    json_raw(status, body)
}

/// POST /api/sheet — stamp scannerVersion + tulis atomik.
async fn post_sheet_h(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let parsed: Option<serde_json::Value> = serde_json::from_slice(&body).ok();
    match parsed {
        Some(v) => {
            let (status, out) = sheet::save_sheet(&paths.sheets_dir, &paths.data_dir, &v);
            json_raw(status, out)
        }
        None => json_status(StatusCode::BAD_REQUEST, json!({ "error": "sheet kosong" })),
    }
}

/// GET /api/model/expressions?name=X — discovery ekspresi (+params per exp).
async fn get_expressions(
    State(paths): State<AppPaths>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let name = q.get("name").map(String::as_str).unwrap_or("");
    match expressions::discover(&paths.model_dir, &paths.data_dir, name) {
        Ok(v) => json_status(StatusCode::OK, v),
        Err(e) => json_status(StatusCode::NOT_FOUND, json!({ "error": e })),
    }
}

/// GET /api/model/motions?name=X — discovery klip .motion3.json (disk +
/// flag declared + grup/index). Sumber adopsi klip yatim di klien.
async fn get_motions(
    State(paths): State<AppPaths>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let name = q.get("name").map(String::as_str).unwrap_or("");
    match motion_files::discover(&paths.model_dir, &paths.data_dir, name) {
        Ok(v) => json_status(StatusCode::OK, v),
        Err(e) => json_status(StatusCode::NOT_FOUND, json!({ "error": e })),
    }
}

/// GET /api/model/motion-analysis?name=X&roles={"ax":"ParamAngleX",...} —
/// analisis kemampuan motion model dari disk (range observasi, base pose,
/// output physics). `roles` = peta role→paramId dari klien (role-mapping.ts);
/// tanpa itu output param-level saja.
async fn get_motion_analysis(
    State(paths): State<AppPaths>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let name = q.get("name").map(String::as_str).unwrap_or("");
    let roles = q.get("roles").and_then(|r| serde_json::from_str::<serde_json::Value>(r).ok());
    match motion_analysis::analyze(&paths.model_dir, &paths.data_dir, name, roles.as_ref()) {
        Ok(v) => json_status(StatusCode::OK, v),
        Err(e) => json_status(StatusCode::NOT_FOUND, json!({ "error": e })),
    }
}

/// GET /api/model/expressions-adoption?name=X — ekspresi + flag enabled.
async fn get_adoption(
    State(paths): State<AppPaths>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let name = q.get("name").map(String::as_str).unwrap_or("");
    let (status, body) = expressions::adoption_get(&paths.model_dir, &paths.data_dir, &paths.sheets_dir, name);
    json_raw(status, body)
}

/// POST /api/model/expressions-adoption {name, disabled:[]}.
async fn post_adoption(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    match serde_json::from_slice::<serde_json::Value>(&body).ok() {
        Some(v) => {
            let (status, out) = expressions::adoption_post(&paths.sheets_dir, &v);
            json_raw(status, out)
        }
        None => json_status(StatusCode::BAD_REQUEST, json!({ "error": "body JSON rusak" })),
    }
}

/// GET /api/model/files?name=X — semua file relatif di folder model.
async fn get_model_files(
    State(paths): State<AppPaths>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let name = q.get("name").map(String::as_str).unwrap_or("");
    match model::list_model_files(&paths.model_dir, name) {
        Some(files) => json_status(StatusCode::OK, json!({ "name": name, "files": files })),
        None => json_status(StatusCode::NOT_FOUND, json!({ "error": "not found" })),
    }
}

/// GET /api/model/avatar?name=X — gambar avatar (biner) atau 404.
async fn get_model_avatar(
    State(paths): State<AppPaths>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let name = q.get("name").map(String::as_str).unwrap_or("");
    match model::find_avatar(&paths.model_dir, name) {
        Some(fp) => {
            let mime = model::avatar_mime(&fp);
            match tokio::fs::read(&fp).await {
                Ok(bytes) => Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, mime)
                    .header(header::CACHE_CONTROL, "no-cache")
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(Body::from(bytes))
                    .unwrap(),
                Err(e) => json_status(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": e.to_string() })),
            }
        }
        None => json_status(StatusCode::NOT_FOUND, json!({ "error": "no avatar" })),
    }
}

/// DELETE /api/model/:name — hapus folder model (rekursif).
async fn delete_model_h(
    State(paths): State<AppPaths>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Response {
    let (status, body) = model::delete_model(&paths.model_dir, &name);
    json_raw(status, body)
}

/// POST /api/model/upload {name, files:[{path,base64}]}.
async fn post_model_upload(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    match serde_json::from_slice::<serde_json::Value>(&body).ok() {
        Some(v) => {
            let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let files = v.get("files").cloned().unwrap_or(json!([]));
            let (status, out) = model::upload_model(&paths.model_dir, name, &files);
            json_raw(status, out)
        }
        None => json_status(StatusCode::BAD_REQUEST, json!({ "error": "body JSON rusak" })),
    }
}

/// POST /api/model/import-zip {name, base64}.
async fn post_import_zip(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    match serde_json::from_slice::<serde_json::Value>(&body).ok() {
        Some(v) => {
            let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let b64 = v.get("base64").and_then(|x| x.as_str()).unwrap_or("");
            let (status, out) = model::import_zip(&paths.model_dir, &paths.data_dir, name, b64);
            json_raw(status, out)
        }
        None => json_status(StatusCode::BAD_REQUEST, json!({ "error": "zip kosong" })),
    }
}

/// GET /api/motions?model=X — daftar motion buatan user.
async fn get_motions_list(
    State(paths): State<AppPaths>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let model = q.get("model").map(String::as_str).unwrap_or("default");
    json_status(StatusCode::OK, motions::list_motions(&paths.motions_dir, model))
}

/// GET /api/motions/native-alias?model=X — overlay rename klip native
/// (non-destruktif; file model tidak pernah ditulis).
async fn get_native_alias_h(
    State(paths): State<AppPaths>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let model = q.get("model").map(String::as_str).unwrap_or("default");
    json_status(StatusCode::OK, motions::get_native_aliases(&paths.motions_dir, model))
}

/// POST /api/motions/native-alias {model, file, name} — set/hapus satu alias
/// (name kosong = hapus). Return {ok, aliases} terbaru.
async fn post_native_alias_h(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let model = v.get("model").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).unwrap_or("default");
    let file = v.get("file").and_then(|x| x.as_str()).unwrap_or("");
    let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
    let (status, out) = motions::set_native_alias(&paths.motions_dir, model, file, name);
    json_raw(status, out)
}

/// GET /api/motions/:id?model=X — satu motion.
async fn get_motion_h(
    State(paths): State<AppPaths>,
    axum::extract::Path(id): axum::extract::Path<String>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let model = q.get("model").map(String::as_str).unwrap_or("default");
    let (status, body) = motions::get_motion(&paths.motions_dir, model, &id);
    json_raw(status, body)
}

/// DELETE /api/motions/:id?model=X — hapus motion.
async fn del_motion_h(
    State(paths): State<AppPaths>,
    axum::extract::Path(id): axum::extract::Path<String>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let model = q.get("model").map(String::as_str).unwrap_or("default");
    let (status, body) = motions::delete_motion(&paths.motions_dir, model, &id);
    json_raw(status, body)
}

/// PUT /api/motions/:id — sanitasi (motion_dsl) lalu tulis. Body {model?, motion?}.
async fn put_motion_h(
    State(paths): State<AppPaths>,
    axum::extract::Path(id): axum::extract::Path<String>,
    body: axum::body::Bytes,
) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let model_key = v.get("model").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).unwrap_or("default").to_string();
    // raw = body.motion || body (id di-override dari URL).
    let mut raw = v.get("motion").cloned().unwrap_or_else(|| v.clone());
    if let Some(o) = raw.as_object_mut() {
        o.insert("id".into(), json!(id));
    }
    let src_model = raw.get("sourceModelId").and_then(|x| x.as_str()).map(String::from).unwrap_or_else(|| model_key.clone());
    match motion_dsl::sanitize_motion_asset(&raw, &motion_dsl::SanitizeOpts { require_tracks: true, source: Some("user".into()), source_model_id: Some(src_model) }) {
        Ok(asset) => {
            let (status, out) = motions::write_motion(&paths.motions_dir, &model_key, &id, &asset);
            json_raw(status, out)
        }
        Err(errs) => json_status(StatusCode::BAD_REQUEST, json!({ "error": format!("motion invalid: {}", errs.join("; ")) })),
    }
}

/// POST /api/motions/generate — buat motion dari deskripsi (role "motion").
async fn post_motions_generate(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let (status, out) = motion_ai::generate_motion(&paths.data_dir.join("config.json"), &v).await;
    json_raw(status, out)
}

/// POST /api/motions/validate {model?, roleMap?, motion} — validator
/// independen (`motion_validation`): laporan issue draft Motion Asset
/// SEBELUM disimpan (sanitize server tetap gerbang akhir saat Simpan).
/// `model` + `roleMap` opsional → pemeriksaan semantik vs analisis disk.
async fn post_motions_validate(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = match serde_json::from_slice(&body).ok() {
        Some(v) => v,
        None => return json_status(StatusCode::BAD_REQUEST, json!({ "error": "body JSON rusak" })),
    };
    let Some(motion) = v.get("motion") else {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "field motion wajib" }));
    };
    let model = v.get("model").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let role_map = v.get("roleMap").filter(|x| x.is_object());
    let analysis = if model.is_empty() {
        None
    } else {
        crate::motion_analysis::analyze(&paths.model_dir, &paths.data_dir, &model, role_map).ok()
    };
    json_status(StatusCode::OK, motion_validation::validate_asset(motion, analysis.as_ref()))
}

/// POST /api/motions/verify {model, roleMap?, motion, intent} — critic
/// visual (`motion_vision`): render filmstrip di harness → LLM role
/// `motion-vision` menilai → verdict. Tanpa koneksi vision → `{skipped}`.
async fn post_motions_verify(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = match serde_json::from_slice(&body).ok() {
        Some(v) => v,
        None => return json_status(StatusCode::BAD_REQUEST, json!({ "error": "body JSON rusak" })),
    };
    let Some(motion) = v.get("motion") else {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "field motion wajib" }));
    };
    let model = v.get("model").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let role_map = v.get("roleMap").cloned().unwrap_or(serde_json::Value::Null);
    let intent = v.get("intent").and_then(|x| x.as_str()).unwrap_or("");
    match motion_vision::verify(&paths.data_dir.join("config.json"), &paths.root, &model, &role_map, motion, intent).await {
        Ok(v) => json_status(StatusCode::OK, v),
        Err(e) => json_status(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": e })),
    }
}

/// POST /api/motions — buat motion baru (padanan handleMotionsPost TS).
/// Sanitasi lewat motion_dsl lalu tulis; 409 bila id sudah ada (pakai PUT
/// untuk timpa/Simpan).
async fn post_motions_h(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = match serde_json::from_slice(&body).ok() {
        Some(v) => v,
        None => return json_status(StatusCode::BAD_REQUEST, json!({ "error": "body JSON rusak" })),
    };
    let model_key = v.get("model").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).unwrap_or("default").to_string();
    // raw = body.motion || body.
    let raw = v.get("motion").cloned().unwrap_or_else(|| v.clone());
    let src_model = raw.get("sourceModelId").and_then(|x| x.as_str()).map(String::from).unwrap_or_else(|| model_key.clone());
    match motion_dsl::sanitize_motion_asset(&raw, &motion_dsl::SanitizeOpts { require_tracks: true, source: Some("user".into()), source_model_id: Some(src_model) }) {
        Ok(asset) => {
            let id = asset.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let (status, out) = motions::create_motion(&paths.motions_dir, &model_key, &id, &asset);
            json_raw(status, out)
        }
        Err(errs) => json_status(StatusCode::BAD_REQUEST, json!({ "error": format!("motion invalid: {}", errs.join("; ")) })),
    }
}

/// GET /api/model/motion-taxonomy?name=X[&force=1] — sajikan cache taksonomi
/// (klasifikasi dihitung klien; server hanya store/serve — opsi B).
async fn get_motion_taxonomy(
    State(paths): State<AppPaths>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let name = q.get("name").map(String::as_str).unwrap_or("");
    let force = q.get("force").map(String::as_str) == Some("1");
    let (status, body) = motion_taxonomy::get(&paths.model_dir, &paths.sheets_dir, name, force);
    json_raw(status, body)
}

/// POST /api/model/motion-taxonomy {name, ...payload} — simpan hasil klasifikasi klien.
async fn post_motion_taxonomy(State(paths): State<AppPaths>, body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let (status, out) = motion_taxonomy::store(&paths.model_dir, &paths.sheets_dir, &v);
    json_raw(status, out)
}

/// Bangun Response JSON dari status u16 + body string (untuk handler yang sudah
/// menghasilkan JSON string + status sendiri).
fn json_raw(status: u16, body: String) -> Response {
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from(body))
        .unwrap()
}

/// Penyajian statis + SPA fallback (padanan blok fetch static di index.ts).
async fn static_handler(State(paths): State<AppPaths>, uri: Uri) -> Response {
    let mut pathname = uri.path().to_string();
    if pathname == "/" {
        pathname = "/index.html".to_string();
    }
    // Auto-Rescue: manifest virtual model/<folder>/__rescue__.model3.json
    // dirakit di memori (tidak menulis folder), sama seperti index.ts.
    if let Some(folder) = pathname
        .strip_prefix("/model/")
        .and_then(|s| s.strip_suffix(&format!("/{}", rescue::RESCUE_FILENAME)))
    {
        let decoded = static_serve::percent_decode_pub(folder);
        if decoded.split(['/', '\\']).any(|s| s == "..") {
            return text(StatusCode::FORBIDDEN, "Forbidden");
        }
        let dir = paths.model_dir.join(&decoded);
        return match rescue::build_rescue_blueprint(&dir) {
            Some(m) => json_status(StatusCode::OK, m),
            None => json_status(StatusCode::NOT_FOUND, json!({ "error": "tak bisa dirakit" })),
        };
    }
    match safe_join(&paths, &pathname) {
        Resolved::Forbidden => text(StatusCode::FORBIDDEN, "Forbidden"),
        Resolved::File(f) => serve_file(f).await,
        Resolved::NotFound => {
            // /api/* tak dikenal → 404 JSON (bukan SPA fallback), sama TS.
            if pathname.starts_with("/api/") {
                return json_status(StatusCode::NOT_FOUND, json!({"error":"not found"}));
            }
            // SPA fallback HANYA path tanpa ekstensi (rute UI).
            let last = pathname.rsplit('/').next().unwrap_or("");
            if !last.is_empty() && !last.contains('.') {
                let idx = paths.static_dir.join("index.html");
                if idx.is_file() {
                    return serve_file(idx).await;
                }
            }
            text(StatusCode::NOT_FOUND, "Not Found")
        }
    }
}

async fn serve_file(path: std::path::PathBuf) -> Response {
    let mime = mime_for(&path.to_string_lossy());
    match tokio::fs::read(&path).await {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CACHE_CONTROL, "no-cache")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Body::from(bytes))
            .unwrap(),
        Err(_) => text(StatusCode::NOT_FOUND, "Not Found"),
    }
}

fn text(status: StatusCode, msg: &str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from(msg.to_string()))
        .unwrap()
}

fn json_status(status: StatusCode, v: serde_json::Value) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .body(Body::from(v.to_string()))
        .unwrap()
}

/// Port loopback yang NYATA di-bind server ini (diisi serve(); dibaca
/// peluncur pet — env PORT saja tak cukup karena shell bisa bergeser port
/// bila default diduduki aplikasi asing).
static SERVER_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

/// Port aktual server. Urutan: bind serve() → env PORT → 8310.
pub fn server_port() -> u16 {
    if let Some(p) = SERVER_PORT.get() {
        return *p;
    }
    std::env::var("PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(8310)
}

/// Jalankan server core di `<HOST>:<port>` (env HOST, default loopback
/// `127.0.0.1`; set HOST=0.0.0.0 bila memang mau diakses dari jaringan —
/// padanan perilaku server lama). Catat port aktual untuk peluncur pet.
/// Blocking sampai shutdown.
pub async fn serve(port: u16, paths: AppPaths) -> std::io::Result<()> {
    let _ = SERVER_PORT.set(port);
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    eprintln!("[core] server HTTP siap di http://{addr}");
    axum::serve(listener, router(paths)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use serde_json::{json, Value};
    use tower::ServiceExt; // oneshot

    fn app() -> Router {
        router(AppPaths::from_root("."))
    }

    #[test]
    fn skeleton_siap() {
        assert!(core_ready());
        assert!(!VERSION.is_empty());
    }

    #[tokio::test]
    async fn health_membalas_ok() {
        let resp = app()
            .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn version_membalas_core_version() {
        let resp = app()
            .oneshot(Request::builder().uri("/api/version").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["core_version"], VERSION);
        // Handshake: instance wajib ada supaya frontend bisa memverifikasi
        // bahwa port yang dihubungi benar server milik instalasi ini.
        assert!(v["instance"].as_str().unwrap_or("").starts_with("lumimi-"));
    }

    #[test]
    fn instance_token_stabil_per_root_dan_beda_antar_root() {
        let a = AppPaths::from_root(".");
        assert_eq!(instance_token(&a), instance_token(&a), "root sama → token sama (attach dobel-klik tetap jalan)");
        let b = AppPaths::from_root("folder-lain");
        assert_ne!(instance_token(&a), instance_token(&b), "root beda → token beda (instalasi lain tak tertukar)");
    }

    #[tokio::test]
    async fn tts_test_provider_browser_502_json() {
        // Jalur error kontrak /api/tts/test: provider "browser" tak pernah
        // disintesis di server → 502 JSON {ok:false}, BUKAN audio biner.
        // (Jalur sukses sengaja tak dites di sini: butuh model SuperTonic
        // di disk / jaringan, keduanya dilarang di test.)
        let body = serde_json::json!({ "tts": { "provider": "browser" } }).to_string();
        let resp = app()
            .oneshot(Request::builder().uri("/api/tts/test").method("POST").body(Body::from(body)).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
        let ct = resp.headers().get(header::CONTENT_TYPE).unwrap().to_str().unwrap();
        assert!(ct.contains("application/json"));
        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], serde_json::Value::Bool(false));
        assert!(v["error"].as_str().unwrap_or("").contains("browser"));
    }

    #[tokio::test]
    async fn api_tak_dikenal_404_json() {
        let resp = app()
            .oneshot(Request::builder().uri("/api/nope").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let ct = resp.headers().get(header::CONTENT_TYPE).unwrap().to_str().unwrap();
        assert!(ct.contains("application/json"));
    }

    #[tokio::test]
    async fn traversal_403() {
        let resp = app()
            .oneshot(Request::builder().uri("/../secret").body(Body::empty()).unwrap())
            .await
            .unwrap();
        // axum menormalkan sebagian; safe_join tetap menolak segmen "..".
        assert!(matches!(resp.status(), StatusCode::FORBIDDEN | StatusCode::NOT_FOUND));
    }

    #[tokio::test]
    async fn test_koneksi_tanpa_key_400() {
        let body = serde_json::json!({ "connection": { "id": "x", "provider": "openai-compatible", "apiKey": "" } }).to_string();
        let resp = app()
            .oneshot(Request::builder().uri("/api/test").method("POST").body(Body::from(body)).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn motions_post_invalid_400() {
        let body = serde_json::json!({ "model": "default", "motion": { "id": "!!!", "tracks": [] } }).to_string();
        let resp = app()
            .oneshot(Request::builder().uri("/api/motions").method("POST").body(Body::from(body)).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn server_port_fallback_env_tanpa_serve() {
        // Tanpa serve() (unit test tak bind), env PORT kosong → 8310.
        let old = std::env::var("PORT").ok();
        std::env::remove_var("PORT");
        assert_eq!(server_port(), 8310);
        std::env::set_var("PORT", "8399");
        assert_eq!(server_port(), 8399);
        match old {
            Some(v) => std::env::set_var("PORT", v),
            None => std::env::remove_var("PORT"),
        }
    }

    // ── Port `test/server-integration.test.ts` (arsip Bun dihapus, Batch A) ──
    // Kontrak: SEMUA rute klien yang dipakai app.js/panel/overlay ter-klaim
    // router — respons bukan penanda rute-unknown (`404 {"error":"not found"}`
    // dari fallback static_handler). Config mock di akar temp → rute LLM tidak
    // pernah menyentuh jaringan / data/ user.

    fn tmp_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("l2drt-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data/model/m1")).unwrap();
        std::fs::create_dir_all(dir.join("data/model/m1/exp")).unwrap();
        std::fs::write(
            dir.join("data/model/m1/m1.model3.json"),
            r#"{"Version":3,"FileReferences":{"Moc":"m1.moc3","Textures":["t.png"],"Expressions":[{"Name":"senyum","File":"exp/s.exp3.json"}]}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("data/model/m1/exp/s.exp3.json"), r#"{"Parameters":[{"Id":"ParamX"}]}"#).unwrap();
        std::fs::write(dir.join("data/model/m1/m1.moc3"), "MOC3fake").unwrap();
        std::fs::write(dir.join("data/model/m1/t.png"), "png").unwrap();
        std::fs::write(
            dir.join("data/config.json"),
            r#"{"activeId":"m","connections":[{"id":"m","provider":"mock","apiKey":"mock"}]}"#,
        )
        .unwrap();
        dir
    }

    async fn call(method: &str, path: &str, body: Option<serde_json::Value>) -> (StatusCode, serde_json::Value) {
        let body = match body {
            Some(v) => Body::from(v.to_string()),
            None => Body::empty(),
        };
        let req = Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body)
            .unwrap();
        let resp = router(AppPaths::from_root(tmp_root("x"))).oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, json)
    }

    fn is_unknown_marker(status: StatusCode, json: &Value) -> bool {
        status == StatusCode::NOT_FOUND && json.get("error").and_then(|e| e.as_str()) == Some("not found")
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn parity_rute_klien_terklaim() {
        // Padanan "is handled by the dispatcher" (44 test TS) — satu tabel,
        // tiap rute klien harus dikenali router (bukan penanda unknown).
        let cases: Vec<(&str, &str, Option<Value>)> = vec![
            ("POST", "/api/chat", Some(json!({"messages":[{"role":"user","content":"hai"}]}))),
            ("POST", "/api/tts", Some(json!({"text":""}))),
            ("GET", "/api/config", None),
            ("POST", "/api/config", Some(json!({"action":"saveI18n","i18n":{"lang":"id"}}))),
            ("POST", "/api/test", Some(json!({}))),
            ("POST", "/api/model/classify-params", Some(json!({"model":"m1"}))),
            ("POST", "/api/model/analyze-sheet", Some(json!({"model":"m1"}))),
            ("POST", "/api/animate-text", Some(json!({"text":""}))),
            ("POST", "/api/motions/analyze", Some(json!({"motion":{}}))),
            ("POST", "/api/motions/generate", Some(json!({"prompt":""}))),
            ("GET", "/api/sheet?name=m1", None),
            ("POST", "/api/sheet", Some(json!({"name":"m1"}))),
            ("GET", "/api/models", None),
            ("GET", "/api/model/path?name=m1", None),
            ("GET", "/api/model/expressions?name=m1", None),
            ("GET", "/api/model/motions?name=m1", None),
            ("GET", "/api/model/expressions-adoption?name=m1", None),
            ("POST", "/api/model/expressions-adoption", Some(json!({"name":"m1","disabled":[]}))),
            ("GET", "/api/model/files?name=m1", None),
            ("GET", "/api/model/motion-taxonomy?name=m1", None),
            ("POST", "/api/model/import-zip", Some(json!({"b64":"!!!not-zip"}))),
            ("POST", "/api/model/upload", Some(json!({}))),
            ("DELETE", "/api/model/__no_such_model_test__", None),
            ("GET", "/api/motions?model=m1", None),
            ("POST", "/api/motions", Some(json!({"model":"m1"}))),
            // GET/DELETE /api/motions/:id sengaja TIDAK di sini: not-found-nya
            // ber-body sama persis dgn penanda rute-unknown → tak terbedakan
            // lewat dispatch. Rutenya tetap teruji lewat core/src/motions.rs.
            ("PUT", "/api/motions/some-id", Some(json!({"model":"m1","motion":{"id":"x","tracks":[]}}))),
            ("GET", "/api/mode", None),
            ("POST", "/api/mode", Some(json!({"mode":"stage"}))),
            ("GET", "/api/pet/state", None),
            ("GET", "/api/browser/status", None),
            ("GET", "/api/assistant/status", None),
            ("GET", "/api/assistant/history", None),
            ("GET", "/api/assistant/events?since=0", None),
            ("GET", "/api/assistant/undo", None),
            ("GET", "/api/assistant/sessions", None),
            ("GET", "/api/assistant/memory", None),
            ("POST", "/api/assistant/start", Some(json!({"workDir":""}))),
            ("POST", "/api/stt", Some(json!([]))),
            ("GET", "/api/media/status", None),
            // target tak dikenal → 400 tanpa menyentuh jaringan (uji klaim rute).
            ("POST", "/api/media/download", Some(json!({"target":"aneh"}))),
            ("POST", "/api/media/delete", Some(json!({"target":"aneh"}))),
        ];
        for (method, path, body) in cases {
            let (status, json) = call(method, path, body).await;
            assert!(!is_unknown_marker(status, &json), "rute tidak ter-klaim router: {method} {path} → {status} {json}");
        }
    }

    #[tokio::test]
    async fn bentuk_rute_klien_konkret() {
        // Beberapa rute diuji BENTUK responsnya (padanan assertion TS yang
        // lebih spesifik dari sekadar "ter-klaim").
        let root = tmp_root("shape");
        let app = router(AppPaths::from_root(&root));
        let get = |uri: &'static str, app: Router| async move {
            let resp = app.oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap()).await.unwrap();
            let status = resp.status();
            let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
            (status, serde_json::from_slice::<Value>(&bytes).unwrap())
        };
        let (st, cfg) = get("/api/config", app.clone()).await;
        assert_eq!(st, StatusCode::OK);
        assert!(cfg["connections"].is_array());
        let (st, models) = get("/api/models", app.clone()).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(models["models"].as_array().unwrap().len(), 1);
        let (st, expr) = get("/api/model/expressions?name=m1", app.clone()).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(expr["expressions"][0]["params"], json!(["ParamX"]));
        let (st, bstat) = get("/api/browser/status", app.clone()).await;
        assert_eq!(st, StatusCode::OK);
        for k in ["available", "running", "connected", "engine", "url", "canBack", "canForward", "originGranted"] {
            assert!(bstat.get(k).is_some(), "browser/status field hilang: {k}");
        }
        let (st, astat) = get("/api/assistant/status", app).await;
        assert_eq!(st, StatusCode::OK);
        assert!(astat["tools"].is_array() && astat["pendingApprovals"].is_array());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn rescue_virtual_manifest_terpasang() {
        // Padanan wiring guard test-auto-rescue (arsip JS dihapus): route
        // /model/<folder>/__rescue__.model3.json dirakit di memori — folder
        // dengan manifest asli → 404 (tak ada yang di-rescue), tanpa manifest
        // tapi ber-.moc3 → 200 blueprint.
        let root = tmp_root("resc");
        std::fs::create_dir_all(root.join("data/model/pure")).unwrap();
        std::fs::write(root.join("data/model/pure/a.moc3"), "M").unwrap();
        let app = router(AppPaths::from_root(&root));
        let hit = |uri: String, app: Router| async move {
            let resp = app.oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap()).await.unwrap();
            resp.status()
        };
        assert_eq!(
            hit("/model/pure/__rescue__.model3.json".into(), app.clone()).await,
            StatusCode::OK,
            "folder tanpa manifest → blueprint virtual"
        );
        assert_eq!(
            hit("/model/m1/__rescue__.model3.json".into(), app.clone()).await,
            StatusCode::NOT_FOUND,
            "punya manifest asli → tak ada rescue"
        );
        assert_eq!(
            hit("/model/../secrets/__rescue__.model3.json".into(), app).await,
            StatusCode::FORBIDDEN
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
