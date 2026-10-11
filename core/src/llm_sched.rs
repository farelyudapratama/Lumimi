//! Scheduler panggilan LLM: retry otomatis, backoff + jitter, hormati
//! Retry-After, deadline per panggilan, antrean berbatas per koneksi, dan
//! pembatalan. Dipakai `llm::llm_for_role_tools`.
//!
//! Prinsip: retry HANYA untuk error sementara (`is_transient` / 429 / 5xx).
//! Error permanen (auth, kuota keras, format) langsung gagal. Streaming yang
//! sudah mengirim sebagian teks ke user TIDAK pernah diulang diam-diam —
//! itu tanggung jawab pemanggil streaming.

use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::{watch, Semaphore};

/// Maksimum percobaan per panggilan (termasuk percobaan pertama).
pub const MAX_ATTEMPTS: u32 = 20;
/// Backoff dasar; dikali 2^n dan dibatasi `BACKOFF_CAP_MS`.
const BACKOFF_BASE_MS: u64 = 500;
const BACKOFF_CAP_MS: u64 = 30_000;
/// Deadline keseluruhan satu panggilan (semua percobaan + tunggu).
pub const DEFAULT_DEADLINE_MS: u64 = 5 * 60 * 1000;
/// Koneksi yang langsung ditolak (server mati, port tertutup) tidak layak
/// dicoba puluhan kali; cukup beberapa kali lalu pindah ke kandidat lain.
pub const REFUSED_MAX_ATTEMPTS: u32 = 3;
/// Paralel per koneksi dan antrean maksimum yang boleh menumpuk.
const PER_CONN_CONCURRENCY: usize = 4;
const MAX_QUEUE_PER_CONN: usize = 32;

/// Jitter penuh: waktu tunggu acak di [0, backoff]. Sumber acak dari
/// jam sistem (nanodetik) + penghitung — cukup untuk menyebar retry, tanpa
/// dependensi RNG.
pub fn jitter(backoff_ms: u64, salt: u64) -> u64 {
    if backoff_ms == 0 {
        return 0;
    }
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos() as u64).unwrap_or(0);
    let mut x = nanos ^ salt.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    x ^= x >> 33;
    x = x.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    x ^= x >> 33;
    x % (backoff_ms + 1)
}

/// Backoff eksponensial untuk percobaan ke-`attempt` (mulai dari 1), dengan
/// jitter penuh. Tidak pernah melewati `BACKOFF_CAP_MS`.
pub fn backoff_ms(attempt: u32, salt: u64) -> u64 {
    let shift = attempt.saturating_sub(1).min(16);
    let raw = BACKOFF_BASE_MS.saturating_mul(1u64 << shift).min(BACKOFF_CAP_MS);
    jitter(raw, salt)
}

/// Parse header `Retry-After`: angka detik, atau tanggal HTTP (RFC 7231).
/// Mengembalikan milidetik. Nilai tak terbaca → None.
pub fn parse_retry_after(value: &str, now_ms: u128) -> Option<u64> {
    let v = value.trim();
    if let Ok(secs) = v.parse::<f64>() {
        if secs.is_finite() && secs >= 0.0 {
            return Some((secs * 1000.0) as u64);
        }
        return None;
    }
    // Tanggal HTTP: "Wed, 21 Oct 2015 07:28:00 GMT" → selisih dari sekarang.
    let target = httpdate_to_ms(v)?;
    Some(target.saturating_sub(now_ms) as u64)
}

/// Parser tanggal HTTP sempit (format IMF-fixdate). Tidak mendukung format
/// usang; cukup untuk header yang dikirim provider modern.
fn httpdate_to_ms(s: &str) -> Option<u128> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() != 6 || parts[5] != "GMT" {
        return None;
    }
    let day: i64 = parts[1].parse().ok()?;
    let month = match parts[2] {
        "Jan" => 1, "Feb" => 2, "Mar" => 3, "Apr" => 4, "May" => 5, "Jun" => 6,
        "Jul" => 7, "Aug" => 8, "Sep" => 9, "Oct" => 10, "Nov" => 11, "Dec" => 12,
        _ => return None,
    };
    let year: i64 = parts[3].parse().ok()?;
    let hms: Vec<&str> = parts[4].split(':').collect();
    if hms.len() != 3 {
        return None;
    }
    let (h, m, sec): (i64, i64, i64) = (hms[0].parse().ok()?, hms[1].parse().ok()?, hms[2].parse().ok()?);
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + h * 3600 + m * 60 + sec;
    if secs < 0 {
        return None;
    }
    Some(secs as u128 * 1000)
}

/// Hari sejak 1970-01-01 untuk tanggal kalender (algoritma Howard Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Keputusan retry untuk satu kegagalan. `retry_after_ms` dari header bila ada.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Coba lagi setelah `wait_ms` milidetik.
    RetryAfter(u64),
    /// Menyerah: error permanen atau percobaan habis.
    GiveUp,
}

/// Putuskan apakah satu kegagalan layak di-retry. `attempt` = percobaan yang
/// baru saja gagal (mulai dari 1). `transient` dari `llm::is_transient`.
pub fn decide(attempt: u32, transient: bool, retry_after_ms: Option<u64>, salt: u64) -> Decision {
    decide_with_cap(attempt, transient, retry_after_ms, salt, MAX_ATTEMPTS)
}

/// Sama seperti `decide`, dengan batas percobaan khusus (mis. koneksi yang
/// ditolak total hanya layak beberapa kali, bukan 20).
pub fn decide_with_cap(attempt: u32, transient: bool, retry_after_ms: Option<u64>, salt: u64, cap: u32) -> Decision {
    if !transient || attempt >= cap {
        return Decision::GiveUp;
    }
    let wait = match retry_after_ms {
        // Hormati Retry-After, tetapi jangan menunggu lebih lama dari batas.
        Some(ra) => ra.min(BACKOFF_CAP_MS * 4),
        None => backoff_ms(attempt, salt),
    };
    Decision::RetryAfter(wait)
}

/// Batas paralel + antrean per koneksi. Permit dipegang selama satu panggilan.
pub struct ConnGate {
    sem: Semaphore,
    queued: std::sync::atomic::AtomicUsize,
}

impl ConnGate {
    fn new() -> Self {
        Self {
            sem: Semaphore::new(PER_CONN_CONCURRENCY),
            queued: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

static GATES: OnceLock<std::sync::Mutex<std::collections::HashMap<String, &'static ConnGate>>> = OnceLock::new();

/// Gerbang untuk satu koneksi (dibuat sekali, hidup selama proses).
pub fn gate_for(conn_id: &str) -> &'static ConnGate {
    let map = GATES.get_or_init(|| std::sync::Mutex::new(Default::default()));
    let mut m = map.lock().unwrap_or_else(|e| e.into_inner());
    m.entry(conn_id.to_string()).or_insert_with(|| Box::leak(Box::new(ConnGate::new())))
}

/// Gagal jika antrean penuh; kalau tidak, menunggu giliran (atau dibatalkan).
pub enum Admit<'a> {
    Permit(tokio::sync::SemaphorePermit<'a>),
    Full,
    Cancelled,
}

pub async fn admit<'a>(gate: &'a ConnGate, cancel: &mut watch::Receiver<bool>) -> Admit<'a> {
    use std::sync::atomic::Ordering;
    let q = gate.queued.fetch_add(1, Ordering::SeqCst);
    if q >= MAX_QUEUE_PER_CONN {
        gate.queued.fetch_sub(1, Ordering::SeqCst);
        return Admit::Full;
    }
    let out = tokio::select! {
        p = gate.sem.acquire() => match p {
            Ok(p) => Admit::Permit(p),
            Err(_) => Admit::Cancelled,
        },
        _ = wait_cancel(cancel) => Admit::Cancelled,
    };
    gate.queued.fetch_sub(1, Ordering::SeqCst);
    out
}

/// Resolve bila token dibatalkan (nilai `true`).
pub async fn wait_cancel(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            // Pengirim sudah dibuang: anggap tidak dibatalkan, jangan spin.
            std::future::pending::<()>().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_naik_dan_dibatasi() {
        // Tanpa jitter (sampling batas atas): kita cek batas maksimum saja.
        for a in 1..=20 {
            assert!(backoff_ms(a, 7) <= BACKOFF_CAP_MS);
        }
        assert!(jitter(1000, 3) <= 1000);
        assert_eq!(jitter(0, 3), 0);
    }

    #[test]
    fn retry_after_angka_dan_tanggal() {
        assert_eq!(parse_retry_after("2", 0), Some(2000));
        assert_eq!(parse_retry_after("0.5", 0), Some(500));
        assert_eq!(parse_retry_after("abc", 0), None);
        // 1970-01-01 00:00:10 GMT, sekarang = 0 → tunggu 10 detik.
        assert_eq!(parse_retry_after("Thu, 01 Jan 1970 00:00:10 GMT", 0), Some(10_000));
        // Tanggal sudah lewat → 0.
        assert_eq!(parse_retry_after("Thu, 01 Jan 1970 00:00:10 GMT", 99_000), Some(0));
    }

    #[test]
    fn keputusan_retry_sesuai_kebijakan() {
        assert_eq!(decide(1, false, None, 1), Decision::GiveUp);
        assert_eq!(decide(MAX_ATTEMPTS, true, None, 1), Decision::GiveUp);
        assert_eq!(decide(1, true, Some(3000), 1), Decision::RetryAfter(3000));
        // Retry-After raksasa tidak boleh menahan lebih dari batas.
        assert_eq!(decide(1, true, Some(10_000_000), 1), Decision::RetryAfter(BACKOFF_CAP_MS * 4));
        assert!(matches!(decide(2, true, None, 1), Decision::RetryAfter(w) if w <= BACKOFF_CAP_MS));
    }

    #[tokio::test]
    async fn antrean_penuh_menolak_dan_pembatalan_membebaskan_tunggu() {
        let gate = ConnGate::new();
        let (keep, mut rx) = watch::channel(false);
        // Pegang semua permit paralel, lalu permintaan berikutnya harus menunggu.
        let mut held = Vec::new();
        for _ in 0..PER_CONN_CONCURRENCY {
            match admit(&gate, &mut rx).await {
                Admit::Permit(p) => held.push(p),
                _ => panic!("permit awal harus didapat"),
            }
        }
        // Batalkan saat menunggu → Cancelled, bukan menggantung selamanya.
        let waiter = {
            let mut rx2 = rx.clone();
            let g = &gate;
            async move { admit(g, &mut rx2).await }
        };
        let canceller = async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let _ = keep.send(true);
        };
        let (res, _) = tokio::join!(waiter, canceller);
        assert!(matches!(res, Admit::Cancelled));
        drop(held);
    }

    #[tokio::test]
    async fn antrean_melebihi_batas_langsung_penuh() {
        let gate = ConnGate::new();
        gate.queued.store(MAX_QUEUE_PER_CONN, std::sync::atomic::Ordering::SeqCst);
        let (_keep, mut rx) = watch::channel(false);
        assert!(matches!(admit(&gate, &mut rx).await, Admit::Full));
    }

    #[test]
    fn tanggal_hari_konsisten() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
    }
}
