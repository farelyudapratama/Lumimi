//! bus.rs — Event bus aktivitas agent.
//!
//! Loop menulis event kanonik di titik penting; konsumen:
//!   - Ring buffer ber-seq → GET /api/assistant/events (panel web / pet shell).
//!   - status().lastEvent (stage chip di panel).
//! Event ini ringkasan singkat untuk tampilan/akting — BUKAN full history agent.
//!
//! Global (satu runtime assistant aktif), sama seperti bus TS modul-level.

use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

const MAX_EVENTS: usize = 120;

#[derive(Clone)]
struct AgentEvent {
    seq: u64,
    kind: String,
    label: String,
    ts: i64,
}

struct BusState {
    events: Vec<AgentEvent>,
    seq: u64,
}

fn bus() -> &'static Mutex<BusState> {
    static B: OnceLock<Mutex<BusState>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(BusState { events: Vec::new(), seq: 0 }))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Catat satu event (label dipotong 200 char). No-op aman bila lock rusak.
pub fn emit(kind: &str, label: &str) {
    if let Ok(mut b) = bus().lock() {
        b.seq += 1;
        let seq = b.seq;
        let label: String = label.chars().take(200).collect();
        b.events.push(AgentEvent { seq, kind: kind.to_string(), label, ts: now_ms() });
        if b.events.len() > MAX_EVENTS {
            let drop = b.events.len() - MAX_EVENTS;
            b.events.drain(0..drop);
        }
    }
}

/// Baca event sejak `since_seq` (+ seq terbaru). Padanan readEvents.
pub fn read(since_seq: u64) -> Value {
    let b = bus().lock().unwrap();
    let events: Vec<Value> = b
        .events
        .iter()
        .filter(|e| e.seq > since_seq)
        .map(|e| json!({ "seq": e.seq, "type": e.kind, "label": e.label, "ts": e.ts }))
        .collect();
    json!({ "latest": b.seq, "events": events })
}

/// Event terakhir (untuk status.lastEvent) — {type,label} atau null.
pub fn last_event() -> Value {
    let b = bus().lock().unwrap();
    match b.events.last() {
        Some(e) => json!({ "type": e.kind, "label": e.label }),
        None => Value::Null,
    }
}

/// Kosongkan bus (dipanggil saat runtime baru mulai).
pub fn reset() {
    if let Ok(mut b) = bus().lock() {
        b.events.clear();
        b.seq = 0;
    }
}

/// Kunci serialisasi test yang menyentuh bus GLOBAL (bus dipakai bersama
/// antar thread test — tanpa ini `emit_read_reset` vs test loop yang emit
/// flaky: reset di tengah baca). Dipakai juga oleh test assistant.
#[cfg(test)]
pub(crate) static BUS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emit_read_reset() {
        let _g = BUS_TEST_LOCK.lock().unwrap();
        reset();
        emit("thinking_start", "");
        emit("final_answer", "selesai");
        let d = read(0);
        assert_eq!(d["events"].as_array().unwrap().len(), 2);
        assert_eq!(d["latest"], 2);
        // sejak seq 1 → hanya event ke-2
        assert_eq!(read(1)["events"].as_array().unwrap().len(), 1);
        assert_eq!(last_event()["type"], "final_answer");
        reset();
        assert_eq!(read(0)["latest"], 0);
        assert!(last_event().is_null());
    }
}
