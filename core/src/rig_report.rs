//! rig_report.rs — RENCANA backlog Fase 1 (ringan, engine-side).
//!
//! Laporan rig per model dari disk. Saat ini membungkus `motion_analysis::analyze`
//! dan menambahkan:
//!   - daftar parameter lengkap dari cdi3 (termasuk yang tak terobservasi di motion),
//!     dengan provenance: observedNative / displayLabel / physicsOutput / heuristic,
//!   - hash ringkas model (nama+ukuran file model) untuk invalidasi cache klien.
//!
//! Ini sengaja ringan: resolver role & alias tetap di `role-mapping.ts` (klien)
//! — Rust tak menebak role. Provenance di sini hanya menyatakan "dari mana
//! angka ini berasal", bukan makna semantik.

use std::collections::BTreeSet;
use std::path::Path;

use serde_json::{json, Value};

use crate::motion_analysis;
use crate::model;

pub fn analyze(model_dir: &Path, data_dir: &Path, name: &str) -> Result<Value, String> {
    if name.split(['\\', '/']).any(|s| s == ".." || s.is_empty()) {
        return Err("not found".into());
    }
    let folder = motion_analysis::resolve_model_folder(model_dir, name)
        .ok_or_else(|| "not found".to_string())?;
    let dir = model_dir.join(&folder);
    if !dir.starts_with(model_dir) || !dir.exists() {
        return Err("not found".into());
    }

    let base_analysis = motion_analysis::analyze(model_dir, data_dir, name, None)?;

    // Set param yang terobservasi dari motion native.
    let observed: BTreeSet<String> = base_analysis
        .get("params")
        .and_then(|v| v.as_object())
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();

    // model3 + cdi3 path (sama pola dengan motion_analysis).
    let model3 = model::find_model3(&dir, 0);
    let base = model3
        .as_ref()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| dir.clone());
    let fr = model3
        .as_ref()
        .and_then(|p| read_json(p))
        .and_then(|mj| mj.get("FileReferences").cloned())
        .unwrap_or(Value::Null);
    let cdi_rel = fr.get("DisplayInfo").and_then(|v| v.as_str());
    let find_single = |suffix: &str| -> Option<std::path::PathBuf> {
        let mut hits: Vec<std::path::PathBuf> = Vec::new();
        collect_by_suffix(&dir, suffix, &mut hits, 0);
        hits.into_iter().next()
    };
    let cdi_path = cdi_rel.map(|r| base.join(r)).filter(|p| p.exists())
        .or_else(|| find_single(".cdi3.json"));

    // param CANDIDATE list from cdi3, terlepas dari observed.
    let mut cdi_params: Vec<(String, String)> = Vec::new();
    if let Some(cp) = &cdi_path {
        if let Some(cdi) = read_json(cp) {
            if let Some(ps) = cdi.get("Parameters").and_then(|v| v.as_array()) {
                for p in ps {
                    if let (Some(id), Some(nm)) = (
                        p.get("Id").and_then(|v| v.as_str()),
                        p.get("Name").and_then(|v| v.as_str()),
                    ) {
                        cdi_params.push((id.to_string(), nm.to_string()));
                    }
                }
            }
        }
    }

    let physics_outputs: BTreeSet<String> = base_analysis
        .get("physicsOutputs")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    // provenance per param (cdi existence + observed native + physics output).
    let mut provenance = serde_json::Map::new();
    // params yang ada di cdi:
    for (id, nm) in &cdi_params {
        let mut srcs = Vec::new();
        if observed.contains(id) {
            srcs.push("curveClassified");
        } else {
            srcs.push("unclassified");
        }
        srcs.push("displayLabel");
        if physics_outputs.contains(id) {
            srcs.push("physicsOutput");
        }
        provenance.insert(id.clone(), json!({ "sources": srcs, "label": nm }));
    }
    // params observed tapi tidak ada di cdi (mungkin model tanpa cdi):
    if let Some(obj) = base_analysis.get("params").and_then(|v| v.as_object()) {
        for id in obj.keys() {
            if !provenance.contains_key(id) {
                let mut srcs = vec!["curveClassified".to_string()];
                if physics_outputs.contains(id) {
                    srcs.push("physicsOutput".into());
                }
                provenance.insert(id.clone(), json!({ "sources": srcs }));
            }
        }
    }

    // hash ringkas: gabungan path + size semua file model (TIDAK isi file penuh
    // untuk murah). Klien boleh menyimpan dan menandai stale bila berubah.
    let model_hash = hash_model_dir(&dir);

    let mut out = base_analysis;
    if let Some(o) = out.as_object_mut() {
        o.insert("rigReport".into(), json!(true));
        o.insert("provenance".into(), Value::Object(provenance.clone()));
        o.insert("modelHash".into(), json!(model_hash));
        // convenience: list id yang unclassified (tidak terobservasi native).
        let unclassified: Vec<String> = provenance
            .iter()
            .filter(|(_, v)| {
                v.get("sources")
                    .and_then(|s| s.as_array())
                    .map(|a| a.iter().any(|x| x.as_str() == Some("unclassified")))
                    .unwrap_or(false)
            })
            .map(|(k, _)| k.clone())
            .collect();
        o.insert("unclassified".into(), json!(unclassified));
    }
    Ok(out)
}

fn read_json(path: &Path) -> Option<Value> {
    let txt = std::fs::read_to_string(path).ok()?;
    let clean = txt.strip_prefix('\u{feff}').unwrap_or(&txt);
    serde_json::from_str::<Value>(clean).ok()
}

fn collect_by_suffix(dir: &Path, suffix: &str, out: &mut Vec<std::path::PathBuf>, depth: usize) {
    if depth > 3 {
        return;
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let full = e.path();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                collect_by_suffix(&full, suffix, out, depth + 1);
            } else if e
                .file_name()
                .to_string_lossy()
                .to_lowercase()
                .ends_with(suffix)
            {
                out.push(full);
            }
        }
    }
}

fn hash_model_dir(dir: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    walk_files(dir, &mut files);
    files.sort();
    for f in files {
        if let Ok(md) = std::fs::metadata(&f) {
            md.len().hash(&mut h);
        }
        f.to_string_lossy().hash(&mut h);
    }
    format!("{:016x}", h.finish())
}

fn walk_files(d: &Path, out: &mut Vec<std::path::PathBuf>) {
    if let Ok(rd) = std::fs::read_dir(d) {
        for e in rd.flatten() {
            let full = e.path();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                walk_files(&full, out);
            } else {
                out.push(full);
            }
        }
    }
}