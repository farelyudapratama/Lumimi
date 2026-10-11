# CHANGELOG

> Format mengikuti [Keep a Changelog](https://keepachangelog.com/) +
> [SemVer](https://semver.org/). Bahasa kerja repo ini Indonesia; commit dan
> entri di sini ikut konvensi itu.
>
> Catatan kalibrasi: angka `2.0.0` yang sempat hidup di manifest adalah klaim
> internal "parity v1→v2" (arsip Bun lama), bukan klaim rilis publik — produk
> belum pernah punya trace rilis (nol tag). Rilis pertama yang ditandai
> karena itu mulai dari `0.1.0`.

## [0.1.2] — 2026-10-12

### Added
- **Agent Workbench dibangun ulang clean-slate ala ZCode** (`src/client/agent/panel/`): dock presence resizable dengan collapse/expand eksplisit, tab dock, transcript/term-log/registry model murni; Fase 3–4 plus visual rework.
- **Plan-approval gate** — rencana agent wajib disetujui user sebelum mutasi pertama; allowlist izin sesi ("selalu izinkan") di kartu approval; kartu approval login.
- **Streaming chat SSE + tombol Stop** — balasan chat mengalir token-demi-token; stop membatalkan end-to-end.
- **Harness agent tangguh** — scheduler antar-task, cancel end-to-end, verifikasi hasil, store observability (`/api/assistant/runs`).
- **API Management terpusat di core** — routing per role, `enabled` eksplisit per koneksi, panel AI baru (daftar koneksi + rencana routing read-only).
- **Dukungan native function-calling** — model FC (gpt-oss dkk.) memanggil tool lewat jalur native provider; tak lagi 400 "tool called a tool".
- **Multi-session assistant** — fungsionalitas antar-sesi + UI.
- **Preferensi engine browser terkontrol** (auto/edge/chrome) + deteksi captcha advisory.
- **Companion** — bubble dihapus, respons penuh di chat; TTS panjang tak terpotong lagi.
- **Filter chat penonton (moderasi komentar)** — komentar audience VTuber kini disaring dua lapis sebelum diproses LLM: blocklist kata/frasa milik user (instan, gratis) dan mesin keputusan opsional via role baru `moderation`. Mesin keputusan memprioritaskan koneksi SystemOne (Jev cloud / Laya lokal) lewat endpoint `v1/systemone` (pola yang sama dengan role `behavior`), fallback ke LLM mana pun yang ditandai role `moderation` eksplisit. Komentar ditahan tetap tampil di feed plus alasan, tapi tidak dibalas; mesin gagal/timeout → fail-open (komentar diteruskan) supaya stream tidak mati. Panel "Filter Chat" baru di tab AI (toggle, blocklist, aturan tambahan bebas) menyimpan via action `saveChatFilter` pada `/api/config`.

### Fixed
- Transport: handshake token instalasi + self-heal port loopback di exe.
- Browser CDP yang ditutup user di-auto-relaunch (task agent tak menggantung lagi); guard auto-relaunch menutup pintu `browser_open` (task browser selalu "CDP terputus"); pesan error jujur & actionable — LLM tak lagi mengarang "ga ada internet"/"tidak aman".
- Panel: transcript re-sync saat task masuk dari luar panel; todo stale tak tampil lagi; spinner berjalan abadi dihapus; model diarahkan jaga status plan; tab dock tanpa scrollbar — label collapse ke ikon saat dock sempit.

### Tests
- Gate hijau penuh: unit bun 611, guard 326, cargo 277 (+11 test filter chat), tsc, build.

## [0.1.1] — 2026-10-04

### Added
- **Memory companion dua lapis** — session context di RAM (jendela terakhir +
  retrieval potongan lama berdasar relevansi + kompresi bergulir via LLM) dan
  long-term memory persisten (`data/companion-memory.json`): retrieval
  relevansi di sisi server, dedupe, `replacesId` untuk koreksi/kontradiksi,
  forget satu/semua, eviksi entri terlemah. Balasan assistant kini ikut masuk
  context; limit efektif 24-pesan dihapus — percakapan panjang tetap menemukan
  konteks awal lewat recent + ringkasan + retrieval.
- **Routing intent chat→agent tanpa command** — gerbang recall longgar +
  klasifikasi makna oleh LLM (role baru `memory`, bisa di-bind ke model murah
  di panel koneksi); tugas diteruskan ke Agent lengkap dengan ringkasan sesi
  + memori relevan; gagal LLM/429 → jatuh ke chat biasa (fail-soft).
- **Tool `memory_recall`** (safe, read-only) di agent — memori companion jadi
  infrastruktur shared: agent bisa menarik fakta user sendiri saat tugas
  membutuhkannya.
- Endpoint `/api/companion/*`: memory (GET/POST/forget/extract), intent,
  summarize.

### Fixed
- Tombol "Clear" chat kini benar-benar mengosongkan sesi otak — dulu hanya
  mengganti referensi properti di `window.__agent`, array internal brain tetap
  terisi. Long-term memory tidak ikut terhapus.

### Tests
- Gate hijau penuh: unit bun 563 (+4), cargo 201 (+5), guard 324, tsc, build.
- Verifikasi E2E lewat browser: binding role `memory` dari panel koneksi
  (simpan → reload → persist), handoff tugas sampai hasil agent muncul di
  chat, clear chat mengosongkan sesi.

## [0.1.0] — 2026-09-24

Rilis pertama dengan trace: tag git + changelog. Merangkum seluruh sejarah
sejak commit awal 2026-08-29 (252 commit).

### Added
- **Lumimi.exe** — satu exe satu proses: shell Tauri (WebView2) meng-host
  backend Rust (`core/`, axum HTTP loopback) secara in-process; dobel-klik
  menyalakan server dan jendela sekaligus.
- **Agent bawaan** sebagai fitur produk: loop obrolan, 21 tool (file, kode,
  perintah dengan kartu persetujuan + cancel), directive gerak `[EMOTION:]`
  yang menggerakkan model lewat MotionRuntime, proaktif saat idle, menyapa
  saat user pergi/balik, deteksi mood dari webcam (inferensi 100% lokal).
- **4 mode runtime** — `stage` (dasar), `vtuber`, `assistant`, `pet`
  (overlay klik-tembus) — satu pintu `POST /api/mode` dengan teardown penuh.
- **Suara lokal** — TTS SuperTonic (4 model ONNX via `ort`) dan STT Whisper
  (`whisper-rs`) jalan in-process di core; mode `browser` sebagai fallback
  tanpa unduhan model.
- **Dukungan model agnostik** — Cubism 4/5 apa pun tinggal impor folder
  `.model3.json`; kemampuan model diukur dari disk (Inspeksi Model), bukan
  dari daftar nama; sistem sheet (`user` > `ai`) dengan re-inspeksi aman.
- **Pipeline motion** — LLM memilih id semantik; `motion-dsl` sebagai satu-
  satunya sanitizer; MotionRuntime pemutar tunggal (priority + blend +
  watchdog rAF); Motion Taxonomy mengklasifikasi klip `.motion3.json`.
- **Panel agent** ala IDE (stream/transcript/diff) dan **Motion Studio**
  untuk mengedit gerak.
- **i18n** id + en (parity dijaga test); protokol directive tetap Indonesia.
- **Transport IPC per-domain** bertahap (core_version, server_port, mode) —
  HTTP loopback tersisa untuk adapter eksternal (CLI/OBS/dev).
- **Landing page statis** (`landing/`) + aset identitas brand.
- **Rilis portable Windows** — `bun run dist` merakit `dist/Lumimi/` +
  installer Inno Setup per-user (tanpa admin).

### Changed
- Rename brand penuh `Live2D Agent`/`Companion` → **Lumimi** (binary, crate
  shell `lumimi`, identifier `com.lumimi.app`, folder rilis, installer,
  ikon).
- Runtime backend pindah Bun → Rust; arsip `src/server/` (Bun) dihapus.
- Renderer satu jalur: **Pixi 8 + Cubism SDK Framework 5-r.5** (teruji Core
  6.0.1); stack Pixi 6 + pixi-live2d + MOC-hack dipensiunkan.

### Removed
- PixiJS 6 dari runtime — `emotion-overlay` diport ke Canvas 2D murni.
- Binary sidecar engine (TTS/STT kini library in-process), `start.bat`
  (digantikan dobel-klik exe), dependensi non-runtime (playwright).

### Gate (terverifikasi pada commit ini)
- 420 unit test TS + 362 guard legacy (7 suite) + 115 test Rust
  (109 core + 6 engine) + `tsc --noEmit` + build — hijau.
- Tanpa test yang memanggil jaringan atau menulis `data/config.json`.

[0.1.0]: https://github.com/farelyudapratama/live2d-agent/releases/tag/v0.1.0
