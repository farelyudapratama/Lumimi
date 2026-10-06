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

/// Path aman di dalam workDir (padanan safePath). Err bila keluar.
pub fn safe_path(work_dir: &Path, p: &str) -> Result<PathBuf, String> {
    // Base dan full dibandingkan pada bentuk yang sama (tanpa prefiks
    // verbatim). Dulu base di-canonicalize mentah: di Windows base = \\?\F:\…
    // sedangkan join path absolut = F:\… → starts_with gagal → SEMUA path
    // absolut ditolak "di luar folder kerja" walau masih di dalam workdir.
    let base = std::fs::canonicalize(work_dir)
        .map(strip_verbatim)
        .unwrap_or_else(|_| normalize_lexical(work_dir));
    let rel = if p.is_empty() { "." } else { p };
    // Path input sendiri bisa membawa prefiks verbatim (mis. hasil
    // canonicalize yang dikirim ulang model) — samakan sebelum membandingkan.
    let full = strip_verbatim(normalize_lexical(&base.join(rel)));
    if full == base || full.starts_with(&base) {
        Ok(full)
    } else {
        Err(format!("di luar folder kerja: {p}"))
    }
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
    let text = std::fs::read_to_string(&fp).map_err(|e| e.to_string())?;
    Ok(clip(&text, 12000))
}

pub fn write_file(work_dir: &Path, path: &str, content: &str) -> Result<String, String> {
    let fp = safe_path(work_dir, path)?;
    if let Some(parent) = fp.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&fp, content).map_err(|e| e.to_string())?;
    Ok(format!("Tersimpan: {} ({} char)", fp.display(), content.chars().count()))
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
    Ok(format!("Diedit: {} (1 penggantian)", fp.display()))
}

pub fn delete_file(work_dir: &Path, path: &str) -> Result<String, String> {
    let fp = safe_path(work_dir, path)?;
    std::fs::remove_file(&fp).map_err(|e| e.to_string())?;
    Ok(format!("Dihapus: {}", fp.display()))
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
        if e.metadata().map(|m| m.len()).unwrap_or(0) > 512 * 1024 {
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

/// run_command {command} — jalankan perintah di workDir (shell), timeout 30s.
/// Exit non-zero / timeout → string "ERROR: …" (bukan panic) supaya loop LLM
/// bisa lanjut. Padanan toolRunCommand.
pub fn run_command(work_dir: &Path, command: &str) -> String {
    let cmd = command.trim();
    if cmd.is_empty() {
        return "ERROR: command kosong".into();
    }
    let (sh, flag) = if cfg!(windows) {
        (std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()), "/C")
    } else {
        (std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()), "-c")
    };
    let mut child = match Command::new(&sh)
        .arg(flag)
        .arg(cmd)
        .current_dir(work_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return format!("ERROR: gagal menjalankan: {e}"),
    };
    // timeout 30s via polling try_wait.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return "ERROR: timeout 30s".into();
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return format!("ERROR: {e}"),
        }
    }
    let out = child.wait_with_output().map(|o| {
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
    }).unwrap_or_else(|e| format!("ERROR: {e}"));
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
