//! motion_validation.rs — Validator independen untuk draft Motion Asset.
//!
//! Pola repo referensi (validate_motions.py dipisah dari generator): pemeriksaan
//! berlapis atas draft SEBELUM disimpan, supaya agent/studio bisa mengoreksi
//! desainnya sendiri:
//! 1. struktural — gerbang otoritatif `motion_dsl::sanitize_motion_asset`
//!    (error = asset akan DITOLAK saat simpan);
//! 2. kualitas raw — kejadian yang disanitasi diam-diam (keyframe di luar
//!    durasi, tak terurut, nilai di-clamp) dilaporkan sebagai warn/info agar
//!    tidak hilang tanpa jejak;
//! 3. semantik vs `motion_analysis` — nilai di luar range observasi, target
//!    output physics (★ jangan dianimasikan langsung), dan kepatuhan base
//!    pose (track role mulai & pulang ke 0).
//!
//! Sifatnya ADVISORY: tidak menggantikan sanitize saat simpan.

use serde_json::{json, Value};

use crate::motion_dsl::{field_bound, normalize_target, sanitize_motion_asset, SanitizeOpts};

fn push(issues: &mut Vec<Value>, level: &str, code: &str, track: Option<usize>, msg: String) {
    let mut e = json!({ "level": level, "code": code, "message": msg });
    if let Some(t) = track {
        e["track"] = json!(t);
    }
    issues.push(e);
}

fn num(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// Validasi satu draft Motion Asset. `analysis` = hasil
/// `motion_analysis::analyze` (opsional; tanpa itu hanya pemeriksaan
/// struktural + kualitas raw). Output:
/// `{ok, errorCount, warnCount, infoCount, issues:[{level,code,message,track?}]}`.
pub fn validate_asset(draft: &Value, analysis: Option<&Value>) -> Value {
    let mut issues: Vec<Value> = Vec::new();

    // 1) Struktural: error dari sanitize = asset akan ditolak saat simpan.
    if let Err(errs) = sanitize_motion_asset(draft, &SanitizeOpts { require_tracks: true, ..Default::default() }) {
        for e in errs {
            push(&mut issues, "error", "sanitize", None, e);
        }
    }

    let tracks = draft.get("tracks").and_then(|v| v.as_array());
    let duration = num(draft.get("duration"));
    if duration.map(|d| !d.is_finite() || d < 0.1 || d > 20.0).unwrap_or(true) {
        push(
            &mut issues,
            "warn",
            "duration",
            None,
            format!("duration {duration:?} di luar 0.1..20 — akan direset/diclampt saat simpan"),
        );
    }

    let params = analysis.and_then(|a| a.get("params")).and_then(|v| v.as_object());
    let roles = analysis.and_then(|a| a.get("roles")).and_then(|v| v.as_object());
    let physics_outputs = analysis
        .and_then(|a| a.get("physicsOutputs"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>())
        .unwrap_or_default();

    // 2) Kualitas raw + 3) semantik, per track.
    for (ti, tr) in tracks.into_iter().flatten().enumerate() {
        let Some(tro) = tr.as_object() else { continue };
        let keys = tro.get("keys").and_then(|v| v.as_array());
        let is_param = tro.get("param").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false);

        if is_param {
            let pid = tro.get("param").and_then(|v| v.as_str()).unwrap_or("").trim();
            if physics_outputs.iter().any(|&p| p == pid) {
                push(
                    &mut issues,
                    "warn",
                    "physics_target",
                    Some(ti),
                    format!("param \"{pid}\" adalah output physics — gerakkan penyebabnya (angla badan/kepala), bukan outputnya"),
                );
            }
            match params.and_then(|p| p.get(pid)) {
                None => push(
                    &mut issues,
                    "info",
                    "param_unobserved",
                    Some(ti),
                    format!("param \"{pid}\" tidak pernah dipakai motion lama model ini — pastikan nilainya masuk akal"),
                ),
                Some(st) => {
                    let (lo, hi) = (num(st.get("min")).unwrap_or(0.0), num(st.get("max")).unwrap_or(0.0));
                    let base = num(st.get("base"));
                    let mut saw_first: Option<f64> = None;
                    let mut saw_last: Option<f64> = None;
                    for k in keys.into_iter().flatten() {
                        let v = num(k.get("v"));
                        if let Some(v) = v {
                            saw_first = Some(saw_first.unwrap_or(v));
                            saw_last = Some(v);
                            if v < lo - 1e-6 || v > hi + 1e-6 {
                                push(
                                    &mut issues,
                                    "warn",
                                    "out_of_observed_range",
                                    Some(ti),
                                    format!("nilai {v} di luar range observasi [{lo}, {hi}] param \"{pid}\""),
                                );
                            }
                        }
                    }
                    // Repo: aksi satu-tembakan mulai & pulang ke base pose.
                    if let (Some(b), Some(f), Some(l)) = (base, saw_first, saw_last) {
                        if (f - b).abs() > 1e-3 {
                            push(
                                &mut issues,
                                "info",
                                "base_mismatch",
                                Some(ti),
                                format!("keyframe pertama {f} ≠ base pose terobservasi {b} param \"{pid}\""),
                            );
                        }
                        if (l - b).abs() > 1e-3 {
                            push(
                                &mut issues,
                                "warn",
                                "base_return",
                                Some(ti),
                                format!("keyframe terakhir {l} ≠ base pose terobservasi {b} param \"{pid}\" — gerakan akan nyangkut"),
                            );
                        }
                    }
                }
            }
        } else {
            // Role track.
            let raw_target = tro.get("target").and_then(|v| v.as_str()).unwrap_or("");
            let known = normalize_target(raw_target);
            match known {
                None => push(
                    &mut issues,
                    "error",
                    "unknown_target",
                    Some(ti),
                    format!("track target tidak dikenal: {raw_target} (hanya role semantik: ax/ay/az/bodyX/bodyY/bodyZ/ex/ey/mouthForm/mouthOpen/browLY/browRY/browLF/browRF/smileL/smileR)"),
                ),
                Some(t) => {
                    let bound = field_bound(&t).unwrap_or(1.0);
                    let mut vals: Vec<f64> = Vec::new();
                    for k in keys.into_iter().flatten() {
                        if let Some(v) = num(k.get("v")) {
                            vals.push(v);
                        }
                        if v_out_of_bound(k, bound) {
                            push(
                                &mut issues,
                                "warn",
                                "role_clamp",
                                Some(ti),
                                format!("nilai role \"{t}\" melebihi ±{bound} — akan di-clamp saat simpan"),
                            );
                        }
                    }
                    if let (Some(f), Some(l)) = (vals.first(), vals.last()) {
                        if f.abs() > 1e-6 {
                            push(
                                &mut issues,
                                "warn",
                                "base_start",
                                Some(ti),
                                format!("keyframe pertama role \"{t}\" = {f} (bukan 0) — mulai dari base pose"),
                            );
                        }
                        if l.abs() > 1e-6 {
                            push(
                                &mut issues,
                                "warn",
                                "base_return",
                                Some(ti),
                                format!("keyframe terakhir role \"{t}\" = {l} (bukan 0) — pulang ke base pose agar tidak nyangkut"),
                            );
                        }
                    }
                    if let Some(rs) = roles.and_then(|r| r.get(&t)) {
                        let (lo, hi) = (num(rs.get("min")).unwrap_or(0.0), num(rs.get("max")).unwrap_or(0.0));
                        for &v in &vals {
                            if v < lo - 1e-6 || v > hi + 1e-6 {
                                push(
                                    &mut issues,
                                    "warn",
                                    "out_of_observed_range",
                                    Some(ti),
                                    format!("nilai {v} di luar range observasi [{lo}, {hi}] role \"{t}\" di model ini"),
                                );
                            }
                        }
                        if rs.get("physics").and_then(|v| v.as_bool()) == Some(true) {
                            push(
                                &mut issues,
                                "warn",
                                "physics_target",
                                Some(ti),
                                format!("role \"{t}\" terpetakan ke param output physics di model ini"),
                            );
                        }
                    }
                }
            }
        }

        // Raw keyframe quality (berlaku untuk kedua kind).
        let mut prev_t: Option<f64> = None;
        for k in keys.into_iter().flatten() {
            let t = num(k.get("t"));
            let v = num(k.get("v"));
            let dur = duration.unwrap_or(f64::NAN);
            match (t, v) {
                (Some(t), Some(v)) if t.is_finite() && v.is_finite() => {
                    if t < 0.0 || t > dur + 0.001 {
                        push(&mut issues, "warn", "key_out_of_duration", Some(ti), format!("keyframe t={t} di luar [0, {dur}] — akan dibuang saat simpan"));
                    }
                    if let Some(p) = prev_t {
                        if t < p {
                            push(&mut issues, "warn", "key_unsorted", Some(ti), "keyframe tidak terurut — akan disortir saat simpan".into());
                        } else if t == p {
                            push(&mut issues, "info", "key_duplicate", Some(ti), format!("keyframe waktu sama t={t} — yang terakhir menang"));
                        }
                    }
                    prev_t = Some(t);
                }
                _ => push(&mut issues, "error", "key_non_numeric", Some(ti), "keyframe non-numerik (t/v bukan angka)".into()),
            }
        }
    }

    let count = |level: &str| issues.iter().filter(|i| i["level"] == json!(level)).count();
    let (err, warn, info) = (count("error"), count("warn"), count("info"));
    json!({
        "ok": err == 0,
        "errorCount": err,
        "warnCount": warn,
        "infoCount": info,
        "issues": issues,
    })
}

fn v_out_of_bound(k: &Value, bound: f64) -> bool {
    match num(k.get("v")) {
        Some(v) => v > bound + 1e-6 || v < -bound - 1e-6,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn analisis() -> Value {
        json!({
            "hasReference": true,
            "params": {
                "ParamAngleX": { "min": -30.0, "max": 20.0, "base": 0.0, "usage": 3 },
                "MouthForm": { "min": -1.0, "max": 1.0, "base": 1.0, "usage": 4 },
                "ParamCheek": { "min": 0.0, "max": 1.0, "base": 0.0, "usage": 1 }
            },
            "physicsOutputs": ["ParamHairFront"],
            "roles": {
                "ax": { "min": -30.0, "max": 20.0, "base": 0.0, "param": "ParamAngleX", "physics": false },
                "mouthForm": { "min": -1.0, "max": 1.0, "base": 1.0, "param": "MouthForm", "physics": false }
            }
        })
    }

    #[test]
    fn draft_bersih_lolos() {
        let d = json!({
            "id": "angguk", "duration": 1.4,
            "tracks": [
                { "target": "ay", "keys": [{ "t": 0, "v": 0 }, { "t": 0.4, "v": 8 }, { "t": 1.4, "v": 0 }] },
                { "param": "ParamCheek", "keys": [{ "t": 0, "v": 0 }, { "t": 0.5, "v": 0.5 }, { "t": 1.4, "v": 0 }] }
            ]
        });
        let r = validate_asset(&d, Some(&analisis()));
        assert_eq!(r["ok"], true, "issues: {}", r["issues"]);
        assert_eq!(r["errorCount"], 0);
    }

    #[test]
    fn target_tak_kenal_dan_key_non_numerik_ditolak() {
        let d = json!({
            "id": "rusak", "duration": 1.0,
            "tracks": [
                { "target": "ParamHairFront", "keys": [{ "t": 0, "v": 1 }] },
                { "target": "ay", "keys": [{ "t": 0, "v": "x" }] }
            ]
        });
        let r = validate_asset(&d, None);
        assert_eq!(r["ok"], false);
        assert!(r["issues"].as_array().unwrap().iter().any(|i| i["code"] == "unknown_target" && i["level"] == "error"));
        assert!(r["issues"].as_array().unwrap().iter().any(|i| i["code"] == "key_non_numeric" && i["level"] == "error"));
    }

    #[test]
    fn role_tidak_pulang_ke_base_dan_nilai_clamp() {
        let d = json!({
            "id": "miring", "duration": 1.0,
            "tracks": [
                { "target": "ax", "keys": [{ "t": 0, "v": 5 }, { "t": 1.0, "v": 45 }] }
            ]
        });
        let r = validate_asset(&d, None);
        let codes: Vec<&str> = r["issues"].as_array().unwrap().iter().filter_map(|i| i["code"].as_str()).collect();
        assert!(codes.contains(&"base_start"), "{codes:?}");
        assert!(codes.contains(&"base_return"), "{codes:?}");
        assert!(codes.contains(&"role_clamp"), "{codes:?}"); // 45 > 30
        assert_eq!(r["ok"], true); // advisory, bukan tolakan
    }

    #[test]
    fn range_observasi_dan_physics_dan_base_param() {
        let d = json!({
            "id": "polos", "duration": 2.0,
            "tracks": [
                // Di luar range observasi ax (max 20) + tak pulang ke base.
                { "param": "ParamAngleX", "keys": [{ "t": 0, "v": 0 }, { "t": 1.0, "v": 25 }, { "t": 2.0, "v": 10 }] },
                // Output physics.
                { "param": "ParamHairFront", "keys": [{ "t": 0, "v": 0 }, { "t": 1.0, "v": 1 }] },
                // Base pose observasi = 1: mulai 0 → info quirk.
                { "param": "MouthForm", "keys": [{ "t": 0, "v": 0 }, { "t": 2.0, "v": 1 }] },
                // Param yang tak pernah dipakai motion lama.
                { "param": "ParamMisterius", "keys": [{ "t": 0, "v": 0 }, { "t": 2.0, "v": 0 }] }
            ]
        });
        let r = validate_asset(&d, Some(&analisis()));
        let arr = r["issues"].as_array().unwrap();
        let has = |code: &str| arr.iter().any(|i| i["code"] == code);
        assert!(has("out_of_observed_range"), "{}", r);
        assert!(has("physics_target"), "{}", r);
        assert!(has("base_mismatch"), "{}", r);
        assert!(has("param_unobserved"), "{}", r);
        assert!(has("base_return"), "{}", r); // AngleX terakhir 10 ≠ 0
        assert_eq!(r["ok"], true);
    }

    #[test]
    fn keyframe_tak_terurut_dan_di_luar_durasi() {
        let d = json!({
            "id": "acak", "duration": 1.0,
            "tracks": [
                { "target": "ay", "keys": [{ "t": 0.8, "v": 4 }, { "t": 0.2, "v": 2 }, { "t": 3.0, "v": 0 }] }
            ]
        });
        let r = validate_asset(&d, None);
        let codes: Vec<&str> = r["issues"].as_array().unwrap().iter().filter_map(|i| i["code"].as_str()).collect();
        assert!(codes.contains(&"key_unsorted"), "{codes:?}");
        assert!(codes.contains(&"key_out_of_duration"), "{codes:?}");
    }

    /// Invariansi nama: laporan sama untuk param bernama beda.
    #[test]
    fn invarian_terhadap_rename_param() {
        let buat = |pid: &str| json!({
            "id": "polos", "duration": 2.0,
            "tracks": [{ "param": pid, "keys": [{ "t": 0, "v": 0 }, { "t": 1.0, "v": 25 }] }]
        });
        let a1 = json!({ "params": { "ParamAngleX": { "min": -30.0, "max": 20.0, "base": 0.0 } }, "physicsOutputs": [], "roles": null });
        let a2 = json!({ "params": { "m_001": { "min": -30.0, "max": 20.0, "base": 0.0 } }, "physicsOutputs": [], "roles": null });
        let r1 = validate_asset(&buat("ParamAngleX"), Some(&a1));
        let r2 = validate_asset(&buat("m_001"), Some(&a2));
        assert_eq!(r1["warnCount"], r2["warnCount"]);
        let c1: Vec<String> = r1["issues"].as_array().unwrap().iter().filter_map(|i| i["code"].as_str().map(String::from)).collect();
        let c2: Vec<String> = r2["issues"].as_array().unwrap().iter().filter_map(|i| i["code"].as_str().map(String::from)).collect();
        assert_eq!(c1, c2);
    }
}
