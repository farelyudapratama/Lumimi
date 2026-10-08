//! Multi-session assistant.
//! Store `data/assistant-sessions.json`: {active, sessions:[{id,name,workDir,
//! ts,messages}]}. cap 20 sesi (FIFO), history cap 60. Migrasi sekali dari
//! `data/assistant-history.json` (format lama) → satu sesi.
//!
//! State: dibaca/ditulis per-panggil (tak ada cache lintas-proses seperti TS,
//! karena core bisa single-run — tiap operasi load→mutate→save atomik).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

const MAX_SESSIONS: usize = 20;
const MAX_HISTORY: usize = 60;

fn store_path(data_dir: &Path) -> PathBuf {
    data_dir.join("assistant-sessions.json")
}
fn legacy_path(data_dir: &Path) -> PathBuf {
    data_dir.join("assistant-history.json")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn session_id() -> String {
    let ms = now_ms() as u128;
    let rnd: u32 = {
        // pseudo-acak sederhana dari waktu (cukup untuk id sesi lokal).
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
        n ^ (ms as u32)
    };
    format!("s_{}_{}", crate::config::base36_pub(ms), crate::config::base36_pub(rnd as u128))
}

fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Nama sesi: pesan user pertama bermakna, else "Sesi YYYY-MM-DD".
fn derive_name(messages: &[Value]) -> String {
    let first = messages.iter().find(|m| {
        m.get("role").and_then(|r| r.as_str()) == Some("user")
            && m.get("content").and_then(|c| c.as_str()).map(|s| {
                let t = s.trim();
                !t.is_empty() && t != "Lanjutkan tugas berdasarkan hasil tool di atas."
            }).unwrap_or(false)
    });
    if let Some(m) = first {
        let raw = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
        let collapsed: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if !collapsed.is_empty() {
            return take_chars(&collapsed, 40);
        }
    }
    let now = chrono::Local::now();
    format!("Sesi {}", now.format("%Y-%m-%d"))
}

fn normalize(f: &Value) -> Value {
    let mut sessions: Vec<Value> = f
        .get("sessions")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|s| s.get("id").and_then(|i| i.as_str()).is_some())
                .map(|s| {
                    let msgs: Vec<Value> = s.get("messages").and_then(|m| m.as_array()).map(|a| {
                        let start = a.len().saturating_sub(MAX_HISTORY);
                        a[start..].to_vec()
                    }).unwrap_or_default();
                    json!({
                        "id": s.get("id").and_then(|i| i.as_str()).unwrap_or(""),
                        "name": take_chars(s.get("name").and_then(|n| n.as_str()).unwrap_or("Sesi"), 80),
                        "workDir": s.get("workDir").and_then(|w| w.as_str()).unwrap_or(""),
                        "ts": s.get("ts").and_then(|t| t.as_i64()).unwrap_or_else(now_ms),
                        "messages": msgs
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if sessions.len() > MAX_SESSIONS {
        let start = sessions.len() - MAX_SESSIONS;
        sessions = sessions[start..].to_vec();
    }
    let active_in = f.get("active").and_then(|a| a.as_str()).unwrap_or("");
    let active = if sessions.iter().any(|s| s.get("id").and_then(|i| i.as_str()) == Some(active_in)) {
        active_in.to_string()
    } else {
        sessions.last().and_then(|s| s.get("id").and_then(|i| i.as_str())).unwrap_or("").to_string()
    };
    json!({ "active": active, "sessions": sessions })
}

/// Muat store (dengan migrasi sekali dari format lama bila perlu).
pub fn load(data_dir: &Path) -> Value {
    if let Ok(raw) = std::fs::read_to_string(store_path(data_dir)) {
        if let Ok(j) = serde_json::from_str::<Value>(&raw) {
            return normalize(&j);
        }
    }
    // migrasi legacy assistant-history.json
    if let Ok(raw) = std::fs::read_to_string(legacy_path(data_dir)) {
        if let Ok(j) = serde_json::from_str::<Value>(&raw) {
            if let Some(hist) = j.get("history").and_then(|h| h.as_array()) {
                if !hist.is_empty() {
                    let start = hist.len().saturating_sub(MAX_HISTORY);
                    let msgs = hist[start..].to_vec();
                    let rec = json!({
                        "id": session_id(),
                        "name": derive_name(&msgs),
                        "workDir": j.get("workDir").and_then(|w| w.as_str()).unwrap_or(""),
                        "ts": now_ms(),
                        "messages": msgs
                    });
                    let store = normalize(&json!({ "active": rec["id"], "sessions": [rec] }));
                    let _ = save(data_dir, &store);
                    let _ = std::fs::rename(legacy_path(data_dir), legacy_path(data_dir).with_extension("json.bak"));
                    return store;
                }
            }
        }
    }
    json!({ "active": "", "sessions": [] })
}

fn save(data_dir: &Path, store: &Value) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = store_path(data_dir);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(store).unwrap_or_else(|_| "{}".into()))?;
    std::fs::rename(&tmp, &path)
}

/// Ringkasan untuk UI (tanpa messages, +count).
pub fn list(data_dir: &Path) -> Value {
    let f = load(data_dir);
    let sessions: Vec<Value> = f.get("sessions").and_then(|s| s.as_array()).map(|arr| {
        arr.iter().map(|s| json!({
            "id": s["id"], "name": s["name"], "workDir": s["workDir"], "ts": s["ts"],
            "count": s.get("messages").and_then(|m| m.as_array()).map(|a| a.len()).unwrap_or(0)
        })).collect()
    }).unwrap_or_default();
    json!({ "active": f["active"], "sessions": sessions })
}

/// Buat sesi baru (jadi aktif). Return rekaman.
pub fn create(data_dir: &Path, work_dir: &str) -> Value {
    let mut f = load(data_dir);
    let rec = json!({
        "id": session_id(),
        "name": format!("Sesi {}", chrono::Local::now().format("%Y-%m-%d %H:%M")),
        "workDir": work_dir,
        "ts": now_ms(),
        "messages": []
    });
    let active = f["active"].as_str().unwrap_or("").to_string();
    let arr = f["sessions"].as_array_mut().unwrap();
    arr.push(rec.clone());
    if arr.len() > MAX_SESSIONS {
        if let Some(idx) = arr.iter().position(|s| s.get("id").and_then(|i| i.as_str()) != Some(active.as_str())) {
            arr.remove(idx);
        } else {
            arr.remove(0);
        }
    }
    f["active"] = rec["id"].clone();
    let _ = save(data_dir, &f);
    rec
}

/// Pesan tersimpan satu sesi (untuk hydrate runtime). None bila id tak dikenal.
pub fn messages(data_dir: &Path, id: &str) -> Option<Vec<Value>> {
    let f = load(data_dir);
    f["sessions"].as_array()?.iter().find(|s| s.get("id").and_then(|i| i.as_str()) == Some(id))?
        .get("messages").and_then(|m| m.as_array()).cloned()
}

/// Tambah giliran user/assistant ke sesi (persist transcript agent). Cap
/// MAX_HISTORY per sesi. No-op diam bila id tak dikenal / tidak ada giliran /
/// role di luar user|assistant — penyimpanan tidak boleh pernah menggagalkan
/// tugas yang sedang jalan.
pub fn append(data_dir: &Path, id: &str, turns: &[Value]) {
    if turns.is_empty() || id.is_empty() {
        return;
    }
    let clean: Vec<Value> = turns.iter().filter(|t| {
        let role = t.get("role").and_then(|r| r.as_str()).unwrap_or("");
        (role == "user" || role == "assistant")
            && t.get("content").and_then(|c| c.as_str()).map(|c| !c.trim().is_empty()).unwrap_or(false)
    }).map(|t| json!({
        "role": t["role"],
        "content": take_chars(t.get("content").and_then(|c| c.as_str()).unwrap_or("").trim(), 4000),
    })).collect();
    if clean.is_empty() {
        return;
    }
    let mut f = load(data_dir);
    let Some(sess) = f["sessions"].as_array_mut().unwrap().iter_mut()
        .find(|s| s.get("id").and_then(|i| i.as_str()) == Some(id))
    else { return };
    if let Some(arr) = sess.get_mut("messages").and_then(|m| m.as_array_mut()) {
        arr.extend(clean);
        let len = arr.len();
        if len > MAX_HISTORY {
            arr.drain(0..len - MAX_HISTORY);
        }
    }
    sess["ts"] = json!(now_ms());
    let _ = save(data_dir, &f);
}

/// Sesi "run" aplikasi: SATU sesi baru per proses (app dibuka = sesi agent
/// baru), dibuat lazy saat permukaan pertama menyentuh agent (hand-off chat
/// atau start panel). Memo per-proses supaya panggilan berulang idempoten;
/// sesi run yang dihapus user → dibuat lagi pada panggilan berikutnya.
pub fn ensure_run_session(data_dir: &Path) -> Value {
    static RUN: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
    let mut memo = RUN.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(id) = memo.as_deref() {
        let f = load(data_dir);
        if let Some(rec) = f["sessions"].as_array().unwrap().iter()
            .find(|s| s.get("id").and_then(|i| i.as_str()) == Some(id))
        {
            return rec.clone();
        }
        memo.take(); // sesi run dihapus user — buat ulang di bawah.
    }
    let rec = create_run(data_dir);
    *memo = Some(rec["id"].as_str().unwrap_or("").to_string());
    rec
}

/// Buat sesi run TANPA memo (selalu sesi baru) — testable.
pub fn create_run(data_dir: &Path) -> Value {
    create(data_dir, "")
}

/// Pindah sesi aktif. Return rekaman atau None.
pub fn switch_to(data_dir: &Path, id: &str) -> Option<Value> {
    let mut f = load(data_dir);
    let found = f["sessions"].as_array().unwrap().iter().find(|s| s.get("id").and_then(|i| i.as_str()) == Some(id)).cloned();
    if found.is_some() {
        f["active"] = json!(id);
        let _ = save(data_dir, &f);
    }
    found
}

/// Hapus sesi. Return (ok, new_active).
pub fn remove(data_dir: &Path, id: &str) -> (bool, String) {
    let mut f = load(data_dir);
    let arr = f["sessions"].as_array_mut().unwrap();
    let idx = arr.iter().position(|s| s.get("id").and_then(|i| i.as_str()) == Some(id));
    let idx = match idx {
        Some(i) => i,
        None => return (false, String::new()),
    };
    arr.remove(idx);
    if f["active"].as_str() == Some(id) {
        let next = f["sessions"].as_array().unwrap().last().and_then(|s| s.get("id").and_then(|i| i.as_str())).unwrap_or("").to_string();
        f["active"] = json!(next);
    }
    let new_active = f["active"].as_str().unwrap_or("").to_string();
    let _ = save(data_dir, &f);
    (true, new_active)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_switch_remove() {
        let data = std::env::temp_dir().join(format!("l2dsess-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&data).unwrap();

        assert_eq!(list(&data)["sessions"].as_array().unwrap().len(), 0);
        let a = create(&data, "/proj/a");
        let aid = a["id"].as_str().unwrap().to_string();
        assert!(aid.starts_with("s_"));
        assert_eq!(list(&data)["active"], json!(aid));
        let b = create(&data, "/proj/b");
        let bid = b["id"].as_str().unwrap().to_string();
        assert_eq!(list(&data)["active"], json!(bid));
        // switch balik ke a
        assert!(switch_to(&data, &aid).is_some());
        assert_eq!(list(&data)["active"], json!(aid));
        assert!(switch_to(&data, "nope").is_none());
        // hapus aktif (a) → aktif pindah ke sisa (b)
        let (ok, new_active) = remove(&data, &aid);
        assert!(ok);
        assert_eq!(new_active, bid);
        assert_eq!(list(&data)["sessions"].as_array().unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn cap_20_sesi_bukan_yang_aktif() {
        // Port agent-sessions.test.ts "cap 20 sesi": sesi ke-21 → yang dibuang
        // bukan yang aktif; sesi aktif bertahan & persist di disk.
        let data = std::env::temp_dir().join(format!("l2dsesscap-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&data).unwrap();
        let first = create(&data, "/p/first");
        let first_id = first["id"].as_str().unwrap().to_string();
        for i in 0..19 {
            create(&data, &format!("/p/{i}"));
        }
        let active = create(&data, "/p/active");
        let active_id = active["id"].as_str().unwrap().to_string();
        let f = list(&data);
        let sessions = f["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), MAX_SESSIONS);
        assert_eq!(f["active"], json!(active_id));
        assert!(sessions.iter().any(|s| s["id"] == json!(active_id)), "aktif tidak boleh terbuang");
        // FIFO: yang terbuang = yang TERTUA di depan (sesi pertama non-aktif).
        assert!(sessions.iter().all(|s| s["id"] != json!(first_id)), "korban cap harus sesi tertua");
        // round-trip disk: store dibaca ulang dari file yang ditulis (load≠list)
        assert_eq!(load(&data)["active"], json!(active_id));
        // hapus non-aktif → daftar menyusut, aktif tak berubah
        let non_active = sessions.iter().find(|s| s["id"] != json!(active_id)).unwrap();
        let victim = non_active["id"].as_str().unwrap().to_string();
        let (ok, new_active) = remove(&data, &victim);
        assert!(ok);
        assert_eq!(new_active, active_id, "hapus non-aktif tidak mengubah sesi aktif");
        assert_eq!(list(&data)["active"], json!(active_id));
        assert!(list(&data)["sessions"].as_array().unwrap().len() == MAX_SESSIONS - 1);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn append_dan_messages_roundtrip() {
        let data = std::env::temp_dir().join(format!("l2dsessap-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&data).unwrap();
        let rec = create(&data, "/p/x");
        let id = rec["id"].as_str().unwrap().to_string();

        // append kosong / id asing → no-op, store tak berubah.
        append(&data, &id, &[]);
        append(&data, "s_tidak_ada", &[json!({"role":"user","content":"hmm"})]);
        assert_eq!(messages(&data, &id).unwrap().len(), 0);

        // append giliran sah; role aneh & konten kosong disaring.
        append(&data, &id, &[
            json!({"role":"user","content":"  tolong rapikan folder  "}),
            json!({"role":"tool","content":"[read_file] ..."}),
            json!({"role":"assistant","content":"beres."}),
        ]);
        let msgs = messages(&data, &id).unwrap();
        assert_eq!(msgs.len(), 2, "role tool tidak ikut disimpan");
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"], "tolong rapikan folder");
        assert_eq!(msgs[1]["role"], "assistant");

        // cap history 60: append 70 giliran → menyisakan 60 TERAKHIR.
        let bulk: Vec<Value> = (0..70)
            .map(|i| json!({"role":"user","content":format!("g{i}")}))
            .collect();
        append(&data, &id, &bulk);
        let msgs = messages(&data, &id).unwrap();
        assert_eq!(msgs.len(), MAX_HISTORY);
        assert_eq!(msgs[0]["content"], "g10", "yang terbuang = yang terlama");
        assert_eq!(msgs.last().unwrap()["content"], "g69");
        // ts sesi naik (persist menyentuh rekaman, bukan cuma messages).
        let f = load(&data);
        let sess = f["sessions"].as_array().unwrap().iter().find(|s| s["id"] == json!(id)).unwrap();
        assert!(sess["ts"].as_i64().unwrap_or(0) >= rec["ts"].as_i64().unwrap_or(0));
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn create_run_sesi_baru_aktif() {
        // CATATAN: ensure_run_session ber-memo PER-PROSES — test ini satu-satunya
        // pemakainya; test lain memakai create/append murni agar tak saling ganggu.
        let data = std::env::temp_dir().join(format!("l2dsessrun-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&data).unwrap();
        // Ensure pertama = buat sesi run baru + jadikan aktif.
        let a = ensure_run_session(&data);
        let aid = a["id"].as_str().unwrap().to_string();
        assert!(aid.starts_with("s_"));
        assert_eq!(load(&data)["active"], json!(aid), "sesi run jadi aktif saat dibuat");
        // Panggilan berikutnya = sesi yang SAMA (idempoten dalam proses ini).
        let b = ensure_run_session(&data);
        assert_eq!(b["id"], json!(aid), "ensure idempoten dalam proses yang sama");
        // Sesi run dihapus user → panggilan berikutnya membuat pengganti.
        let (ok, _) = remove(&data, &aid);
        assert!(ok);
        let c = ensure_run_session(&data);
        let cid = c["id"].as_str().unwrap().to_string();
        assert_ne!(cid, aid, "sesi run yang dihapus digantikan sesi run baru");
        assert_eq!(load(&data)["active"], json!(cid));
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn migrasi_legacy() {
        let data = std::env::temp_dir().join(format!("l2dsessleg-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(legacy_path(&data), r#"{"workDir":"/x","history":[{"role":"user","content":"halo dunia"}]}"#).unwrap();
        let f = load(&data);
        assert_eq!(f["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(f["sessions"][0]["name"], "halo dunia");
        assert!(store_path(&data).exists());
        // padanan agent-sessions TS: file lama dipindah ke .bak (bukan dihapus)
        assert!(!legacy_path(&data).exists());
        assert!(legacy_path(&data).with_extension("json.bak").exists());
        let _ = std::fs::remove_dir_all(&data);
    }
}
