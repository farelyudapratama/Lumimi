//! Endpoint LLM-role "sheet" — port handleClassifyParams (`/api/model/
//! classify-params`). LLM mengklasifikasi parameter rig → role baku + grup +
//! label. Model-Agnostic: hanya role dari KNOWN_ROLES yang lolos; LLM tak
//! pernah mengirim angka range (validasi ketat di sini).

use std::path::Path;

use serde_json::{json, Value};

use crate::{jsonx, llm};

/// Role baku (padanan KNOWN_ROLES index.ts).
pub const KNOWN_ROLES: &[&str] = &[
    "angleX", "angleY", "angleZ", "eyeBallX", "eyeBallY", "eyeLOpen", "eyeROpen",
    "eyeLSmile", "eyeRSmile", "eyeForm", "mouthOpenY", "mouthForm", "mouthOpenX",
    "bodyAngleX", "bodyAngleY", "bodyAngleZ", "breath", "browLForm", "browRForm",
    "browLY", "browRY", "browLAngle", "browRAngle", "blush",
];

fn str_cap(v: &Value, cap: usize) -> String {
    v.as_str()
        .map(|s| {
            s.chars()
                .filter(|&c| (c as u32) > 0x1F && (c as u32) != 0x7F)
                .collect::<String>()
                .trim()
                .chars()
                .take(cap)
                .collect()
        })
        .unwrap_or_default()
}

/// POST /api/model/classify-params — return {classifications:[...]}.
pub async fn classify_params(config_path: &Path, body: &Value) -> Value {
    let unclassified = body.get("params").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if unclassified.is_empty() {
        return json!({ "classifications": [] });
    }
    let known_roles = body.get("currentRoles").cloned().unwrap_or(json!({}));

    let param_lines = unclassified
        .iter()
        .map(|u| {
            format!(
                "- ID: \"{}\", Range: [{}, {}], Default: {}",
                u.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                u.get("min").map(|v| v.to_string()).unwrap_or_default(),
                u.get("max").map(|v| v.to_string()).unwrap_or_default(),
                u.get("def").map(|v| v.to_string()).unwrap_or_default(),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mapped = known_roles
        .as_object()
        .map(|o| {
            if o.is_empty() {
                "(belum ada)".to_string()
            } else {
                o.iter()
                    .map(|(r, id)| format!("  {r} -> {}", id.as_str().unwrap_or("")))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        })
        .unwrap_or_else(|| "(belum ada)".to_string());

    let prompt = format!(
        "Kamu adalah pakar Live2D Cubism rigging & parameter modeling.\n\
Berikut daftar parameter model yang BELUM memiliki mapping role baku:\n{param_lines}\n\n\
Parameter yang SUDAH ter-mapping:\n{mapped}\n\n\
Daftar semantic roles yang tersedia:\n[{roles}]\n\n\
TUGAS: Analisis setiap parameter (nama ID, range, konvensi JP/CN/EN, fungsinya di Live2D).\n\
Tentukan: id, role (salah satu di atas, atau null jika aksesoris/parts/fisika),\n\
group (\"Sudut (Angle)\"/\"Mata (Eye)\"/\"Alis (Eyebrow)\"/\"Mulut (Mouth)\"/\"Badan (Body)\"/\
\"Rambut (Hair)\"/\"Aksesoris (Accessory)\"/\"Physics\"/\"Kustom\"), isAccessory (bool),\n\
dan label: ringkas, NETRAL gaya teknis Cubism (bahasa Inggris umum, mis. \"Head X\",\n\
\"Mouth Open\") — label hanya pelengkap ID param di UI, BUKAN terjemahan bebas\n\
dan BUKAN kalimat deskriptif panjang.\n\n\
KEMBALIKAN HANYA JSON array valid tanpa markdown.\n\
Format:\n[\n  {{ \"id\": \"ParamX\", \"role\": \"angleX\", \"group\": \"Sudut (Angle)\", \"label\": \"Head X\", \"isAccessory\": false }}\n]",
        roles = KNOWN_ROLES.join(", "),
    );

    let msgs = vec![llm::ChatMessage { role: "user".into(), content: prompt }];
    let reply = match llm::llm_for_role(config_path, "sheet", &msgs, "").await {
        Ok(ok) => ok.reply,
        Err((_, msg)) => return json!({ "classifications": [], "warning": msg }),
    };

    let parsed = jsonx::extract_json_array_loose(&reply);
    let requested: std::collections::HashSet<String> = unclassified
        .iter()
        .filter_map(|u| u.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let allowed: std::collections::HashSet<&str> = KNOWN_ROLES.iter().cloned().collect();

    let mut out: Vec<Value> = Vec::new();
    for it in &parsed {
        let id = it.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if !requested.contains(&id) {
            continue;
        }
        let role = it
            .get("role")
            .and_then(|v| v.as_str())
            .filter(|r| allowed.contains(r))
            .map(|r| json!(r))
            .unwrap_or(Value::Null);
        out.push(json!({
            "id": id,
            "role": role,
            "group": str_cap(it.get("group").unwrap_or(&Value::Null), 40),
            "label": str_cap(it.get("label").unwrap_or(&Value::Null), 60),
            "isAccessory": it.get("isAccessory") == Some(&json!(true))
        }));
    }
    json!({ "classifications": out })
}

const CATS: &[&str] = &["emosi", "properti", "aksesoris"];

fn note_of(notes: &Value, id: &str) -> String {
    notes
        .get(id)
        .and_then(|v| v.as_str())
        .map(|s| {
            s.chars()
                .filter(|&c| {
                    let u = c as u32;
                    !((u <= 0x08) || u == 0x0B || u == 0x0C || (0x0E..=0x1F).contains(&u) || u == 0x7F)
                })
                .collect::<String>()
                .trim()
                .chars()
                .take(300)
                .collect()
        })
        .unwrap_or_default()
}

/// POST /api/model/analyze-sheet — usul preset pose (role "sheet"). Return
/// {presets:[...], warning?, stats?}. Echo model kecil → retry + koreksi.
pub async fn analyze_sheet(config_path: &Path, body: &Value) -> Value {
    // params valid: id string, min/max angka.
    let params: Vec<Value> = body
        .get("params")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter(|p| {
                    p.get("id").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
                        && p.get("min").and_then(|v| v.as_f64()).is_some()
                        && p.get("max").and_then(|v| v.as_f64()).is_some()
                })
                .take(300)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let parts: Vec<String> = body
        .get("parts")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|p| p.get("id").and_then(|v| v.as_str()).or_else(|| p.as_str()).map(String::from))
                .take(300)
                .collect()
        })
        .unwrap_or_default();
    let existing: Vec<String> = body
        .get("existingNames")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|n| n.as_str()).map(|s| s.to_lowercase()).take(400).collect())
        .unwrap_or_default();
    let notes = body.get("notes").cloned().unwrap_or(json!({}));

    if params.is_empty() {
        return json!({ "presets": [], "warning": "tidak ada parameter dengan range valid" });
    }

    let param_lines = params.iter().map(|p| {
        let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let label = p.get("label").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty())
            .map(|s| format!(" ({})", s.chars().take(40).collect::<String>())).unwrap_or_default();
        let group = p.get("group").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty())
            .map(|s| format!(" [grup: {}]", s.chars().take(40).collect::<String>())).unwrap_or_default();
        let min = p.get("min").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let max = p.get("max").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let def = p.get("def").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let pn = note_of(&notes, id);
        let note = if pn.is_empty() { String::new() } else { format!(" | penjelasan user: {pn}") };
        format!("- \"{id}\"{label}{group} range [{min}, {max}] default {def}{note}")
    }).collect::<Vec<_>>().join("\n");

    let parts_block = if !parts.is_empty() {
        format!("PART TERSEDIA (opacity 0..1):\n{}", parts.iter().map(|p| format!("- \"{p}\"")).collect::<Vec<_>>().join("\n"))
    } else {
        "(model ini tidak punya part yang bisa di-toggle — efek aksesoris/properti lewat kombinasi PARAMETER di atas.)".to_string()
    };
    let existing_block = if existing.is_empty() { "(belum ada, kamu bebas berkreasi dari nol)".to_string() } else { existing.join(", ") };

    let prompt = format!(
        "Kamu pakar rigging Live2D Cubism. Berdasarkan daftar parameter model di bawah, usulkan preset pose yang masuk akal dan SEBANYAK MUNGKIN VARIASI untuk model INI.\n\n\
PARAMETER TERSEDIA (hanya id di bawah yang boleh dipakai):\n{param_lines}\n\n{parts_block}\n\n\
PRESET YANG SUDAH ADA (jangan diusulkan ulang):\n{existing_block}\n\n\
TUGAS: usulkan MINIMAL 12 preset BERAGAM yang menyentuh sebanyak mungkin grup parameter.\n\
Tiap preset: name (Indonesia, maks 60, unik), category ({cats}), values {{\"ParamId\":angka}} HANYA id di atas, parts {{\"PartId\":0..1}}.\n\n\
ATURAN KERAS:\n1. JANGAN mengarang id parameter/part di luar daftar.\n2. JANGAN sertakan min/max/def/steps.\n\
3. Hanya parameter yang berubah dari default (3-8 per preset).\n4. Kategori \"gerak\" TIDAK BOLEH.\n\
5. MINIMAL 6 preset \"emosi\" berbeda; sisanya \"properti\"/\"aksesoris\".\n\n\
KEMBALIKAN HANYA JSON array valid. MULAI dengan [ dan AKHIRI dengan ]. JANGAN mengulang instruksi.\n\
Format (contoh STRUKTUR, ganti dgn milik model ini):\n\
[\n  {{ \"name\": \"Senang\", \"category\": \"emosi\", \"values\": {{ \"ParamMouthForm\": 1 }}, \"parts\": {{}} }}\n]",
        cats = CATS.join(" / "),
    );

    let echoed = |clean: &str| -> bool {
        let low = clean.to_lowercase();
        low.contains("parameter tersedia") || low.trim_start().starts_with("kamu pakar")
    };

    // panggilan 1
    let msgs1 = vec![llm::ChatMessage { role: "user".into(), content: prompt.clone() }];
    let mut reply = match llm::llm_for_role(config_path, "sheet", &msgs1, "").await {
        Ok(ok) => ok.reply,
        Err((_, msg)) => return json!({ "presets": [], "warning": msg }),
    };
    let mut clean = strip_fences(&reply);
    let mut parsed = jsonx::extract_json_array_loose(&reply);

    // echo / kosong → retry dgn koreksi.
    if echoed(&clean) || parsed.is_empty() {
        let msgs2 = vec![
            llm::ChatMessage { role: "user".into(), content: prompt.clone() },
            llm::ChatMessage { role: "assistant".into(), content: clean.chars().take(2000).collect() },
            llm::ChatMessage {
                role: "user".into(),
                content: "Balasanmu tadi salah: kamu mengulang instruksi, bukan menjawab. Balas HANYA array JSON preset — mulai dengan [ langsung, tanpa markdown, tanpa penjelasan.".into(),
            },
        ];
        if let Ok(ok2) = llm::llm_for_role(config_path, "sheet", &msgs2, "").await {
            let clean2 = strip_fences(&ok2.reply);
            let parsed2 = jsonx::extract_json_array_loose(&ok2.reply);
            if !parsed2.is_empty() {
                reply = ok2.reply;
                clean = clean2;
                parsed = parsed2;
            } else if echoed(&clean) {
                parsed = vec![];
                clean = clean2;
            }
        }
    }
    let _ = reply;

    if parsed.is_empty() {
        let why = if echoed(&clean) {
            "model mengulang teks instruksi (echo) — coba lagi atau pakai model lain"
        } else {
            "kemungkinan terpotong — perbesar maxTokens koneksi, atau coba lagi / pakai koneksi lain"
        };
        return json!({ "presets": [], "warning": format!("balasan LLM tidak berisi array preset ({why}); awalan: {}", clean.chars().take(120).collect::<String>()) });
    }

    // validasi + dedup.
    use std::collections::{HashMap, HashSet};
    let ranges: HashMap<String, (f64, f64)> = params
        .iter()
        .filter_map(|p| {
            let id = p.get("id").and_then(|v| v.as_str())?.to_string();
            let lo = p.get("min").and_then(|v| v.as_f64())?;
            let hi = p.get("max").and_then(|v| v.as_f64())?;
            Some((id, (lo, hi)))
        })
        .collect();
    let part_ids: HashSet<&str> = parts.iter().map(String::as_str).collect();
    let existing_set: HashSet<&str> = existing.iter().map(String::as_str).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let (mut dup, mut invalid) = (0i32, 0i32);
    let mut dup_names: Vec<String> = Vec::new();
    let mut safe: Vec<Value> = Vec::new();

    for it in &parsed {
        if !it.is_object() {
            invalid += 1;
            continue;
        }
        let name = str_cap(it.get("name").unwrap_or(&Value::Null), 60);
        let category = it.get("category").and_then(|v| v.as_str()).filter(|c| CATS.contains(c));
        let (name, category) = match (name.is_empty(), category) {
            (false, Some(c)) => (name, c),
            _ => {
                invalid += 1;
                continue;
            }
        };
        let key = format!("{category}\u{0}{}", name.to_lowercase());
        if existing_set.contains(name.to_lowercase().as_str()) || seen.contains(&key) {
            dup += 1;
            if dup_names.len() < 5 {
                dup_names.push(name.clone());
            }
            continue;
        }
        let mut values = serde_json::Map::new();
        if let Some(vo) = it.get("values").and_then(|v| v.as_object()) {
            for (k, v) in vo {
                if let (Some(&(lo, hi)), Some(n)) = (ranges.get(k), v.as_f64()) {
                    values.insert(k.clone(), json!(n.clamp(lo, hi)));
                }
            }
        }
        let mut pparts = serde_json::Map::new();
        if let Some(po) = it.get("parts").and_then(|v| v.as_object()) {
            for (k, v) in po {
                if part_ids.contains(k.as_str()) {
                    if let Some(n) = v.as_f64() {
                        pparts.insert(k.clone(), json!(n.clamp(0.0, 1.0)));
                    }
                }
            }
        }
        if values.is_empty() && pparts.is_empty() {
            invalid += 1;
            continue;
        }
        seen.insert(key);
        safe.push(json!({ "name": name, "category": category, "values": values, "parts": pparts, "source": "ai" }));
        if safe.len() >= 12 {
            break;
        }
    }

    if safe.is_empty() {
        let raw = parsed.len();
        let why = if raw == 0 {
            "model tidak mengusulkan apa pun — coba lagi".to_string()
        } else {
            format!("model mengusulkan {raw} preset tapi SEMUANYA dibuang: {dup} nama sudah dipakai, {invalid} ditolak (id tidak ada / struktur salah)")
        };
        return json!({ "presets": [], "warning": why });
    }
    json!({
        "presets": safe,
        "stats": { "raw": parsed.len(), "kept": safe.len(), "droppedDup": dup, "droppedInvalid": invalid, "dupNames": dup_names }
    })
}

fn strip_fences(text: &str) -> String {
    text.replace("```json", "").replace("```JSON", "").replace("```", "").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn classify_kosong_dan_fallback() {
        let dir = std::env::temp_dir().join(format!("l2dsai-{}-{}", std::process::id(), now()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        std::fs::write(&f, r#"{"activeId":"m","connections":[{"id":"m","provider":"mock"}]}"#).unwrap();
        // params kosong → classifications []
        let empty = classify_params(&f, &json!({ "params": [] })).await;
        assert_eq!(empty["classifications"].as_array().unwrap().len(), 0);
        // mock meng-echo prompt (berisi contoh [{id:ParamX}]); id kita berbeda
        // ("ParamHairFront") → tak ada di requested → tersaring habis → [].
        // Ini juga menguji validasi requested-id.
        let out = classify_params(&f, &json!({ "params": [{ "id": "ParamHairFront", "min": 0, "max": 1, "def": 0 }] })).await;
        assert_eq!(out["classifications"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn now() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
    }
}
