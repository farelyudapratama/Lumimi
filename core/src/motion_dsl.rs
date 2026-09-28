//! motion_dsl.rs — Sanitasi Motion Asset (port `sanitizeMotionAsset` dari
//! `src/client/animation/motion-dsl.ts`).
//!
//! Ini SATU-SATUNYA entrypoint sanitize di sisi server Rust: dipakai
//! `/api/motions/generate` dan `/api/motions` (PUT). Batas nilai per field
//! HARUS identik dengan motion-dsl klien (frontend TS tetap punya salinannya
//! untuk runtime player di browser — itu frontend, bukan runtime Bun).
//!
//! Catatan aturan repo: pembatasan "LLM tak boleh menyentuh id param langsung"
//! adalah untuk LLM PRODUK yang mengoperasikan karakter saat runtime — bukan
//! larangan mem-port logika sanitize ke server. Server tetap menyaring semua
//! tulisan motion lewat fungsi tunggal ini.

use serde_json::{json, Map, Value};

/// Batas nilai per field kanonik (semantic role limits). HARUS identik dengan
/// FIELD_BOUNDS `src/client/animation/motion-dsl.ts` (test server-parity).
pub(crate) fn field_bound(field: &str) -> Option<f64> {
    match field {
        "ax" | "ay" | "az" | "bodyX" | "bodyY" | "bodyZ" => Some(30.0),
        "ex" | "ey" | "mouthForm" | "browLY" | "browRY" | "browLF" | "browRF"
        | "smileL" | "smileR" | "mouthOpen" => Some(1.0),
        _ => None,
    }
}

/// Alias gaya SPEC → field internal.
fn role_alias(name: &str) -> Option<&'static str> {
    match name {
        "angleX" => Some("ax"),
        "angleY" => Some("ay"),
        "angleZ" => Some("az"),
        "eyeX" => Some("ex"),
        "eyeY" => Some("ey"),
        "bodyX" => Some("bodyX"),
        "bodyY" => Some("bodyY"),
        "bodyZ" => Some("bodyZ"),
        "mouthForm" => Some("mouthForm"),
        "mouthOpenY" => Some("mouthOpen"),
        "eyeLSmile" => Some("smileL"),
        "eyeRSmile" => Some("smileR"),
        "browLForm" => Some("browLF"),
        "browRForm" => Some("browRF"),
        _ => None,
    }
}

const KNOWN_REQUIRES: &[&str] = &["head", "eyes", "mouth", "body", "brow"];
const INTERP_MODES: &[&str] = &["linear", "ease-in", "ease-out", "ease-in-out", "stepped"];
const PARAM_ABS_MAX: f64 = 1e6;

// Batas (LIMITS TS).
const NAME_LEN: usize = 60;
const DESC_LEN: usize = 400;
const TAG_LEN: usize = 30;
const TAGS_MAX: usize = 10;
const DURATION_MIN: f64 = 0.1;
const DURATION_MAX: f64 = 20.0;
const KEYS_PER_TRACK_MAX: usize = 64;
const TRACKS_MAX: usize = 48;
const COOLDOWN_MAX: f64 = 600000.0;

/// Kanoniskan nama target track → field internal, atau None bila tak dikenal.
pub fn normalize_target(name: &str) -> Option<String> {
    let k = name.trim();
    if field_bound(k).is_some() {
        return Some(k.to_string());
    }
    role_alias(k).map(|s| s.to_string())
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

/// Ambil f64 dari Value (Number atau string numerik) — padanan Number(x).
fn num(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn to_fixed(v: f64, dp: i32) -> f64 {
    let f = 10f64.powi(dp);
    (v * f).round() / f
}

fn str_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn id_valid(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= 60 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Opsi sanitize (padanan opts TS).
#[derive(Default)]
pub struct SanitizeOpts {
    pub require_tracks: bool,
    pub source: Option<String>,
    pub source_model_id: Option<String>,
}

/// Sanitasi + normalisasi satu motion asset. Ok(asset) atau Err(daftar error).
pub fn sanitize_motion_asset(raw: &Value, opts: &SanitizeOpts) -> Result<Value, Vec<String>> {
    let mut errors: Vec<String> = Vec::new();
    let obj = match raw.as_object() {
        Some(o) => o,
        None => return Err(vec!["bukan objek motion".into()]),
    };

    let id = str_of(obj.get("id"));
    let id = id.trim().to_string();
    if !id_valid(&id) {
        errors.push("id tidak valid (1-60 karakter alfanumerik/_/-)".into());
    }
    let name_src = if str_of(obj.get("name")).trim().is_empty() { id.clone() } else { str_of(obj.get("name")).trim().to_string() };
    let name = take_chars(&name_src, NAME_LEN);

    // tags
    let mut tags: Vec<Value> = Vec::new();
    if let Some(tv) = obj.get("tags") {
        if !tv.is_null() {
            match tv.as_array() {
                None => errors.push("tags harus array".into()),
                Some(arr) => {
                    for t in arr.iter().take(TAGS_MAX) {
                        let s = take_chars(str_of(Some(t)).trim().to_lowercase().as_str(), TAG_LEN);
                        if !s.is_empty() {
                            tags.push(json!(s));
                        }
                    }
                }
            }
        }
    }

    // duration
    let mut duration = num(obj.get("duration")).unwrap_or(f64::NAN);
    if !duration.is_finite() || duration < DURATION_MIN {
        duration = 1.0;
    }
    duration = duration.min(DURATION_MAX);

    // intensity
    let intensity = {
        let iv = obj.get("intensity").and_then(|v| v.as_object());
        if let Some(io) = iv {
            let mn = num(io.get("min")).map(|x| clamp(x, 0.0, 1.0)).unwrap_or(0.3);
            let mx = num(io.get("max")).map(|x| clamp(x, 0.0, 1.0)).unwrap_or(1.0);
            let df = num(io.get("default")).map(|x| clamp(x, 0.0, 1.0)).unwrap_or(0.8);
            let lo = mn.min(mx);
            let hi = mn.max(mx);
            json!({ "min": lo, "max": hi, "default": clamp(df, lo, hi) })
        } else {
            json!({ "min": 0.3, "max": 1.0, "default": 0.8 })
        }
    };

    // emotionCompatibility
    let mut emo = Map::new();
    if let Some(eo) = obj.get("emotionCompatibility").and_then(|v| v.as_object()) {
        for (k, v) in eo {
            if let Some(n) = v.as_f64() {
                if n.is_finite() {
                    emo.insert(take_chars(k, 30), json!(clamp(n, 0.0, 1.0)));
                }
            }
        }
    }

    // cooldown / priority
    let mut cooldown = num(obj.get("cooldown")).unwrap_or(f64::NAN);
    if !cooldown.is_finite() || cooldown < 0.0 {
        cooldown = 0.0;
    }
    cooldown = cooldown.min(COOLDOWN_MAX);
    let mut priority = num(obj.get("priority")).unwrap_or(f64::NAN);
    if !priority.is_finite() {
        priority = 60.0;
    }
    priority = clamp(priority.round(), 0.0, 100.0);

    // requires
    let requires: Vec<Value> = obj
        .get("requires")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .map(|r| str_of(Some(r)).trim().to_lowercase())
                .filter(|r| KNOWN_REQUIRES.contains(&r.as_str()))
                .map(Value::from)
                .collect()
        })
        .unwrap_or_default();

    // tracks
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut tracks: Vec<Value> = Vec::new();
    if let Some(tv) = obj.get("tracks") {
        if !tv.is_null() {
            match tv.as_array() {
                None => errors.push("tracks harus array".into()),
                Some(arr) => {
                    for tr in arr.iter().take(TRACKS_MAX) {
                        let tro = tr.as_object();
                        let param_id = tro
                            .and_then(|o| o.get("param"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.trim())
                            .filter(|s| !s.is_empty())
                            .map(|s| take_chars(s, 120));
                        let is_param = param_id.is_some();
                        let (target, seen_key, bound, label): (Option<String>, String, f64, String) = if is_param {
                            let pid = param_id.clone().unwrap();
                            (None, format!("param:{pid}"), PARAM_ABS_MAX, pid)
                        } else {
                            let raw_target = tro.and_then(|o| o.get("target")).and_then(|v| v.as_str()).unwrap_or("");
                            match normalize_target(raw_target) {
                                None => {
                                    errors.push(format!("track target tidak dikenal: {raw_target}"));
                                    continue;
                                }
                                Some(t) => {
                                    let b = field_bound(&t).unwrap_or(1.0);
                                    (Some(t.clone()), format!("role:{t}"), b, t)
                                }
                            }
                        };
                        if seen.contains(&seen_key) {
                            continue;
                        }
                        seen.insert(seen_key);
                        let _ = label;

                        // keys
                        let mut keys: Vec<(f64, f64, Option<String>)> = Vec::new();
                        if let Some(karr) = tro.and_then(|o| o.get("keys")).and_then(|v| v.as_array()) {
                            for k in karr.iter().take(KEYS_PER_TRACK_MAX) {
                                let ko = k.as_object();
                                let t = num(ko.and_then(|o| o.get("t")));
                                let v = num(ko.and_then(|o| o.get("v")));
                                let (t, v) = match (t, v) {
                                    (Some(t), Some(v)) if t.is_finite() && v.is_finite() => (t, v),
                                    _ => continue,
                                };
                                if t < 0.0 || t > duration + 0.001 {
                                    continue;
                                }
                                let easing = ko
                                    .and_then(|o| o.get("easing"))
                                    .and_then(|v| v.as_str())
                                    .filter(|e| INTERP_MODES.contains(e))
                                    .map(String::from);
                                keys.push((to_fixed(t, 3), clamp(v, -bound, bound), easing));
                            }
                        }
                        keys.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                        // merge keyframe waktu-sama (yang terakhir menang)
                        let mut merged: Vec<(f64, f64, Option<String>)> = Vec::new();
                        for k in keys {
                            if let Some(last) = merged.last_mut() {
                                if last.0 == k.0 {
                                    *last = k;
                                    continue;
                                }
                            }
                            merged.push(k);
                        }
                        if merged.is_empty() {
                            continue;
                        }
                        let interp = tro
                            .and_then(|o| o.get("interp"))
                            .and_then(|v| v.as_str())
                            .filter(|i| INTERP_MODES.contains(i))
                            .unwrap_or("linear");
                        let intensity_scale = num(tro.and_then(|o| o.get("intensityScale"))).map(|x| clamp(x, 0.0, 2.0));
                        let keys_json: Vec<Value> = merged
                            .into_iter()
                            .map(|(t, v, e)| {
                                let mut kk = json!({ "t": t, "v": v });
                                if let Some(e) = e {
                                    kk["easing"] = json!(e);
                                }
                                kk
                            })
                            .collect();
                        if is_param {
                            let mut t = json!({ "kind": "param", "param": param_id.unwrap(), "interp": interp, "keys": keys_json });
                            let mn = num(tro.and_then(|o| o.get("min")));
                            let mx = num(tro.and_then(|o| o.get("max")));
                            if let (Some(mn), Some(mx)) = (mn, mx) {
                                t["min"] = json!(mn);
                                t["max"] = json!(mx);
                            }
                            if let Some(lbl) = tro.and_then(|o| o.get("label")).and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty()) {
                                t["label"] = json!(take_chars(lbl, 80));
                            }
                            tracks.push(t);
                        } else {
                            let mut t = json!({ "kind": "role", "target": target.unwrap(), "interp": interp, "keys": keys_json });
                            if let Some(sc) = intensity_scale {
                                t["intensityScale"] = json!(sc);
                            }
                            tracks.push(t);
                        }
                    }
                }
            }
        }
    }

    if opts.require_tracks && tracks.is_empty() {
        errors.push("minimal satu track keyframe diperlukan".into());
    }
    if !errors.is_empty() {
        return Err(errors);
    }

    let has_param_track = tracks.iter().any(|t| t.get("kind").and_then(|k| k.as_str()) == Some("param"));
    let source = obj.get("source").and_then(|v| v.as_str()).map(String::from).or_else(|| opts.source.clone()).unwrap_or_else(|| "user".into());
    let motion_type = obj
        .get("type")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| if tracks.is_empty() { "gesture".into() } else { "keyframe".into() });
    let ai_enabled = obj.get("aiEnabled").map(|v| v.as_bool() != Some(false)).unwrap_or(true);

    let mut asset = json!({
        "version": 1,
        "id": id,
        "name": name,
        "description": take_chars(str_of(obj.get("description")).trim(), DESC_LEN),
        "tags": tags,
        "source": source,
        "type": motion_type,
        "duration": to_fixed(duration, 3),
        "loop": obj.get("loop").and_then(|v| v.as_bool()).unwrap_or(false),
        "intensity": intensity,
        "emotionCompatibility": Value::Object(emo),
        "cooldown": cooldown,
        "priority": priority,
        "aiEnabled": ai_enabled,
        "requires": requires,
        "tracks": tracks,
    });
    let src_model = take_chars(
        obj.get("sourceModelId").and_then(|v| v.as_str()).map(String::from).or_else(|| opts.source_model_id.clone()).unwrap_or_default().trim(),
        200,
    );
    if !src_model.is_empty() {
        asset["sourceModelId"] = json!(src_model);
    }
    if has_param_track {
        asset["modelScoped"] = json!(true);
    }
    Ok(asset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_alias() {
        assert_eq!(normalize_target("angleX").as_deref(), Some("ax"));
        assert_eq!(normalize_target("ax").as_deref(), Some("ax"));
        assert!(normalize_target("ParamAngleX").is_none());
    }

    #[test]
    fn field_ekspresi_v2() {
        // Kosakata diperluas 2026-09-29: alias SPEC dikanoniskan, bound sesuai.
        assert_eq!(normalize_target("angleZ").as_deref(), Some("az"));
        assert_eq!(normalize_target("az").as_deref(), Some("az"));
        assert_eq!(normalize_target("browLY").as_deref(), Some("browLY"));
        assert_eq!(normalize_target("browLForm").as_deref(), Some("browLF"));
        assert_eq!(normalize_target("eyeLSmile").as_deref(), Some("smileL"));
        assert_eq!(normalize_target("mouthOpenY").as_deref(), Some("mouthOpen"));
        assert_eq!(normalize_target("mouthOpen").as_deref(), Some("mouthOpen"));
        assert_eq!(field_bound("az"), Some(30.0));
        assert_eq!(field_bound("mouthOpen"), Some(1.0));
        assert!(normalize_target("ParamEyeLOpen").is_none(), "kedip tetap di luar kosakata (milik blink framework)");
    }

    #[test]
    fn sanitize_field_ekspresi_clamp() {
        let raw = json!({
            "id": "kaget", "duration": 1.0,
            "tracks": [
                { "target": "browLY", "keys": [{ "t": 0, "v": 0 }, { "t": 0.4, "v": 5 }, { "t": 1.0, "v": 0 }] },
                { "target": "mouthOpenY", "keys": [{ "t": 0, "v": 0 }, { "t": 0.4, "v": 3 }, { "t": 1.0, "v": 0 }] }
            ]
        });
        let a = sanitize_motion_asset(&raw, &SanitizeOpts { require_tracks: true, ..Default::default() }).unwrap();
        assert_eq!(a["tracks"][0]["target"], "browLY");
        assert_eq!(a["tracks"][0]["keys"][1]["v"], 1.0); // clamp 5 → 1
        assert_eq!(a["tracks"][1]["target"], "mouthOpen");
        assert_eq!(a["tracks"][1]["keys"][1]["v"], 1.0); // clamp 3 → 1
    }

    #[test]
    fn sanitize_role_track_clamp_dan_sort() {
        let raw = json!({
            "id": "angguk",
            "duration": 1.4,
            "tracks": [
                { "target": "ay", "keys": [
                    { "t": 1.4, "v": 0 },
                    { "t": 0, "v": 999 },   // v di-clamp ke +30
                    { "t": 0.4, "v": 8 },
                    { "t": 99, "v": 5 }     // t > durasi → dibuang
                ]}
            ],
            "emotionCompatibility": { "senang": 2.0, "zzz": "x" }
        });
        let a = sanitize_motion_asset(&raw, &SanitizeOpts { require_tracks: true, ..Default::default() }).unwrap();
        assert_eq!(a["id"], "angguk");
        let keys = a["tracks"][0]["keys"].as_array().unwrap();
        assert_eq!(keys.len(), 3); // t=99 dibuang
        assert_eq!(keys[0]["t"], 0.0); // tersortir
        assert_eq!(keys[0]["v"], 30.0); // clamp ke bound
        // emotionCompatibility: nilai numerik di-clamp 0..1, non-numerik dibuang
        assert_eq!(a["emotionCompatibility"]["senang"], 1.0);
        assert!(a["emotionCompatibility"].get("zzz").is_none());
    }

    #[test]
    fn sanitize_tolak_id_dan_target_invalid() {
        let bad_id = sanitize_motion_asset(&json!({ "id": "spasi salah", "tracks": [] }), &SanitizeOpts::default());
        assert!(bad_id.is_err());
        let bad_target = sanitize_motion_asset(
            &json!({ "id": "x", "tracks": [{ "target": "ParamHairFront", "keys": [{ "t": 0, "v": 1 }] }] }),
            &SanitizeOpts { require_tracks: true, ..Default::default() },
        );
        assert!(bad_target.unwrap_err().iter().any(|e| e.contains("tidak dikenal")));
    }

    #[test]
    fn param_track_model_scoped() {
        let raw = json!({
            "id": "kedip_khusus",
            "duration": 1.0,
            "tracks": [{ "param": "ParamEyeLOpen", "keys": [{ "t": 0, "v": 1 }, { "t": 0.5, "v": 0 }], "min": 0, "max": 1 }]
        });
        let a = sanitize_motion_asset(&raw, &SanitizeOpts { require_tracks: true, source_model_id: Some("hana".into()), ..Default::default() }).unwrap();
        assert_eq!(a["modelScoped"], true);
        assert_eq!(a["sourceModelId"], "hana");
        assert_eq!(a["tracks"][0]["kind"], "param");
        assert_eq!(a["tracks"][0]["param"], "ParamEyeLOpen");
    }
}
