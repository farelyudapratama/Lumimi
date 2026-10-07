//! Assistant runtime + loop — port `agentAsk` (loop.ts) + facade (assistant.ts).
//! Satu runtime aktif (workDir, history, approvals, busy). Loop: LLM
//! ("assistant") → detect tool → gate (mutating: pause minta izin) / exec →
//! ulang sampai final. Permission gate menjeda loop; /approve melanjutkannya.
//!
//! Verifikasi: run_command & FS diuji di tools/loop_ (3d-3/3d-4). Loop no-tool
//! diuji dgn mock; jalur tool+gate lewat LLM sungguhan (mock tak emit "TOOL:").

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::agent::{bus, loop_, memory, plan, tools};
use crate::llm::{self, ChatMessage};

const MAX_ITERATIONS: usize = 25;
const MAX_HISTORY: usize = 60;
// Kontrak MODES.md: cap 20 FIFO (padanan MAX_UNDO TS yang di-guard).
const MAX_UNDO: usize = 20;
const MAX_NOTES: usize = 30;

/// Rekaman undo satu mutasi file (snapshot isi SEBELUM tool write/edit/delete).
#[derive(Clone)]
struct UndoRec {
    id: String,
    rel_path: String,
    abs_path: PathBuf,
    /// None = file belum ada sebelum mutasi (revert = hapus file).
    prev_content: Option<String>,
    ts: i64,
    reverted: bool,
}

#[derive(Default)]
pub struct Runtime {
    pub running: bool,
    pub busy: bool,
    pub work_dir: String,
    /// Model Live2D aktif (nama folder) + peta role→paramId dari klien —
    /// konteks untuk tool motion (motion_*). Klien mengirimnya saat start.
    pub model: String,
    pub role_map: Value,
    pub history: Vec<Value>, // {role, content}
    pub approvals: Vec<Value>, // {id, tool, args, ts}
    /// Allowlist izin sesi (kunci allow_key): tool mutating yang sudah
    /// pernah disetujui dengan "selalu izinkan" — gate melewatinya tanpa
    /// pause. Kosong lagi saat stop().
    pub allowed: std::collections::HashSet<String>,
    /// Kontrak plan-approval (Fase 2): ask_seq = penomor tugas berjalan;
    /// plan_seq = ask_seq saat rencana terakhir disusun lewat update_plan.
    /// Gate menyala hanya bila rencana disusun PADA tugas berjalan (lihat
    /// plan_gate_required) dan dilucuti setelah approve/reject atau mutasi
    /// pertama tereksekusi. Di-reset per tugas di ask().
    ask_seq: u64,
    plan_seq: u64,
    plan_ok: bool,
    mutated: bool,
    plan: Vec<Value>,          // update_plan items
    notes_files: Vec<String>,  // file tersentuh sesi ini (relatif)
    undo: Vec<UndoRec>,        // snapshot mutasi (cap MAX_UNDO)
    cancel: bool,              // cancel kooperatif antar-langkah
    active_task: Option<Value>, // {taskId, prompt, status} — untuk status panel
    next_task_seq: u64,        // penomor taskId
    undo_seq: u64,             // penomor id undo (id unik walau ms sama)
}

fn rt() -> &'static Mutex<Runtime> {
    static R: OnceLock<Mutex<Runtime>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Runtime::default()))
}

fn push_msg(r: &mut Runtime, role: &str, content: &str) {
    r.history.push(json!({ "role": role, "content": content }));
    if r.history.len() > MAX_HISTORY {
        let drop = r.history.len() - MAX_HISTORY;
        r.history.drain(0..drop);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Kunci allowlist sesi: per-tool, KECUALI run_command yang dikelompokkan
/// per perintah — menyetujui "cargo test" bukan berarti mengizinkan
/// perintah arbitrer lain dengan nama tool yang sama.
fn allow_key(name: &str, args: &Value) -> String {
    if name == "run_command" {
        let cmd = args.get("command").and_then(|v| v.as_str()).unwrap_or("").trim();
        if !cmd.is_empty() {
            return format!("run_command:{cmd}");
        }
    }
    name.to_string()
}

/// Kontrak plan-approval (Fase 2, murni): gate hanya untuk rencana yang
/// disusun PADA tugas berjalan (plan_seq == ask_seq), belum disetujui
/// (plan_ok), dan belum ada mutasi tereksekusi (mutated). Tugas tanpa plan,
/// plan dari tugas lampau, dan kondisi setelah mutasi pertama TIDAK
/// menggerbangi — mereka langsung ke gerbang izin tool (Fase 1) saja.
fn plan_gate_required(r: &Runtime) -> bool {
    r.plan_seq > 0 && r.plan_seq == r.ask_seq && !r.plan_ok && !r.mutated
}

/// Buang baris directive TOOL: + blok/tag reasoning yang bocor dari teks final
/// (padanan stripToolDirective). Model reasoning kerap membocorkan `<think>` /
/// `<tool_call>` sebagai teks — jangan sampai muncul di transkrip user.
fn strip_tool_directive(text: &str) -> String {
    let text = loop_::strip_reasoning(text);
    text.lines()
        .filter(|l| {
            let t = l.trim_start();
            !loop_::TOOLS.iter().any(|tool| t.starts_with(&format!("TOOL: {}", tool.name)) || t.to_lowercase().starts_with("tool:"))
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Mulai/attach runtime ke workDir. Bus di-reset (sesi baru). `model` +
/// `role_map` opsional: konteks untuk tool motion (motion_*).
pub async fn start(work_dir: &str, model: &str, role_map: Value) -> Value {
    bus::reset();
    let mut r = rt().lock().await;
    r.running = true;
    r.busy = false;
    r.cancel = false;
    if !work_dir.is_empty() {
        r.work_dir = work_dir.to_string();
    }
    r.model = model.trim().to_string();
    r.role_map = if role_map.is_object() { role_map } else { Value::Null };
    // Workdir nggak valid diterima tapi DITANDAI — dulu diam saja dan panel
    // menampilkan status generik, user awam tidak tahu foldernya salah
    // sampai tool gagal dengan os error.
    let warning = if r.work_dir.is_empty() {
        None
    } else if !Path::new(&r.work_dir).is_dir() {
        Some(format!("folder kerja tidak ditemukan: {}", r.work_dir))
    } else {
        None
    };
    json!({ "ok": true, "workDir": r.work_dir, "model": r.model, "warning": warning })
}

/// Status untuk panel/probe. activeTask/parkedTasks masih stub (task-identity
/// Worker belum diport) — panel degrade anggun (satu ask sinkron per waktu).
pub async fn status() -> Value {
    let r = rt().lock().await;
    let pending: Vec<Value> = r.approvals.iter().map(|ap| {
        let name = ap.get("tool").and_then(|x| x.as_str()).unwrap_or("");
        let args = ap.get("args").cloned().unwrap_or(json!({}));
        json!({
            "id": ap.get("id").cloned().unwrap_or(Value::Null),
            "kind": ap.get("kind").cloned().unwrap_or(Value::Null),
            "tool": name,
            "args": loop_::public_tool_args(name, &args),
            "ts": ap.get("ts").cloned().unwrap_or(Value::Null),
        })
    }).collect();
    let mut allowlist: Vec<String> = r.allowed.iter().cloned().collect();
    allowlist.sort();
    json!({
        "running": r.running,
        "busy": r.busy,
        "workDir": r.work_dir,
        "historyCount": r.history.len(),
        "pendingApprovals": pending,
        "allowlist": allowlist,
        "plan": r.plan,
        "notes": { "filesTouched": r.notes_files },
        "lastEvent": if r.running { bus::last_event() } else { Value::Null },
        "tools": loop_::TOOLS.iter().map(|t| json!({ "name": t.name, "level": t.level })).collect::<Vec<_>>(),
        "activeTask": r.active_task.clone().unwrap_or(Value::Null),
        "parkedTasks": [],
    })
}

pub async fn stop() -> Value {
    let mut r = rt().lock().await;
    r.running = false;
    r.busy = false;
    r.cancel = false;
    r.history.clear();
    r.approvals.clear();
    r.allowed.clear();
    r.ask_seq = 0;
    r.plan_seq = 0;
    r.plan_ok = false;
    r.mutated = false;
    r.plan.clear();
    r.notes_files.clear();
    r.undo.clear();
    r.active_task = None;
    json!({ "ok": true })
}

/// GET /api/assistant/history.
pub async fn history() -> Value {
    let r = rt().lock().await;
    Value::Array(r.history.clone())
}

/// POST /api/assistant/quip {persona?, event?} — komentar berkarakter singkat
/// (SUARA pet/VTuber) atas aksi agent. LLM role "chat". Stateless. Gagal →
/// {quip:"", error}. Padanan handleAssistantQuip.
pub async fn quip(config_path: &Path, persona: &str, event: &str) -> Value {
    let persona: String = persona.chars().take(800).collect();
    let event: String = event.chars().take(160).collect();
    let en = lang_of(config_path) == "en";
    let base = if en {
        "You are the VOICE of a living character (desktop pet / VTuber) accompanying an AI agent as it works. You briefly react to what the agent JUST did — one casual spoken line, max 15 words, with personality. Never mention tool names, file paths, or technical terms. No emoji, no quotation marks."
    } else {
        "Kamu adalah SUARA karakter hidup (pet / VTuber) yang menemani agent AI bekerja. Reaksilah singkat atas apa yang agent BARU lakukan — satu kalimat santai, maksimal 15 kata, dengan kepribadian. Jangan sebut nama tool, path file, atau istilah teknis. Tanpa emoji, tanpa tanda kutip."
    };
    let sys = if persona.trim().is_empty() {
        base.to_string()
    } else if en {
        format!("{base}\n\nYour character:\n{persona}")
    } else {
        format!("{base}\n\nKaraktermu:\n{persona}")
    };
    let user = if event.trim().is_empty() { "agent mulai berpikir".to_string() } else { event };
    let messages = [ChatMessage { role: "user".into(), content: user }];
    match llm::llm_for_role(config_path, "chat", &messages, &sys).await {
        Ok(ok) => json!({ "quip": ok.reply.trim().chars().take(140).collect::<String>() }),
        Err((_, msg)) => json!({ "quip": "", "error": msg }),
    }
}

/// POST /api/assistant/reset — kosongkan riwayat (ditolak saat busy).
pub async fn reset() -> Value {
    let mut r = rt().lock().await;
    if r.busy {
        return json!({ "ok": false, "error": "masih memproses tugas — riwayat tidak bisa dikosongkan saat task berjalan" });
    }
    r.history.clear();
    json!({ "ok": true })
}

/// POST /api/assistant/cancel — minta batal kooperatif (dicek antar-langkah).
/// Model core sinkron: tanpa task-identity, cancel menyetel flag yang dibaca
/// run_loop di awal tiap turn.
pub async fn cancel() -> Value {
    let mut r = rt().lock().await;
    if !r.running || (!r.busy && r.approvals.is_empty()) {
        return json!({ "ok": true, "accepted": false });
    }
    r.cancel = true;
    json!({ "ok": true, "accepted": true })
}

/// GET /api/assistant/events?since=N.
pub async fn events(since: u64) -> Value {
    let busy = rt().lock().await.busy;
    let mut d = bus::read(since);
    d["busy"] = json!(busy);
    d
}

/// GET /api/assistant/undo — daftar snapshot (terbaru dulu).
pub async fn undo_list() -> Value {
    let r = rt().lock().await;
    let list: Vec<Value> = r.undo.iter().rev().map(|u| {
        json!({
            "id": u.id,
            "path": u.rel_path,
            "ts": u.ts,
            "reverted": u.reverted,
            "kind": if u.prev_content.is_none() { "created" } else { "modified" },
        })
    }).collect();
    Value::Array(list)
}

/// POST /api/assistant/revert {id} — kembalikan file ke snapshot. Ok/Err.
pub async fn revert(id: &str) -> Result<String, String> {
    let mut r = rt().lock().await;
    let idx = r.undo.iter().position(|u| u.id == id).ok_or_else(|| format!("rekaman undo tidak dikenal: {id}"))?;
    if r.undo[idx].reverted {
        return Err("rekaman ini sudah pernah di-revert".into());
    }
    let (abs, prev, rel) = {
        let u = &r.undo[idx];
        (u.abs_path.clone(), u.prev_content.clone(), u.rel_path.clone())
    };
    let msg = match &prev {
        None => {
            let _ = std::fs::remove_file(&abs);
            format!("Dikembalikan: {rel} dihapus (sebelumnya belum ada).")
        }
        Some(content) => {
            std::fs::write(&abs, content).map_err(|e| e.to_string())?;
            format!("Dikembalikan: {rel} ke isi sebelum mutasi agent ({} char).", content.chars().count())
        }
    };
    r.undo[idx].reverted = true;
    bus::emit("verification_result", &format!("revert: {rel}"));
    Ok(msg)
}

/// Hasil ask/approve.
pub struct AskResult {
    pub ok: bool,
    pub reply: String,
    pub paused: bool,
    pub error: Option<String>,
}

/// Bahasa balasan dari config.i18n.
fn lang_of(config_path: &Path) -> String {
    let cfg = crate::config::load(config_path);
    if cfg.get("i18n").and_then(|i| i.get("lang")).and_then(|l| l.as_str()) == Some("en") {
        "en".into()
    } else {
        "id".into()
    }
}

/// Jalankan loop dari history saat ini sampai final / paused / batas iterasi.
/// Runtime di-lock per-langkah (lepas saat await LLM) supaya status bisa dibaca.
async fn run_loop(config_path: &Path, root: &Path) -> AskResult {
    let lang = lang_of(config_path);
    let (work_dir, model_name) = { let r = rt().lock().await; (r.work_dir.clone(), r.model.clone()) };
    let wd = PathBuf::from(&work_dir);
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut final_text = String::new();
    let mut paused = false;
    // Anti "ngaku simpan tapi tak memanggil tool": bila draft sudah divalidasi
    // tapi model mencoba mengakhiri tanpa motion_save, ajukan simpan sendiri
    // (pakai draft yang tervalidasi) lewat kartu izin — tak bergantung model
    // mengeluarkan ulang JSON besar.
    let mut motion_validated = false;
    let mut last_validated_draft: Option<Value> = None;

    for _turn in 0..MAX_ITERATIONS {
        // Cancel kooperatif: dicek di awal tiap turn (loop lepas lock saat await
        // LLM, jadi /cancel dari request lain bisa menyetel flag ini).
        {
            let mut r = rt().lock().await;
            if r.cancel {
                r.cancel = false;
                push_msg(&mut r, "assistant", "Dibatalkan oleh user.");
                bus::emit("error", "dibatalkan: oleh user");
                r.busy = false;
                r.active_task = None;
                return AskResult { ok: true, reply: "Dibatalkan oleh user.".into(), paused: false, error: None };
            }
        }
        bus::emit("thinking_start", "");
        // rakit messages dari history (tool → user "[hasil tool] …").
        let messages: Vec<ChatMessage> = {
            let r = rt().lock().await;
            r.history.iter().map(|m| {
                let role = m.get("role").and_then(|x| x.as_str()).unwrap_or("user");
                let content = m.get("content").and_then(|x| x.as_str()).unwrap_or("");
                if role == "tool" {
                    ChatMessage { role: "user".into(), content: format!("[hasil tool] {content}") }
                } else {
                    ChatMessage { role: role.into(), content: content.into() }
                }
            }).collect()
        };
        let system = format!("{}{}", loop_::build_system(&lang, &work_dir, &model_name), memory::memory_prompt_block(root));

        let reply = match llm::llm_for_role_tools(config_path, "assistant", &messages, &system, &loop_::tool_defs_json()).await {
            Ok(ok) => ok.reply,
            Err((_, msg)) => {
                bus::emit("error", &msg);
                let mut r = rt().lock().await;
                push_msg(&mut r, "assistant", &format!("⚠️ {msg}"));
                return AskResult { ok: false, reply: String::new(), paused: false, error: Some(msg) };
            }
        };

        let detected = loop_::detect_tool_call(&reply);
        let (name, args) = match detected {
            None => {
                // Model mendeskripsikan "sudah kusimpan" tapi tak pernah memanggil
                // motion_save. Bila draft sudah tervalidasi, JANGAN cuma berhenti:
                // ajukan motion_save sendiri (server yang pegang draft valid) lewat
                // kartu izin. Sekali per ask — jalur ini langsung pause & break.
                if motion_validated && last_validated_draft.is_some() {
                    let draft = last_validated_draft.clone().unwrap();
                    let save_args = json!({ "motion": draft });
                    bus::emit("permission_request", "motion_save");
                    let id = format!("ap_{}", crate::config::base36_pub(now_ms() as u128));
                    let pub_args = loop_::public_tool_args("motion_save", &save_args);
                    let mut r = rt().lock().await;
                    while r.approvals.len() >= 8 {
                        r.approvals.remove(0);
                    }
                    r.approvals.push(json!({ "id": id, "tool": "motion_save", "args": save_args, "ts": now_ms() }));
                    push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
                    push_msg(&mut r, "tool", &format!("MENUNGGU PERSETUJUAN: motion_save {} (id {id})", serde_json::to_string(&pub_args).unwrap_or_default().chars().take(300).collect::<String>()));
                    paused = true;
                    final_text = "Draft sudah divalidasi — aku ajukan simpan ke library. Setujui di panel Assistant untuk menyimpannya.".to_string();
                    break;
                }
                final_text = if reply.trim().is_empty() { "(kosong)".into() } else { reply };
                break;
            }
            Some(d) => d,
        };
        let call_key = format!("{name} {}", serde_json::to_string(&args).unwrap_or_default());
        let level = loop_::tool_level(&name);
        if level.is_none() {
            let mut r = rt().lock().await;
            push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
            push_msg(&mut r, "tool", &format!("ERROR: tool tidak dikenal: {name}"));
            continue;
        }
        if seen.contains(&call_key) {
            // Model mengulang panggilan tool yang sama — hentikan dengan bahasa
            // user, bukan label internal loop.
            final_text = {
                let s = strip_tool_directive(&reply);
                if s.is_empty() {
                    "Aku berhenti karena langkah yang sama terulang tanpa hasil baru. Kalau tugasnya belum selesai, coba perjelas atau ubah instruksinya.".into()
                } else {
                    s
                }
            };
            break;
        }
        seen.insert(call_key);

        if level == Some("mutating") && plan_gate_required(&*rt().lock().await) {
            // PLAN APPROVAL GATE (Fase 2) — rencana yang disusun pada tugas
            // ini harus disetujui user SEBELUM mutasi pertama dieksekusi.
            // Gate ini TERPISAH dari gerbang izin tool (Fase 1): setelah
            // rencana disetujui, tool mutating tetap melewati gerbang izinnya
            // sendiri (atau allowlist sesi). Tidak ada tool yang dieksekusi
            // di jalur ini — hanya jeda + kartu rencana.
            bus::emit("permission_request", "update_plan");
            let id = format!("ap_{}", crate::config::base36_pub(now_ms() as u128));
            let plan_snapshot = rt().lock().await.plan.clone();
            let mut r = rt().lock().await;
            while r.approvals.len() >= 8 {
                r.approvals.remove(0);
            }
            r.approvals.push(json!({ "id": id, "kind": "plan", "tool": "update_plan", "args": { "todos": plan_snapshot }, "ts": now_ms() }));
            push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
            push_msg(&mut r, "tool", &format!("MENUNGGU PERSETUJUAN RENCANA (id {id}) — eksekusi dijeda sebelum mutasi pertama."));
            paused = true;
            final_text = format!("{}\n\n⏳ Rencana kerja menunggu setujumu di panel — aku jeda sebelum mengubah apa pun.", strip_tool_directive(&reply));
            break;
        }
        if level == Some("mutating") && !rt().lock().await.allowed.contains(&allow_key(&name, &args)) {
            // PERMISSION GATE — jeda, minta izin. Tool yang sudah di-allowlist
            // sesi (approve dengan "selalu izinkan") melewati blok ini dan
            // dieksekusi inline di bawah, dengan snapshot undo yang sama.
            bus::emit("permission_request", &name);
            let id = format!("ap_{}", crate::config::base36_pub(now_ms() as u128));
            let pub_args = loop_::public_tool_args(&name, &args);
            let mut r = rt().lock().await;
            while r.approvals.len() >= 8 {
                r.approvals.remove(0);
            }
            r.approvals.push(json!({ "id": id, "tool": name, "args": args, "ts": now_ms() }));
            push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
            push_msg(&mut r, "tool", &format!("MENUNGGU PERSETUJUAN: {name} {} (id {id})", serde_json::to_string(&pub_args).unwrap_or_default().chars().take(300).collect::<String>()));
            paused = true;
            final_text = format!("{}\n\n⏳ Aku butuh izinmu untuk {name} — cek panel Assistant.", strip_tool_directive(&reply));
            break;
        }

        // spawn_subagent: jalankan batch loop read-only paralel (async) — bukan
        // exec_tool sinkron. Hasil ringkasan masuk history orchestrator.
        if name == "spawn_subagent" {
            let tasks = crate::agent::subagent::parse_tasks(&args);
            let result = if tasks.is_empty() {
                "ERROR: task kosong — kirim {tasks:[{task:'...'}]} atau {task:'...'}".to_string()
            } else {
                bus::emit("tool_call_start", "spawn_subagent");
                let out = crate::agent::subagent::run_batch(config_path, root, &work_dir, tasks).await;
                bus::emit("tool_call_end", "spawn_subagent");
                out
            };
            let mut r = rt().lock().await;
            push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
            push_msg(&mut r, "tool", &format!("[spawn_subagent] {}", clip_tool(&result)));
            continue;
        }

        // update_plan: state terpisah dari teks — ubah rt.plan (bukan exec_tool).
        if name == "update_plan" {
            let reason = args.get("reason").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let result = match plan::sanitize_plan(args.get("todos").unwrap_or(&Value::Null)) {
                None => "ERROR: 'todos' kosong/invalid — kirim array {id,task,status}".to_string(),
                Some(todos) => {
                    let mut r = rt().lock().await;
                    let (ok, why) = plan::apply_plan(&mut r.plan, todos, &reason);
                    if ok {
                        // Rencana disusun pada tugas ini → plan-approval
                        // ter-armed (kontrak plan_gate_required).
                        r.plan_seq = r.ask_seq;
                        format!("Rencana diperbarui: {}", plan::plan_label(&r.plan))
                    } else {
                        format!("ERROR: {}", why.unwrap_or_default())
                    }
                }
            };
            let mut r = rt().lock().await;
            push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
            push_msg(&mut r, "tool", &format!("[update_plan] {result}"));
            continue;
        }

        // tool safe → eksekusi langsung (browser_* lewat jalur async manager,
        // motion_* lewat modul motion_tools dengan config_path + state model).
        // Tool mutating yang lolos allowlist sesi juga tiba di sini — snapshot
        // undo wajib sama seperti jalur approve().
        let is_mutating = level == Some("mutating");
        let snap = if is_mutating { snapshot_before(&wd, &name, &args) } else { None };
        // Label bus mengikuti kontrak panel (transcript.applyBus):
        //   tool_call_start → "name {json args…}"
        //   tool_call_end   → "name → hasil"
        // Dulu hanya nama telanjang — kartu aktivitas live tanpa isi & hasil.
        bus::emit("tool_call_start", &format!("{name} {}", serde_json::to_string(&args).unwrap_or_default()));
        let result = if loop_::is_browser_tool(&name) {
            crate::browser::agent_exec(root, &name, &args).await
        } else if loop_::is_motion_tool(&name) {
            let (model, role_map) = {
                let r = rt().lock().await;
                (r.model.clone(), r.role_map.clone())
            };
            crate::agent::motion_tools::exec(config_path, root, &name, &args, &model, &role_map).await
        } else {
            loop_::exec_tool(root, &wd, &name, &args)
        };
        bus::emit("tool_call_end", &format!("{name} → {}", first_line(&result, 160)));
        // Tandai + tangkap draft bila validasi lolos (report validator, bukan
        // ERROR) — dipakai untuk mengajukan motion_save bila model berhenti di
        // narasi. Hanya draft dengan tracks yang layak disimpan.
        if name == "motion_validate" && !result.starts_with("ERROR") {
            motion_validated = true;
            if let Some(m) = args.get("motion") {
                let has_tracks = m.get("tracks").and_then(|t| t.as_array()).map(|a| !a.is_empty()).unwrap_or(false);
                if has_tracks {
                    last_validated_draft = Some(m.clone());
                }
            }
        }
        let mut r = rt().lock().await;
        if is_mutating {
            // Mutasi tereksekusi pada tugas ini → plan-approval dilucuti
            // (kontrak: gate hanya SEBELUM mutasi pertama).
            r.mutated = true;
            if !result.starts_with("ERROR") {
                if let Some((rel, abs, prev)) = snap {
                    record_undo(&mut r, rel, abs, prev);
                }
            }
        }
        push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
        push_msg(&mut r, "tool", &format!("[{name}] {}", clip_tool(&result)));
    }

    if final_text.is_empty() {
        final_text = format!("(berhenti tanpa jawaban setelah {MAX_ITERATIONS} langkah — coba pecah tugasnya)");
    }
    let final_clean = strip_tool_directive(&final_text);
    if !paused {
        bus::emit("final_answer", "");
    }
    {
        let mut r = rt().lock().await;
        push_msg(&mut r, "assistant", &final_clean);
        if !paused {
            r.busy = false;
            r.active_task = None;
        }
    }
    AskResult { ok: true, reply: final_clean, paused, error: None }
}

fn clip_tool(s: &str) -> String {
    let n = s.chars().count();
    if n > 4000 {
        format!("{}\n…(terpotong)", s.chars().take(4000).collect::<String>())
    } else {
        s.to_string()
    }
}

/// Baris pertama hasil tool, dipotong — untuk label bus "name → hasil".
fn first_line(s: &str, max: usize) -> String {
    let line = s.lines().next().unwrap_or("").trim();
    let n = line.chars().count();
    if n > max {
        format!("{}…", line.chars().take(max).collect::<String>())
    } else if line.is_empty() {
        "(kosong)".into()
    } else {
        line.to_string()
    }
}

/// Snapshot isi file SEBELUM tool mutasi (write/edit/delete). None utk tool
/// non-file. Return (relPath, absPath, prevContent). prevContent None = file
/// belum ada (revert = hapus).
fn snapshot_before(work_dir: &Path, name: &str, args: &Value) -> Option<(String, PathBuf, Option<String>)> {
    if !matches!(name, "write_file" | "edit_file" | "delete_file") {
        return None;
    }
    let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if rel.is_empty() {
        return None;
    }
    let abs = tools::safe_path(work_dir, &rel).ok()?;
    let prev = std::fs::read_to_string(&abs).ok();
    Some((rel, abs, prev))
}

/// Catat rekaman undo + tandai file tersentuh (notes). Cap MAX_UNDO (FIFO).
/// Dedup: path dengan rekaman belum-reverted TIDAK dicatat ulang — rekaman
/// pertama = kondisi ASLI sebelum rantai mutasi, satu-satunya revert yang
/// bermakna (padanan execTool TS; tanpa ini revert pasca-mutasi-kedua
/// mengembalikan state antara, bukan state asli).
fn record_undo(r: &mut Runtime, rel: String, abs: PathBuf, prev: Option<String>) {
    let dup = r.undo.iter().any(|u| u.abs_path == abs && !u.reverted);
    if !dup {
        r.undo_seq += 1;
        let id = format!("un_{}_{}", crate::config::base36_pub(now_ms() as u128), r.undo_seq);
        r.undo.push(UndoRec { id, rel_path: rel.clone(), abs_path: abs, prev_content: prev, ts: now_ms(), reverted: false });
        if r.undo.len() > MAX_UNDO {
            let drop = r.undo.len() - MAX_UNDO;
            r.undo.drain(0..drop);
        }
    }
    if !r.notes_files.contains(&rel) {
        r.notes_files.push(rel);
        if r.notes_files.len() > MAX_NOTES {
            let drop = r.notes_files.len() - MAX_NOTES;
            r.notes_files.drain(0..drop);
        }
    }
}

/// Perbarui konteks tool motion tanpa mereset sesi (dipanggil dari ask/
/// ask-stream: model bisa dimuat/ganti SETELAH panel hidup — konteks yang
/// hanya dikirim saat start membeku usang).
pub async fn set_model_context(model: &str, role_map: Value) {
    let mut r = rt().lock().await;
    if !model.trim().is_empty() {
        r.model = model.trim().to_string();
    }
    if role_map.is_object() {
        r.role_map = role_map;
    }
}

/// POST /api/assistant/ask — jalankan tugas (loop penuh, sinkron).
pub async fn ask(config_path: &Path, root: &Path, text: &str) -> AskResult {
    {
        let mut r = rt().lock().await;
        // GUARD SATU-SLOT: dulu ask kedua diterima saat tugas pertama masih
        // jalan / menggantung di approval — dua run_loop bisa saling
        // menyisipkan pesan di history dan approval lama jadi bermakna ganda.
        // Sekarang ditolak dengan pesan jelas (panel menampilkannya apa adanya).
        if r.busy {
            return AskResult { ok: false, reply: String::new(), paused: false, error: Some("masih ada tugas yang sedang berjalan — tunggu selesai atau batalkan dulu".into()) };
        }
        if !r.approvals.is_empty() {
            return AskResult { ok: false, reply: String::new(), paused: false, error: Some("agent sedang menunggu keputusanmu di panel — setujui atau tolak dulu".into()) };
        }
        r.running = true;
        r.busy = true;
        r.cancel = false;
        let t: String = text.chars().take(4000).collect();
        let tid = format!("t_{}", r.next_task_seq);
        r.next_task_seq += 1;
        // Tugas baru = kontrak plan-approval di-reset: plan tugas lampau
        // tetap terlihat tapi tidak menggerbangi tugas ini.
        r.ask_seq += 1;
        r.plan_ok = false;
        r.mutated = false;
        r.active_task = Some(json!({ "taskId": tid, "prompt": t.chars().take(120).collect::<String>(), "status": "running" }));
        push_msg(&mut r, "user", &t);
    }
    run_loop(config_path, root).await
}

/// POST /api/assistant/modify {taskId?, text} — ganti tugas. Model core sinkron:
/// tanpa antrean parked penuh, "modify" = batalkan tugas aktif (kooperatif) lalu
/// jalankan pengganti di background. Return {ok, taskId, target}.
pub async fn modify(config_path: &Path, root: &Path, _task_id: &str, text: &str) -> Value {
    let text: String = text.chars().take(4000).collect();
    if text.trim().is_empty() {
        return json!({ "ok": false, "error": "teks task kosong" });
    }
    let (running, busy) = {
        let r = rt().lock().await;
        (r.running, r.busy)
    };
    if !running {
        return json!({ "ok": false, "error": "assistant mode tidak aktif" });
    }
    if busy {
        // Batalkan tugas aktif; pengganti dijalankan di background begitu slot bebas.
        {
            let mut r = rt().lock().await;
            r.cancel = true;
            push_msg(&mut r, "assistant", "(tugas diganti user)");
        }
        let cp = config_path.to_path_buf();
        let rt_root = root.to_path_buf();
        let replacement = text.clone();
        tokio::spawn(async move {
            // tunggu tugas lama melepas slot (cancel kooperatif), lalu jalankan.
            for _ in 0..600 {
                if !rt().lock().await.busy {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            let _ = ask(&cp, &rt_root, &replacement).await;
        });
        let tid = {
            let r = rt().lock().await;
            format!("t_{}", r.next_task_seq)
        };
        json!({ "ok": true, "taskId": tid, "target": "active" })
    } else {
        // Idle → jalankan sebagai tugas baru (foreground).
        let r = ask(config_path, root, &text).await;
        json!({ "ok": r.ok, "reply": r.reply, "paused": r.paused, "target": "idle" })
    }
}

/// POST /api/assistant/approve — resume loop setelah izin tool mutating.
/// `always` = sekalian masukkan tool/perintah ke allowlist sesi (gate
/// berikutnya untuk kunci yang sama tidak pause lagi).
pub async fn approve(config_path: &Path, root: &Path, id: &str, approve_it: bool, always: bool) -> AskResult {
    let pending = {
        let mut r = rt().lock().await;
        let idx = r.approvals.iter().position(|a| a.get("id").and_then(|x| x.as_str()) == Some(id));
        match idx {
            Some(i) => Some(r.approvals.remove(i)),
            None => None,
        }
    };
    let pending = match pending {
        Some(p) => p,
        None => return AskResult { ok: false, reply: String::new(), paused: false, error: Some(format!("approval tidak dikenal: {id}")) },
    };
    let name = pending.get("tool").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let args = pending.get("args").cloned().unwrap_or(json!({}));
    let work_dir = { rt().lock().await.work_dir.clone() };
    let wd = PathBuf::from(work_dir);

    // Plan approval (Fase 2): bukan eksekusi tool — hanya menandai rencana
    // disetujui (approve) atau dilucuti (reject, agar task tidak menggantung)
    // lalu resume loop. `always` tidak berlaku di sini (bukan allowlist tool).
    if pending.get("kind").and_then(|x| x.as_str()) == Some("plan") {
        let mut r = rt().lock().await;
        r.plan_ok = true;
        if approve_it {
            push_msg(&mut r, "tool", "User MENYETUJUI rencana kerja — lanjutkan eksekusi sesuai rencana.");
        } else {
            push_msg(&mut r, "tool", "User MENOLAK rencana kerja. Revisi pendekatan atau tanyakan user; jangan eksekusi rencana yang ditolak.");
        }
        drop(r);
        bus::emit("permission_resolved", &format!("{}: rencana kerja", if approve_it { "disetujui" } else { "ditolak" }));
        return run_loop(config_path, root).await;
    }

    bus::emit("permission_resolved", &format!("{}: {name}", if approve_it { "disetujui" } else { "ditolak" }));

    if approve_it {
        if always {
            let key = allow_key(&name, &args);
            rt().lock().await.allowed.insert(key);
            bus::emit("permission_resolved", &format!("diizinkan untuk sesi ini: {name}"));
        }
        // Snapshot undo SEBELUM tool mutasi file (write/edit/delete) dieksekusi.
        let snap = snapshot_before(&wd, &name, &args);
        bus::emit("tool_call_start", &format!("{name} {}", serde_json::to_string(&args).unwrap_or_default()));
        let result = if loop_::is_browser_tool(&name) {
            crate::browser::agent_exec(root, &name, &args).await
        } else if loop_::is_motion_tool(&name) {
            let (model, role_map) = {
                let r = rt().lock().await;
                (r.model.clone(), r.role_map.clone())
            };
            crate::agent::motion_tools::exec(config_path, root, &name, &args, &model, &role_map).await
        } else {
            loop_::exec_tool(root, &wd, &name, &args)
        };
        bus::emit("tool_call_end", &format!("{name} → {}", first_line(&result, 160)));
        let ok = !result.starts_with("ERROR");
        let mut r = rt().lock().await;
        // Mutasi tereksekusi pada tugas ini → plan-approval dilucuti.
        if loop_::tool_level(&name) == Some("mutating") {
            r.mutated = true;
        }
        if ok {
            if let Some((rel, abs, prev)) = snap {
                record_undo(&mut r, rel, abs, prev);
            }
        }
        push_msg(&mut r, "tool", &format!("[{name}] {}", clip_tool(&result)));
    } else {
        let mut r = rt().lock().await;
        push_msg(&mut r, "tool", &format!("User MENOLAK menjalankan {name}. Cari pendekatan lain atau tanyakan."));
    }
    run_loop(config_path, root).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("l2d{}-{}-{}", tag, std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn mock_config(dir: &Path) -> PathBuf {
        let f = dir.join("config.json");
        std::fs::write(&f, r#"{"activeId":"m","connections":[{"id":"m","provider":"mock"}]}"#).unwrap();
        f
    }

    #[tokio::test]
    async fn ask_no_tool_final_dgn_mock() {
        // Kunci bus global (lihat BUS_TEST_LOCK) — loop emit ke bus bersama.
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        // mock LLM (echo) tak emit "TOOL:" → loop langsung final.
        let dir = tmp_dir("as");
        let f = mock_config(&dir);
        start("/tmp/work", "", Value::Null).await;
        let res = ask(&f, &dir, "halo agent").await;
        assert!(res.ok);
        assert!(!res.paused);
        assert!(res.reply.to_lowercase().contains("halo"));
        stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ask_ditolak_saat_busy_atau_approval_menggantung() {
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir("asguard");
        let f = mock_config(&dir);
        start(&dir.to_string_lossy(), "", Value::Null).await;
        // busy=true → ask kedua ditolak dengan pesan jelas (bukan jalan paralel).
        {
            let mut r = rt().lock().await;
            r.busy = true;
        }
        let res1 = ask(&f, &dir, "tugas kedua").await;
        assert!(!res1.ok);
        assert!(res1.error.unwrap_or_default().contains("berjalan"));
        // approval pending → ditolak juga (approval harus diputuskan dulu).
        {
            let mut r = rt().lock().await;
            r.busy = false;
            r.approvals.push(json!({ "id": "ap_guard", "tool": "write_file", "args": {}, "ts": now_ms() }));
        }
        let res2 = ask(&f, &dir, "tugas ketiga").await;
        assert!(!res2.ok);
        assert!(res2.error.unwrap_or_default().contains("keputusan"));
        stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn start_memberi_warning_workdir_tidak_ada() {
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        stop().await;
        let dir = tmp_dir("aswd");
        let bogus = dir.join("nggak-ada-xyz");
        let res = start(bogus.to_str().unwrap(), "", Value::Null).await;
        assert!(res["warning"].is_string(), "workdir fiktif harus berwarning");
        let res2 = start(dir.to_str().unwrap(), "", Value::Null).await;
        assert!(res2["warning"].is_null(), "workdir sah tanpa warning");
        let res3 = start("", "", Value::Null).await;
        assert!(res3["warning"].is_null(), "workdir kosong (default) tanpa warning");
        stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn status_shape_panel() {
        // Padanan server-integration "/api/assistant/status selalu berisi shape
        // panel" — kunci field yang dibaca panel/probe.
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        stop().await;
        let s = status().await;
        for k in ["running", "busy", "workDir", "historyCount", "pendingApprovals", "plan", "notes", "lastEvent", "tools", "activeTask", "parkedTasks"] {
            assert!(s.get(k).is_some(), "field hilang: {k}");
        }
        assert!(s["notes"]["filesTouched"].is_array());
        let tools = s["tools"].as_array().unwrap();
        assert!(tools.len() >= 21, "registry tool < 21: {}", tools.len());
        let wf = tools.iter().find(|t| t["name"] == "write_file").unwrap();
        assert_eq!(wf["level"], "mutating");
        let rf = tools.iter().find(|t| t["name"] == "read_file").unwrap();
        assert_eq!(rf["level"], "safe");
        assert_eq!(s["lastEvent"], Value::Null); // runtime mati → null
    }

    /// Jalur approval sintetis (padanan agentRunApproved TS): push satu
    /// approval lalu approve(id, true) → exec_tool + snapshot/rekaman undo.
    async fn run_approved_tool(wd: &Path, name: &str, args: Value) {
        let id = format!("ap_test_{}", crate::config::base36_pub(now_ms() as u128));
        {
            let mut r = rt().lock().await;
            r.running = true;
            r.busy = true;
            r.work_dir = wd.to_string_lossy().to_string();
            r.approvals.push(json!({ "id": id, "tool": name, "args": args, "ts": now_ms() }));
        }
        let cfg = mock_config(wd);
        let res = approve(&cfg, wd, &id, true, false).await;
        assert!(res.ok);
    }

    #[tokio::test]
    async fn izin_sesi_allowlist_dan_stop_mengosongkan() {
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        // Kunci allowlist: tool lain per nama, run_command per perintah —
        // menyetujui satu perintah tidak mengizinkan perintah arbitrer lain.
        assert_eq!(allow_key("edit_file", &json!({})), "edit_file");
        assert_eq!(allow_key("run_command", &json!({ "command": "  cargo test  " })), "run_command:cargo test");
        assert_eq!(allow_key("run_command", &json!({})), "run_command");

        let wd = tmp_dir("allowlist");
        start(&wd.to_string_lossy(), "", Value::Null).await;
        let id = format!("ap_test_{}", crate::config::base36_pub(now_ms() as u128));
        {
            let mut r = rt().lock().await;
            r.running = true;
            r.busy = true;
            r.work_dir = wd.to_string_lossy().to_string();
            r.approvals.push(json!({ "id": id, "tool": "edit_file", "args": json!({ "path": "a.txt", "old": "x", "new": "y" }), "ts": now_ms() }));
        }
        let cfg = mock_config(&wd);
        let res = approve(&cfg, &wd, &id, true, true).await;
        assert!(res.ok);
        assert!(rt().lock().await.allowed.contains("edit_file"), "approve + always harus memasukkan allowlist");
        let st = status().await;
        assert!(st["allowlist"].as_array().unwrap().iter().any(|v| v == "edit_file"), "status mengekspos allowlist");

        stop().await;
        assert!(rt().lock().await.allowed.is_empty(), "stop() = batas sesi, allowlist kosong lagi");
        assert!(status().await["allowlist"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn plan_approval_lifecycle() {
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        // ── Kontrak keputusan (murni, tanpa LLM) ──
        let mut r = Runtime::default();
        assert!(!plan_gate_required(&r), "tanpa plan → tidak menggerbangi");
        r.ask_seq = 3;
        r.plan_seq = 2;
        assert!(!plan_gate_required(&r), "plan tugas lampau tidak menggerbangi tugas baru");
        r.plan_seq = 3;
        assert!(plan_gate_required(&r), "plan tugas berjalan + belum disetujui + belum mutasi → gate");
        r.plan_ok = true;
        assert!(!plan_gate_required(&r), "setelah approve tidak menggerbangi ulang");
        r.plan_ok = false;
        r.mutated = true;
        assert!(!plan_gate_required(&r), "setelah mutasi pertama gate dilucuti");

        // ── Lifecycle approve/reject lewat jalur approval asli ──
        // (LLM mock tidak scriptable — kartu plan dipush langsung persis
        // seperti yang dilakukan gate di run_loop.)
        let wd = tmp_dir("plan_gate");
        start(&wd.to_string_lossy(), "", Value::Null).await;
        let cfg = mock_config(&wd);
        {
            let mut r = rt().lock().await;
            r.ask_seq = 1;
            r.plan_seq = 1;
            r.plan = plan::sanitize_plan(&json!([
                { "id": "1", "task": "baca kode transport" },
                { "id": "2", "task": "perbaiki cara ambil port" },
                { "id": "3", "task": "jalankan test" },
            ])).unwrap();
        }
        assert!(plan_gate_required(&*rt().lock().await), "update_plan pada tugas ini → gate armed");
        let id = format!("ap_test_{}", crate::config::base36_pub(now_ms() as u128));
        let todos_snapshot = rt().lock().await.plan.clone();
        {
            let mut r = rt().lock().await;
            r.approvals.push(json!({ "id": id, "kind": "plan", "tool": "update_plan", "args": { "todos": todos_snapshot }, "ts": now_ms() }));
        }
        // Approve → rencana disetujui, loop resume, TIDAK ada eksekusi gantung.
        let res_ok = approve(&cfg, &wd, &id, true, false).await;
        assert!(res_ok.ok);
        assert!(!res_ok.paused, "approve rencana → resume tanpa approval yang tersisa");
        assert!(rt().lock().await.plan_ok, "approve menandai rencana disetujui");
        assert!(rt().lock().await.history.iter().any(|m| m["content"].as_str().unwrap_or("").contains("MENYETUJUI rencana")));
        assert!(rt().lock().await.approvals.is_empty(), "kartu rencana selesai dikonsumsi");

        // Reject → juga tidak menggantung (gate dilucuti, agent diarahkan revisi).
        let id2 = format!("ap_test_{}", crate::config::base36_pub(now_ms() as u128));
        {
            let mut r = rt().lock().await;
            r.approvals.push(json!({ "id": id2, "kind": "plan", "tool": "update_plan", "args": { "todos": [] }, "ts": now_ms() }));
        }
        let res_no = approve(&cfg, &wd, &id2, false, false).await;
        assert!(res_no.ok);
        assert!(!plan_gate_required(&*rt().lock().await), "reject melucuti gate (tidak ping-pong)");
        assert!(rt().lock().await.history.iter().any(|m| m["content"].as_str().unwrap_or("").contains("MENOLAK rencana")));

        // Mutasi pertama tereksekusi → gate dilucuti walau plan disusun ulang.
        run_approved_tool(&wd, "write_file", json!({ "path": "x.txt", "content": "v1" })).await;
        assert!(rt().lock().await.mutated, "approve jalur tool menandai mutated");
        {
            let mut r = rt().lock().await;
            r.plan_seq = r.ask_seq; // agent menyusun ulang rencana setelah mutasi
        }
        assert!(!plan_gate_required(&*rt().lock().await), "setelah mutasi, update_plan cuma pelacakan");

        // Tugas baru via ask() sungguhan (LLM mock) → kontrak di-reset.
        let res_task = ask(&cfg, &wd, "halo").await;
        assert!(res_task.ok);
        {
            let r = rt().lock().await;
            assert!(!r.plan_ok && !r.mutated, "tugas baru: kontrak plan-approval mulai bersih");
            assert!(!plan_gate_required(&r), "plan tugas lampau tidak menggerbangi");
        }
        stop().await;
    }

    #[tokio::test]
    async fn undo_snapshot_revert_mutation_paths() {
        // Port agent-undo.test.ts: edit/write/delete pada workDir temp →
        // rekaman + revert memulihkan kondisi asli.
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        let wd = tmp_dir("undo");
        start(&wd.to_string_lossy(), "", Value::Null).await;

        // (1) edit_file file lama → kind modified; revert memulihkan.
        std::fs::create_dir_all(wd.join("src")).unwrap();
        std::fs::write(wd.join("src").join("a.txt"), "kondisi asli\n").unwrap();
        run_approved_tool(&wd, "edit_file", json!({ "path": "src/a.txt", "old": "asli", "new": "diubah agent" })).await;
        assert!(std::fs::read_to_string(wd.join("src").join("a.txt")).unwrap().contains("diubah agent"));
        let list = undo_list().await;
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["path"], "src/a.txt");
        assert_eq!(list[0]["kind"], "modified");
        let msg = revert(list[0]["id"].as_str().unwrap()).await.unwrap();
        assert!(msg.contains("Dikembalikan"));
        assert_eq!(std::fs::read_to_string(wd.join("src").join("a.txt")).unwrap(), "kondisi asli\n");

        // (2) write_file file BARU → kind created; revert menghapus file.
        run_approved_tool(&wd, "write_file", json!({ "path": "new/b.txt", "content": "baru" })).await;
        assert!(wd.join("new").join("b.txt").exists());
        let list = undo_list().await;
        let rec = list.as_array().unwrap().iter().find(|u| u["path"] == "new/b.txt").unwrap();
        assert_eq!(rec["kind"], "created");
        revert(rec["id"].as_str().unwrap()).await.unwrap();
        assert!(!wd.join("new").join("b.txt").exists());

        // (3) delete_file file lama → revert mengembalikan isi.
        std::fs::write(wd.join("c.txt"), "jangan hilang").unwrap();
        run_approved_tool(&wd, "delete_file", json!({ "path": "c.txt" })).await;
        assert!(!wd.join("c.txt").exists());
        let list = undo_list().await;
        let rec = list.as_array().unwrap().iter().find(|u| u["path"] == "c.txt").unwrap();
        assert_eq!(rec["kind"], "modified");
        revert(rec["id"].as_str().unwrap()).await.unwrap();
        assert_eq!(std::fs::read_to_string(wd.join("c.txt")).unwrap(), "jangan hilang");

        // (4) revert ganda → Err; id asing → Err; path di luar workDir tak tercatat.
        std::fs::write(wd.join("d.txt"), "x").unwrap();
        run_approved_tool(&wd, "write_file", json!({ "path": "d.txt", "content": "y" })).await;
        let list = undo_list().await;
        let rec = list.as_array().unwrap().iter().find(|u| u["path"] == "d.txt").unwrap();
        revert(rec["id"].as_str().unwrap()).await.unwrap();
        assert!(revert(rec["id"].as_str().unwrap()).await.is_err());
        assert!(revert("un_tidak_ada").await.is_err());
        run_approved_tool(&wd, "write_file", json!({ "path": "../outside.txt", "content": "no" })).await;
        let list = undo_list().await;
        assert!(list.as_array().unwrap().iter().all(|u| !u["path"].as_str().unwrap_or("").contains("outside.txt")));
        assert!(!wd.parent().unwrap().join("outside.txt").exists());

        stop().await;
        let _ = std::fs::remove_dir_all(&wd);
    }

    #[tokio::test]
    async fn undo_dedup_keeps_original_condition() {
        // Padanan guard "dua mutasi beruntun pada path sama → SATU rekaman":
        // rekaman pertama = kondisi ASLI sebelum rantai; revert mengembalikan
        // state paling awal, bukan state antara.
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        let wd = tmp_dir("unedup");
        start(&wd.to_string_lossy(), "", Value::Null).await;
        std::fs::write(wd.join("e.txt"), "asli-e").unwrap();
        run_approved_tool(&wd, "write_file", json!({ "path": "e.txt", "content": "v1" })).await;
        run_approved_tool(&wd, "write_file", json!({ "path": "e.txt", "content": "v2" })).await;
        let list = undo_list().await;
        let recs: Vec<_> = list.as_array().unwrap().iter().filter(|u| u["path"] == "e.txt").collect();
        assert_eq!(recs.len(), 1, "rantai mutasi path sama harus satu rekaman");
        revert(recs[0]["id"].as_str().unwrap()).await.unwrap();
        assert_eq!(std::fs::read_to_string(wd.join("e.txt")).unwrap(), "asli-e");
        stop().await;
        let _ = std::fs::remove_dir_all(&wd);
    }

    #[tokio::test]
    async fn undo_cap_fifo() {
        // Cap MAX_UNDO (20, kontrak MODES.md): rekaman terlama dibuang.
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        let wd = tmp_dir("uncap");
        start(&wd.to_string_lossy(), "", Value::Null).await;
        for i in 0..25 {
            run_approved_tool(&wd, "write_file", json!({ "path": format!("cap/f{i}.txt"), "content": format!("x{i}") })).await;
        }
        let r = rt().lock().await;
        assert_eq!(r.undo.len(), MAX_UNDO);
        assert_eq!(r.undo[0].rel_path, "cap/f5.txt"); // f0..f4 terbuang
        drop(r);
        stop().await;
        let _ = std::fs::remove_dir_all(&wd);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_kooperatif() {
        // Port agent-cancel.test.ts: (1) ask me-reset flag sisa → tak bocor
        // antar tugas; (2) cancel saat ask berjalan → reply "Dibatalkan",
        // runtime TETAP hidup (beda dgn stop); (3) accepted saat busy,
        // ditolak saat idle.
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        let wd = tmp_dir("canc");
        let cfg = mock_config(&wd);
        start(&wd.to_string_lossy(), "", Value::Null).await;

        // (1) flag sisa dibuang ask baru — jawaban bukan "Dibatalkan".
        { rt().lock().await.cancel = true; }
        let r = ask(&cfg, &wd, "tugas segar").await;
        assert!(r.ok);
        assert_ne!(r.reply, "Dibatalkan oleh user.");
        assert!(!rt().lock().await.cancel);

        // (2) cancel di tengah ask (mock delay 300 ms): flag dibaca antar-turn —
        // mock final di turn 0, jadi ask tetap selesai normal; yang dikunci:
        // runtime HIDUP & busy lepas (padanan semantik agent-cancel TS).
        let (cp, root) = (cfg.clone(), wd.clone());
        let h = tokio::spawn(async move { ask(&cp, &root, "tugas yang dicancl di tengah").await });
        for _ in 0..100 {
            if rt().lock().await.busy { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let c = cancel().await;
        assert_eq!(c["accepted"], true);
        let r = h.await.unwrap();
        assert!(r.ok);
        {
            let r2 = rt().lock().await;
            assert!(r2.running, "cancel tidak mematikan runtime (beda dgn stop)");
            assert!(!r2.busy);
        }

        // (3) saat idle → accepted false.
        let idle = cancel().await;
        assert_eq!(idle["accepted"], false);
        stop().await;
        assert_eq!(cancel().await["accepted"], false, "runtime mati → ditolak");
        let _ = std::fs::remove_dir_all(&wd);
    }

    #[test]
    fn strip_directive() {
        let t = "Baik, aku baca.\nTOOL: read_file {\"path\":\"x\"}\nsisa";
        let s = strip_tool_directive(t);
        assert!(!s.contains("TOOL:"));
        assert!(s.contains("Baik"));
    }
}
