//! Tool agent (sandbox workDir): FS (list/read/write/edit/delete) + search_code
//! + git_diff + run_command. Browser/subagent di-dispatch lewat loop (assistant.rs).
//!
//! Semua path lewat `safe_path` — tak boleh keluar workDir.

use std::path::{Component, Path, PathBuf};
use std::process::Command;

/// Normalisasi lexical: resolve "." (buang) & ".." (pop). Tak menyentuh FS.
fn normalize_lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Lepas prefiks verbatim Windows (\\?\ dan \\?\UNC\) agar path hasil
/// canonicalize bisa dibandingkan dengan path biasa. Tanpa ini base kanonik
/// (\\?\F:\…) tak pernah cocok dengan join path absolut (F:\…).
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.as_os_str().to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest.to_string())
    } else {
        p
    }
}

/// Resolusi symlink: canonicalize leluhur terdekat yang sudah ada, lalu
/// pasang kembali sisa komponen yang belum ada. Symlink di tengah path ikut
/// terbaca, jadi target yang keluar dari base ketahuan.
fn resolve_existing(p: &Path) -> PathBuf {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        if let Ok(c) = std::fs::canonicalize(&cur) {
            let mut out = strip_verbatim(c);
            for comp in tail.iter().rev() {
                out.push(comp);
            }
            return out;
        }
        match cur.file_name() {
            Some(n) => tail.push(n.to_os_string()),
            None => return p.to_path_buf(),
        }
        if !cur.pop() {
            return p.to_path_buf();
        }
    }
}

/// Path aman di dalam workDir (padanan safePath). Err bila keluar, baik
/// secara leksikal (`..`) maupun lewat symlink/junction di dalam workdir.
pub fn safe_path(work_dir: &Path, p: &str) -> Result<PathBuf, String> {
    // Base dan full dibandingkan pada bentuk yang sama (tanpa prefiks
    // verbatim). Dulu base di-canonicalize mentah: di Windows base = \\?\F:\...
    // sedangkan join path absolut = F:\... → starts_with gagal → SEMUA path
    // absolut ditolak "di luar folder kerja" walau masih di dalam workdir.
    let base = std::fs::canonicalize(work_dir)
        .map(strip_verbatim)
        .unwrap_or_else(|_| normalize_lexical(work_dir));
    let rel = if p.is_empty() { "." } else { p };
    // Path input sendiri bisa membawa prefiks verbatim (mis. hasil
    // canonicalize yang dikirim ulang model) — samakan sebelum membandingkan.
    let full = strip_verbatim(normalize_lexical(&base.join(rel)));
    let inside = |x: &Path| x == base || x.starts_with(&base);
    if !inside(&full) {
        return Err(format!("di luar folder kerja: {p}"));
    }
    if !inside(&resolve_existing(&full)) {
        return Err(format!("di luar folder kerja (lewat symlink): {p}"));
    }
    Ok(full)
}

/// Berkas yang berisi rahasia (kunci API, kredensial, konfigurasi app). Tidak
/// dibaca tool file maupun ditelusuri search_code, supaya isinya tak ikut
/// terkirim ke provider LLM.
pub fn is_sensitive(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    name.starts_with(".env")
        || [".pem", ".key", ".p12", ".pfx", ".kdbx"].iter().any(|e| name.ends_with(e))
        || matches!(name.as_str(), "id_rsa" | "id_ed25519" | "credentials.json" | "config.json" | ".netrc")
}

/// Potong hasil panjang (manajemen token). Padanan clip.
pub fn clip(text: &str, max: usize) -> String {
    let n = text.chars().count();
    if n > max {
        let head: String = text.chars().take(max).collect();
        format!("{head}\n…(terpotong, {n} char)")
    } else {
        text.to_string()
    }
}

pub fn list_dir(work_dir: &Path, path: &str) -> Result<String, String> {
    let dir = safe_path(work_dir, path)?;
    let mut entries: Vec<(String, bool, u64)> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .take(200)
        .map(|e| {
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            (e.file_name().to_string_lossy().into_owned(), is_dir, size)
        })
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let lines: Vec<String> = entries
        .iter()
        .map(|(name, is_dir, size)| {
            if *is_dir {
                format!("[d] {name}/")
            } else {
                format!("[f] {name} ({size} B)")
            }
        })
        .collect();
    let body = if lines.is_empty() { "(kosong)".to_string() } else { lines.join("\n") };
    Ok(clip(&format!("Isi {}:\n{body}", dir.display()), 12000))
}

pub fn read_file(work_dir: &Path, path: &str) -> Result<String, String> {
    let fp = safe_path(work_dir, path)?;
    if is_sensitive(&fp) {
        return Err(format!("berkas sensitif tidak boleh dibaca agent: {path}"));
    }
    let text = std::fs::read_to_string(&fp).map_err(|e| e.to_string())?;
    Ok(clip(&text, 12000))
}

pub fn write_file(work_dir: &Path, path: &str, content: &str) -> Result<String, String> {
    let fp = safe_path(work_dir, path)?;
    if let Some(parent) = fp.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&fp, content).map_err(|e| e.to_string())?;
    // Verifikasi read-back (SWE-agent lesson: tool yang memagari dirinya):
    // baca ulang dan bandingkan — simpan tidak boleh dilaporkan sukses bila
    // isi di disk tidak persis sama.
    let back = std::fs::read_to_string(&fp).map_err(|e| format!("read-back gagal: {e}"))?;
    if back != content {
        return Err(format!(
            "verifikasi read-back GAGAL: isi {} di disk tidak sama dengan yang dikirim ({} vs {} char)",
            path,
            back.chars().count(),
            content.chars().count()
        ));
    }
    Ok(format!(
        "Tersimpan + terverifikasi: {} ({} char, dibaca ulang cocok)",
        fp.display(),
        content.chars().count()
    ))
}

pub fn edit_file(work_dir: &Path, path: &str, old: &str, new: &str) -> Result<String, String> {
    let fp = safe_path(work_dir, path)?;
    if old.is_empty() {
        return Err("parameter 'old' kosong".into());
    }
    let text = std::fs::read_to_string(&fp).map_err(|e| e.to_string())?;
    let count = text.matches(old).count();
    if count == 0 {
        return Err(format!("teks 'old' tidak ditemukan di {path}"));
    }
    if count > 1 {
        return Err(format!("teks 'old' muncul {count}x — perjelas dengan potongan yang lebih panjang"));
    }
    std::fs::write(&fp, text.replacen(old, new, 1)).map_err(|e| e.to_string())?;
    // Verifikasi read-back: 'old' harus lenyap dan 'new' harus muncul di disk.
    let back = std::fs::read_to_string(&fp).map_err(|e| format!("read-back gagal: {e}"))?;
    if back.contains(old) {
        return Err(format!("verifikasi read-back GAGAL: teks lama masih ada di {path}"));
    }
    if !back.contains(new) {
        return Err(format!("verifikasi read-back GAGAL: teks pengganti tidak ditemukan di {path}"));
    }
    Ok(format!(
        "Diedit + terverifikasi: {} (1 penggantian, dibaca ulang cocok)",
        fp.display()
    ))
}

pub fn delete_file(work_dir: &Path, path: &str) -> Result<String, String> {
    let fp = safe_path(work_dir, path)?;
    std::fs::remove_file(&fp).map_err(|e| e.to_string())?;
    // Verifikasi read-back: file benar-benar hilang dari disk.
    if fp.exists() {
        return Err(format!("verifikasi read-back GAGAL: {path} masih ada setelah dihapus"));
    }
    Ok(format!("Dihapus + terverifikasi: {}", fp.display()))
}

const SKIP_DIRS: &[&str] = &["node_modules", ".git", "dist", "build", "out", ".zcode", "target", ".next", "coverage"];
const TEXT_EXT: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "css", "html", "md", "txt",
    "yml", "yaml", "toml", "svg", "sh", "bat", "iss", "rs", "py", "go", "java",
    "c", "h", "cpp", "hpp", "sql", "xml",
];

fn walk_text(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 8 || out.len() > 400 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    for e in items {
        if out.len() > 400 {
            return;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        let full = e.path();
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if !SKIP_DIRS.contains(&name.as_str()) {
                walk_text(&full, out, depth + 1);
            }
            continue;
        }
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        if !ext.is_empty() && !TEXT_EXT.contains(&ext.as_str()) {
            continue;
        }
        if e.metadata().map(|m| m.len()).unwrap_or(0) > 512 * 1024 || is_sensitive(&full) {
            continue;
        }
        out.push(full);
    }
}

pub fn search_code(work_dir: &Path, query: &str, path: &str) -> Result<String, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("query kosong".into());
    }
    let lower = query.to_lowercase();
    let root = safe_path(work_dir, path)?;
    let mut files = Vec::new();
    walk_text(&root, &mut files, 0);
    let mut hits: Vec<String> = Vec::new();
    for fp in &files {
        if hits.len() >= 60 {
            break;
        }
        let text = match std::fs::read_to_string(fp) {
            Ok(t) => t,
            Err(_) => continue,
        };
        for (i, line) in text.lines().enumerate() {
            if hits.len() >= 60 {
                break;
            }
            if line.to_lowercase().contains(&lower) {
                let rel = fp.strip_prefix(&root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| fp.to_string_lossy().into_owned());
                let snippet: String = line.trim().chars().take(160).collect();
                hits.push(format!("{rel}:{}: {snippet}", i + 1));
            }
        }
    }
    let body = if hits.is_empty() {
        format!("Tidak ada hasil untuk \"{query}\"")
    } else {
        format!("{} hasil untuk \"{query}\":\n{}", hits.len(), hits.join("\n"))
    };
    Ok(clip(&body, 8000))
}

/// Pemeriksaan heuristik untuk perintah shell: menolak token yang jelas
/// mengarah ke luar folder kerja (`..`, path absolut/drive di luar base) dan
/// ekspansi variabel (`%VAR%`, `$VAR`, `~`) yang bisa menyamarkan path. Ini
/// BUKAN isolasi proses; batas kerasnya tetap approval user untuk tiap
/// perintah yang belum di-allowlist.
pub fn command_escape(work_dir: &Path, command: &str) -> Option<String> {
    if command.contains('%') || command.contains('$') || command.contains('~') || command.contains('`') {
        return Some("ekspansi variabel/tilde tidak diizinkan di perintah agent".into());
    }
    let base = std::fs::canonicalize(work_dir).map(strip_verbatim).unwrap_or_else(|_| normalize_lexical(work_dir));
    let tokens = command.split(|c: char| c.is_whitespace() || "&|;<>()\"'=,".contains(c)).filter(|t| !t.is_empty());
    for tok in tokens {
        if tok.split(['/', '\\']).any(|seg| seg == "..") {
            return Some(format!("path dengan '..' keluar dari folder kerja: {tok}"));
        }
        let absolute = tok.starts_with('/') || tok.starts_with('\\') || tok.as_bytes().get(1) == Some(&b':');
        if absolute && !inside_base(&base, tok) {
            return Some(format!("path absolut di luar folder kerja: {tok}"));
        }
    }
    None
}

fn inside_base(base: &Path, tok: &str) -> bool {
    let p = normalize_lexical(Path::new(tok));
    let full = strip_verbatim(resolve_existing(&p));
    full == base || full.starts_with(base)
}

/// Format hasil keluaran perintah: gabung stdout+stderr; exit non-zero →
/// "ERROR: …" (bukan panic) supaya loop LLM bisa lanjut.
fn format_command_output(o: &std::process::Output) -> String {
    let mut s = String::from_utf8_lossy(&o.stdout).into_owned();
    let err = String::from_utf8_lossy(&o.stderr);
    if !o.status.success() {
        if !s.is_empty() {
            s.push('\n');
        }
        s.push_str(&err);
        let t = s.trim();
        let t = if t.is_empty() { "gagal tanpa output" } else { t };
        if t.starts_with("ERROR:") { t.to_string() } else { format!("ERROR: {t}") }
    } else if s.trim().is_empty() {
        "(tanpa output)".to_string()
    } else {
        s
    }
}

/// run_command {command} — jalankan perintah di workDir (shell), timeout 30s.
/// ASYNC + cancel-aware: dulu versi sinkron memblokir satu worker tokio
/// penuh (hingga 30 detik) dan permintaan batal hanya terbaca di giliran
/// loop berikutnya — kini pembatalan meng-kill child seketika. Exit non-zero
/// / timeout / batal → "ERROR: …". Padanan toolRunCommand.
pub async fn run_command_async(
    work_dir: &Path,
    command: &str,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> String {
    let cmd = command.trim();
    if cmd.is_empty() {
        return "ERROR: command kosong".into();
    }
    if let Some(why) = command_escape(work_dir, cmd) {
        return format!("ERROR: perintah ditolak — {why}");
    }
    let (sh, flag) = if cfg!(windows) {
        (std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()), "/C")
    } else {
        (std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()), "-c")
    };
    let child = match tokio::process::Command::new(&sh)
        .arg(flag)
        .arg(cmd)
        .current_dir(work_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Future yang di-drop (timeout/batal) → child ikut di-drop → kill.
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return format!("ERROR: gagal menjalankan: {e}"),
    };
    let wait = child.wait_with_output();
    tokio::pin!(wait);
    let out = tokio::select! {
        res = &mut wait => match res {
            Ok(o) => format_command_output(&o),
            Err(e) => format!("ERROR: {e}"),
        },
        _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => "ERROR: timeout 30s".to_string(),
        _ = crate::llm_sched::wait_cancel(cancel) => "ERROR: dibatalkan oleh user".to_string(),
    };
    clip(&out, 12000)
}

pub fn git_diff(work_dir: &Path) -> Result<String, String> {
    let run = |args: &[&str]| -> String {
        Command::new("git")
            .args(args)
            .current_dir(work_dir)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    let st = run(&["status", "--short"]);
    let mut out = format!("git status:\n{}", if st.is_empty() { "(bersih)" } else { &st });
    if !st.is_empty() {
        let df = run(&["diff", "--stat"]);
        if !df.is_empty() {
            out.push_str(&format!("\n\ngit diff --stat:\n{df}"));
        }
    }
    Ok(clip(&out, 12000))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("l2dtool-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn safe_path_tolak_keluar() {
        let d = tmp();
        assert!(safe_path(&d, "sub/x.txt").is_ok());
        assert!(safe_path(&d, "../../etc/passwd").is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn safe_path_absolut_di_dalam_workdir_sah() {
        // Regresi: base kanonik Windows berprefiks \\?\ sehingga path ABSOLUT
        // (F:\…, di dalam workdir pun) selalu ditolak "di luar folder kerja".
        let d = tmp();
        let canon = std::fs::canonicalize(&d).unwrap();
        let abs_in = canon.join("sub/x.txt");
        assert!(safe_path(&d, abs_in.to_str().unwrap()).is_ok(), "path absolut di dalam workdir harus sah: {abs_in:?}");
        // Di luar tetap ditolak.
        let luar = std::env::temp_dir();
        assert!(safe_path(&d, luar.join("l2d-di-luar.txt").to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn fs_write_read_edit_delete_list() {
        let d = tmp();
        assert!(write_file(&d, "a/b.txt", "halo dunia").unwrap().contains("char"));
        assert_eq!(read_file(&d, "a/b.txt").unwrap(), "halo dunia");
        edit_file(&d, "a/b.txt", "dunia", "rust").unwrap();
        assert_eq!(read_file(&d, "a/b.txt").unwrap(), "halo rust");
        // edit multi-match ditolak
        write_file(&d, "c.txt", "x x").unwrap();
        assert!(edit_file(&d, "c.txt", "x", "y").is_err());
        assert!(list_dir(&d, ".").unwrap().contains("a/"));
        delete_file(&d, "c.txt").unwrap();
        assert!(read_file(&d, "c.txt").is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn safe_path_tolak_symlink_keluar() {
        let d = tmp();
        let outside = tmp();
        std::fs::write(outside.join("rahasia.txt"), "x").unwrap();
        let link = d.join("tautan");
        // Symlink butuh hak khusus di Windows; lewati bila tak tersedia.
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&outside, &link).is_ok();
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(&outside, &link).is_ok();
        if made {
            assert!(safe_path(&d, "tautan/rahasia.txt").is_err(), "symlink keluar harus ditolak");
            assert!(read_file(&d, "tautan/rahasia.txt").is_err());
        }
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn berkas_sensitif_tak_dibaca_atau_dicari() {
        let d = tmp();
        write_file(&d, ".env", "API_KEY=rahasia123").unwrap();
        write_file(&d, "data/config.json", "{\"apiKey\":\"rahasia123\"}").unwrap();
        write_file(&d, "src/app.rs", "rahasia123 bukan di sini").unwrap();
        assert!(read_file(&d, ".env").unwrap_err().contains("sensitif"));
        assert!(read_file(&d, "data/config.json").is_err());
        let r = search_code(&d, "rahasia123", ".").unwrap();
        assert!(r.contains("src/app.rs"));
        assert!(!r.contains(".env") && !r.contains("config.json"), "{r}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn run_command_tolak_jalan_keluar() {
        let d = tmp();
        let (_tx, mut rx) = tokio::sync::watch::channel(false);
        assert!(command_escape(&d, "type ..\\..\\secret.txt").is_some());
        assert!(command_escape(&d, "type ../../secret.txt").is_some());
        assert!(command_escape(&d, "echo %USERPROFILE%").is_some());
        assert!(command_escape(&d, "cat $HOME/.ssh/id_rsa").is_some());
        assert!(command_escape(&d, "cat ~/x").is_some());
        let r = run_command_async(&d, "type ..\\..\\secret.txt", &mut rx).await;
        assert!(r.starts_with("ERROR: perintah ditolak"), "{r}");
        // Perintah wajar di dalam workdir tetap lolos.
        assert!(command_escape(&d, "cargo test -p live2d-core").is_none());
        assert!(command_escape(&d, "dir src").is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn run_command_async_jalan_dan_bisa_dibatalkan() {
        let d = tmp();
        let (_tx, mut rx) = tokio::sync::watch::channel(false);
        let out = run_command_async(&d, "echo halo", &mut rx).await;
        assert!(out.to_lowercase().contains("halo"), "{out}");
        assert!(run_command_async(&d, "", &mut rx).await.starts_with("ERROR"));
        // Cancel yang SUDAH menyala → perintah tidak dieksekusi (dibatalkan).
        let (ctx, mut crx) = tokio::sync::watch::channel(false);
        ctx.send(true).unwrap();
        let out2 = run_command_async(&d, "echo jangan", &mut crx).await;
        assert!(out2.contains("dibatalkan"), "{out2}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn search_menemukan() {
        let d = tmp();
        write_file(&d, "src/main.rs", "fn main() { println!(\"tandaX\"); }").unwrap();
        write_file(&d, "node_modules/skip.js", "tandaX").unwrap(); // di-skip
        let r = search_code(&d, "tandaX", ".").unwrap();
        assert!(r.contains("src/main.rs:1"));
        assert!(!r.contains("node_modules"));
        assert!(search_code(&d, "zzz", ".").unwrap().contains("Tidak ada"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
