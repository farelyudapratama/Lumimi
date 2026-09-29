# docs/MODES.md — Sistem 3 Mode (VTuber / Assistant / Pet)

Dokumen mengikat untuk arsitektur mode. Aturan di sini menopang UI baru tanpa
membongkar inti lama.

## Aturan inti (terkunci)

1. **Satu mode aktif.** `POST /api/mode {mode}` pintu pindah mode di jalur
   HTTP; di shell Tauri pintu yang sama tersedia sebagai IPC `set_mode`
   (helper `modeSet` di `src/client/transport/`, HTTP sebagai jembatan
   transisi). Mode yang sah: `stage` (default) / `vtuber` / `assistant` / `pet`.
2. **Pindah mode = teardown dulu.** `handleModePost` memanggil `teardownMode(modeLama)`
   **sebelum** mengaktifkan mode baru: vtuber → `vtuberStop()` (WS/interval server),
   assistant → `assistantStop()` (riwayat & approval dibuang), pet → `petClose()`
   (jendela overlay ditutup). Client melakukan hal yang sama di
   `static/js/mode-runtime.js` (`destroyFn()` + `clearInterval(pollTimer)` +
   `__live2dAgent.stopSpeaking()` — bicara aktif & antrean speech ikut mati,
   lihat policy speech di `src/client/speech/speech-policy.ts`).
3. **Mode non-aktif tidak diproses sama sekali** — tidak ada polling, tidak ada
   interval, tidak ada feed yang berjalan di latar. Termasuk otak proaktif:
   event idle/away/return/mood dari companion ditekan saat mode aktif bukan
   `stage` atau saat task Worker berjalan — gate `proactiveAllowed()` di
   `reactEvent()` (brain.ts) membaca `/api/mode` SEBELUM memanggil LLM.
4. Status gabungan selalu bisa dibaca: `GET /api/mode` →
   `{active, vtuber, assistant, pet}`.

## Shell 4 kolom (2026-09-07)

Layout app ala coding-agent: `[activity+projek/history][stage Live2D][conversation][technical pane]`.

- **Activity bar** (`<nav id="activity">`): switcher mode vertikal — id
  `mode-switch` + tombol `data-mode` DIPERTAHANKAN agar wiring
  `mode-runtime.js` tak berubah; tombol projek membuka rail.
- **Rail projek/history** (`#projek-rail`, dibangun `src/client/shell/projek.ts`
  → `window.__shellProjek`): indikator project (basename workdir) + riwayat
  sesi assistant (lihat seksi Multi-session). Activity + rail dibungkus
  `#left-workspace` sebagai kolom konteks pertama.
- **Stage Live2D** tetap kolom kedua; sizing otomatis (`stageSize()` membaca
  `#stage.clientWidth`).
- **Conversation** = `#sidebar` di dalam `#agent-workspace`; state/TASK,
  transcript, quick actions, dan composer tetap terlihat.
- **Technical pane** = `#agent-tech`: tab Review, Terminal, Browser yang
  benar-benar fungsional. Combined workspace resizable 650–1200px.
- Breakpoint `<1280px`: technical pane ditumpuk di bawah conversation dan
  gutter desktop mati; `<1024px`: shell menjadi vertikal.

## Multi-session assistant (2026-09-07)

Riwayat sesi bernama di `data/assistant-sessions.json`
(`{active, sessions: [{id, name, workDir, ts, messages}]}`, cap 20 sesi,
migrasi sekali dari `assistant-history.json` lama + arsip `.bak`):

- Store: `core/src/agent/sessions.rs` (`sessions::load/create/switch_to/remove` —
  path injectable untuk test). Auto-nama sesi = pesan user pertama
  (40 char), fallback tanggal. Tulis atomic tmp→rename.
- API: `GET /api/assistant/sessions`, `POST /api/assistant/sessions/new
  {workDir?}`, `POST /api/assistant/sessions/switch {id}`,
  `POST /api/assistant/sessions/delete {id}` — semua menolak saat `busy`
  (409/404 sesuai kasus).
- **Pindah sesi TIDAK mematikan runtime** (kontrak mode utuh): facade
  mengganti `rt.history`/`rt.workDir`/`rt.sessionId` lalu persist. Panel
  menangkap event DOM `agent:session-changed` (dilempar `projek.ts`) dan
  hydrate ulang transcript dari `/history`.
- `loadSession`/`saveSession` (state.ts) kini wrapper store — CLI
  `bun run agent` ikut membuka sesi aktif tanpa perubahan.

## Cancel per-task & status global (2026-09-07 (2))

- **Cancel kooperatif**: `POST /api/assistant/cancel` menyetel
  `rt.cancelRequested` (hanya saat `busy` → `{ok,accepted}`); loop mengecek
  flag di awal tiap turn & setelah `execTool` kembali — tool yang sedang
  jalan selesai dulu (`run_command` ≤30 dtk), lalu reply
  "Dibatalkan oleh user." + bus `error "dibatalkan: oleh user"`. Runtime
  TIDAK dimatikan (beda dengan `POST /api/assistant/stop` yang membongkar
  runtime & approval). Panel: tombol "Stop Task" (`#as-cancel`), aktif
  saat `running && (busy || liveAsk)`.
- **Metadata tool**: `GET /api/assistant/status` menyertakan
  `tools: [{name, level}]` (dari registry `TOOLS`) — panel menampilkan
  badge "auto" (safe) / "izin" (mutating) di header kartu tool & approval.
- **Status global**: tombol Assistant di activity bar diberi `data-agent`
  (off/idle/busy/approval) dari poll `/status` 4 dtk (`projek.ts`) — status
  agent terlihat tanpa membuka panel. Pill panel punya state tambahan
  `approval` (dari `pendingApprovals` — saat loop pause untuk izin,
  `busy=false`, jadi sumbernya bukan busy).
- Side panel resizable via `#sb-gutter` (drag 320–900px, persist
  localStorage, dobel-klik = reset); quick actions 4 shortcut di composer
  (teks i18n = prompt, dikirim apa adanya).

### Hierarki Agent Workspace (2026-09-07 (5))

Panel Assistant tidak lagi diperlakukan sebagai form konfigurasi + chat.
Hierarkinya dikunci menjadi tiga lapisan:

1. **Apa yang agent kerjakan** — state row + kartu TASK hero. Pesan user
   terakhir (`Transcript.currentTask`) menjadi judul tugas; `status.plan`
   tampil sebagai checklist live (pending/in-progress/done/failed + progres).
2. **Apa yang benar-benar dikerjakan** — transcript/activity yang padat,
   tool/diff/verifikasi, serta tab Review dan Terminal.
3. **Intervensi user** — quick actions tenang + composer command di bawah.

Chrome lama (judul Assistant, label Folder kerja besar, hint panjang) dibuang;
workspace + cancel/stop/reset/memory menjadi satu utility row. Composer memakai
placeholder identitas karakter (`Tanya {name}…`) dan tombol kirim `↑`.

Karakter bukan viewer terpisah: `GET /api/assistant/status` menyertakan field
additive `lastEvent: {type,label}|null`; `projek.ts` menampilkan
`#stage-agent-chip` hanya saat busy/approval (`Bekerja — write_file …`) dan
menyembunyikannya saat idle. Akting ekspresi/pose tetap dari `actor.ts`.

## AI VTuber (`core/src/vtuber.rs`)

| Provider | Kredensial | Sumber event |
|---|---|---|
| `mock` | tidak perlu | interval 6 dtk: chat acak; setiap ke-5 donasi |
| `twitch` | nama channel (token opsional — anonim `justinfan`) | IRC `wss://irc-ws.chat.twitch.tv:443`; CAP tags; PING→`PONG :tmi.twitch.tv`; PRIVMSG diparse (tags `display-name` menang); auto-reconnect 5 dtk |
| `youtube` | API key + video ID yang sedang live | `videos.list(liveStreamingDetails)` → `activeLiveChatId` → poll `liveChatMessages.list` (part `snippet,authorDetails`), hormati `pollingIntervalMillis` (min 5 dtk); `superChatEvent`/`superStickerEvent` → **donasi** |

Endpoint: `POST /api/vtuber/start|stop`, `GET /api/vtuber/events?since=<id>`
(ring buffer 500 event), `POST /api/vtuber/mock-event` (simulasi dari UI),
`POST /api/vtuber/config` (persona/cooldown/flag respond live tanpa restart),
`POST /api/vtuber/operator` (instruksi streamer → antrean operator §7).

Behavior engine (`core/src/vtuber_scheduler.rs`, §7 ARSITEKTUR-TARGET):
SATU scheduler di server — audience chat = suppression (dedup 30 dtk +
cooldown `#vt-cooldown`), donasi = antrean FIFO-20 (penuh → item baru
DITOLAK dengan feedback feed, tidak silent-evict), operator = antrean
sendiri (masuk walau respond mati); satu active slot — donation selalu
didahulukan dari operator, item aktif tidak dipreempt; LLM role "chat"
server-side, slot ditahan selama estimasi bicara (`speech-timing`).
Balasan masuk feed sebagai event `agent`. Dua klien hanya render+speech:
app utama memutar balasan via `window.__debugSpeak` (kelas speech
"vtuber") selama overlay OBS tidak on-air (heartbeat `/api/vtuber/overlay`
→ `overlay:true`); `vtuber.html` (overlay, stack render baru Pixi 8 +
Cubism 5) memutar sendiri versinya saat on-air.

## AI Assistant (`core/src/agent/assistant.rs`)

- Runtime: `{workDir, history (maks 60), approvals Map, activeTask, parkedTasks,
  pendingReplacement, busy}`.
- **Task identity (§9–12 ARSITEKTUR-TARGET)**: worker bukan sekadar `busy`
  — tiap request = `taskId (t_n)`. Satu slot aktif (`activeTask`); task baru
  saat slot dipegang **di-park** (antrean FIFO cap 20; penuh → item baru
  ditolak eksplisit; prompt tidak masuk history sebelum task jalan). Pause
  approval **tetap memegang slot** (status `awaiting_approval`, busy hidup) —
  task baru di-park, resume melanjutkan task yang sama tanpa lewat gerbang.
  `POST /api/assistant/cancel {taskId?}`: running → kooperatif, paused →
  terminal langsung, parked → dikeluarkan spesifik. `POST
  /api/assistant/modify {taskId, text}`: replacement mewarisi posisi
  (aktif → cancel kooperatif + pendingReplacement; paused → langsung;
  antrean → in-place). Slot kosong → drain otomatis (replacement dulu,
  lalu antrean FIFO). Status mengekspos `activeTask`/`parkedTasks`.
- Tools (registry di `core/src/agent/loop_.rs` (TOOLS), **25 tool**; level = data,
  bukan if-else di loop): 12 tool coding (`list_dir`, `read_file`, `search_code`,
  `git_diff`, `write_file`, `edit_file`, `delete_file`, `run_command`,
  `update_plan`, `remember`, `recall`, `spawn_subagent`) + 9 tool browser CDP
  (`browser_status/open/navigate/inspect/click/type/history/close/grant_private`)
  + 4 tool motion (`motion_analyze/validate/save/verify`).
  Level `safe` jalan otomatis; `mutating` ditahan server sampai approval user.
- Protokol LLM: system prompt memerintahkan tool call; balasan model dideteksi
  dengan `detect()` — cari **nama tool yang dikenal** di teks (model memformat
  bebas: `TOOL: nama {json}`, `**Tool: nama**` + fence json, atau `nama {json}`),
  lalu ambil `{...}` pertama dalam jendela 160 char; JSON longgar (key tanpa
  kutip, kutip tunggal) ditoleransi.
- Setelah tool aman dieksekusi, hasil dimasukkan sebagai pesan `[hasil tool]`
  dan loop lanjut (maks 6 turn) sampai jawaban final.
- Approval: `POST /api/assistant/approve {id, approve}` — mengeksekusi tool
  lalu melanjutkan reasoning; menolak memasukkan pesan "User MENOLAK".
  Varian streaming `POST /api/assistant/approve-stream` (SSE) mengalirkan
  hasil tool + lanjutan reasoning — dipakai panel browser.
- Sandbox: `safePath` mengunci path di dalam folder kerja; `run_command`
  asinkron dengan timeout 30 dtk, output dipangkas 12 KB (server tetap
  responsif selama perintah jalan). Tetap: shell = akses penuh mesin — hanya
  izinkan perintah yang kamu pahami.

### Panel agent (remake ala ZCode, 2026-09-07)

Panel assistant **port ke TS**: `src/client/agent/panel/` (stream / transcript /
actor / view / panel) di-bundle ke `bundle.js` sebagai `window.__agentPanel`;
`mode-runtime.js` hanya bridge `start()`. Bentuk:

- **Workspace melebar** — `#agent-workspace.agent-wide` menampung kolom
  conversation + technical pane saat mode assistant; karakter tetap terlihat
  di kolom stage.
- **Transcript live** — pertanyaan dikirim via SSE `/api/assistant/ask-stream`
  (delta token, kartu tool + args/hasil, kartu approval, `speak`, `done`),
  bukan lagi `POST /ask` blocking. Approve via `/approve-stream` agar kartu
  bermetamorfosis mulus ("menunggu izin" → "menjalankan" → hasil).
- **Satu sumber kebenaran per state** — kartu approval & plan dari poll
  `/api/assistant/status` (2 dtk, keyed by `ap.id`); transcript mode `live`
  (SSE) vs `follow` (bus `/events?since=`, untuk pantau CLI/klien lain).
  Bus `thinking/tool_call/permission/final/error` disupresi dari transcript
  saat live (padanannya dari SSE); `verification/subagent` selalu dirender.
- **Protokol putus-koneksi dua-kasus** (`decideFallback`): SSE gagal sebelum
  event pertama → cek status fresh, resend `POST /ask` sekali bila tidak busy;
  putus setelah ≥1 event → tidak pernah resend, lanjut follow dari bus
  (server menolak ask kedua saat `busy` — defense-in-depth).
- **Direktur akting** (`actor.ts`) tetap ada, mapping per-event diperluas:
  verification gagal → prihatin, lolos → ringan tanpa komentar;
  subagent_completed → senang; plan_revised → gaze think;
  permission_resolved disetujui → lega, ditolak → tanpa reaksi.
- **Diff, markdown, tab, undo (vibecoding, 2026-09-07 (2))**:
  - `panel/diff.ts` menghitung diff file di CLIENT dari argumen tool mutasi
    (`write_file`/`edit_file`/`delete_file` lewat SSE) — kartu tool mutasi
    menampilkan diff, kartu approval menampilkan pratinjau diff terbuka, dan
    tiap akhir giliran memunculkan kartu ringkasan "N file berubah +a −r".
  - `panel/md.ts` (zero-dep, token data → textContent, tanpa innerHTML)
    merender jawaban `final` sebagai markdown.
  - Tab **Obrolan / Review / Terminal** di atas transcript: Review = daftar
    file berubah sesi ini (registry client + `notes.filesTouched` dari
    `/api/assistant/status` — field additive) + tombol Revert; Terminal =
    riwayat `run_command` (command + output).
  - **Undo**: `execTool` menyimpan snapshot isi file SEBELUM write/edit/
    delete sukses (`Runtime.undo`, cap 20 FIFO, in-memory, tidak dipersist —
    seperti approval). `GET /api/assistant/undo` + `POST /api/assistant/
    revert {id}`; revert menulis balik isi lama / menghapus bila file tadinya
    belum ada; satu rekaman per path = kondisi asli sebelum rantai mutasi;
    revert ganda ditolak. CLI ikut tercakup (jalur `execTool` sama).
- Kontrak lama utuh: CLI `bun run agent` memakai runtime yang sama; panel
  hanya LAYAR — destroy() melepas UI, runtime tetap hidup.

## Desktop Pet (`core/src/pet.rs` + `static/pet.html`)

Web murni tidak bisa menembus desktop; pet berjalan di jendela aplikasi
terpisah. SATU PROSES: pet adalah window Tauri KEDUA ("pet") dalam
`Lumimi.exe` yang sama — dibuka/tutup lewat `/api/pet/launch|close`
(server in-process memanggil balik bridge `register_pet_host` dari shell;
tutup-oleh-user disinkronkan via `notify_closed`). Tak ada proses kedua,
tak ada mode CLI `pet` lagi.

1. **Window pet in-process** — WebView2 transparan melayang di desktop,
   always-on-top native, tanpa frame, tanpa taskbar. Jendela utama
   (`Lumimi.exe [main <url>]`) berdekorasi normal dan
   menunggu server bind (maks 15 dtk) sebelum membuat jendela.
    - Klik-tembus: toggle "Klik Tembus" di panel Pet (atau tombol di bar pet)
      → `POST /api/pet/clickthrough {on}` → pet page memanggil Tauri
      `setIgnoreCursorEvents`. Saat menyala, klik menembus ke desktop; satu-
      satunya jalan keluar adalah toggle yang sama di app utama.
2. **Fallback (hanya bila core jalan TANPA shell — dev `cargo run -p
   live2d-core`)**: spawn `Lumimi.exe` + Chrome/Edge `--app` (opaque,
   always-on-top via PowerShell `SetWindowPos`, tanpa klik-tembus).
   Catatan jujur: argumen `pet` diabaikan shell (`parse_args` di
   `agent-shell/src/main.rs`) — exe yang di-spawn membuka jendela UTAMA
   kedua (`index.html`), BUKAN overlay pet transparan. Jadi fallback ini
   dev-only, bukan jalur produksi.
3. `pet.html` — adapter view stack baru (importmap pixi8.mjs +
   `js/live2d-view.mjs`; model lewat `__live2dView.loadModel`). Blink/breath
   diputar framework; gaze kursor via `setLookTarget(±1)` — semua sendi
   (kepala/mata/badan) ikut, ter-skala range model, tanpa id param hardcode.
   Sapaan berkala, tombol Sapa/Bicara/Klik-tembus/Tutup (`POST /api/pet/close`
   menutup jendela; di jalur fallback mematikan proses yang di-spawn).
   Esc juga menutup. Bar bawah memakai
   `data-tauri-drag-region` (bisa dipindah di shell Tauri).
4. Pindah mode dari app utama otomatis menutup jendela pet (`petClose()` di
   teardown).

## Catatan pengembangan lanjutan

- Twitch donasi asli butuh EventSub (webhook/public URL) atau layanan pihak
  ketiga (StreamElements) — belum dibangun; donasi Twitch saat ini hanya via
  mock/inject.
- Click-through pet sudah ada via shell Tauri (`set_ignore_cursor_events`);
  fallback Chrome tidak mendukungnya.
- YouTube `liveChatMessages.streamList` bisa mengganti polling bila tersedia
  di semua akun.
