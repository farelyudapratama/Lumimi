# ARCHITECTURE — Tauri + Rust Core (selesai, kontrak berlaku)

> **Status (2026-09-29): TARGET TEREKSEKUSI PENUH — dokumen ini kini dibaca
> sebagai kontrak arsitektur yang berlaku, bukan rencana migrasi.** `Lumimi.exe`
> = satu binary satu proses: Tauri + Rust core (library, in-process) + frontend
> ter-embed (frontendDist → binary). Transport INTERNAL WebView↔Rust = perintah
> IPC per-domain, bertahap (single source of truth = fungsi `live2d_core`;
> handler HTTP memakai fungsi yang sama). HTTP/Axum loopback dipertahankan
> HANYA sebagai adapter eksternal (CLI, OBS `vtuber.html`, dev browser) +
> jembatan transisi domain yang belum migrasi (CORS permisif, loopback saja).
> Render loop Live2D/PixiJS tetap 100% di WebView — tanpa IPC per-frame.
> Backend penuh di `core/src/` (Rust); Bun = alat build/dev saja.
>
> Sumber niat: arah "Tauri + Rust Application Core + TypeScript/Live2D Frontend"
> yang disetujui user. Prinsip inti:
> **Rust memiliki aplikasi. TypeScript memiliki WebView & rendering. LLM tetap
> provider eksternal yang bisa diganti.**

---

## 1. Bukan tujuan (Non-Goals)

Jangan tafsirkan arah ini sebagai "semua harus jadi Rust". Yang **eksplisit
BUKAN** tujuan:

1. Menulis ulang renderer Live2D di Rust.
2. Mengganti / memindahkan PixiJS 8 ke Rust.
3. Memindahkan render loop Live2D lewat Tauri IPC.
4. **Menaruh IPC di jalur per-frame** (setParameter 30/60/120 FPS lewat IPC).
5. Menanam runtime inferensi LLM + model ke dalam exe utama.
6. Menghapus TypeScript hanya karena Rust masuk.
7. Rewrite big-bang.
8. Memakai migrasi Rust sebagai "obat" masalah performa render.

Performa render diselesaikan di pipeline render (Cubism → adapter → Pixi 8 →
WebGL → compositing), **bukan** dengan memindah logika backend ke Rust.

---

## 2. Keputusan yang dikunci (user)

> **REVISI 2026-09-22 (setelah temuan §6b + tujuan single-exe user).** Tujuan
> akhir user yang mengikat: **satu berkas executable** — bukan Bun & Tauri jalan
> sebagai dua proses terpisah seperti sekarang. Ini menetapkan arah:

0. **PRODUK AKHIR = SATU EXE (`Lumimi.exe`).** Tidak ada proses Bun terpisah
   di produksi. Ini menutup opsi "pertahankan server Bun" — Bun hanya alat dev.

1. **PRODUK AKHIR = SATU EXE SATU PROSES (`Lumimi.exe`).** Shell Tauri
    me-link server Rust dan menjalankannya **in-process**
    (`agent-shell/src/main.rs::ensure_server` — thread runtime tokio sendiri,
    root path dari lokasi exe / cwd dev). Frontend **di-embed ke binary**
    (`frontendDist: ../static`; `WebviewUrl::App` → origin lokal → command
    aplikasi diizinkan — temuan blokir-origin IPC §6b tak berlaku).
    Transport internal = **IPC per-domain, bertahap**: command shell selubung
    tipis atas fungsi `live2d_core` (handler HTTP memakai fungsi yang SAMA —
    single source of truth). HTTP loopback = adapter EKSTERNAL (CLI, OBS,
    dev) + jembatan domain-belum-migrasi. **Tak ada exe server kedua, tak ada
    sidecar.** `window.__TAURI__` untuk IPC + kontrol jendela native
    (pet overlay) — BUKAN untuk API per-frame (render loop tetap di WebView).

2. **HTTP loopback = arsitektur inti (bukan sekadar kompat).** Karena server
   Rust in-process memang berbicara HTTP loopback, klien mandiri (CLI agent,
   overlay OBS `vtuber.html`, akses HP via `HOST=0.0.0.0`) tetap didukung
   gratis — mereka konsumen dari server Rust yang sama, di dalam satu exe.
3. **engine/ diabsorb in-process.** Sidecar Whisper + SuperTonic (crate
   `engine/`) jadi **library** yang dipanggil langsung dari Rust core. Hilang:
   port 8330, spawn/health/`ensureSidecarHasStt` restart-dance, satu proses.
4. **Renderer tetap TypeScript.** `src/live2d/*`, `src/client/*`,
   `static/js/app.js`, MotionRuntime, ParameterArbiter — tidak pindah.

---

## 3. Arsitektur target

```
Lumimi.exe — SATU exe, SATU proses (semuanya dalam satu proses OS)
├─ Tauri
│   ├─ WebView2 → frontend JS ter-embed (PixiJS + Live2D, MotionRuntime, panel)
│   │    ├─ Render loop 100% lokal (tanpa IPC per-frame)
│   │    └─ src/client/transport/ — SEAM TUNGGAL
│   │         domain termigrasi → invoke() IPC · sisanya → HTTP loopback
│   └─ Rust Core (in-process, thread tokio) — core/src
│        ├── Agent (loop + tool + gate) · LLM (multi-provider + fallback)
│        ├── Memory (lintas sesi) · Tools · Browser (CDP)
│        ├── TTS/STT native (lib live2d-engine) · Persistence (config/sheet)
│        ├── Command IPC: core_version · server_port · pet_model ·
│        │   get_mode · set_mode (+ domain berikut bertahap)
│        └── HTTP loopback (axum, PORT/HOST, CORS) → ADAPTER EKSTERNAL:
│             CLI · OBS vtuber.html · dev browser · jembatan transisi
└─ Dobel-klik kedua menempel ke instance pertama bila port sudah dilayani
   server milik kita — tanpa server baru. Jendela pet = window Tauri KEDUA
   ("pet") dalam PROSES yang sama (via /api/pet/launch → bridge
   register_pet_host; tutup-oleh-user → notify_closed). Fallback spawn
   proses/browser hanya bila core jalan TANPA shell (dev).
```

### Aturan migrasi IPC per-domain (mengikat)

Setiap domain yang pindah HTTP → IPC WAJIB sekaligus:
1. Command di `agent-shell/src/main.rs` = selubung tipis atas fungsi
   `live2d_core` (JANGAN duplikat logika; handler HTTP tetap memakai fungsi
   yang sama — itu adapter eksternalnya).
2. Helper bernama di `src/client/transport/` (modeGet/modeSet/…) — JANGAN
   `invoke` mentah di call-site (satu titik cabut jembatan).
3. Call-site lama dialihkan ke helper; guard/test menyertakan domain itu.
4. Jembatan HTTP sementara (fallback + console.warn) dicabut per-domain
   setelah migrasi terbukti di build nyata — bukan sekaligus di akhir.
5. Render loop / per-frame TIDAK PERNAH lewat IPC (invarian tetap).

### Frame Loop Rule (KRITIS)

Rust hanya mengeluarkan **directive semantik** ("emotion: happy, gaze {x,y},
motion: idle"). Frontend yang menerjemahkan ke animasi/parameter/blend/render,
seluruhnya lokal. Tidak pernah `setAngleX()`/`setParameter()` lewat IPC.

```
LLM → Agent/Decision (Rust) → Companion Directive → HTTP loopback → Frontend
    → CompanionPolicy → MotionRuntime → ParameterArbiter → Live2D → Pixi → WebGL
```

---

## 4. Kondisi awal — SEJARAH (2026-09-29)

Bagian ini mendeskripsikan kondisi pra-migrasi (0 command IPC, server Bun,
port sidecar 8330, ±60 situs fetch). Diarsipkan; riwayat lengkap ada di git.
Yang masih berlaku sebagai fakta arsitektur kini: klien HTTP mandiri
(`vtuber.html`, `pet.html`, `src/cli/agent.ts`) + kopling motion-dsl TS↔Rust
yang wajib sepadan + choke point path data — semuanya diringkas di §5 dan
peta kode `AGENTS.md`.

---

## 5. Kontrak yang WAJIB utuh lintas migrasi (invarian)

Setiap stage harus mempertahankan semuanya; kalau berubah, itu regresi.

- **Format file data byte-compatible:** `data/config.json` (atomic tmp+rename,
  merge per-id koneksi, `runtimeOverrides`, apiKey plaintext di disk & di-MASK
  ke antarmuka dengan placeholder `MASUKKAN…` / `••••`),
  `data/assistant-sessions.json` (`{active, sessions:[{id,name,workDir,ts,
  messages}]}`, cap 20×60), `.agent-memory/memory.json` (di akar app, cap
  100×1200 char), cache `data/sheets/*` (stamp `scannerVersion`).
- **Replay ber-kursor:** events assistant & vtuber bisa diminta `since=0` untuk
  replay dari ring buffer (assistant bus 120 event ber-seq). Migrasi
  polling→push WAJIB hybrid: replay awal via kursor + push live.
- **Kosakata event stream panel** persis: `delta / tool_call / tool_result /
  approval / speak / done{ok,reply,error,parked,taskId,position,paused}` +
  semantik fallback `decideFallback` dua-kasus (`src/client/agent/panel/
  stream.ts`).
- **Model-Agnostic** (docs/MODEL-AGNOSTIC-RULES.md): TIDAK ADA id param
  bernomor / nama model / range spesifik di Rust core; makna param hanya lewat
  role space. Logika penyimpulan harus tetap benar setelah semua nama diganti.
- **Sistem sheet** (docs/SHEET-SYSTEM.md): `user > ai` mutlak; `paramGroups` ≠
  `presets`; angka hanya dari engine.
- **Mode** (docs/MODES.md): satu mode aktif; teardown dulu saat pindah mode.
- **Motion** (docs/MOTION-SYSTEM-SPEC.md): LLM hanya memilih id semantik; sanitize
  satu pintu; runtime satu pemutar. **Frame loop tidak lewat IPC.**
- **Keamanan/privasi** (AGENTS.md §5): loopback default; body cap; guard
  traversal; frame webcam tak pernah keluar; audio mic default loopback lokal,
  cloud hanya bila user pilih sadar.
- **Guard legacy** ikut di-update di commit yang sama saat kontrak berubah
  (guard menguji kode asli via `vm` — bukan salinan).

---

## 6. Roadmap bertahap

> **CATATAN satu-exe (2026-09-22):** roadmap Stage 0–5 di bawah adalah SEJARAH
> eksekusi. Kondisi akhir MELAMPAUI rencana: bukan "dua proses sementara" —
> server Rust hidup **in-process di dalam `Lumimi.exe`** (satu proses OS).
> `bun run dev/start` = `cargo run -p live2d-core` (dev via browser), produk =
> `Lumimi.exe`. Jangan memulai stage "pindah rute / sidecar / IPC" baru.
> Sisa pekerjaan adalah stabilisasi + packaging, bukan migrasi.

Aturan: **tiap stage meninggalkan aplikasi tetap fungsional + gate hijau**
(`bun run build` + `bunx tsc --noEmit` + `bun run test` + `cargo test` untuk
crate yang tersentuh). Tiap stage punya definisi "selesai" sendiri dan boleh
berhenti aman di situ.

> **REVISI transport (2026-09-22, demi single-exe).** Mekanisme pengganti server
> Bun bukan Tauri IPC melainkan **server HTTP Rust in-process (axum) di dalam
> Tauri**. Jadi Stage 2–4 "pindah ke Rust" = **port rute Bun → handler axum**
> (bukan command IPC), wire tetap HTTP loopback → frontend tak perlu ditulis
> ulang. Stage 5 (frontendDist embed + buang exe Bun) = titik di mana produk
> jadi **satu `Lumimi.exe`**. Tiap rute yang sudah diport dilayani server
> Rust; selama transisi, rute yang belum diport masih oleh Bun (dua proses
> SEMENTARA di dev) — single-exe tercapai saat SEMUA rute pindah + frontendDist.
> `src/client/transport/` yang sudah ada tetap seam-nya; ia cukup diarahkan ke
> server in-process (default sekarang: HTTP loopback, tak berubah).

### Stage 0–5 — SELESAI SEMUA (2026-09-29)

Roadmap migrasi tereksekusi penuh; kondisi akhir melampaui rencana (satu
proses, §2). Detail tiap stage dihapus; riwayat lengkap ada di git. Jangan
memulai stage migrasi baru dari bagian ini — sisa pekerjaan = stabilisasi +
packaging.

Aturan yang TETAP BERLAKU dari roadmap: **tiap perubahan meninggalkan
aplikasi fungsional + gate hijau** (`bun run build` + `bunx tsc --noEmit` +
`bun run test` + `cargo test` untuk crate yang tersentuh).

---

## 6b. TEMUAN IPC (spike Stage 1 — mengubah urutan migrasi)

Diverifikasi headless (server + jendela Tauri nyata + diagnostik):

- `window.__TAURI__.core.invoke` ADA, command `app_info` ter-registrasi
  (`generate_handler!`), tapi invoke **ditolak**: `"app_info not allowed.
  Plugin not found"`.
- Akar masalah (dibaca dari `tauri-2.11.6/src/ipc/authority.rs::resolve_access`):
  otorisasi command difilter `origin.matches(&cmd.context)`. Shell memuat
  frontend via `WebviewUrl::External("http://127.0.0.1:8310")` → origin
  **Remote**. Command app default konteksnya **Local**, dan capability yang
  cuma berisi permission `core:*` tidak memberi command app ke origin remote.
  Menambah `remote.urls` ke capability pun tak menolong: command app **tidak
  punya identifier permission** (dicek: tak ada di `gen/schemas`), jadi tak bisa
  didaftarkan sebagai permission bercakupan-remote.

**Konsekuensi (load-bearing):** selama frontend disajikan oleh server HTTP
(origin remote), **Tauri IPC untuk command app tidak bisa dipakai.** Ini
membalik urutan rencana: **frontend harus disajikan LOKAL oleh Tauri**
(`frontendDist` → origin `tauri://`/`http://tauri.localhost`) SEBELUM IPC-first
bisa jalan. Artinya "packaging frontendDist" (dulu Stage 5) menjadi
**prasyarat Stage 1**, bukan langkah akhir.

**Dampak ke arsitektur "shell load External URL":** model saat ini (shell =
`WebviewUrl::External` ke server Bun) harus berubah jadi Tauri menyajikan aset
frontend lokal, dan server HTTP turun peran jadi *compat adapter* (untuk CLI
agent + OBS overlay + akses HP) — persis niat "HTTP = kompatibilitas opsional",
tapi transisinya harus lebih awal.

**Yang SUDAH terbukti jalan:** frontend penuh (Live2D + Pixi + TTS/STT) berjalan
mulus di dalam jendela Tauri via HTTP (origin remote) — "model muncul, suara
keluar". Jadi HttpTransport (mode kompatibilitas) valid; hanya jalur IPC yang
menuntut origin lokal.

**Keputusan (histori):** revisi "satu-jalur HTTP" 2026-09-22 sempat menghapus
Tauri IPC untuk API. **Keputusan itu SUDAH DISUSUL** oleh revisi berikutnya
(header dokumen §atas + §2b): produk kembali memakai `frontendDist` (aset
ter-embed, `WebviewUrl::App` → origin lokal) **dan** IPC per-domain.

**Kondisi NYATA sekarang** (terverifikasi di kode):
- `agent-shell/tauri.conf.json` → `frontendDist: "../static"`, `withGlobalTauri: true`.
- `agent-shell/src/main.rs` → `invoke_handler` dengan 6 command:
  `core_version`, `server_port`, `pet_model`, `get_mode`, `set_mode`,
  `import_model_dialog` (dialog folder native rfd + salin folder oleh core —
  import model tanpa upload base64 lewat WebView).
- `src/client/transport/index.ts` → helper IPC per-domain (`initLoopback` via
  `server_port`, `modeGet`/`modeSet` via `get_mode`/`set_mode`, `coreVersion`,
  `modelImportDialog`), dengan HTTP loopback sebagai jembatan transisi +
  adapter eksternal (CLI/OBS/dev). **Jaminan koneksi exe + handshake
  (2026-10-05):** port loopback tidak pernah diasumsikan — IPC `server_port`
  + `server_token` dulu, lalu port DIVERIFIKASI lewat handshake `/api/version`
  (`core_version` ada DAN `instance` == token instalasi dari
  `live2d_core::instance_token`, deterministik per root app); bila gagal →
  probe 8310..8399 dengan syarat token cocok — rentang WAJIB sinkron dengan
  kandidat `pick_port` di shell. Server asing ATAU instalasi Lumimi lain
  (portabel lama vs installer, dev vs exe) tidak pernah ditempeli meski
  menjawab di port yang sama; dobel-klik kedua pada instalasi yang sama tetap
  bisa attach (token sama). Kegagalan resolve tidak di-cache (boleh dicoba
  ulang); `apiFetch` embedded yang kena kegagalan koneksi re-resolve port
  sekali lalu mengulang request bila basis berganti (self-heal untuk kasus
  historis "browser bisa, exe engga" saat server tergeser dari 8310).
  `pet.html` memakai handshake yang sama (cermin mandiri — halaman itu tidak
  memuat bundle.js). Dev/browser tidak tersentuh (same-origin by
  construction).

Jadi jalur internal = IPC per-domain (domain yang sudah migrasi) + HTTP loopback
untuk sisanya; frontend TIDAK di-serve via `WebviewUrl::External`. §6b tinggal
sebagai catatan sejarah temuan teknis (blokir-origin IPC pada origin remote).

## 7. Risiko — SELESAI (2026-09-29)

Tabel risiko migrasi dihapus; mitigasinya sudah jadi arsitektur final di
atas. Riwayat lengkap ada di git. Risiko operasional yang masih hidup
tinggal di `TROUBLESHOOTING.md`.

---

## 8. Definisi sukses

```
Development : Bun + Tauri + Rust + TypeScript  → jalan normal
Production  : Lumimi.exe                      → pengalaman lengkap, 1 exe
Internal    : Rust = core/backend/native
              TypeScript = UI + Live2D + Pixi + presentation
              LLM = layanan eksternal yang bisa diganti
```

Dan rantai ini tetap bersih & terpisah:

```
LLM → Agent/Decision → Semantic Directive → HTTP loopback → Frontend
    → MotionRuntime → ParameterArbiter → Live2D → PixiJS 8 → WebGL
```

Proyek **bukan** menjadi "renderer Rust". Proyek menjadi *aplikasi desktop
Tauri yang core native-nya Rust, lapisan presentasi/render-nya tetap TypeScript
+ PixiJS 8 + Live2D, dan LLM-nya layanan eksternal yang bisa diganti* — satu
exe utama dari sisi user, fleksibel di provider LLM, dengan render Live2D
real-time yang sepenuhnya lokal di frontend.
