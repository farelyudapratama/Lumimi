//! store.rs — Persistensi observability harness agent (SQLite, FAIL-SOFT).
//!
//! Menyimpan riwayat tugas (runs), eksekusi tool (tool_execs), dan langkah
//! rencana (plan_steps) ke `data/agent-store.db` supaya kegagalan bisa
//! DIAUDIT (bukan ditebak) dan agent bisa menelusuri pekerjaan lampau
//! (tool `run_history`, endpoint `/api/assistant/runs`).
//!
//! Kontrak: store adalah INSTRUMEN, bukan jalur kritis — semua fungsi global
//! TIDAK PERNAH membuat tugas agent gagal; error ditelan (sekali, via bus).
//! Fungsi inti (`*_conn`) menerima `&Connection` supaya bisa diuji hermetik
//! tanpa menyentuh slot global.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rusqlite::Connection;
use serde_json::{json, Value};

use super::bus;

const DB_NAME: &str = "agent-store.db";
const MAX_RUNS: i64 = 300;
const MAX_TOOL_EXECS: i64 = 5000;

pub struct Store {
    conn: Mutex<Connection>,
}

static STORE: OnceLock<Mutex<Option<Store>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<Store>> {
    STORE.get_or_init(|| Mutex::new(None))
}

/// Buka (sekali per proses) store di `<root>/data`. Gagal → store tetap None
/// dan semua operasi lain menjadi no-op.
pub fn init(root: &Path) {
    let mut slot = slot().lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_some() {
        return;
    }
    let dir = root.join("data");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        bus::emit("store_error", &format!("gagal membuat folder data store: {e}"));
        return;
    }
    match open_conn(&dir.join(DB_NAME)) {
        Ok(conn) => {
            // Retensi: buang baris terlama di luar cap. Toleran kegagalan.
            let _ = conn.execute(
                &format!("DELETE FROM tool_execs WHERE id NOT IN (SELECT id FROM tool_execs ORDER BY id DESC LIMIT {MAX_TOOL_EXECS})"),
                [],
            );
            let _ = conn.execute(
                &format!("DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT {MAX_RUNS})"),
                [],
            );
            *slot = Some(Store { conn: Mutex::new(conn) });
        }
        Err(e) => bus::emit("store_error", &e),
    }
}

fn open_conn(path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("gagal membuka {}: {e}", path.display()))?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(2000));
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL DEFAULT '',
            task TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'running',
            error TEXT,
            model TEXT NOT NULL DEFAULT '',
            llm_calls INTEGER NOT NULL DEFAULT 0,
            started_at INTEGER NOT NULL,
            ended_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS tool_execs (
            id INTEGER PRIMARY KEY,
            run_id INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            tool TEXT NOT NULL,
            level TEXT NOT NULL DEFAULT '',
            args_json TEXT NOT NULL DEFAULT '{}',
            result_excerpt TEXT NOT NULL DEFAULT '',
            ok INTEGER NOT NULL DEFAULT 1,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            ts INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tool_execs_run ON tool_execs(run_id, seq);
        CREATE INDEX IF NOT EXISTS idx_tool_execs_tool ON tool_execs(tool, ts);
        CREATE TABLE IF NOT EXISTS plan_steps (
            run_id INTEGER NOT NULL,
            step_id TEXT NOT NULL,
            task TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            note TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (run_id, step_id)
        );",
    )
    .map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA user_version = 1;").map_err(|e| e.to_string())?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Jalankan operasi pada store global (no-op bila belum di-init). Error SQL
/// ditelan ke bus — pemanggil tidak boleh gagal karena store.
fn with_conn<T>(f: impl FnOnce(&Connection) -> Result<T, String>) -> Option<T> {
    let slot = slot().lock().unwrap_or_else(|e| e.into_inner());
    let store = slot.as_ref()?;
    let conn = store.conn.lock().unwrap_or_else(|e| e.into_inner());
    match f(&conn) {
        Ok(v) => Some(v),
        Err(e) => {
            bus::emit("store_error", &e.chars().take(160).collect::<String>());
            None
        }
    }
}

// ── Operasi inti (menerima &Connection — diuji hermetik) ────────────────────

pub fn begin_run_conn(c: &Connection, session_id: &str, task: &str, model: &str) -> Result<i64, String> {
    c.execute(
        "INSERT INTO runs (session_id, task, status, model, started_at) VALUES (?1, ?2, 'running', ?3, ?4)",
        rusqlite::params![session_id, task, model, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(c.last_insert_rowid())
}

pub fn set_run_status_conn(c: &Connection, run_id: i64, status: &str) -> Result<(), String> {
    c.execute("UPDATE runs SET status = ?2 WHERE id = ?1", rusqlite::params![run_id, status])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn end_run_conn(c: &Connection, run_id: i64, status: &str, error: Option<&str>, llm_calls: u64) -> Result<(), String> {
    c.execute(
        "UPDATE runs SET status = ?2, error = ?3, llm_calls = ?4, ended_at = ?5 WHERE id = ?1",
        rusqlite::params![run_id, status, error, llm_calls as i64, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn log_tool_conn(c: &Connection, run_id: i64, seq: u64, tool: &str, level: &str, args: &Value, result: &str, duration_ms: u64) -> Result<(), String> {
    let ok = !result.starts_with("ERROR");
    let excerpt: String = result.chars().take(600).collect();
    let args_json = serde_json::to_string(&redact_args(tool, args)).unwrap_or_else(|_| "{}".into());
    c.execute(
        "INSERT INTO tool_execs (run_id, seq, tool, level, args_json, result_excerpt, ok, duration_ms, ts) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        rusqlite::params![run_id, seq as i64, tool, level, args_json, excerpt, ok as i64, duration_ms as i64, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_plan_conn(c: &Connection, run_id: i64, steps: &[Value]) -> Result<(), String> {
    c.execute("DELETE FROM plan_steps WHERE run_id = ?1", rusqlite::params![run_id])
        .map_err(|e| e.to_string())?;
    for s in steps {
        c.execute(
            "INSERT OR REPLACE INTO plan_steps (run_id, step_id, task, status, note) VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![
                run_id,
                s.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                s.get("task").and_then(|v| v.as_str()).unwrap_or(""),
                s.get("status").and_then(|v| v.as_str()).unwrap_or("pending"),
                s.get("note").and_then(|v| v.as_str()).unwrap_or(""),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn run_row(r: &rusqlite::Row) -> Value {
    json!({
        "id": r.get::<_, i64>(0).unwrap_or(0),
        "sessionId": r.get::<_, String>(1).unwrap_or_default(),
        "task": r.get::<_, String>(2).unwrap_or_default(),
        "status": r.get::<_, String>(3).unwrap_or_default(),
        "error": r.get::<_, Option<String>>(4).unwrap_or(None),
        "model": r.get::<_, String>(5).unwrap_or_default(),
        "llmCalls": r.get::<_, i64>(6).unwrap_or(0),
        "startedAt": r.get::<_, i64>(7).unwrap_or(0),
        "endedAt": r.get::<_, Option<i64>>(8).unwrap_or(None),
    })
}

pub fn runs_conn(c: &Connection, limit: usize, query: Option<&str>) -> Result<Vec<Value>, String> {
    let lim = limit.clamp(1, 100) as i64;
    let mut stmt = c
        .prepare(
            "SELECT id, session_id, task, status, error, model, llm_calls, started_at, ended_at FROM runs
             WHERE (?1 IS NULL OR task LIKE '%' || ?1 || '%')
             ORDER BY id DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![query, lim], |r| Ok(run_row(r)))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn run_detail_conn(c: &Connection, id: i64) -> Result<Value, String> {
    let run = c
        .query_row(
            "SELECT id, session_id, task, status, error, model, llm_calls, started_at, ended_at FROM runs WHERE id = ?1",
            rusqlite::params![id],
            |r| Ok(run_row(r)),
        )
        .map_err(|e| e.to_string())?;
    let mut execs = Vec::new();
    let mut stmt = c
        .prepare("SELECT seq, tool, level, args_json, result_excerpt, ok, duration_ms, ts FROM tool_execs WHERE run_id = ?1 ORDER BY seq")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![id], |r| {
            Ok(json!({
                "seq": r.get::<_, i64>(0)?,
                "tool": r.get::<_, String>(1)?,
                "level": r.get::<_, String>(2)?,
                "args": serde_json::from_str::<Value>(&r.get::<_, String>(3)?).unwrap_or(Value::Null),
                "result": r.get::<_, String>(4)?,
                "ok": r.get::<_, i64>(5)? == 1,
                "durationMs": r.get::<_, i64>(6)?,
                "ts": r.get::<_, i64>(7)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        execs.push(row.map_err(|e| e.to_string())?);
    }
    let mut steps = Vec::new();
    let mut stmt2 = c
        .prepare("SELECT step_id, task, status, note FROM plan_steps WHERE run_id = ?1 ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows2 = stmt2
        .query_map(rusqlite::params![id], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "task": r.get::<_, String>(1)?,
                "status": r.get::<_, String>(2)?,
                "note": r.get::<_, String>(3)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    for row in rows2 {
        steps.push(row.map_err(|e| e.to_string())?);
    }
    Ok(json!({ "run": run, "toolExecs": execs, "planSteps": steps }))
}

// ── API global (fail-soft; dipakai loop agent & handler HTTP) ───────────────

/// Catat tugas baru; return run_id (None = store tidak aktif).
pub fn begin_run(session_id: &str, task: &str, model: &str) -> Option<i64> {
    with_conn(|c| begin_run_conn(c, session_id, task, model))
}

/// Perbarui status run (transisi paused/running juga).
pub fn set_run_status(run_id: i64, status: &str) {
    with_conn(|c| set_run_status_conn(c, run_id, status));
}

/// Tutup run: status final + error + jumlah panggilan LLM.
pub fn end_run(run_id: i64, status: &str, error: Option<&str>, llm_calls: u64) {
    with_conn(|c| end_run_conn(c, run_id, status, error, llm_calls));
}

/// Sembunyikan bagian command yang berpotensi rahasia sebelum dicatat ke
/// store observability. Pola yang dimasked: segmen mirip token (≥24 char
/// base64/hex) dan `kunci=nilai` dengan kunci mengandung kata rahasia
/// (key/token/secret/password/bearer). Perintah biasa (cargo test, dir src)
/// tetap terbaca — nilai observability-nya justru di situ.
fn mask_command_secrets(cmd: &str) -> String {
    let secret_key = |k: &str| {
        let k = k.to_lowercase();
        ["key", "token", "secret", "password", "passwd", "authorization", "bearer"]
            .iter()
            .any(|w| k.contains(w))
    };
    cmd.split_whitespace()
        .map(|tok| {
            let len = tok.chars().count();
            // kunci=nilai / kunci:nilai (kunci di awal token).
            if let Some(eq) = tok.find(['=', ':']) {
                let (k, v) = tok.split_at(eq);
                let v = &v[1..];
                if secret_key(k) && !v.is_empty() && len < 200 {
                    return format!("{k}=***");
                }
            }
            // Segmen mirip token panjang (bukan path/flag biasa).
            let looks_token = len >= 24
                && tok.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+' | '/' | '=' | '.'))
                && tok.chars().any(|c| c.is_ascii_digit());
            if looks_token {
                "***".to_string()
            } else {
                tok.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Argumen aman utk disimpan: isi berkas TIDAK disimpan (bisa memuat rahasia
/// atau sekadar besar) — cukup path + panjang. browser_type sudah diredaksi
/// public_tool_args; lapisan ini tambahan khusus tool file + run_command.
pub fn redact_args(name: &str, args: &Value) -> Value {
    let mut v = args.clone();
    if let Some(obj) = v.as_object_mut() {
        match name {
            "write_file" => {
                let n = obj.get("content").and_then(|c| c.as_str()).map(|s| s.chars().count()).unwrap_or(0);
                obj.insert("content_len".into(), json!(n));
                obj.remove("content");
            }
            "edit_file" => {
                let n_old = obj.get("old").and_then(|c| c.as_str()).map(|s| s.chars().count()).unwrap_or(0);
                let n_new = obj.get("new").and_then(|c| c.as_str()).map(|s| s.chars().count()).unwrap_or(0);
                obj.insert("old_len".into(), json!(n_old));
                obj.insert("new_len".into(), json!(n_new));
                obj.remove("old");
                obj.remove("new");
            }
            "run_command" => {
                // Command line bisa membawa rahasia (token CI, header auth) —
                // mask pola rahasia, sisanya tetap terbaca untuk debugging.
                if let Some(cmd) = obj.get("command").and_then(|c| c.as_str()) {
                    obj.insert("command".into(), json!(mask_command_secrets(cmd)));
                }
            }
            _ => {}
        }
    }
    v
}

/// Catat satu eksekusi tool. `ok` = hasil tidak berawalan ERROR.
pub fn log_tool(run_id: i64, seq: u64, tool: &str, level: &str, args: &Value, result: &str, duration_ms: u64) {
    with_conn(|c| log_tool_conn(c, run_id, seq, tool, level, args, result, duration_ms));
}

/// Simpan snapshot rencana untuk run (replace penuh — plan terbaru menang).
pub fn set_plan(run_id: i64, steps: &[Value]) {
    with_conn(|c| set_plan_conn(c, run_id, steps));
}

/// Daftar run terbaru (terbaru dulu) — untuk endpoint observability & tool.
pub fn runs(limit: usize, query: Option<&str>) -> Vec<Value> {
    with_conn(|c| runs_conn(c, limit, query)).unwrap_or_default()
}

/// Daftar run sebagai teks ringkas untuk tool `run_history` (dibaca LLM).
pub fn runs_as_text(list: &[Value]) -> String {
    if list.is_empty() {
        return "(tidak ada tugas masa lalu yang cocok)".into();
    }
    let mut out = String::from(format!("{} tugas masa lalu (terbaru dulu):", list.len()));
    for r in list {
        let task: String = r["task"].as_str().unwrap_or("").chars().take(120).collect();
        let err = r["error"].as_str().unwrap_or("");
        let mut line = format!(
            "\n- [#{}] ({}) {} — {} panggilan LLM",
            r["id"],
            r["status"].as_str().unwrap_or("?"),
            task,
            r["llmCalls"].as_i64().unwrap_or(0)
        );
        if !err.is_empty() {
            let err: String = err.chars().take(120).collect();
            line.push_str(&format!(" — error: {err}"));
        }
        out.push_str(&line);
    }
    out
}

/// Detail satu run: run + tool_execs (urut seq) + plan_steps.
pub fn run_detail(id: i64) -> Option<Value> {
    with_conn(|c| run_detail_conn(c, id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("l2dstore-{tag}-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Store test hermetik: koneksi sendiri di tmp dir, TANPA menyentuh slot
    /// global (slot global dipakai antar-test lain — jangan direasuh).
    fn hermetic(tag: &str) -> (PathBuf, Connection) {
        let root = tmp_root(tag);
        std::fs::create_dir_all(root.join("data")).unwrap();
        let conn = open_conn(&root.join("data").join(DB_NAME)).expect("buka db test");
        (root, conn)
    }

    #[test]
    fn siklus_run_tool_plan_dan_query() {
        let (root, conn) = hermetic("siklus");

        let rid = begin_run_conn(&conn, "s_1", "buat file hello lalu verifikasi", "model-x").unwrap();
        log_tool_conn(&conn, rid, 1, "write_file", "mutating", &json!({ "path": "hello.txt", "content": "isi rahasia-body" }), "Tersimpan + terverifikasi: hello.txt (15 char, dibaca ulang cocok)", 12).unwrap();
        log_tool_conn(&conn, rid, 2, "read_file", "safe", &json!({ "path": "hello.txt" }), "ERROR: berkas hilang", 3).unwrap();
        set_plan_conn(&conn, rid, &[json!({ "id": "1", "task": "tulis", "status": "done", "note": "read-back cocok" }), json!({ "id": "2", "task": "uji", "status": "pending" })]).unwrap();
        end_run_conn(&conn, rid, "done", None, 3).unwrap();

        let list = runs_conn(&conn, 10, None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["status"], "done");
        assert_eq!(list[0]["llmCalls"], 3);
        // Pencarian task.
        assert_eq!(runs_conn(&conn, 10, Some("hello")).unwrap().len(), 1);
        assert_eq!(runs_conn(&conn, 10, Some("tidakada")).unwrap().len(), 0);

        let d = run_detail_conn(&conn, rid).unwrap();
        let execs = d["toolExecs"].as_array().unwrap();
        assert_eq!(execs.len(), 2);
        assert_eq!(execs[0]["tool"], "write_file");
        assert_eq!(execs[0]["ok"], json!(true));
        assert_eq!(execs[1]["ok"], json!(false));
        // Isi file TIDAK disimpan (hanya panjang) — rahasia tak bocor via endpoint.
        let args0 = serde_json::to_string(&execs[0]["args"]).unwrap();
        assert!(args0.contains("content_len"), "{args0}");
        assert!(!args0.contains("rahasia-body"), "{args0}");
        let steps = d["planSteps"].as_array().unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0]["status"], "done");
        assert_eq!(steps[0]["note"], "read-back cocok");
        // Runs as text: format terbaca LLM.
        let txt = runs_as_text(&list);
        assert!(txt.contains("(done)"), "{txt}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn retensi_buang_yang_terlama() {
        let (root, conn) = hermetic("retensi");
        let rid = begin_run_conn(&conn, "s", "tugas retensi", "m").unwrap();
        for i in 0..(MAX_TOOL_EXECS + 50) {
            log_tool_conn(&conn, rid, i as u64, "list_dir", "safe", &json!({}), "ok", 0).unwrap();
        }
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM tool_execs", [], |r| r.get(0)).unwrap();
        assert_eq!(n, MAX_TOOL_EXECS + 50);
        // Simulasi retensi seperti init().
        conn.execute(
            &format!("DELETE FROM tool_execs WHERE id NOT IN (SELECT id FROM tool_execs ORDER BY id DESC LIMIT {MAX_TOOL_EXECS})"),
            [],
        )
        .unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM tool_execs", [], |r| r.get(0)).unwrap();
        assert_eq!(n, MAX_TOOL_EXECS, "cap ditepatkan");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn redact_args_meredaksi_isi_file() {
        let r = redact_args("write_file", &json!({ "path": "a.txt", "content": "rahasia" }));
        assert!(r.get("content").is_none());
        assert_eq!(r["content_len"], 7);
        let r2 = redact_args("edit_file", &json!({ "path": "a", "old": "lama", "new": "baru" }));
        assert!(r2.get("old").is_none() && r2.get("new").is_none());
        assert_eq!(r2["old_len"], 4);
        // Tool lain lolos utuh.
        assert_eq!(redact_args("read_file", &json!({ "path": "x" })), json!({ "path": "x" }));

        // run_command: perintah biasa tetap terbaca (nilai observability
        // utamanya justru di sini), pola rahasia dimasked.
        let rc = redact_args("run_command", &json!({ "command": "cargo test -p live2d-core" }));
        assert_eq!(rc["command"], "cargo test -p live2d-core");
        let rc2 = redact_args("run_command", &json!({ "command": "deploy --api-key=abc12345" }));
        assert_eq!(rc2["command"], "deploy --api-key=***", "{}", rc2["command"]);
        let tok = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
        let rc3 = redact_args("run_command", &json!({ "command": format!("curl {tok} https://x") }));
        let s3 = rc3["command"].as_str().unwrap();
        assert!(!s3.contains(tok), "token panjang harus lenyap: {s3}");
        assert!(s3.contains("***"));
        let rc4 = redact_args("run_command", &json!({ "command": "git diff -- src/lib.rs" }));
        assert_eq!(rc4["command"], "git diff -- src/lib.rs");
    }

    #[test]
    fn migrasi_idempoten() {
        let root = tmp_root("migrasi");
        {
            let dir = root.join("data");
            std::fs::create_dir_all(&dir).unwrap();
            let conn = Connection::open(dir.join(DB_NAME)).unwrap();
            migrate(&conn).unwrap();
            migrate(&conn).unwrap(); // kedua kali: tidak error, schema tetap
        }
        // Buka ulang db lama via open_conn → tetap jalan.
        let conn = open_conn(&root.join("data").join(DB_NAME)).unwrap();
        let rid = begin_run_conn(&conn, "s", "t", "m").unwrap();
        assert!(rid > 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn tanpa_init_global_noop() {
        // Slot global mungkin sudah di-init test lain (fail-soft): pastikan
        // API global TIDAK panic dalam keadaan apa pun.
        let _ = begin_run("s", "t", "m");
        let _ = runs(10, None);
        let _ = run_detail(1);
        log_tool(1, 1, "x", "safe", &json!({}), "ok", 1);
        set_plan(1, &[]);
        set_run_status(1, "done");
        end_run(1, "done", None, 1);
    }
}
