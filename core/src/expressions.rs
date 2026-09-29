//! Rute ekspresi: discoverExpressions + adoption GET/POST.
//! Test di bawah menuntut tiap ekspresi membawa `params` (Id dari file
//! .exp3.json) — data rig asli milik model, dipakai klien untuk info
//! ekspresi/adopsi. Folder tanpa `.model3.json` memakai blueprint
//! Auto-Rescue in-memory (padanan fallback TS — manifest user tak disentuh).

use std::collections::BTreeSet;
use std::path::Path;

use serde_json::{json, Value};

use crate::model::find_model3;

/// Nama folder/berkas aman — padanan `sanitizeModelFolderName`: huruf/angka
/// Unicode + `_`/`-` dipertahankan; run karakter asing → satu `_`; kosong →
/// `model_<base36 ts>`.
pub fn sanitize_model_folder_name(name: &str) -> String {
    let trimmed = name.trim();
    let mut out = String::new();
    let mut in_run = false;
    for c in trimmed.chars() {
        if c.is_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    if out.is_empty() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("model_{}", crate::config::base36_pub(ts))
    } else {
        out
    }
}

pub(crate) fn rel_fwd(base: &Path, full: &Path) -> Option<String> {
    let rel = full.strip_prefix(base).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

fn walk_exp3(dir: &Path, base_dir: &Path, declared: &BTreeSet<String>, out: &mut Vec<Value>, depth: usize) {
    if depth > 6 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        let full = e.path();
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            walk_exp3(&full, base_dir, declared, out, depth + 1);
            continue;
        }
        let fname = e.file_name().to_string_lossy().to_string();
        if !fname.to_lowercase().ends_with(".exp3.json") {
            continue;
        }
        let rel = match rel_fwd(base_dir, &full) {
            Some(r) if !r.starts_with("..") => r,
            _ => continue,
        };
        // params = Id yang ditulis file (data rigger). Rusak → kosong, bukan error.
        let mut params: Vec<String> = Vec::new();
        if let Ok(txt) = std::fs::read_to_string(&full) {
            let clean = txt.strip_prefix('\u{feff}').unwrap_or(&txt);
            if let Ok(j) = serde_json::from_str::<Value>(clean) {
                if let Some(arr) = j.get("Parameters").and_then(|v| v.as_array()) {
                    for p in arr {
                        if let Some(id) = p.get("Id").and_then(|v| v.as_str()) {
                            if !params.contains(&id.to_string()) {
                                params.push(id.to_string());
                            }
                        }
                        if params.len() >= 64 {
                            break;
                        }
                    }
                }
            }
        }
        let name = fname
            .strip_suffix(".exp3.json")
            .or_else(|| fname.strip_suffix(".exp3.JSON"))
            .unwrap_or(&fname)
            .to_string();
        out.push(json!({
            "Name": name,
            "File": rel,
            "declared": declared.contains(&rel),
            "params": params
        }));
    }
}

/// discoverExpressions(name) → Ok(Value) atau Err(msg) (→ 404).
pub fn discover(model_dir: &Path, data_dir: &Path, name: &str) -> Result<Value, String> {
    if name.split(['\\', '/']).any(|s| s == "..") {
        return Err("not found".into());
    }
    let dir = model_dir.join(name);
    if !dir.starts_with(model_dir) || !dir.exists() {
        return Err("not found".into());
    }
    // Fallback Auto-Rescue (padanan TS): folder tanpa manifest → blueprint
    // in-memory; file user di disk tak tersentuh. Base dir = folder model.
    let (model3, base_dir, blueprint) = match find_model3(&dir, 0) {
        Some(m3) => {
            let base = m3.parent().unwrap_or(&dir).to_path_buf();
            (m3, base, None)
        }
        None => {
            let bp = crate::rescue::build_rescue_blueprint(&dir)
                .ok_or_else(|| "no model3.json in folder".to_string())?;
            (dir.join(crate::rescue::RESCUE_FILENAME), dir.clone(), Some(bp))
        }
    };

    // declared expressions dari model3 (File → forward slash). Untuk jalur
    // rescue, sumbernya blueprint di memori (File-nya relatif folder model).
    let mut declared: BTreeSet<String> = BTreeSet::new();
    let fr = match &blueprint {
        Some(bp) => bp.get("FileReferences").cloned().unwrap_or(Value::Null),
        None => std::fs::read_to_string(&model3)
            .ok()
            .map(|txt| {
                let clean = txt.strip_prefix('\u{feff}').unwrap_or(&txt);
                serde_json::from_str::<Value>(clean).unwrap_or(Value::Null)
            })
            .and_then(|mj| mj.get("FileReferences").cloned())
            .unwrap_or(Value::Null),
    };
    if let Some(ex) = fr.get("Expressions").and_then(|e| e.as_array()) {
        for e in ex {
            if let Some(file) = e.get("File").and_then(|v| v.as_str()) {
                declared.insert(file.replace('\\', "/"));
            }
        }
    }

    let mut found: Vec<Value> = Vec::new();
    walk_exp3(&dir, &base_dir, &declared, &mut found, 0);
    // TS memakai localeCompare (case-insensitive untuk ASCII); tiru dgn
    // banding lowercase supaya urutan sama (mis. "collar_blue" < "X_change").
    found.sort_by(|a, b| {
        let an = a["Name"].as_str().unwrap_or("").to_lowercase();
        let bn = b["Name"].as_str().unwrap_or("").to_lowercase();
        an.cmp(&bn)
    });
    let orphan = found.iter().filter(|f| f["declared"] == json!(false)).count();

    Ok(json!({
        "model3": rel_fwd(data_dir, &model3).unwrap_or_default(),
        "declaredCount": declared.len(),
        "expressions": found,
        "orphanCount": orphan
    }))
}

fn adopt_file(sheets_dir: &Path, name: &str) -> std::path::PathBuf {
    sheets_dir.join(format!("exp3-adoption_{}.json", sanitize_model_folder_name(name)))
}

/// GET /api/model/expressions-adoption?name=X → (status, body).
pub fn adoption_get(model_dir: &Path, data_dir: &Path, sheets_dir: &Path, name: &str) -> (u16, String) {
    let info = match discover(model_dir, data_dir, name) {
        Ok(v) => v,
        Err(e) => return (404, json!({ "error": e }).to_string()),
    };
    let mut disabled: BTreeSet<String> = BTreeSet::new();
    if let Ok(txt) = std::fs::read_to_string(adopt_file(sheets_dir, name)) {
        if let Ok(j) = serde_json::from_str::<Value>(&txt) {
            if let Some(arr) = j.get("disabled").and_then(|v| v.as_array()) {
                for d in arr {
                    if let Some(s) = d.as_str() {
                        disabled.insert(s.to_string());
                    }
                }
            }
        }
    }
    let exprs: Vec<Value> = info["expressions"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut e| {
            let nm = e["Name"].as_str().unwrap_or("").to_string();
            if let Some(o) = e.as_object_mut() {
                o.insert("enabled".into(), json!(!disabled.contains(&nm)));
            }
            e
        })
        .collect();
    (
        200,
        json!({
            "model3": info["model3"],
            "expressions": exprs,
            "disabled": disabled.iter().cloned().collect::<Vec<_>>()
        })
        .to_string(),
    )
}

/// POST /api/model/expressions-adoption {name, disabled:[]} → (status, body).
pub fn adoption_post(sheets_dir: &Path, body: &Value) -> (u16, String) {
    let name = sanitize_model_folder_name(body.get("name").and_then(|v| v.as_str()).unwrap_or(""));
    if name.is_empty() {
        return (500, json!({ "error": "name kosong" }).to_string());
    }
    let disabled: Vec<Value> = body
        .get("disabled")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter(|x| x.is_string()).cloned().collect())
        .unwrap_or_default();
    let file = adopt_file(sheets_dir, &name);
    match crate::sheet::write_json_atomic(&file, &json!({ "disabled": disabled.clone() })) {
        Ok(()) => (200, json!({ "ok": true, "disabled": disabled }).to_string()),
        Err(e) => (500, json!({ "error": e.to_string() }).to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_folder_name() {
        assert_eq!(sanitize_model_folder_name("神宫白子模型"), "神宫白子模型");
        assert_eq!(sanitize_model_folder_name("ren-official_2"), "ren-official_2");
        assert_eq!(sanitize_model_folder_name("a  b//c"), "a_b_c");
        // "!!!" → run karakter asing runtuh jadi satu "_" (sama TS, bukan fallback).
        assert_eq!(sanitize_model_folder_name("!!!"), "_");
        // benar-benar kosong → fallback bermakna.
        assert!(sanitize_model_folder_name("   ").starts_with("model_"));
    }

    #[test]
    fn discover_dan_adoption() {
        let data = std::env::temp_dir().join(format!("l2dexp-{}-{}", std::process::id(), crate::config::base36_pub(now())));
        let model_dir = data.join("model");
        let sheets = data.join("sheets");
        let m = model_dir.join("hana");
        std::fs::create_dir_all(&m).unwrap();
        std::fs::create_dir_all(&sheets).unwrap();
        // model3 dengan 1 expression declared
        std::fs::write(m.join("hana.model3.json"),
            r#"{"FileReferences":{"Expressions":[{"Name":"senyum","File":"exp/senyum.exp3.json"}]}}"#).unwrap();
        std::fs::create_dir_all(m.join("exp")).unwrap();
        std::fs::write(m.join("exp").join("senyum.exp3.json"),
            r#"{"Parameters":[{"Id":"ParamMouth","Value":1},{"Id":"ParamMouth","Value":1}]}"#).unwrap();
        std::fs::write(m.join("exp").join("marah.exp3.json"), r#"{"Parameters":[{"Id":"ParamBrow"}]}"#).unwrap();

        let info = discover(&model_dir, &data, "hana").unwrap();
        let ex = info["expressions"].as_array().unwrap();
        assert_eq!(ex.len(), 2);
        // sorted by Name: marah, senyum
        assert_eq!(ex[0]["Name"], "marah");
        assert_eq!(ex[0]["declared"], false); // orphan
        assert_eq!(ex[1]["Name"], "senyum");
        assert_eq!(ex[1]["declared"], true);
        assert_eq!(ex[1]["params"], json!(["ParamMouth"])); // deduped
        assert_eq!(info["orphanCount"], 1);

        // adoption: disable "marah"
        let (st, _) = adoption_post(&sheets, &json!({ "name": "hana", "disabled": ["marah"] }));
        assert_eq!(st, 200);
        let (_, body) = adoption_get(&model_dir, &data, &sheets, "hana");
        let v: Value = serde_json::from_str(&body).unwrap();
        let exg = v["expressions"].as_array().unwrap();
        let marah = exg.iter().find(|e| e["Name"] == "marah").unwrap();
        assert_eq!(marah["enabled"], false);
        let senyum = exg.iter().find(|e| e["Name"] == "senyum").unwrap();
        assert_eq!(senyum["enabled"], true);

        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn nested_bom_cjk_file_relatif_model3() {
        // Port test-exp3-adoption TS (guard): model3 di SUBDIR + ber-BOM;
        // declared File relatif ke DIR model3 (yang resolve loader), bukan
        // folder model; nama CJK utuh; file di luar dir model3 tak ikut.
        let data = std::env::temp_dir().join(format!("l2dexpn-{}-{}", std::process::id(), crate::config::base36_pub(now())));
        let model_dir = data.join("model");
        let sub = model_dir.join("char").join("nested");
        std::fs::create_dir_all(sub.join("expr")).unwrap();
        std::fs::create_dir_all(sub.join("deep").join("sub")).unwrap();
        // BOM di awal model3.json
        std::fs::write(
            sub.join("m.model3.json"),
            "\u{feff}{\"FileReferences\":{\"Expressions\":[{\"Name\":\"known\",\"File\":\"expr/known.exp3.json\"}]}}",
        )
        .unwrap();
        std::fs::write(sub.join("expr").join("known.exp3.json"), r#"{"Parameters":[{"Id":"P1"}]}"#).unwrap();
        std::fs::write(sub.join("expr").join("joy.exp3.json"), r#"{"Parameters":[]}"#).unwrap();
        std::fs::write(sub.join("deep").join("sub").join("wink.exp3.json"), r#"{"Parameters":[]}"#).unwrap();
        std::fs::write(sub.join("\u{5446}\u{732b}.exp3.json"), r#"{"Parameters":[]}"#).unwrap(); // 呆猫 CJK
        // di LUAR dir model3 → tetap di-walk (dir=char) tapi File relatif base
        // sub; file di luar folder model → tak tersentuh (di luar dir="char").
        std::fs::write(model_dir.join("char").join("outside.exp3.json"), r#"{"Parameters":[]}"#).unwrap();

        let info = discover(&model_dir, &data, "char").unwrap();
        assert_eq!(info["model3"], "model/char/nested/m.model3.json", "BOM model3 ter-resolve");
        let ex = info["expressions"].as_array().unwrap();
        let names: Vec<&str> = ex.iter().map(|e| e["Name"].as_str().unwrap()).collect();
        // rekursif dari folder model: joy + known + wink + 呆猫. File di LUAR
        // dir model3.json (outside) dikecualikan — guard rel ".." (loader tak
        // bisa resolve-nya), sama seperti TS.
        assert_eq!(ex.len(), 4, "{names:?}");
        assert!(names.iter().all(|n| *n != "outside"), "di luar dir model3 tak boleh ikut");
        let by = |n: &str| ex.iter().find(|e| e["Name"] == n).unwrap();
        // File relatif ke DIR model3.json: tanpa prefix nested/
        assert_eq!(by("joy")["File"], "expr/joy.exp3.json");
        assert_eq!(by("wink")["File"], "deep/sub/wink.exp3.json");
        assert_eq!(by("known")["declared"], true);
        assert_eq!(by("joy")["declared"], false);
        assert_eq!(by("呆猫")["Name"], "呆猫"); // nama CJK utuh
        assert_eq!(info["orphanCount"], 3);
        assert_eq!(info["declaredCount"], 1);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn params_edge_cases() {
        // params per ekspresi — rusak → [] (bukan error), tanpa Parameters
        // → [], Id duplikat didedupe, field lama (Name/File/declared) utuh.
        let data = std::env::temp_dir().join(format!("l2dexppe-{}-{}", std::process::id(), crate::config::base36_pub(now())));
        let model_dir = data.join("model");
        let m = model_dir.join("g");
        std::fs::create_dir_all(&m).unwrap();
        std::fs::write(m.join("m.model3.json"),
            r#"{"FileReferences":{"Expressions":[{"Name":"known","File":"known.exp3.json"}]}}"#).unwrap();
        std::fs::write(m.join("known.exp3.json"), r#"{"Parameters":[{"Id":"ParamEX04","Value":1},{"Id":"ParamEX08","Value":1}]}"#).unwrap();
        std::fs::write(m.join("orph.exp3.json"), r#"{"Parameters":[{"Id":"Param91","Value":0.5}]}"#).unwrap();
        std::fs::write(m.join("multi.exp3.json"), r#"{"Parameters":[{"Id":"A","Value":1},{"Id":"A","Value":2},{"Id":"B","Value":0}]}"#).unwrap();
        std::fs::write(m.join("broken.exp3.json"), "{ ini bukan json").unwrap();
        std::fs::write(m.join("noparams.exp3.json"), r#"{"Type":"Live2D Expression"}"#).unwrap();

        let info = discover(&model_dir, &data, "g").unwrap();
        let ex = info["expressions"].as_array().unwrap();
        assert_eq!(ex.len(), 5);
        let by = |n: &str| ex.iter().find(|e| e["Name"] == n).unwrap();
        assert_eq!(by("known")["params"], json!(["ParamEX04", "ParamEX08"]));
        assert_eq!(by("orph")["declared"], false);
        assert_eq!(by("orph")["params"], json!(["Param91"]));
        assert_eq!(by("multi")["params"], json!(["A", "B"]), "Id duplikat didedupe");
        assert_eq!(by("broken")["params"], json!([]), "rusak → [] bukan error");
        assert_eq!(by("noparams")["params"], json!([]));
        assert!(by("known").get("File").is_some() && by("known").get("declared").is_some());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn traversal_readonly_dan_terulang() {
        // Port guard exp3-adoption "SERVER guards" + "read-only guarantee":
        // ".." ditolak, nama tak ada → Err, discovery TIDAK menulis disk dan
        // idempoten (dipanggil dua kali → hasil identik).
        let data = std::env::temp_dir().join(format!("l2dexpr-{}-{}", std::process::id(), crate::config::base36_pub(now())));
        let model_dir = data.join("model");
        let m = model_dir.join("r");
        std::fs::create_dir_all(m.join("expr")).unwrap();
        std::fs::write(m.join("r.model3.json"), r#"{"FileReferences":{"Moc":"r.moc3","Textures":[]}}"#).unwrap();
        std::fs::write(m.join("r.moc3"), "M").unwrap();
        std::fs::write(m.join("expr/e.exp3.json"), r#"{"Parameters":[{"Id":"X"}]}"#).unwrap();

        assert!(discover(&model_dir, &data, "..").is_err());
        assert!(discover(&model_dir, &data, "../..").is_err());
        assert!(discover(&model_dir, &data, "tidak_ada").is_err());

        let before = std::fs::read(m.join("r.model3.json")).unwrap();
        let n = std::fs::read_dir(&m).unwrap().count();
        let first = discover(&model_dir, &data, "r").unwrap();
        let second = discover(&model_dir, &data, "r").unwrap();
        assert_eq!(first, second, "read-only + idempoten");
        assert_eq!(std::fs::read(m.join("r.model3.json")).unwrap(), before);
        assert_eq!(std::fs::read_dir(&m).unwrap().count(), n, "tak ada file dibuat/dihapus");

        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn folder_tanpa_manifest_pakai_blueprint_rescue() {
        // Padanan fallback TS pasca-Batch A: folder tanpa .model3.json →
        // discover tetap jalan lewat blueprint in-memory (bukan 404), semua
        // ekspresi blueprint dianggap declared, model3 = __rescue__.
        let data = std::env::temp_dir().join(format!("l2dexprz-{}-{}", std::process::id(), crate::config::base36_pub(now())));
        let model_dir = data.join("model");
        let m = model_dir.join("raw");
        std::fs::create_dir_all(m.join("fx")).unwrap();
        std::fs::write(m.join("karakter.moc3"), "MOC3").unwrap();
        std::fs::write(m.join("fx").join("happy.exp3.json"), r#"{"Parameters":[{"Id":"P1"}]}"#).unwrap();

        let info = discover(&model_dir, &data, "raw").unwrap();
        assert_eq!(info["model3"], "model/raw/__rescue__.model3.json");
        let ex = info["expressions"].as_array().unwrap();
        assert_eq!(ex.len(), 1);
        assert_eq!(ex[0]["declared"], true, "blueprint mendeklarasikan semua .exp3");
        assert_eq!(ex[0]["params"], json!(["P1"]));
        assert_eq!(info["orphanCount"], 0);

        // folder tanpa manifest DAN tanpa moc3 → tetap Err (bukan blueprint kosong)
        let bare = model_dir.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        assert!(discover(&model_dir, &data, "bare").is_err());

        let _ = std::fs::remove_dir_all(&data);
    }

    fn now() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
    }
}
