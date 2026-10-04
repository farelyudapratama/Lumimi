# AGENTS.md: Panduan AI Agent untuk repo ini

> **File ini untuk siapa pun yang mengerjakan kode Lumimi: kontributor manusia
> maupun AI agent** (ZCode, Claude Code, Cursor, dsb.). `README.md` adalah
> perkenalan produk untuk pengguna; begitu kamu mulai mengubah kode, file ini
> bersama `docs/` jadi acuan kerja yang **mengikat**. `README.md` sendiri menunjuk
> kontributor ke sini. Jika dokumen dan kode bertentangan, **kode yang benar;
> perbaiki dokumennya.**

> **Branding (rename dieksekusi 2026-09-24).** Produk bernama **Lumimi**. Identitas
> build sudah ikut: `productName` Tauri = `Lumimi`, binary `Lumimi.exe`, crate shell
> `lumimi` (dibangun `-p lumimi`), `identifier` `com.lumimi.app`, `name` di
> `package.json` = `lumimi`, folder rilis `dist/Lumimi/` plus `dist/Lumimi-Setup.exe`.
> Yang sengaja TETAP: crate internal `live2d-core` dan `live2d-engine` (nama teknis,
> bukan brand), dan kelas speech `companion`/`companion_proactive` (istilah perilaku
> di `speech-policy.ts`, bukan nama produk).

## Ringkasan proyek

Aplikasi Live2D yang dikendalikan AI: karakter Cubism 4/5 **apa pun** di
`data/model/<nama>/` dianimasikan oleh agent. Dia ngobrol (teks atau STT),
bergerak (directive → MotionRuntime), bersuara (TTS), proaktif saat idle, membaca
mood dari webcam, dan punya mode dasar `stage` plus 3 mode (VTuber, Assistant,
Pet). Backend **Rust** (`core/`, axum HTTP loopback) di-host **in-process di dalam
shell Tauri** (`agent-shell/`): produk = **satu exe satu proses** (`Lumimi.exe`;
dobel-klik menyalakan server dan jendela sekaligus). Inti logika **TypeScript**
(`src/`) di-bundle ke `static/js/bundle.js`, `static/js/live2d-view.mjs`, dan
`static/js/i18n.js`; driver karakter dan UI di `static/js/app.js` (dijaga guard).
**Bun = alat build/dev saja** (bundle, test, tsc), bukan runtime. Renderer satu
jalur: **Pixi 8 + Cubism SDK Framework 5-r.5** (teruji dengan Core 6.0.1) di
`src/live2d/view/`; stack lama (Pixi 6 + pixi-live2d) sudah dipensiunkan.

Produk ini juga membawa **agent-nya sendiri** sebagai fitur (loop, 25 tool,
dan permission gate di `core/src/agent/`). Jangan tertukar: itu kode produk, bukan instruksi untukmu.

## Urutan baca wajib (mengikat)

| # | Dokumen | Baca sebelum… |
|---|---------|---------------|
| 1 | [`docs/MODEL-AGNOSTIC-RULES.md`](docs/MODEL-AGNOSTIC-RULES.md) | menyentuh **apa pun** yang menyimpulkan makna parameter/role/motion |
| 2 | [`docs/SHEET-SYSTEM.md`](docs/SHEET-SYSTEM.md) | menyentuh sheet, preset, migrasi, atau analisa LLM |
| 3 | [`docs/MOTION-SYSTEM-SPEC.md`](docs/MOTION-SYSTEM-SPEC.md) | menyentuh pipeline motion / Motion Studio |
| 4 | [`docs/MODES.md`](docs/MODES.md) | menyentuh mode, runtime, atau teardown |
| 5 | [`docs/ARSITEKTUR-TARGET.md`](docs/ARSITEKTUR-TARGET.md) | menyentuh kontrak perilaku (concurrency, speech ownership, proactive gate, lifecycle request) — HANYA §§1–18 + §§32–34 + §36; sisanya arsip |
| 6 | [`docs/ARCHITECTURE-TAURI-RUST.md`](docs/ARCHITECTURE-TAURI-RUST.md) | menyentuh **apa pun** terkait backend Rust / shell Tauri / transport (IPC per-domain untuk domain yang sudah migrasi; HTTP loopback = adapter eksternal + jembatan transisi) |
| 6 | `docs/STATUS-CUBISM5-EFEK.md` (LOKAL, di-gitignore — handoff sesi pribadi, bukan acuan contributor) | **awal sesi lokal**: baca entri teratas bila file ada · **akhir sesi**: tambah entri baru (tetap lokal, jangan di-push) |
| 7 | [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | debugging perilaku yang dilaporkan user |

## Perintah & definisi "selesai"

```bash
bun run build          # WAJIB sebelum run: static/js/bundle.js di-gitignore
bun run test           # SEMUA TS: 457 unit (bun, 28 file) + 302 guard (5 suite)
bun run test:unit      # hanya unit test TS
bun run test:guards    # hanya guard legacy
bunx tsc --noEmit      # type-check (harus bersih)
cargo test --workspace # backend Rust (179 test: 173 core + 6 engine), bagian gate
```

**Selesai** = build bersih + `tsc` bersih + `bun run test` hijau + `cargo test
--workspace` hijau. Tidak ada test yang memanggil jaringan (endpoint LLM di-stub
ke provider `mock`) dan tidak ada test yang menulis `data/config.json`;
pertahankan begitu.

## Rilis produksi (build yang diedarkan)

`bun` cuma penjalan skrip; yang meng-compile Rust selalu `cargo`. Urutan rilis:

```bash
bun run setup:core     # WAJIB sekali: unduh Cubism Core ke static/ (dist TIDAK mengunduhnya)
bun run dist           # bundle frontend + cargo build --release -p lumimi + rakit dist/Lumimi/ + installer
```

Hasil: `dist/Lumimi/` (portable: `Lumimi.exe` + `static/` + BACA-SAYA.txt) dan, bila
Inno Setup 6 terpasang, `dist/Lumimi-Setup.exe` (installer per-user, tanpa admin).
`bun run build:pet` (`bunx @tauri-apps/cli build`) hanya meng-compile exe-nya saja;
`bun run dist` yang merakit paket lengkap.

Jebakan yang harus diingat:

- **Core diunduh terpisah.** `bun run dist` cuma mem-bundle frontend, tidak memanggil
  `setup:core`. Kalau `static/js/live2dcubismcore.min.js` belum ada, paket terkirim tanpa
  Core dan panggung mati di mesin user. Jalankan `setup:core` (atau `bun run build`) dulu.
- **STT native tidak ikut default.** `dist` memanggil cargo tanpa `--features engine-stt`,
  jadi rilis dapat TTS SuperTonic tapi bukan STT Whisper native (STT mode `browser` tetap
  jalan). Untuk mengikutkan STT native, tambah flag itu di `src/dist.ts` (mesin build butuh
  cmake + LLVM/libclang).
- **Versi terpusat di `0.1.0`.** Satu versi produk dipakai di `package.json`,
  `agent-shell/tauri.conf.json`, dan ketiga `Cargo.toml` (plus fallback di
  `installer.iss`). `installer.iss` mengambil versi dari `package.json`, exe Tauri
  dari `tauri.conf.json`, dan `live2d_core::VERSION` (IPC `core_version` + `/api/version`)
  dari `core/Cargo.toml` lewat `env!("CARGO_PKG_VERSION")`. Saat menaikkan versi, ubah
  semua tempat itu bersama dan jalankan `cargo update --workspace` untuk `Cargo.lock`.
- **Trace rilis = tag + changelog.** Angka manifest saja bukan trace. Setiap rilis
  ditandai annotated tag `v<semver>` dan punya entri di [`CHANGELOG.md`](CHANGELOG.md);
  ketiganya (bump versi, entri changelog, tag) dibuat pada commit yang sama.
- **Per-OS + writable.** Build untuk OS host (Windows-only sekarang). Folder portable harus
  di lokasi yang bisa ditulis (bukan Program Files) karena `data/` ditulis di samping exe;
  installer sudah memakai `%LOCALAPPDATA%\Programs\Lumimi` yang writable.

## Aturan inti (ringkasan; detail wajib di dokumen masing-masing)

1. **Model-agnostic.** Tidak ada id bernomor (`Param91`), nama model, atau range
   spesifik di tabel universal; makna tidak boleh diambil dari indeks array
   (`lipSyncIds[0]`); menulis ke parameter **hanya lewat role space**
   (`pokeRoleRef` / `pokeRoleNorm` / `roleDefault`) yang memetakan skala referensi
   ke range model; kemampuan model diukur dari **disk**, bukan hanya manifest.
   → [`docs/MODEL-AGNOSTIC-RULES.md`](docs/MODEL-AGNOSTIC-RULES.md)
2. **Sistem sheet.** `user` > `ai` **mutlak** (re-inspeksi tidak boleh menghapus
   tulisan user); `paramGroups` ≠ `presets`, dua struktur, jangan digabung;
   benturan nama gerak dicegah saat **simpan**; angka hanya dari engine (LLM tidak
   pernah boleh mengirim range). → [`docs/SHEET-SYSTEM.md`](docs/SHEET-SYSTEM.md)
3. **Motion.** Satu pipeline: LLM hanya memilih id semantik plus properti tingkat
   tinggi, **tidak** boleh menyentuh id param Live2D langsung; `motion-dsl`
   satu-satunya sanitize; runtime satu-satunya pemutar (priority + blend + watchdog
   rAF). → [`docs/MOTION-SYSTEM-SPEC.md`](docs/MOTION-SYSTEM-SPEC.md)
4. **Mode.** Satu mode aktif; `POST /api/mode` satu-satunya pintu; pindah mode
   berarti **teardown dulu** runtime lama (interval/WS/feed/riwayat, client dan
   server) sebelum menyalakan yang baru; mode non-aktif tidak diproses sama sekali.
   → [`docs/MODES.md`](docs/MODES.md)
5. **Keamanan & privasi.** `data/config.json` tidak pernah disajikan via HTTP;
   bind loopback default; batas body per endpoint; guard path traversal; **frame
   webcam TIDAK PERNAH di-upload** (inferensi kamera 100% lokal, aturan tak
   berubah). **Audio mic** (revisi 2026-09-21): default STT provider `local` =
   whisper in-process di server Rust **loopback 127.0.0.1** (proses lokal, bukan
   jaringan); provider `browser` = 100% dalam tab; provider cloud HANYA bila user
   memilihnya sadar. Cloud tak pernah default.

## Aturan kerja

- **Satu exe satu proses.** Produk = `Lumimi.exe`: Tauri + Rust core (library,
  in-process via `ensure_server`) + frontend ter-embed (`frontendDist`). Transport
  internal = IPC per-domain bertahap (aturan di `ARCHITECTURE-TAURI-RUST.md`
  §aturan-migrasi: selubung tipis atas `live2d_core` + helper bernama di
  `transport/` + jembatan dicabut per-domain). HTTP loopback = adapter EKSTERNAL
  (CLI/OBS/dev) plus jembatan transisi; jangan jadikan jalur internal baru. Render
  loop / per-frame tidak pernah lewat IPC. `src/server/` sudah **DIHAPUS** (Batch A
  2026-09-23); seluruh backend ada di `core/src/`, tambah rute/fitur di sana.
- **Satu jalur render.** Stack lama (Pixi 6 + pixi-live2d) sudah dipensiunkan;
  jangan menambah cabang dual-stack. Kepemilikan gerak: framework memutar
  motion/ekspresi/physics/pose plus efek blink/breath/gaze/lipsync (updater ber-gate
  di `Live2DUserModel`); app.js menyumbang liveliness/emosi secara **aditif** lewat
  `pokeAddParam`, jangan menulis SET absolut di atas param yang sama di luar
  aiLock/motion-layer.
- **Panel agent** sudah TS (`src/client/agent/panel/`); `mode-runtime.js` hanya
  bridge `window.__agentPanel.start()`, logic panel baru ditulis di TS.
- **Guard menguji kode asli.** Guard legacy mengekstrak fungsi dari `app.js` via
  `vm`, bukan salinan. Saat mengubah kontrak fungsi yang dijaga, guard ikut
  diperbarui di commit yang sama, bukan dihapus.
- **Invariansi nama.** Logika penyimpulan makna harus tetap benar setelah semua
  nama diganti (`m_001`, hash, bahasa lain). Guard sudah menguji ini (role-mapping);
  kalau menambah logika baru, uji ulang dengan nama yang diganti, dan bila
  distribusi hasilnya kolaps berarti logikanya masih bergantung nama.
- **i18n.** String UI baru wajib ada di **kedua** kamus (`src/client/i18n/`, id +
  en); parity dan coverage dijaga `test/i18n.test.ts`. Kosakata directive
  (`[EMOTION:]` dst.) tetap Indonesia, itu protokol antar-komponen.
- **Bahasa kerja.** Komentar kode, commit, dan dokumen: Indonesia —
  pengecualian: `README.md` berbahasa Inggris (etalase utama) dengan
  padanannya `README-ID.md`. Issue/PR/diskusi bahasa Inggris welcome.
  Pesan commit gaya conventional plus deskripsi Indonesia (lihat `git log`): `feat(ui): …`,
  `fix(core): …`, `docs: …`, `test: …`, `refactor: …`, `chore: …`.

## Jebakan yang sering terjadi

- Lupa `bun run build` → `bundle.js` dan `live2d-view.mjs` tidak ada (dua-duanya
  di-gitignore) → chat **dan panggung** mati (agent degrade gracefully, bukan crash).
- Hardcode `127.0.0.1:8310` → pakai `location.origin` (frontend) atau `appRoot()`
  (`src/shared/paths.ts`, akar app dev vs exe compile).
- Menulis angka literal ke param role (bypass skala) → gagal senyap, karakter datar;
  rig `eyeOpen` 0..100 menerima nilai `1` sebagai 1% terbuka.
- Timeout absolut pada LLM streaming → pakai **idle timeout** (reset per chunk) saat
  `conn.stream=true`.
- Thinking model (mis. gemini-2.5) memakan budget output untuk reasoning → JSON
  terpotong; gunakan `salvageJSONArrayOfObjects` plus warning eksplisit.
- Sheet di disk adalah **cache scan**, bukan sumber kebenaran; kalau logika
  role-mapping berubah, sheet lama basi dan perlu re-scan.

## Peta kode

```text
core/                        backend Rust (axum, loopback), SATU-SATUNYA backend
                             (src/server/ dihapus Batch A 2026-09-23; logika + testnya
                             semua di core/src/)
  motion_analysis.rs         analisis motion model dari DISK: range observasi,
                             base pose, output physics3 (angka hanya dari engine)
  motion_validation.rs       validator independen draft Motion Asset (advisory;
                             sanitize tetap gerbang akhir)
  agent/motion_tools.rs      tool motion agent bawaan: motion_analyze /
                             motion_validate / motion_save / motion_verify
                             (loop analisis → desain → validasi → verifikasi
                             visual → simpan dengan approval)
  motion_vision.rs           critic visual: harness render → filmstrip 8 frame
                             → LLM role `motion-vision` (koneksi HARUS
                             ditandai eksplisit; model harus menerima gambar)
  companion_memory.rs        memory jangka panjang companion (data/
                             companion-memory.json) + keputusan latar role
                             "memory": intent chat→agent, ringkas sesi,
                             ekstraksi memori — semua fail-soft. Agent membaca
                             lewat tool memory_recall (shared, read-only).
                             Session context (RAM) ada di src/client/agent/
                             companion-memory.ts (lihat MODES.md)
static/harness-motion.html   halaman harness render critic visual (juga
src/client/harness/          entry build ke-4 harness-motion.mjs) — capture
                             sinkron canvas.toDataURL, tanpa rAF/kompositor
agent-shell/                 SATU exe SATU proses: host server Rust in-process
                             (`ensure_server`) + 6 command IPC (core_version,
                             server_port, pet_model, get_mode, set_mode,
                             import_model_dialog)
src/client/transport/        seam transport: HTTP (apiBase/apiUrl/apiFetch/getJson/
                             postJson) + helper IPC per-domain (modeGet/modeSet/
                             coreVersion/modelImportDialog/initLoopback)
src/shared/                  types, config, llm-client (role routing)
src/client/animation/        easing, motion-dsl, motion-io (dua arah .motion3.json),
                             motion-registry, motion-runtime
src/client/engine/           motion-taxonomy (klasifikasi klip .motion3.json),
                             native-clips (daftar per-file + alias rename),
                             role-mapping (inferensi role), native-expressions
src/client/agent/            brain + directive-parser → window.__agent
src/client/agent/panel/      panel agent (remake ala ZCode): stream/transcript/
                             actor/view/panel/diff/md/registry → window.__agentPanel
src/client/browser/          control plane browser preview/CDP → window.__browserPanel
src/client/shell/            rail projek shell (sesi & project) → window.__shellProjek
src/client/i18n/             core i18n zero-dep + kamus id/en
src/build.ts                 bundle-entry → static/js/bundle.js (IIFE)
src/dist.ts                  bun run dist, rakit dist/Lumimi/ (exe + static)
src/cli/agent.ts             bun run agent, REPL Assistant di terminal
src/live2d/                  renderer satu jalur: Pixi 8 + Cubism 5-r.5 (teruji Core 6.0.1)
  view/                      Live2DView (facade + backend tulis) + framing + entry
  Live2DUserModel.ts         pipeline update dua fase + updater efek ber-gate
  Live2DRenderer.ts          draw, tekstur, role/arbiter, setGazeGain
  cubism/                    Cubism Framework 5-r.5 vendored + PATCH renderOrders/blend
static/js/app.js             driver karakter & UI (±9.800 baris), dijaga guard
static/js/mode-runtime.js    switcher mode; panel assistant tinggal bridge
                             window.__agentPanel
static/js/{voice-input,motion-editor,camera-presence}.js
test/                        bun test (unit): frontend TS (motion/i18n/transport/brain)
test/legacy/                 guard legacy: mengekstrak fungsi app.js via vm
data/                        data user, TIDAK di-commit
```

## Jangan

- ❌ Commit `data/` (model berlisensi, `config.json` berisi apiKey, sheet user,
  `.agent-memory/`) atau output build (`static/js/bundle.js`, `static/js/i18n.js`);
  semuanya di-gitignore, jangan dipaksa masuk.
- ❌ Menyetel parameter hanya untuk model yang sedang dites.
- ❌ Menambah regex/id khusus satu model (begitulah 7 pola khusus Ichika dulu
  menyusup).
- ❌ Menggabungkan `paramGroups` dan `presets` jadi satu.
- ❌ Melewatkan teardown saat pindah mode.
- ❌ Mengirim frame webcam ke server/provider mana pun (tetap mutlak).
- ❌ Mengirim audio mic ke **cloud** sebagai default; loopback lokal (whisper
  in-process di core) boleh, cloud HANYA bila user memilih provider cloud sadar.
- ❌ Memperbaiki balik aturan yang terkunci di `docs/`; kalaupun kelihatan bisa
  disederhanakan, itu sudah dibalik orang dan punya alasan.





