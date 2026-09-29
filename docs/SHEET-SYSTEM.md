# Sistem Sheet per Model

Dokumen hidup — panduan mengikat sistem sheet. Tujuannya: siapa pun (termasuk
sesi berikutnya) bisa lanjut kerja tanpa membaca ulang percakapan panjang.
Kalau kode dan dokumen ini beda, **kode yang benar** — perbaiki dokumennya.

> Sistem sheet diimplementasikan di `static/js/app.js` (legacy — di-port saat
> disentuh) + endpoint server di `core/src/sheet.rs` (+ `core/src/expressions.rs`).

## Kenapa ada sistem sheet

Model Live2D tidak punya metadata semantik. `Param92` bisa berarti blush di satu
rig dan ekor di rig lain. Sheet adalah satu-satunya tempat aplikasi menyimpan
"apa arti parameter ini pada model INI", diisi dari tiga sumber dengan
kepercayaan berbeda:

| Sumber | Isi | Boleh menimpa? |
|---|---|---|
| Inspeksi Cubism (`inspectModel()`) | id, min, max, def, parts, motionGroups | angka = kebenaran, selalu ditimpa saat re-inspeksi |
| LLM (`.ai`) | label grup + usulan preset | **tidak pernah** menimpa `.user` |
| User (`.user`) | catatan, label grup, preset | otoritatif, wajib selamat dari re-inspeksi |

## Aturan yang tidak boleh "diperbaiki" balik

Empat aturan di bawah ini sudah beberapa kali dibalik oleh perubahan yang
kelihatan seperti pembersihan. Semuanya punya alasan, bukan selera.

1. **`user` > `ai`, mutlak.** Berlaku untuk `paramGroups` maupun `presets`.
   Turunan langsung dari `USER_AUTHORED_FIELDS` (`static/js/app.js`):
   re-inspeksi tidak boleh menghapus tulisan user. Entri `.ai` yang namanya
   bentrok dengan milik user **tidak** menimpa — ditampilkan sebagai saran
   terpisah berbadge 🤖 sampai user menekan "Pakai". Lihat `resolvePresets()`
   dan `findPreset()`.

2. **`paramGroups` dan `presets` tetap DUA struktur.** `paramGroups` =
   kategorisasi (1 param → 1 label, untuk menyusun tampilan slider mentah).
   `presets` = aksi (1 nama → kombinasi banyak param+value/steps, untuk tombol).
   Label kategori tidak membawa nilai; preset tidak memberi tahu slider harus
   ditaruh di tab mana. Keduanya perlu. Jangan digabung.

3. **Namespace gerak: tabrakan dicegah saat SIMPAN, bukan saat lookup.**
   `playGesture()` resolve dengan urutan: klip native exact (`motion_<stem>`)
   → grup native model → preset `gerak` user → entri registry (`static/js/app.js`
   `playGesture()`). Motion native adalah data intrinsik model,
   sekelas `.exp3` — bukan "saran AI" yang boleh dikalahkan preset. Jadi preset
   `gerak` **ditolak** kalau namanya sudah dipakai (`checkGerakName()`), dengan
   usulan nama alternatif (`suggestGerakName()`). Sheet lama yang sudah bentrok
   di disk diperbaiki sekali saat migrasi oleh `deshadowGerakPresets()`, rename
   + catat `renamedFrom` supaya UI bisa menjelaskan, bukan hapus.
   (Tabel gesture bawaan `GESTURE_LIBRARY` dulu ikut di urutan ini —
   **dihapus** keputusan user 2026-09-27.)

4. **Angka hanya dari engine.** `min`/`max`/`def` datang dari Cubism Core saja.
   LLM tidak pernah boleh mengirim angka range, dan `steps` gerak buatan LLM
   ditolak — LLM hanya boleh MEMILIH nama gerak yang benar-benar ada di
   registry (klip native model / motion user / preset `gerak`). Semua value preset di-clamp ke range
   terukur saat apply (`applyPreset()`), jadi file sheet pun tidak dipercaya.

## Skema sheet v4

Migrasi non-destruktif v0→v4 di `migrateSheet()` (`static/js/app.js`).

```
v0  legacy tanpa versi
v1  + schemaVersion, userNote
v2  + config{}          (blink, idle, framing, TTS pitch/rate/lang per model)
v3  + rangeSource       (sheet pra-v3 mengaku "measured" padahal tebakan)
v4  + params[].userNote, paramGroups{user,ai}, presets{user,ai}
```

Preset punya 4 kategori: `emosi`, `properti`, `aksesoris`, `gerak`.
Batas struktural steps gerak: `STEP_MS_MIN` 40, `STEP_MS_MAX` 3000,
`STEP_COUNT_MAX` 12, `STEP_TOTAL_MS_MAX` 8000. Field delta preset `gerak`
memakai kosakata field semantik motion yang sama dengan
`MOTION-SYSTEM-SPEC.md` §3 (16 field v2: `ax ay az ex ey bodyX bodyY bodyZ
mouthForm` + `browLY browRY browLF browRF smileL smileR mouthOpen`) — paramId
mentah sengaja di-DROP supaya preset gerak tetap model-agnostic.

Penyimpanan: `localStorage['live2d_sheet_' + currentModelKey()]` **dan**
`data/sheets/<key>.json` di server (atomic tmp+rename via
`write_json_atomic` di `core/src/sheet.rs`). `currentModelKey()` diturunkan dari
model PATH, dan sanitizernya identik dengan `sanitize_key()` di
`core/src/sheet.rs` — jangan ubah salah satu tanpa yang lain. Data versi
lama (`sheets/*.json` dari arsip) kompatibel: cukup copy ke `data/sheets/`.

## API sheet (dipakai UI, diekspos di `window.__live2dAgent.sheet`)

| Fungsi | Guna |
|---|---|
| `saveUserPreset(preset)` | satu pintu simpan: validasi nama → upsert `presets.user` → localStorage + `POST /api/sheet` → invalidate cache capability |
| `resolvePresets(sheet, category)` | daftar preset untuk ditampilkan; entri `.ai` ditandai `suggestion: true` |
| `resolveParamGroup(sheet, id, heuristik)` | `user ?? ai ?? heuristik` |
| `checkGerakName(name, sheet)` | `{ok, code, conflictWith, message, suggestion}` — return objek, bukan throw, karena pemanggilnya field UI |
| `suggestGerakName(name, sheet)` | nama alternatif yang aman |
| `applyPreset(nameOrPreset, category)` | apply nilai (params via `setParameterValue`, parts via `setPartOpacity` — beda call, tidak bisa satu map) |
| `findPreset(name, category)` | lookup untuk `[ACC:]` / `playGesture()` sebelum fallback |
| `loadCharacterSheet()` | baca + migrasi dari localStorage |
| `deleteUserPreset(category, name)` | hapus satu preset user |
| `applyAISuggestion(category, name)` | promosikan satu entri `.ai` → `.user` (butuh klik user) |
| `triggerAIParamClassification()` | tulis `paramGroups.ai`, tidak menimpa heuristik |

Endpoint analisa: `POST /api/model/analyze-sheet` lewat `llmWithFallback()`
(`src/shared/llm-client.ts`). Nol kebocoran `min`/`max`/`def`/`steps` ke LLM,
dedupe terhadap `existingNames`, params kosong → 200 + warning (bukan 500).

## Adopsi `.exp3` yatim

Kegagalan senyap klasik: ExpressionManager framework **hanya** dibuat kalau
manifest mendaftarkan ekspresi. lumine punya 19 file `.exp3.json` di disk
dan `model3.json`-nya mendaftarkan **nol**, jadi 19 aset mati **tanpa satu
pun error** — persis kelas kegagalan yang jadi alasan
`MODEL-AGNOSTIC-RULES.md` ada. (Stack renderer pra-migrasi yang dulu
memperparah ini sudah dipensiunkan; adopsi in-memory di bawah tetap berlaku
untuk renderer kini.)

Dua bagian:

| Bagian | Apa |
|---|---|
| `GET /api/model/expressions?name=X` (`core/src/expressions.rs`) | Menyusuri folder model di `data/model/`, melaporkan setiap `.exp3` dengan `File` **relatif terhadap direktori `model3.json`** (itu yang di-resolve loader), plus flag `declared` per file dan `orphanCount` |
| `buildModelSettings()` (`static/js/app.js`) | Menggabungkan hanya yang **belum** terdaftar ke salinan **in-memory** manifest, lalu menyerahkan objek itu ke `Live2DModel.from()` alih-alih string URL |

Aturan yang wajib dipertahankan:

- **Manifest lengkap → `null`.** Pemuatan jatuh ke jalur URL biasa. 神宫白子
  (8/8 terdaftar) tidak disentuh sama sekali.
- **Nama duplikat tidak pernah di-append.** Deklarasi rigger yang menang.
- **File di disk tidak pernah ditulis.** Adopsi murni in-memory.
- **Setiap kegagalan → `null`.** Server mati, JSON rusak, payload aneh, path di
  luar `data/model/` — semuanya jatuh ke pemuatan biasa. Adopsi secara
  struktural tidak bisa menggagalkan pemuatan model.
- **File `.exp3` di ATAS direktori `model3.json` dilewati** — path relatifnya
  tidak akan pernah resolve.
- Nama ekspresi diambil **verbatim** dari nama file pilihan rigger (CJK,
  numerik, snake_case apa adanya).
- Kontrol opt-out per-file: tab 📋 Sheet → 🧬 Ekspresi Teradopsi
  (`GET/POST /api/model/expressions-adoption`).

Efek terukur: model tanpa deklarasi naik dari **0 → 19** emosi di
`getCapabilityProfile()`. Catatan yang tetap berlaku: adopsi ini belum pernah
diverifikasi visual — penanda console: `[exp3] adopted N undeclared
expression file(s) for <model>`.

## Keputusan agen reaktif yang terkunci

- **Kamera opt-in, default MATI.** Inferensi 100% lokal di browser
  (transformers.js); frame webcam tidak pernah di-upload ke server mana pun.
- **STT (🎤) push-to-talk, filosofi yang sama.** Inferensi 100% lokal
  (Whisper via transformers.js); audio tidak pernah di-upload. Tidak ada
  perekam latar, dan memulai rekam **ditolak saat karakter bicara TTS**
  (anti-echo — kalau tidak, karakter mentranskripsi suaranya sendiri).
  Integrasi nol perubahan `app.js`: `#btn-mic`, guard `state.talking` via
  `window.__l2dDebug`, kirim lewat klik `#btn-bubble`.
- **Ekspresi wajah user = INPUT mood**, bukan untuk dicermin balik tiap frame.
  Mood adalah gabungan kamera + teks ketikan.
- **Presence punya satu hub.** Dua produsen (modul webcam `static/js/camera-presence.js`,
  dan fallback visibility/focus tab) tidak boleh dipercaya sekaligus. Semua
  memanggil `window.__agent.setPresence()`, agen memanggil balik
  `window.__l2dPresenceChanged()`. Sebelum aturan ini, menyalakan kamera justru
  **mematikan** semua event idle.
- **Izin kamera ditolak → `setPresence(null)`**, bukan `false`. Mode fallback
  memakai visibility saja; jangan pernah men-trigger "away" dari ketidaktahuan.
- Anti-jitter: mood hanya trigger saat label berubah + debounce, presence butuh
  `awayHiddenMs` konsisten sebelum dinyatakan away.
- Proaktivitas diatur via UI (panel **Kelakuan**, tab ⚙️ AI), persist via
  `POST /api/config saveEvents` (aman untuk apiKey). `quietMs` dibaca LIVE dari
  `window.__appEvents` — tanpa restart.

State runtime bisa dibaca lewat `window.__agent._reactiveState()`.

## Test

```bash
bun run test          # unit test TS + guard legacy (termasuk sheet schema v4: 220 assertion)
bun run test:guards   # hanya guard legacy
```

Guard schema v4 (`test/legacy/test-fase1-sheet-schema.js`)
mengekstrak `migrateSheet()` dll. langsung dari `static/js/app.js` via `vm` —
menguji fungsi **asli** yang jalan di aplikasi, bukan salinan, jadi perubahan
`migrateSheet` yang melanggar kontrak langsung memerah.

## Utang teknis / catatan

- **`motionGroups` kosong di kedua model bundled** dan hanya ada 1 file
  `.motion3.json` deklarasi. Sejak 2026-09-27 (tabel `GESTURE_LIBRARY` dihapus),
  `[GESTURE:]` resolve ke klip native adopsi / preset `gerak` user — bila model
  tak punya keduanya, director tidak mengiklankan gesture sama sekali dan LLM
  dilarang mengarang nama. Konsekuensi aset, bukan bug.
- `config.json` milik user berisi koneksi + apiKey — file itu ada di
  `data/config.json`, **di-gitignore** dan **tidak pernah disajikan** lewat HTTP
  statis (403). Ini data milik user, minta izin dulu sebelum menyentuh.
- `.bak` apapun yang memuat apiKey jangan pernah di-commit.
