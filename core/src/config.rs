//! Config — port BACA+TULIS `src/shared/config.ts` (byte-compatible dengan
//! `data/config.json`). Backend satu-satunya: core Rust.
//!
//! Strategi byte-compat: pakai `serde_json::Value` mentah, TIDAK memodelkan tiap
//! field — merge section-level ({...DEFAULT, ...base}) persis seperti TS, mask
//! apiKey untuk UI, normalisasi roles. Nilai user tak pernah ditimpa default.

use std::path::Path;

use serde_json::{json, Value};

/// Role LLM yang dikenal (padanan LLM_ROLES di llm-client.ts).
const LLM_ROLES: &[&str] =
    &["chat", "motion", "sheet", "assistant", "motion-vision", "behavior"];

/// DEFAULT_CONFIG — cermin `src/shared/config.ts` (untuk backfill section baru).
pub fn default_config() -> Value {
    json!({
        "activeId": null,
        "connections": [],
        "tts": { "provider": "auto", "endpoint": "", "voice": "F1" },
        "events": {
            "idleSpeak": true, "idleMs": 1_800_000, "idleRepeatMs": 1_800_000,
            "awaySpeak": true, "returnSpeak": true, "awayHiddenMs": 10_000,
            "quietMs": 1_800_000
        },
        "camera": {
            "enabled": false, "fps": 0.4, "presenceThreshold": 0.4,
            "device": "webgpu", "model": "Xenova/facial_emotions_image_detection",
            "moodGraceMs": 20_000, "moodDebounceMs": 5000, "moodStableTicks": 2
        },
        "motion": { "enabled": false, "gain": 1.5 },
        "i18n": { "lang": "auto" },
        "stt": {
            "provider": "auto", "engineModel": "base", "model": "Xenova/whisper-base",
            "language": "indonesian", "autoSend": true, "silenceMs": 1500,
            "maxMs": 30_000, "device": "",
            "endpoint": "", "apiKey": "", "apiModel": "whisper-1"
        }
    })
}

/// Muat config dari `path`, merge section-level dengan default (base menang per
/// key top-level, key default yang absen diisi) — padanan `{...DEFAULT, ...base}`.
/// File hilang/rusak → default utuh (TS ensureDefault menulis default saat itu).
pub fn load(path: &Path) -> Value {
    let mut merged = default_config();
    if let Ok(text) = std::fs::read_to_string(path) {
        if let Ok(base) = serde_json::from_str::<Value>(&text) {
            if let (Some(m), Some(b)) = (merged.as_object_mut(), base.as_object()) {
                for (k, v) in b {
                    m.insert(k.clone(), v.clone()); // base menang (juga isi key ekstra)
                }
            }
        }
    }
    merged
}

/// Mask apiKey untuk UI (padanan maskKey): kosong / "MASUKKAN…" → apa adanya;
/// selain itu 6 char awal + 8 bullet + 4 char akhir. Berbasis char (bukan byte).
pub fn mask_key(k: &str) -> String {
    if k.is_empty() || k.starts_with("MASUKKAN") {
        return k.to_string();
    }
    let chars: Vec<char> = k.chars().collect();
    let head: String = chars.iter().take(6).collect();
    let tail: String = if chars.len() >= 4 {
        chars[chars.len() - 4..].iter().collect()
    } else {
        chars.iter().collect()
    };
    format!("{head}••••••••{tail}")
}

/// Normalisasi roles: array string, lowercase-trim, hanya role dikenal, unik.
pub fn normalize_roles(raw: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(arr) = raw.as_array() {
        for r in arr {
            if let Some(s) = r.as_str() {
                let k = s.trim().to_lowercase();
                if k.is_empty() || !LLM_ROLES.contains(&k.as_str()) {
                    continue;
                }
                if !out.contains(&k) {
                    out.push(k);
                }
            }
        }
    }
    out
}

/// Bangun payload GET /api/config (apiKey dimask, roles dinormalisasi) — persis
/// bentuk yang dikembalikan handler TS.
pub fn api_config_response(path: &Path) -> Value {
    let cfg = load(path);
    let empty_arr = Value::Array(vec![]);
    let conns = cfg.get("connections").unwrap_or(&empty_arr);
    let conns_out: Vec<Value> = conns
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|c| {
                    let mut o = c.clone();
                    if let Some(obj) = o.as_object_mut() {
                        if let Some(k) = obj.get("apiKey").and_then(|v| v.as_str()) {
                            if !k.is_empty() && !k.starts_with("MASUKKAN") {
                                obj.insert("apiKey".into(), json!(mask_key(k)));
                            }
                        }
                        let roles = obj.get("roles").cloned().unwrap_or(Value::Null);
                        obj.insert("roles".into(), json!(normalize_roles(&roles)));
                    }
                    o
                })
                .collect()
        })
        .unwrap_or_default();

    let mut tts_out = cfg.get("tts").cloned().unwrap_or_else(|| json!({}));
    if let Some(obj) = tts_out.as_object_mut() {
        if let Some(k) = obj.get("apiKey").and_then(|v| v.as_str()) {
            if !k.is_empty() {
                obj.insert("apiKey".into(), json!(mask_key(k)));
            }
        }
    }

    let sect = |k: &str| cfg.get(k).cloned().unwrap_or_else(|| json!({}));
    // stt.apiKey (provider openai) dimask — plaintext tak pernah lewat HTTP.
    let mut stt_out = sect("stt");
    if let Some(obj) = stt_out.as_object_mut() {
        if let Some(k) = obj.get("apiKey").and_then(|v| v.as_str()) {
            if !k.is_empty() && !k.starts_with("MASUKKAN") {
                obj.insert("apiKey".into(), json!(mask_key(k)));
            }
        }
    }
    json!({
        "activeId": cfg.get("activeId").cloned().unwrap_or(Value::Null),
        "connections": conns_out,
        "tts": tts_out,
        "events": sect("events"),
        "camera": sect("camera"),
        "motion": sect("motion"),
        "stt": stt_out,
        "i18n": sect("i18n"),
    })
}

// ── TULIS config (port handleConfigPost + save* dari index.ts/config.ts) ──
// data/config.json TIDAK di-commit (gitignored) & berisi apiKey plaintext.

const KNOWN_EVENT_KEYS: &[&str] = &[
    "idleSpeak", "idleMs", "idleRepeatMs", "awaySpeak", "returnSpeak", "awayHiddenMs", "quietMs",
];

/// Baca file mentah sebagai objek (untuk merge saat tulis). Rusak/hilang → {}.
fn read_raw(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}))
}

/// `{...base, ...over}` untuk objek (over menang). Non-objek → over.
fn merge_obj(base: &Value, over: &Value) -> Value {
    match (base.as_object(), over.as_object()) {
        (Some(b), Some(o)) => {
            let mut m = b.clone();
            for (k, v) in o {
                m.insert(k.clone(), v.clone());
            }
            Value::Object(m)
        }
        _ => over.clone(),
    }
}

/// cleanStr: buang kontrol + zero-width + trim (padanan cleanStr TS).
fn clean_str(s: &str) -> String {
    s.chars()
        .filter(|&c| {
            let u = c as u32;
            !(u <= 0x1F
                || u == 0x7F
                || u == 0xA0
                || (0x200B..=0x200D).contains(&u)
                || u == 0xFEFF)
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// base36 publik (dipakai modul lain, mis. expressions untuk fallback nama).
pub fn base36_pub(n: u128) -> String {
    base36(n)
}

fn base36(mut n: u128) -> String {
    if n == 0 {
        return "0".into();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(digits[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Tulis {...prev, activeId, connections} atomik (padanan saveConnections).
pub fn save_connections(path: &Path, conns: Vec<Value>, active_id: Value) -> std::io::Result<()> {
    let prev = read_raw(path);
    let active = if active_id.is_null() {
        conns.first().and_then(|c| c.get("id").cloned()).unwrap_or(Value::Null)
    } else {
        active_id
    };
    let mut data = prev.as_object().cloned().unwrap_or_default();
    data.insert("activeId".into(), active);
    data.insert("connections".into(), Value::Array(conns));
    crate::sheet::write_json_atomic(path, &Value::Object(data))
}

/// Simpan events (mergeEventsIntoConfig: hanya KNOWN_EVENT_KEYS).
pub fn save_events(path: &Path, events: &Value) -> std::io::Result<Value> {
    let prev = read_raw(path);
    let prev_events = prev.get("events").cloned().unwrap_or_else(|| json!({}));
    let merged = merge_obj(&prev_events, events);
    let mut clean = serde_json::Map::new();
    if let Some(m) = merged.as_object() {
        for k in KNOWN_EVENT_KEYS {
            if let Some(v) = m.get(*k) {
                clean.insert((*k).to_string(), v.clone());
            }
        }
    }
    let data = merge_obj(&prev, &json!({ "events": Value::Object(clean.clone()) }));
    crate::sheet::write_json_atomic(path, &data)?;
    Ok(Value::Object(clean))
}

/// Simpan tts ({...prev.tts, ...tts}).
pub fn save_tts(path: &Path, tts: &Value) -> std::io::Result<Value> {
    let prev = read_raw(path);
    let merged = merge_obj(&prev.get("tts").cloned().unwrap_or_else(|| json!({})), tts);
    let data = merge_obj(&prev, &json!({ "tts": merged.clone() }));
    crate::sheet::write_json_atomic(path, &data)?;
    Ok(merged)
}

/// Simpan i18n ({...prev.i18n, ...i18n}).
pub fn save_i18n(path: &Path, i18n: &Value) -> std::io::Result<Value> {
    let prev = read_raw(path);
    let merged = merge_obj(&prev.get("i18n").cloned().unwrap_or_else(|| json!({})), i18n);
    let data = merge_obj(&prev, &json!({ "i18n": merged.clone() }));
    crate::sheet::write_json_atomic(path, &data)?;
    Ok(merged)
}

/// Field koneksi stream VTuber yang dipersist (merge per-field). apiKey masked/
/// placeholder/kosong dari UI = pertahankan yang tersimpan (padanan
/// saveVtuberConn di config.ts).
const VTUBER_KEYS: &[&str] = &[
    "provider", "channel", "videoId", "apiKey", "persona", "cooldownMs", "respondChat", "respondDonation",
];

/// Simpan koneksi stream VTuber (merge per-field, apiKey aman). Return vtuber.
pub fn save_vtuber_conn(path: &Path, conn: &Value) -> std::io::Result<Value> {
    let prev = read_raw(path);
    let mut next = prev.get("vtuber").and_then(|v| v.as_object()).cloned().unwrap_or_default();
    if let Some(obj) = conn.as_object() {
        for k in VTUBER_KEYS {
            let Some(v) = obj.get(*k) else { continue };
            if *k == "apiKey" {
                let s = v.as_str().unwrap_or("").trim();
                // Masked / placeholder / kosong = pertahankan yang tersimpan.
                if s.is_empty() || s.contains("••••") || s.starts_with("MASUKKAN") {
                    continue;
                }
            }
            next.insert((*k).to_string(), v.clone());
        }
    }
    let vt = Value::Object(next);
    let data = merge_obj(&prev, &json!({ "vtuber": vt.clone() }));
    crate::sheet::write_json_atomic(path, &data)?;
    Ok(vt)
}

/// Koneksi stream tersimpan dengan apiKey TERMASK (prefill form, tak pernah
/// balik nilai asli lewat HTTP — pola sama dgn /api/config).
pub fn vtuber_conn_masked(path: &Path) -> Value {
    let prev = read_raw(path);
    let mut vt = prev.get("vtuber").and_then(|v| v.as_object()).cloned().unwrap_or_default();
    if let Some(k) = vt.get("apiKey").and_then(|v| v.as_str()) {
        let masked = mask_key(k);
        vt.insert("apiKey".into(), json!(masked));
    }
    Value::Object(vt)
}

/// POST /api/config — dispatcher action (padanan handleConfigPost). Return
/// (status, body JSON string).
pub fn handle_config_post(path: &Path, body: &Value) -> (u16, String) {
    if !body.is_object() {
        return (400, json!({ "error": "body JSON rusak" }).to_string());
    }
    let action = body.get("action").and_then(|v| v.as_str()).unwrap_or("save");
    let cfg = load(path);
    let mut active_id = cfg.get("activeId").cloned().unwrap_or(Value::Null);
    let mut conns: Vec<Value> = cfg
        .get("connections")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    match action {
        "add" => {
            let id = format!("conn_{}", base36(now_ms()));
            let mut conn = json!({ "id": id, "testStatus": "idle", "provider": "openai-compatible" });
            let src = body.get("connection").cloned().unwrap_or_else(|| json!({}));
            conn = merge_obj(&conn, &src);
            if let Some(o) = conn.as_object_mut() {
                o.insert("id".into(), json!(id));
                let roles = o.get("roles").cloned().unwrap_or(Value::Null);
                o.insert("roles".into(), json!(normalize_roles(&roles)));
            }
            conns.push(conn);
            if active_id.is_null() {
                active_id = json!(id);
            }
        }
        "update" => {
            let bid = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let idx = conns.iter().position(|c| c.get("id").and_then(|v| v.as_str()) == Some(bid));
            let i = match idx {
                Some(i) => i,
                None => return (404, json!({ "error": "connection tidak ada" }).to_string()),
            };
            let mut upd = body.get("connection").cloned().unwrap_or_else(|| json!({}));
            let has_roles = upd.get("roles").is_some();
            if let Some(o) = upd.as_object_mut() {
                let empty_key = o
                    .get("apiKey")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().is_empty())
                    .unwrap_or(true);
                if empty_key {
                    if let Some(old) = conns[i].get("apiKey").cloned() {
                        o.insert("apiKey".into(), old);
                    }
                }
                if has_roles {
                    let roles = o.get("roles").cloned().unwrap_or(Value::Null);
                    o.insert("roles".into(), json!(normalize_roles(&roles)));
                }
            }
            let mut merged = merge_obj(&conns[i], &upd);
            if let Some(o) = merged.as_object_mut() {
                o.insert("id".into(), json!(bid));
            }
            conns[i] = merged;
        }
        "delete" => {
            let bid = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
            conns.retain(|c| c.get("id").and_then(|v| v.as_str()) != Some(bid));
            if active_id.as_str() == Some(bid) {
                active_id = conns.first().and_then(|c| c.get("id").cloned()).unwrap_or(Value::Null);
            }
        }
        "setActive" => {
            let bid = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if !conns.iter().any(|c| c.get("id").and_then(|v| v.as_str()) == Some(bid)) {
                return (404, json!({ "error": "connection tidak ada" }).to_string());
            }
            active_id = json!(bid);
        }
        "saveEvents" => {
            let ev = body.get("events").cloned().unwrap_or_else(|| json!({}));
            return match save_events(path, &ev) {
                Ok(out) => (200, json!({ "ok": true, "events": out }).to_string()),
                Err(e) => (500, json!({ "error": format!("gagal menyimpan: {e}") }).to_string()),
            };
        }
        "saveTTS" => {
            let tts = body.get("tts").cloned().unwrap_or_else(|| json!({}));
            return match save_tts(path, &tts) {
                Ok(mut t) => {
                    if let Some(o) = t.as_object_mut() {
                        let masked = o
                            .get("apiKey")
                            .and_then(|v| v.as_str())
                            .map(|k| if k.is_empty() { String::new() } else { mask_key(k) })
                            .unwrap_or_default();
                        o.insert("apiKey".into(), json!(masked));
                    }
                    (200, json!({ "ok": true, "tts": t }).to_string())
                }
                Err(e) => (500, json!({ "error": format!("gagal menyimpan: {e}") }).to_string()),
            };
        }
        "saveI18n" => {
            let i = body.get("i18n").cloned().unwrap_or_else(|| json!({}));
            return match save_i18n(path, &i) {
                Ok(out) => (200, json!({ "ok": true, "i18n": out }).to_string()),
                Err(e) => (500, json!({ "error": format!("gagal menyimpan: {e}") }).to_string()),
            };
        }
        "save" => {
            if let Some(arr) = body.get("connections").and_then(|v| v.as_array()) {
                conns = arr.clone();
            }
            if let Some(a) = body.get("activeId") {
                if !a.is_null() {
                    active_id = a.clone();
                }
            }
        }
        other => {
            return (400, json!({ "error": format!("action tidak dikenal: {other}") }).to_string());
        }
    }

    // cleanStr apiKey tiap koneksi (padanan loop akhir TS).
    for c in conns.iter_mut() {
        if let Some(o) = c.as_object_mut() {
            if let Some(k) = o.get("apiKey").and_then(|v| v.as_str()) {
                if !k.is_empty() {
                    o.insert("apiKey".into(), json!(clean_str(k)));
                }
            }
        }
    }
    let count = conns.len();
    match save_connections(path, conns, active_id.clone()) {
        Ok(()) => (
            200,
            json!({ "ok": true, "activeId": active_id, "connections": count }).to_string(),
        ),
        Err(e) => (500, json!({ "error": format!("gagal menyimpan: {e}") }).to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_key_seperti_ts() {
        assert_eq!(mask_key(""), "");
        assert_eq!(mask_key("MASUKKAN_API_KEY"), "MASUKKAN_API_KEY");
        assert_eq!(mask_key("sk-abcdefghijklmnop"), "sk-abc••••••••mnop");
    }

    #[test]
    fn roles_hanya_yang_dikenal_unik() {
        let r = json!(["chat", "CHAT", " Motion ", "bogus", "assistant"]);
        assert_eq!(normalize_roles(&r), vec!["chat", "motion", "assistant"]);
        assert_eq!(normalize_roles(&json!("bukan-array")), Vec::<String>::new());
    }

    #[test]
    fn load_backfill_default_saat_file_hilang() {
        let cfg = load(Path::new("/tak/ada/config.json"));
        // Default "auto": native dipakai bila modelnya tersedia, selain itu
        // klien jatuh ke mesin browser.
        assert_eq!(cfg["tts"]["provider"], "auto");
        assert_eq!(cfg["stt"]["provider"], "auto");
        assert_eq!(cfg["activeId"], Value::Null);
    }

    #[test]
    fn write_add_update_delete_setactive() {
        let dir = std::env::temp_dir().join(format!("l2dcfgw-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");

        // add → koneksi pertama jadi aktif, roles dinormalisasi
        let (st, _) = handle_config_post(&f, &json!({
            "action": "add",
            "connection": { "name": "x", "apiKey": "sk-abc", "roles": ["chat", "bogus"] }
        }));
        assert_eq!(st, 200);
        let cfg = load(&f);
        let id = cfg["connections"][0]["id"].as_str().unwrap().to_string();
        assert!(id.starts_with("conn_"));
        assert_eq!(cfg["activeId"], json!(id));
        assert_eq!(cfg["connections"][0]["roles"], json!(["chat"]));
        assert_eq!(cfg["connections"][0]["provider"], "openai-compatible");

        // update tanpa apiKey → key lama dipertahankan
        let (st2, _) = handle_config_post(&f, &json!({
            "action": "update", "id": id, "connection": { "name": "y", "apiKey": "" }
        }));
        assert_eq!(st2, 200);
        let cfg2 = load(&f);
        assert_eq!(cfg2["connections"][0]["name"], "y");
        assert_eq!(cfg2["connections"][0]["apiKey"], "sk-abc"); // lama dipertahankan

        // setActive ke id tak ada → 404
        let (st3, _) = handle_config_post(&f, &json!({ "action": "setActive", "id": "nope" }));
        assert_eq!(st3, 404);

        // delete → activeId jatuh ke null (koneksi habis)
        let (st4, _) = handle_config_post(&f, &json!({ "action": "delete", "id": id }));
        assert_eq!(st4, 200);
        let cfg3 = load(&f);
        assert_eq!(cfg3["connections"].as_array().unwrap().len(), 0);
        assert_eq!(cfg3["activeId"], Value::Null);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_save_tts_mask_dan_merge() {
        let dir = std::env::temp_dir().join(format!("l2dcfgt-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        let (st, body) = handle_config_post(&f, &json!({
            "action": "saveTTS", "tts": { "provider": "elevenlabs", "apiKey": "el-secretkey123" }
        }));
        assert_eq!(st, 200);
        let r: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(r["tts"]["apiKey"], "el-sec••••••••y123"); // balasan termask
        // file simpan key ASLI (bukan mask)
        let cfg = load(&f);
        assert_eq!(cfg["tts"]["apiKey"], "el-secretkey123");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn response_mask_apikey_koneksi() {
        // tulis config sementara
        let dir = std::env::temp_dir().join(format!("l2dcfgtest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        std::fs::write(
            &f,
            r#"{"activeId":"a","connections":[{"id":"a","apiKey":"sk-secretsecret1234","roles":["chat","bogus"]}],"tts":{"provider":"supertonic","apiKey":"tts-secretkey99"},"stt":{"provider":"openai","apiKey":"stt-secretkey77"}}"#,
        )
        .unwrap();
        let resp = api_config_response(&f);
        let c0 = &resp["connections"][0];
        assert_eq!(c0["apiKey"], "sk-sec••••••••1234"); // dimask
        assert_eq!(c0["roles"], json!(["chat"])); // bogus dibuang
        assert_eq!(resp["tts"]["apiKey"], "tts-se••••••••ey99"); // tts dimask
        assert_eq!(resp["stt"]["apiKey"], "stt-se••••••••ey77"); // stt dimask
        let _ = std::fs::remove_dir_all(&dir);
    }
}
