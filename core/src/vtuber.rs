//! vtuber.rs — Runtime konektor + otak behavior mode AI VTuber. Single active
//! runtime: `start()` menghancurkan runtime lama dulu (bump epoch → task lama
//! mati sendiri). Provider: **mock** (simulator penonton+donasi tanpa key),
//! **twitch** (IRC over WSS via tokio-tungstenite), **youtube** (poll live chat).
//!
//! Behavior (dedup/cooldown audience, antrean donation/operator FIFO-20 +
//! precedence, LLM balasan) hidup DI SINI via `vtuber_scheduler` — satu
//! scheduler untuk semua klien (app utama + overlay OBS hanya render feed &
//! memutar balasan; race dobel-balasan mati dari akarnya).

use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use crate::chat_filter;
use crate::llm::{self, ChatMessage};
use crate::vtuber_scheduler::{
    speak_ms, ConfigPatch, QueueItem, Scheduler, SchedulerClass, SchedulerEvent,
};

const MAX_EVENTS: usize = 500;

#[derive(Clone)]
struct VtEvent {
    id: u64,
    ts: i64,
    kind: String, // "chat" | "donation" | "system" | "agent"
    user: String,
    text: String,
    amount: Option<String>,
}

impl VtEvent {
    fn to_json(&self) -> Value {
        let mut o = json!({
            "id": self.id,
            "ts": self.ts,
            "type": self.kind,
            "user": self.user,
            "text": self.text,
        });
        if let Some(a) = &self.amount {
            o["amount"] = json!(a);
        }
        o
    }
}

struct VtRuntime {
    epoch: u64,
    provider: String,
    cfg: Value,
    events: Vec<VtEvent>,
    next_id: u64,
    scheduler: Scheduler,
    config_path: PathBuf,
}

fn rt() -> &'static Mutex<Option<VtRuntime>> {
    static R: OnceLock<Mutex<Option<VtRuntime>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

fn epoch_counter() -> &'static AtomicU64 {
    static E: OnceLock<AtomicU64> = OnceLock::new();
    E.get_or_init(|| AtomicU64::new(0))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Dorong event ke feed (trim ke MAX_EVENTS). Return JSON event.
/// TIDAK menyentuh scheduler — dipakai untuk agent/system dan sebagai primitif
/// oleh `ingest_feed`.
fn push_feed(rt: &mut VtRuntime, kind: &str, user: &str, text: &str, amount: Option<String>) -> Value {
    let ev = VtEvent {
        id: rt.next_id,
        ts: now_ms(),
        kind: kind.to_string(),
        user: user.to_string(),
        text: text.to_string(),
        amount,
    };
    rt.next_id += 1;
    let out = ev.to_json();
    rt.events.push(ev);
    if rt.events.len() > MAX_EVENTS {
        let drop = rt.events.len() - MAX_EVENTS;
        rt.events.drain(0..drop);
    }
    out
}

/// Event penonton/donasi: masuk feed LALU scheduler (§7 intake). Menyerap
/// feedback sistem (antrean penuh) sebagai event feed, dan mengembalikan item
/// audience yang harus langsung dijalankan (run_now) bila ada.
fn ingest_feed(rt: &mut VtRuntime, kind: &str, user: &str, text: &str, amount: Option<String>) -> (Value, Option<QueueItem>) {
    let out = push_feed(rt, kind, user, text, amount.clone());
    let mut run_now = None;
    if kind == "chat" || kind == "donation" {
        let class = if kind == "chat" { SchedulerClass::Audience } else { SchedulerClass::Donation };
        let (_r, item) = rt.scheduler.ingest(SchedulerEvent {
            class,
            user: user.to_string(),
            text: text.to_string(),
            amount,
        });
        run_now = item;
        for msg in rt.scheduler.drain_system() {
            push_feed(rt, "system", "system", &msg, None);
        }
    }
    (out, run_now)
}

/// Catatan sistem ke feed dengan jeda minimal (anti-spam feed saat error
/// berkala — mis. mesin keputusan mati dan tiap komen memicu error sama).
fn feed_note_throttled(epoch: u64, text: &str) {
    static LAST: OnceLock<Mutex<i64>> = OnceLock::new();
    let last = LAST.get_or_init(|| Mutex::new(0));
    let now = now_ms();
    {
        let mut g = last.lock().unwrap();
        if now - *g < 30_000 {
            return;
        }
        *g = now;
    }
    feed_system(epoch, text);
}

/// Jalankan satu item (LLM role "chat") lalu tahan slot selama estimasi bicara,
/// finish, dan tarik item berikut dari antrean (drain). Berhenti sendiri bila
/// runtime sudah diganti (epoch beda) atau dihentikan.
fn spawn_run(epoch: u64, item: QueueItem) {
    tokio::spawn(async move {
        // Rakit prompt + system + config_path di bawah lock (lepas sebelum await).
        let prepared = {
            let mut g = rt().lock().unwrap();
            match g.as_mut() {
                Some(r) if r.epoch == epoch && !r.scheduler.is_stopped() => {
                    Some((r.scheduler.build_prompt(&item), r.scheduler.system_prompt(), r.config_path.clone()))
                }
                _ => None,
            }
        };
        let Some((prompt, system, config_path)) = prepared else { return };

        // Gerbang moderasi (khusus audience) — SETELAH gerbang mekanis
        // scheduler (dedup/cooldown/slot), jadi biaya keputusan hanya dibayar
        // untuk komentar yang memang akan dibalas. Komentar yang ditahan
        // lepas slot tanpa balasan; catatan: cooldown sudah tercatat di
        // ingest, jadi komentar berikut tetap menghormati jeda itu.
        if item.class == SchedulerClass::Audience {
            let filter = chat_filter::ChatFilter::load(&config_path);
            if filter.enabled {
                let mut blocked = filter.match_word(&item.text).map(|w| format!("kata terlarang \"{w}\""));
                if blocked.is_none() && filter.use_decision {
                    if chat_filter::decision_available(&config_path) {
                        let d = chat_filter::decide(&config_path, &item.user, &item.text, &filter.extra_rules).await;
                        if d.reject {
                            blocked = Some(if d.reason.is_empty() { "melanggar filter".into() } else { d.reason });
                        } else if let Some(err) = d.error {
                            // Fail-open: komen diteruskan tanpa keputusan mesin.
                            feed_note_throttled(epoch, &format!("Filter chat: {err} — komen diproses tanpa keputusan mesin."));
                        }
                    } else {
                        feed_note_throttled(
                            epoch,
                            "Filter chat: mesin keputusan tidak tersedia (tandai koneksi dengan role \"moderation\") — hanya blocklist yang aktif.",
                        );
                    }
                }
                if let Some(reason) = blocked {
                    let next = {
                        let mut g = rt().lock().unwrap();
                        match g.as_mut() {
                            Some(r) if r.epoch == epoch && !r.scheduler.is_stopped() => {
                                let user: String = item.user.chars().take(60).collect();
                                push_feed(r, "system", "system", &format!("Komen dari {user} ditahan filter ({reason})."), None);
                                r.scheduler.finish();
                                r.scheduler.try_start()
                            }
                            _ => None,
                        }
                    };
                    if let Some(n) = next {
                        spawn_run(epoch, n);
                    }
                    return;
                }
            }
        }

        let messages = [ChatMessage { role: "user".into(), content: prompt }];
        let result = llm::llm_for_role(&config_path, "chat", &messages, &system).await;

        // Emit balasan / feedback error, lalu tahan slot.
        let reply: String = match result {
            Ok(ok) => ok.reply.trim().chars().take(500).collect(),
            Err((_, msg)) => {
                let feedback = format!("AI gagal membalas {}: {}", item.class.as_str(), msg.chars().take(120).collect::<String>());
                let mut g = rt().lock().unwrap();
                if let Some(r) = g.as_mut() {
                    if r.epoch == epoch {
                        push_feed(r, "system", "system", &feedback, None);
                    }
                }
                String::new()
            }
        };

        let wait = if reply.is_empty() {
            0
        } else {
            let mut g = rt().lock().unwrap();
            if let Some(r) = g.as_mut() {
                if r.epoch == epoch && !r.scheduler.is_stopped() {
                    push_feed(r, "agent", "AI", &reply, None);
                }
            }
            speak_ms(&reply)
        };
        if wait > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(wait as u64)).await;
        }

        // Slot lepas → tarik item berikut (precedence donation>operator).
        let next = {
            let mut g = rt().lock().unwrap();
            match g.as_mut() {
                Some(r) if r.epoch == epoch && !r.scheduler.is_stopped() => {
                    r.scheduler.finish();
                    r.scheduler.try_start()
                }
                _ => None,
            }
        };
        if let Some(n) = next {
            spawn_run(epoch, n);
        }
    });
}

/// True selama runtime dgn epoch ini masih aktif (belum diganti/dihentikan).
fn epoch_current(epoch: u64) -> bool {
    let g = rt().lock().unwrap();
    matches!(g.as_ref(), Some(r) if r.epoch == epoch)
}

/// Masukkan event penonton/donasi (dari provider apa pun) → feed + scheduler →
/// jalankan item bila diterima. No-op bila runtime sudah diganti.
fn feed_incoming(epoch: u64, kind: &str, user: &str, text: &str, amount: Option<String>) {
    let run_now = {
        let mut g = rt().lock().unwrap();
        match g.as_mut() {
            Some(r) if r.epoch == epoch => ingest_feed(r, kind, user, text, amount).1,
            _ => None,
        }
    };
    if let Some(item) = run_now {
        spawn_run(epoch, item);
    }
}

/// Event sistem/feedback ke feed. No-op bila runtime sudah diganti.
fn feed_system(epoch: u64, text: &str) {
    let mut g = rt().lock().unwrap();
    if let Some(r) = g.as_mut() {
        if r.epoch == epoch {
            push_feed(r, "system", "system", text, None);
        }
    }
}

async fn sleep_ms(ms: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

/// Loop simulator penonton (provider mock). Berhenti saat epoch berubah.
fn spawn_mock(epoch: u64, interval_ms: u64) {
    tokio::spawn(async move {
        const NAMES: &[&str] = &["Rian", "Sinta", "Budi", "Ayu", "Kevin", "Nadia", "Fajar", "Tania", "Yoga", "Melati"];
        const CHATS: &[&str] = &[
            "Halo semua!", "Kamu dari mana?", "Suara lucu banget 😆", "Sedih banget lagunya",
            "Main game dong!", "Jam berapa stream selesai?", "Keren sih karakternya",
            "Ada yang tahu cara donasi?", "Request lagu boleh?", "Hari ini ngapain aja?",
        ];
        const DONORS: &[&str] = &["Rian", "Kevin", "Ayu", "Fajar"];
        const AMOUNTS: &[&str] = &["Rp 10.000", "Rp 25.000", "Rp 50.000", "Rp 100.000"];
        let mut tick: u64 = 0;
        loop {
            sleep_ms(interval_ms).await;
            if !epoch_current(epoch) {
                return;
            }
            tick += 1;
            if tick % 5 == 0 {
                let user = DONORS[pseudo_rand(tick) % DONORS.len()];
                let amount = AMOUNTS[pseudo_rand(tick.wrapping_mul(7)) % AMOUNTS.len()];
                feed_incoming(epoch, "donation", user, "Dukung terus streamnya!", Some(amount.to_string()));
            } else {
                let user = NAMES[pseudo_rand(tick.wrapping_mul(3)) % NAMES.len()];
                let text = CHATS[pseudo_rand(tick.wrapping_mul(11)) % CHATS.len()];
                feed_incoming(epoch, "chat", user, text, None);
            }
        }
    });
}

/// Provider Twitch: baca live chat via IRC WebSocket (wss). Tanpa token =
/// anonim read-only (justinfan). Reconnect 5 dtk saat koneksi tertutup, selama
/// runtime dgn epoch ini masih aktif. Port dari cabang "twitch" vtuber.ts.
fn spawn_twitch(epoch: u64, channel: String, token: String, nick: String) {
    tokio::spawn(async move {
        loop {
            if !epoch_current(epoch) {
                return;
            }
            match tokio_tungstenite::connect_async("wss://irc-ws.chat.twitch.tv:443").await {
                Err(_) => {
                    feed_system(epoch, "Gagal terhubung ke Twitch IRC.");
                }
                Ok((mut ws, _)) => {
                    let _ = ws.send(Message::Text("CAP REQ :twitch.tv/tags".into())).await;
                    if !token.is_empty() {
                        let bare = token.trim_start_matches("oauth:").trim_start_matches("OAUTH:");
                        let _ = ws.send(Message::Text(format!("PASS oauth:{bare}").into())).await;
                    }
                    let _ = ws.send(Message::Text(format!("NICK {nick}").into())).await;
                    let _ = ws.send(Message::Text(format!("JOIN #{channel}").into())).await;
                    feed_system(
                        epoch,
                        &format!("Terhubung ke Twitch #{channel}{}", if token.is_empty() { " (anonim)" } else { " (auth)" }),
                    );
                    while let Some(msg) = ws.next().await {
                        if !epoch_current(epoch) {
                            let _ = ws.close(None).await;
                            return;
                        }
                        let raw = match msg {
                            Ok(Message::Text(t)) => t.as_str().to_string(),
                            Ok(Message::Ping(p)) => {
                                let _ = ws.send(Message::Pong(p)).await;
                                continue;
                            }
                            Ok(Message::Close(_)) | Err(_) => break,
                            _ => continue,
                        };
                        for line in raw.split("\r\n") {
                            if line.is_empty() {
                                continue;
                            }
                            if line.starts_with("PING") {
                                let _ = ws.send(Message::Text("PONG :tmi.twitch.tv".into())).await;
                                continue;
                            }
                            if line.contains(" PRIVMSG ") {
                                if let Some((user, text)) = parse_privmsg(line) {
                                    let t: String = text.chars().take(400).collect();
                                    feed_incoming(epoch, "chat", &user, &t, None);
                                }
                            } else if line.contains("Login authentication failed") || line.contains("Improperly formatted auth") {
                                feed_system(epoch, "Auth Twitch gagal — cek token/nick. Coba tanpa token (anonim).");
                            }
                        }
                    }
                }
            }
            if !epoch_current(epoch) {
                return;
            }
            feed_system(epoch, "Koneksi Twitch tertutup. Mencoba ulang 5 dtk…");
            sleep_ms(5000).await;
        }
    });
}

/// Parse baris IRC PRIVMSG → (user, text). Format:
/// `@tags :nick!nick@nick.tmi.twitch.tv PRIVMSG #chan :pesan`. display-name
/// dari tags dipakai bila ada.
fn parse_privmsg(line: &str) -> Option<(String, String)> {
    // Ambil display-name dari tags (bila ada) sebagai user preferensi.
    let mut display: Option<String> = None;
    if line.starts_with('@') {
        if let Some(seg) = line.split(' ').next() {
            for kv in seg.trim_start_matches('@').split(';') {
                if let Some(v) = kv.strip_prefix("display-name=") {
                    if !v.is_empty() {
                        display = Some(v.to_string());
                    }
                }
            }
        }
    }
    // Buang tags → mulai dari ":nick!..."
    let rest = if line.starts_with('@') {
        match line.find(' ') {
            Some(i) => &line[i + 1..],
            None => line,
        }
    } else {
        line
    };
    // :nick!user@host PRIVMSG #chan :text
    let rest = rest.strip_prefix(':')?;
    let bang = rest.find('!')?;
    let nick = &rest[..bang];
    let privmsg_at = rest.find(" PRIVMSG ")?;
    let after = &rest[privmsg_at + " PRIVMSG ".len()..];
    let colon = after.find(" :")?;
    let text = &after[colon + 2..];
    let user = display.unwrap_or_else(|| nick.to_string());
    if user.is_empty() || text.is_empty() {
        return None;
    }
    Some((user, text.to_string()))
}

/// Provider YouTube: poll liveChatMessages.list (butuh API key + videoId live).
/// superChat/superSticker → donasi. Port dari cabang "youtube" vtuber.ts.
fn spawn_youtube(epoch: u64, video_id: String, key: String) {
    tokio::spawn(async move {
        const BASE: &str = "https://www.googleapis.com/youtube/v3";
        let client = reqwest::Client::new();

        // 1) activeLiveChatId dari videos.list
        let live_chat_id = match client
            .get(format!("{BASE}/videos"))
            .query(&[("part", "liveStreamingDetails"), ("id", video_id.as_str()), ("key", key.as_str())])
            .send()
            .await
        {
            Ok(r) => r
                .json::<Value>()
                .await
                .ok()
                .and_then(|j| {
                    j.get("items")
                        .and_then(|i| i.as_array())
                        .and_then(|a| a.first())
                        .and_then(|it| it.get("liveStreamingDetails"))
                        .and_then(|d| d.get("activeLiveChatId"))
                        .and_then(|v| v.as_str())
                        .map(String::from)
                })
                .unwrap_or_default(),
            Err(e) => {
                feed_system(epoch, &format!("Gagal ambil liveChatId: {e}"));
                return;
            }
        };
        if live_chat_id.is_empty() {
            feed_system(epoch, "liveChatId tidak ditemukan — pastikan video sedang live dan chat aktif.");
            return;
        }
        feed_system(epoch, "Terhubung ke live chat YouTube.");

        let mut page_token = String::new();
        loop {
            if !epoch_current(epoch) {
                return;
            }
            let wait: u64;
            match client
                .get(format!("{BASE}/liveChat/messages"))
                .query(&[
                    ("liveChatId", live_chat_id.as_str()),
                    ("part", "snippet,authorDetails"),
                    ("pageToken", page_token.as_str()),
                    ("key", key.as_str()),
                ])
                .send()
                .await
            {
                Ok(resp) => {
                    let j = resp.json::<Value>().await.unwrap_or_else(|_| json!({}));
                    if let Some(err) = j.get("error") {
                        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("error");
                        feed_system(epoch, &format!("YouTube API: {msg}"));
                        break;
                    }
                    if let Some(items) = j.get("items").and_then(|i| i.as_array()) {
                        for it in items {
                            parse_youtube_item(epoch, it);
                        }
                    }
                    if let Some(tok) = j.get("nextPageToken").and_then(|v| v.as_str()) {
                        page_token = tok.to_string();
                    }
                    wait = j.get("pollingIntervalMillis").and_then(|v| v.as_u64()).unwrap_or(5000).max(5000);
                }
                Err(e) => {
                    feed_system(epoch, &format!("Poll YouTube gagal: {e}"));
                    wait = 10000;
                }
            }
            sleep_ms(wait).await;
        }
    });
}

/// Satu item liveChatMessages → feed (chat/donation). Amount superchat =
/// amountMicros/1e6 + currency.
fn parse_youtube_item(epoch: u64, it: &Value) {
    let sn = it.get("snippet").cloned().unwrap_or_else(|| json!({}));
    let user = it
        .get("authorDetails")
        .and_then(|a| a.get("displayName"))
        .and_then(|v| v.as_str())
        .or_else(|| sn.get("authorChannelId").and_then(|v| v.as_str()))
        .unwrap_or("?")
        .to_string();
    let kind = sn.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "superChatEvent" => {
            if let Some(d) = sn.get("superChatDetails") {
                let amt = money(d);
                let text = d.get("userComment").and_then(|v| v.as_str()).unwrap_or("").to_string();
                feed_incoming(epoch, "donation", &user, &text, Some(amt));
            }
        }
        "superStickerEvent" => {
            if let Some(d) = sn.get("superStickerDetails") {
                feed_incoming(epoch, "donation", &user, "[super sticker]", Some(money(d)));
            }
        }
        "textMessageEvent" => {
            if let Some(t) = sn.get("textMessageDetails").and_then(|d| d.get("messageText")).and_then(|v| v.as_str()) {
                let t: String = t.chars().take(400).collect();
                feed_incoming(epoch, "chat", &user, &t, None);
            }
        }
        _ => {}
    }
}

/// amountMicros/1e6 (bulat) + " " + currency.
fn money(d: &Value) -> String {
    let micros = d.get("amountMicros").and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0.0);
    let cur = d.get("currency").and_then(|v| v.as_str()).unwrap_or("");
    format!("{} {}", (micros / 1e6).round() as i64, cur).trim().to_string()
}

/// PRNG murah (tanpa dep rand): xorshift dari tick + nanos.
fn pseudo_rand(seed: u64) -> usize {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let mut x = seed ^ nanos ^ 0x9E3779B97F4A7C15;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    x as usize
}

// ── API publik (dipakai handler lib.rs) ────────────────────────────────────

/// Status runtime + antrean scheduler.
pub fn status() -> Value {
    let g = rt().lock().unwrap();
    match g.as_ref() {
        None => json!({
            "running": false,
            "provider": null,
            "channel": null,
            "respond": false,
            "eventCount": 0,
            "queues": { "active": null, "donationQueue": 0, "operatorQueue": 0 },
        }),
        Some(r) => {
            let (active, dq, oq) = r.scheduler.stats();
            let channel = r.cfg.get("channel").and_then(|v| v.as_str())
                .or_else(|| r.cfg.get("videoId").and_then(|v| v.as_str()));
            json!({
                "running": true,
                "provider": r.provider,
                "channel": channel,
                "respond": r.cfg.get("respondChat").and_then(|v| v.as_bool()).unwrap_or(false),
                "eventCount": r.events.len(),
                "queues": {
                    "active": active.map(|c| c.as_str()),
                    "donationQueue": dq,
                    "operatorQueue": oq,
                },
            })
        }
    }
}

/// Event sejak cursor `since` (+ cursor terbaru).
pub fn events(since: u64) -> Value {
    let g = rt().lock().unwrap();
    match g.as_ref() {
        None => json!({ "events": [], "cursor": since }),
        Some(r) => {
            let evs: Vec<Value> = r.events.iter().filter(|e| e.id > since).map(|e| e.to_json()).collect();
            json!({ "events": evs, "cursor": r.next_id.saturating_sub(1) })
        }
    }
}

/// Injeksi event manual (mock-event UI). type: donation|agent|else→chat.
pub fn inject_event(body: &Value) -> Option<Value> {
    let raw_type = body.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let kind = if raw_type == "donation" || raw_type == "agent" { raw_type } else { "chat" };
    let user = body.get("user").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("Guest").to_string();
    let text: String = body.get("text").and_then(|v| v.as_str()).unwrap_or("").chars().take(400).collect();
    let amount = body.get("amount").and_then(|v| v.as_str()).map(String::from);

    let (out, run_now, epoch) = {
        let mut g = rt().lock().unwrap();
        let r = g.as_mut()?;
        let ep = r.epoch;
        let (o, item) = ingest_feed(r, kind, &user, &text, amount);
        (o, item, ep)
    };
    if let Some(item) = run_now {
        spawn_run(epoch, item);
    }
    Some(out)
}

/// Balasan agent → event feed type "agent".
pub fn agent_say(text: &str) -> Option<Value> {
    let mut g = rt().lock().unwrap();
    let r = g.as_mut()?;
    let t: String = text.chars().take(500).collect();
    Some(push_feed(r, "agent", "AI", &t, None))
}

/// Instruksi operator (§7): echo ke feed + masuk antrean operator.
pub fn operator_say(text: &str) -> (bool, Option<String>) {
    let text: String = text.chars().take(400).collect();
    let text = text.trim().to_string();
    if text.is_empty() {
        return (false, Some("teks instruksi kosong".into()));
    }
    let (run_now, epoch) = {
        let mut g = rt().lock().unwrap();
        let Some(r) = g.as_mut() else { return (false, Some("vtuber runtime tidak aktif".into())) };
        push_feed(r, "system", "operator", &format!("Operator: {text}"), None);
        let (_res, _item) = r.scheduler.ingest(SchedulerEvent {
            class: SchedulerClass::Operator,
            user: "operator".into(),
            text,
            amount: None,
        });
        // operator masuk antrean; tarik bila slot bebas
        let item = r.scheduler.try_start();
        for msg in r.scheduler.drain_system() {
            push_feed(r, "system", "system", &msg, None);
        }
        (item, r.epoch)
    };
    if let Some(item) = run_now {
        spawn_run(epoch, item);
    }
    (true, None)
}

/// Ubah config behavior JALAN (tanpa restart stream).
pub fn set_config(body: &Value) -> Value {
    let patch = ConfigPatch {
        persona: body.get("persona").and_then(|v| v.as_str()).map(String::from),
        cooldown_ms: body.get("cooldownMs").and_then(|v| v.as_i64()),
        respond_chat: body.get("respondChat").and_then(|v| v.as_bool()),
        respond_donation: body.get("respondDonation").and_then(|v| v.as_bool()),
    };
    let (ok, run_now, epoch) = {
        let mut g = rt().lock().unwrap();
        match g.as_mut() {
            None => (false, None, 0),
            Some(r) => {
                // cache flag respond utk status
                if let Some(b) = patch.respond_chat {
                    r.cfg["respondChat"] = json!(b);
                }
                r.scheduler.set_config(patch);
                // config baru bisa menyalakan drain (respond dinyalakan saat antre)
                let item = r.scheduler.try_start();
                (true, item, r.epoch)
            }
        }
    };
    if let Some(item) = run_now {
        spawn_run(epoch, item);
    }
    json!({ "ok": ok })
}

/// Hentikan runtime (bump epoch → task lama berhenti sendiri).
pub fn stop() -> Value {
    let mut g = rt().lock().unwrap();
    if let Some(r) = g.as_mut() {
        r.scheduler.stop();
    }
    *g = None;
    epoch_counter().fetch_add(1, Ordering::SeqCst);
    json!({ "ok": true })
}

/// Mulai runtime. Menghancurkan runtime lama dulu. `config_path` untuk LLM.
pub fn start(cfg: Value, config_path: PathBuf) -> (bool, Option<String>) {
    // stop dulu (single active runtime)
    stop();
    let provider = cfg.get("provider").and_then(|v| v.as_str()).unwrap_or("mock").to_string();

    // Validasi param wajib per provider SEBELUM menyalakan runtime (padanan
    // vtuber.ts: kembalikan error, jangan menyisakan runtime setengah jalan).
    let str_of = |k: &str| cfg.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    match provider.as_str() {
        "mock" => {}
        "twitch" => {
            let channel = str_of("channel").to_lowercase();
            let channel = channel.trim_start_matches('#').to_string();
            if channel.is_empty() {
                return (false, Some("nama channel Twitch wajib diisi".into()));
            }
        }
        "youtube" => {
            if str_of("videoId").is_empty() || str_of("apiKey").is_empty() {
                return (false, Some("videoId live + API key YouTube wajib diisi".into()));
            }
        }
        other => return (false, Some(format!("provider tidak dikenal: {other}"))),
    }

    let epoch = epoch_counter().fetch_add(1, Ordering::SeqCst) + 1;
    let mut scheduler = Scheduler::new();
    scheduler.set_config(ConfigPatch {
        persona: cfg.get("persona").and_then(|v| v.as_str()).map(String::from),
        cooldown_ms: cfg.get("cooldownMs").and_then(|v| v.as_i64()),
        respond_chat: Some(cfg.get("respondChat").and_then(|v| v.as_bool()).unwrap_or(false)),
        respond_donation: Some(cfg.get("respondDonation").and_then(|v| v.as_bool()).unwrap_or(false)),
    });

    let interval_ms = cfg.get("mockIntervalMs").and_then(|v| v.as_u64()).unwrap_or(6000).max(3000);

    // Param provider dihitung sebelum menyimpan runtime (cfg dipindah masuk).
    let channel = str_of("channel").to_lowercase().trim_start_matches('#').to_string();
    let token = str_of("apiKey");
    let nick = if token.is_empty() {
        format!("justinfan{}", 10000 + (pseudo_rand(epoch) % 89999))
    } else {
        let n = str_of("nick");
        if n.is_empty() { "justinfan12345".to_string() } else { n.to_lowercase() }
    };
    let video_id = str_of("videoId");
    let api_key = token.clone();

    {
        let mut g = rt().lock().unwrap();
        let mut r = VtRuntime {
            epoch,
            provider: provider.clone(),
            cfg,
            events: Vec::new(),
            next_id: 1,
            scheduler,
            config_path,
        };
        if provider == "mock" {
            push_feed(&mut r, "system", "system", "Mode mock aktif — penonton simulasi (tanpa API key).", None);
        }
        *g = Some(r);
    }

    match provider.as_str() {
        "mock" => spawn_mock(epoch, interval_ms),
        "twitch" => spawn_twitch(epoch, channel, token, nick),
        "youtube" => spawn_youtube(epoch, video_id, api_key),
        _ => {}
    }
    (true, None)
}

// ── Overlay OBS ─────────────────────────────────────────────────────────────
// vtuber.html (Browser Source OBS) kirim heartbeat berkala; selama segar, app
// utama menahan balasan otomatisnya (anti-dobel). 0 = belum pernah nyambung.
fn overlay_beat() -> &'static AtomicI64 {
    static B: OnceLock<AtomicI64> = OnceLock::new();
    B.get_or_init(|| AtomicI64::new(0))
}

pub fn overlay_ping() -> Value {
    overlay_beat().store(now_ms(), Ordering::SeqCst);
    json!({ "ok": true, "active": true })
}

pub fn overlay_active() -> bool {
    let b = overlay_beat().load(Ordering::SeqCst);
    b > 0 && now_ms() - b < 8000
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test yang menyentuh runtime GLOBAL (rt()) berjalan serial — cargo
    /// menjalankan test paralel, dan start()/stop() membanting runtime bersama.
    static RT_LOCK: Mutex<()> = Mutex::new(());

    fn lock_rt() -> std::sync::MutexGuard<'static, ()> {
        RT_LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn fresh_config(dir: &std::path::Path) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let f = dir.join("config.json");
        std::fs::write(&f, r#"{"activeId":"m","connections":[{"id":"m","provider":"mock"}]}"#).unwrap();
        f
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn start_stop_mock_status() {
        let _g = lock_rt();
        let dir = std::env::temp_dir().join(format!("l2dvt-{}-{}", std::process::id(), now_ms()));
        let cfg_path = fresh_config(&dir);
        // validasi param wajib per provider (tanpa menyalakan koneksi nyata)
        let (ok, err) = start(json!({ "provider": "twitch" }), cfg_path.clone());
        assert!(!ok);
        assert!(err.unwrap().contains("channel Twitch"));
        let (ok, err) = start(json!({ "provider": "youtube", "videoId": "v" }), cfg_path.clone());
        assert!(!ok);
        assert!(err.unwrap().contains("YouTube"));
        let (ok, err) = start(json!({ "provider": "bogus" }), cfg_path.clone());
        assert!(!ok);
        assert!(err.unwrap().contains("tidak dikenal"));

        // mock start → running + event system pembuka
        let (ok, _) = start(json!({ "provider": "mock", "mockIntervalMs": 3000 }), cfg_path);
        assert!(ok);
        let st = status();
        assert_eq!(st["running"], true);
        assert_eq!(st["provider"], "mock");
        let ev = events(0);
        assert!(ev["events"].as_array().unwrap().iter().any(|e| e["type"] == "system"));

        stop();
        assert_eq!(status()["running"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn inject_dan_agent_say() {
        let _g = lock_rt();
        let dir = std::env::temp_dir().join(format!("l2dvt2-{}-{}", std::process::id(), now_ms()));
        let cfg_path = fresh_config(&dir);
        start(json!({ "provider": "mock", "mockIntervalMs": 60000 }), cfg_path);
        // inject chat (respondChat default mati → tak memicu LLM, tapi tampil feed)
        let ev = inject_event(&json!({ "type": "chat", "user": "Rian", "text": "halo" })).unwrap();
        assert_eq!(ev["type"], "chat");
        assert_eq!(ev["user"], "Rian");
        // agent say
        let a = agent_say("halo semua").unwrap();
        assert_eq!(a["type"], "agent");
        // operator tanpa runtime setelah stop → gagal
        stop();
        assert!(inject_event(&json!({ "type": "chat" })).is_none());
        assert!(agent_say("x").is_none());
        let (ok, _) = operator_say("test");
        assert!(!ok);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn overlay_heartbeat() {
        assert!(!overlay_active() || overlay_active()); // no panic
        overlay_ping();
        assert!(overlay_active());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn filter_chat_blocklist_dan_keputusan_fail_open() {
        let _g = lock_rt();
        let dir = std::env::temp_dir().join(format!("l2dvt3-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");

        // ── Skenario 1: blocklist menahan komen sebelum LLM, tanpa balasan agent.
        std::fs::write(
            &f,
            r#"{"activeId":"m","connections":[{"id":"m","provider":"mock","enabled":true,"roles":["chat","moderation"]}],"chatFilter":{"enabled":true,"useDecision":true,"words":["slot","judol"]}}"#,
        )
        .unwrap();
        start(json!({ "provider": "mock", "mockIntervalMs": 60000 }), f.clone());
        set_config(&json!({ "respondChat": true }));
        inject_event(&json!({ "type": "chat", "user": "Rian", "text": "ayo main slot gacor" }));
        sleep_ms(400).await;
        let evs = events(0)["events"].as_array().unwrap().clone();
        assert!(
            evs.iter().any(|e| e["type"] == "system" && e["text"].as_str().unwrap_or("").contains("ditahan filter")),
            "harus ada catatan penahanan di feed"
        );
        assert!(!evs.iter().any(|e| e["type"] == "agent"), "komen terlarang tak boleh dibalas");
        stop();

        // ── Skenario 2: mesin keputusan (mock meng-echo prompt "IZINKAN atau
        // TOLAK") → jawaban tak terbaca → fail-open → komen tetap dibalas.
        std::fs::write(
            &f,
            r#"{"activeId":"m","connections":[{"id":"m","provider":"mock","enabled":true,"roles":["chat","moderation"]}],"chatFilter":{"enabled":true,"useDecision":true,"words":[]}}"#,
        )
        .unwrap();
        start(json!({ "provider": "mock", "mockIntervalMs": 60000 }), f);
        set_config(&json!({ "respondChat": true }));
        inject_event(&json!({ "type": "chat", "user": "Sinta", "text": "halo semua" }));
        // Dua panggilan mock (moderasi + balasan chat) @300ms + jeda scheduler.
        sleep_ms(2500).await;
        let evs = events(0)["events"].as_array().unwrap().clone();
        assert!(evs.iter().any(|e| e["type"] == "agent"), "komen baik harus dibalas (fail-open)");
        stop();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
