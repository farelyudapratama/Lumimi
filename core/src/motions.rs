//! Rute motions READ/WRITE/DELETE.
//! Motion buatan user disimpan di `data/motions/<key>/<id>.motion.json`.
//! Semua tulisan lewat `motion_dsl::sanitize_motion_asset` (satu-satunya
//! entrypoint sanitize sisi Rust).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::sheet::sanitize_key;

/// Key motion ala klien: `sanitize(modelPath)` — modelPath = path model3
/// relatif `data/` hasil `/api/model/path` (dipakai runtime & Motion Studio).
/// Path folder `data/model/<folder>/…` TIDAK menghasilkan key ini.
fn client_motion_key(model_key: &str) -> String {
    sanitize_key(model_key)
}

/// Semua kandidat key untuk sebuah identitas model (urutan cek LIST/GET):
/// 1. key apa adanya (key klien sudah benar),
/// 2. key dari NAMA FOLDER model (warisan: motion lama tersimpan saat
///    identitas masih nama folder, mis. `data/motions/lumine/`),
/// 3. key ala klien dari path model3 (`model/...` disanitasi).
fn candidate_keys(motions_root: &Path, model_key: &str) -> Vec<PathBuf> {
    let mut out = vec![motions_root.join(client_motion_key(model_key))];
    let model_root = match motions_root.parent() {
        Some(d) => d.join("model"),
        None => return out,
    };
    // Resolusi identitas → folder model → kandidat tambahan.
    let Some(folder) = crate::motion_analysis::resolve_model_folder(&model_root, model_key) else {
        return out;
    };
    let push = |k: String, out: &mut Vec<PathBuf>| {
        if !out.iter().any(|p| p.file_name().map(|f| f == std::ffi::OsStr::new(&k)).unwrap_or(false)) {
            out.push(motions_root.join(k));
        }
    };
    // 2) Nama folder.
    push(sanitize_key(&folder), &mut out);
    // 3) Path model3 (bila beda dari dua di atas).
    let dir = model_root.join(&folder);
    if dir.starts_with(&model_root) && dir.is_dir() {
        if let Some(m3) = crate::model::find_model3(&dir, 0) {
            if let Ok(rel) = m3.strip_prefix(motions_root.parent().unwrap_or(m3.as_path())) {
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                push(sanitize_key(&rel_str), &mut out);
            }
        }
    }
    out
}

fn motions_dir_for(motions_root: &Path, model_key: &str) -> Option<PathBuf> {
    let dir = motions_root.join(sanitize_key(model_key));
    if dir.starts_with(motions_root) {
        Some(dir)
    } else {
        None
    }
}

/// Validasi id motion (padanan `/^[A-Za-z0-9_\-]{1,60}$/`).
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 60
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn motion_file_for(motions_root: &Path, model_key: &str, id: &str) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    let dir = motions_dir_for(motions_root, model_key)?;
    let file = dir.join(format!("{id}.motion.json"));
    if file.starts_with(motions_root) {
        Some(file)
    } else {
        None
    }
}

/// GET /api/motions?model=X → {motions:[...]} (parse tiap *.motion.json).
/// Membaca SEMUA kandidat key (key klien + warisan nama-folder) lalu menggabung
/// — motion lama yang tersimpan di bawah identitas beda tetap terlihat.
pub fn list_motions(motions_root: &Path, model_key: &str) -> Value {
    let mut out: Vec<Value> = Vec::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for dir in candidate_keys(motions_root, model_key) {
        if let Ok(rd) = std::fs::read_dir(&dir) {
            let mut names: Vec<_> = rd
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(".motion.json"))
                .collect();
            names.sort_by_key(|e| e.file_name());
            for e in names {
                if let Ok(txt) = std::fs::read_to_string(e.path()) {
                    let clean = txt.strip_prefix('\u{feff}').unwrap_or(&txt);
                    if let Ok(v) = serde_json::from_str::<Value>(clean) {
                        // Dedup by id: kandidat pertama (key klien) menang.
                        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        if !seen_ids.insert(id) {
                            continue;
                        }
                        out.push(v);
                    }
                }
            }
        }
    }
    json!({ "motions": out })
}

/// GET /api/motions/:id?model=X → (status, body). Cek semua kandidat key.
pub fn get_motion(motions_root: &Path, model_key: &str, id: &str) -> (u16, String) {
    if !valid_id(id) {
        return (400, json!({ "error": "motion id tidak valid" }).to_string());
    }
    for dir in candidate_keys(motions_root, model_key) {
        let file = dir.join(format!("{id}.motion.json"));
        if !file.starts_with(motions_root) {
            continue;
        }
        if let Ok(txt) = std::fs::read_to_string(&file) {
            return (200, txt.strip_prefix('\u{feff}').unwrap_or(&txt).to_string());
        }
    }
    (404, json!({ "error": "not found" }).to_string())
}

/// POST /api/motions — buat asset baru (sudah disanitasi pemanggil).
/// Menolak bila id sudah ada (409, padanan handleMotionsPost: "sudah ada.
/// Pakai nama lain atau Simpan (timpa)"). Buat dir bila perlu.
pub fn create_motion(motions_root: &Path, model_key: &str, id: &str, asset: &Value) -> (u16, String) {
    let file = match motion_file_for(motions_root, model_key, id) {
        Some(f) => f,
        None => return (400, json!({ "error": "motion id tidak valid" }).to_string()),
    };
    if file.exists() {
        return (
            409,
            json!({ "error": format!("motion \"{id}\" sudah ada. Pakai nama lain atau Simpan (timpa).") }).to_string(),
        );
    }
    write_motion(motions_root, model_key, id, asset)
}

/// PUT /api/motions/:id?model=X — tulis asset (sudah disanitasi pemanggil).
/// Buat dir bila perlu. Return (status, body).
pub fn write_motion(motions_root: &Path, model_key: &str, id: &str, asset: &Value) -> (u16, String) {
    let file = match motion_file_for(motions_root, model_key, id) {
        Some(f) => f,
        None => return (400, json!({ "error": "motion id tidak valid" }).to_string()),
    };
    if let Some(dir) = file.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return (400, json!({ "error": "gagal membuat folder motion" }).to_string());
        }
    }
    match crate::sheet::write_json_atomic(&file, asset) {
        Ok(()) => (200, json!({ "ok": true, "motion": asset }).to_string()),
        Err(e) => (400, json!({ "error": e.to_string() }).to_string()),
    }
}

/// DELETE /api/motions/:id?model=X → (status, body). Hapus dari kandidat
/// pertama yang punya filenya (key klien dulu, lalu warisan).
pub fn delete_motion(motions_root: &Path, model_key: &str, id: &str) -> (u16, String) {
    if !valid_id(id) {
        return (400, json!({ "error": "motion id tidak valid" }).to_string());
    }
    for dir in candidate_keys(motions_root, model_key) {
        let file = dir.join(format!("{id}.motion.json"));
        if !file.starts_with(motions_root) || !file.exists() {
            continue;
        }
        return match std::fs::remove_file(&file) {
            Ok(()) => (200, json!({ "ok": true }).to_string()),
            Err(e) => (400, json!({ "error": e.to_string() }).to_string()),
        };
    }
    (400, json!({ "error": "not found" }).to_string())
}

// ── Alias klip native (rename non-destruktif) ───────────────────────────
// Nama tampilan klip .motion3.json milik model dioverlay lewat file
// `native-aliases.json` di folder motion user — file model TIDAK PERNAH
// ditulis (paritas prinsip adopsi in-memory; lihat MODEL-AGNOSTIC-RULES.md
// "in-memory saja, jangan tulis ke file model"). Key map = path File klip
// persis seperti di manifest (relatif folder model3.json, forward-slash).

const NATIVE_ALIASES_FILE: &str = "native-aliases.json";

fn native_aliases_file_for(motions_root: &Path, model_key: &str) -> Option<PathBuf> {
    let dir = motions_dir_for(motions_root, model_key)?;
    if !dir.starts_with(motions_root) {
        return None;
    }
    Some(dir.join(NATIVE_ALIASES_FILE))
}

/// Key alias = path File klip. Traversal ("..") dan karakter kontrol ditolak —
/// key dipakai klien untuk lookup, tapi jangan jadi lubang penulisan sembarangan.
fn valid_alias_key(file: &str) -> bool {
    !file.is_empty()
        && file.len() <= 300
        && !file.split(['\\', '/']).any(|seg| seg == "..")
        && file.chars().all(|c| !c.is_control())
}

/// GET helper — baca overlay alias. File absen/rusak = map kosong (bukan error):
/// alias adalah garnish, kegagalannya tidak boleh mematikan daftar klip.
pub fn get_native_aliases(motions_root: &Path, model_key: &str) -> Value {
    let empty = json!({ "version": 1, "aliases": {} });
    let Some(f) = native_aliases_file_for(motions_root, model_key) else {
        return empty;
    };
    match std::fs::read_to_string(&f) {
        Ok(txt) => serde_json::from_str::<Value>(txt.strip_prefix('\u{feff}').unwrap_or(&txt))
            .unwrap_or(empty),
        Err(_) => empty,
    }
}

/// POST helper — set satu alias; `name` kosong = hapus alias (kembali ke nama
/// asli klip). Return (status, body JSON string).
pub fn set_native_alias(motions_root: &Path, model_key: &str, file: &str, name: &str) -> (u16, String) {
    if !valid_alias_key(file) {
        return (400, json!({ "error": "file key tidak valid" }).to_string());
    }
    let Some(f) = native_aliases_file_for(motions_root, model_key) else {
        return (400, json!({ "error": "model key tidak valid" }).to_string());
    };
    let mut doc = get_native_aliases(motions_root, model_key);
    let Some(obj) = doc.as_object_mut() else {
        return (400, json!({ "error": "dokumen alias tidak valid" }).to_string());
    };
    let aliases = obj.entry("aliases").or_insert_with(|| json!({}));
    let Some(amap) = aliases.as_object_mut() else {
        return (400, json!({ "error": "dokumen alias tidak valid" }).to_string());
    };
    let trimmed = name.trim();
    if trimmed.is_empty() {
        amap.remove(file);
    } else {
        if trimmed.len() > 80 || trimmed.chars().any(|c| c.is_control()) {
            return (400, json!({ "error": "nama alias tidak valid" }).to_string());
        }
        amap.insert(file.to_string(), json!(trimmed));
    }
    if let Some(dir) = f.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let aliases_now = obj.get("aliases").cloned().unwrap_or(json!({}));
    match crate::sheet::write_json_atomic(&f, &doc) {
        Ok(()) => (200, json!({ "ok": true, "aliases": aliases_now }).to_string()),
        Err(e) => (400, json!({ "error": e.to_string() }).to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_get_delete() {
        let root = std::env::temp_dir().join(format!("l2dmot-{}-{}", std::process::id(), now()));
        let mdir = root.join("hana");
        std::fs::create_dir_all(&mdir).unwrap();
        std::fs::write(mdir.join("wave.motion.json"), r#"{"id":"wave","frames":[]}"#).unwrap();
        std::fs::write(mdir.join("bogus.txt"), "x").unwrap(); // diabaikan

        let list = list_motions(&root, "hana");
        assert_eq!(list["motions"].as_array().unwrap().len(), 1);
        assert_eq!(list["motions"][0]["id"], "wave");

        let (st, body) = get_motion(&root, "hana", "wave");
        assert_eq!(st, 200);
        assert!(body.contains("\"wave\""));

        // id tak valid → 400
        assert_eq!(get_motion(&root, "hana", "../etc").0, 400);
        assert_eq!(get_motion(&root, "hana", "nihil").0, 404);

        let (std_, _) = delete_motion(&root, "hana", "wave");
        assert_eq!(std_, 200);
        assert_eq!(get_motion(&root, "hana", "wave").0, 404);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Motion warisan tersimpan di key lain (nama folder) tetap terlihat dari
    /// key klien (path model3 disanitasi) — kasus "tersimpan tapi tak muncul".
    #[test]
    fn list_gabung_motion_warisan_lintas_key() {
        // Layout produksi: <data>/motions + <data>/model (sibling).
        let data = std::env::temp_dir().join(format!("l2dmot2-{}-{}", std::process::id(), now()));
        let root = data.join("motions");
        let m = data.join("model").join("hana");
        std::fs::create_dir_all(m.join("sub")).unwrap();
        std::fs::write(m.join("sub").join("hana.model3.json"), "{}").unwrap();
        // Warisan: key nama folder "hana".
        std::fs::create_dir_all(root.join("hana")).unwrap();
        std::fs::write(root.join("hana").join("old.motion.json"), r#"{"id":"old","frames":[]}"#).unwrap();
        // Baru: key ala klien model_hana_sub_hana_model3_json.
        std::fs::create_dir_all(root.join("model_hana_sub_hana_model3_json")).unwrap();
        std::fs::write(
            root.join("model_hana_sub_hana_model3_json").join("new.motion.json"),
            r#"{"id":"new","frames":[]}"#,
        )
        .unwrap();

        // LIST via key klien harus menggabung keduanya.
        let list = list_motions(&root, "model_hana_sub_hana_model3_json");
        let ids: Vec<&str> = list["motions"].as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap()).collect();
        assert!(ids.contains(&"new"), "{ids:?}");
        assert!(ids.contains(&"old"), "warisan harus terlihat: {ids:?}");

        // GET & DELETE warisan via key klien juga harus jalan.
        assert_eq!(get_motion(&root, "model_hana_sub_hana_model3_json", "old").0, 200);
        assert_eq!(delete_motion(&root, "model_hana_sub_hana_model3_json", "old").0, 200);
        assert_eq!(get_motion(&root, "model_hana_sub_hana_model3_json", "old").0, 404);

        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn create_menolak_duplikat_409() {
        let root = std::env::temp_dir().join(format!("l2dmotc-{}-{}", std::process::id(), now()));
        let asset = serde_json::json!({"id":"jump","frames":[]});
        assert_eq!(create_motion(&root, "hana", "jump", &asset).0, 200);
        let (st, body) = create_motion(&root, "hana", "jump", &asset);
        assert_eq!(st, 409);
        assert!(body.contains("sudah ada"));
        // PUT (write) tetap bisa timpa.
        assert_eq!(write_motion(&root, "hana", "jump", &asset).0, 200);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn alias_native_set_get_hapus() {
        let root = std::env::temp_dir().join(format!("l2dmota-{}-{}", std::process::id(), now()));
        // Awal: kosong (file absen bukan error).
        assert_eq!(get_native_aliases(&root, "hana")["aliases"].as_object().unwrap().len(), 0);
        // Set dua alias.
        let (st, _) = set_native_alias(&root, "hana", "motions/a.motion3.json", "Lambaikan");
        assert_eq!(st, 200);
        let (st, _) = set_native_alias(&root, "hana", "motions/b.motion3.json", "Kedip");
        assert_eq!(st, 200);
        let doc = get_native_aliases(&root, "hana");
        assert_eq!(doc["aliases"]["motions/a.motion3.json"], "Lambaikan");
        // Nama kosong = hapus alias; file lain tetap.
        let (st, _) = set_native_alias(&root, "hana", "motions/a.motion3.json", "  ");
        assert_eq!(st, 200);
        let doc = get_native_aliases(&root, "hana");
        assert!(doc["aliases"].get("motions/a.motion3.json").is_none());
        assert_eq!(doc["aliases"]["motions/b.motion3.json"], "Kedip");
        // Traversal ditolak.
        assert_eq!(set_native_alias(&root, "hana", "../evil.json", "x").0, 400);
        // Nama dengan karakter kontrol ditolak.
        assert_eq!(set_native_alias(&root, "hana", "motions/b.motion3.json", "a\nb").0, 400);
        let _ = std::fs::remove_dir_all(&root);
    }

    fn now() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
    }
}
