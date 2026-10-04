//! Memory jangka panjang companion (mode stage/chat & pet) + keputusan latar
//! ber-LLM: klasifikasi intent (chat → agent), ringkas sesi, ekstraksi memori.
//!
//! Dua lapisan sesi permintaan fitur:
//! - Session context = milik client (RAM, mati saat aplikasi ditutup) — TIDAK
//!   ada di sini. Yang persisten hanya ekstraksi layak-ingat lintas sesi.
//! - Store `data/companion-memory.json`: {entries:[{id,text,tags,ts,hits,
//!   lastHit}]}. Dedupe mirip (Jaccard token) saat menambah; penuh → buang
//!   entri terlemah (paling jarang diakses, paling lama tak disentuh).
//!
//! Panggilan LLM memakai role "memory" (fallback koneksi aktif — TANPA
//! has_explicit_role guard, supaya fitur jalan zero-config). Semua keputusan
//! fail-soft: LLM gagal → intent chat biasa / ringkasan lama dipertahankan /
//! ekstraksi kosong. Pattern prompt+validate mengikuti behavior.rs.

use std::collections::HashSet;
use std::path::Path;

use serde_json::{json, Value};

use crate::jsonx;

const MAX_ENTRIES: usize = 120;
const MAX_TEXT_CHARS: usize = 400;
const MAX_TAGS: usize = 5;
const MAX_TAG_CHARS: usize = 24;
/// Kemiripan Jaccard minimum untuk menganggap dua memori sama (dedupe).
const DEDUPE_JACCARD: f64 = 0.7;
pub const DEFAULT_RETRIEVE_LIMIT: usize = 6;
/// Boost skor recency: entri yang terakhir diakses < 14 hari tetap segar.
const RECENCY_HALF_LIFE_DAYS: f64 = 14.0;

fn store_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("companion-memory.json")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn entry_id() -> String {
    let ms = now_ms() as u128;
    let rnd: u32 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("m_{}_{}", crate::config::base36_pub(ms), crate::config::base36_pub(rnd as u128))
}

/// Bersihkan satu entri masukan: teks wajib ada (≥ 3 char), tags dibatasi.
fn sanitize_entry(e: &Value) -> Option<(String, Vec<String>)> {
    let text = e.get("text").and_then(|t| t.as_str())?.trim();
    if text.chars().count() < 3 {
        return None;
    }
    let tags: Vec<String> = e
        .get("tags")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.as_str())
                .map(|t| take_chars(t.trim(), MAX_TAG_CHARS))
                .filter(|t| !t.is_empty())
                .take(MAX_TAGS)
                .collect()
        })
        .unwrap_or_default();
    Some((take_chars(text, MAX_TEXT_CHARS), tags))
}

fn normalize(f: &Value) -> Value {
    let entries: Vec<Value> = f
        .get("entries")
        .and_then(|e| e.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let (text, tags) = sanitize_entry(e)?;
                    Some(json!({
                        "id": e.get("id").and_then(|i| i.as_str()).unwrap_or(""),
                        "text": text,
                        "tags": tags,
                        "ts": e.get("ts").and_then(|t| t.as_i64()).unwrap_or_else(now_ms),
                        "hits": e.get("hits").and_then(|h| h.as_i64()).unwrap_or(0).max(0),
                        "lastHit": e.get("lastHit").and_then(|h| h.as_i64()).unwrap_or(0),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    json!({ "entries": entries })
}

fn load(data_dir: &Path) -> Value {
    if let Ok(raw) = std::fs::read_to_string(store_path(data_dir)) {
        if let Ok(j) = serde_json::from_str::<Value>(&raw) {
            return normalize(&j);
        }
    }
    json!({ "entries": [] })
}

fn save(data_dir: &Path, store: &Value) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = store_path(data_dir);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(store).unwrap_or_else(|_| "{}".into()))?;
    std::fs::rename(&tmp, &path)
}

/// Tokenisasi lintas-bahasa: run karakter alfanumerik unicode (Indonesia,
/// Inggris, Jepang, dst), lowercase, buang token < 2 char. Dipakai retrieval
/// DAN dedupe — tidak bergantung nama/bahasa tertentu (aturan inti #1).
pub fn tokenize(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_alphanumeric() {
            cur.push(c);
        } else if !cur.is_empty() {
            if cur.chars().count() >= 2 {
                out.push(std::mem::take(&mut cur));
            } else {
                cur.clear();
            }
        }
    }
    if cur.chars().count() >= 2 {
        out.push(cur);
    }
    out
}

fn token_set(s: &str) -> HashSet<String> {
    tokenize(s).into_iter().collect()
}

fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count();
    let union = a.union(b).count();
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}

/// Skor kecocokan satu entri terhadap token query:
/// overlap berbobot IDF (token langka di korpus lebih bermakna) + boost
/// recency. Murni — mudah dites.
fn score_entry(
    entry: &Value,
    q_tokens: &HashSet<String>,
    df: &std::collections::HashMap<String, usize>,
    total: usize,
    now: i64,
) -> f64 {
    let text = entry.get("text").and_then(|t| t.as_str()).unwrap_or("");
    let tags = entry.get("tags").and_then(|t| t.as_array());
    // Tag dihitung ikut (bobot sama — korpusnya kecil, IDF yang membedakan).
    let mut entry_tokens = token_set(text);
    if let Some(tags) = tags {
        for t in tags {
            for tok in tokenize(t.as_str().unwrap_or("")) {
                entry_tokens.insert(tok);
            }
        }
    }
    if q_tokens.is_empty() || entry_tokens.is_empty() {
        return 0.0;
    }
    let mut score = 0.0f64;
    for tok in q_tokens.iter() {
        if entry_tokens.contains(tok) {
            let idf = match df.get(tok) {
                Some(dfv) if *dfv > 0 => ((total as f64 + 1.0) / (*dfv as f64 + 1.0)).ln().max(0.3),
                _ => ((total as f64 + 1.0) / 1.0).ln().max(0.3),
            };
            score += idf;
        }
    }
    if score <= 0.0 {
        return 0.0;
    }
    // Recency: eksponensial lembut berbasis lastHit (fallback ts).
    let last = entry
        .get("lastHit")
        .and_then(|h| h.as_i64())
        .filter(|h| *h > 0)
        .unwrap_or_else(|| entry.get("ts").and_then(|t| t.as_i64()).unwrap_or(0));
    let days = ((now - last).max(0) as f64) / 86_400_000.0;
    let recency = (-days / RECENCY_HALF_LIFE_DAYS).exp2(); // 1.0 → 0.5 per half-life
    score * (1.0 + 0.3 * recency)
}

/// GET retrieval: entri paling relevan untuk query (tanpa query → terbaru).
/// Return {entries:[{id,text,tags,ts,score}]} — sisi server supaya SEMUA
/// surface (app utama, jendela pet, CLI) berbagi logika yang sama.
pub fn retrieve(data_dir: &Path, query: &str, limit: usize) -> Value {
    let f = load(data_dir);
    let entries = f["entries"].as_array().cloned().unwrap_or_default();
    let limit = limit.clamp(1, 24);
    let now = now_ms();
    let q_tokens = token_set(query);
    if q_tokens.is_empty() {
        // Tanpa query: terbaru dulu (dipakai untuk review memori).
        let mut sorted = entries;
        sorted.sort_by_key(|e| -e.get("ts").and_then(|t| t.as_i64()).unwrap_or(0));
        let items: Vec<Value> = sorted
            .into_iter()
            .take(limit)
            .map(|e| json!({ "id": e["id"], "text": e["text"], "tags": e["tags"], "ts": e["ts"], "score": 0.0 }))
            .collect();
        return json!({ "entries": items });
    }
    // DF korpus untuk IDF.
    let mut df: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for e in &entries {
        let mut seen = token_set(e.get("text").and_then(|t| t.as_str()).unwrap_or(""));
        if let Some(tags) = e.get("tags").and_then(|t| t.as_array()) {
            for t in tags {
                for tok in tokenize(t.as_str().unwrap_or("")) {
                    seen.insert(tok);
                }
            }
        }
        for tok in seen {
            *df.entry(tok).or_insert(0) += 1;
        }
    }
    let total = entries.len();
    let mut scored: Vec<(f64, Value)> = entries
        .into_iter()
        .map(|e| {
            let s = score_entry(&e, &q_tokens, &df, total, now);
            (s, e)
        })
        .filter(|(s, _)| *s > 0.0)
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let picked: Vec<(f64, Value)> = scored.into_iter().take(limit).collect();
    // Catat akses untuk kebijakan eviksi (entri yang sering dipakai = kuat).
    let ids: Vec<String> = picked
        .iter()
        .filter_map(|(_, e)| e.get("id").and_then(|i| i.as_str()).map(String::from))
        .collect();
    mark_hits(data_dir, &ids);
    let items: Vec<Value> = picked
        .into_iter()
        .map(|(s, e)| json!({ "id": e["id"], "text": e["text"], "tags": e["tags"], "ts": e["ts"], "score": (s * 1000.0).round() / 1000.0 }))
        .collect();
    json!({ "entries": items })
}

/// Tambah entri (dedupe mirip → perbarui ts/hits entri lama, jangan duplikat).
/// Item boleh membawa `replacesId`: PERBARUI entri lama itu di tempat — untuk
/// koreksi/kontradiksi (user pindah kota, berhenti hobi, preferensi berubah).
/// Penuh → buang entri terlemah (hits paling kecil, lastHit paling tua).
/// Return {added, updated, total}.
pub fn add_entries(data_dir: &Path, items: &[Value]) -> Value {
    let mut f = load(data_dir);
    let mut added = 0usize;
    let mut updated = 0usize;
    let now = now_ms();
    {
        let entries = f["entries"].as_array_mut().unwrap();
        for item in items {
            let Some((text, tags)) = sanitize_entry(item) else { continue };
            let replaces = item
                .get("replacesId")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string();
            // Update eksplisit (koreksi/kontradiksi) menang atas dedupe.
            if !replaces.is_empty() {
                if let Some(old) = entries.iter_mut().find(|e| {
                    e.get("id").and_then(|i| i.as_str()) == Some(replaces.as_str())
                }) {
                    old["text"] = json!(text);
                    if !tags.is_empty() {
                        old["tags"] = json!(tags);
                    }
                    if let Some(t) = old.get_mut("ts") {
                        *t = json!(now);
                    }
                    updated += 1;
                    continue;
                }
                // id tidak ada → jatuh ke jalur tambah biasa (fail-soft).
            }
            let new_tokens = token_set(&text);
            if new_tokens.is_empty() {
                continue;
            }
            // Dedupe: mirip dengan entri lama → segarkan entri lama.
            let dup = entries.iter_mut().find(|e| {
                let old_text = e.get("text").and_then(|t| t.as_str()).unwrap_or("");
                jaccard(&new_tokens, &token_set(old_text)) >= DEDUPE_JACCARD
            });
            match dup {
                Some(old) => {
                    // Teks yang lebih panjang biasanya lebih informatif.
                    let old_len = old.get("text").and_then(|t| t.as_str()).map(|t| t.chars().count()).unwrap_or(0);
                    if text.chars().count() > old_len {
                        old["text"] = json!(text);
                    }
                    if let Some(t) = old.get_mut("ts") {
                        *t = json!(now);
                    }
                }
                None => {
                    entries.push(json!({
                        "id": entry_id(),
                        "text": text,
                        "tags": tags,
                        "ts": now,
                        "hits": 0,
                        "lastHit": 0,
                    }));
                    added += 1;
                }
            }
        }
        // Cap: buang terlemah sampai muat. Kekuatan = (hits, lastHit) — entri
        // yang jarang dipakai dan lama tak disentuh dikorbankan lebih dulu.
        while entries.len() > MAX_ENTRIES {
            let weakest = entries.iter().enumerate().min_by_key(|(_, e)| {
                let hits = e.get("hits").and_then(|h| h.as_i64()).unwrap_or(0);
                let last = e
                    .get("lastHit")
                    .and_then(|h| h.as_i64())
                    .filter(|h| *h > 0)
                    .unwrap_or_else(|| e.get("ts").and_then(|t| t.as_i64()).unwrap_or(0));
                (hits, last)
            });
            let Some((idx, _)) = weakest else { break };
            entries.remove(idx);
        }
    }
    let total = f["entries"].as_array().map(|a| a.len()).unwrap_or(0);
    let _ = save(data_dir, &f);
    json!({ "added": added, "updated": updated, "total": total })
}

/// Format hasil retrieve() sebagai teks untuk agent/tool — entri terurut
/// relevansi, dengan id supaya pemanggil bisa mereferensikannya.
pub fn entries_as_text(v: &Value) -> String {
    let arr = v.get("entries").and_then(|e| e.as_array());
    let Some(arr) = arr else {
        return "(memori tidak tersedia)".into();
    };
    if arr.is_empty() {
        return "(tidak ada memori user yang relevan)".into();
    }
    let lines: Vec<String> = arr
        .iter()
        .map(|e| {
            let id = e.get("id").and_then(|i| i.as_str()).unwrap_or("");
            let text = e.get("text").and_then(|t| t.as_str()).unwrap_or("");
            format!("- [{}] {}", id, text)
        })
        .collect();
    lines.join("\n")
}

/// Catat akses (retrieve menghitung hits + lastHit untuk kebijakan eviksi).
fn mark_hits(data_dir: &Path, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    let mut f = load(data_dir);
    let now = now_ms();
    if let Some(entries) = f["entries"].as_array_mut() {
        for e in entries.iter_mut() {
            let id = e.get("id").and_then(|i| i.as_str()).unwrap_or("");
            if ids.contains(&id.to_string()) {
                if let Some(h) = e.get_mut("hits") {
                    *h = json!(h.as_i64().unwrap_or(0) + 1);
                }
                if let Some(lh) = e.get_mut("lastHit") {
                    *lh = json!(now);
                }
            }
        }
    }
    let _ = save(data_dir, &f);
}

/// Lupakan satu entri ({id}) atau semua ({all:true}). Return jumlah terhapus.
pub fn forget(data_dir: &Path, id: &str, all: bool) -> usize {
    let mut f = load(data_dir);
    let mut removed = 0usize;
    {
        let entries = f["entries"].as_array_mut().unwrap();
        if all {
            removed = entries.len();
            entries.clear();
        } else if !id.is_empty() {
            let before = entries.len();
            entries.retain(|e| e.get("id").and_then(|i| i.as_str()) != Some(id));
            removed = before - entries.len();
        }
    }
    if removed > 0 {
        let _ = save(data_dir, &f);
    }
    removed
}

// ── Keputusan latar ber-LLM (role "memory") ─────────────────────────────

fn turn_lines(turns: &[Value], max_turns: usize, max_chars_per_turn: usize) -> String {
    turns
        .iter()
        .rev()
        .take(max_turns)
        .rev()
        .filter_map(|t| {
            let role = t.get("role").and_then(|r| r.as_str()).unwrap_or("user");
            let content = t.get("content").and_then(|c| c.as_str()).unwrap_or("").trim();
            if content.is_empty() {
                return None;
            }
            Some(format!("{role}: {}", take_chars(content, max_chars_per_turn)))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// POST /api/companion/intent — pesan user ini TUGAS (perlu agent mengerjakan)
/// atau OBROLAN biasa? Keputusan berdasar makna keseluruhan; keyword tidak
/// pernah memutuskan sendiri. Fail-soft → isTask:false (chat biasa).
pub async fn decide_intent(config_path: &Path, text: &str, summary: &str, recent: &[Value]) -> Value {
    let text = take_chars(text.trim(), 800);
    if text.is_empty() {
        return json!({ "isTask": false, "task": "", "reason": "teks kosong" });
    }
    let summary_block = if summary.trim().is_empty() {
        String::new()
    } else {
        format!("\nRINGKASAN PERCAKAPAN SEJAUH INI:\n{}\n", take_chars(summary, 1200))
    };
    let recent_block = {
        let lines = turn_lines(recent, 6, 300);
        if lines.is_empty() {
            String::new()
        } else {
            format!("\nGILIRAN TERAKHIR:\n{lines}\n")
        }
    };
    let prompt = format!(
        "Kamu adalah pengklasifikasi intent untuk companion Live2D. Tentukan apakah \
pesan user di bawah adalah PERMINTAAN TUGAS — user mengharapkan assistant \
mengerjakan sesuatu (mencari/membandingkan informasi, membuat atau mengubah \
file/kode, mengecek error, merapikan, dsb.) — atau OBROLAN biasa (ngobrol, \
bercanda, bertanya hal yang cukup dijawab dengan bicara, diskusi opini).\
{summary_block}{recent_block}\n\
PESAN TERBARU USER:\n\"{text}\"\n\n\
ATURAN:\n\
- Kata kerja seperti \"cari/cek/tolong/bikin\" TIDAK otomatis berarti tugas; \
baca MAKSUD keseluruhan kalimat. \"Restoran favoritmu apa?\" = chat walau ada \
kata makanan; \"carikan aku restoran yang enak\" = tugas.\n\
- Pertanyaan pengetahuan yang cukup dijawab langsung = chat, bukan tugas.\n\
- Kalimat melanjutkan topik tanpa meminta tindakan = chat.\n\n\
KEMBALIKAN HANYA satu objek JSON valid, tanpa markdown, skema:\n\
{{ \"isTask\": true|false, \"task\": \"perintah ulang singkat tugas bila isTask, selain itu kosongkan\", \"reason\": \"alasan singkat\" }}"
    );
    let msgs = vec![crate::llm::ChatMessage {
        role: "user".into(),
        content: prompt,
    }];
    match crate::llm::llm_for_role(config_path, "memory", &msgs, "").await {
        Ok(ok) => {
            let parsed = jsonx::extract_json_object_loose(&ok.reply).unwrap_or(json!({}));
            let is_task = parsed.get("isTask").and_then(|b| b.as_bool()).unwrap_or(false);
            let task = parsed
                .get("task")
                .and_then(|t| t.as_str())
                .map(|t| take_chars(t.trim(), 500))
                .unwrap_or_default();
            let task = if is_task && task.is_empty() { text.clone() } else { task };
            json!({
                "isTask": is_task,
                "task": if is_task { task } else { String::new() },
                "reason": parsed.get("reason").and_then(|r| r.as_str()).map(|r| take_chars(r, 200)).unwrap_or_default(),
            })
        }
        Err((_, msg)) => json!({ "isTask": false, "task": "", "reason": take_chars(&msg, 200) }),
    }
}

/// POST /api/companion/summarize — gabungkan ringkasan lama + blok giliran
/// menjadi satu ringkasan padat. Fail-soft → ringkasan lama dipertahankan.
pub async fn summarize_session(config_path: &Path, prior: &str, turns: &[Value]) -> Value {
    let transcript = turn_lines(turns, 60, 700);
    if transcript.trim().is_empty() {
        return json!({ "summary": prior, "ok": true });
    }
    let prior_block = if prior.trim().is_empty() {
        String::new()
    } else {
        format!("RINGKASAN LAMA:\n{}\n\n", take_chars(prior, 1200))
    };
    let prompt = format!(
        "{prior_block}BLOK PERCAKAPAN BARU:\n{transcript}\n\n\
Gabungkan keduanya menjadi SATU ringkasan padat (maks ±250 kata) untuk konteks \
companion di giliran berikutnya. WAJIB dipertahankan bila ada: keputusan yang \
disepakati, preferensi user, fakta penting tentang user/proyek/lingkungan, hal \
yang sedang dikerjakan, topik yang masih terbuka, janji/rencana. Buang \
sapaan, basa-basi, dan pengulangan. Kembalikan HANYA teks ringkasannya — \
tanpa pengantar, tanpa format markdown."
    );
    let msgs = vec![crate::llm::ChatMessage {
        role: "user".into(),
        content: prompt,
    }];
    match crate::llm::llm_for_role(config_path, "memory", &msgs, "").await {
        Ok(ok) => {
            let s = ok.reply.trim();
            if s.is_empty() {
                json!({ "summary": prior, "ok": false })
            } else {
                json!({ "summary": take_chars(s, 1600), "ok": true })
            }
        }
        Err((_, _)) => json!({ "summary": prior, "ok": false }),
    }
}

/// POST /api/companion/memory/extract — ekstraksi memori layak-ingat dari
/// giliran sejak ekstraksi terakhir. Langsung disimpan (dedupe di store).
/// Fail-soft → entries kosong.
pub async fn extract_and_store(config_path: &Path, data_dir: &Path, turns: &[Value]) -> Value {
    let transcript = turn_lines(turns, 40, 600);
    if transcript.trim().is_empty() {
        return json!({ "entries": [], "added": 0 });
    }
    // Daftar memori lama BESERTA id-nya supaya LLM bisa menandai entri yang
    // perlu diperbarui saat informasi baru mengubah/mensanggah yang lama.
    let existing = load(data_dir);
    let existing_block = {
        let arr = existing["entries"].as_array().cloned().unwrap_or_default();
        if arr.is_empty() {
            "(masih kosong)".to_string()
        } else {
            arr.iter()
                .rev()
                .take(30)
                .filter_map(|e| {
                    let id = e.get("id").and_then(|i| i.as_str())?;
                    let text = e.get("text").and_then(|t| t.as_str())?;
                    Some(format!("- [{}] {}", id, take_chars(text, 160)))
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
    };
    let prompt = format!(
        "Kamu mengekstrak MEMORI JANGKA PANJANG dari percakapan user dengan \
companion Live2D. Pilih HANYA informasi yang berguna untuk percakapan di masa \
depan: preferensi user, keputusan yang dibuat, fakta penting tentang \
user/proyek/lingkungan, hal yang sedang dikerjakan. JANGAN ambil basa-basi, \
sapaan, obrolan sesaat, komentar cuakan, atau yang sudah tercakup MEMORI LAMA. \
Batch ini TIDAK otomatis menjadi memori — hanya item yang benar-benar layak \
yang akan disimpan.\n\n\
MEMORI LAMA (id dalam kurung; jangan duplikat isinya):\n{existing_block}\n\n\
PERCAKAPAN:\n{transcript}\n\n\
ATURAN KONSISTENSI:\n\
- Informasi baru yang MENGUBAH atau MENSANGGAH memori lama (user pindah kota, \
berhenti hobi, preferensi berubah, keputusan dicabut) → kembalikan FAKTA \
TERBARU dan sertakan \"replacesId\": \"<id memori lama>\" pada item itu.\n\
- Fakta baru yang tidak terkait memori lama → item biasa tanpa replacesId.\n\n\
KEMBALIKAN HANYA array JSON valid, tanpa markdown, tiap item:\n\
{{ \"text\": \"<satu fakta ringkas berdiri sendiri>\", \"tags\": [\"<topik>\"], \"replacesId\": \"<opsional>\" }}\n\
Bila tidak ada yang layak diingat, kembalikan []."
    );
    let msgs = vec![crate::llm::ChatMessage {
        role: "user".into(),
        content: prompt,
    }];
    match crate::llm::llm_for_role(config_path, "memory", &msgs, "").await {
        Ok(ok) => {
            let raw = jsonx::extract_json_array_loose(&ok.reply);
            let items: Vec<Value> = raw
                .iter()
                .filter_map(|e| {
                    let (text, tags) = sanitize_entry(e)?;
                    let mut item = json!({ "text": text, "tags": tags });
                    if let Some(rid) = e.get("replacesId").and_then(|r| r.as_str()) {
                        item["replacesId"] = json!(rid);
                    }
                    Some(item)
                })
                .collect();
            let res = add_entries(data_dir, &items);
            json!({
                "entries": items,
                "added": res["added"].clone(),
                "updated": res["updated"].clone(),
            })
        }
        Err((_, _)) => json!({ "entries": [], "added": 0, "updated": 0 }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "l2dcmem-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn tokenize_lintas_bahasa_dan_case() {
        assert_eq!(
            tokenize("Aku mau cari Restoran Jepang!"),
            vec!["aku", "mau", "cari", "restoran", "jepang"]
        );
        // Jepang: token per-run alfanumerik unicode, bukan per-byte.
        assert_eq!(tokenize("ラーメンを食べる"), vec!["ラーメンを食べる"]);
        assert!(tokenize("a ! ?").is_empty());
    }

    #[test]
    fn add_dedupe_dan_sanitasi() {
        let d = tmpdir("dedupe");
        let r = add_entries(
            &d,
            &[
                json!({ "text": "User alergi seafood, jangan sarankan menu laut.", "tags": ["makanan", "kesehatan"] }),
                json!({ "text": "" }), // kosong → dibuang
                json!({ "text": "ab" }),     // < 3 char → dibuang
            ],
        );
        assert_eq!(r["added"], json!(1));
        // Mirip (Jaccard tinggi) → dedupe, tidak nambah.
        let r2 = add_entries(
            &d,
            &[json!({ "text": "User alergi seafood — jangan pernah sarankan menu laut ke dia." })],
        );
        assert_eq!(r2["added"], json!(0));
        assert_eq!(r2["total"], json!(1));
        let f = load(&d);
        assert_eq!(f["entries"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn retrieve_skor_idf_dan_tanpa_query_terbaru() {
        let d = tmpdir("retrieve");
        add_entries(
            &d,
            &[
                json!({ "text": "User sedang mengerjakan aplikasi musik dengan Rust." }),
                json!({ "text": "User tidak suka komentar bertele-tele." }),
                json!({ "text": "Deadline proyek musik tanggal 20." }),
            ],
        );
        let r = retrieve(&d, "proyek musik", 6);
        let arr = r["entries"].as_array().unwrap();
        assert!(arr.len() >= 2, "harus menemukan entri bertopik musik");
        assert!(arr[0]["text"].as_str().unwrap().contains("musik"));
        // Tanpa query → terbaru dulu, semua entri dicantumkan sampai limit.
        let r2 = retrieve(&d, "", 10);
        assert_eq!(r2["entries"].as_array().unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn retrieve_menandai_hits_untuk_eviksi() {
        let d = tmpdir("hits");
        let r = add_entries(&d, &[json!({ "text": "User pakai keyboard mechanical biru." })]);
        assert_eq!(r["added"], json!(1));
        retrieve(&d, "keyboard mechanical", 5);
        let f = load(&d);
        let e = &f["entries"].as_array().unwrap()[0];
        assert_eq!(e["hits"], json!(1));
        assert!(e["lastHit"].as_i64().unwrap() > 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn cap_120_buang_terlemah() {
        let d = tmpdir("cap");
        for i in 0..MAX_ENTRIES {
            // Tiap entri punya beberapa token UNIK supaya tidak kena dedupe
            // (threshold Jaccard 0.7) — yang berbeda hanya pola tokennya.
            add_entries(
                &d,
                &[json!({ "text": format!("fakta unik i{i} alpha{i} beta{i} gamma{i} delta{i} tentang kebun") })],
            );
        }
        // Buat entri pertama "kuat" dengan banyak hits.
        retrieve(&d, "fakta unik i0 alpha0", 5);
        add_entries(&d, &[json!({ "text": "fakta baru masuk i999 tentang akuarium laut dalam" })]);
        let f = load(&d);
        let arr = f["entries"].as_array().unwrap();
        assert_eq!(arr.len(), MAX_ENTRIES);
        // Entri kuat (pernah diakses) harus bertahan.
        assert!(
            arr.iter().any(|e| e["text"].as_str().unwrap().contains("i0 ")),
            "entri dengan hits tertinggi tidak boleh terbuang"
        );
        // Entri baru harus masuk (ada yang dikorbankan dari yang lama).
        assert!(arr.iter().any(|e| e["text"].as_str().unwrap().contains("i999")));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn forget_satu_dan_semua() {
        let d = tmpdir("forget");
        add_entries(
            &d,
            &[
                json!({ "text": "memori satu tentang kopi" }),
                json!({ "text": "memori dua tentang teh" }),
            ],
        );
        let f = load(&d);
        let id = f["entries"][0]["id"].as_str().unwrap().to_string();
        assert_eq!(forget(&d, &id, false), 1);
        assert_eq!(load(&d)["entries"].as_array().unwrap().len(), 1);
        assert_eq!(forget(&d, "m_tidak_ada", false), 0);
        assert_eq!(forget(&d, "", true), 1);
        assert_eq!(load(&d)["entries"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn round_trip_disk_dan_normalize_basi() {
        let d = tmpdir("disk");
        add_entries(&d, &[json!({ "text": "User prefers dark mode.", "tags": ["ui"] })]);
        // Tulis sampah → normalize membuang entri rusak, tidak panic.
        std::fs::write(
            store_path(&d),
            r#"{"entries":[{"text":"ok ini valid"},{"text":""},{"id":"tanpa_teks"}]}"#,
        )
        .unwrap();
        let f = load(&d);
        assert_eq!(f["entries"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn jaccard_dan_score_entry_murni() {
        let a = token_set("user suka kopi pagi");
        let b = token_set("user suka kopi sore");
        assert!(jaccard(&a, &b) > 0.5);
        assert_eq!(jaccard(&a, &HashSet::new()), 0.0);
        let e = json!({ "text": "user suka kopi", "ts": 0, "hits": 0, "lastHit": 0 });
        let q = token_set("kopi");
        let df = std::collections::HashMap::new();
        assert!(score_entry(&e, &q, &df, 1, now_ms()) > 0.0);
        assert_eq!(score_entry(&e, &token_set("teh"), &df, 1, now_ms()), 0.0);
    }

    #[test]
    fn replaces_id_mengubah_entri_dan_kontradiksi() {
        let d = tmpdir("replaces");
        // Memori lama yang nanti disanggah user.
        let r1 = add_entries(&d, &[json!({ "text": "User tinggal di Jakarta dan suka kopi susu." })]);
        assert_eq!(r1["added"], json!(1));
        let old_id = load(&d)["entries"][0]["id"].as_str().unwrap().to_string();

        // Koreksi: user pindah kota + berhenti kopi → REPLACE, bukan tambah.
        let r2 = add_entries(
            &d,
            &[json!({
                "text": "User sekarang tinggal di Bandung dan berhenti minum kopi.",
                "replacesId": old_id,
            })],
        );
        assert_eq!(r2["added"], json!(0));
        assert_eq!(r2["updated"], json!(1));
        let entries = load(&d)["entries"].as_array().unwrap().to_vec();
        assert_eq!(entries.len(), 1, "entri lama diganti, tidak bertumpuk");
        assert_eq!(entries[0]["id"].as_str().unwrap(), old_id);
        assert!(entries[0]["text"].as_str().unwrap().contains("Bandung"));
        assert!(!entries[0]["text"].as_str().unwrap().contains("Jakarta"));

        // replacesId tak dikenal → fail-soft: masuk sebagai entri baru.
        let r3 = add_entries(
            &d,
            &[json!({ "text": "User mulai kursus piano.", "replacesId": "m_tidak_ada" })],
        );
        assert_eq!(r3["added"], json!(1));
        assert_eq!(load(&d)["entries"].as_array().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn extract_garbage_tidak_menulis_store() {
        // Provider mock membalas teks non-JSON → ekstraksi gagal → fail-soft:
        // TIDAK ada entri yang dipaksa masuk. Ini bukti batch percakapan tidak
        // otomatis jadi memori — tulis hanya bila LLM memang mengirim item.
        let d = tmpdir("extractgarbage");
        let cfg = d.join("config.json");
        std::fs::write(&cfg, r#"{"activeId":"m","connections":[{"id":"m","provider":"mock"}]}"#).unwrap();
        let res = extract_and_store(
            &cfg,
            &d,
            &[
                json!({ "role": "user", "content": "halo halo" }),
                json!({ "role": "assistant", "content": "halo juga!" }),
            ],
        )
        .await;
        assert_eq!(res["added"], json!(0));
        assert_eq!(res["entries"].as_array().unwrap().len(), 0);
        assert_eq!(load(&d)["entries"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn summarize_tidak_pernah_menyentuh_store() {
        // Ringkasan sesi = context client, BUKAN long-term memory: fungsi ini
        // bahkan tidak menerima path store — test memastikan tidak ada file
        // yang tertulis dan store tetap kosong setelahnya.
        let d = tmpdir("summarizepure");
        let cfg = d.join("config.json");
        std::fs::write(&cfg, r#"{"activeId":"m","connections":[{"id":"m","provider":"mock"}]}"#).unwrap();
        let res = summarize_session(
            &cfg,
            "",
            &[json!({ "role": "user", "content": "aku putuskan pakai PostgreSQL" })],
        )
        .await;
        // mock selalu membalas teks → summary terisi (stateless, return value),
        // tapi TIDAK ada tulisan ke store memori.
        assert!(res["summary"].as_str().map(|s| !s.is_empty()).unwrap_or(false));
        assert!(!store_path(&d).exists(), "summarize tidak boleh menulis store");
        assert_eq!(load(&d)["entries"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn entries_as_text_bawa_id_dan_kosong() {
        let v = retrieve(&tmpdir("asText"), "", 3);
        assert_eq!(entries_as_text(&v), "(tidak ada memori user yang relevan)");
        let v2 = json!({ "entries": [
            { "id": "m_1", "text": "User alergi seafood", "tags": [], "ts": 1, "score": 1.0 },
        ] });
        let t = entries_as_text(&v2);
        assert!(t.contains("[m_1]"), "{t}");
        assert!(t.contains("User alergi seafood"));
    }
}
