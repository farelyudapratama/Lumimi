//! browser/ — Control plane browser agent (Edge/Chrome via CDP). Meluncurkan
//! browser dengan remote-debugging,
//! menghubungkan CDP, dan menyediakan open/navigate/inspect/click/type/
//! screenshot dengan kebijakan URL (policy) + snapshot AX ber-ref.
//!
//! Satu instance global (single browser terkontrol). Verifikasi butuh browser
//! sungguhan — lihat manual-test checklist.

pub mod cdp;
pub mod policy;
pub mod snapshot;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::Engine;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use cdp::CdpClient;
use policy::{inspect_browser_url, OriginGrants, UrlDecision};
use snapshot::{format_inspect, normalize_ax_tree, RefErr, SnapshotStore};

// ── Discovery (Windows Edge/Chrome) ─────────────────────────────────────────
fn edge_candidates() -> Vec<String> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let mut c = Vec::new();
    if !local.is_empty() {
        c.push(format!("{local}\\Microsoft\\Edge\\Application\\msedge.exe"));
    }
    c.push("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe".into());
    c.push("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe".into());
    c
}

fn chrome_candidates() -> Vec<String> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let mut c = Vec::new();
    if !local.is_empty() {
        c.push(format!("{local}\\Google\\Chrome\\Application\\chrome.exe"));
    }
    c.push("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe".into());
    c.push("C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe".into());
    c
}

/// Deteksi browser default Windows (ProgId di registry, dibaca via reg.exe —
/// tanpa dep baru). Some("chrome"/"edge") bila default-nya Chromium yang bisa
/// dikendalikan CDP; None bila lain (Firefox/dst) atau reg gagal (non-Windows).
fn windows_default_chromium() -> Option<&'static str> {
    let out = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice", "/v", "Progid"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
    if text.contains("chromehtml") {
        Some("chrome")
    } else if text.contains("msedgehtm") {
        Some("edge")
    } else {
        None
    }
}

/// Kandidat exe sesuai pref ("auto"|"edge"|"chrome"). "auto" menaruh browser
/// default Windows di depan bila Edge/Chrome, selain itu urutan lama
/// Edge → Chrome (Edge praktis selalu ada di Windows).
fn chromium_candidates(pref: &str) -> Vec<String> {
    let (edge, chrome) = (edge_candidates(), chrome_candidates());
    match pref {
        "edge" => edge,
        "chrome" => chrome,
        _ if windows_default_chromium() == Some("chrome") => {
            let mut c = chrome;
            c.extend(edge);
            c
        }
        _ => {
            let mut c = edge;
            c.extend(chrome);
            c
        }
    }
}

pub fn find_chromium(pref: &str) -> Option<String> {
    chromium_candidates(pref).into_iter().find(|f| Path::new(f).exists())
}

fn config_path(root: &Path) -> PathBuf {
    root.join("data").join("config.json")
}

/// Pref engine dari config (`browser.engine`); nilai tak dikenal → "auto".
fn engine_pref_from_config(root: &Path) -> String {
    let cfg = crate::config::load(&config_path(root));
    let e = cfg
        .get("browser")
        .and_then(|b| b.get("engine"))
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        .trim()
        .to_lowercase();
    if matches!(e.as_str(), "auto" | "edge" | "chrome") { e } else { "auto".to_string() }
}

// ── Deteksi captcha (advisory: berhenti + serahkan ke user, BUKAN dipecahkan) ──
/// Marker pada haystack lowercase (url+title+teks AX) → nama kind.
const CAPTCHA_MARKERS: &[(&str, &str)] = &[
    ("recaptcha", "reCAPTCHA"),
    ("hcaptcha", "hCaptcha"),
    ("challenges.cloudflare.com", "Cloudflare"),
    ("just a moment", "Cloudflare"),
    ("verify you are human", "Cloudflare"),
    ("verify you're human", "Cloudflare"),
    ("checking your browser", "Cloudflare"),
    ("attention required", "Cloudflare"),
];

/// Instruksi untuk agent saat captcha terdeteksi: berhenti & serahkan ke user.
const CAPTCHA_HINT: &str = "Captcha terdeteksi di halaman ini. JANGAN mencoba menyelesaikannya (klik/otomasi tidak akan lolos dan melanggar aturan situs). Berhenti, beri tahu user untuk menyelesaikan captcha secara manual di jendela browser yang terbuka, lalu tunggu konfirmasi user sebelum melanjutkan.";

/// Deteksi captcha dari teks halaman. Return nama kind (reCAPTCHA/hCaptcha/
/// Cloudflare/captcha) — None bila tak ada indikasi. Advisory saja.
pub fn detect_captcha(hay: &str) -> Option<&'static str> {
    let h = hay.to_lowercase();
    for (m, kind) in CAPTCHA_MARKERS {
        if h.contains(m) {
            return Some(kind);
        }
    }
    if h.contains("captcha") {
        return Some("captcha");
    }
    None
}

fn engine_of(exe: &Option<String>) -> Option<&'static str> {
    let name = exe.as_deref()?.to_lowercase();
    if name.contains("edge") {
        Some("edge")
    } else if name.contains("chrome") {
        Some("chrome")
    } else {
        None
    }
}

// ── Manager ─────────────────────────────────────────────────────────────────
#[derive(Default)]
pub struct BrowserManager {
    executable: Option<String>,
    engine_pref: Option<String>, // None = belum dimuat dari config
    captcha: Option<String>,     // kind captcha di halaman aktif (advisory)
    profile_dir: Option<PathBuf>,
    root: Option<PathBuf>,       // akar app — disimpan utk re-launch otomatis
    launched: bool,              // pernah diluncurkan & BELUM ditutup sengaja
    client: Option<CdpClient>,
    process: Option<std::process::Child>,
    url: String,
    title: String,
    can_back: bool,
    can_forward: bool,
    last_error: Option<String>,
    current_snapshot_id: Option<String>,
    grants: OriginGrants,
    snapshots: SnapshotStore,
}

fn mgr() -> &'static Mutex<BrowserManager> {
    static M: OnceLock<Mutex<BrowserManager>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(BrowserManager::default()))
}

const SPAWN_ARGS: &[&str] = &[
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--new-window",
    "about:blank",
];

impl BrowserManager {
    /// Pastikan engine_pref terisi (dari config, sekali per proses) dan
    /// executable cocok dengannya. Dipanggil dari jalur yang punya root.
    fn resolve_executable(&mut self, root: &Path) {
        self.root = Some(root.to_path_buf());
        if self.engine_pref.is_none() {
            self.engine_pref = Some(engine_pref_from_config(root));
        }
        if self.executable.is_none() {
            let pref = self.engine_pref.clone().unwrap_or_else(|| "auto".into());
            self.executable = find_chromium(&pref);
        }
    }

    fn connected(&self) -> bool {
        self.client.as_ref().map(|c| !c.is_closed()).unwrap_or(false)
    }

    fn origin_granted(&self) -> bool {
        url::Url::parse(&self.url).ok().map(|u| self.grants.has(&u.origin().unicode_serialization())).unwrap_or(false)
    }

    fn status_value(&self) -> Value {
        let mut v = json!({
            "available": self.executable.is_some(),
            "running": self.process.is_some(),
            "connected": self.connected(),
            "engine": engine_of(&self.executable),
            "enginePref": self.engine_pref.clone().unwrap_or_else(|| "auto".into()),
            "captcha": self.captcha,
            "url": self.url,
            "title": self.title,
            "canBack": self.can_back,
            "canForward": self.can_forward,
            "originGranted": self.origin_granted(),
        });
        if let Some(e) = &self.last_error {
            v["error"] = json!(e);
        }
        v
    }

    fn require_client(&self) -> Result<&CdpClient, String> {
        match &self.client {
            Some(c) if !c.is_closed() => Ok(c),
            _ => Err("browser belum terbuka atau CDP terputus".into()),
        }
    }

    fn reset(&mut self, error: Option<String>) {
        if let Some(mut p) = self.process.take() {
            let _ = p.kill();
        }
        self.client = None;
        self.url.clear();
        self.title.clear();
        self.can_back = false;
        self.can_forward = false;
        self.current_snapshot_id = None;
        self.captcha = None;
        self.snapshots.clear();
        self.last_error = error;
    }

    /// Proses browser sudah exit (jendela ditutup user dari luar)? Bila iya,
    /// bangkainya direap (state direset) dan return true.
    fn reap_if_dead(&mut self) -> bool {
        let dead = matches!(self.process.as_mut().map(|p| p.try_wait()), Some(Ok(Some(_))));
        if dead {
            self.reset(Some("browser ditutup dari luar — dibuka ulang otomatis".into()));
        }
        dead
    }

    /// Pastikan client CDP siap dipakai tool: bila proses mati, LUNCURKAN
    /// ULANG otomatis (pakai root tersimpan) — task agent tidak menggantung
    /// sampai CDP timeout hanya karena user menutup jendela browser.
    async fn ensure_alive(&mut self) -> Result<&CdpClient, String> {
        // Dua bentuk "jendela ditutup dari luar": bangkai proses masih terpasang
        // (reap di sini) atau sudah direap jalur lain (status()/polling) — yang
        // membedakannya dari tutup-SENGAJA (close/set_engine, launched=false)
        // adalah flag `launched`. Tutup sengaja tidak dibuka ulang.
        let reaped = self.reap_if_dead();
        let orphaned = !reaped && self.launched && self.client.is_none();
        if (reaped || orphaned) && self.launched {
            let root = self
                .root
                .clone()
                .ok_or_else(|| "browser ditutup dari luar dan root belum diketahui".to_string())?;
            self.launch(&root).await?;
        }
        match &self.client {
            Some(c) if !c.is_closed() => Ok(c),
            _ => Err("browser belum terbuka atau CDP terputus".into()),
        }
    }

    async fn launch(&mut self, root: &Path) -> Result<(), String> {
        self.resolve_executable(root);
        let exe = self.executable.clone().ok_or("Edge/Chrome tidak ditemukan")?;
        let profile = root.join("data").join("browser").join("profile");
        std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(profile.join("DevToolsActivePort"));
        self.profile_dir = Some(profile.clone());

        let mut args: Vec<String> = vec![format!("--user-data-dir={}", profile.display())];
        args.extend(SPAWN_ARGS.iter().map(|s| s.to_string()));
        let child = std::process::Command::new(&exe)
            .args(&args)
            .spawn()
            .map_err(|e| format!("gagal meluncurkan browser: {e}"))?;
        self.process = Some(child);
        self.launched = true;

        // Tunggu DevToolsActivePort (baris 1 = port).
        let port = self.wait_devtools_port(&profile).await?;
        let list_url = format!("http://127.0.0.1:{port}/json/list");
        let client = reqwest::Client::new();
        let targets: Vec<Value> = match client.get(&list_url).timeout(std::time::Duration::from_secs(5)).send().await {
            Ok(r) => r.json().await.map_err(|e| format!("daftar target CDP gagal: {e}"))?,
            Err(e) => {
                self.reset(Some(format!("daftar target CDP gagal: {e}")));
                return Err(format!("daftar target CDP gagal: {e}"));
            }
        };
        let target = choose_page_target(&targets);
        let ws_url = match target.and_then(|t| t.get("webSocketDebuggerUrl").and_then(|v| v.as_str())) {
            Some(u) => u.to_string(),
            None => {
                self.reset(Some("target page CDP tidak ditemukan".into()));
                return Err("target page CDP tidak ditemukan".into());
            }
        };
        let cdp = match CdpClient::connect(&ws_url).await {
            Ok(c) => c,
            Err(e) => {
                self.reset(Some(e.clone()));
                return Err(e);
            }
        };
        let t_url = target.and_then(|t| t.get("url").and_then(|v| v.as_str())).unwrap_or("");
        self.url = if t_url == "about:blank" { String::new() } else { t_url.to_string() };
        self.title = target.and_then(|t| t.get("title").and_then(|v| v.as_str())).unwrap_or("").to_string();
        for m in ["Page.enable", "Runtime.enable", "Accessibility.enable", "DOM.enable"] {
            let _ = cdp.send(m, json!({}), 10_000).await;
        }
        self.client = Some(cdp);
        self.refresh_history().await;
        self.last_error = None;
        Ok(())
    }

    async fn wait_devtools_port(&mut self, profile: &Path) -> Result<u32, String> {
        let file = profile.join("DevToolsActivePort");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
        while std::time::Instant::now() < deadline {
            if let Some(p) = self.process.as_mut() {
                if let Ok(Some(_)) = p.try_wait() {
                    return Err("proses browser berhenti sebelum CDP siap".into());
                }
            }
            if let Ok(txt) = std::fs::read_to_string(&file) {
                if let Some(line) = txt.lines().next() {
                    if let Ok(port) = line.trim().parse::<u32>() {
                        if port > 0 && port <= 65_535 {
                            return Ok(port);
                        }
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(75)).await;
        }
        Err("timeout menunggu DevToolsActivePort".into())
    }

    async fn authorize(&self, raw: &str) -> Result<UrlDecision, String> {
        let d = inspect_browser_url(raw).await;
        if !d.ok {
            return Err(d.error.unwrap_or_else(|| "URL tidak diizinkan".into()));
        }
        gate_privat(&d, &self.grants)?;
        Ok(d)
    }

    async fn navigate_authorized(&mut self, normalized: &str) -> Result<(), String> {
        let checked = inspect_browser_url(normalized).await;
        if !checked.ok || checked.url.is_none() {
            return Err(checked.error.unwrap_or_else(|| "URL tidak diizinkan".into()));
        }
        if checked.url.as_deref() != Some(normalized) {
            return Err("URL berubah saat pemeriksaan ulang".into());
        }
        gate_privat(&checked, &self.grants)?;
        let url = checked.url.clone().unwrap();
        let result = self.require_client()?.send("Page.navigate", json!({ "url": url }), 10_000).await?;
        if let Some(err) = result.get("errorText").and_then(|v| v.as_str()) {
            if !err.is_empty() {
                let host = url::Url::parse(&url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
                return Err(jelaskan_error_navigasi(err, &host));
            }
        }
        self.url = url;
        self.title.clear();
        self.current_snapshot_id = None;
        self.captcha = None;
        Ok(())
    }

    async fn verify_current_page(&mut self) -> Result<(), String> {
        let tree = self.require_client()?.send("Page.getFrameTree", json!({}), 10_000).await?;
        let live = tree.get("frameTree").and_then(|f| f.get("frame")).and_then(|f| f.get("url")).and_then(|v| v.as_str()).unwrap_or(&self.url).to_string();
        if live.is_empty() || live == "about:blank" {
            return Ok(());
        }
        // Host sama = origin sudah diotorisasi saat navigasi. Lewati resolve
        // DNS ulang di setiap inspect/click/type — dulu tiap verifikasi
        // me-resolve ulang, dan DNS yang sempat gagal dilaporkan salah
        // sebagai "origin tidak diizinkan" (false alarm "browser tidak aman").
        if host_dari(&live) == host_dari(&self.url) {
            if live != self.url {
                self.url = live;
                self.current_snapshot_id = None;
                self.captcha = None;
            }
            return Ok(());
        }
        if !live.starts_with("http://") && !live.starts_with("https://") {
            // chrome-error://chromewebdata dkk. — bukan halaman web biasa.
            self.current_snapshot_id = None;
            return Err(format!(
                "halaman aktif bukan halaman web normal ({live}) — navigasi kemungkinan gagal, ulangi browser_navigate dengan URL yang benar"
            ));
        }
        let d = inspect_browser_url(&live).await;
        if !d.ok {
            self.current_snapshot_id = None;
            return Err(format!(
                "halaman aktif pindah ke \"{live}\" tapi tidak bisa diverifikasi: {}",
                d.error.unwrap_or_default()
            ));
        }
        if let Err(e) = gate_privat(&d, &self.grants) {
            self.current_snapshot_id = None;
            return Err(e);
        }
        if live != self.url {
            self.url = d.url.unwrap_or(live);
            self.current_snapshot_id = None;
            self.captcha = None;
        }
        Ok(())
    }

    async fn refresh_history(&mut self) {
        if self.require_client().is_err() {
            return;
        }
        if let Ok(h) = self.require_client().unwrap().send("Page.getNavigationHistory", json!({}), 10_000).await {
            self.apply_history(&h);
        }
        self.read_title().await;
    }

    fn apply_history(&mut self, h: &Value) {
        let idx = h.get("currentIndex").and_then(|v| v.as_i64()).unwrap_or(-1);
        let entries = h.get("entries").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        self.can_back = idx > 0;
        self.can_forward = idx >= 0 && (idx as usize) < entries.len().saturating_sub(1);
        if idx >= 0 {
            if let Some(cur) = entries.get(idx as usize) {
                if let Some(u) = cur.get("url").and_then(|v| v.as_str()) {
                    if u != "about:blank" {
                        self.url = u.to_string();
                    }
                }
                if let Some(t) = cur.get("title").and_then(|v| v.as_str()) {
                    if !t.is_empty() {
                        self.title = t.to_string();
                    }
                }
            }
        }
    }

    async fn read_title(&mut self) {
        if let Ok(c) = self.require_client() {
            if let Ok(r) = c.send("Runtime.evaluate", json!({ "expression": "document.title", "returnByValue": true, "silent": true }), 10_000).await {
                if let Some(t) = r.get("result").and_then(|v| v.get("value")).and_then(|v| v.as_str()) {
                    self.title = t.to_string();
                }
            }
        }
    }

    async fn dispatch_point(&self, x: f64, y: f64) -> Result<(), String> {
        let c = self.require_client()?;
        c.send("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y }), 10_000).await?;
        c.send("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1 }), 10_000).await?;
        c.send("Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1 }), 10_000).await?;
        Ok(())
    }
}

/// Gerbang origin privat: tanpa grant → error yang menyebut origin DAN
/// langkah berikutnya. Pesan lama ("memerlukan persetujuan user") bikin
/// LLM mengarang "browser tidak aman" tanpa tahu harus apa.
fn gate_privat(d: &UrlDecision, grants: &OriginGrants) -> Result<(), String> {
    if d.private_network {
        if let Some(o) = &d.origin {
            if !grants.has(o) {
                return Err(format!(
                    "origin privat {o} butuh persetujuan user — bila user setuju, panggil browser_grant_private dengan origin \"{o}\"; kalau tidak, pakai URL publik"
                ));
            }
        }
    }
    Ok(())
}

/// Host dari URL mentah tanpa validasi penuh — pembanding cepat utk
/// verifikasi halaman aktif. URL tak ter-parse → string kosong.
fn host_dari(raw: &str) -> String {
    url::Url::parse(raw).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default()
}

/// Terjemahkan errorText CDP jadi penyebab yang jujur & singkat. Kode mentah
/// dipertahankan dalam kurung supaya jejak aslinya tak hilang — parafrase
/// kosong dari LLM ("ga ada internet"/"tidak aman") lahir dari pesan error
/// yang tidak menjelaskan apa-apa.
fn jelaskan_error_navigasi(error_text: &str, host: &str) -> String {
    let e = error_text;
    let alasan = if e.contains("ERR_NAME_NOT_RESOLVED") {
        format!("DNS gagal men-resolve \"{host}\" — koneksi internet/DNS kemungkinan sedang gangguan")
    } else if e.contains("ERR_INTERNET_DISCONNECTED") {
        "komputer sedang tidak terhubung ke internet".to_string()
    } else if e.contains("ERR_CONNECTION_TIMED_OUT") || e.contains("ERR_TIMED_OUT") {
        format!("server \"{host}\" tidak merespons (timeout)")
    } else if e.contains("ERR_CONNECTION_REFUSED") {
        format!("server \"{host}\" menolak koneksi")
    } else if e.contains("ERR_CONNECTION_RESET") || e.contains("ERR_CONNECTION_CLOSED") {
        "koneksi direset di tengah jalan".to_string()
    } else if e.contains("ERR_CERT") || e.contains("SSL") || e.contains("TLS") {
        "sertifikat keamanan situs tidak valid — browser menolak membukanya".to_string()
    } else if e.contains("ERR_BLOCKED_BY") {
        "permintaan diblokir (oleh situs atau client)".to_string()
    } else if e.contains("ERR_ABORTED") {
        "navigasi dibatalkan (mungkin oleh redirect atau halaman itu sendiri)".to_string()
    } else {
        "gagal memuat halaman".to_string()
    };
    format!("navigasi gagal: {alasan} [{e}]")
}

fn choose_page_target(targets: &[Value]) -> Option<&Value> {
    let pages: Vec<&Value> = targets.iter().filter(|t| t.get("type").and_then(|v| v.as_str()) == Some("page") && t.get("webSocketDebuggerUrl").and_then(|v| v.as_str()).is_some()).collect();
    pages.iter().find(|t| t.get("url").and_then(|v| v.as_str()) == Some("about:blank")).copied().or_else(|| pages.first().copied())
}

// ── API publik (dipakai handler lib.rs) ─────────────────────────────────────

pub async fn status(root: &Path) -> Value {
    let mut m = mgr().lock().await;
    // sinkron: bila proses sudah exit, reset.
    let dead = m.process.as_mut().map(|p| matches!(p.try_wait(), Ok(Some(_)))).unwrap_or(false);
    if dead {
        m.reset(Some("browser ditutup".into()));
    }
    m.resolve_executable(root);
    m.status_value()
}

/// Set pref engine (`auto`|`edge`|`chrome`), simpan ke config, lalu tutup
/// browser yang sedang jalan agar buka berikutnya memakai engine baru.
pub async fn set_engine(root: &Path, pref: &str) -> Result<Value, String> {
    let p = pref.trim().to_lowercase();
    if !matches!(p.as_str(), "auto" | "edge" | "chrome") {
        return Err("engine harus auto, edge, atau chrome".into());
    }
    crate::config::save_browser(&config_path(root), &json!({ "engine": p }))
        .map_err(|e| format!("gagal menyimpan: {e}"))?;
    let mut m = mgr().lock().await;
    m.engine_pref = Some(p.clone());
    m.executable = find_chromium(&p);
    if m.process.is_some() || m.connected() {
        shutdown(&mut m).await;
    }
    Ok(m.status_value())
}

pub async fn grant_private_origin(raw_origin: &str) -> Result<String, String> {
    let u = url::Url::parse(raw_origin).map_err(|_| "origin tidak valid".to_string())?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("origin grant harus http/https".into());
    }
    if !u.username().is_empty() || u.password().is_some() || u.path() != "/" || u.query().is_some() || u.fragment().is_some() {
        return Err("grant harus berupa origin tanpa path/credential".into());
    }
    let d = inspect_browser_url(&u.origin().unicode_serialization()).await;
    if !d.ok || d.origin.is_none() {
        return Err(d.error.unwrap_or_else(|| "origin tidak valid".into()));
    }
    if !d.private_network {
        return Err("grant hanya untuk origin privat".into());
    }
    let origin = d.origin.unwrap();
    mgr().lock().await.grants.grant(&origin);
    Ok(origin)
}

pub async fn open(root: &Path, raw_url: &str, allow_private: bool) -> Result<Value, String> {
    // allowPrivate: grant origin privat dulu bila diminta.
    if allow_private {
        let d = inspect_browser_url(raw_url).await;
        if !d.ok || d.origin.is_none() {
            return Err(d.error.unwrap_or_else(|| "URL tidak valid".into()));
        }
        if !d.private_network {
            return Err("allowPrivate hanya untuk origin privat".into());
        }
        mgr().lock().await.grants.grant(d.origin.as_deref().unwrap());
    }
    let mut m = mgr().lock().await;
    let decision = m.authorize(raw_url).await?;
    let url = decision.url.ok_or("URL tidak valid")?;
    if m.require_client().is_err() {
        m.launch(root).await?;
    }
    m.navigate_authorized(&url).await?;
    Ok(m.status_value())
}

/// Jalur tool browser: pastikan browser hidup sebelum perintah apa pun.
/// Dipanggil dari `agent_exec` — user menutup jendela browser bukan alasan
/// task menggantung; browser dibuka ulang dan tool jalan Normal.
pub async fn ensure_alive(root: &Path) -> Result<(), String> {
    let mut m = mgr().lock().await;
    m.resolve_executable(root);
    m.ensure_alive().await.map(|_| ())
}

pub async fn navigate(raw_url: &str) -> Result<Value, String> {
    let mut m = mgr().lock().await;
    m.ensure_alive().await?;
    m.require_client()?;
    let decision = m.authorize(raw_url).await?;
    let url = decision.url.ok_or("URL tidak valid")?;
    m.navigate_authorized(&url).await?;
    Ok(m.status_value())
}

pub async fn history(action: &str) -> Result<(), String> {
    let mut m = mgr().lock().await;
    match action {
        "back" | "forward" => {
            let h = m.require_client()?.send("Page.getNavigationHistory", json!({}), 10_000).await?;
            m.apply_history(&h);
            let idx = h.get("currentIndex").and_then(|v| v.as_i64()).unwrap_or(-1);
            let entries = h.get("entries").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let target_idx = if action == "back" { idx - 1 } else { idx + 1 };
            let entry = if target_idx >= 0 { entries.get(target_idx as usize) } else { None };
            let eid = entry.and_then(|e| e.get("id")).and_then(|v| v.as_i64()).ok_or_else(|| format!("tidak ada riwayat {action}"))?;
            m.require_client()?.send("Page.navigateToHistoryEntry", json!({ "entryId": eid }), 10_000).await?;
            m.current_snapshot_id = None;
            m.captcha = None;
            Ok(())
        }
        "reload" => {
            m.require_client()?.send("Page.reload", json!({ "ignoreCache": false }), 10_000).await?;
            m.current_snapshot_id = None;
            m.captcha = None;
            Ok(())
        }
        _ => Err("action harus back, forward, atau reload".into()),
    }
}

pub async fn inspect(cursor: usize, max_chars: usize, snapshot_id: Option<&str>) -> Result<Value, String> {
    let mut m = mgr().lock().await;
    if let Some(sid) = snapshot_id {
        let snap = m.snapshots.get(sid).map_err(|e| e.message().to_string())?;
        return Ok(format_inspect(&snap, cursor, max_chars));
    }
    m.require_client()?;
    m.verify_current_page().await?;
    let (url, title) = (m.url.clone(), m.title.clone());
    let result = m.require_client()?.send("Accessibility.getFullAXTree", json!({ "depth": -1 }), 15_000).await?;
    let nodes = result.get("nodes").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let snap = normalize_ax_tree(&nodes, &url, &title);
    let sid = snap.snapshot_id.clone();
    // Deteksi captcha dari url+title+teks AX; hasil disimpan utk status & tool.
    let hay = {
        let mut parts = vec![snap.url.clone(), snap.title.clone()];
        for n in &snap.nodes {
            parts.push(n.name.clone());
            if let Some(v) = &n.value { parts.push(v.clone()); }
            if let Some(d) = &n.description { parts.push(d.clone()); }
        }
        parts.join(" ")
    };
    let kind = detect_captcha(&hay);
    m.captcha = kind.map(|s| s.to_string());
    let mut out = format_inspect(&snap, cursor, max_chars);
    if let Some(k) = kind {
        out["captcha"] = json!(k);
        out["captchaHint"] = json!(CAPTCHA_HINT);
    }
    m.snapshots.put(snap);
    m.current_snapshot_id = Some(sid);
    Ok(out)
}

fn resolve_node(m: &mut BrowserManager, snapshot_id: &str, ref_id: &str) -> Result<snapshot::AxNode, String> {
    let cur = m.current_snapshot_id.clone();
    match &cur {
        None => return Err("inspect halaman sebelum memakai ref".into()),
        Some(c) if c != snapshot_id => return Err("snapshot browser sudah stale setelah navigasi/inspect baru".into()),
        _ => {}
    }
    let url = m.url.clone();
    m.snapshots.resolve(ref_id, Some(snapshot_id), Some(&url)).map_err(|e: RefErr| e.message().to_string())
}

pub async fn click(snapshot_id: &str, ref_id: &str) -> Result<(), String> {
    let mut m = mgr().lock().await;
    m.require_client()?;
    m.verify_current_page().await?;
    let node = resolve_node(&mut m, snapshot_id, ref_id)?;
    let backend = node.backend_dom_node_id.ok_or("elemen tidak punya target DOM")?;
    let model = m.require_client()?.send("DOM.getBoxModel", json!({ "backendNodeId": backend }), 10_000).await?;
    let quad = model.get("model").and_then(|mm| mm.get("border").or_else(|| mm.get("content"))).and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if quad.len() < 8 {
        return Err("elemen tidak terlihat atau tidak punya box".into());
    }
    let g = |i: usize| quad[i].as_f64().unwrap_or(0.0);
    let x = (g(0) + g(2) + g(4) + g(6)) / 4.0;
    let y = (g(1) + g(3) + g(5) + g(7)) / 4.0;
    m.dispatch_point(x, y).await
}

pub async fn click_point(nx: f64, ny: f64) -> Result<(), String> {
    let mut m = mgr().lock().await;
    m.require_client()?;
    m.verify_current_page().await?;
    if !(0.0..=1.0).contains(&nx) || !(0.0..=1.0).contains(&ny) {
        return Err("koordinat preview harus antara 0 dan 1".into());
    }
    let layout = m.require_client()?.send("Page.getLayoutMetrics", json!({}), 10_000).await?;
    let vp = layout.get("cssLayoutViewport");
    let w = vp.and_then(|v| v.get("clientWidth")).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let h = vp.and_then(|v| v.get("clientHeight")).and_then(|v| v.as_f64()).unwrap_or(0.0);
    if w <= 0.0 || h <= 0.0 {
        return Err("ukuran viewport browser tidak tersedia".into());
    }
    m.dispatch_point(nx * w, ny * h).await
}

pub async fn type_text(snapshot_id: &str, ref_id: &str, value: &str, press_enter: bool) -> Result<(), String> {
    let mut m = mgr().lock().await;
    m.require_client()?;
    m.verify_current_page().await?;
    let node = resolve_node(&mut m, snapshot_id, ref_id)?;
    if node.sensitive {
        return Err("pengisian password/rahasia tidak diizinkan".into());
    }
    let backend = node.backend_dom_node_id.ok_or("elemen tidak punya target DOM")?;
    let c = m.require_client()?;
    c.send("DOM.focus", json!({ "backendNodeId": backend }), 10_000).await?;
    c.send("Input.insertText", json!({ "text": value }), 10_000).await?;
    if press_enter {
        c.send("Input.dispatchKeyEvent", json!({ "type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13 }), 10_000).await?;
        c.send("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13 }), 10_000).await?;
    }
    Ok(())
}

/// Return (bytes, mime, width, height, ts).
pub async fn screenshot(format: &str, quality: u8) -> Result<(Vec<u8>, &'static str, i64, i64, i64), String> {
    let mut m = mgr().lock().await;
    m.require_client()?;
    m.verify_current_page().await?;
    let jpeg = format == "jpeg";
    let mut params = json!({ "format": if jpeg { "jpeg" } else { "png" }, "fromSurface": true });
    if jpeg {
        params["quality"] = json!(quality.min(100));
    }
    let result = m.require_client()?.send("Page.captureScreenshot", params, 15_000).await?;
    let data = result.get("data").and_then(|v| v.as_str()).ok_or("screenshot kosong")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    let layout = m.require_client()?.send("Page.getLayoutMetrics", json!({}), 10_000).await.unwrap_or(json!({}));
    let vp = layout.get("cssLayoutViewport");
    let w = vp.and_then(|v| v.get("clientWidth")).and_then(|v| v.as_f64()).unwrap_or(0.0).round() as i64;
    let h = vp.and_then(|v| v.get("clientHeight")).and_then(|v| v.as_f64()).unwrap_or(0.0).round() as i64;
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    Ok((bytes, if jpeg { "image/jpeg" } else { "image/png" }, w, h, ts))
}

/// Jalankan ekspresi JS di halaman aktif (Runtime.evaluate, returnByValue +
/// awaitPromise). Return objek `result` CDP (nilai di `.value`); error JS
/// jadi Err. Dipakai jalur motion-vision untuk mengendalikan halaman harness.
pub async fn evaluate(expression: &str) -> Result<Value, String> {
    let m = mgr().lock().await;
    let result = m.require_client()?.send(
        "Runtime.evaluate",
        json!({ "expression": expression, "returnByValue": true, "awaitPromise": true, "silent": true }),
        60_000,
    ).await?;
    if let Some(desc) = result.pointer("/exceptionDetails/exception/description").and_then(|v| v.as_str()) {
        return Err(format!("JS error: {desc}"));
    }
    if let Some(desc) = result.pointer("/exceptionDetails/text").and_then(|v| v.as_str()) {
        return Err(format!("JS error: {desc}"));
    }
    Ok(result.get("result").cloned().unwrap_or(Value::Null))
}

pub async fn focus() -> bool {
    let m = mgr().lock().await;
    let pid = match m.process.as_ref().map(|p| p.id()) {
        Some(pid) => pid,
        None => return false,
    };
    if !cfg!(windows) {
        return false;
    }
    drop(m);
    let cmd = format!(
        "$p=Get-Process -Id {pid} -ErrorAction Stop;Add-Type -Name W -Namespace P -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);';if($p.MainWindowHandle -eq 0){{exit 2}}; if([P.W]::SetForegroundWindow($p.MainWindowHandle)){{exit 0}}else{{exit 3}}"
    );
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Matikan browser terkontrol (CDP + proses + grant sesi).
async fn shutdown(m: &mut BrowserManager) {
    if let Some(c) = m.client.take() {
        c.close().await;
    }
    m.reset(None);
    m.launched = false; // tutup sengaja — jangan di-auto-relaunch
    m.grants.revoke_all();
}

pub async fn close() {
    let mut m = mgr().lock().await;
    shutdown(&mut m).await;
}

/// {captcha, captchaHint} bila captcha masih terdeteksi di halaman aktif,
/// selain itu null — ditempelkan ke hasil tool click/type agar agent tidak
/// mencoba berinteraksi dengan captcha.
pub async fn captcha_note() -> Value {
    let m = mgr().lock().await;
    match &m.captcha {
        Some(k) => json!({ "captcha": k, "captchaHint": CAPTCHA_HINT }),
        None => Value::Null,
    }
}

// ── Jalur tool agent (dipanggil loop assistant) ─────────────────────────────
const DEFAULT_URL: &str = "https://example.com";
const MAX_INSPECT_CHARS: usize = 3500;

/// Eksekusi tool browser_* dari loop agent. Return JSON string (atau ERROR: …).
pub async fn agent_exec(root: &Path, name: &str, args: &Value) -> String {
    // Browser ditutup user di tengah task → buka ulang otomatis sebelum
    // tool jalan. KHUSUS `browser_open`: justru tugasknya MEMBUKA browser
    // bila belum ada — guard di sini malah menutup pintunya (bug 2026-10-06:
    // "browser CDP terputus" setiap task). status/close juga tak butuh.
    if !matches!(name, "browser_status" | "browser_close" | "browser_open") {
        if let Err(e) = ensure_alive(root).await {
            return format!("ERROR: {e}");
        }
    }
    let sreq = |k: &str| -> Result<String, String> {
        let v = args.get(k).and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        if v.is_empty() { Err(format!("{k} wajib diisi")) } else { Ok(v) }
    };
    let out: Result<String, String> = match name {
        "browser_status" => Ok(status(root).await.to_string()),
        "browser_open" => {
            let url = args.get("url").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty()).unwrap_or(DEFAULT_URL);
            open(root, url, false).await.map(|v| v.to_string())
        }
        "browser_navigate" => match sreq("url") {
            Ok(u) => navigate(&u).await.map(|v| v.to_string()),
            Err(e) => Err(e),
        },
        "browser_inspect" => {
            let cursor = args.get("cursor").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let max = args.get("maxChars").and_then(|v| v.as_u64()).map(|n| (n as usize).clamp(1, MAX_INSPECT_CHARS)).unwrap_or(MAX_INSPECT_CHARS);
            let sid = args.get("snapshotId").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
            inspect(cursor, max, sid).await.map(|v| v.to_string())
        }
        "browser_click" => match (sreq("snapshotId"), sreq("ref")) {
            (Ok(s), Ok(r)) => {
                let note = captcha_note().await;
                click(&s, &r).await.map(|_| {
                    let mut v = json!({ "ok": true, "snapshotId": s, "ref": r });
                    if let Some(k) = note.get("captcha") { v["captcha"] = k.clone(); v["captchaHint"] = note["captchaHint"].clone(); }
                    v.to_string()
                })
            }
            (Err(e), _) | (_, Err(e)) => Err(e),
        },
        "browser_type" => match (sreq("snapshotId"), sreq("ref")) {
            (Ok(s), Ok(r)) => {
                let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
                let submit = args.get("submit").and_then(|v| v.as_bool()).unwrap_or(false);
                let note = captcha_note().await;
                type_text(&s, &r, text, submit).await.map(|_| {
                    let mut v = json!({ "ok": true, "snapshotId": s, "ref": r, "chars": text.chars().count(), "submit": submit });
                    if let Some(k) = note.get("captcha") { v["captcha"] = k.clone(); v["captchaHint"] = note["captchaHint"].clone(); }
                    v.to_string()
                })
            }
            (Err(e), _) | (_, Err(e)) => Err(e),
        },
        "browser_history" => match sreq("action") {
            Ok(a) => history(&a).await.map(|_| json!({ "ok": true, "action": a }).to_string()),
            Err(e) => Err(e),
        },
        "browser_close" => {
            close().await;
            Ok(json!({ "ok": true }).to_string())
        }
        "browser_grant_private" => match sreq("origin") {
            Ok(o) => grant_private_origin(&o).await.map(|origin| json!({ "ok": true, "origin": origin }).to_string()),
            Err(e) => Err(e),
        },
        other => Err(format!("tool browser tidak dikenal: {other}")),
    };
    match out {
        Ok(s) => s,
        Err(e) => if e.starts_with("ERROR") { e } else { format!("ERROR: {e}") },
    }
}

/// Redaksi arg publik untuk browser_type (jangan bocorkan teks ketikan).
pub fn public_args(name: &str, args: &Value) -> Value {
    if name == "browser_type" {
        return json!({
            "snapshotId": args.get("snapshotId").and_then(|v| v.as_str()).unwrap_or(""),
            "ref": args.get("ref").and_then(|v| v.as_str()).unwrap_or(""),
            "chars": args.get("text").and_then(|v| v.as_str()).map(|s| s.chars().count()).unwrap_or(0),
            "submit": args.get("submit").and_then(|v| v.as_bool()).unwrap_or(false),
        });
    }
    args.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::policy::normalize_browser_url;

    #[test]
    fn pilih_target_page() {
        let t = |typ: &str, url: &str, ws: bool| json!({
            "type": typ, "url": url,
            "webSocketDebuggerUrl": if ws { json!("ws://x") } else { Value::Null },
        });
        // tanpa kandidat page → None
        assert!(choose_page_target(&[t("other", "x", true)]).is_none());
        // page tanpa webSocketDebuggerUrl diabaikan
        assert!(choose_page_target(&[t("page", "about:blank", false)]).is_none());
        // about:blank menang walau datang belakangan
        let targets = vec![t("page", "https://a.test", true), t("page", "about:blank", true)];
        assert_eq!(choose_page_target(&targets).unwrap()["url"], "about:blank");
        // tanpa about:blank → page pertama
        let targets = vec![t("page", "https://a.test", true), t("page", "https://b.test", true)];
        assert_eq!(choose_page_target(&targets).unwrap()["url"], "https://a.test");
    }

    #[test]
    fn engine_dari_nama_exe() {
        assert_eq!(engine_of(&Some(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe".into())), Some("edge"));
        assert_eq!(engine_of(&Some("google-chrome-stable".into())), Some("chrome"));
        assert_eq!(engine_of(&Some("firefox".into())), None);
        assert_eq!(engine_of(&None), None);
    }

    #[test]
    fn kandidat_engine_sesuai_pref() {
        let edge = chromium_candidates("edge");
        assert!(!edge.is_empty());
        assert!(edge.iter().all(|p| p.to_lowercase().contains("edge")));
        let chrome = chromium_candidates("chrome");
        assert!(!chrome.is_empty());
        assert!(chrome.iter().all(|p| p.to_lowercase().contains("chrome")));
        // auto menyertakan kedua kelompok (urutan tergantung default Windows).
        let auto = chromium_candidates("auto");
        assert!(auto.iter().any(|p| p.to_lowercase().contains("edge")));
        assert!(auto.iter().any(|p| p.to_lowercase().contains("chrome")));
        assert_eq!(auto.len(), edge.len() + chrome.len());
        // pref tidak dikenal diperlakukan seperti auto.
        assert_eq!(chromium_candidates("aneh"), auto);
    }

    #[test]
    fn deteksi_captcha_dari_teks_halaman() {
        assert_eq!(detect_captcha("https://x.test halo dunia selamat datang"), None);
        assert_eq!(detect_captcha("protected by reCAPTCHA Privasi Persyaratan"), Some("reCAPTCHA"));
        assert_eq!(detect_captcha("Please complete the hCaptcha verification"), Some("hCaptcha"));
        assert_eq!(detect_captcha("https://challenges.cloudflare.com/turnstile/v0/api.js Just a moment..."), Some("Cloudflare"));
        assert_eq!(detect_captcha("VERIFY YOU ARE HUMAN to continue"), Some("Cloudflare"));
        assert_eq!(detect_captcha("silakan isi captcha di bawah ini"), Some("captcha"));
    }

    #[test]
    fn gate_privat_menyebut_origin_dan_langkah() {
        let g = OriginGrants::default();
        let publik = normalize_browser_url("https://example.com");
        assert!(gate_privat(&publik, &g).is_ok());
        let privat = normalize_browser_url("http://192.168.1.5");
        let e = gate_privat(&privat, &g).unwrap_err();
        assert!(e.contains("192.168.1.5"), "{e}");
        assert!(e.contains("browser_grant_private"), "{e}");
        g.grant(privat.origin.as_deref().unwrap());
        assert!(gate_privat(&privat, &g).is_ok());
    }

    #[test]
    fn host_dari_url_mentah() {
        assert_eq!(host_dari("https://news.google.com/home?hl=id"), "news.google.com");
        assert_eq!(host_dari("http://192.168.1.5:8080/x"), "192.168.1.5");
        assert_eq!(host_dari("chrome-error://chromewebdata"), "chromewebdata");
        assert_eq!(host_dari("bukan url"), "");
    }

    #[test]
    fn error_navigasi_diterjemahkan_jujur() {
        let m = jelaskan_error_navigasi("net::ERR_NAME_NOT_RESOLVED", "news.google.com");
        assert!(m.contains("DNS"), "{m}");
        assert!(m.contains("news.google.com"), "{m}");
        assert!(m.contains("[net::ERR_NAME_NOT_RESOLVED]"), "{m}");
        assert!(jelaskan_error_navigasi("net::ERR_INTERNET_DISCONNECTED", "x").contains("tidak terhubung"));
        assert!(jelaskan_error_navigasi("net::ERR_CONNECTION_TIMED_OUT", "x.test").contains("timeout"));
        assert!(jelaskan_error_navigasi("net::ERR_CERT_AUTHORITY_INVALID", "x").contains("sertifikat"));
        assert!(jelaskan_error_navigasi("net::ERR_ANEH_SEKALI", "x").contains("gagal memuat"));
    }

    #[test]
    fn pref_engine_dari_config() {
        let dir = std::env::temp_dir().join(format!("l2dbrpref-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("data")).unwrap();
        let cfg = dir.join("data").join("config.json");
        std::fs::write(&cfg, r#"{"browser":{"engine":"chrome"}}"#).unwrap();
        assert_eq!(engine_pref_from_config(&dir), "chrome");
        std::fs::write(&cfg, r#"{"browser":{"engine":"firefox"}}"#).unwrap();
        assert_eq!(engine_pref_from_config(&dir), "auto");
        std::fs::remove_file(&cfg).unwrap();
        assert_eq!(engine_pref_from_config(&dir), "auto");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn arg_publik_meredaksi_teks_ketikan() {
        // kontrak kartu approval: browser_type TIDAK pernah membocorkan teks.
        let red = public_args("browser_type", &json!({ "snapshotId": "s1", "ref": "r2", "text": "rahasia!", "submit": true }));
        assert_eq!(red, json!({ "snapshotId": "s1", "ref": "r2", "chars": 8, "submit": true }));
        assert!(red.get("text").is_none());
        // tool lain lolos utuh
        assert_eq!(public_args("browser_click", &json!({ "ref": "r1" })), json!({ "ref": "r1" }));
    }

    // Bantu: spawn proses pendek yang sudah exit (lintas platform minim).
    fn spawn_exited_child() -> std::process::Child {
        let mut c = if cfg!(windows) {
            std::process::Command::new("cmd").args(["/c", "exit 0"]).spawn().expect("spawn")
        } else {
            std::process::Command::new("true").spawn().expect("spawn")
        };
        let _ = c.wait();
        c
    }

    #[tokio::test]
    async fn proses_mati_direap_state_direset() {
        let mut m = BrowserManager::default();
        m.process = Some(spawn_exited_child());
        assert!(m.reap_if_dead(), "proses exit → direap");
        assert!(m.process.is_none(), "bangkai dibuang");
        assert_eq!(
            m.last_error.as_deref(),
            Some("browser ditutup dari luar — dibuka ulang otomatis")
        );
        // reap kedua: tak ada bangkai → false.
        assert!(!m.reap_if_dead());
    }

    #[tokio::test]
    async fn proses_hidup_tidak_direap() {
        let mut m = BrowserManager::default();
        let child = if cfg!(windows) {
            std::process::Command::new("cmd").args(["/c", "timeout /t 30"]).spawn().expect("spawn")
        } else {
            std::process::Command::new("sleep").arg("30").spawn().expect("spawn")
        };
        m.process = Some(child);
        assert!(!m.reap_if_dead(), "proses hidup → tidak direap");
        assert!(m.process.is_some());
        if let Some(p) = m.process.as_mut() {
            let _ = p.kill();
            let _ = p.wait();
        }
    }

    #[tokio::test]
    async fn ensure_alive_tanpa_browser_tanpa_root_tetap_error_jelas() {
        let mut m = BrowserManager::default();
        let err = match m.ensure_alive().await {
            Err(e) => e,
            Ok(_) => panic!("tanpa browser harusnya error"),
        };
        assert!(err.contains("browser belum terbuka"), "malah: {err}");
    }

    #[tokio::test]
    async fn orphan_sudah_direap_tetap_dicoba_relaunch() {
        // Skenario: status() mereap bangkai lebih dulu (process=None) — flag
        // `launched` membedakannya dari "belum pernah buka". Jangan spawn
        // browser asli di unit test: executable palsu → gagal di spawn dengan
        // pesan "gagal meluncurkan", BUKAN "belum terbuka" (bukti jalur
        // re-launch benar-benar dicoba).
        let root = std::env::temp_dir().join("wb-orphan-test");
        let mut m = BrowserManager::default();
        m.launched = true; // pernah jalan, kini process+client sudah direap
        m.root = Some(root.clone());
        m.executable = Some("Z:/tidak-ada/browser-palsu.exe".into());
        let err = match m.ensure_alive().await {
            Err(e) => e,
            Ok(_) => panic!("exe palsu tidak mungkin berhasil launch"),
        };
        assert!(
            err.contains("gagal meluncurkan"),
            "harusnya sampai tahap spawn — malah: {err}"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// Jalur agent nyata: browser_open lewat agent_exec HARUS bisa membuka
    /// browser dari nol (guard ensure_alive TIDAK boleh menutup pintunya —
    /// bug 2026-10-06). Launch browser sungguhan → tandai #[ignore], jalankan
    /// manual: `cargo test -p live2d-core browser_open_via_agent -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn browser_open_via_agent_exec_dari_nol() {
        let root = std::env::temp_dir().join("wb-agent-open-test");
        std::fs::create_dir_all(&root).unwrap();
        let out = agent_exec(&root, "browser_open", &serde_json::json!({ "url": "http://example.com" })).await;
        assert!(!out.starts_with("ERROR"), "browser_open gagal: {out}");
        assert!(out.contains("\"running\":true"), "browser tidak jalan: {out}");
        let out2 = agent_exec(&root, "browser_close", &serde_json::json!({})).await;
        assert!(out2.contains("\"ok\":true"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn tutup_sengaja_tidak_autorelaunch() {
        // close()/set_engine (shutdown) menandai launched=false — navigate
        // setelahnya harus error "belum terbuka", bukan membuka ulang.
        let mut m = BrowserManager::default();
        m.launched = false;
        m.root = Some(std::env::temp_dir().join("wb-orphan-test"));
        let err = match m.ensure_alive().await {
            Err(e) => e,
            Ok(_) => panic!("tutup sengaja tidak boleh di-auto-relaunch"),
        };
        assert!(err.contains("belum terbuka"), "malah: {err}");
    }
}
