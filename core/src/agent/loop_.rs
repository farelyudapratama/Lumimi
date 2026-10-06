//! Agent loop (bagian inti).
//! build_system (system prompt + katalog tool), detect_tool_call (parse longgar),
//! exec_tool (dispatch), tool_level. Loop + permission gate + SSE.

use std::path::Path;

use serde_json::Value;

use crate::agent::{memory, tools};

/// Definisi tool: nama, deskripsi param (utk prompt), level.
pub struct ToolDef {
    pub name: &'static str,
    pub params: &'static str,
    pub level: &'static str,
}

/// Katalog tool. update_plan/subagent/browser_* di-dispatch di run_loop
/// (assistant.rs), bukan exec_tool di sini; exec_tool memuat FS/search/git/
/// run_command/memory, sisanya jatuh ke catch-all ERROR. LLM diberi tahu prompt
/// yang aktif supaya tak memanggil yang belum ada.
pub const TOOLS: &[ToolDef] = &[
    ToolDef { name: "list_dir", params: "path: string, default '.'", level: "safe" },
    ToolDef { name: "read_file", params: "path: string", level: "safe" },
    ToolDef { name: "search_code", params: "query: string, path: string opsional", level: "safe" },
    ToolDef { name: "git_diff", params: "", level: "safe" },
    ToolDef { name: "update_plan", params: "todos: [{id,task,status,note?}], reason?: string (wajib saat revisi rencana) — rencana yang disusun pada tugas berjalan akan diminta persetujuan user SEBELUM mutasi pertama dieksekusi", level: "safe" },
    ToolDef { name: "write_file", params: "path: string, content: string", level: "mutating" },
    ToolDef { name: "edit_file", params: "path: string, old: string, new: string", level: "mutating" },
    ToolDef { name: "delete_file", params: "path: string", level: "mutating" },
    ToolDef { name: "run_command", params: "command: string", level: "mutating" },
    ToolDef { name: "remember", params: "key: string, value: string", level: "safe" },
    ToolDef { name: "recall", params: "key: string opsional", level: "safe" },
    ToolDef { name: "memory_recall", params: "query: string, limit: number opsional — cari MEMORI USER lintas sesi (fakta/preferensi/keputusan companion; beda store dgn recall)", level: "safe" },
    ToolDef { name: "spawn_subagent", params: "tasks: [{task: deskripsi goal}] — delegasi riset/analisa INDEPENDEN ke subagent read-only paralel (maks 4)", level: "safe" },
    ToolDef { name: "browser_status", params: "", level: "safe" },
    ToolDef { name: "browser_open", params: "url: string opsional (default https://example.com) — buka browser terisolasi", level: "mutating" },
    ToolDef { name: "browser_navigate", params: "url: string", level: "mutating" },
    ToolDef { name: "browser_inspect", params: "cursor: number opsional, maxChars: number opsional (maks 3500), snapshotId: string opsional — bila hasil memuat captcha+captchaHint: STOP, beri tahu user menyelesaikan captcha manual di jendela browser dan tunggu konfirmasi; jangan mencoba menyelesaikannya", level: "safe" },
    ToolDef { name: "browser_click", params: "snapshotId: string, ref: string (dari inspect terakhir)", level: "mutating" },
    ToolDef { name: "browser_type", params: "snapshotId: string, ref: string, text: string, submit: boolean opsional", level: "mutating" },
    ToolDef { name: "browser_history", params: "action: back|forward|reload", level: "mutating" },
    ToolDef { name: "browser_close", params: "", level: "mutating" },
    ToolDef { name: "browser_grant_private", params: "origin: http/https tanpa path (izinkan localhost/LAN sesi ini)", level: "mutating" },
    ToolDef { name: "motion_analyze", params: "model: string opsional (default model aktif) — laporan range observasi per role + output physics dari disk", level: "safe" },
    ToolDef { name: "motion_validate", params: "motion: objek Motion Asset {id, name, duration, tracks:[{target: ax|ay|bodyX|bodyY|bodyZ|ex|ey|mouthForm, keys:[{t,v}]}]} — laporan issue; perbaiki sampai ok SEBELUM motion_save", level: "safe" },
    ToolDef { name: "motion_save", params: "motion: Motion Asset yang sudah lolos motion_validate — simpan ke library karakter", level: "mutating" },
    ToolDef { name: "motion_verify", params: "motion: objek draft ATAU motionId: id tersimpan; intent: deskripsi gerakan yang diharapkan — filmstrip dinilai LLM motion-vision (butuh koneksi vision)", level: "safe" },
];

/// True bila tool motion (dispatch khusus di run_loop/approve — butuh
/// config_path + state model/roleMap runtime).
pub fn is_motion_tool(name: &str) -> bool {
    name.starts_with("motion_")
}

/// True bila tool dijalankan lewat jalur async browser manager (bukan exec_tool sinkron).
pub fn is_browser_tool(name: &str) -> bool {
    name.starts_with("browser_")
}

pub fn tool_level(name: &str) -> Option<&'static str> {
    TOOLS.iter().find(|t| t.name == name).map(|t| t.level)
}

/// System prompt agent (id/en) + katalog tool + folder kerja + model aktif.
/// `model` = nama model Live2D yang sedang dimuat (kosong = tak ada) — dipakai
/// supaya LLM tahu "model ini" sudah tersedia dan tak perlu mencari file model.
pub fn build_system(lang: &str, work_dir: &str, model: &str) -> String {
    let en = lang == "en";
    let head = if en {
        "You are a local AI agent (like a coding agent) appearing as the user's Live2D desktop character. Your job is to COMPLETE the user's request — not to chat. Style: concise, friendly."
    } else {
        "Kamu adalah AI agent lokal (seperti coding-agent) yang tampil sebagai karakter Live2D di desktop user. Tugasmu MENYELESAIKAN permintaan user — bukan mengobrol. Gaya: ringkas, padat, ramah."
    };
    let tools_hdr = if en {
        "TOOLS — to call one, reply with EXACTLY one line like this (valid JSON, no markdown):"
    } else {
        "TOOLS — untuk memanggil, balas DENGAN PERSIS satu baris ini (JSON valid, tanpa markdown):"
    };
    let rules: &[&str] = if en {
        &[
            "0. TOOL CALL FORMAT: reply with one line `TOOL: <name> {json}`. <tool_call>{\"name\",\"arguments\"}</tool_call> is also accepted. Keep <think> reasoning OUT of the visible answer.",
            "1. UNDERSTAND FIRST. Questions needing no files/commands are answered DIRECTLY — no tool.",
            "2. If you need data, call a tool. At most ONE short plan sentence before the TOOL: line.",
            "3. Every '[hasil tool] …' MUST be followed up: next tool or final answer. NEVER repeat same tool+args. If a tool FAILS, try another approach.",
            "4. FINAL reply: what you did + key findings. Max ~4 sentences, no markdown.",
            "5. Task done → stop calling tools. If unclear, ask ONE specific question.",
            "6. NEVER write/delete beyond the request or run destructive commands — mutating tools ask permission.",
            "7. MOTION: the active Live2D model is ALREADY loaded (see 'Active model'). Do NOT search the filesystem for model files (a path in the user's text is NOT the model). REQUIRED chain, one tool per turn: motion_analyze → emit the FULL draft JSON via motion_validate (fix until ok) → motion_save. A prose description of the motion is NOT a motion and NOT completion — you must output the draft JSON and save it. Do NOT say 'done'/stop before motion_save succeeds. (motion_verify is optional, only if a vision connection exists.)",
            "8. PLAN: if an update_plan list exists for this task, keep it LIVE — when you start a step call update_plan marking it in_progress, when you finish it mark done (or failed). Before your final answer every step must be done/failed. If the task needs no plan, do not create one.",
            "9. MEMORY: user prefs / key decisions → remember (short key). Need context → recall. Need USER FACTS across sessions (favorite color, city, decisions) → memory_recall with a free-form query.",
            "10. TOOL FAILED: in the final reply state the ACTUAL cause from the '[hasil tool] ERROR: …' line (condensed is fine, quote the key phrase). NEVER invent a cause the error does not state (e.g. claiming 'no internet' or 'unsafe' when the error says something else). If the error names a next step (e.g. browser_grant_private), do it before giving up.",
        ]
    } else {
        &[
            "0. FORMAT PANGGILAN TOOL: balas satu baris `TOOL: <nama> {json}`. Format <tool_call>{\"name\",\"arguments\"}</tool_call> juga diterima. Simpan penalaran <think> DI LUAR jawaban yang terlihat.",
            "1. PAHAMI DULU. Pertanyaan tanpa file/perintah dijawab LANGSUNG — tanpa tool.",
            "2. Kalau butuh data, panggil tool. Maks SATU kalimat rencana sebelum baris TOOL:.",
            "3. Tiap '[hasil tool] …' WAJIB dilanjutkan: tool berikutnya atau jawaban final. JANGAN ulang tool+arg sama. Kalau GAGAL, coba pendekatan lain.",
            "4. Jawaban FINAL: apa yang dikerjakan + temuan penting. Maks ~4 kalimat, tanpa markdown.",
            "5. Tugas selesai → berhenti memanggil tool. Kalau tak jelas, tanya SEKALI yang spesifik.",
            "6. DILARANG menulis/menghapus di luar kebutuhan atau perintah merusak — tool mutating minta izin.",
            "7. MOTION: model Live2D aktif SUDAH dimuat (lihat 'Model aktif'). JANGAN cari file model di folder (path di teks user BUKAN modelnya). Alur WAJIB, satu tool per giliran: motion_analyze → keluarkan draft JSON LENGKAP lewat motion_validate (perbaiki sampai ok) → motion_save. Deskripsi gerakan dalam prosa BUKAN motion dan BUKAN penyelesaian — kamu HARUS mengeluarkan draft JSON-nya lalu menyimpannya. JANGAN bilang 'selesai'/berhenti sebelum motion_save berhasil. (motion_verify opsional, hanya bila ada koneksi vision.)",
            "8. RENCANA: kalau ada daftar update_plan untuk tugas ini, JAGA tetap hidup — saat mulai satu langkah panggil update_plan yang menandainya in_progress, saat selesai tandai done (atau failed). Sebelum jawaban final, semua langkah harus done/failed. Kalau tugas tak butuh rencana, jangan buat.",
            "9. MEMORY: preferensi/keputusan penting → remember (key singkat). Butuh konteks → recall. Butuh FAKTA/PREFERENSI USER lintas sesi (warna favorit, kota, keputusan) → memory_recall dengan query bebas.",
            "10. TOOL GAGAL: di jawaban final sebutkan SEBAB ASLI dari baris '[hasil tool] ERROR: …' (boleh diringkas, kutip frasa kuncinya). JANGAN mengarang sebab yang tidak tertulis di error (mis. bilang 'internet mati' atau 'tidak aman' padahal error bilang hal lain). Bila error menyarankan langkah berikutnya (mis. browser_grant_private), jalankan dulu sebelum menyerah.",
        ]
    };
    let final_line = if en {
        "Reply in the SAME language the user used. Technical terms (file names, commands) stay as-is."
    } else {
        "Balas dalam bahasa yang SAMA dengan user. Sebutan teknis (nama file, perintah) tetap apa adanya."
    };
    let work_line = if work_dir.trim().is_empty() {
        if en { "Working folder: (NONE set — ask the user to set one before using file tools)".to_string() }
        else { "Folder kerja: (BELUM DISET — minta user set folder dulu sebelum pakai tool file)".to_string() }
    } else {
        format!("Folder kerja: {work_dir}")
    };
    let model_line = if model.trim().is_empty() {
        if en { "Active model: (none loaded)".to_string() } else { "Model aktif: (belum ada yang dimuat)".to_string() }
    } else if en {
        format!("Active model: {model} (already loaded — motion tools work on it directly)")
    } else {
        format!("Model aktif: {model} (sudah dimuat — tool motion langsung mengenainya)")
    };
    let mut lines = vec![head.to_string(), String::new(), work_line, model_line, String::new(), tools_hdr.to_string()];
    for t in TOOLS {
        lines.push(format!("TOOL: {} {{{}}} — level: {}", t.name, t.params, t.level));
    }
    lines.push(String::new());
    lines.push(if en { "RULES:".into() } else { "ATURAN:".into() });
    for r in rules {
        lines.push(r.to_string());
    }
    lines.push(String::new());
    lines.push(final_line.to_string());
    lines.join("\n")
}

/// Deteksi tool call dari balasan LLM (format bebas → parse longgar).
/// Padanan detectToolCall. Mendukung dua dialek: format kami `TOOL: <nama>
/// {json}` DAN format native `<tool_call>{"name","arguments"}</tool_call>`
/// (Qwen/Hermes/GLM). Blok penalaran `<think>…</think>` dibuang dulu supaya
/// nama tool yang cuma DISEBUT saat berpikir tak salah terdeteksi.
pub fn detect_tool_call(reply: &str) -> Option<(String, Value)> {
    let no_think = strip_block(reply, "<think>", "</think>");
    // 1) Native <tool_call>{"name","arguments"}</tool_call> — eksplisit, diutamakan.
    if let Some(call) = detect_native_tool_call(&no_think) {
        return Some(call);
    }
    // 2) Format kami: `TOOL: <nama> {json}`.
    let clean = no_think.replace("```", "\n").replace("**", "");
    let lower = clean.to_lowercase();
    // nama tool terpanjang dulu (hindari "recall" match sebelum "read_file" dst).
    let mut names: Vec<&str> = TOOLS.iter().map(|t| t.name).collect();
    names.sort_by_key(|n| std::cmp::Reverse(n.len()));
    for name in names {
        if let Some(idx) = lower.find(name) {
            let after_start = idx + name.len();
            // Draft motion dkk. membawa JSON BERSARANG yang panjang (tracks/
            // keys) — window kecil + kurung-pertama memotong di `}` dalam dan
            // parse selalu gagal. Ambil objek ber-imbangan (string-aware)
            // dari window besar.
            let window: String = clean[after_start..].chars().take(8000).collect();
            if let Some(obj) = first_brace_obj(&window) {
                if let Ok(v) = serde_json::from_str::<Value>(&obj) {
                    return Some((name.to_string(), v));
                }
                // loose: kunci tanpa quote + kutip tunggal
                let loose = looseify(&obj);
                if let Ok(v) = serde_json::from_str::<Value>(&loose) {
                    return Some((name.to_string(), v));
                }
            }
        }
    }
    None
}

/// Parse blok native `<tool_call>{"name": "...", "arguments": {...}}</tool_call>`.
/// `arguments`/`parameters` boleh objek atau string JSON. Nama harus tool dikenal.
fn detect_native_tool_call(s: &str) -> Option<(String, Value)> {
    let lower = s.to_lowercase();
    let open = lower.find("<tool_call>")?;
    let after = open + "<tool_call>".len();
    let obj = first_brace_obj(&s[after..])?;
    let v: Value = serde_json::from_str(&obj)
        .or_else(|_| serde_json::from_str(&looseify(&obj)))
        .ok()?;
    let name = v.get("name").and_then(|x| x.as_str())?.trim().to_string();
    if !TOOLS.iter().any(|t| t.name == name) {
        return None;
    }
    let raw = v.get("arguments").or_else(|| v.get("parameters")).cloned().unwrap_or_else(|| Value::Object(Default::default()));
    let args = match raw {
        Value::String(st) => serde_json::from_str::<Value>(&st).unwrap_or_else(|_| Value::Object(Default::default())),
        other => other,
    };
    Some((name, args))
}

/// Buang pasangan blok `open`…`close` (case-insensitive). Blok tanpa penutup →
/// sisanya dibuang (reasoning/panggilan belum kelar, bukan untuk ditampilkan).
pub(crate) fn strip_block(s: &str, open: &str, close: &str) -> String {
    let lower = s.to_lowercase();
    let (ol, cl) = (open.to_lowercase(), close.to_lowercase());
    let mut out = String::with_capacity(s.len());
    let mut pos = 0usize;
    while let Some(rel) = lower[pos..].find(&ol) {
        let o = pos + rel;
        out.push_str(&s[pos..o]);
        match lower[o..].find(&cl) {
            Some(re) => pos = o + re + cl.len(),
            None => {
                pos = s.len();
                break;
            }
        }
    }
    out.push_str(&s[pos..]);
    out
}

/// Bersihkan teks untuk DITAMPILKAN: buang blok reasoning `<think>` dan blok
/// `<tool_call>`, plus sisa tag telanjang yang bocor (mis. `</think>` yatim dari
/// chunk sebelumnya). Model reasoning gemar membocorkan tag ini sebagai teks.
pub(crate) fn strip_reasoning(s: &str) -> String {
    let a = strip_block(s, "<think>", "</think>");
    let b = strip_block(&a, "<tool_call>", "</tool_call>");
    b.replace("<think>", "")
        .replace("</think>", "")
        .replace("<tool_call>", "")
        .replace("</tool_call>", "")
        .replace("<THINK>", "")
        .replace("</THINK>", "")
}

fn first_brace_obj(s: &str) -> Option<String> {
    let chars: Vec<char> = s.chars().collect();
    let start = chars.iter().position(|&c| c == '{')?;
    // Scanner ber-imbangan: hitung kedalaman {..} sambil menghormati string
    // ("{" di dalam string bukan kurung; \" bukan penutup). Tanpa ini argumen
    // bersarang (motion draft, content write_file) terpotong di `}` pertama.
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    for i in start..chars.len() {
        let c = chars[i];
        if escaped {
            escaped = false;
            continue;
        }
        if in_str {
            if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(chars[start..=i].iter().collect());
                }
            }
            _ => {}
        }
    }
    None
}

fn looseify(obj: &str) -> String {
    // {key: → {"key":  dan ' → "
    let mut out = String::with_capacity(obj.len() + 8);
    let bytes: Vec<char> = obj.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == '{' || c == ',' {
            out.push(c);
            // skip ws
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_whitespace() {
                out.push(bytes[j]);
                j += 1;
            }
            // ident diikuti ':' → quote
            let ks = j;
            while j < bytes.len() && (bytes[j].is_alphanumeric() || bytes[j] == '_') {
                j += 1;
            }
            if j > ks && j < bytes.len() && {
                let mut k = j;
                while k < bytes.len() && bytes[k].is_whitespace() {
                    k += 1;
                }
                k < bytes.len() && bytes[k] == ':'
            } {
                out.push('"');
                out.extend(&bytes[ks..j]);
                out.push('"');
                i = j;
                continue;
            } else {
                out.extend(&bytes[ks..j]);
                i = j;
                continue;
            }
        } else if c == '\'' {
            out.push('"');
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

/// Eksekusi satu tool. `root` = app root (utk memory), `work_dir` = folder kerja.
/// Selalu mengembalikan String (ERROR: … bukan panic) — sesuai kontrak loop.
pub fn exec_tool(root: &Path, work_dir: &Path, name: &str, args: &Value) -> String {
    let s = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let res: Result<String, String> = match name {
        "list_dir" => tools::list_dir(work_dir, &s(args, "path")),
        "read_file" => tools::read_file(work_dir, &s(args, "path")),
        "search_code" => {
            let path = args.get("path").and_then(|x| x.as_str()).unwrap_or(".");
            tools::search_code(work_dir, &s(args, "query"), path)
        }
        "git_diff" => tools::git_diff(work_dir),
        "write_file" => tools::write_file(work_dir, &s(args, "path"), &s(args, "content")),
        "edit_file" => tools::edit_file(work_dir, &s(args, "path"), &s(args, "old"), &s(args, "new")),
        "delete_file" => tools::delete_file(work_dir, &s(args, "path")),
        "run_command" => Ok(tools::run_command(work_dir, &s(args, "command"))),
        "remember" => Ok(memory::remember(root, &s(args, "key"), &s(args, "value"))),
        "recall" => {
            let key = args.get("key").and_then(|x| x.as_str());
            Ok(memory::recall(root, key))
        }
        // Memory companion = infrastruktur SHARED: agent bisa menarik sendiri
        // fakta/preferensi user lintas sesi saat tugas membutuhkannya — bukan
        // hanya menerima pilihan caller di teks hand-off. Read-only di sini;
        // jalur tulis tetap terkurasi (ekstraksi companion + POST manual).
        "memory_recall" => {
            let query = s(args, "query");
            let limit = args.get("limit").and_then(|x| x.as_u64()).unwrap_or(6) as usize;
            let store = crate::companion_memory::retrieve(&root.join("data"), &query, limit);
            Ok(crate::companion_memory::entries_as_text(&store))
        }
        other => Err(format!("tool belum diport ke core: {other}")),
    };
    match res {
        Ok(t) => t,
        Err(e) => {
            if e.starts_with("ERROR") {
                e
            } else {
                format!("ERROR: {e}")
            }
        }
    }
}

/// Argumen tool yang aman ditampilkan ke UI (redaksi ringan). Padanan publicToolArgs.
pub fn public_tool_args(name: &str, args: &Value) -> Value {
    if is_browser_tool(name) {
        return crate::browser::public_args(name, args);
    }
    args.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detect_berbagai_format() {
        let (n, a) = detect_tool_call("baiklah. TOOL: read_file {\"path\": \"a.txt\"}").unwrap();
        assert_eq!(n, "read_file");
        assert_eq!(a["path"], "a.txt");
        // loose: kunci tanpa quote
        let (n2, a2) = detect_tool_call("list_dir {path: 'src'}").unwrap();
        assert_eq!(n2, "list_dir");
        assert_eq!(a2["path"], "src");
        // tanpa tool
        assert!(detect_tool_call("halo, apa kabar?").is_none());
    }

    #[test]
    fn exec_dispatch_fs_dan_run() {
        let d = std::env::temp_dir().join(format!("l2dloop-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&d).unwrap();
        let out = exec_tool(&d, &d, "write_file", &json!({ "path": "x.txt", "content": "hai" }));
        assert!(out.contains("char"));
        assert_eq!(exec_tool(&d, &d, "read_file", &json!({ "path": "x.txt" })), "hai");
        // run_command aman (echo)
        let echo = if cfg!(windows) { "echo halo" } else { "echo halo" };
        let r = exec_tool(&d, &d, "run_command", &json!({ "command": echo }));
        assert!(r.to_lowercase().contains("halo"), "{r}");
        // tool belum diport
        assert!(exec_tool(&d, &d, "browser_open", &json!({})).contains("belum diport"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn memory_recall_tool_baca_store_companion() {
        // Memory companion = shared infrastructure: agent menarik sendiri fakta
        // user lewat tool read-only ini (root/data/companion-memory.json).
        let d = std::env::temp_dir().join(format!("l2dloopmem-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(
            exec_tool(&d, &d, "memory_recall", &json!({ "query": "apa saja" })),
            "(tidak ada memori user yang relevan)"
        );
        crate::companion_memory::add_entries(
            &d.join("data"),
            &[json!({ "text": "Warna favorit user hijau lumut." })],
        );
        let out = exec_tool(&d, &d, "memory_recall", &json!({ "query": "warna favorit user" }));
        assert!(out.contains("hijau lumut"), "{out}");
        assert!(out.starts_with("- [m_"), "hasil memuat id entri: {out}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn detect_json_bersarang_dan_besar() {
        // Draft motion = JSON bersarang (tracks → keys) — dulu terpotong di
        // `}` keyframe pertama dan tool call tidak pernah terdeteksi.
        let reply = r#"Saya validasi dulu. TOOL: motion_validate {"motion": {"id": "shy_look", "duration": 4.0, "tracks": [{"target": "ay", "keys": [{"t": 0, "v": 0}, {"t": 1.5, "v": -12}, {"t": 4.0, "v": 0}]}, {"target": "ex", "keys": [{"t": 0, "v": 0}, {"t": 2.0, "v": -0.6}, {"t": 4.0, "v": 0}]}]}}"#;
        let (n, a) = detect_tool_call(reply).unwrap();
        assert_eq!(n, "motion_validate");
        assert_eq!(a["motion"]["id"], "shy_look");
        assert_eq!(a["motion"]["tracks"].as_array().unwrap().len(), 2);
        assert_eq!(a["motion"]["tracks"][0]["keys"].as_array().unwrap().len(), 3);
        // Konten write_file dengan kurung di dalam string juga aman.
        let (n2, a2) = detect_tool_call(r#"TOOL: write_file {"path": "a.rs", "content": "fn main() { println!(\"}{\"); }"}"#).unwrap();
        assert_eq!(n2, "write_file");
        assert!(a2["content"].as_str().unwrap().contains("println"));
    }

    #[test]
    fn system_prompt_muat_tool() {
        let p = build_system("id", "/proj", "Mao");
        assert!(p.contains("Folder kerja: /proj"));
        assert!(p.contains("TOOL: run_command"));
        assert!(p.contains("level: mutating"));
        assert!(p.contains("Model aktif: Mao"), "{p}");
        // Aturan 10: error tool dilaporkan apa adanya, bukan dikarang.
        assert!(p.contains("SEBAB ASLI"), "{p}");
        // Tanpa folder/model → petunjuk eksplisit, bukan baris hampa.
        let p2 = build_system("id", "", "");
        assert!(p2.contains("BELUM DISET"), "{p2}");
        assert!(p2.contains("belum ada yang dimuat"), "{p2}");
    }

    #[test]
    fn detect_native_tool_call_dan_buang_think() {
        // Format native <tool_call>{name,arguments}</tool_call> (Qwen/GLM).
        let reply = "<think>saya perlu analisa dulu, mungkin read_file</think>\n<tool_call>\n{\"name\": \"motion_analyze\", \"arguments\": {\"model\": \"Mao\"}}\n</tool_call>";
        let (n, a) = detect_tool_call(reply).unwrap();
        assert_eq!(n, "motion_analyze");
        assert_eq!(a["model"], "Mao");

        // arguments sebagai STRING JSON juga diterima.
        let reply2 = "<tool_call>{\"name\":\"list_dir\",\"arguments\":\"{\\\"path\\\":\\\"src\\\"}\"}</tool_call>";
        let (n2, a2) = detect_tool_call(reply2).unwrap();
        assert_eq!(n2, "list_dir");
        assert_eq!(a2["path"], "src");

        // Nama tool yang hanya DISEBUT di <think> tak boleh terdeteksi.
        assert!(detect_tool_call("<think>mungkin pakai read_file nanti</think> oke deh.").is_none());
    }

    #[test]
    fn strip_reasoning_buang_tag_bocor() {
        let s = "Hasilnya begini.\n<tool_call>\n{\"name\":\"x\"}\n</tool_call>\n</think>\nselesai.";
        let out = strip_reasoning(s);
        assert!(!out.contains("<tool_call>"), "{out}");
        assert!(!out.contains("</think>"), "{out}");
        assert!(out.contains("Hasilnya begini."));
        assert!(out.contains("selesai."));
    }
}
