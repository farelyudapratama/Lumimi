//! Behavior decision layer — port SystemOne-style "keputusan terstruktur".
//! Role LLM "behavior": saat karakter idle, alih-alih memutar motion ACAK tiap
//! 7 detik (yang membuatnya terasa tanpa jiwa), layer ini meminta LLM memilih
//! SATU keputusan mikro yang bertipe & tervalidasi — mau apa berikutnya, mood
//! apa, arah pandang mana — dari kosakata yang HANYA berisi kemampuan nyata
//! model (Model-Agnostic: tak pernah mengarang id/nama/aksi di luar daftar).
//!
//! Ini bukan generator teks: outputnya keputusan (`{action, emotion, gaze,
//! motion, holdMs, confidence}`), analog endpoint `v1/systemone` (state +
//! pertanyaan → jawaban tertipe). Seam-nya sengaja sama dengan director.rs
//! (role routing + fallback aman + selalu 200), jadi backend keputusan lain
//! (mis. Jev/Laya lokal) bisa dicolok belakangan lewat koneksi role "behavior"
//! tanpa mengubah pemanggil.

use std::collections::HashSet;
use std::path::Path;

use serde_json::{json, Value};

use crate::{director, jsonx, llm};

/// Aksi idle bawaan (idle-safe, tanpa asumsi klip model). Dipakai bila caller
/// tidak mengirim daftar aksi. `settle` = tenang menghadap user; `gaze-shift` =
/// alih pandang disengaja lalu pulang; `micro-fidget` = gerak halus aditif.
const DEFAULT_ACTIONS: &[&str] = &["settle", "gaze-shift", "micro-fidget"];

/// Arah pandang bawaan (padanan kunci GAZE_INTENTS di app.js). Model-agnostic:
/// gaze digerakkan CubismTargetPoint, tak bergantung klip.
const DEFAULT_GAZES: &[&str] = &["face-user", "glance", "think", "lookaway-down", "up"];

/// Clamp f64 dengan guard non-finite → default.
fn clamp_f64(v: Option<f64>, lo: f64, hi: f64, default: f64) -> f64 {
    match v {
        Some(x) if x.is_finite() => x.clamp(lo, hi),
        _ => default,
    }
}

/// Ambil daftar string dari `caps[key]`; kosong/absen → `fallback`.
fn cap_strings(caps: &Value, key: &str, fallback: &[&str]) -> Vec<String> {
    caps.get(key)
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>())
        .filter(|v: &Vec<String>| !v.is_empty())
        .unwrap_or_else(|| fallback.iter().map(|s| s.to_string()).collect())
}

/// Keputusan fallback aman: diam menghadap user, tanpa klip, confidence 0.
fn fallback_decision() -> Value {
    json!({
        "action": "settle",
        "emotion": Value::Null,
        "gaze": "face-user",
        "motion": Value::Null,
        "holdMs": 2500,
        "confidence": 0.0,
        "note": ""
    })
}

/// Rangkai blok STATE yang dapat dibaca LLM dari snapshot `state`. Hanya key
/// yang dikenal dan bermakna yang dirender; angka mentah tetap apa adanya.
fn format_state(state: &Value) -> String {
    let obj = match state.as_object() {
        Some(o) => o,
        None => return "- (tidak ada data state)".into(),
    };
    let mut lines: Vec<String> = Vec::new();
    let secs = |ms: f64| (ms / 1000.0).round() as i64;
    if let Some(ms) = obj.get("idleMs").and_then(|v| v.as_f64()) {
        lines.push(format!("- Sudah {} detik sejak interaksi terakhir user.", secs(ms)));
    }
    if let Some(ms) = obj.get("lastActionMs").and_then(|v| v.as_f64()) {
        lines.push(format!("- Aksi idle terakhir {} detik lalu.", secs(ms)));
    }
    if let Some(m) = obj.get("mood").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        lines.push(format!("- Mood karakter sekarang: {m}.", m = director::sanitize_persona_text(&json!(m), 40)));
    }
    if let Some(m) = obj.get("cameraMood").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        lines.push(format!("- Kamera membaca ekspresi user: {m}.", m = director::sanitize_persona_text(&json!(m), 40)));
    }
    if let Some(t) = obj.get("timeOfDay").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        lines.push(format!("- Waktu: {t}.", t = director::sanitize_persona_text(&json!(t), 40)));
    }
    if lines.is_empty() {
        "- Karakter sedang idle, menunggu.".into()
    } else {
        lines.join("\n")
    }
}

/// Bangun prompt keputusan perilaku (System-One style: state + kosakata →
/// satu keputusan tertipe). LLM WAJIB memilih dari daftar, tak boleh mengarang.
fn build_prompt(
    state: &Value,
    actions: &[String],
    emotions: &[String],
    gazes: &[String],
    motions: &[Value],
    persona: &str,
    char_name: &str,
) -> String {
    let motion_block = if !motions.is_empty() {
        let lines = motions
            .iter()
            .take(24)
            .filter_map(|m| {
                let id = m.get("id").and_then(|v| v.as_str())?;
                let desc = m.get("description").and_then(|v| v.as_str()).unwrap_or(id);
                Some(format!("- {id}: {desc}"))
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!("Klip gerak idle-safe yang bisa dipilih (field \"motion\", id PERSIS, atau null):\n{lines}\n")
    } else {
        "Model ini tidak punya klip idle-safe; \"motion\" HARUS null.\n".to_string()
    };
    let name_line = if char_name.is_empty() {
        String::new()
    } else {
        format!("Karakter yang kamu kendalikan: {char_name}\n")
    };
    let persona_block = if persona.is_empty() {
        String::new()
    } else {
        format!("\nKEPRIBADIAN (ditulis user — keputusan harus konsisten dengan ini, jangan generik):\n{persona}\n")
    };

    format!(
        "Kamu adalah 'behavior director' untuk karakter Live2D yang hidup. Karakter\n\
sedang IDLE (tidak sedang bicara). Tugasmu: putuskan SATU perilaku mikro\n\
berikutnya supaya terasa punya maksud — bukan gerak acak. Diam yang tenang\n\
juga keputusan yang sah; jangan memaksa gerak tiap saat.\n{name_line}\n\
STATE SAAT INI:\n{state_block}\n\
{persona_block}\n\
PILIHAN (WAJIB pilih dari daftar; jangan mengarang):\n\
- action: [{actions}]\n\
- emotion: [{emotions}] (atau null bila mood tak perlu berubah)\n\
- gaze: [{gazes}] (atau null)\n\
{motion_block}\n\
Pertimbangkan state: makin lama idle boleh makin banyak inisiatif kecil;\n\
kalau baru saja beraksi, cenderung 'settle'. Cocokkan mood & gaze dengan\n\
kepribadian dan bacaan kamera bila ada.\n\n\
KEMBALIKAN HANYA satu objek JSON valid, tanpa markdown/pengantar, skema:\n\
{{ \"action\": \"<dari daftar>\", \"emotion\": \"<dari daftar atau null>\", \
\"gaze\": \"<dari daftar atau null>\", \"motion\": \"<id dari daftar atau null>\", \
\"holdMs\": <800-8000>, \"confidence\": <0.0-1.0>, \"note\": \"<alasan singkat>\" }}",
        name_line = name_line,
        state_block = format_state(state),
        persona_block = persona_block,
        actions = actions.join(", "),
        emotions = emotions.join(", "),
        gazes = gazes.join(", "),
        motion_block = motion_block,
    )
}

/// Cari koneksi SystemOne (provider "systemone") yang enabled dan melayani
/// role `behavior` (eksplisit lebih disukai; wildcard ikut). Return koneksi
/// pertama yang cocok, atau None → pakai jalur LLM chat biasa.
fn find_systemone_conn(config_path: &Path) -> Option<Value> {
    let cfg = crate::config::load(config_path);
    let conns = cfg.get("connections").and_then(|v| v.as_array())?;
    let is_enabled = |c: &Value| c.get("enabled").and_then(|v| v.as_bool()) == Some(true);
    let is_systemone = |c: &Value| {
        c.get("provider").and_then(|v| v.as_str()).map(|s| s.eq_ignore_ascii_case("systemone")).unwrap_or(false)
    };
    let serves = |c: &Value| crate::llm::conn_has_role(c, "behavior");
    let marks_behavior = |c: &Value| {
        crate::config::normalize_roles(&c.get("roles").cloned().unwrap_or(Value::Null))
            .iter()
            .any(|r| r == "behavior")
    };
    // Eksplisit ditandai role "behavior" menang atas wildcard.
    let mut wildcard: Option<Value> = None;
    for c in conns {
        if !is_systemone(c) || !is_enabled(c) {
            continue;
        }
        if marks_behavior(c) {
            return Some(c.clone());
        }
        if wildcard.is_none() && serves(c) {
            wildcard = Some(c.clone());
        }
    }
    wildcard
}

/// Bangun pertanyaan SystemOne dari kosakata capabilities. Return
/// (questions, emotions, gazes, motion_ids) — "none" ditambahkan sendiri di
/// map_answers, TIDAK di criteria (choicesSystemOne murni pilihan nyata).
fn build_questions(caps: &Value) -> (Value, Vec<String>, Vec<String>, Vec<String>) {
    let actions = cap_strings(caps, "actions", DEFAULT_ACTIONS);
    let gazes = cap_strings(caps, "gazes", DEFAULT_GAZES);
    let emotions: Vec<String> = caps
        .get("emotions")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let motion_ids: Vec<String> = caps
        .get("motions")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from)).collect())
        .unwrap_or_default();

    let mut q = serde_json::Map::new();
    // action: pilihan wajib — tanpa "none" (settle = diam, itu sudah none-nya).
    q.insert(
        "action".into(),
        json!({
            "type": "choice",
            "instructions": "Perilaku mikro berikutnya untuk karakter yang sedang idle.",
            "criteria": actions.iter().map(|a| (a.clone(), json!(null))).collect::<serde_json::Map<String, Value>>()
        }),
    );
    if !emotions.is_empty() {
        q.insert(
            "emotion".into(),
            json!({
                "type": "choice",
                "instructions": "Emosi yang cocok untuk perilaku ini berdasarkan state. Pilih yang paling pas; null berarti pertahankan mood saat ini.",
                "criteria": emotions.iter().map(|e| (e.clone(), json!(null))).collect::<serde_json::Map<String, Value>>()
            }),
        );
    }
    if !gazes.is_empty() {
        q.insert(
            "gaze".into(),
            json!({
                "type": "choice",
                "instructions": "Arah pandang yang alami untuk perilaku ini (gaze akan pulang menghadap user sendiri).",
                "criteria": gazes.iter().map(|g| (g.clone(), json!(null))).collect::<serde_json::Map<String, Value>>()
            }),
        );
    }
    if !motion_ids.is_empty() {
        q.insert(
            "motion".into(),
            json!({
                "type": "choice",
                "instructions": "Klip gerak idle-safe milik model yang paling cocok, bila perlu gerak tubuh.",
                "criteria": motion_ids.iter().map(|m| (m.clone(), json!(null))).collect::<serde_json::Map<String, Value>>()
            }),
        );
    }
    q.insert(
        "holdMs".into(),
        json!({
            "type": "score",
            "instructions": "Seberapa lama perilaku ini patut ditahan sebelum keputusan berikutnya?",
            "criteria": [
                "sangat singkat (~1 detik)",
                "singkat (~2 detik)",
                "sedang (~3,5 detik)",
                "lama (~5,5 detik)",
                "sangat lama (~8 detik)"
            ]
        }),
    );
    (Value::Object(q), emotions, gazes, motion_ids)
}

/// Petakan jawaban SystemOne ({answers:{k:{type,choice|noul|score,confidence}}})
/// ke keputusan mentah, lalu lewat validate() yang sama dengan jalur LLM —
/// jadi garansi kosakata + clamp HOLD identik di kedua mesin. Jawaban
/// tak ada / kunci tak dikenal → nilai default yang aman.
fn map_answers(
    answers: &Value,
    actions: &[String],
    emotions: &[String],
    gazes: &[String],
    motion_ids: &[String],
) -> Value {
    let get = |k: &str| answers.get(k);
    let action = get("action")
        .and_then(|a| a.get("choice"))
        .and_then(|v| v.as_str())
        .unwrap_or("settle")
        .to_string();
    let opt_choice = |k: &str| -> Option<String> {
        get(k)
            .and_then(|a| a.get("choice"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty() && *s != "none")
            .map(String::from)
    };
    let emotion = opt_choice("emotion").filter(|e| emotions.contains(e));
    let gaze = opt_choice("gaze").filter(|g| gazes.contains(g));
    let motion = opt_choice("motion").filter(|m| motion_ids.contains(m));
    let hold_raw = get("holdMs").and_then(|a| a.get("score")).and_then(|v| v.as_f64()).unwrap_or(1.4);
    let hold = 800.0 + (hold_raw.clamp(0.0, 4.0) / 4.0) * 7200.0;
    let confidence = get("action")
        .and_then(|a| a.get("confidence"))
        .and_then(|v| v.as_f64())
        .filter(|c| c.is_finite())
        .unwrap_or(0.5);
    let action_opts: HashSet<&str> = actions.iter().map(String::as_str).collect();
    let raw = json!({
        "action": if action_opts.contains(action.as_str()) { json!(action) } else { json!("settle") },
        "emotion": emotion,
        "gaze": gaze,
        "motion": motion,
        "holdMs": hold.round(),
        "confidence": confidence
    });
    let motions: Vec<Value> = motion_ids.iter().map(|id| json!({ "id": id })).collect();
    validate(&raw, actions, emotions, gazes, &motions)
}

/// POST /api/behavior/decide — kembalikan `{ decision, engine }`. `engine=false`
/// berarti TIDAK ada mesin keputusan yang dipakai (tak ada koneksi role
/// "behavior" eksplisit, atau panggilannya gagal) → pemanggil menjalankan siklus
/// motion deterministik lokal, bukan diam. `engine=true` = keputusan dari mesin:
/// koneksi SystemOne (Jev cloud / Laya lokal) bila ada, selain itu LLM role
/// "behavior". Selalu 200. Validasi ketat & Model-Agnostic: action/emotion/
/// gaze/motion di luar kosakata caller di-drop, tak diteruskan.
pub async fn handle_decide(config_path: &Path, body: &Value) -> Value {
    // Hanya jalan bila user MENANDAI koneksi ke role "behavior" secara eksplisit
    // (mis. Laya/Jev). Tanpa itu jangan membajak koneksi chat aktif untuk tick
    // periodik — biarkan klien bersiklus motion deterministik.
    if !llm::has_explicit_role(config_path, "behavior") {
        return json!({ "decision": Value::Null, "engine": false });
    }

    let caps = body.get("capabilities").cloned().unwrap_or(json!({}));
    let state = body.get("state").cloned().unwrap_or(json!({}));

    let actions = cap_strings(&caps, "actions", DEFAULT_ACTIONS);
    let gazes = cap_strings(&caps, "gazes", DEFAULT_GAZES);
    // emotions boleh kosong: berarti mood tak boleh diubah (tidak ada default).
    let emotions: Vec<String> = caps
        .get("emotions")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let motions: Vec<Value> = caps
        .get("motions")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter(|m| m.get("id").and_then(|i| i.as_str()).is_some()).cloned().collect())
        .unwrap_or_default();

    // Jalur native SystemOne (Jev cloud / Laya lokal) — diprioritaskan di atas
    // jalur LLM chat bila ada koneksi provider "systemone" yang melayani role
    // ini. Keputusan tetap lewat map_answers → validate: garansi kosakata +
    // clamp identik dengan jalur LLM.
    if let Some(conn) = find_systemone_conn(config_path) {
        let (questions, emo_opts, gaze_opts, motion_ids) = build_questions(&caps);
        return match llm::call_systemone(&conn, &state, &questions).await {
            Ok(resp) => {
                let answers = resp.get("answers").cloned().unwrap_or(json!({}));
                json!({
                    "decision": map_answers(&answers, &actions, &emo_opts, &gaze_opts, &motion_ids),
                    "engine": true,
                    "model": resp.get("model").cloned().unwrap_or(Value::Null)
                })
            }
            Err(e) => {
                // Mesin ada tapi gagal (jaringan/401/429) → serahkan ke siklus
                // deterministik klien; bawa pesan error untuk diagnostik UI.
                json!({ "decision": Value::Null, "engine": false, "error": e.message })
            }
        };
    }

    let persona = director::sanitize_persona_text(&body.get("persona").cloned().unwrap_or(Value::Null), 800);
    let char_name = director::sanitize_persona_text(&body.get("characterName").cloned().unwrap_or(Value::Null), 60);

    let prompt = build_prompt(&state, &actions, &emotions, &gazes, &motions, &persona, &char_name);
    let msgs = vec![llm::ChatMessage { role: "user".into(), content: prompt }];
    let reply = match llm::llm_for_role(config_path, "behavior", &msgs, "").await {
        Ok(ok) => ok.reply,
        // Mesin ada tapi panggilan gagal → serahkan ke siklus lokal (engine=false).
        Err(_) => return json!({ "decision": Value::Null, "engine": false }),
    };

    // Mesin membalas tapi bukan JSON objek → hormati mesin dengan keputusan aman.
    let parsed = match jsonx::extract_json_object_loose(&reply) {
        Some(v) => v,
        None => return json!({ "decision": fallback_decision(), "engine": true }),
    };
    json!({ "decision": validate(&parsed, &actions, &emotions, &gazes, &motions), "engine": true })
}

/// Validasi keputusan mentah LLM terhadap kosakata yang diizinkan. Nilai di luar
/// daftar di-drop (bukan diteruskan): action→"settle", emotion/gaze/motion→null.
fn validate(
    raw: &Value,
    actions: &[String],
    emotions: &[String],
    gazes: &[String],
    motions: &[Value],
) -> Value {
    let ok_action: HashSet<&str> = actions.iter().map(String::as_str).collect();
    let ok_emotion: HashSet<&str> = emotions.iter().map(String::as_str).collect();
    let ok_gaze: HashSet<&str> = gazes.iter().map(String::as_str).collect();
    let ok_motion: HashSet<&str> =
        motions.iter().filter_map(|m| m.get("id").and_then(|v| v.as_str())).collect();

    let action = raw
        .get("action")
        .and_then(|v| v.as_str())
        .filter(|a| ok_action.contains(a))
        .unwrap_or("settle")
        .to_string();
    let emotion = raw
        .get("emotion")
        .and_then(|v| v.as_str())
        .filter(|e| ok_emotion.contains(e))
        .map(String::from);
    let gaze = raw
        .get("gaze")
        .and_then(|v| v.as_str())
        .filter(|g| ok_gaze.contains(g))
        .map(String::from);
    let motion = raw
        .get("motion")
        .and_then(|v| v.as_str())
        .filter(|m| ok_motion.contains(m))
        .map(String::from);
    let hold_ms = clamp_f64(raw.get("holdMs").and_then(|v| v.as_f64()), 800.0, 8000.0, 2500.0).round();
    let confidence = clamp_f64(raw.get("confidence").and_then(|v| v.as_f64()), 0.0, 1.0, 0.5);
    let note = director::sanitize_persona_text(&raw.get("note").cloned().unwrap_or(Value::Null), 160);

    json!({
        "action": action,
        "emotion": emotion,
        "gaze": gaze,
        "motion": motion,
        "holdMs": hold_ms,
        "confidence": confidence,
        "note": note
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
    }

    #[test]
    fn validate_drop_di_luar_kosakata() {
        let actions = vec!["settle".to_string(), "gaze-shift".to_string()];
        let emotions = vec!["normal".to_string(), "senang".to_string()];
        let gazes = vec!["face-user".to_string(), "glance".to_string()];
        let motions = vec![json!({ "id": "lumine_idle" })];

        // Nilai valid dipertahankan.
        let ok = validate(
            &json!({ "action": "gaze-shift", "emotion": "senang", "gaze": "glance", "motion": "lumine_idle", "holdMs": 3000, "confidence": 0.8, "note": "melirik" }),
            &actions, &emotions, &gazes, &motions,
        );
        assert_eq!(ok["action"], "gaze-shift");
        assert_eq!(ok["emotion"], "senang");
        assert_eq!(ok["gaze"], "glance");
        assert_eq!(ok["motion"], "lumine_idle");
        assert_eq!(ok["holdMs"], 3000.0);
        assert_eq!(ok["confidence"], 0.8);

        // Nilai karangan di luar daftar di-drop, BUKAN diteruskan.
        let bad = validate(
            &json!({ "action": "backflip", "emotion": "murka", "gaze": "spin", "motion": "Param91", "holdMs": 99999, "confidence": 5 }),
            &actions, &emotions, &gazes, &motions,
        );
        assert_eq!(bad["action"], "settle"); // fallback aksi
        assert!(bad["emotion"].is_null());
        assert!(bad["gaze"].is_null());
        assert!(bad["motion"].is_null());
        assert_eq!(bad["holdMs"], 8000.0); // clamp atas
        assert_eq!(bad["confidence"], 1.0); // clamp atas
    }

    #[test]
    fn validate_holdms_confidence_non_finite_default() {
        let actions = vec!["settle".to_string()];
        let d = validate(&json!({ "action": "settle" }), &actions, &[], &[], &[]);
        assert_eq!(d["holdMs"], 2500.0);
        assert_eq!(d["confidence"], 0.5);
    }

    #[test]
    fn systemone_bangun_pertanyaan_dari_kosakata() {
        let caps = json!({
            "actions": ["settle", "idle-clip"],
            "emotions": ["normal", "senang"],
            "gazes": ["face-user", "glance"],
            "motions": [{ "id": "lumine_idle" }, { "id": "lumine_nod" }]
        });
        let (q, emo, gazes, mids) = build_questions(&caps);
        // action tanpa "none" — settle sudah mewakili diam.
        assert_eq!(q["action"]["type"], "choice");
        assert!(q["action"]["criteria"].get("settle").is_some());
        assert!(q["action"]["criteria"].get("none").is_none());
        // emotion/gaze/motion bertipe choice, holdMs bertipe score dgn 5 level.
        assert_eq!(q["emotion"]["criteria"].get("senang").is_some(), true);
        assert_eq!(q["gaze"]["criteria"].get("face-user").is_some(), true);
        assert_eq!(q["motion"]["criteria"].get("lumine_idle").is_some(), true);
        assert_eq!(q["holdMs"]["type"], "score");
        assert_eq!(q["holdMs"]["criteria"].as_array().unwrap().len(), 5);
        assert_eq!(emo.len(), 2);
        assert_eq!(gazes.len(), 2);
        assert_eq!(mids.len(), 2);

        // Tanpa emosi/motion → pertanyaannya TIDAK dibuat.
        let (q2, emo2, _, mids2) = build_questions(&json!({ "actions": ["settle"] }));
        assert!(q2.get("emotion").is_none());
        assert!(q2.get("motion").is_none());
        assert!(emo2.is_empty());
        assert!(mids2.is_empty());
    }

    #[test]
    fn systemone_petakan_jawaban_ke_keputusan_tervalidasi() {
        let actions = vec!["settle".to_string(), "idle-clip".to_string()];
        let emotions = vec!["normal".to_string(), "senang".to_string()];
        let gazes = vec!["face-user".to_string(), "glance".to_string()];
        let mids = vec!["lumine_idle".to_string()];

        // Jawaban lengkap: choice + score (boleh antar level) + confidence.
        let ans = json!({
            "action": { "type": "choice", "choice": "idle-clip", "confidence": 0.77 },
            "emotion": { "type": "choice", "choice": "senang", "probabilities": { "senang": 0.9 } },
            "gaze": { "type": "choice", "choice": "none" }, // "none" → null
            "motion": { "type": "choice", "choice": "lumine_idle" },
            "holdMs": { "type": "score", "score": 2.5, "legend": { "0": "s" } }
        });
        let d = map_answers(&ans, &actions, &emotions, &gazes, &mids);
        assert_eq!(d["action"], "idle-clip");
        assert_eq!(d["emotion"], "senang");
        assert!(d["gaze"].is_null(), "gaze 'none' harus null: {d}");
        assert_eq!(d["motion"], "lumine_idle");
        // score 2.5 dari 4 → 800 + (2.5/4)*7200 = 5300.
        assert_eq!(d["holdMs"], 5300.0);
        assert_eq!(d["confidence"], 0.77);

        // Jawaban kosong/kacau → default aman via validate.
        let d2 = map_answers(&json!({}), &actions, &emotions, &gazes, &mids);
        assert_eq!(d2["action"], "settle");
        assert!(d2["emotion"].is_null());
        assert!(d2["motion"].is_null());
        assert_eq!(d2["holdMs"], 800.0 + (1.4 / 4.0) * 7200.0); // default score 1.4

        // Choice di luar daftar di-drop.
        let d3 = map_answers(
            &json!({ "action": { "choice": "backflip" }, "motion": { "choice": "Param91" } }),
            &actions, &emotions, &gazes, &mids,
        );
        assert_eq!(d3["action"], "settle");
        assert!(d3["motion"].is_null());
    }

    #[test]
    fn systemone_koneksi_dicari_dari_config() {
        let dir = std::env::temp_dir().join(format!("l2dbhvso-{}", now()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");

        // Hanya mock (bukan systemone) → None.
        std::fs::write(&f, r#"{"connections":[{"id":"m","provider":"mock","roles":["behavior"]}]}"#).unwrap();
        assert!(find_systemone_conn(&f).is_none());

        // systemone enabled + role behavior eksplisit → Some.
        std::fs::write(&f, r#"{"connections":[{"id":"m","provider":"mock"},{"id":"s","provider":"systemone","roles":["behavior"],"baseUrl":"http://127.0.0.1:8000"}]}"#).unwrap();
        let c = find_systemone_conn(&f).unwrap();
        assert_eq!(c["id"], "s");

        // systemone disabled → None.
        std::fs::write(&f, r#"{"connections":[{"id":"s","provider":"systemone","roles":["behavior"],"enabled":false}]}"#).unwrap();
        assert!(find_systemone_conn(&f).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn format_state_render_detik() {
        let s = format_state(&json!({ "idleMs": 24000, "mood": "normal" }));
        assert!(s.contains("24 detik"), "state: {s}");
        assert!(s.contains("normal"), "state: {s}");
        // state kosong tetap menghasilkan kalimat aman.
        assert!(!format_state(&json!({})).is_empty());
    }

    #[tokio::test]
    async fn decide_tanpa_koneksi_behavior_eksplisit_engine_false() {
        let dir = std::env::temp_dir().join(format!("l2dbhv-{}-{}n", std::process::id(), now()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        // Koneksi mock TANPA role behavior eksplisit (wildcard) → jangan dibajak.
        std::fs::write(&f, r#"{"activeId":"m","connections":[{"id":"m","provider":"mock"}]}"#).unwrap();
        let out = handle_decide(&f, &json!({ "state": { "idleMs": 10000 } })).await;
        assert_eq!(out["engine"], false);
        assert!(out["decision"].is_null(), "tanpa mesin, decision harus null: {}", out);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn decide_engine_ada_reply_bukan_json_settle() {
        let dir = std::env::temp_dir().join(format!("l2dbhv-{}-{}e", std::process::id(), now()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        // Koneksi ditandai EKSPLISIT role "behavior" → mesin dipakai; reply mock
        // bukan objek JSON → keputusan aman 'settle', engine tetap true.
        std::fs::write(&f, r#"{"activeId":"m","connections":[{"id":"m","provider":"mock","roles":["behavior"]}]}"#).unwrap();
        let out = handle_decide(&f, &json!({ "state": { "idleMs": 10000 } })).await;
        assert_eq!(out["engine"], true);
        assert_eq!(out["decision"]["action"], "settle");
        assert_eq!(out["decision"]["confidence"], 0.0);
        assert!(out["decision"]["motion"].is_null());
        let _ = std::fs::remove_dir_all(&dir);
    }
}



