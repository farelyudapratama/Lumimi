//! motion_probe.rs — backlog Fase 2: probe canvas runtime penuh.
//!
//! Sweep satu/lebih parameter model di harness (halaman yang sama dengan
//! critic visual): drive patch → settle physics → capture sinkron → metrik diff
//! piksel dihitung sisi harness. Untuk param yang TIDAK mati, frame sweep
//! dikirim ke LLM role `motion-vision` untuk cross-check attribution
//! (region/sign/safe range) — bukan pengganti role-mapping, melainkan
//! EVIDENSA tambahan untuk param unclassified.
//!
//! Jalurnya sama dengan motion_vision (CDP → harness-motion.html); endpoint
//! ini lapisan di atasnya. Tanpa koneksi vision → field `skipped` per param
//! (degrade anggun; metrik piksel tetap hasil).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::llm::{self, LlmImage};
use crate::{browser, jsonx, motion_analysis, rig_report, motion_vision};

const MAX_PARAMS: usize = 6; // sweep boros waktu; cap tiap panggilan
const HARNESS_READY_POLLS: usize = 60;
const VISION_FRAMES: usize = 3; // min/mid/max (frame 0 = default, bukan kandidat gambar)

fn round3(v: f64) -> String {
    format!("{:.3}", v)
}

/// Prompt attribution probe: VLM melihat frame sweep (bukan default) dan
/// menjawab region/arah/range aman. Deterministik — param + nilai saja.
pub fn build_probe_prompt(param: &str, values: &[f64]) -> String {
    let frames: Vec<String> = values
        .iter()
        .enumerate()
        .map(|(i, v)| format!("F{}: parameter dinaikkan ke nilai {}", i + 1, round3(*v)))
        .collect();
    format!(
        "Kamu penganalisa rig karakter Live2D.\n\
Parameter \"{param}\" disweep dari nilai default ke beberapa nilai (frame berurutan \
berikut; bandingkan dengan pose default awal yang tidak disertakan).\n\
{frames}\n\n\
Tugas: tentukan region tubuh yang BERUBAH karena parameter ini, dan arah efek nilainya.\n\n\
Balas HANYA objek JSON:\n\
{{ \"region\": \"kepala|mata|mulut|badan|rambut|tangan|lainnya|tidak_terlihat\", \"sign\": -1|0|1, \"safeRange\": [min, max], \"confidence\": 0.0-1.0, \"notes\": \"maksimal satu kalimat bahasa Indonesia\" }}\n\n\
sign = arah efek nilai positif (1 = ke arah yang tampak di frame terakhir, -1 = berlawanan, 0 = tak pasti).\n\
safeRange = rentang nilai yang masih tampak wajar (bukan ekstrem yang merusak bentuk).",
        param = param,
        frames = frames.join("\n"),
    )
}

/// Parse loose jawaban VLM probe (JSON di tengah teks pun ditampung; sampah
/// tetap diawetkan ke `raw` supaya terlihat).
pub fn parse_probe_vision(reply: &str) -> Value {
    let parsed = jsonx::extract_json_object_loose(reply).unwrap_or(Value::Null);
    let region = parsed
        .get("region")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let sign = parsed.get("sign").and_then(|v| v.as_i64()).map(|s| s.clamp(-1, 1));
    let safe: Option<Vec<f64>> = parsed
        .get("safeRange")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_f64()).take(2).collect::<Vec<f64>>())
        .filter(|v| v.len() == 2 && v[0] <= v[1]);
    let mut out = json!({
        "ok": parsed.is_object(),
        "region": if region.is_empty() { "tidak_terlihat".to_string() } else { region },
        "confidence": parsed.get("confidence").and_then(|v| v.as_f64()).map(|c| c.clamp(0.0, 1.0)),
        "notes": parsed.get("notes").and_then(|v| v.as_str()).unwrap_or("").trim().chars().take(300).collect::<String>(),
        "raw": if parsed.is_object() { Value::Null } else { json!(reply.chars().take(400).collect::<String>()) },
    });
    if let Some(s) = sign {
        out["sign"] = json!(s);
    }
    if let Some(sr) = safe {
        out["safeRange"] = json!(sr);
    }
    out
}

/// POST /api/model/probe {model, params?: [paramId]} — sweep param di harness.
/// `params` kosong → default: daftar param unclassified dari rig report
/// (evidensa role-mapping). Return JSON {ok, model, params:[…]}.
pub async fn probe(config_path: &Path, root: &Path, body: &Value) -> (u16, String) {
    let model_raw = body.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if model_raw.is_empty() {
        return (400, json!({ "error": "model tidak diketahui" }).to_string());
    }
    let data_dir: PathBuf = match config_path.parent() {
        Some(d) => d.to_path_buf(),
        None => return (500, json!({ "error": "config path tidak valid" }).to_string()),
    };

    // Identitas klien bisa berupa currentModelKey() (path disanitasi) —
    // resolve ke folder nyata dulu (pola yang sama dengan motion_vision).
    let model = motion_analysis::resolve_model_folder(&data_dir.join("model"), &model_raw)
        .unwrap_or_else(|| model_raw.clone());
    let m3 = match crate::model::find_model3(&data_dir.join("model").join(&model), 0) {
        Some(m) => m,
        None => return (404, json!({ "error": format!("model3 tidak ditemukan untuk \"{model}\"") }).to_string()),
    };
    let rel = match crate::expressions::rel_fwd(&data_dir, &m3) {
        Some(r) => r,
        None => return (500, json!({ "error": "path model tidak valid" }).to_string()),
    };

    // Daftar param: dari body, atau fallback unclassified rig report.
    let mut params: Vec<String> = body
        .get("params")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    params.retain(|p| !p.trim().is_empty());
    if params.is_empty() {
        if let Ok(rr) = rig_report::analyze(&data_dir.join("model"), &data_dir, &model) {
            params = rr
                .get("unclassified")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            params.sort();
        }
    }
    params.truncate(MAX_PARAMS);
    if params.is_empty() {
        return (200, json!({ "ok": true, "model": model, "params": [], "note": "tidak ada param unclassified untuk disweep" }).to_string());
    }

    // 1) Harness di origin loopback milik server sendiri (aman → allow_private).
    let harness_url = format!("http://127.0.0.1:{}/harness-motion.html", crate::server_port());
    if let Err(e) = browser::open(root, &harness_url, true).await {
        return (500, json!({ "error": e }).to_string());
    }
    if let Err(e) = motion_vision::wait_ready(HARNESS_READY_POLLS).await {
        return (502, json!({ "error": e }).to_string());
    }

    // 2) Muat model TANPA asset — pose murni dari drive patch probe.
    let payload = json!({ "model": rel, "asset": Value::Null });
    if let Err(e) = browser::evaluate(&format!("window.__motionHarness.load({})", payload)).await {
        return (502, json!({ "error": format!("harness load gagal: {e}") }).to_string());
    }

    // 3) Sweep tiap param di harness (drive → settle → capture → metrik diff).
    let mut results: Vec<Value> = Vec::new();
    let mut sweep_frames: Vec<Vec<Value>> = Vec::new();
    for param in &params {
        let js = format!("window.__motionHarness.probe({})", serde_json::to_string(param).unwrap_or_default());
        let item = match browser::evaluate(&js).await {
            Ok(res) => {
                let val = res.get("value").cloned().unwrap_or(Value::Null);
                if val.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                    let frames = val.get("frames").cloned().unwrap_or(json!([]));
                    sweep_frames.push(frames.as_array().cloned().unwrap_or_default());
                    // Metrik untuk klien: tanpa dataUrl (besar; sudah dikonsumsi di sini).
                    let mut metrics: Vec<Value> = frames.as_array().cloned().unwrap_or_default();
                    for f in metrics.iter_mut() {
                        if let Some(o) = f.as_object_mut() {
                            o.remove("dataUrl");
                        }
                    }
                    json!({
                        "paramId": param,
                        "dead": val.get("dead").and_then(|v| v.as_bool()).unwrap_or(true),
                        "range": val.get("range").cloned().unwrap_or(Value::Null),
                        "metrics": metrics,
                        "vision": Value::Null,
                    })
                } else {
                    sweep_frames.push(Vec::new());
                    json!({
                        "paramId": param,
                        "error": val.get("error").and_then(|v| v.as_str()).unwrap_or("probe gagal"),
                    })
                }
            }
            Err(e) => {
                sweep_frames.push(Vec::new());
                json!({ "paramId": param, "error": e })
            }
        };
        results.push(item);
    }

    // 4) Cross-check VLM (role motion-vision) untuk param yang TIDAK mati —
    //    frame sweep yang benar-benar mengubah piksel dikirim sebagai gambar.
    for (i, item) in results.iter_mut().enumerate() {
        if item.get("error").is_some() {
            continue;
        }
        let dead = item.get("dead").and_then(|v| v.as_bool()).unwrap_or(true);
        if dead {
            continue;
        }
        let frames = &sweep_frames[i];
        let mut images: Vec<LlmImage> = Vec::new();
        let mut values: Vec<f64> = Vec::new();
        for f in frames.iter().skip(1).take(VISION_FRAMES) {
            let data_url = f.get("dataUrl").and_then(|v| v.as_str());
            let v = f.get("v").and_then(|v| v.as_f64());
            if let (Some(du), Some(v)) = (data_url, v) {
                if let Some(d) = du.strip_prefix("data:image/jpeg;base64,") {
                    images.push(LlmImage { mime: "image/jpeg".into(), data: d.to_string() });
                    values.push(v);
                }
            }
        }
        if images.is_empty() {
            continue;
        }
        let param_id = item.get("paramId").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let prompt = build_probe_prompt(&param_id, &values);
        let system = "Kamu penganalisa rig karakter Live2D. Balas HANYA objek JSON tanpa penjelasan lain.";
        item["vision"] = match llm::llm_for_vision(config_path, system, &prompt, &images).await {
            Ok(ok) => {
                let mut v = parse_probe_vision(&ok.reply);
                v["usedConnection"] = json!(ok.used);
                v
            }
            Err((400, msg)) => json!({
                "skipped": true,
                "reason": msg,
                "hint": "tandai satu koneksi dengan role motion-vision di panel Koneksi AI (model harus mendukung input gambar)",
            }),
            Err((st, msg)) => json!({ "skipped": true, "reason": format!("LLM vision error ({st}): {msg}") }),
        };
    }

    (200, json!({ "ok": true, "model": model, "params": results }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_probe_memuat_param_dan_nilai() {
        let p = build_probe_prompt("ParamHairSway", &[0.0, -30.0, 0.0, 30.0]);
        assert!(p.contains("ParamHairSway"), "{p}");
        assert!(p.contains("F1:"), "{p}");
        assert!(p.contains("nilai -30.000"), "{p}");
        assert!(p.contains("\"region\""), "{p}");
        assert!(p.contains("\"safeRange\""), "{p}");
        assert!(p.contains("\"sign\""), "{p}");
        // Prompt selalu menaruh instruksi JSON-only di akhir.
        assert!(p.contains("HANYA objek JSON"), "{p}");
    }

    #[test]
    fn vision_probe_loose_dan_sampah_ditolak() {
        let v = parse_probe_vision(
            "{\"region\":\"kepala\",\"sign\":1,\"safeRange\":[-15,15],\"confidence\":0.8,\"notes\":\"miring kanan\"}",
        );
        assert_eq!(v["ok"], true);
        assert_eq!(v["region"], "kepala");
        assert_eq!(v["sign"], 1);
        assert_eq!(v["safeRange"], json!([-15.0, 15.0]));
        assert_eq!(v["confidence"], json!(0.8));
        assert_eq!(v["notes"], "miring kanan");

        // Sampah bukan JSON → raw diawetkan.
        let v2 = parse_probe_vision("tidak ada json sama sekali di sini");
        assert_eq!(v2["ok"], false);
        assert!(v2["raw"].as_str().unwrap().contains("tidak ada json"));

        // safeRange terbalik dibuang (bukan diteruskan mentah-mentah).
        let v3 = parse_probe_vision("{\"region\":\"mata\",\"safeRange\":[5,-5]}");
        assert!(v3.get("safeRange").is_none());
        assert_eq!(v3["region"], "mata");

        // Region kosong → fallback tidak_terlihat.
        let v4 = parse_probe_vision("{\"confidence\":0.3}");
        assert_eq!(v4["region"], "tidak_terlihat");
        // sign di luar rentang di-clamp.
        let v5 = parse_probe_vision("{\"region\":\"mulut\",\"sign\":9}");
        assert_eq!(v5["sign"], 1);
    }
}
