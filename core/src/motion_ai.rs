//! Endpoint LLM-role "motion": `/api/motions/analyze` (tebak makna satu motion
//! → deskripsi + tag + kompatibilitas emosi) dan `/api/motions/generate` (buat
//! motion dari teks). Echo-retry + validasi emosi + sanitize via motion_dsl.

use std::path::Path;

use serde_json::{json, Value};

use crate::{jsonx, llm};

const DEFAULT_EMOTIONS: &[&str] = &["senang", "sedih", "malu", "kaget", "normal"];

fn strip_fences(text: &str) -> String {
    text.replace("```json", "").replace("```JSON", "").replace("```", "").trim().to_string()
}

/// POST /api/motions/analyze — (status, body JSON). Selalu 200 kecuali input
/// invalid (400) / tak ada koneksi (503, ditangani llm_for_role → warning).
pub async fn analyze_motion(config_path: &Path, body: &Value) -> (u16, String) {
    let m = body.get("motion").cloned().unwrap_or(json!({}));
    let emotions: Vec<String> = body
        .get("emotions")
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty())
        .map(|a| a.iter().take(12).map(|x| x.as_str().unwrap_or("").to_string()).collect())
        .unwrap_or_else(|| DEFAULT_EMOTIONS.iter().map(|s| s.to_string()).collect());

    // tracks: {target, range[min,max], keyframes}
    struct Tr {
        target: String,
        lo: f64,
        hi: f64,
        keyframes: usize,
    }
    let mut tracks: Vec<Tr> = Vec::new();
    if let Some(arr) = m.get("tracks").and_then(|v| v.as_array()) {
        for tr in arr {
            let target = tr
                .get("label").and_then(|v| v.as_str())
                .or_else(|| tr.get("param").and_then(|v| v.as_str()))
                .or_else(|| tr.get("target").and_then(|v| v.as_str()))
                .or_else(|| tr.get("field").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            if target.is_empty() {
                continue;
            }
            let keys = tr.get("keys").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let vals: Vec<f64> = keys.iter().filter_map(|k| k.get("v").and_then(|v| v.as_f64())).collect();
            let (lo, hi) = if vals.is_empty() {
                (0.0, 0.0)
            } else {
                (vals.iter().cloned().fold(f64::INFINITY, f64::min), vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
            };
            tracks.push(Tr { target, lo, hi, keyframes: keys.len() });
        }
    }
    if tracks.is_empty() {
        return (400, json!({ "error": "motion tanpa track" }).to_string());
    }

    let duration = m.get("duration").and_then(|v| v.as_f64()).filter(|d| *d > 0.0).unwrap_or(1.0);
    let track_lines = tracks
        .iter()
        .map(|t| format!("- {}: rentang {}..{}, {} keyframe", t.target, t.lo, t.hi, t.keyframes))
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
        "Kamu menganalisa satu gerakan (motion) karakter Live2D.\n\
Data gerakan (peran semantik, bukan parameter mentah):\n\
durasi: {duration} detik\n{track_lines}\n\n\
Nama track bisa peran singkat atau nama parameter rig:\n\
ax=kepala kiri/kanan, ay=kepala atas/bawah, az=kepala miring, bodyZ=badan miring, bodyX/bodyY=badan geser,\n\
ex/ey=arah bola mata, mouthForm=bentuk mulut, mouthOpen=bukaan mulut, smileL/smileR=senyum mata,\n\
browLY/browRY=alis naik-turun, browLF/browRF=bentuk alis. Nama lain = parameter rig (tebak dari namanya).\n\
Baca rentang tiap track, jangan asumsikan derajat.\n\n\
TUGAS: tebak gerakan ini menyampaikan apa, lalu balas JSON:\n\
{{\n  \"description\": \"satu kalimat Indonesia, maks 120 karakter\",\n  \"tags\": [\"3-5 tag Indonesia satu kata\"],\n  \"emotionCompatibility\": {{ \"<emosi>\": 0.0-1.0 }}\n}}\n\
Emosi yang boleh HANYA: [{emo}]\n\
KEMBALIKAN HANYA JSON. MULAI dengan {{ dan AKHIRI dengan }}. JANGAN mengulang instruksi.",
        emo = emotions.join(", "),
    );

    let echoed = |clean: &str| -> bool {
        let low = clean.to_lowercase();
        low.contains("balas json") || low.contains("kamu menganalisa")
    };

    let msgs1 = vec![llm::ChatMessage { role: "user".into(), content: prompt.clone() }];
    let reply = match llm::llm_for_role(config_path, "motion", &msgs1, "").await {
        Ok(ok) => ok.reply,
        Err((_, msg)) => return (200, json!({ "warning": msg }).to_string()),
    };
    let mut clean = strip_fences(&reply);
    let mut parsed = jsonx::extract_json_object_loose(&reply);

    if parsed.is_none() || echoed(&clean) {
        let msgs2 = vec![
            llm::ChatMessage { role: "user".into(), content: prompt.clone() },
            llm::ChatMessage { role: "assistant".into(), content: clean.chars().take(2000).collect() },
            llm::ChatMessage {
                role: "user".into(),
                content: "Balasanmu tadi salah: kamu mengulang instruksi. Balas HANYA objek JSON {description, tags, emotionCompatibility} — mulai dengan { langsung.".into(),
            },
        ];
        if let Ok(ok2) = llm::llm_for_role(config_path, "motion", &msgs2, "").await {
            let p2 = jsonx::extract_json_object_loose(&ok2.reply);
            clean = strip_fences(&ok2.reply);
            if p2.is_some() {
                parsed = p2;
            } else if echoed(&clean) {
                parsed = None;
            }
        }
    }

    let parsed = match parsed {
        Some(p) => p,
        None => {
            let extra = if echoed(&clean) { " (model mengulang instruksi dua kali — coba lagi / pakai model lain)" } else { "" };
            return (200, json!({ "warning": format!("AI tidak mengembalikan JSON valid{extra}") }).to_string());
        }
    };

    let ok_emo: std::collections::HashSet<&str> = emotions.iter().map(String::as_str).collect();
    let mut emo = serde_json::Map::new();
    if let Some(ec) = parsed.get("emotionCompatibility").and_then(|v| v.as_object()) {
        for (k, v) in ec {
            if ok_emo.contains(k.as_str()) {
                if let Some(n) = v.as_f64() {
                    emo.insert(k.clone(), json!(n.clamp(0.0, 1.0)));
                }
            }
        }
    }
    let tags: Vec<String> = parsed
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .take(5)
                .filter_map(|t| t.as_str())
                .map(|s| s.trim().to_lowercase().chars().take(30).collect::<String>())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let description: String = parsed.get("description").and_then(|v| v.as_str()).unwrap_or("").trim().chars().take(200).collect();

    (200, json!({ "description": description, "tags": tags, "emotionCompatibility": emo, "source": "ai" }).to_string())
}

/// Blok konteks model untuk prompt generate — dari hasil analisis disk
/// (`motion_analysis::analyze`). Angka murni engine; LLM hanya menerima,
/// tidak pernah mengirim range. None = tak ada konteks berharga (tanpa
/// peta role atau tanpa data terobservasi).
fn model_context_block(analysis: &Value) -> Option<String> {
    if analysis.get("hasReference").and_then(|v| v.as_bool()) != Some(true) {
        return Some(
            "Konteks model ini: belum ada motion referensi di disk — pakai range konvensional yang realistis.".into(),
        );
    }
    let roles = analysis.get("roles").and_then(|v| v.as_object())?;
    if roles.is_empty() {
        return None;
    }
    let mut ranges: Vec<String> = Vec::new();
    let mut physics: Vec<String> = Vec::new();
    for (role, r) in roles {
        let lo = r.get("min").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let hi = r.get("max").and_then(|v| v.as_f64()).unwrap_or(0.0);
        ranges.push(format!("{role} {lo}..{hi}"));
        if r.get("physics").and_then(|v| v.as_bool()) == Some(true) {
            physics.push(role.clone());
        }
    }
    let mut lines = vec![
        "Konteks model ini (diukur engine dari motion milik model ini):".to_string(),
        format!("- amplitudo teramati: {}", ranges.join(", ")),
    ];
    if !physics.is_empty() {
        lines.push(format!(
            "- role terpetakan ke param output physics (jangan dipakai; gerakkan penyebabnya): {}",
            physics.join(", ")
        ));
    }
    Some(lines.join("\n"))
}

/// Bangun prompt generate. `ctx` (opsional) = blok konteks model yang
/// disisipkan sebelum bagian Aturan. Tanpa ctx, hasil byte-per-byte sama
/// dengan prompt lama (backward compat).
fn build_generate_prompt(desc: &str, emo: &str, ctx: Option<&str>) -> String {
    let base = format!(
        "Kamu membuat gerakan (motion) untuk karakter Live2D dari deskripsi user.\n\
Permintaan user: \"{desc}\"\n\n\
Kamu HANYA boleh memakai nama track berikut. Ini nama PERAN, bukan nama parameter\n\
model — klien yang akan menerjemahkannya ke parameter rig yang sesuai:\n\
ax    = kepala kiri(-)/kanan(+), derajat, batas ±30\n\
ay    = kepala atas(-)/bawah(+), derajat, batas ±30\n\
az    = kepala miring (tilt), derajat, batas ±30\n\
bodyZ = badan miring, derajat, batas ±30\n\
bodyX = badan geser kiri/kanan, derajat, batas ±30\n\
bodyY = badan naik/turun, derajat, batas ±30\n\
ex    = bola mata kiri(-)/kanan(+), −1..1\n\
ey    = bola mata atas(-)/bawah(+), −1..1\n\
mouthForm = bentuk mulut, −1..1\n\
mouthOpen = bukaan mulut, 0 = diam (default model), 1 = terbuka penuh\n\
smileL / smileR = senyum mata kiri/kanan, 0 = netral, 1 = senyum penuh\n\
browLY / browRY = alis kiri/kanan turun(-)/naik(+), −1..1\n\
browLF / browRF = bentuk alis kiri/kanan, -1 = mengernyut, +1 = terangkat\n\n\
Semua field mulai dan PULANG ke 0 (0 selalu pose istirahat, termasuk mouthOpen\n\
dan senyum mata). JANGAN menyebut nama parameter model seperti ParamAngleX\n\
atau ParamHairFront — kamu tidak tahu nama parameter rig ini dan menebaknya\n\
akan ditolak.\n\n\
Aturan:\n\
- Maksimal 4 track, maksimal 6 keyframe per track.\n\
- t dalam detik, mulai 0, tidak melebihi durasi.\n\
- Durasi 0.6 sampai 3 detik.\n\
- Gerakan yang bagus PULANG ke 0 di keyframe terakhir supaya tidak nyangkut.\n\
- Nilai realistis: ±5..15 derajat untuk kepala/badan, ±0.2..0.6 untuk bola mata,\n\
  0.2..0.8 untuk mulut/senyum mata, ±0.2..0.7 untuk alis.\n\n\
Balas JSON persis format ini:\n\
{{\n  \"id\": \"nama_id_snake_case\",\n  \"name\": \"Nama Singkat\",\n  \"description\": \"satu kalimat bahasa Indonesia\",\n  \"tags\": [\"dua-empat tag\"],\n  \"duration\": 1.4,\n  \"emotionCompatibility\": {{ \"<emosi>\": 0.0-1.0 }},\n  \"tracks\": [\n    {{ \"target\": \"ay\", \"keys\": [{{ \"t\": 0, \"v\": 0 }}, {{ \"t\": 0.4, \"v\": 8 }}, {{ \"t\": 1.4, \"v\": 0 }}] }}\n  ]\n}}\n\
Emosi yang boleh dipakai HANYA: [{emo}]\n\
KEMBALIKAN HANYA JSON. MULAI balasanmu langsung dengan {{ dan AKHIRI dengan }} — JANGAN mengulang instruksi ini.",
        desc = desc,
        emo = emo,
    );
    match ctx {
        None => base,
        Some(c) => match base.find("\nAturan:\n") {
            Some(i) => format!("{}\n\n{}\n\n{}", base[..i].trim_end(), c, &base[i + 1..]),
            None => base,
        },
    }
}

/// POST /api/motions/generate — buat motion dari deskripsi user (role "motion")
/// + echo-retry + sanitize (motion_dsl). Return (status, body JSON). Tidak
/// menulis ke disk — klien menerima {motion} lalu menyimpan lewat PUT.
///
/// Model-aware (opsional): bila body memuat `model` (nama folder model) dan
/// `roleMap` (peta role→paramId dari klien), server menganalisis motion
/// milik model dari disk dan menyisipkan konteks amplitudo/physics ke prompt.
pub async fn generate_motion(config_path: &Path, body: &Value) -> (u16, String) {
    let desc: String = body.get("prompt").and_then(|v| v.as_str()).unwrap_or("").trim().chars().take(300).collect();
    if desc.is_empty() {
        return (400, json!({ "error": "prompt kosong" }).to_string());
    }
    let emotions: Vec<String> = body
        .get("emotions")
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty())
        .map(|a| a.iter().take(12).map(|x| x.as_str().unwrap_or("").to_string()).collect())
        .unwrap_or_else(|| DEFAULT_EMOTIONS.iter().map(|s| s.to_string()).collect());

    // Konteks model-aware: analisis dari disk (angka hanya dari engine).
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let role_map = body.get("roleMap").filter(|v| v.is_object());
    let analysis = if model.is_empty() {
        None
    } else {
        let data_dir = config_path.parent();
        let model_dir = data_dir.map(|d| d.join("model"));
        match (data_dir, model_dir) {
            (Some(dd), Some(md)) => crate::motion_analysis::analyze(&md, dd, &model, role_map).ok(),
            _ => None,
        }
    };
    let ctx = analysis.as_ref().and_then(|a| model_context_block(a));

    let prompt = build_generate_prompt(&desc, &emotions.join(", "), ctx.as_deref());

    let echoed = |clean: &str| -> bool {
        let low = clean.to_lowercase();
        low.contains("balas json") || low.contains("permintaan user")
    };

    let msgs1 = vec![llm::ChatMessage { role: "user".into(), content: prompt.clone() }];
    let reply = match llm::llm_for_role(config_path, "motion", &msgs1, "").await {
        Ok(ok) => ok.reply,
        Err((_, msg)) => return (200, json!({ "error": msg }).to_string()),
    };
    let mut clean = strip_fences(&reply);
    let mut parsed = jsonx::extract_json_object_loose(&reply);

    if parsed.is_none() || echoed(&clean) {
        let msgs2 = vec![
            llm::ChatMessage { role: "user".into(), content: prompt.clone() },
            llm::ChatMessage { role: "assistant".into(), content: clean.chars().take(2000).collect() },
            llm::ChatMessage {
                role: "user".into(),
                content: "Balasanmu tadi salah: kamu mengulang instruksi. Balas HANYA objek JSON motion (id, name, duration, tracks, emotionCompatibility) — mulai dengan karakter { langsung, tanpa mengulang instruksi.".into(),
            },
        ];
        if let Ok(ok2) = llm::llm_for_role(config_path, "motion", &msgs2, "").await {
            let p2 = jsonx::extract_json_object_loose(&ok2.reply);
            clean = strip_fences(&ok2.reply);
            if p2.is_some() {
                parsed = p2;
            } else if echoed(&clean) {
                parsed = None;
            }
        }
    }

    let mut parsed = match parsed {
        Some(p) if p.is_object() => p,
        _ => {
            let extra = if echoed(&clean) { " (model mengulang instruksi dua kali — coba lagi / pakai model lain)" } else { "" };
            return (200, json!({ "error": format!("AI tidak mengembalikan JSON valid{extra}") }).to_string());
        }
    };

    // Self-fix satu putaran (pola loop agent): validator independen menandai
    // issue lalu LLM memperbaiki draftnya sendiri, dipilih hanya bila benar-benar
    // lebih baik. Inilah pembeda hasil Studio (dulu sekali-jalan) vs agent —
    // angka tetap dari engine, validator advisory, sanitize tetap gerbang akhir.
    parsed = refine_with_validator(config_path, parsed, analysis.as_ref(), &emotions.join(", ")).await;

    // Buang emosi di luar daftar; normalisasi id snake_case.
    let ok_emo: std::collections::HashSet<&str> = emotions.iter().map(String::as_str).collect();
    if let Some(ec) = parsed.get_mut("emotionCompatibility").and_then(|v| v.as_object_mut()) {
        ec.retain(|k, _| ok_emo.contains(k.as_str()));
    }
    let id_src = parsed.get("id").and_then(|v| v.as_str()).map(String::from).unwrap_or_else(|| desc.clone());
    let mut id: String = id_src
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    while id.contains("__") {
        id = id.replace("__", "_");
    }
    let id: String = id.trim_matches('_').chars().take(60).collect();
    let id = if id.is_empty() { "gerakan_ai".to_string() } else { id };
    parsed["id"] = json!(id);

    match crate::motion_dsl::sanitize_motion_asset(&parsed, &crate::motion_dsl::SanitizeOpts { require_tracks: true, source: Some("user".into()), ..Default::default() }) {
        Ok(asset) => (200, json!({ "motion": asset, "source": "ai" }).to_string()),
        Err(errs) => (200, json!({ "error": format!("hasil AI tidak valid: {}", errs.join("; ")) }).to_string()),
    }
}

/// Jumlah issue signifikan (error + warn) dari laporan validator. Info diabaikan
/// (quirk minor, bukan cacat gerak).
fn significant_issues(report: &Value) -> u64 {
    report.get("errorCount").and_then(|v| v.as_u64()).unwrap_or(0)
        + report.get("warnCount").and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Satu putaran self-fix: validator independen (`motion_validation`) menandai
/// issue → LLM role "motion" memperbaiki draftnya sendiri, meniru loop agent
/// (analyze→design→validate→self-fix). Draft hasil dipakai HANYA bila jumlah
/// issue signifikan berkurang; selain itu draft asli dipertahankan. Graceful:
/// tanpa issue / tanpa koneksi / JSON gagal → kembalikan draft apa adanya.
async fn refine_with_validator(config_path: &Path, draft: Value, analysis: Option<&Value>, emo: &str) -> Value {
    let report = crate::motion_validation::validate_asset(&draft, analysis);
    let before = significant_issues(&report);
    if before == 0 {
        return draft;
    }
    let lines: Vec<String> = report
        .get("issues")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|i| i["level"] == json!("error") || i["level"] == json!("warn"))
                .take(12)
                .map(|i| format!("- [{}] {}", i["code"].as_str().unwrap_or("?"), i["message"].as_str().unwrap_or("")))
                .collect()
        })
        .unwrap_or_default();
    if lines.is_empty() {
        return draft;
    }

    let draft_str: String = serde_json::to_string(&draft).unwrap_or_default().chars().take(2000).collect();
    let fix_prompt = format!(
        "Draft motion buatanmu diperiksa validator independen dan ada yang perlu diperbaiki.\n\n\
Draft sekarang (JSON):\n{draft_str}\n\n\
Masalah yang ditemukan:\n{issues}\n\n\
Perbaiki HANYA masalah di atas. Tetap pakai nama track PERAN (ax, ay, az, bodyX,\n\
bodyY, bodyZ, ex, ey, mouthForm, mouthOpen, smileL, smileR, browLY, browRY,\n\
browLF, browRF) — \
JANGAN menyebut nama parameter rig. Jaga nilai realistis (±5..15 derajat kepala/badan, ±0.2..0.6 mata) dan \
PULANG ke 0 di keyframe terakhir tiap track supaya gerakan tidak nyangkut. Emosi yang boleh HANYA: [{emo}].\n\
Balas HANYA objek JSON motion lengkap (id, name, description, tags, duration, emotionCompatibility, tracks) — \
mulai dengan {{ dan akhiri dengan }}. JANGAN mengulang instruksi ini.",
        draft_str = draft_str,
        issues = lines.join("\n"),
        emo = emo,
    );

    let msgs = vec![llm::ChatMessage { role: "user".into(), content: fix_prompt }];
    let reply = match llm::llm_for_role(config_path, "motion", &msgs, "").await {
        Ok(ok) => ok.reply,
        Err(_) => return draft,
    };
    let fixed = match jsonx::extract_json_object_loose(&reply) {
        Some(f) if f.is_object() => f,
        _ => return draft,
    };
    let after = significant_issues(&crate::motion_validation::validate_asset(&fixed, analysis));
    if after < before {
        fixed
    } else {
        draft
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn analyze_tanpa_track_400() {
        let dir = std::env::temp_dir().join(format!("l2dmai-{}-{}", std::process::id(), now()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        std::fs::write(&f, r#"{"activeId":"m","connections":[{"id":"m","provider":"mock"}]}"#).unwrap();
        let (st, _) = analyze_motion(&f, &json!({ "motion": { "tracks": [] } })).await;
        assert_eq!(st, 400);
        // ada track → mock echo → 200 warning (bukan crash)
        let (st2, body) = analyze_motion(&f, &json!({ "motion": { "duration": 1.2, "tracks": [{ "target": "ay", "keys": [{ "t": 0, "v": 0 }, { "t": 0.4, "v": 8 }] }] } })).await;
        assert_eq!(st2, 200);
        assert!(body.contains("warning") || body.contains("description"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prompt_tanpa_konteks_dan_dengan_konteks() {
        // Tanpa konteks: prompt lama utuh — tanpa blok Konteks, Aturan tetap ada.
        let p0 = build_generate_prompt("buat angguk", "senang, sedih", None);
        assert!(p0.starts_with("Kamu membuat gerakan (motion) untuk karakter Live2D dari deskripsi user.\n"));
        assert!(p0.contains("Permintaan user: \"buat angguk\""));
        assert!(p0.contains("Emosi yang boleh dipakai HANYA: [senang, sedih]"));
        assert!(p0.ends_with("JANGAN mengulang instruksi ini."));
        assert!(!p0.contains("Konteks model"));
        // Kosakata v2 (field ekspresi) wajib ada di prompt.
        assert!(p0.contains("az    = kepala miring"));
        assert!(p0.contains("mouthOpen = bukaan mulut"));
        assert!(p0.contains("smileL / smileR"));
        assert!(p0.contains("browLY / browRY"));
        assert!(p0.contains("Semua field mulai dan PULANG ke 0"));

        // Dengan konteks: blok disisipkan sebelum "Aturan:", aturan tetap utuh.
        let ctx = "Konteks model ini (diukur engine dari motion milik model ini):\n- amplitudo teramati: ax -30..20";
        let p1 = build_generate_prompt("buat angguk", "senang", Some(ctx));
        let i_ctx = p1.find(ctx).unwrap();
        let i_aturan = p1.find("\nAturan:\n").unwrap();
        assert!(i_ctx < i_aturan, "konteks harus sebelum Aturan");
        assert!(p1.contains("- Maksimal 4 track"));
        assert!(p1.contains("Konteks model"));
    }

    #[test]
    fn konteks_model_dari_analisis() {
        // Tanpa referensi → catatan fallback.
        let kosong = json!({ "hasReference": false, "roles": Value::Null });
        let c0 = model_context_block(&kosong).unwrap();
        assert!(c0.contains("belum ada motion referensi"));

        // Dengan roleMap terproyeksi → amplitudo + physics.
        let a = json!({
            "hasReference": true,
            "roles": {
                "ax": { "min": -30.0, "max": 20.0, "base": 0.0, "param": "P1", "physics": false },
                "ey": { "min": -1.0, "max": 1.0, "base": 0.0, "param": "P2", "physics": true }
            }
        });
        let c1 = model_context_block(&a).unwrap();
        assert!(c1.contains("amplitudo teramati"));
        assert!(c1.contains("ax -30..20"));
        assert!(c1.contains("ey -1..1"));
        assert!(c1.contains("output physics"));
        assert!(c1.contains("ey"));
        assert!(!c1.contains("P1") && !c1.contains("P2"), "nama param mentah tidak boleh bocor ke prompt");

        // Tanpa roles (klien tak kirim roleMap) → tanpa konteks.
        let a2 = json!({ "hasReference": true, "roles": Value::Null });
        assert!(model_context_block(&a2).is_none());
        let a3 = json!({ "hasReference": true, "roles": {} });
        assert!(model_context_block(&a3).is_none());
    }

    fn now() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
    }

    #[tokio::test]
    async fn refine_draft_bersih_dilewati() {
        // Draft mulai & pulang ke 0, dalam batas role → tanpa issue signifikan →
        // dikembalikan apa adanya tanpa memanggil LLM.
        let dir = std::env::temp_dir().join(format!("l2dref-{}-{}", std::process::id(), now()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        std::fs::write(&f, r#"{"activeId":"m","connections":[{"id":"m","provider":"mock"}]}"#).unwrap();
        let bersih = json!({
            "id": "angguk", "duration": 1.4,
            "tracks": [{ "target": "ay", "keys": [{ "t": 0, "v": 0 }, { "t": 0.4, "v": 8 }, { "t": 1.4, "v": 0 }] }]
        });
        let out = refine_with_validator(&f, bersih.clone(), None, "senang").await;
        assert_eq!(out, bersih, "draft bersih tidak boleh berubah");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn refine_gagal_perbaiki_pertahankan_asli() {
        // Draft dengan issue (nilai role di luar batas + tak pulang ke 0) → refine
        // memanggil LLM; mock tak bisa memperbaiki → draft asli dipertahankan
        // (tidak crash, tidak memburuk).
        let dir = std::env::temp_dir().join(format!("l2dref2-{}-{}", std::process::id(), now()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        std::fs::write(&f, r#"{"activeId":"m","connections":[{"id":"m","provider":"mock"}]}"#).unwrap();
        let kotor = json!({
            "id": "miring", "duration": 1.0,
            "tracks": [{ "target": "ax", "keys": [{ "t": 0, "v": 5 }, { "t": 1.0, "v": 45 }] }]
        });
        let before = significant_issues(&crate::motion_validation::validate_asset(&kotor, None));
        assert!(before > 0, "prasyarat: draft harus punya issue");
        let out = refine_with_validator(&f, kotor.clone(), None, "senang").await;
        assert!(out.is_object());
        assert_eq!(out.get("id").and_then(|v| v.as_str()), Some("miring"));
        let after = significant_issues(&crate::motion_validation::validate_asset(&out, None));
        assert!(after <= before, "refine tidak boleh memperburuk draft");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
