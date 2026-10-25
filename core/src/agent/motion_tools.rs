//! motion_tools.rs — Tool motion untuk agent bawaan.
//!
//! Memindahkan pola repo referensi (live2d-add-motion-sample-web-ui) ke
//! dalam produk: agent menganalisis model dari disk → mendesain track role
//! → memvalidasi (validator independen) → memperbaiki sendiri → menyimpan
//! (level "mutating", lewat kartu persetujuan).
//!
//! Kontrak loop: selalu return String, error diawali "ERROR: " (tanpa panic).
//! Angka hanya dari engine: analisis dihitung `motion_analysis` dari disk;
//! LLM hanya mendesain, tidak pernah mengirim range.

use std::path::Path;

use serde_json::{json, Value};

use crate::motion_analysis;
use crate::motion_dsl::{sanitize_motion_asset, SanitizeOpts};
use crate::motion_validation::validate_asset;

/// Eksekusi tool motion. `model`/`role_map` = state runtime agent (dikirim
/// panel saat start dari model aktif — peta role tetap sumber tunggal di
/// role-mapping.ts klien; Rust hanya melipat). `root` = app root (harness
/// browser). `cancel` = sinyal batal tugas (motion_verify meneruskannya ke
/// panggilan VLM supaya Stop terasa real-time). Kontrak loop: selalu return
/// String, error diawali "ERROR: ".
pub async fn exec(config_path: &Path, root: &Path, name: &str, args: &Value, model: &str, role_map: &Value, cancel: &tokio::sync::watch::Receiver<bool>) -> String {
    match name {
        "motion_analyze" => analyze(config_path, args, model, role_map),
        "motion_validate" => validate(config_path, args, model, role_map),
        "motion_save" => save(config_path, args, model, role_map),
        "motion_verify" => verify(config_path, root, args, model, role_map, Some(cancel)).await,
        other => format!("ERROR: tool motion tidak dikenal: {other}"),
    }
}

fn s_arg<'a>(args: &'a Value, k: &str) -> Option<&'a str> {
    args.get(k).and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty())
}

/// Identitas model target: arg > runtime > ERROR. Dikembalikan APA ADANYA
/// (key `currentModelKey()` dari klien), TANPA dipetakan ke nama folder —
/// karena penyimpanan motion (`data/motions/<key>/`) memakai key yang sama
/// dengan yang dibaca runtime & Motion Studio. Pemetaan ke folder `data/model/`
/// untuk analisis/render dilakukan di dalam `motion_analysis::analyze` dan
/// `motion_vision::verify` (resolve_model_folder), bukan di sini — kalau di sini
/// disamakan ke folder, motion tersimpan ke dir yang salah dan hilang dari UI.
fn resolve_model<'a>(_config_path: &Path, args: &'a Value, model: &'a str) -> Result<String, String> {
    if let Some(m) = s_arg(args, "model") {
        return Ok(m.to_string());
    }
    if !model.is_empty() {
        return Ok(model.to_string());
    }
    Err("model tidak diketahui — kirim arg \"model\" (nama folder model di data/model/) atau buka model dulu".into())
}

fn analyze_model(config_path: &Path, model: &str, role_map: &Value) -> Result<Value, String> {
    let data_dir = config_path.parent().ok_or_else(|| "config path tidak valid".to_string())?;
    let model_dir = data_dir.join("model");
    motion_analysis::analyze(&model_dir, data_dir, model, Some(role_map))
}

/// motion_analyze — laporan ringkas kemampuan motion model (role-level).
/// Detail param mentah sengaja diringkas: agent mendesain di role space,
/// dan history tool ter-clip 4000 karakter.
fn analyze(config_path: &Path, args: &Value, model: &str, role_map: &Value) -> String {
    let m = match resolve_model(config_path, args, model) {
        Ok(m) => m,
        Err(e) => return format!("ERROR: {e}"),
    };
    let a = match analyze_model(config_path, &m, role_map) {
        Ok(a) => a,
        Err(e) => return format!("ERROR: analisis gagal: {e}"),
    };

    let mut out = json!({
        "model": m,
        "motionCount": a.get("motionCount").cloned().unwrap_or(json!(0)),
        "hasReference": a.get("hasReference").cloned().unwrap_or(json!(false)),
    });
    // Role terproyeksi (range observasi + base + physics) — permukaan desain.
    if let Some(roles) = a.get("roles").cloned() {
        out["roles"] = roles;
    }
    // Physics outputs: daftar param yang DIDORONG fisika (★). Cap 30 agar
    // history tool tidak membengkak.
    if let Some(po) = a.get("physicsOutputs").and_then(|v| v.as_array()) {
        let list: Vec<Value> = po.iter().take(30).cloned().collect();
        out["physicsOutputs"] = json!(list);
        out["physicsOutputsTruncated"] = json!(po.len() > 30);
    }
    if let Some(params) = a.get("params").and_then(|v| v.as_object()) {
        out["paramObservedCount"] = json!(params.len());
    }
    out.to_string()
}

/// motion_validate — validasi draft Motion Asset (validator independen).
/// Agent dipandu memanggil ini SEBELUM motion_save dan mengoreksi issue.
fn validate(config_path: &Path, args: &Value, model: &str, role_map: &Value) -> String {
    let Some(draft) = args.get("motion") else {
        return "ERROR: kirim draft di arg \"motion\" (objek Motion Asset: id, duration, tracks)".into();
    };
    let analysis = match resolve_model(config_path, args, model) {
        Ok(m) => analyze_model(config_path, &m, role_map).ok(),
        Err(_) => None,
    };
    validate_asset(draft, analysis.as_ref()).to_string()
}

/// motion_save — simpan Motion Asset ke library user (data/motions/<model>/).
/// Level "mutating": sampai sini berarti user sudah menyetujui kartu izin.
/// Sanitize tetap gerbang akhir; 409 id duplikat dilaporkan agar agent
/// memakai id lain.
fn save(config_path: &Path, args: &Value, model: &str, _role_map: &Value) -> String {
    let Some(draft) = args.get("motion") else {
        return "ERROR: kirim draft di arg \"motion\" (objek Motion Asset lengkap)".into();
    };
    let m = match resolve_model(config_path, args, model) {
        Ok(m) => m,
        Err(e) => return format!("ERROR: {e}"),
    };
    // sourceModelId otomatis bila belum diisi.
    let mut draft = draft.clone();
    if draft.get("sourceModelId").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        draft["sourceModelId"] = json!(m);
    }
    let asset = match sanitize_motion_asset(&draft, &SanitizeOpts { require_tracks: true, source: Some("user".into()), source_model_id: Some(m.clone()) }) {
        Ok(a) => a,
        Err(errs) => return format!("ERROR: hasil draft tidak valid (panggil motion_validate dulu): {}", errs.join("; ")),
    };
    let id = asset.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let data_dir = match config_path.parent() {
        Some(d) => d.to_path_buf(),
        None => return "ERROR: config path tidak valid".into(),
    };
    let (st, body) = crate::motions::create_motion(&data_dir.join("motions"), &m, &id, &asset);
    if st == 200 {
        // Sapaan balik berisi ringkasan agar agent bisa melapor ke user.
        let n_tracks = asset.get("tracks").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        let dur = asset.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
        format!("OK: motion \"{id}\" tersimpan ({} track, {:.1}s) — tersedia untuk AI setelah model dimuat ulang atau di Motion Studio. Perhatian: validasi laporan sebelumnya dan sampaikan ringkasannya.", n_tracks, dur)
    } else if st == 409 {
        format!("ERROR: id \"{id}\" sudah dipakai — pilih id lain lalu ulangi motion_save")
    } else {
        format!("ERROR: simpan gagal ({st}): {body}")
    }
}

/// motion_verify — critic visual (PLAN-MOTION-PIPELINE 4d): render filmstrip
/// di harness → VLM role `motion-vision` menilai kecocokan intent + artefak.
/// Tanpa koneksi vision → verdict `{skipped:true}` (bukan gagal) berisi cara
/// mengaktifkan. Draft dari arg `motion` atau `motionId` (tersimpan).
/// `cancel` = Some untuk jalur agent (Stop menghentikan VLM seketika);
/// None untuk endpoint HTTP langsung.
async fn verify(config_path: &Path, root: &Path, args: &Value, model: &str, role_map: &Value, cancel: Option<&tokio::sync::watch::Receiver<bool>>) -> String {
    let m = match resolve_model(config_path, args, model) {
        Ok(m) => m,
        Err(e) => return format!("ERROR: {e}"),
    };
    let draft = if let Some(d) = args.get("motion") {
        Some(d.clone())
    } else if let Some(id) = s_arg(args, "motionId") {
        let data_dir = match config_path.parent() {
            Some(d) => d.to_path_buf(),
            None => return "ERROR: config path tidak valid".into(),
        };
        let (st, body) = crate::motions::get_motion(&data_dir.join("motions"), &m, id);
        if st != 200 {
            return format!("ERROR: motion \"{id}\" tidak ditemukan untuk model {m}");
        }
        serde_json::from_str::<Value>(&body).ok()
    } else {
        None
    };
    let Some(draft) = draft else {
        return "ERROR: kirim draft di arg \"motion\" atau id tersimpan di \"motionId\"".into();
    };
    let intent = s_arg(args, "intent").unwrap_or("").to_string();
    match crate::motion_vision::verify(config_path, root, &m, role_map, &draft, &intent, cancel).await {
        Ok(v) => v.to_string(),
        Err(e) => format!("ERROR: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }

    /// Fixture model + config.json (mock provider) di temp dir.
    fn fixture(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let data = std::env::temp_dir().join(format!(
            "l2dmt-{}-{}-{}",
            tag,
            std::process::id(),
            crate::config::base36_pub(now())
        ));
        let m = data.join("model").join("hana");
        std::fs::create_dir_all(&m).unwrap();
        std::fs::create_dir_all(m.join("motions")).unwrap();
        std::fs::write(
            m.join("motions").join("m1.motion3.json"),
            r#"{"Meta":{"Duration":1.0},"Curves":[{"Target":"Parameter","Id":"ParamAngleX","Segments":[0,0, 0,0.5,-12, 0,1.0,0]}]}"#,
        )
        .unwrap();
        let cfg = data.join("config.json");
        std::fs::write(&cfg, r#"{"activeId":"m","connections":[{"id":"m","provider":"mock"}]}"#).unwrap();
        (cfg, data)
    }

    const ROLE_MAP: &str = r#"{"ax":"ParamAngleX"}"#;

    /// Receiver batal netral untuk test (sinyal tak pernah menyala).
    fn no_cancel() -> tokio::sync::watch::Receiver<bool> {
        tokio::sync::watch::channel(false).1
    }

    #[tokio::test]
    async fn analyze_melaporkan_role_dan_physics() {
        let (cfg, data) = fixture("analyze");
        let args = json!({});
        let out = exec(&cfg, &data, "motion_analyze", &args, "hana", &serde_json::from_str(ROLE_MAP).unwrap(), &no_cancel()).await;
        assert!(out.contains("\"hasReference\":true"), "{out}");
        assert!(out.contains("ParamAngleX"), "{out}");
        assert!(out.contains("\"param\":\"ParamAngleX\""), "{out}");
        // Tanpa model dikenal → ERROR (bukan panic).
        let out2 = exec(&cfg, &data, "motion_analyze", &json!({}), "", &Value::Null, &no_cancel()).await;
        assert!(out2.starts_with("ERROR"), "{out2}");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn validate_melaporkan_issue_dan_base_return() {
        let (cfg, data) = fixture("validate");
        let draft = json!({
            "id": "angguk", "duration": 1.0,
            "tracks": [{ "target": "ax", "keys": [
                { "t": 0, "v": 0 }, { "t": 0.5, "v": 40 }, { "t": 1.0, "v": 8 }
            ]}]
        });
        let out = exec(&cfg, &data, "motion_validate", &json!({ "motion": draft }), "hana", &serde_json::from_str(ROLE_MAP).unwrap(), &no_cancel()).await;
        // 40 > 30 → clamp; 8 ≠ 0 di keyframe terakhir → base_return; range model ini kecil.
        assert!(out.contains("role_clamp"), "{out}");
        assert!(out.contains("base_return"), "{out}");
        assert!(out.contains("out_of_observed_range"), "{out}");
        // Draft kosong → ERROR.
        let out2 = exec(&cfg, &data, "motion_validate", &json!({}), "hana", &Value::Null, &no_cancel()).await;
        assert!(out2.starts_with("ERROR"), "{out2}");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn save_tersimpan_dan_tolak_duplikat() {
        let (cfg, data) = fixture("save");
        let draft = json!({
            "id": "angguk", "name": "Angguk", "duration": 1.0,
            "tracks": [{ "target": "ay", "keys": [{ "t": 0, "v": 0 }, { "t": 0.4, "v": 10 }, { "t": 1.0, "v": 0 }] }]
        });
        let out = exec(&cfg, &data, "motion_save", &json!({ "motion": draft }), "hana", &Value::Null, &no_cancel()).await;
        assert!(out.starts_with("OK"), "{out}");
        // File benar-benar ada di data/motions/hana/.
        assert!(data.join("motions").join("hana").join("angguk.motion.json").exists());
        // Duplikat → 409 → ERROR dengan arahan id lain.
        let out2 = exec(&cfg, &data, "motion_save", &json!({ "motion": draft }), "hana", &Value::Null, &no_cancel()).await;
        assert!(out2.contains("sudah dipakai"), "{out2}");
        // Draft invalid (tanpa track) → ditolak sanitize.
        let out3 = exec(&cfg, &data, "motion_save", &json!({ "motion": { "id": "kosong", "duration": 1.0, "tracks": [] } }), "hana", &Value::Null, &no_cancel()).await;
        assert!(out3.starts_with("ERROR"), "{out3}");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn verify_tanpa_draft_dan_model_tidak_kenal() {
        let (cfg, data) = fixture("verify");
        // Tanpa motion/motionId → ERROR.
        let out = exec(&cfg, &data, "motion_verify", &json!({}), "hana", &Value::Null, &no_cancel()).await;
        assert!(out.starts_with("ERROR"), "{out}");
        // Model tidak dikenal → ERROR (sebelum menyentuh browser).
        let out2 = exec(&cfg, &data, "motion_verify", &json!({ "motion": { "id": "x", "duration": 1.0, "tracks": [] } }), "tidak_ada", &Value::Null, &no_cancel()).await;
        assert!(out2.starts_with("ERROR"), "{out2}");
        let _ = std::fs::remove_dir_all(&data);
    }
}
