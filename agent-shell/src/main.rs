// Cangkang jendela Lumimi — SATU exe, SATU proses.
//
//   Lumimi.exe [main <url>|<url>] → jendela utama (port dari URL eksplisit
//                                     atau dipilih sendiri).
//   Dobel-klik exe = semuanya nyala: server HTTP Rust (live2d-core) berjalan
// IN-PROCESS di thread runtime tokio sendiri — jendela WebView me-load
// loopback yang dilayani proses ini juga. Tak ada exe kedua, tak ada sidecar.
//
// Jendela PET (overlay transparan selalu-di-atas) adalah window Tauri KEDUA
// dalam proses yang SAMA — dibuka/tutup lewat /api/pet/* (server in-process
// memanggil balik pembuka yang didaftarkan di setup). Tak ada lagi mode
// proses-pet (`Lumimi.exe pet …`); argumen itu kini diabaikan (jendela
// utama yang dibuka, pet via panel).
//
// URL diterima dari argumen supaya ikut PORT yang sebenarnya. Sebelum jendela
// menunggu port server terbuka (maks 15 dtk): Lumimi.exe menyalakan shell dan
// server hampir bersamaan, dan WebView tidak punya retry — tanpa menunggu,
// jendela bisa menampilkan halaman error. Kalau 15 dtk tidak cukup (mesin
// lambat / server gagal boot sesaat), jendela tetap dibuat dan thread
// pemulihan me-RELOAD begitu server terlihat — dulu halaman error WebView2
// nyangkut permanen padahal server lalu naik sendiri.
//
// Kenapa bukan Electron: WebView2 sudah menjadi bagian dari Windows 10/11,
// jadi binary-nya kecil dan RAM jendela ±40-90MB — tidak membawa Chromium
// sendiri seperti Electron.
//
// Port (peluncuran TANPA argumen URL — dobel-klik shortcut installer): port
// dasar 8310 dipakai bila kosong ATAU sudah dipakai server milik kita sendiri
// (probe handshake /api/version + token instalasi — dobel-klik kedua
// menempel ke instance pertama, tanpa
// server baru). Bila port diduduki aplikasi ASING, shell bergeser ke
// 8311..8399 — rentang ini HARUS sinkron dengan probe frontend
// (src/client/transport/index.ts, PROBE_FIRST..PROBE_LAST) supaya fallback
// probe frontend menemukan server yang pindah. URL argumen eksplisit
// (Lumimi.exe / pet yang diluncurkan server) selalu dihormati apa adanya.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Perintah IPC — frontend ter-embed (origin lokal) memanggil logika core
/// LANGSUNG dalam proses yang sama (tanpa HTTP). Tiap command adalah selubung
/// tipis di atas fungsi `live2d_core` (single source of truth — handler HTTP
/// di core memakai fungsi yang sama untuk adapter eksternal CLI/OBS/dev).
/// Render loop Live2D/PixiJS tetap 100% di WebView — tak ada IPC per-frame.
#[tauri::command]
fn core_version() -> String {
    live2d_core::VERSION.to_string()
}

/// Port loopback adapter HTTP eksternal (dipilih shell saat boot).
#[tauri::command]
fn server_port(port: tauri::State<u16>) -> u16 {
    *port
}

/// Token handshake instalasi (live2d_core::instance_token) — frontend
/// memverifikasi bahwa port yang dihubungi benar server milik instalasi ini
/// sebelum memakainya (lihat transport/index.ts + pet.html).
#[tauri::command]
fn server_token(token: tauri::State<String>) -> String {
    token.inner().clone()
}

/// Model awal jendela pet (?model= dari peluncur, via State karena URL App
/// tak membawa query). Dipakai pet.html setelah qs (dev browser) kosong.
#[tauri::command]
fn pet_model(model: tauri::State<Option<String>>) -> Option<String> {
    model.inner().clone()
}

/// GET /api/mode versi IPC (domain pertama yang migrasi penuh).
#[tauri::command]
fn get_mode() -> serde_json::Value {
    live2d_core::mode::status()
}

/// POST /api/mode versi IPC — satu-satunya pintu pindah mode (MODES.md).
#[tauri::command]
fn set_mode(mode: String) -> Result<serde_json::Value, String> {
    let (status, out) = live2d_core::mode::set_mode(&serde_json::json!({ "mode": mode }));
    if status < 400 {
        Ok(out)
    } else {
        Err(out
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("gagal ganti mode")
            .to_string())
    }
}

/// Import model lewat dialog folder NATIVE (domain model-import). Dialog
/// dibuka rfd di thread blocking (jangan tahan runtime async); penyalinan
/// folder dilakukan `live2d_core::model::import_model_folder` langsung di
/// disk — TANPA upload base64 lewat WebView (folder model ber-tekstur 4K
/// melampaui batas body HTTP dan WebView2 memutus koneksi: "Failed to
/// fetch"). `name` = preferensi nama dari kolom nama (kosong → stem file
/// *.model3.json).
#[tauri::command]
async fn import_model_dialog(name: Option<String>) -> Result<serde_json::Value, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new().pick_folder()
    })
    .await
    .map_err(|e| format!("dialog gagal: {e}"))?;
    let Some(src) = picked else {
        // User menutup dialog tanpa memilih — bukan error.
        return Ok(serde_json::json!({ "ok": false, "cancelled": true }));
    };
    let paths = live2d_core::paths::AppPaths::detect();
    let (status, out) = live2d_core::model::import_model_folder(
        &paths.model_dir,
        &paths.data_dir,
        &src,
        name.as_deref().unwrap_or(""),
    );
    let mut v: serde_json::Value =
        serde_json::from_str(&out).unwrap_or(serde_json::json!({ "ok": false }));
    if status >= 400 && v.get("ok").is_none() {
        v["ok"] = serde_json::json!(false);
    }
    Ok(v)
}

const FALLBACK_PORT: u16 = 8310;
/** Batas pemulihan: kalau server belum juga naik dalam 2 menit, menyerah —
 *  user tinggal menutup jendela dan menjalankan Lumimi.exe lagi. */
const RECOVER_SECS: u64 = 120;

struct Launch {
    /// URL eksplisit (Lumimi.exe / dev) — port-nya dihormati; HALAMAN selalu
    /// dari aset ter-embed (origin lokal → IPC hidup). Tanpa argumen → shell
    /// memilih port sendiri (pick_port). Argumen "pet" lama diabaikan: pet
    /// kini window kedua se-proses (via /api/pet/*), bukan proses terpisah.
    explicit_url: Option<String>,
}

fn parse_args() -> Launch {
    let rest: Vec<String> = std::env::args().skip(1).collect();
    let url = match rest.first().map(|s| s.as_str()) {
        Some("main") => rest.get(1).cloned(),
        Some(u) if u.starts_with("http") => Some(u.into()),
        _ => None,
    };
    Launch { explicit_url: url }
}

/// Bangun jendela pet (overlay desktop) di DALAM proses ini. Dipanggil lewat
/// bridge yang didaftarkan ke core (server in-process → AppHandle). Jendela
/// "pet" yang sudah ada dipakai ulang (tak ada duplikat).
fn build_pet_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("pet").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("pet.html".into()))
        .title("Lumimi Pet")
        .inner_size(420.0, 640.0)
        .position(40.0, 40.0)
        .decorations(false) // tanpa frame — murni overlay
        .transparent(true) // latar tembus pandang: karakter melayang
        .always_on_top(true) // native, tanpa trik PowerShell SetWindowPos
        .skip_taskbar(true) // pet bukan aplikasi biasa, jangan isi taskbar
        .resizable(false)
        .build()?;
    Ok(())
}

fn host_port_of(url: &str) -> String {
    url.split("//")
        .nth(1)
        .and_then(|h| h.split('/').next())
        .unwrap_or("127.0.0.1:8310")
        .to_string()
}

fn can_connect(host_port: &str) -> bool {
    TcpStream::connect(host_port).is_ok()
}

/// Apakah listener di host_port adalah server milik INSTALASI ini? Handshake
/// via /api/version: jawaban harus memuat `core_version` (bentuk khas Lumimi)
/// DAN token instance yang cocok — kunci `"active"` di /api/mode dulu
/// digunakan, tapi pola JSON semacam itu bisa dikejar server asing, dan yang
/// lebih penting: server milik INSTALASI Lumimi lain (portabel lama, dev
/// `cargo run`) juga memenuhinya padahal data & versinya berbeda. Token
/// (live2d_core::instance_token) deterministik per root app, jadi attach
/// dobel-klik pada instalasi yang sama tetap jalan, lintas-instalasi tidak.
fn is_our_server(host_port: &str, token: &str) -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = TcpStream::connect(host_port) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let req = format!("GET /api/version HTTP/1.0\r\nHost: {host_port}\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 2048];
    let n = stream.read(&mut buf).unwrap_or(0);
    let resp = String::from_utf8_lossy(&buf[..n]);
    resp.contains("HTTP/1")
        && resp.contains("core_version")
        && resp.contains(&format!("\"instance\":\"{token}\""))
}

/// Beri kesempatan kedua: server milik kita yang baru dinyalakan (boot <1 dtk)
/// mungkin belum sempat membalas saat probe pertama.
fn is_our_server_with_retry(host_port: &str, token: &str) -> bool {
    if is_our_server(host_port, token) {
        return true;
    }
    std::thread::sleep(Duration::from_millis(300));
    is_our_server(host_port, token)
}

/// Pilih port bila peluncuran tanpa argumen URL (dobel-klik shortcut):
///   1) port kosong → pakai (server in-process menyusul di ensure_server);
///   2) port berisi server MILIK INSTALASI INI (token cocok) → pakai,
///      menempel ke instance itu;
///   3) port diduduki aplikasi asing ATAU instalasi Lumimi lain → geser ke
///      kandidat berikutnya.
/// Semua kandidat gagal → kembali ke port dasar (perilaku lama).
fn pick_port(token: &str) -> u16 {
    const BASE_PORT: u16 = 8310;
    // 90 kandidat (8310..8399, sinkron dengan probe frontend di transport):
    // dulu 10 — hasil akhir kandidat habis adalah kembali ke port dasar yang
    // justru diduduki asing, dan exe mati total tanpa server. Dengan 90,
    // kehabisan hampir mustahil; port mati (mayoritas) lolos probe instan.
    const CANDIDATES: u16 = 90;
    for candidate in BASE_PORT..BASE_PORT + CANDIDATES {
        let hp = format!("127.0.0.1:{candidate}");
        if !can_connect(&hp) || is_our_server_with_retry(&hp, token) {
            return candidate;
        }
    }
    BASE_PORT
}

/// Pastikan ada server yang melayani `host_port`, dengan SATU PROSES sebagai
/// prioritas: bila port masih kosong, nyalakan server Rust IN-PROCESS (thread
/// runtime tokio sendiri, root path terdeteksi dari lokasi exe / cwd dev).
/// Bila port sudah dilayani server milik INSTALASI INI (token cocok — instance
/// lain / dev `cargo run` pada root yang sama), menempel saja tanpa server
/// baru. Bila diduduki aplikasi asing atau instalasi Lumimi lain, bukan urusan
/// kita — frontend pun punya handshake yang sama dan tidak akan bicara ke
/// sana (jendela menampilkan apa adanya, seperti dulu).
fn ensure_server(host_port: &str, port: u16, token: &str, paths: &live2d_core::paths::AppPaths) {
    if is_our_server_with_retry(host_port, token) {
        return;
    }
    if can_connect(host_port) {
        return;
    }
    eprintln!(
        "[shell] server Rust in-process — root={} port={port}",
        paths.root.display()
    );
    let paths = paths.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("gagal membuat runtime server");
        rt.block_on(async move {
            if let Err(e) = live2d_core::serve(port, paths).await {
                eprintln!("[shell] server gagal: {e}");
                std::process::exit(1);
            }
        });
    });
}

fn main() {
    let launch = parse_args();
    // Paths + token handshake dihitung SEKALI di sini: dipakai pick_port /
    // ensure_server (attach hanya ke server instalasi ini) dan disumbang ke
    // frontend lewat command `server_token` (verifikasi di transport/pet.html).
    let paths = live2d_core::paths::AppPaths::detect();
    let token = live2d_core::instance_token(&paths);
    // Port: dari URL eksplisit bila ada, else shell memilih sendiri.
    // HALAMAN selalu dari aset ter-embed (WebviewUrl::App → origin lokal →
    // IPC hidup). URL eksplisit hanya menyumbang PORT (+ ?model= pet).
    let port: u16 = match launch.explicit_url.as_deref() {
        Some(url) => host_port_of(url)
            .rsplit(':')
            .next()
            .and_then(|p| p.parse().ok())
            .unwrap_or(FALLBACK_PORT),
        None => pick_port(&token),
    };
    let host_port = format!("127.0.0.1:{port}");
    ensure_server(&host_port, port, &token, &paths);
    // Tunggu server bind (maks 15 dtk) SEBELUM jendela dibuat — kasus normal.
    let ready = {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if can_connect(&host_port) {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    };
    let label = "main";
    tauri::Builder::default()
        .manage(port)
        // Token handshake untuk verifikasi loopback di frontend (transport +
        // pet.html): port yang sama bisa saja diduduki server asing/instalasi
        // lain — tanpa token, frontend bisa bicara ke backend yang salah.
        .manage(token.clone())
        // Command pet_model dipertahankan (pet.html memanggilnya; selalu None
        // di jalur in-process — pet memakai daftar model dari server).
        .manage(None::<String>)
        .invoke_handler(tauri::generate_handler![
            core_version,
            server_port,
            server_token,
            pet_model,
            get_mode,
            set_mode,
            import_model_dialog
        ])
        .setup(move |app| {
            // Daftarkan pembuka/penutup pet in-process ke core (server yang
            // sama memanggilnya saat /api/pet/launch|close — satu PID).
            {
                let h = app.handle().clone();
                let opener = move || build_pet_window(&h).is_ok();
                let h2 = app.handle().clone();
                let closer = move || {
                    if let Some(w) = h2.get_webview_window("pet") {
                        let _ = w.destroy();
                    }
                };
                let _ = live2d_core::pet::register_pet_host(live2d_core::pet::PetHost {
                    open: Arc::new(opener),
                    close: Arc::new(closer),
                });
            }
            // Halaman dari aset ter-embed (frontendDist → binary) — origin
            // LOKAL, jadi command aplikasi diizinkan (temuan §6b tak berlaku).
            // Adapter HTTP loopback proses-sendiri tetap ada untuk CLI/OBS/dev
            // + domain yang belum migrasi IPC.
            let builder = WebviewWindowBuilder::new(
                app,
                label,
                WebviewUrl::App("index.html".into()),
            )
            .title("Lumimi");
            // Jendela utama: aplikasi biasa — berdekorasi, bisa diresize,
            // dibuka langsung maximize (permintaan user 2026-10-01).
            builder
                .inner_size(1280.0, 800.0)
                .min_inner_size(700.0, 520.0)
                .center()
                .maximized(true)
                .build()?;
            if !ready {
                // Server belum ada saat jendela dibuat → WebView menampilkan
                // halaman error. Pantau port dan reload begitu server naik.
                let handle = app.handle().clone();
                let label = label.to_string();
                std::thread::spawn(move || {
                    let deadline = Instant::now() + Duration::from_secs(RECOVER_SECS);
                    while Instant::now() < deadline {
                        if can_connect(&host_port) {
                            if let Some(w) = handle.get_webview_window(&label) {
                                let _ = w.eval("location.reload()");
                            }
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(1000));
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("gagal menjalankan shell")
        .run(|_app, event| {
            // Jendela pet in-process ditutup user (Esc/tombol) → sinkronkan
            // state core (padanan deteksi proses-mati jalur spawn).
            if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = &event {
                if label == "pet" {
                    live2d_core::pet::notify_closed();
                }
            }
        });
}
