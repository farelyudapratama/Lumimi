//! pet_native.rs — indra kursor NATIVE untuk jendela pet.
//!
//! Saat klik-tembus menyala, WebView TIDAK menerima event mouse sama sekali
//! (klik menembus ke desktop), jadi pet butuh posisi kursor global dari OS.
//! Thread sense menyampel `GetCursorPos` + `GetAsyncKeyState(VK_LBUTTON)`
//! tiap ~40 ms lalu PUSH event `pet://cursor` ke webview "pet" (koordinat
//! FISIK layar; konversi ke CSS px dilakukan frontend pakai outerPosition +
//! scaleFactor — tahu sendiri, tanpa IPC balik).
//!
//! Ini stream INPUT, bukan render loop — aturan "render/per-frame tak pernah
//! lewat IPC" di ARCHITECTURE-TAURI-RUST.md tetap berdiri: yang dikirim cuma
//! posisi kursor; semua gerak/param tetap 100% lokal di webview.
//!
//! Siklus hidup: thread dinyalakan dari `build_pet_window` (idempoten) dan
//! bunuh diri saat jendela pet tidak ada lagi — tanpa command arm/disarm.
//!
//! FFI langsung user32 (tanpa crate `windows`): fungsi yang dipakai cuma dua
//! dan shell sengaja dijaga kecil — polanya sama dengan fallback PowerShell
//! `SetWindowPos` di core/src/pet.rs (P/Invoke daripada menambah dependensi).

/// Repr POINT Win32 (minimal — hanya bidang yang dibaca).
#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[link(name = "user32")]
extern "system" {
    fn GetCursorPos(lp_point: *mut Point) -> i32;
    fn GetAsyncKeyState(v_key: i32) -> i16;
}

const VK_LBUTTON: i32 = 0x01;
const SENSE_INTERVAL_MS: u64 = 40;

use std::sync::Mutex;
use std::sync::OnceLock;

use tauri::Manager;

fn sense_handle() -> &'static Mutex<Option<std::thread::JoinHandle<()>>> {
    static H: OnceLock<Mutex<Option<std::thread::JoinHandle<()>>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(None))
}

/// Pastikan thread sense hidup (idempoten — handle lama yang masih jalan
/// membuat panggilan berikutnya no-op). Dipanggil `build_pet_window`.
pub fn ensure_sense_thread(app: tauri::AppHandle) {
    let mut guard = sense_handle().lock().unwrap();
    if let Some(h) = guard.as_ref() {
        if !h.is_finished() {
            return;
        }
    }
    let spawned = std::thread::Builder::new()
        .name("pet-sense".into())
        .spawn(move || sense_loop(app));
    // Ganti handle mati dengan yang baru; gagal spawn (jarang) → pet tetap
    // jalan, cuma tanpa indra kursor native.
    if let Ok(h) = spawned {
        *guard = Some(h);
    }
}

fn sense_loop(app: tauri::AppHandle) {
    let mut last: (i32, i32, bool) = (i32::MIN, i32::MIN, false);
    loop {
        std::thread::sleep(std::time::Duration::from_millis(SENSE_INTERVAL_MS));
        // Jendela pet sudah tidak ada → bunuh diri (dinyalakan lagi oleh
        // build_pet_window di launch berikutnya).
        if app.get_webview_window("pet").is_none() {
            break;
        }
        let mut p = Point { x: 0, y: 0 };
        let ok = unsafe { GetCursorPos(&mut p) } != 0;
        let down = ok && unsafe { GetAsyncKeyState(VK_LBUTTON) } < 0;
        let cur = (p.x, p.y, down);
        if !ok || cur == last {
            continue; // tak ada perubahan — jangan banjir webview
        }
        last = cur;
        use tauri::Emitter;
        let _ = app.emit_to(
            "pet",
            "pet://cursor",
            serde_json::json!({ "x": p.x, "y": p.y, "down": down }),
        );
    }
}

/// Toggle "tak mencuri fokus" jendela pet (`set_focusable` Tauri 2 = backend
/// WS_EX_NOACTIVATE di Windows). Saat ON, menyentuh/mengklik/menggeser pet
/// TIDAK memindah fokus keyboard dari aplikasi yang sedang dipakai user —
/// perilaku desktop-pet sejati. Konsekuensi: Esc di pet tidak menerima
/// keyboard tanpa fokus; tombol Tutup di bar tetap berfungsi (window
/// tak-berfokus tetap menerima klik mouse).
pub fn no_activate(app: &tauri::AppHandle, on: bool) -> bool {
    match app.get_webview_window("pet") {
        Some(w) => w.set_focusable(!on).is_ok(),
        None => false,
    }
}
