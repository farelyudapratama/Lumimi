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

use crate::agent::{bus, loop_, memory, plan, sessions, store, tools};
use crate::llm::{self, ChatMessage};

const MAX_ITERATIONS: usize = 25;
/// Batas durasi keseluruhan satu tugas agent (ms). Dicek di awal tiap langkah.
const TASK_MAX_DURATION_MS: u64 = 15 * 60 * 1000;
const MAX_HISTORY: usize = 60;
/// Berapa kali tool yang sama berturut-turut dianggap macet.
const STUCK_SAME_TOOL_RUN: usize = 6;
/// Panggilan tool+argumen IDENTIK ke-N: ke-2 tetap dijalankan + peringatan,
/// ke-3 menghentikan tugas (loop sungguhan). Lihat kebijakan panggilan-ulang.
const REPEAT_CALL_STOP: usize = 3;
/// Berapa kali berturut-turut balasan boleh gagal diparse sebagai tool call
/// sebelum tugas dihentikan (format rusak berulang = model tidak sanggup).
const PARSE_FAIL_STOP: usize = 3;
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

pub struct Runtime {
    pub running: bool,
    pub busy: bool,
    pub work_dir: String,
    /// Sesi store yang terikat runtime saat ini (`assistant-sessions.json`).
    /// Kosong = belum terikat (belum ada permukaan yang menyentuh agent) —
    /// ask tetap jalan tapi transcript tidak dipersist. Bind terjadi saat:
    /// start panel/hand-off chat (→ sesi run aplikasi) atau switch rail.
    pub session_id: String,
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
    /// Permintaan batal (watch channel). Watch, bukan bool polos: pemegang
    /// Receiver (panggilan LLM, run_command) bisa MENUNGGU pembatalan secara
    /// real-time — dulu flag bool cuma terbaca antar-langkah, jadi LLM atau
    /// perintah yang menggantung tetap jalan sampai selesai walau user
    /// menekan Stop.
    cancel_tx: tokio::sync::watch::Sender<bool>,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
    /// True saat run_loop berhenti dalam keadaan paused (menunggu keputusan
    /// approval; busy tetap true). Loop SUDAH exit pada keadaan ini, jadi
    /// cancel/modify yang menggantung tak akan pernah dikonsumsi loop lama —
    /// keduanya wajib membersihkan sendiri approval + slot.
    paused: bool,
    /// Lokasi store sesi (dipakai cancel() yang tak punya akses parameter
    /// data_dir untuk mempersist catatan pembatalan ke sesi terikat).
    data_dir: Option<PathBuf>,
    /// Run observability aktif di store (data/agent-store.db). None = store
    /// tidak aktif (gagal buka / test tanpa init) — semua operasi fail-soft.
    run_id: Option<i64>,
    /// Penomor urutan eksekusi tool dalam run.
    run_seq: u64,
    /// Penghitung panggilan LLM tugas berjalan (orchestrator + subagent).
    llm_calls: u64,
    active_task: Option<Value>, // {taskId, prompt, status} — untuk status panel
    next_task_seq: u64,        // penomor taskId
    undo_seq: u64,             // penomor id undo (id unik walau ms sama)
    /// Jenis tugas berjalan dari classify_task() — dipakai run_loop menentukan
    /// versi ucap laporan akhir (greeting tidak diucapkan ulang).
    task_type: String,
}

impl Default for Runtime {
    fn default() -> Self {
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        Self {
            running: false,
            busy: false,
            work_dir: String::new(),
            session_id: String::new(),
            model: String::new(),
            role_map: Value::Null,
            history: Vec::new(),
            approvals: Vec::new(),
            allowed: Default::default(),
            ask_seq: 0,
            plan_seq: 0,
            plan_ok: false,
            mutated: false,
            plan: Vec::new(),
            notes_files: Vec::new(),
            undo: Vec::new(),
            cancel_tx,
            cancel_rx,
            paused: false,
            data_dir: None,
            run_id: None,
            run_seq: 0,
            llm_calls: 0,
            active_task: None,
            next_task_seq: 0,
            undo_seq: 0,
            task_type: String::new(),
        }
    }
}

fn rt() -> &'static Mutex<Runtime> {
    static R: OnceLock<Mutex<Runtime>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Runtime::default()))
}

fn push_msg(r: &mut Runtime, role: &str, content: &str) {
    r.history.push(json!({ "role": role, "content": content }));
    trim_history(&mut r.history);
}

/// Batas konten history dalam CHAR (approximation token ~1:4). Batas jumlah
/// pesan saja tak cukup: hasil tool (maks 4.000 char/pesan) bisa menumpuk
/// hingga ratusan ribu char dan meledakkan konteks model kecil — provider
/// akan menolak dengan 400 dan tugas gagal keras. Pangkas dari pesan tua.
const MAX_HISTORY_CHARS: usize = 120_000;

/// Pangkas history ke MAX_HISTORY + anggaran MAX_HISTORY_CHARS sambil
/// MEMPERTAHANKAN pesan user pertama (tujuan tugas). Pemotongan dilaporkan
/// ke bus agar tidak terjadi diam-diam.
fn trim_history(history: &mut Vec<Value>) {
    if history.len() > MAX_HISTORY {
        let keep_first = history.first().map(|m| m.get("role").and_then(|x| x.as_str()) == Some("user")).unwrap_or(false);
        let head = if keep_first { 1 } else { 0 };
        let drop = history.len() - MAX_HISTORY;
        history.drain(head..head + drop);
        bus::emit("context_trimmed", &format!("{drop} pesan lama dibuang (tujuan tugas dipertahankan)"));
    }
    let size = |m: &Value| m.get("content").and_then(|c| c.as_str()).map(|s| s.len()).unwrap_or(0);
    let mut total: usize = history.iter().map(|m| size(m)).sum();
    if total > MAX_HISTORY_CHARS {
        let keep_first = history.first().map(|m| m.get("role").and_then(|x| x.as_str()) == Some("user")).unwrap_or(false);
        let head = if keep_first { 1 } else { 0 };
        let mut dropped = 0usize;
        // Selalu sisakan pesan pertama (tujuan) + satu pesan terbaru.
        while history.len() > head + 1 && total > MAX_HISTORY_CHARS {
            total -= size(&history[head]);
            history.remove(head);
            dropped += 1;
        }
        if dropped > 0 {
            bus::emit("context_trimmed", &format!("{dropped} pesan lama dibuang (anggaran konten {MAX_HISTORY_CHARS} char; tujuan tugas dipertahankan)"));
        }
    }
}

/// Anggaran panggilan LLM per tugas (termasuk subagent). Melampaui = tugas
/// dihentikan dengan pesan jelas, bukan dibiarkan jalan tanpa batas.
const MAX_LLM_CALLS_PER_TASK: u64 = 60;

/// Permintaan batal untuk tugas berjalan (dibaca subagent di tiap langkah).
pub(crate) async fn is_cancelled() -> bool {
    let r = rt().lock().await;
    let c = *r.cancel_rx.borrow();
    c
}

/// Clone sinyal batal untuk diteruskan ke panggilan LLM / run_command agar
/// pembatalan terasa real-time (bukan hanya antar-langkah loop).
pub(crate) async fn cancel_receiver() -> tokio::sync::watch::Receiver<bool> {
    rt().lock().await.cancel_rx.clone()
}

/// Hitung satu panggilan LLM. Return false bila anggaran tugas sudah habis.
pub(crate) async fn spend_llm_call() -> bool {
    let mut r = rt().lock().await;
    if r.llm_calls >= MAX_LLM_CALLS_PER_TASK {
        return false;
    }
    r.llm_calls += 1;
    true
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ── Observability store (fail-soft: tak perna menggagalkan tugas) ───────────

/// Tutup run di store dengan status final. run_id dibersihkan.
fn finish_run(r: &mut Runtime, status: &str, error: Option<&str>) {
    if let Some(rid) = r.run_id.take() {
        store::end_run(rid, status, error, r.llm_calls);
    }
}

/// Tandai run paused (tunggu keputusan approval) — run tetap terbuka.
fn pause_run(r: &Runtime) {
    if let Some(rid) = r.run_id {
        store::set_run_status(rid, "paused");
    }
}

/// Kunci allowlist sesi: per-tool, KECUALI run_command yang dikelompokkan
/// per perintah dan write/edit/delete_file yang dikelompokkan per FOLDER
/// induk path — "selalu izinkan" pada satu file bukan berarti path apa pun
/// di workdir ikut terbuka selama sesi (dulu kunci hanya nama tool: satu
/// persetujuan membuka seluruh workdir). Eksekusi tetap lewat safe_path,
/// jadi path di luar workdir tetap ditolak apa pun kuncinya.
fn allow_key(name: &str, args: &Value) -> String {
    if name == "run_command" {
        let cmd = args.get("command").and_then(|v| v.as_str()).unwrap_or("").trim();
        if !cmd.is_empty() {
            return format!("run_command:{cmd}");
        }
    }
    if matches!(name, "write_file" | "edit_file" | "delete_file") {
        let p = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim().replace('\\', "/");
        // "sub/a.txt" → "sub"; "a.txt" → "." (akar workdir). Path ".." lolos
        // di kunci tapi tetap ditolak safe_path saat eksekusi.
        let dir = match p.rfind('/') {
            Some(i) if i > 0 => p[..i].to_string(),
            _ => ".".to_string(),
        };
        return format!("{name}:{dir}");
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

/// Bind runtime ke sesi store: ganti `rt.session_id`, hydrate `rt.history`
/// dari pesan tersimpan, dan jadikan sesi itu aktif (persist — kontrak
/// MODES.md "pindah sesi TIDAK mematikan runtime"). Ditolak saat tugas
/// berjalan: history yang sedang dipakai loop tidak boleh diganti di bawah
/// kaki loop.
pub async fn bind_session(data_dir: &Path, id: &str) -> Result<Value, String> {
    let mut r = rt().lock().await;
    if r.busy {
        return Err("tugas sedang berjalan — sesi tidak bisa diganti sekarang".into());
    }
    let msgs = sessions::messages(data_dir, id)
        .ok_or_else(|| format!("sesi tidak dikenal: {id}"))?;
    let mut hist: Vec<Value> = msgs
        .into_iter()
        .filter(|m| {
            let role = m.get("role").and_then(|x| x.as_str()).unwrap_or("");
            role == "user" || role == "assistant"
        })
        .collect();
    if hist.len() > MAX_HISTORY {
        let drop = hist.len() - MAX_HISTORY;
        hist.drain(0..drop);
    }
    r.session_id = id.to_string();
    r.history = hist;
    sessions::switch_to(data_dir, id);
    Ok(json!({ "ok": true, "id": id, "count": r.history.len() }))
}

/// Sesi store yang sedang terikat runtime ("" bila belum).
pub async fn bound_session() -> String {
    rt().lock().await.session_id.clone()
}

/// Slot tugas sedang dipakai? Guard untuk operasi yang menyentuh ikatan sesi.
pub async fn is_busy() -> bool {
    rt().lock().await.busy
}

/// Lepas ikatan sesi (sesi terikat dihapus & store kosong). History runtime
/// ikut dikosongkan — tanpa sesi, tidak ada transcript yang bermakna.
pub async fn unbind_session() {
    let mut r = rt().lock().await;
    r.session_id.clear();
    r.history.clear();
}

/// Mulai/attach runtime ke workDir. Bus di-reset (sesi baru). `model` +
/// `role_map` opsional: konteks untuk tool motion (motion_*).
pub async fn start(work_dir: &str, model: &str, role_map: Value) -> Value {
    bus::reset();
    let mut r = rt().lock().await;
    r.running = true;
    r.busy = false;
    let _ = r.cancel_tx.send(false);
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
        "sessionId": r.session_id,
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
    r.paused = false;
    let _ = r.cancel_tx.send(false);
    r.history.clear();
    r.approvals.clear();
    r.allowed.clear();
    // session_id SENGAJA dipertahankan: stop = batas sesi runtime (allowlist
    // dsb.), bukan unbind dari store — start berikutnya hydrate ulang
    // transcript sesi yang sama, bukan mulai kosong.
    r.ask_seq = 0;
    r.plan_seq = 0;
    r.plan_ok = false;
    r.mutated = false;
    r.plan.clear();
    r.notes_files.clear();
    r.undo.clear();
    r.active_task = None;
    finish_run(&mut r, "cancelled", Some("runtime dihentikan (stop)"));
    json!({ "ok": true })
}

/// GET /api/assistant/history.
pub async fn history() -> Value {
    let r = rt().lock().await;
    Value::Array(r.history.clone())
}

/// POST /api/assistant/quip — dua mode (aturan alur respons):
///  - mode reaksi (default): {persona?, event?} — komentar singkat atas
///    langkah yang baru saja dilakukan ( SUARA pet/VTuber), LLM role "chat",
///    stateless, gagal → {quip:"", error}.
///  - mode ack: {persona?, ackType, input?} — respons PEMBUKA setelah jenis
///    tugas diketahui (#2): sapaan → balas sapa; search/coding/general →
///    konfirmasi singkat lalu eksekusi.
/// Stance orang pertama berlaku untuk keduanya: karakter adalah PEKERJANYA —
/// melapor atas kerjanya sendiri, bukan pengawas yang menyuruh/memantau.
pub async fn quip(config_path: &Path, persona: &str, event: &str, ack_type: &str, input: &str) -> Value {
    let persona: String = persona.chars().take(800).collect();
    let event: String = event.chars().take(160).collect();
    let ack_type: String = ack_type.chars().take(24).collect();
    let input: String = input.chars().take(160).collect();
    let en = lang_of(config_path) == "en";
    let stance = if en {
        "You are a living character (desktop pet / VTuber) who is PERSONALLY doing the user's task with your own tools. Speak in FIRST person (\"I\") — you are the one doing the work, never a supervisor watching or ordering someone else. One casual spoken line, max 15 words, with personality. Never mention tool names, file paths, or technical terms. No emoji, no quotation marks."
    } else {
        "Kamu adalah karakter hidup (pet / VTuber) yang SENDIRI mengerjakan tugas dari user dengan alat-alatmu. Bicara ORANG PERTAMA (\"aku\") — kamu pekerjanya, bukan pengawas yang memantau atau menyuruh pihak lain. Satu kalimat santai maksimal 15 kata, dengan kepribadian. Jangan sebut nama tool, path file, atau istilah teknis. Tanpa emoji, tanpa tanda kutip."
    };
    let (base, user) = if !ack_type.is_empty() {
        // Mode ACK: jenis tugas sudah diketahui → boleh bicara (#1–#2).
        let (instr_en, instr_id) = match ack_type.as_str() {
            "greeting" => (
                "The user greeted you — greet back briefly and naturally.",
                "User menyapamu — balas sapaannya singkat dan natural.",
            ),
            "search" => (
                "The user asked you to find files — briefly confirm WHAT you are going to look for, then you start searching.",
                "User minta kamu mencari sesuatu — konfirmasikan singkat APA yang akan kamu cari, lalu pencarianmulah berjalan.",
            ),
            "coding" => (
                "The user gave you a coding task — briefly confirm you are starting to work on it.",
                "User memberi tugas coding — konfirmasikan singkat bahwa kamu mulai mengerjakannya.",
            ),
            _ => (
                "The user gave you a task — briefly confirm you are starting to work on it.",
                "User memberi sebuah tugas — konfirmasikan singkat bahwa kamu mulai mengerjakannya.",
            ),
        };
        let base = if en {
            format!("{stance}\n\n{instr_en}")
        } else {
            format!("{stance}\n\n{instr_id}")
        };
        let clipped = if input.is_empty() {
            String::new()
        } else if en {
            format!("User's message: {input}")
        } else {
            format!("Pesan user: {input}")
        };
        (base, if clipped.is_empty() {
            if en { "a new task just arrived".to_string() } else { "tugas baru saja masuk".to_string() }
        } else { clipped })
    } else {
        // Mode reaksi (lama): label langkah = aksi karakter sendiri.
        let base = if en {
            format!("{stance}\n\nThe user message notes a step YOU just took in that work — report it aloud. Treat technical notes (tool names, paths) as your own activity log; never say them out loud. Occasionally you MAY engage the user — a neat thing you found or a quick question — so it feels like working together, not a monologue.")
        } else {
            format!("{stance}\n\nPesan user mencatat langkah yang BARU saja kamu lakukan — laporkan dengan suara. Catatan teknis (nama tool, path) anggap log aktivitasmu sendiri; jangan diucapkan. Sesekali BOLEH melibatkan user — kabar menarik yang kamu temui atau pertanyaan ringan — supaya terasa mengerjakan bersama, bukan monolog.")
        };
        let user = if event.trim().is_empty() {
            if en { "you just started sketching your work plan".to_string() }
            else { "kamu baru saja mulai menyusun rencana kerjamu".to_string() }
        } else { event };
        (base, user)
    };
    let sys = if persona.trim().is_empty() {
        base
    } else if en {
        format!("{base}\n\nYour character:\n{persona}")
    } else {
        format!("{base}\n\nKaraktermu:\n{persona}")
    };
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

/// POST /api/assistant/cancel — minta batal kooperatif. Dua keadaan:
/// - tugas BERJALAN → set sinyal batal; dibaca loop antar-langkah, panggilan
///   LLM, dan run_command (watch channel).
/// - tugas MENUNGGU keputusan (paused: loop sudah exit) → bersihkan approval
///   menggantung + lepas slot langsung; tak ada lagi yang mengonsumsi sinyal,
///   dulu flag ini menggantung sampai user memaksa approve/reject.
pub async fn cancel() -> Value {
    let mut r = rt().lock().await;
    if !r.running {
        return json!({ "ok": true, "accepted": false });
    }
    if r.paused {
        r.approvals.clear();
        r.busy = false;
        r.paused = false;
        r.active_task = None;
        finish_run(&mut r, "cancelled", None);
        let _ = r.cancel_tx.send(false); // dikonsumsi langsung, jangan bocor ke tugas berikut
        push_msg(&mut r, "assistant", "Dibatalkan oleh user.");
        let sid = r.session_id.clone();
        let dir = r.data_dir.clone();
        drop(r);
        bus::emit("error", "dibatalkan: oleh user");
        if let (true, Some(dir)) = (!sid.is_empty(), dir) {
            sessions::append(&dir, &sid, &[json!({"role":"assistant","content":"Dibatalkan oleh user."})]);
        }
        return json!({ "ok": true, "accepted": true });
    }
    if !r.busy && r.approvals.is_empty() {
        return json!({ "ok": true, "accepted": false });
    }
    let _ = r.cancel_tx.send(true);
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
    /// Versi jawaban yang LAZY DIUCAPKAN companion: sudah tersanitasi
    /// (tanpa markdown/kode/path) dan gepuk pendek. Kosong = tidak perlu
    /// diucapkan (tugas greeting — ack awal sudah menjadi balasannya;
    /// kegagalan/cancel — panel cukup menampilkan teksnya).
    pub speak: String,
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

/// Klasifikasi jenis tugas dari input user (aturan alur respons #1–#2) —
/// DETERMINISTIK (kata kunci id+en, lowercase), tanpa LLM: companion tidak
/// boleh bicara sebelum jenis tugas diketahui, jadi klasifikasi wajib
/// selesai instan SEBELUM loop jalan. Salah klasifikasi hanya mengubah diksi
/// ack awal, bukan jalur eksekusi. Urutan: greeting → search → coding →
/// general (paling spesifik duluan).
pub fn classify_task(text: &str) -> &'static str {
    let t = text.trim().to_lowercase();
    if t.is_empty() {
        return "general";
    }
    // Sapaan: pendek DAN kata pertamanya kata sapa umum.
    let first = t
        .split(|c: char| c.is_whitespace() || c == '!' || c == '?' || c == '.' || c == ',')
        .next()
        .unwrap_or("");
    let greetings = [
        "halo", "hallo", "hai", "hi", "hello", "hey", "yo", "oi", "pagi", "siang", "sore",
        "malam", "assalamualaikum", "permisi", "sup", "test", "tes", "ping",
    ];
    if t.split_whitespace().count() <= 4 && greetings.contains(&first) {
        return "greeting";
    }
    // Pencarian file/lokasi: frasa cari + objek file-ish.
    let search_cues = [
        "cari file", "cari folder", "cari di", "temukan file", "temukan folder", "di mana file",
        "dimana file", "lokasi file", "lokasi folder", "daftar file", "list file", "isi folder",
        "file apa saja", "file apa aja", "ada file", "show files", "find file", "search file",
        "where is the file", "where's the file", "locate the file",
    ];
    if search_cues.iter().any(|c| t.contains(c)) {
        return "search";
    }
    // Perintah coding: kosakata dev eksplisit (kata kerja umum seperti
    // "buat"/"ubah" SENGAJA tidak dipakai sendirian — terlalu sering tugas
    // non-coding).
    let coding_cues = [
        "bug", "error", "fix", "perbaiki", "perbaik", "refactor", "implement", "fungsi",
        "function", "komponen", "component", "endpoint", "api", "css", "html", "javascript",
        "typescript", "rust", "crate", "compile", "build", "unit test", "script", "kode",
        "kodenya", "code", "commit", "deploy", "typescript", "logika",
    ];
    if coding_cues.iter().any(|c| t.contains(c)) {
        return "coding";
    }
    "general"
}

/// Batas versi ucap laporan akhir — cukup untuk 2–3 kalimat ringkasan.
const SPEECH_MAX_CHARS: usize = 320;

/// Sanitasi teks jawaban menjadi versi yang LAZY DIUCAPKAN companion (aturan
/// alur respons #4): buang blok/inline kode, penanda markdown, link (sisip
/// teksnya), path panjang (→ nama berkas), emoji/simbol, dan gepuk di batas
/// kalimat terakhir yang muat. Detail teknis tetap utuh di reply panel.
pub fn sanitize_speech(text: &str) -> String {
    let mut s = text.to_string();
    // Blok kode ```...``` (multi-baris) dibuang; inline `kode` dicopot
    // backtick-nya (isinya bisa jadi kata bermakna, mis. nama fungsi pendek).
    while let Some(a) = s.find("```") {
        match s[a + 3..].find("```") {
            Some(b) => {
                let end = a + 3 + b + 3;
                s.replace_range(a..end, " ");
            }
            None => {
                s.replace_range(a.., " ");
                break;
            }
        }
    }
    let mut s = s.chars().filter(|&c| c != '`').collect::<String>();
    // Link & gambar markdown: [teks](url) → teks.
    let mut cleaned = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '[' {
            if let Some(close) = chars[i + 1..].iter().position(|&x| x == ']') {
                let j = i + 1 + close;
                if j + 1 < chars.len() && chars[j + 1] == '(' {
                    if let Some(p) = chars[j + 2..].iter().position(|&x| x == ')') {
                        for &k in &chars[i + 1..j] {
                            cleaned.push(k);
                        }
                        i = j + 2 + p + 1;
                        continue;
                    }
                }
            }
        }
        cleaned.push(c);
        i += 1;
    }
    s = cleaned;
    // Penanda markdown & simbol tak alami diucapkan: header, emphasis,
    // blockquote, bullet, pemisah tabel/garis, backtick sisa. Numbered list
    // SENGAJA tidak distrip — kalimat yang diawali angka bisa bermakna.
    let mut flat = String::with_capacity(s.len());
    for line in s.lines() {
        let l = line.trim_start();
        let l = l.trim_start_matches('#').trim_start();
        let l = l.strip_prefix('>').map(str::trim_start).unwrap_or(l);
        let l = l.trim_start_matches(['-', '*', '+']).trim_start();
        let line_chars: Vec<char> = l.chars().collect();
        for (idx, &ch) in line_chars.iter().enumerate() {
            match ch {
                // Underscore dibuang sebagai penanda emphasis (_miring_), tapi
                // DIPERTAHANKAN di antara alfanumerik — itu bagian nama
                // identifier (parse_cfg) yang justru membantu pelafalan.
                '_' => {
                    let prev = if idx > 0 { line_chars[idx - 1] } else { ' ' };
                    let next = line_chars.get(idx + 1).copied().unwrap_or(' ');
                    if !(prev.is_alphanumeric() && next.is_alphanumeric()) {
                        continue;
                    }
                    flat.push(ch);
                }
                // '*'/'#'/'`'/'|' = penanda markdown; '~' SENGAJA dipertahankan
                // — itu gaya bicara karakter produk ini ("beres~").
                '*' | '#' | '`' | '|' => {}
                _ => flat.push(ch),
            }
        }
        flat.push(' ');
    }
    s = flat;
    // Path panjang → basename (nama berkas/folder terakhir).
    let words: Vec<String> = s
        .split_whitespace()
        .map(|w| {
            let bare = w.trim_matches(|c: char| {
                !c.is_alphanumeric() && c != '/' && c != '\\' && c != '.' && c != '-' && c != '_'
            });
            let has_sep = bare.contains('/') || bare.contains('\\');
            if has_sep && bare.chars().count() >= 12 {
                let base = bare.rsplit(['/', '\\']).next().unwrap_or(bare);
                w.replace(bare, base)
            } else {
                w.to_string()
            }
        })
        .collect();
    s = words.join(" ");
    // Emoji/simbol: tidak natural diucapkan (TTS melompati atau membaca nama).
    s = s
        .chars()
        .filter(|&c| {
            !matches!(c as u32,
                0x2190..=0x21FF     // panah
                | 0x2300..=0x23FF   // jam/pasir (⏳)
                | 0x2600..=0x27BF   // simbol dingbat
                | 0xFE0F            // variation selector emoji
                | 0x1F000..=0x1FAFF // emoji penuh
            )
        })
        .collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    // Gepuk di batas kalimat terakhir yang muat.
    let n = s.chars().count();
    if n > SPEECH_MAX_CHARS {
        let cut: String = s.chars().take(SPEECH_MAX_CHARS).collect();
        match cut.rfind(['.', '!', '?', '…']) {
            Some(p) if p >= SPEECH_MAX_CHARS / 2 => cut[..=p].to_string(),
            _ => cut.trim_end().to_string() + "…",
        }
    } else {
        s
    }
    .trim()
    .to_string()
}

/// Jalankan loop dari history saat ini sampai final / paused / batas iterasi.
/// Runtime di-lock per-langkah (lepas saat await LLM) supaya status bisa dibaca.
/// `data_dir` = lokasi store sesi untuk persist transcript.
async fn run_loop(config_path: &Path, root: &Path, data_dir: &Path) -> AskResult {
    let lang = lang_of(config_path);
    let (work_dir, model_name) = { let r = rt().lock().await; (r.work_dir.clone(), r.model.clone()) };
    let wd = PathBuf::from(&work_dir);
    let mut cancel_rx = cancel_receiver().await;
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut last_tool: Option<String> = None;
    let mut run: usize = 0;
    let mut final_text = String::new();
    let mut paused = false;
    // Anti "ngaku simpan tapi tak memanggil tool": bila draft sudah divalidasi
    // tapi model mencoba mengakhiri tanpa motion_save, ajukan simpan sendiri
    // (pakai draft yang tervalidasi) lewat kartu izin — tak bergantung model
    // mengeluarkan ulang JSON besar.
    let mut motion_validated = false;
    let mut last_validated_draft: Option<Value> = None;
    // Penghitung pemulihan: format panggilan rusak & balasan kosong berturut-
    // turut (di-reset tiap kali model menghasilkan panggilan yang bisa dibaca).
    let mut parse_fails = 0usize;
    let mut empty_replies = 0usize;
    // Guard jawaban-final dipakai SEKALI per tugas (rencana belum beres).
    let mut plan_guard_used = false;
    // Status run store: "done" default; "stopped" bila berhenti tanpa jawaban
    // bermakna (macet/timeout/iterasi habis).
    let mut run_status = "done";

    // Batas durasi keseluruhan tugas (di luar batas langkah).
    let task_deadline = std::time::Instant::now() + std::time::Duration::from_millis(TASK_MAX_DURATION_MS);
    let mut timed_out = false;
    for _turn in 0..MAX_ITERATIONS {
        if std::time::Instant::now() >= task_deadline {
            timed_out = true;
            break;
        }
        // Cancel kooperatif: dicek di awal tiap turn (loop lepas lock saat await
        // LLM, jadi /cancel dari request lain bisa menyetel sinyal ini).
        {
            let mut r = rt().lock().await;
            if *r.cancel_rx.borrow() {
                let _ = r.cancel_tx.send(false);
                push_msg(&mut r, "assistant", "Dibatalkan oleh user.");
                finish_run(&mut r, "cancelled", None);
                r.busy = false;
                r.active_task = None;
                let sid = r.session_id.clone();
                drop(r);
                if !sid.is_empty() {
                    sessions::append(data_dir, &sid, &[json!({"role":"assistant","content":"Dibatalkan oleh user."})]);
                }
                bus::emit("error", "dibatalkan: oleh user");
                return AskResult { ok: true, reply: "Dibatalkan oleh user.".into(), speak: String::new(), paused: false, error: None };
            }
        }
        if !spend_llm_call().await {
            let msg = format!("anggaran tugas habis ({MAX_LLM_CALLS_PER_TASK} panggilan LLM) — tugas dihentikan, coba pecah tugasnya");
            bus::emit("error", &msg);
            let mut r = rt().lock().await;
            push_msg(&mut r, "assistant", &msg);
            finish_run(&mut r, "stopped", Some(&msg));
            r.busy = false;
            r.active_task = None;
            return AskResult { ok: false, reply: String::new(), speak: String::new(), paused: false, error: Some(msg) };
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

        // Panggilan LLM cancel-aware: /cancel menghentikan request yang
        // menggantung secara real-time (dulu loop cuma membaca flag antar-
        // langkah — LLM yang nge-hang tetap jalan sampai selesai).
        let reply = match llm::llm_for_role_cancelable(config_path, "assistant", &messages, &system, &loop_::tool_defs_json(), &mut cancel_rx).await {
            Ok(ok) => ok.reply,
            Err((499, _)) => {
                // Dibatalkan saat menunggu LLM — bukan error provider.
                let mut r = rt().lock().await;
                let _ = r.cancel_tx.send(false);
                push_msg(&mut r, "assistant", "Dibatalkan oleh user.");
                finish_run(&mut r, "cancelled", None);
                r.busy = false;
                r.active_task = None;
                let sid = r.session_id.clone();
                drop(r);
                if !sid.is_empty() {
                    sessions::append(data_dir, &sid, &[json!({"role":"assistant","content":"Dibatalkan oleh user."})]);
                }
                bus::emit("error", "dibatalkan: oleh user");
                return AskResult { ok: true, reply: "Dibatalkan oleh user.".into(), speak: String::new(), paused: false, error: None };
            }
            Err((_, msg)) => {
                bus::emit("error", &msg);
                let mut r = rt().lock().await;
                push_msg(&mut r, "assistant", &format!("⚠️ {msg}"));
                // Tugas GAGAL = slot lepas — dulu busy & active_task dibiarkan
                // tergantung sehingga agent "brick" (composer mati, ask berikut
                // ditolak, cancel tak pernah dikonsumsi karena loop sudah exit).
                finish_run(&mut r, "failed", Some(&msg));
                r.busy = false;
                r.active_task = None;
                return AskResult { ok: false, reply: String::new(), speak: String::new(), paused: false, error: Some(msg) };
            }
        };

        let detected = loop_::detect_tool_call(&reply);
        let (name, args, args_truncated) = match detected {
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
                    pause_run(&mut r);
                    paused = true;
                    final_text = "Draft sudah divalidasi — aku ajukan simpan ke library. Setujui di panel Assistant untuk menyimpannya.".to_string();
                    break;
                }
                // Upaya tool RUSAK (ada direktif tapi tak bisa diparse) →
                // umpan-balik perbaikan format, BUKAN akhir senyap. Dulu balasan
                // sampah ini jadi "jawaban final" — model lemah yang salah
                // format terlihat berhenti mendadak tanpa kesempatan memperbaiki.
                if loop_::count_tool_directives(&reply) > 0 {
                    parse_fails += 1;
                    empty_replies = 0;
                    if parse_fails >= PARSE_FAIL_STOP {
                        final_text = "Aku berhenti: panggilan tool berkali-kali tidak bisa dibaca karena formatnya rusak. Coba perjelas instruksinya atau pecah tugasnya.".into();
                        bus::emit("error", "macet: format panggilan tool rusak berulang");
                        run_status = "stopped";
                        break;
                    }
                    let names = loop_::TOOLS.iter().map(|t| t.name).collect::<Vec<_>>().join(", ");
                    let mut r = rt().lock().await;
                    push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
                    push_msg(&mut r, "tool", &format!(
                        "ERROR: FORMAT PANGGILAN TOOL RUSAK — aku tidak bisa membaca panggilanmu. Ulangi dengan PERSIS satu baris (JSON valid, tanpa markdown, tanpa pindah baris di dalam JSON):\nTOOL: <nama> {{json}}\nTool yang tersedia: {names}. Kalau tugas sudah selesai, berikan jawaban final TANPA directive TOOL."
                    ));
                    continue;
                }
                // Balasan KOSONG (budget reasoning habis / stream putus) →
                // minta jawab langsung, maks 2x, baru menyerah dengan jujur.
                if reply.trim().is_empty() {
                    empty_replies += 1;
                    parse_fails = 0;
                    if empty_replies <= 2 {
                        let mut r = rt().lock().await;
                        push_msg(&mut r, "tool", "Balasanmu KOSONG (budget output kemungkinan habis untuk reasoning sebelum jawaban terbentuk). Jawab LANGSUNG sekarang: hasil akhir singkat, atau SATU baris 'TOOL: <nama> {json}' — tanpa reasoning panjang.");
                        continue;
                    }
                    final_text = "(kosong)".into();
                    break;
                }
                // Guard jawaban-final: rencana TUGAS INI masih punya langkah
                // belum beres → sekali feed-balik (tuntaskan / tandai failed
                // dgn alasan), jangan biarkan kabur setengah jalan. Kedua kalinya
                // final tetap diterima — model bisa punya alasan sah berhenti.
                {
                    let r = rt().lock().await;
                    let plan_aktif = r.plan_seq == r.ask_seq && !r.plan.is_empty();
                    let sisa: Vec<String> = if plan_aktif {
                        r.plan.iter().filter(|p| {
                            let st = p.get("status").and_then(|s| s.as_str()).unwrap_or("pending");
                            st == "pending" || st == "in_progress"
                        }).map(|p| p.get("task").and_then(|t| t.as_str()).unwrap_or("?").to_string()).collect()
                    } else {
                        Vec::new()
                    };
                    drop(r);
                    if !sisa.is_empty() && !plan_guard_used {
                        plan_guard_used = true;
                        let mut r = rt().lock().await;
                        push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
                        push_msg(&mut r, "tool", &format!(
                            "Tugas BELUM BOLEH diakhiri: rencana masih punya {} langkah belum selesai: {}. Tuntaskan langkahnya (atau tandai failed dengan alasan lewat update_plan), lalu beri jawaban final.",
                            sisa.len(),
                            sisa.join("; ")
                        ));
                        continue;
                    }
                }
                final_text = reply;
                break;
            }
            Some(d) => d,
        };
        parse_fails = 0;
        empty_replies = 0;
        // Catatan bila balasan memuat lebih dari satu panggilan tool: hanya
        // yang pertama dieksekusi — model harus tahu sisanya TIDAK terjadi.
        let multi_note = if loop_::count_tool_directives(&reply) > 1 {
            Some(format!("\n(catatan sistem: balasanmu memuat lebih dari satu panggilan tool — hanya '{name}' yang dijalankan; satu tool per giliran, ulangi sisanya di giliran berikutnya)"))
        } else {
            None
        };
        let call_key = format!("{name} {}", serde_json::to_string(&args).unwrap_or_default());
        let level = loop_::tool_level(&name);
        if level.is_none() {
            let mut r = rt().lock().await;
            push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
            push_msg(&mut r, "tool", &format!("ERROR: tool tidak dikenal: {name}"));
            continue;
        }
        // Kebijakan panggilan-ulang: panggilan tool+argumen IDENTIK.
        // Ke-2 tetap dijalankan (keadaan bisa berubah) + peringatan ke model;
        // ke-3 = loop sungguhan → hentikan dengan bahasa user, bukan label
        // internal loop. Dulu SATU pengulangan pun langsung menghentikan
        // tugas — terlalu keras untuk tugas panjang (mis. re-read setelah edit).
        let rep = seen.get(&call_key).copied().unwrap_or(0) + 1;
        if rep >= REPEAT_CALL_STOP {
            final_text = {
                let s = strip_tool_directive(&reply);
                if s.is_empty() {
                    "Aku berhenti karena langkah yang sama terulang tanpa hasil baru. Kalau tugasnya belum selesai, coba perjelas atau ubah instruksinya.".into()
                } else {
                    s
                }
            };
            bus::emit("error", "macet: panggilan identik berulang");
            run_status = "stopped";
            break;
        }
        seen.insert(call_key, rep);
        let repeat_note = if rep == REPEAT_CALL_STOP - 1 {
            Some(format!("\n(peringatan: panggilan {name} dengan argumen IDENTIK ini sudah pernah dijalankan di tugas ini — hasilnya ada di atas. Bila keadaan berubah boleh saja; kalau tidak, ubah pendekatan, jangan ulangi.)"))
        } else {
            None
        };
        // Sufiks yang menempel di hasil tool (catatan multi-call + peringatan
        // pengulangan) supaya model membacanya bersama hasilnya.
        // Peringatan JSON terpotong: subset argumen yang diselamatkan BISA
        // tidak lengkap — write_file/edit_file jangan dianggap utuh. Dulu
        // file setengah jadi tertulis tanpa jejak apa pun.
        let trunc_note = if args_truncated {
            "\n(peringatan sistem: JSON panggilan tool terpotong di tengah transmisi — hanya sebagian argumen yang bisa diselamatkan. Bila ini write_file/edit_file, isi yang tertulis KEMUNGKINAN TIDAK LENGKAP: baca ulang file dan tulis ulang utuh sebelum melanjutkan.)"
        } else {
            ""
        };
        let result_suffix = format!(
            "{}{}{}",
            multi_note.as_deref().unwrap_or(""),
            repeat_note.as_deref().unwrap_or(""),
            trunc_note
        );

        // Macet berbasis pola: tool yang sama dipanggil berulang tanpa henti
        // (argumen boleh sedikit berbeda) dihentikan sebelum habis 25 langkah.
        run = if last_tool.as_deref() == Some(name.as_str()) { run + 1 } else { 1 };
        last_tool = Some(name.clone());
        if run >= STUCK_SAME_TOOL_RUN {
            final_text = format!("Aku berhenti: tool {name} dipanggil {run} kali berturut-turut tanpa kemajuan. Coba perjelas instruksinya.");
            bus::emit("error", "macet: tool sama berulang");
            run_status = "stopped";
            break;
        }
        if let Some(err) = loop_::validate_args(&name, &args) {
            let mut r = rt().lock().await;
            push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
            push_msg(&mut r, "tool", &format!("[{name}] {err}"));
            continue;
        }

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
            pause_run(&mut r);
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
                bus::emit("error", "approval terlama dibuang: antrean izin penuh");
            }
            r.approvals.push(json!({ "id": id, "tool": name, "args": args, "ts": now_ms() }));
            push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
            push_msg(&mut r, "tool", &format!("MENUNGGU PERSETUJUAN: {name} {} (id {id})", serde_json::to_string(&pub_args).unwrap_or_default().chars().take(300).collect::<String>()));
            pause_run(&mut r);
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
                let out = crate::agent::subagent::run_batch(config_path, root, &work_dir, tasks, cancel_rx.clone()).await;
                bus::emit("tool_call_end", "spawn_subagent");
                out
            };
            let mut r = rt().lock().await;
            r.run_seq += 1;
            if let Some(rid) = r.run_id {
                store::log_tool(rid, r.run_seq, "spawn_subagent", "safe", &loop_::public_tool_args("spawn_subagent", &args), &result, 0);
            }
            push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
            push_msg(&mut r, "tool", &format!("[spawn_subagent] {}{result_suffix}", clip_tool(&result)));
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
                        if let Some(rid) = r.run_id {
                            store::set_plan(rid, &r.plan);
                        }
                        // Kontrak verifikasi: langkah done tanpa note bukti
                        // diperingatkan langsung di hasil tool (aturan 13).
                        let warning = plan::unverified_done_warning(&r.plan);
                        format!("Rencana diperbarui: {}{}", plan::plan_label(&r.plan), warning)
                    } else {
                        format!("ERROR: {}", why.unwrap_or_default())
                    }
                }
            };
            let mut r = rt().lock().await;
            r.run_seq += 1;
            if let Some(rid) = r.run_id {
                store::log_tool(rid, r.run_seq, "update_plan", "safe", &loop_::public_tool_args("update_plan", &args), &result, 0);
            }
            push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
            push_msg(&mut r, "tool", &format!("[update_plan] {result}{result_suffix}"));
            continue;
        }

        // tool safe → eksekusi langsung (browser_* lewat jalur async manager,
        // motion_* lewat modul motion_tools dengan config_path + state model).
        // Tool mutating yang lolos allowlist sesi juga tiba di sini — snapshot
        // undo wajib sama seperti jalur approve().
        let is_mutating = level == Some("mutating");
        let snap = if is_mutating { snapshot_before(&wd, &name, &args) } else { None };
        let tool_started = std::time::Instant::now();
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
            crate::agent::motion_tools::exec(config_path, root, &name, &args, &model, &role_map, &cancel_rx).await
        } else {
            loop_::exec_tool(root, &wd, &name, &args, &mut cancel_rx).await
        };
        bus::emit("tool_call_end", &format!("{name} → {}", first_line(&result, 160)));
        let duration_ms = tool_started.elapsed().as_millis() as u64;
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
        // Observability: catat eksekusi tool ke store (fail-soft) — argumen
        // lewat public_tool_args, isi file direraksi store::redact_args.
        {
            r.run_seq += 1;
            if let Some(rid) = r.run_id {
                store::log_tool(rid, r.run_seq, &name, level.unwrap_or("safe"), &loop_::public_tool_args(&name, &args), &result, duration_ms);
            }
        }
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
        // Captcha terdeteksi oleh inspect → jeda untuk user, bukan keputusan model.
        if loop_::is_browser_tool(&name) {
            let note = crate::browser::captcha_note().await;
            if let Some(kind) = note.get("captcha").and_then(|k| k.as_str()) {
                let id = format!("ap_{}", crate::config::base36_pub(now_ms() as u128));
                let mut r = rt().lock().await;
                push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
                push_msg(&mut r, "tool", &format!("[{name}] {result}{result_suffix}"));
                r.approvals.push(json!({ "id": id, "kind": "captcha", "tool": name, "args": { "captcha": kind }, "ts": now_ms() }));
                bus::emit("permission_request", "captcha");
                pause_run(&mut r);
                paused = true;
                final_text = format!("⏳ Captcha ({kind}) terdeteksi di halaman. Selesaikan di jendela browser, lalu tekan lanjut di panel.");
                break;
            }
            // Halaman login/MFA → jeda yang sama: kredensial HANYA boleh diisi
            // user langsung di jendela browser (tool type menolak field
            // rahasia). Setelah user login & menekan lanjut, loop memeriksa
            // ulang halaman dan tugas berlanjut dari state yang sama.
            let lnote = crate::browser::login_note().await;
            if let Some(hint) = lnote.get("login").and_then(|k| k.as_str()) {
                let id = format!("ap_{}", crate::config::base36_pub(now_ms() as u128));
                let mut r = rt().lock().await;
                push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
                push_msg(&mut r, "tool", &format!("[{name}] {result}{result_suffix}\n{hint}"));
                r.approvals.push(json!({ "id": id, "kind": "login", "tool": name, "args": {}, "ts": now_ms() }));
                bus::emit("permission_request", "login");
                pause_run(&mut r);
                paused = true;
                final_text = "⏳ Halaman login terdeteksi — aku jeda di sini. Isi kredensial LANGSUNG di jendela browser (password/OTP hanya boleh kamu isi sendiri), lalu tekan lanjut di panel Assistant.".to_string();
                break;
            }
        }
        if name == "run_command" && !result.starts_with("ERROR") {
            bus::emit("undo_unavailable", "run_command tidak bisa di-undo — efeknya permanen");
        }
        push_msg(&mut r, "assistant", &strip_tool_directive(&reply));
        push_msg(&mut r, "tool", &format!("[{name}] {}{result_suffix}", clip_tool(&result)));
    }

    if final_text.is_empty() {
        run_status = "stopped";
        final_text = if timed_out {
            format!("(berhenti: batas waktu tugas {} menit tercapai — coba pecah tugasnya)", TASK_MAX_DURATION_MS / 60_000)
        } else {
            format!("(berhenti tanpa jawaban setelah {MAX_ITERATIONS} langkah — coba pecah tugasnya)")
        };
    }
    let final_clean = strip_tool_directive(&final_text);
    // Versi UCAPAN laporan akhir (aturan alur respons #3): sanitasi markdown/
    // kode/path + gepuk kalimat. Tugas greeting tidak diucapkan lagi — ack
    // klasifikasi sudah menjadi balasan sapaannya; jawaban penuh tetap di
    // panel. Paused TETAP diucapkan: teksnya instruksi ke user (izin/captcha).
    let task_type = { let r = rt().lock().await; r.task_type.clone() };
    let speak = if task_type == "greeting" {
        String::new()
    } else {
        sanitize_speech(&final_clean)
    };
    if !paused {
        bus::emit("final_answer", "");
        // Run selesai untuk semua jalur non-pause (final normal, macet,
        // timeout, iterasi habis) — status "stopped" bila tanpa jawaban.
        let mut r = rt().lock().await;
        finish_run(&mut r, run_status, if run_status == "stopped" { Some(final_clean.as_str()) } else { None });
    }
    {
        let mut r = rt().lock().await;
        push_msg(&mut r, "assistant", &final_clean);
        // paused = loop exit sambil menunggu keputusan approval: slot TIDAK
        // dilepas (busy tetap true) tapi runtime mencatat keadaannya supaya
        // cancel()/modify() tahu harus membersihkan sendiri (loop sudah exit).
        r.paused = paused;
        if !paused {
            r.busy = false;
            r.active_task = None;
        }
        // Persist giliran assistant final ke sesi terikat (transcript store).
        // Jalur error LLM sudah return di atas — tidak menulis giliran gagal.
        let sid = r.session_id.clone();
        if !sid.is_empty() {
            sessions::append(data_dir, &sid, &[json!({"role":"assistant","content":&final_clean})]);
        }
    }
    AskResult { ok: true, reply: final_clean, speak, paused, error: None }
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
/// `session` opsional: `Some("run")` = ikat dulu runtime ke sesi run aplikasi
/// (dipakai hand-off chat/panggung — percakapan companion selalu berlabuh ke
/// sesi run, terpisah dari pilihan manual rail).
pub async fn ask(config_path: &Path, root: &Path, data_dir: &Path, text: &str, session: Option<&str>) -> AskResult {
    if session == Some("run") {
        // Bind GAGAL saat busy → ask di bawah menolak dengan pesan yang sama;
        // bind sukses = runtime berlabuh ke sesi run sebelum tugas jalan.
        let run = sessions::ensure_run_session(data_dir);
        if let Some(id) = run.get("id").and_then(|i| i.as_str()) {
            if bound_session().await != id {
                let _ = bind_session(data_dir, id).await;
            }
        }
    }
    {
        let mut r = rt().lock().await;
        // GUARD SATU-SLOT: dulu ask kedua diterima saat tugas pertama masih
        // jalan / menggantung di approval — dua run_loop bisa saling
        // menyisipkan pesan di history dan approval lama jadi bermakna ganda.
        // Sekarang ditolak dengan pesan jelas (panel menampilkannya apa adanya).
        if r.busy {
            let msg = if r.paused {
                "agent sedang menunggu keputusanmu di panel — setujui, tolak, atau batalkan dulu".to_string()
            } else {
                "masih ada tugas yang sedang berjalan — tunggu selesai atau batalkan dulu".to_string()
            };
            return AskResult { ok: false, reply: String::new(), speak: String::new(), paused: false, error: Some(msg) };
        }
        if !r.approvals.is_empty() {
            return AskResult { ok: false, reply: String::new(), speak: String::new(), paused: false, error: Some("agent sedang menunggu keputusanmu di panel — setujui atau tolak dulu".into()) };
        }
        r.running = true;
        r.busy = true;
        r.paused = false;
        let _ = r.cancel_tx.send(false); // sinyal sisa tugas lampau dibuang
        r.data_dir = Some(data_dir.to_path_buf());
        // Store observability: buka (idempoten) lalu catat run baru. Fail-soft —
        // kegagalan disk tidak boleh menggagalkan tugas.
        store::init(root);
        let sid = r.session_id.clone();
        r.run_id = None;
        r.run_seq = 0;
        let t: String = text.chars().take(4000).collect();
        let tid = format!("t_{}", r.next_task_seq);
        r.next_task_seq += 1;
        // Tugas baru = kontrak plan-approval di-reset: plan tugas lampau
        // tetap terlihat tapi tidak menggerbangi tugas ini.
        r.ask_seq += 1;
        r.plan_ok = false;
        r.mutated = false;
        r.llm_calls = 0;
        // Klasifikasi jenis tugas DULU (aturan alur respons #1): event
        // task_classified dikirim SEBELUM loop → companion diam sampai jenis
        // tugas diketahui, lalu memberi ack sesuai konteks (#2). Salah ketik
        // klasifikasi hanya mengubah diksi ack, bukan eksekusi.
        let ctype = classify_task(&t);
        r.task_type = ctype.to_string();
        r.active_task = Some(json!({ "taskId": tid, "prompt": t.chars().take(120).collect::<String>(), "status": "running" }));
        push_msg(&mut r, "user", &t);
        bus::emit("task_classified", ctype);
        // Run observability dimulai SETELAH tugas dikenal — catat teks tugas
        // agar run_history bisa menemukannya. Fail-soft.
        {
            let model_now = r.model.clone();
            r.run_id = store::begin_run(&sid, &t, &model_now);
        }
        // Persist giliran user ke sesi terikat SEBELUM loop (tugas jalan lama
        // pun sudah tercatat; approval resume menambah giliran final nanti).
        let sid = r.session_id.clone();
        drop(r);
        if !sid.is_empty() {
            sessions::append(data_dir, &sid, &[json!({"role":"user","content":&t})]);
        }
    }
    run_loop(config_path, root, data_dir).await
}

/// POST /api/assistant/modify {taskId?, text} — ganti tugas. Model core sinkron:
/// tanpa antrean parked penuh, "modify" = batalkan tugas aktif (kooperatif) lalu
/// jalankan pengganti di background. Return {ok, taskId, target}.
pub async fn modify(config_path: &Path, root: &Path, data_dir: &Path, _task_id: &str, text: &str) -> Value {
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
        // Pengganti dijalankan di background begitu slot bebas. Dua keadaan:
        // - paused (menunggu approval; loop sudah exit): buang kartu menggantung
        //   + lepas slot LANGSUNG — dulu modify di keadaan ini hanya menyetel
        //   flag batal yang tak pernah dikonsumsi, tugas pengganti menunggu 60
        //   detik lalu gagal senyap.
        // - berjalan: set sinyal batal (dibaca loop/LLM/run_command real-time).
        {
            let mut r = rt().lock().await;
            if r.paused {
                r.approvals.clear();
                r.busy = false;
                r.paused = false;
                r.active_task = None;
                bus::emit("error", "approval menggantung dibuang: tugas diganti user");
            } else {
                let _ = r.cancel_tx.send(true);
            }
            push_msg(&mut r, "assistant", "(tugas diganti user)");
        }
        let cp = config_path.to_path_buf();
        let rt_root = root.to_path_buf();
        let rt_data = data_dir.to_path_buf();
        let replacement = text.clone();
        tokio::spawn(async move {
            // tunggu tugas lama melepas slot (cancel kooperatif), lalu jalankan.
            for _ in 0..600 {
                if !rt().lock().await.busy {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            let _ = ask(&cp, &rt_root, &rt_data, &replacement, None).await;
        });
        let tid = {
            let r = rt().lock().await;
            format!("t_{}", r.next_task_seq)
        };
        json!({ "ok": true, "taskId": tid, "target": "active" })
    } else {
        // Idle → jalankan sebagai tugas baru (foreground).
        let r = ask(config_path, root, data_dir, &text, None).await;
        json!({ "ok": r.ok, "reply": r.reply, "speak": r.speak, "paused": r.paused, "target": "idle" })
    }
}

/// POST /api/assistant/approve — resume loop setelah izin tool mutating.
/// `always` = sekalian masukkan tool/perintah ke allowlist sesi (gate
/// berikutnya untuk kunci yang sama tidak pause lagi).
pub async fn approve(config_path: &Path, root: &Path, data_dir: &Path, id: &str, approve_it: bool, always: bool) -> AskResult {
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
        None => return AskResult { ok: false, reply: String::new(), speak: String::new(), paused: false, error: Some(format!("approval tidak dikenal: {id}")) },
    };
    // Loop akan dilanjutkan di bawah — keadaan pause berakhir di sini.
    rt().lock().await.paused = false;
    let mut cancel_rx = cancel_receiver().await;
    let name = pending.get("tool").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let args = pending.get("args").cloned().unwrap_or(json!({}));
    let work_dir = { rt().lock().await.work_dir.clone() };
    let wd = PathBuf::from(work_dir);

    // Captcha & login: bukan eksekusi tool. "Lanjut" = inspect ulang halaman;
    // bila captcha/login masih ada, kartu dikembalikan dan loop tidak jalan.
    let kind = pending.get("kind").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if kind == "captcha" || kind == "login" {
        let result = crate::browser::agent_exec(root, "browser_inspect", &json!({})).await;
        if crate::browser::captcha_note().await.get("captcha").is_some() {
            rt().lock().await.approvals.push(pending);
            return AskResult { ok: false, reply: String::new(), speak: String::new(), paused: true, error: Some("captcha masih terdeteksi — selesaikan dulu di jendela browser".into()) };
        }
        if crate::browser::login_note().await.get("login").is_some() {
            rt().lock().await.approvals.push(pending);
            return AskResult { ok: false, reply: String::new(), speak: String::new(), paused: true, error: Some("masih di halaman login — selesaikan login dulu di jendela browser (password/OTP diisi kamu sendiri), lalu tekan lanjut".into()) };
        }
        let mut r = rt().lock().await;
        push_msg(&mut r, "tool", &format!("[browser_inspect] {result}"));
        push_msg(&mut r, "tool", &format!("User menyelesaikan {kind}; halaman sudah diperiksa ulang. Lanjutkan tugas dari state halaman sekarang."));
        drop(r);
        bus::emit("permission_resolved", &format!("{kind}: lanjut"));
        return run_loop(config_path, root, data_dir).await;
    }

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
        return run_loop(config_path, root, data_dir).await;
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
        let tool_started = std::time::Instant::now();
        let result = if loop_::is_browser_tool(&name) {
            crate::browser::agent_exec(root, &name, &args).await
        } else if loop_::is_motion_tool(&name) {
            let (model, role_map) = {
                let r = rt().lock().await;
                (r.model.clone(), r.role_map.clone())
            };
            crate::agent::motion_tools::exec(config_path, root, &name, &args, &model, &role_map, &cancel_rx).await
        } else {
            loop_::exec_tool(root, &wd, &name, &args, &mut cancel_rx).await
        };
        bus::emit("tool_call_end", &format!("{name} → {}", first_line(&result, 160)));
        let ok = !result.starts_with("ERROR");
        let mut r = rt().lock().await;
        {
            r.run_seq += 1;
            if let Some(rid) = r.run_id {
                store::log_tool(rid, r.run_seq, &name, loop_::tool_level(&name).unwrap_or("safe"), &loop_::public_tool_args(&name, &args), &result, tool_started.elapsed().as_millis() as u64);
            }
        }
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
    run_loop(config_path, root, data_dir).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_task_tipe_dasar() {
        assert_eq!(classify_task("halo"), "greeting");
        assert_eq!(classify_task("Halo!"), "greeting");
        assert_eq!(classify_task("pagi, ada?"), "greeting");
        assert_eq!(classify_task("hi there!"), "greeting");
        // Sapaan + kalimat panjang → bukan greeting (ada isi tugas).
        assert_ne!(classify_task("halo, tolong perbaiki bug di login ya"), "greeting");
        assert_eq!(classify_task("cari file konfigurasi di project"), "search");
        assert_eq!(classify_task("di mana file readme"), "search");
        assert_eq!(classify_task("where is the file config"), "search");
        assert_eq!(classify_task("tolong perbaiki bug di modul login"), "coding");
        assert_eq!(classify_task("refactor fungsi parse"), "coding");
        assert_eq!(classify_task("jelaskan cara kerja promise"), "general");
        assert_eq!(classify_task(""), "general");
    }

    #[test]
    fn sanitize_speech_bersihkan_markdown_dan_path() {
        // Blok kode dibuang, inline code dipertahankan tanpa backtick.
        let s = sanitize_speech("Hasil:\n```rust\nfn main() {}\n```\npanggil `parse_cfg` ya.");
        assert!(!s.contains("```"));
        assert!(!s.contains("fn main"));
        assert!(s.contains("parse_cfg"));
        // Markdown: header/emphasis/link/bullet hilang, teks link tetap.
        let s = sanitize_speech("## Laporan\n- **fix** `auth` di [halaman login](http://x/y)");
        assert!(!s.contains("##"));
        assert!(!s.contains("**"));
        assert!(!s.contains("http"));
        assert!(s.contains("halaman login"));
        // Path panjang → basename; pendek dibiarkan.
        let s = sanitize_speech("aku ubah src/client/agent/panel/actor.ts dan core/lib.rs");
        assert!(s.contains("actor.ts"));
        assert!(!s.contains("src/client"));
        assert!(s.contains("core/lib.rs"));
        // Emoji & simbol dibuang, teks utuh.
        let s = sanitize_speech("selesai ⏳ ✅ semua beres~");
        assert_eq!(s, "selesai semua beres~");
    }

    #[test]
    fn sanitize_speech_gepuk_di_batas_kalimat() {
        let long = "Kalimat pertama cukup panjang untuk diucapkan. ".repeat(20);
        let s = sanitize_speech(&long);
        assert!(s.chars().count() <= super::SPEECH_MAX_CHARS + 1);
        // Gepukan mendarat di akhir kalimat, bukan di tengah kata.
        assert!(s.ends_with('.') || s.ends_with('…'));
    }

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
        let data = dir.join("data");
        let f = mock_config(&dir);
        start("/tmp/work", "", Value::Null).await;
        let res = ask(&f, &dir, &data, "halo agent", None).await;
        assert!(res.ok);
        assert!(!res.paused);
        assert!(res.reply.to_lowercase().contains("halo"));
        stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ask_persist_ke_sesi_terikat() {
        // Runtime terikat sesi store → ask mempersist giliran user + final.
        // Tanpa ikatan → store tidak tersentuh (perilaku lama tetap aman).
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir("aspersist");
        let data = dir.join("data");
        let f = mock_config(&dir);
        stop().await;
        // Runtime global dibagi antar test (router test juga bisa mem-bind) —
        // pastikan mulai dari keadaan TANPA ikatan.
        unbind_session().await;

        // (1) belum terikat → ask jalan, store kosong.
        let res = ask(&f, &dir, &data, "tanpa sesi", None).await;
        assert!(res.ok);
        assert_eq!(bound_session().await, "");
        assert!(sessions::load(&data)["sessions"].as_array().unwrap().is_empty());

        // (2) terikat sesi → user + final tercatat.
        let rec = sessions::create(&data, "");
        let sid = rec["id"].as_str().unwrap().to_string();
        bind_session(&data, &sid).await.unwrap();
        assert_eq!(bound_session().await, sid);
        let res = ask(&f, &dir, &data, "halo dari chat", None).await;
        assert!(res.ok);
        let msgs = sessions::messages(&data, &sid).unwrap();
        assert_eq!(msgs.len(), 2, "user + final assistant");
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"], "halo dari chat");
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"], res.reply);
        stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn bind_hydrate_dan_tolak_saat_busy() {
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir("asbind");
        let data = dir.join("data");
        stop().await;

        // sesi dengan isi → bind meng-hydrate history runtime.
        let a = sessions::create(&data, "");
        let aid = a["id"].as_str().unwrap().to_string();
        sessions::append(&data, &aid, &[
            json!({"role":"user","content":"tugas kemarin"}),
            json!({"role":"assistant","content":"sudah beres"}),
        ]);
        let ok = bind_session(&data, &aid).await.unwrap();
        assert_eq!(ok["count"], 2);
        assert_eq!(bound_session().await, aid);
        let r = rt().lock().await;
        assert_eq!(r.history.len(), 2);
        assert_eq!(r.history[0]["content"], "tugas kemarin");
        drop(r);
        // bind juga memindah sesi aktif store (persist — kontrak MODES.md).
        assert_eq!(sessions::load(&data)["active"], json!(aid));

        // busy → bind ditolak.
        let b = sessions::create(&data, "");
        let bid = b["id"].as_str().unwrap().to_string();
        { rt().lock().await.busy = true; }
        let err = bind_session(&data, &bid).await.unwrap_err();
        assert!(err.contains("berjalan"), "pesan harus jelas: {err}");
        assert_eq!(bound_session().await, aid, "bind gagal tidak mengubah ikatan");
        { rt().lock().await.busy = false; }

        // id asing → ditolak; history tak tersentuh.
        assert!(bind_session(&data, "s_hilang").await.is_err());
        assert_eq!(rt().lock().await.history.len(), 2);
        stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ask_llm_error_melepas_slot() {
        // Provider rusak (koneksi aktif hilang) → ask gagal DAN slot bebas:
        // busy=false, active_task null — agent tidak boleh brick setelah error.
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir("aserr");
        let data = dir.join("data");
        // config TANPA koneksi → llm_for_role_tools pasti error.
        let f = dir.join("config.json");
        std::fs::write(&f, r#"{"activeId":"m","connections":[]}"#).unwrap();
        start(&dir.to_string_lossy(), "", Value::Null).await;
        let res = ask(&f, &dir, &data, "tugas yang pasti gagal", None).await;
        assert!(!res.ok);
        assert!(res.error.is_some());
        let st = status().await;
        assert_eq!(st["busy"], json!(false), "busy harus lepas setelah error");
        assert_eq!(st["activeTask"], Value::Null, "activeTask harus bersih");
        // Slot benar-benar bebas: ask berikutnya diterima (bukan ditolak busy).
        std::fs::write(&f, r#"{"activeId":"m","connections":[{"id":"m","provider":"mock"}]}"#).unwrap();
        let res2 = ask(&f, &dir, &data, "halo lagi", None).await;
        assert!(res2.ok, "ask setelah error harus jalan normal");
        stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ask_ditolak_saat_busy_atau_approval_menggantung() {
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir("asguard");
        let data = dir.join("data");
        let f = mock_config(&dir);
        start(&dir.to_string_lossy(), "", Value::Null).await;
        // busy=true → ask kedua ditolak dengan pesan jelas (bukan jalan paralel).
        {
            let mut r = rt().lock().await;
            r.busy = true;
        }
        let res1 = ask(&f, &dir, &data, "tugas kedua", None).await;
        assert!(!res1.ok);
        assert!(res1.error.unwrap_or_default().contains("berjalan"));
        // approval pending → ditolak juga (approval harus diputuskan dulu).
        {
            let mut r = rt().lock().await;
            r.busy = false;
            r.approvals.push(json!({ "id": "ap_guard", "tool": "write_file", "args": {}, "ts": now_ms() }));
        }
        let res2 = ask(&f, &dir, &data, "tugas ketiga", None).await;
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
        for k in ["running", "busy", "workDir", "sessionId", "historyCount", "pendingApprovals", "plan", "notes", "lastEvent", "tools", "activeTask", "parkedTasks"] {
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
        let res = approve(&cfg, wd, &wd.join("data"), &id, true, false).await;
        assert!(res.ok);
    }

    #[tokio::test]
    async fn izin_sesi_allowlist_dan_stop_mengosongkan() {
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        // Kunci allowlist: tool lain per nama, run_command per perintah,
        // write/edit/delete_file per folder induk — menyetujui satu perintah
        // / satu file tidak mengizinkan arbitrer lain dengan tool yang sama.
        assert_eq!(allow_key("edit_file", &json!({})), "edit_file:.");
        assert_eq!(allow_key("edit_file", &json!({ "path": "src/a.txt" })), "edit_file:src");
        assert_eq!(allow_key("edit_file", &json!({ "path": "b.txt" })), "edit_file:.");
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
        let res = approve(&cfg, &wd, &wd.join("data"), &id, true, true).await;
        assert!(res.ok);
        assert!(rt().lock().await.allowed.contains("edit_file:."), "approve + always harus memasukkan allowlist (kunci per folder)");
        let st = status().await;
        assert!(st["allowlist"].as_array().unwrap().iter().any(|v| v == "edit_file:."), "status mengekspos allowlist");

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
        let res_ok = approve(&cfg, &wd, &wd.join("data"), &id, true, false).await;
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
        let res_no = approve(&cfg, &wd, &wd.join("data"), &id2, false, false).await;
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
        let res_task = ask(&cfg, &wd, &wd.join("data"), "halo", None).await;
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
        let data = wd.join("data");
        let cfg = mock_config(&wd);
        start(&wd.to_string_lossy(), "", Value::Null).await;

        // (1) sinyal sisa dibuang ask baru — jawaban bukan "Dibatalkan".
        { let _ = rt().lock().await.cancel_tx.send(true); }
        let r = ask(&cfg, &wd, &data, "tugas segar", None).await;
        assert!(r.ok);
        assert_ne!(r.reply, "Dibatalkan oleh user.");
        assert!(!*rt().lock().await.cancel_rx.borrow());

        // (2) cancel di tengah ask (mock delay 300 ms): flag dibaca antar-turn —
        // mock final di turn 0, jadi ask tetap selesai normal; yang dikunci:
        // runtime HIDUP & busy lepas (padanan semantik agent-cancel TS).
        let (cp, root, rt_data) = (cfg.clone(), wd.clone(), data.clone());
        let h = tokio::spawn(async move { ask(&cp, &root, &rt_data, "tugas yang dicancl di tengah", None).await });
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

    #[tokio::test]
    async fn cancel_saat_pause_membuang_kartu_dan_melepas_slot() {
        // Pause = loop sudah exit sambil menunggu keputusan approval. Dulu
        // cancel hanya menyetel flag yang tak pernah dikonsumsi (loop exit) —
        // slot menggantung sampai user memaksa approve/reject. Sekarang cancel
        // membersihkan sendiri: kartu dibuang, slot lepas, ask berikut jalan.
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir("cancpause");
        let data = dir.join("data");
        stop().await;
        let f = mock_config(&dir);
        start(&dir.to_string_lossy(), "", Value::Null).await;
        {
            let mut r = rt().lock().await;
            r.busy = true;
            r.paused = true;
            r.active_task = Some(json!({ "taskId": "t_9", "prompt": "x", "status": "running" }));
            r.approvals.push(json!({ "id": "ap_pause", "tool": "write_file", "args": {}, "ts": now_ms() }));
        }
        let c = cancel().await;
        assert_eq!(c["accepted"], true);
        let st = status().await;
        assert_eq!(st["busy"], json!(false), "pause + cancel → slot lepas");
        assert_eq!(st["pendingApprovals"].as_array().unwrap().len(), 0, "kartu menggantung dibuang");
        assert_eq!(st["activeTask"], Value::Null);
        // Slot benar-benar bebas: ask berikutnya diterima (mock → final).
        let res = ask(&f, &dir, &data, "halo lagi", None).await;
        assert!(res.ok, "ask setelah cancel-pause harus jalan: {:?}", res.error);
        stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn modify_saat_pause_menjalankan_pengganti() {
        // modify saat tugas menggantung di approval: kartu dibuang, slot lepas,
        // tugas pengganti berjalan (dulu: pengganti menunggu 60 detik lalu
        // ditolak "menunggu keputusan" — gagal senyap).
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir("modpause");
        let data = dir.join("data");
        let f = mock_config(&dir);
        stop().await;
        start(&dir.to_string_lossy(), "", Value::Null).await;
        {
            let mut r = rt().lock().await;
            r.busy = true;
            r.paused = true;
            r.approvals.push(json!({ "id": "ap_pause2", "tool": "write_file", "args": {}, "ts": now_ms() }));
        }
        let res = modify(&f, &dir, &data, "t_0", "tugas pengganti").await;
        assert_eq!(res["ok"], json!(true), "{res}");
        // Tunggu tugas pengganti benar-benar dimulai (user msg masuk history) —
        // busy bisa terlihat false sejenak antara cleanup dan ask() yang
        // di-spawn, jadi tanda hidupnya adalah history, bukan slot.
        let mut started = false;
        for _ in 0..300 {
            if rt().lock().await.history.iter().any(|m| m["content"].as_str().unwrap_or("") == "tugas pengganti") {
                started = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(started, "tugas pengganti harus masuk history");
        // Tunggu tugas pengganti (mock echo → final cepat) menyelesaikan slot.
        for _ in 0..300 {
            if !rt().lock().await.busy {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let st = status().await;
        assert_eq!(st["busy"], json!(false), "pengganti selesai → slot lepas");
        assert_eq!(st["pendingApprovals"].as_array().unwrap().len(), 0, "kartu pause dibuang modify");
        stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trim_history_pertahankan_tujuan_awal() {
        let mut h: Vec<Value> = vec![json!({ "role": "user", "content": "tujuan" })];
        for i in 0..(MAX_HISTORY + 10) {
            h.push(json!({ "role": "assistant", "content": format!("langkah {i}") }));
        }
        trim_history(&mut h);
        assert_eq!(h.len(), MAX_HISTORY);
        assert_eq!(h[0]["content"], "tujuan", "pesan user pertama harus tetap ada");
        assert_eq!(h[MAX_HISTORY - 1]["content"], format!("langkah {}", MAX_HISTORY + 9));
    }

    #[test]
    fn trim_history_anggaran_konten() {
        let _g = bus::BUS_TEST_LOCK.lock().unwrap();
        // Hasil tool besar menumpuk: 60 pesan ≤ batas jumlah, tapi total char
        // meledakkan konteks model kecil → anggaran char memangkas dari tua.
        let big = "x".repeat(3000);
        let mut h: Vec<Value> = vec![json!({ "role": "user", "content": "tujuan" })];
        for i in 0..MAX_HISTORY {
            h.push(json!({ "role": "assistant", "content": format!("{big}{i}") }));
        }
        trim_history(&mut h);
        assert!(h.len() < MAX_HISTORY, "harus dipangkas oleh anggaran char: {}", h.len());
        assert_eq!(h[0]["content"], "tujuan", "tujuan tugas dipertahankan");
        assert!(h.len() >= 2, "minimal tujuan + pesan terbaru");
        let total: usize = h.iter().map(|m| m["content"].as_str().unwrap_or("").len()).sum();
        assert!(
            total <= MAX_HISTORY_CHARS + 3000,
            "total {total} harus mendekati anggaran {MAX_HISTORY_CHARS} (toleransi 1 pesan)"
        );
    }

    #[tokio::test]
    async fn budget_llm_per_tugas_habis() {
        rt().lock().await.llm_calls = 0;
        for _ in 0..MAX_LLM_CALLS_PER_TASK {
            assert!(spend_llm_call().await);
        }
        assert!(!spend_llm_call().await, "panggilan melewati anggaran harus ditolak");
        rt().lock().await.llm_calls = 0;
    }

    #[test]
    fn strip_directive() {
        let t = "Baik, aku baca.\nTOOL: read_file {\"path\":\"x\"}\nsisa";
        let s = strip_tool_directive(t);
        assert!(!s.contains("TOOL:"));
        assert!(s.contains("Baik"));
    }
}
