//! plan.rs — Todo list terstruktur untuk task kompleks, port `agent/plan.ts`.
//! State TERPISAH dari teks jawaban: runtime menyimpan di `rt.plan`, tool
//! `update_plan` mengubahnya, dan tiap perubahan di-emit ke bus supaya user
//! melihat progress (plan_updated / plan_revised).

use serde_json::{json, Value};

use crate::agent::bus;

const STATUSES: &[&str] = &["pending", "in_progress", "done", "failed"];

/// Validasi & normalisasi payload plan dari LLM. None bila kosong/invalid.
pub fn sanitize_plan(raw: &Value) -> Option<Vec<Value>> {
    let arr = raw.as_array()?;
    let mut out: Vec<Value> = Vec::new();
    for it in arr {
        let Some(obj) = it.as_object() else { continue };
        let id_raw = obj.get("id").map(val_to_string).unwrap_or_default();
        let id: String = id_raw.trim().chars().take(12).collect();
        let id = if id.is_empty() { (out.len() + 1).to_string() } else { id };
        let task: String = obj.get("task").map(val_to_string).unwrap_or_default().trim().chars().take(300).collect();
        if task.is_empty() {
            continue;
        }
        let mut status = obj.get("status").map(val_to_string).unwrap_or_default().to_lowercase();
        if !STATUSES.contains(&status.as_str()) {
            status = "pending".into();
        }
        let note: String = obj.get("note").map(val_to_string).unwrap_or_default().trim().chars().take(300).collect();
        let mut item = json!({ "id": id, "task": task, "status": status });
        if !note.is_empty() {
            item["note"] = json!(note);
        }
        out.push(item);
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn val_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

fn key_of(item: &Value) -> String {
    let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let task = item.get("task").and_then(|v| v.as_str()).unwrap_or("");
    format!("{id}|{task}")
}

/// Terapkan plan baru ke `plan`. Revisi (item lama hilang/berubah) WAJIB
/// disertai `reason` — kalau tidak, ditolak. Emit bus. Return (ok, reason?).
pub fn apply_plan(plan: &mut Vec<Value>, todos: Vec<Value>, reason: &str) -> (bool, Option<String>) {
    let old = &*plan;
    let old_keys: std::collections::HashSet<String> = old.iter().map(key_of).collect();
    let new_keys: std::collections::HashSet<String> = todos.iter().map(key_of).collect();
    let is_revision = !old.is_empty()
        && (todos.iter().any(|p| !old_keys.contains(&key_of(p))) || old.iter().any(|p| !new_keys.contains(&key_of(p))));
    if is_revision && reason.trim().is_empty() {
        return (false, Some("REVISI TANPA ALASAN DITOLAK — sebutkan 'reason' singkat kenapa rencana berubah.".into()));
    }
    *plan = todos;
    if is_revision {
        bus::emit("plan_revised", reason);
    } else {
        bus::emit("plan_updated", &plan_label(plan));
    }
    (true, None)
}

pub fn plan_label(todos: &[Value]) -> String {
    let done = todos.iter().filter(|p| p.get("status").and_then(|s| s.as_str()) == Some("done")).count();
    let failed = todos.iter().filter(|p| p.get("status").and_then(|s| s.as_str()) == Some("failed")).count();
    let mut s = format!("{}/{} selesai", done, todos.len());
    if failed > 0 {
        s.push_str(&format!(", {failed} gagal"));
    }
    s
}

/// Peringatan bila ada langkah ditandai done TANPA note bukti (kontrak
/// verifikasi — aturan 13 system prompt). Kosong bila bersih. Tidak menolak —
/// model bisa punya alasan sah; ia hanya dipaksa membaca pengingatnya.
pub fn unverified_done_warning(todos: &[Value]) -> String {
    let n = todos
        .iter()
        .filter(|p| {
            p.get("status").and_then(|s| s.as_str()) == Some("done")
                && p.get("note").and_then(|n| n.as_str()).map(|n| n.trim().is_empty()).unwrap_or(true)
        })
        .count();
    if n > 0 {
        format!("\n(peringatan: {n} langkah ditandai done TANPA note bukti — jalankan pemeriksaan nyata dan cantumkan buktinya di note, aturan 13)")
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_buang_task_kosong() {
        let raw = json!([{ "id": "1", "task": "baca file" }, { "task": "" }, { "task": "  edit  ", "status": "aneh" }]);
        let p = sanitize_plan(&raw).unwrap();
        assert_eq!(p.len(), 2);
        assert_eq!(p[0]["task"], "baca file");
        assert_eq!(p[1]["status"], "pending"); // status aneh → pending
        assert_eq!(p[1]["task"], "edit");
        assert!(sanitize_plan(&json!([])).is_none());
    }

    #[test]
    fn revisi_tanpa_alasan_ditolak() {
        bus::reset();
        let mut plan: Vec<Value> = Vec::new();
        // pertama kali (bukan revisi) → ok tanpa alasan
        let (ok, _) = apply_plan(&mut plan, sanitize_plan(&json!([{ "id": "1", "task": "A" }])).unwrap(), "");
        assert!(ok);
        // ganti task (revisi) tanpa alasan → ditolak
        let (ok2, reason) = apply_plan(&mut plan, sanitize_plan(&json!([{ "id": "1", "task": "B" }])).unwrap(), "");
        assert!(!ok2);
        assert!(reason.unwrap().contains("REVISI"));
        // dengan alasan → ok
        let (ok3, _) = apply_plan(&mut plan, sanitize_plan(&json!([{ "id": "1", "task": "B" }])).unwrap(), "ganti pendekatan");
        assert!(ok3);
        assert_eq!(plan[0]["task"], "B");
    }

    #[test]
    fn label_hitung() {
        let todos = vec![json!({ "status": "done" }), json!({ "status": "failed" }), json!({ "status": "pending" })];
        assert_eq!(plan_label(&todos), "1/3 selesai, 1 gagal");
    }

    #[test]
    fn done_tanpa_bukti_diperingatkan() {
        // done dgn note bukti → bersih.
        let bersih = vec![json!({ "status": "done", "note": "cargo test hijau" }), json!({ "status": "pending" })];
        assert_eq!(unverified_done_warning(&bersih), "");
        // done tanpa note → peringatan menyebut jumlah & aturan.
        let w = unverified_done_warning(&vec![json!({ "status": "done" }), json!({ "status": "done", "note": "" })]);
        assert!(w.contains("2 langkah"), "{w}");
        assert!(w.contains("aturan 13"), "{w}");
        // pending/failed tidak diperhitungkan.
        assert_eq!(unverified_done_warning(&vec![json!({ "status": "pending" }), json!({ "status": "failed" })]), "");
    }
}
