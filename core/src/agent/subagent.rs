//! subagent.rs — Delegasi sub-task ke loop terpisah (context segar).
//!
//! Aturan keras (sama dgn TS):
//!   - Subagent TIDAK boleh spawn subagent lagi (nesting 1 level).
//!   - Subagent hanya tool READ-ONLY (mutating tetap otoritas orchestrator +
//!     approval user).
//!   - Orchestrator hanya menerima RINGKASAN hasil akhir, bukan history anak.
//!   - Maks 4 subagent paralel per panggilan.
//!
//! Beda dari TS: tak menggeser singleton runtime — tiap subagent punya history
//! lokal sendiri (loop mini di sini), jadi tak menyentuh state global.

use std::path::{Path, PathBuf};

use crate::agent::{bus, loop_};
use crate::llm::{self, ChatMessage};

const MAX_PARALLEL: usize = 4;
const SUB_MAX_ITERATIONS: usize = 12;

fn lang_of(config_path: &Path) -> String {
    let cfg = crate::config::load(config_path);
    if cfg.get("i18n").and_then(|i| i.get("lang")).and_then(|l| l.as_str()) == Some("en") {
        "en".into()
    } else {
        "id".into()
    }
}

fn strip_tool_directive(text: &str) -> String {
    text.lines()
        .filter(|l| {
            let t = l.trim_start();
            !loop_::TOOLS.iter().any(|tool| t.starts_with(&format!("TOOL: {}", tool.name))) && !t.to_lowercase().starts_with("tool:")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn clip(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n > max {
        s.chars().take(max).collect()
    } else {
        s.to_string()
    }
}

/// Satu subagent: loop mini read-only sampai final / batas iterasi.
async fn run_sub_loop(config_path: &Path, root: &Path, work_dir: &str, task: &str) -> Result<String, String> {
    let wd = PathBuf::from(work_dir);
    let lang = lang_of(config_path);
    let extra = if lang == "en" {
        "\n\nYou are a READ-ONLY subagent: you may ONLY use read/search tools. You cannot write, edit, delete, run commands, or spawn subagents. Return a concise summary of findings."
    } else {
        "\n\nKamu subagent READ-ONLY: HANYA boleh tool baca/cari. Dilarang menulis, mengedit, menghapus, menjalankan perintah, atau spawn subagent. Kembalikan ringkasan temuan yang padat."
    };
    let system = format!("{}{}", loop_::build_system(&lang, work_dir, ""), extra);

    let mut history: Vec<(String, String)> = vec![("user".into(), clip(task, 4000))];
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for _ in 0..SUB_MAX_ITERATIONS {
        let messages: Vec<ChatMessage> = history
            .iter()
            .map(|(role, content)| {
                if role == "tool" {
                    ChatMessage { role: "user".into(), content: format!("[hasil tool] {content}") }
                } else {
                    ChatMessage { role: role.clone(), content: content.clone() }
                }
            })
            .collect();
        let reply = llm::llm_for_role_tools(config_path, "assistant", &messages, &system, &loop_::tool_defs_json()).await.map_err(|(_, m)| m)?.reply;

        let detected = loop_::detect_tool_call(&reply);
        let (name, args) = match detected {
            None => return Ok(strip_tool_directive(&reply)),
            Some(d) => d,
        };
        let level = loop_::tool_level(&name);
        // Read-only: tolak mutating / spawn_subagent / tak dikenal.
        if name == "spawn_subagent" || level == Some("mutating") || level.is_none() {
            history.push(("assistant".into(), strip_tool_directive(&reply)));
            history.push(("tool".into(), format!("ERROR: subagent read-only — tool '{name}' tidak diizinkan; pakai read_file/list_dir/search_code atau jawab langsung.")));
            continue;
        }
        let call_key = format!("{name} {}", serde_json::to_string(&args).unwrap_or_default());
        if seen.contains(&call_key) {
            return Ok(strip_tool_directive(&reply));
        }
        seen.insert(call_key);

        // update_plan tak relevan utk subagent → perlakukan sbg no-op ringkas.
        if name == "update_plan" {
            history.push(("assistant".into(), strip_tool_directive(&reply)));
            history.push(("tool".into(), "[update_plan] (diabaikan untuk subagent)".into()));
            continue;
        }
        let result = loop_::exec_tool(root, &wd, &name, &args);
        history.push(("assistant".into(), strip_tool_directive(&reply)));
        history.push(("tool".into(), clip(&result, 4000)));
    }
    Ok("(subagent berhenti tanpa jawaban)".into())
}

/// Jalankan batch subagent paralel. Return teks tool_result gabungan.
pub async fn run_batch(config_path: &Path, root: &Path, work_dir: &str, tasks: Vec<String>) -> String {
    let total = tasks.len();
    let batch: Vec<String> = tasks.into_iter().take(MAX_PARALLEL).collect();
    let skipped = total.saturating_sub(batch.len());

    let mut futs = Vec::new();
    for (i, task) in batch.into_iter().enumerate() {
        let id = format!("sub{}", i + 1);
        bus::emit("subagent_spawned", &format!("{id}: {}", clip(&task, 80)));
        let cp = config_path.to_path_buf();
        let rt = root.to_path_buf();
        let wd = work_dir.to_string();
        futs.push(async move {
            let out = match run_sub_loop(&cp, &rt, &wd, &task).await {
                Ok(s) if !s.is_empty() => clip(&s, 2000),
                Ok(_) => "(kosong)".into(),
                Err(e) => format!("ERROR: {}", clip(&e, 200)),
            };
            bus::emit("subagent_completed", &format!("{id}: {}", clip(&out, 80)));
            format!("── {id} ──\n{}\n→ {out}", clip(&task, 120))
        });
    }
    let results = futures_util::future::join_all(futs).await;
    let mut out = results.join("\n\n");
    if skipped > 0 {
        out.push_str(&format!("\n\n({skipped} spawn_subagent dilewati — maksimal {MAX_PARALLEL} subagent paralel)"));
    }
    out
}

/// Ambil daftar task dari args tool: {tasks:[{task}|"..."]} atau {task:"..."}.
pub fn parse_tasks(args: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(arr) = args.get("tasks").and_then(|v| v.as_array()) {
        for t in arr {
            let s = t.get("task").and_then(|v| v.as_str()).or_else(|| t.as_str()).unwrap_or("").trim();
            if !s.is_empty() {
                out.push(clip(s, 1000));
            }
        }
    } else if let Some(s) = args.get("task").and_then(|v| v.as_str()) {
        let s = s.trim();
        if !s.is_empty() {
            out.push(clip(s, 1000));
        }
    }
    out
}
