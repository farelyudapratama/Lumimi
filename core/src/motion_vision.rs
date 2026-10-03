//! motion_vision.rs — Critic visual (PLAN-MOTION-PIPELINE 4d).
//!
//! Orkestrasi verifikasi visual motion: buka halaman harness render
//! (`static/harness-motion.html`) di browser terkelola → muat model + Motion
//! Asset → seek ke N waktu → screenshot per frame → kirim filmstrip ke LLM
//! role `motion-vision` → verdict JSON terstruktur.
//!
//! Privasi: yang dikirim = render canvas model Live2D (aset milik user),
//! BUKAN frame webcam — aturan "webcam tak pernah di-upload" tidak tersentuh.
//!
//! Tanpa koneksi bertanda `motion-vision` → verdict `{skipped:true}` dengan
//! cara mengaktifkan (degrade anggun; jalur numerik tetap jalan).

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use crate::llm::{self, LlmImage};
use crate::{browser, jsonx};

const DETAIL_FRAMES: usize = 8; // tubuh atas (wajah/kepala) — detail halus
const FULL_FRAMES: usize = 3; // seluruh model (termasuk kaki) — menyeluruh
// Kualitas JPEG frame ditentukan sisi harness TS (toDataURL "image/jpeg", 0.72).

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// N waktu frame merata termasuk 0 dan `duration` (murni, test).
pub fn frame_times(duration: f64, count: usize) -> Vec<f64> {
    let n = count.max(2);
    let d = duration.max(0.1);
    (0..n)
        .map(|i| ((d * i as f64) / (n as f64 - 1.0) * 1000.0).round() / 1000.0)
        .collect()
}

/// Waktu frame SADAR-KEYFRAME: grid merata `cap` titik DISISIPI semua t
/// keyframe asset (puncak osilasi tak boleh terlewat — pelajaran uji tilt:
/// puncak t=0.9 di antara frame 0.8/1.0 tak tersampel). Bila union meluber
/// dari cap, sampel merata dari union (endpoint 0 & duration dijamin ikut).
pub fn frame_times_from_asset(duration: f64, asset: &Value, cap: usize) -> Vec<f64> {
    let d = duration.max(0.1);
    let mut ts = frame_times(d, cap);
    if let Some(tracks) = asset.get("tracks").and_then(|v| v.as_array()) {
        for tr in tracks {
            if let Some(keys) = tr.get("keys").and_then(|v| v.as_array()) {
                for k in keys {
                    if let Some(t) = k.get("t").and_then(|v| v.as_f64()) {
                        if t.is_finite() && t >= 0.0 && t <= d + 1e-6 {
                            ts.push(round3(t));
                        }
                    }
                }
            }
        }
    }
    ts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut uniq: Vec<f64> = Vec::new();
    for t in ts {
        if uniq.last().map(|p| (t - *p).abs() > 0.02).unwrap_or(true) {
            uniq.push(t);
        }
    }
    if uniq.len() <= cap {
        return uniq;
    }
    let n = uniq.len();
    (0..cap)
        .map(|i| uniq[i * (n - 1) / (cap - 1)])
        .collect()
}

/// Prompt penilai untuk VLM (murni, test). Dua grup frame berlabel eksplisit
/// (U = tubuh atas/wajah, F = seluruh model) agar model tidak tertukar
/// (pola PLAN 2d).
pub fn build_judge_prompt(intent: &str, detail: &[f64], full: &[f64], duration: f64) -> String {
    let mut lines = vec![
        "Kamu menilai motion karakter Live2D dari dua grup frame berurutan.".to_string(),
        format!("Intent gerakan: \"{intent}\"."),
        format!("Durasi motion: {duration:.2} detik."),
        "Grup U (U1..Un) = TUBUH ATAS close-up (kepala/wajah/dada) — nilai detail ekspresi & arah gerak halus di sini.".to_string(),
        "Grup F (F1..Fn) = SELURUH MODEL (kepala sampai kaki) — nilai gerakan menyeluruh, proporsi, dan artefak mesh di bagian mana pun (termasuk kaki/rok/aksesoris).".to_string(),
        "Waktu frame:".to_string(),
    ];
    for (i, t) in detail.iter().enumerate() {
        lines.push(format!("- U{}: t={:.2}s", i + 1, t));
    }
    for (i, t) in full.iter().enumerate() {
        lines.push(format!("- F{}: t={:.2}s", i + 1, t));
    }
    lines.push(
        "Tugas:\n\
1. LIHAT tiap frame grup U satu per satu dan catat posisi kepala/arah pandang dalam \"perFrame\" (satu frasa pendek per frame, contoh \"U1: kepala tegak, pandangan lurus\").\n\
2. \"playing\": BANDINGKAN frame — apakah pose berubah antar frame (motion bergerak, bukan diam di pose dasar)?\n\
3. \"matchesIntent\": apakah gerakan sesuai intent?\n\
4. \"artifacts\": daftar artefak visual bila ada (mesh menembus, ekspresi patah, bagian tubuh hilang/berubah aneh, di grup mana pun).\n\
5. \"notes\": satu kalimat untuk manusia.\n\
Balas HANYA JSON persis: {\"perFrame\": [\"U1: …\", \"U2: …\"], \"playing\": true|false, \"matchesIntent\": true|false, \"artifacts\": [\"…\"], \"notes\": \"…\", \"confidence\": 0.0-1.0}"
            .to_string(),
    );
    lines.join("\n")
}

/// Parse verdict longgar dari balasan VLM (echo/dogfest tetap ditolak lewat
/// `ok:false`).
pub fn parse_verdict(reply: &str) -> Value {
    let parsed = jsonx::extract_json_object_loose(reply).unwrap_or(Value::Null);
    let get_bool = |k: &str| parsed.get(k).and_then(|v| v.as_bool());
    let artifacts: Vec<String> = parsed
        .get("artifacts")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .take(10)
                .collect()
        })
        .unwrap_or_default();
    // Deskripsi per-frame (chain-of-thought ringan) — opsional, hanya
    // diteruskan bila model mengisinya.
    let per_frame: Vec<String> = parsed
        .get("perFrame")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .take(16)
                .collect()
        })
        .unwrap_or_default();
    let mut verdict = json!({
        "ok": parsed.is_object(),
        "playing": get_bool("playing"),
        "matchesIntent": get_bool("matchesIntent"),
        "artifacts": artifacts,
        "notes": parsed.get("notes").and_then(|v| v.as_str()).unwrap_or("").trim().chars().take(300).collect::<String>(),
        "confidence": parsed.get("confidence").and_then(|v| v.as_f64()).map(|c| c.clamp(0.0, 1.0)),
        // Balasan bukan-JSON dipotong supaya agent/user tetap bisa melihat apa
        // yang dikatakan model (mis. model menolak gambar).
        "raw": if parsed.is_object() { Value::Null } else { json!(reply.chars().take(400).collect::<String>()) },
    });
    if !per_frame.is_empty() {
        verdict["perFrame"] = json!(per_frame);
    }
    verdict
}

async fn wait_ready(timeout_polls: usize) -> Result<(), String> {
    for _ in 0..timeout_polls {
        let res = browser::evaluate(
            "JSON.stringify(window.__motionHarness ? window.__motionHarness.state() : {ready:false, booting:true})",
        ).await;
        if let Ok(r) = res {
            if let Some(s) = r.get("value").and_then(|v| v.as_str()) {
                if let Ok(j) = serde_json::from_str::<Value>(s) {
                    if j.get("ready").and_then(|v| v.as_bool()) == Some(true) {
                        return Ok(());
                    }
                    if let Some(e) = j.get("error").and_then(|v| v.as_str()) {
                        if !e.is_empty() {
                            return Err(format!("harness error: {e}"));
                        }
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("harness tidak siap (timeout)".into())
}

/// Verifikasi visual lengkap. Return verdict JSON (atau `{skipped:true}`).
/// `motion` = Motion Asset (draft/tersimpan), `role_map` opsional untuk
/// migrasi role di harness.
pub async fn verify(
    config_path: &Path,
    root: &Path,
    model: &str,
    role_map: &Value,
    motion: &Value,
    intent: &str,
) -> Result<Value, String> {
    if model.is_empty() {
        return Err("model tidak diketahui — buka model dulu atau kirim arg \"model\"".into());
    }
    let data_dir = config_path.parent().ok_or("config path tidak valid")?;
    // Identitas dari klien bisa berupa key `currentModelKey()` (path disanitasi),
    // bukan nama folder — resolve ke folder nyata dulu.
    let model = crate::motion_analysis::resolve_model_folder(&data_dir.join("model"), model)
        .unwrap_or_else(|| model.to_string());
    let m3 = crate::model::find_model3(&data_dir.join("model").join(&model), 0)
        .ok_or_else(|| format!("model3 tidak ditemukan untuk \"{model}\""))?;
    let rel = crate::expressions::rel_fwd(data_dir, &m3).ok_or("path model tidak valid")?;
    let duration = motion.get("duration").and_then(|v| v.as_f64()).unwrap_or(1.0).clamp(0.1, 20.0);
    let detail_times = frame_times_from_asset(duration, motion, DETAIL_FRAMES);
    let full_times = frame_times(duration, FULL_FRAMES);

    // 1) Harness di origin loopback milik server sendiri (aman → allow_private).
    let harness_url = format!("http://127.0.0.1:{}/harness-motion.html", crate::server_port());
    browser::open(root, &harness_url, true).await?;
    wait_ready(60).await?;

    // 2) Muat model + asset (roleMap dikirim; migrasi role terjadi di harness).
    let payload = json!({ "model": rel, "asset": motion, "roleMap": role_map });
    let loaded = browser::evaluate(&format!("window.__motionHarness.load({})", payload)).await?;
    if let Some(e) = loaded.get("value").and_then(|v| v.get("error")) {
        if !e.as_str().unwrap_or("").is_empty() {
            return Err(format!("harness load gagal: {}", e.as_str().unwrap_or("")));
        }
    }

    // 3) Filmstrip dua framing, render + capture SINKRON per frame
    //    (canvas.toDataURL — rAF/kompositor tidak dilibatkan; jendela boleh
    //    ter-occlude: screenshot permukaan CDP akan frame basi).
    //    U = crop tubuh atas dari capture penuh (detail halus),
    //    F = seluruh model + margin (kaki, proporsi, artefak).
    let mut images: Vec<LlmImage> = Vec::new();
    for &t in &detail_times {
        images.push(snap_frame(t, "upper").await?);
    }
    for &t in &full_times {
        images.push(snap_frame(t, "full").await?);
    }

    // 4) VLM (role motion-vision; tanpa koneksi → skipped, bukan gagal).
    let prompt = build_judge_prompt(intent, &detail_times, &full_times, duration);
    let system = "Kamu penilai visual motion karakter Live2D. Balas HANYA objek JSON tanpa penjelasan lain.";
    match llm::llm_for_vision(config_path, system, &prompt, &images).await {
        Ok(ok) => {
            let mut verdict = parse_verdict(&ok.reply);
            verdict["model"] = json!(model);
            verdict["usedConnection"] = json!(ok.used);
            verdict["framesUpper"] = json!(detail_times);
            verdict["framesFull"] = json!(full_times);
            verdict["skipped"] = json!(false);
            Ok(verdict)
        }
        Err((400, msg)) => Ok(json!({
            "skipped": true,
            "reason": msg,
            "hint": "tandai satu koneksi dengan role motion-vision di panel Koneksi AI (model harus mendukung input gambar)",
        })),
        Err((st, msg)) => Err(format!("LLM vision error ({st}): {msg}")),
    }
}

/// Snap satu frame: render eksplisit di t + capture JPEG (base64) dari canvas.
/// `mode` = "upper" (crop kepala/wajah) atau "full" (seluruh model).
async fn snap_frame(t: f64, mode: &str) -> Result<LlmImage, String> {
    let res = browser::evaluate(&format!(
        "window.__motionHarness.snap({t}, \"{mode}\")"
    ))
    .await?;
    let data_url = res
        .get("value")
        .and_then(|v| v.get("dataUrl"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            let err = res
                .get("value")
                .and_then(|v| v.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or("tanpa detail");
            format!("snap gagal: {err}")
        })?;
    let data = data_url
        .strip_prefix("data:image/jpeg;base64,")
        .ok_or_else(|| "dataUrl bukan jpeg base64".to_string())?;
    Ok(LlmImage { mime: "image/jpeg".into(), data: data.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waktu_frame_merata_dan_ujung() {
        let t = frame_times(2.0, 8);
        assert_eq!(t.len(), 8);
        assert_eq!(t[0], 0.0);
        assert_eq!(t[7], 2.0);
        assert!(t.windows(2).all(|w| w[1] > w[0]), "harus menaik");
        // Durasi kecil tetap sah.
        assert_eq!(frame_times(0.1, 4).len(), 4);
    }

    #[test]
    fn waktu_frame_sadar_keyframe() {
        // Puncak osilasi di t=0.9 WAJIB tersampel (pelajaran uji tilt:
        // grid merata 0.2s melewatkannya).
        let asset = json!({
            "duration": 1.4,
            "tracks": [{ "target": "az", "keys": [
                { "t": 0, "v": 0 }, { "t": 0.4, "v": -28 }, { "t": 0.9, "v": 20 }, { "t": 1.4, "v": 0 }
            ]}]
        });
        let t = frame_times_from_asset(1.4, &asset, 8);
        assert_eq!(t[0], 0.0);
        assert_eq!(*t.last().unwrap(), 1.4);
        assert!(t.contains(&0.9), "puncak keyframe harus ada: {t:?}");
        assert!(t.contains(&0.4), "{t:?}");
        // Cap: union melebihi cap → sampel merata, endpoint tetap.
        let banyak = json!({
            "duration": 10.0,
            "tracks": [{ "keys": [
                { "t": 1.0, "v": 1 }, { "t": 2.0, "v": 1 }, { "t": 3.0, "v": 1 },
                { "t": 4.0, "v": 1 }, { "t": 5.0, "v": 1 }, { "t": 6.0, "v": 1 },
                { "t": 7.0, "v": 1 }, { "t": 8.0, "v": 1 }, { "t": 9.0, "v": 1 }
            ]}]
        });
        let t2 = frame_times_from_asset(10.0, &banyak, 6);
        assert_eq!(t2.len(), 6);
        assert_eq!(t2[0], 0.0);
        assert_eq!(*t2.last().unwrap(), 10.0);
        // Tanpa keyframe sama dengan grid merata.
        let kosong = frame_times_from_asset(2.0, &json!({}), 8);
        assert_eq!(kosong, frame_times(2.0, 8));
    }

    #[test]
    fn prompt_memuat_intent_dua_grup_framing() {
        let p = build_judge_prompt("miring kiri", &[0.0, 0.9, 1.4], &[0.0, 1.4], 1.4);
        assert!(p.contains("miring kiri"));
        assert!(p.contains("U1: t=0.00s"));
        assert!(p.contains("U2: t=0.90s"));
        assert!(p.contains("F1: t=0.00s"));
        assert!(p.contains("TUBUH ATAS"));
        assert!(p.contains("SELURUH MODEL"));
        assert!(p.contains("\"playing\""));
        assert!(p.contains("\"matchesIntent\""));
    }

    #[test]
    fn verdict_json_loose_dan_sampah_ditolak() {
        let v = parse_verdict(r#"oke. {"playing": true, "matchesIntent": false, "artifacts": ["mesh tembus"], "notes": "kurang jelas", "confidence": 1.7}"#);
        assert_eq!(v["ok"], true);
        assert_eq!(v["playing"], true);
        assert_eq!(v["matchesIntent"], false);
        assert_eq!(v["artifacts"][0], "mesh tembus");
        assert_eq!(v["confidence"], 1.0); // di-clamp

        // Echo instruksi / teks polos → ok:false + raw dipotong.
        let v2 = parse_verdict("Balas HANYA JSON persis: {\"playing\"…");
        assert_eq!(v2["ok"], false);
        assert!(v2["raw"].as_str().unwrap().len() <= 400);
    }
}
