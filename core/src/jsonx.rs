//! Parser JSON tahan-banting — port helper dari `src/shared/llm-client.ts`:
//! `extractJSON`, `salvageJSONArrayOfObjects`, `extractJSONArrayLoose`,
//! `extractJSONObjectLoose`. Semua string-aware ('{'/'}'/'['/']' di dalam string
//! tidak dihitung). Dipakai endpoint LLM-role (analyze-sheet, animate-text, dst)
//! yang harus toleran relay aneh / model kecil yang echo prompt / balasan terpotong.

use serde_json::Value;

fn is_records(v: &Value) -> bool {
    v.as_array()
        .map(|a| !a.is_empty() && a.iter().all(|it| it.is_object()))
        .unwrap_or(false)
}

/// Iris SEMUA blok seimbang berawalan `open`/`close` (string-aware).
/// Mengembalikan potongan string tiap blok level-atas.
fn balanced_blocks(src: &str, open: char, close: char) -> Vec<String> {
    let mut out = Vec::new();
    let (mut depth, mut start, mut in_str, mut esc) = (0i32, -1i64, false, false);
    for (i, ch) in src.char_indices() {
        if in_str {
            if esc {
                esc = false;
            } else if ch == '\\' {
                esc = true;
            } else if ch == '"' {
                in_str = false;
            }
            continue;
        }
        if ch == '"' {
            in_str = true;
        } else if ch == open {
            if depth == 0 {
                start = i as i64;
            }
            depth += 1;
        } else if ch == close {
            depth -= 1;
            if depth == 0 && start >= 0 {
                out.push(src[start as usize..=i].to_string());
                start = -1;
            }
        }
    }
    out
}

/// `extractJSON`: parse langsung → SSE (gabung data:) → iris objek `{}` seimbang.
/// Err bila kosong / tak ada JSON.
pub fn extract_json(text: &str) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Err("respon KOSONG dari provider — relay/faucet mungkin kehabisan kuota atau memutus koneksi diam-diam".into());
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return Ok(v);
    }
    // SSE: kumpulkan payload baris "data:".
    let mut data_lines: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("data:") {
            let p = rest.trim();
            if !p.is_empty() && p != "[DONE]" {
                data_lines.push(p.to_string());
            }
        }
    }
    if !data_lines.is_empty() {
        let objs: Vec<Value> = data_lines.iter().filter_map(|d| serde_json::from_str::<Value>(d).ok()).collect();
        if objs.len() == 1 {
            return Ok(objs[0].clone());
        }
        if !objs.is_empty() {
            let mut content = String::new();
            let mut usage = Value::Null;
            for o in &objs {
                let c = o.pointer("/choices/0");
                let piece = c
                    .and_then(|c| c.pointer("/delta/content").or_else(|| c.pointer("/message/content")))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                content.push_str(piece);
                if let Some(u) = o.get("usage") {
                    usage = u.clone();
                }
            }
            let mut merged = serde_json::json!({ "choices": [{ "message": { "role": "assistant", "content": content } }] });
            if !usage.is_null() {
                merged["usage"] = usage;
            }
            return Ok(merged);
        }
    }
    // objek seimbang pertama.
    let blocks = balanced_blocks(text, '{', '}');
    if let Some(first) = blocks.first() {
        if let Ok(v) = serde_json::from_str::<Value>(first) {
            return Ok(v);
        }
    }
    Err(format!("respon bukan JSON: {}", text.chars().take(200).collect::<String>()))
}

/// `salvageJSONArrayOfObjects`: objek `{}` level-atas dari dalam `[...]` yang
/// terpotong — objek selesai di-parse, yang kebelah diabaikan.
pub fn salvage_json_array_of_objects(text: &str) -> Vec<Value> {
    let start = match text.find('[') {
        Some(s) => s,
        None => return vec![],
    };
    let src = &text[start..];
    let mut out = Vec::new();
    let (mut depth, mut obj_start, mut in_str, mut esc) = (0i32, -1i64, false, false);
    for (i, ch) in src.char_indices() {
        if in_str {
            if esc {
                esc = false;
            } else if ch == '\\' {
                esc = true;
            } else if ch == '"' {
                in_str = false;
            }
            continue;
        }
        if ch == '"' {
            in_str = true;
        } else if ch == '{' {
            if depth == 0 {
                obj_start = i as i64;
            }
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 && obj_start >= 0 {
                if let Ok(v) = serde_json::from_str::<Value>(&src[obj_start as usize..=i]) {
                    out.push(v);
                }
                obj_start = -1;
            } else if depth < 0 {
                break;
            }
        }
    }
    out
}

fn strip_fences(text: &str) -> String {
    text.replace("```json", "").replace("```JSON", "").replace("```", "").trim().to_string()
}

/// `extractJSONArrayLoose`: array-of-objects tahan model kecil. Langsung →
/// objek pembungkus → blok `[...]` seimbang TERAKHIR → salvage.
pub fn extract_json_array_loose(text: &str) -> Vec<Value> {
    let src = strip_fences(text);
    if src.is_empty() {
        return vec![];
    }
    let pick = |v: &Value| -> Option<Vec<Value>> {
        if is_records(v) {
            return v.as_array().cloned();
        }
        if let Some(o) = v.as_object() {
            for val in o.values() {
                if is_records(val) {
                    return val.as_array().cloned();
                }
            }
        }
        None
    };
    if let Ok(direct) = serde_json::from_str::<Value>(&src) {
        if let Some(r) = pick(&direct) {
            return r;
        }
    }
    let cands = balanced_blocks(&src, '[', ']');
    for c in cands.iter().rev() {
        if let Ok(parsed) = serde_json::from_str::<Value>(c) {
            if let Some(r) = pick(&parsed) {
                return r;
            }
        }
    }
    salvage_json_array_of_objects(&src)
}

/// `extractJSONObjectLoose`: SATU objek. Langsung → blok `{}` seimbang TERAKHIR.
pub fn extract_json_object_loose(text: &str) -> Option<Value> {
    let src = strip_fences(text);
    if src.is_empty() {
        return None;
    }
    if let Ok(direct) = serde_json::from_str::<Value>(&src) {
        if direct.is_object() {
            return Some(direct);
        }
    }
    let cands = balanced_blocks(&src, '{', '}');
    for c in cands.iter().rev() {
        if let Ok(parsed) = serde_json::from_str::<Value>(c) {
            if parsed.is_object() {
                return Some(parsed);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_json_langsung_dan_sampah() {
        assert_eq!(extract_json(r#"{"a":1}"#).unwrap(), json!({"a":1}));
        // JSON + sampah setelahnya
        assert_eq!(extract_json(r#"{"a":1} lalu ngoceh}"#).unwrap(), json!({"a":1}));
        // "}" di dalam string tidak menutup dini
        assert_eq!(extract_json(r#"{"a":"x}y"}"#).unwrap(), json!({"a":"x}y"}));
        assert!(extract_json("   ").is_err());
    }

    #[test]
    fn extract_json_router_sampah_done_menempel() {
        // Regresi live (router lokal): body JSON utuh + `data: [DONE]` SSE
        // menempel di akhir — parser ketat menolak seluruh respons.
        let raw = r#"{"id":"2bf9","choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","tool_calls":null,"content":"Halo"}}]}data: [DONE]"#;
        let v = extract_json(raw).unwrap();
        assert_eq!(v.pointer("/choices/0/message/content").unwrap(), "Halo");
    }

    #[test]
    fn extract_json_sse_merge() {
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"Ha\"}}]}\ndata: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\ndata: [DONE]\n";
        let v = extract_json(sse).unwrap();
        assert_eq!(v.pointer("/choices/0/message/content").unwrap(), "Halo");
    }

    #[test]
    fn array_loose_ambil_terakhir_bukan_echo() {
        // model echo contoh dari prompt di awal, jawaban asli di akhir
        let t = r#"contoh: [{"x":0}] ... jawaban: [{"name":"a"},{"name":"b"}]"#;
        let r = extract_json_array_loose(t);
        assert_eq!(r.len(), 2);
        assert_eq!(r[1]["name"], "b");
        // objek pembungkus {presets:[...]}
        let w = extract_json_array_loose(r#"{"presets":[{"p":1}]}"#);
        assert_eq!(w.len(), 1);
    }

    #[test]
    fn salvage_terpotong() {
        let t = r#"[{"a":1},{"b":2},{"c":"#; // objek ke-3 kebelah
        let r = salvage_json_array_of_objects(t);
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn object_loose_ambil_terakhir() {
        let t = r#"template: {"<emosi>":0} hasil: {"happy":0.8}"#;
        let o = extract_json_object_loose(t).unwrap();
        assert_eq!(o["happy"], 0.8);
    }
}
