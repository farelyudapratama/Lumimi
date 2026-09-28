# SPECIFICATION — Motion Studio & AI Motion System

> Spesifikasi mengikat sistem motion di repo ini. Sistemnya sudah terbangun
> penuh (7 fase selesai) — dokumen ini menjelaskan makna setiap keputusan dan
> pagar yang tidak boleh dilanggar saat mengubah sistem motion.

## 0. Peta implementasi

```text
src/client/animation/motion-dsl.ts        Format Motion Asset + evaluator keyframe + sanitize
src/client/animation/motion-registry.ts   Registry 3 sumber gerakan
src/client/animation/motion-runtime.ts    Satu-satunya pemutar animasi (scheduler + blending)
src/client/engine/motion-taxonomy.ts      Klasifikasi klip .motion3.json (dipakai server & bundle)
src/client/agent/brain.ts                 AI Motion Director (prompt, directive, arbitrase)
static/js/motion-editor.js                UI Motion Studio (timeline, metadata, preview)
static/js/app.js                          Bridge runtime ↔ render loop ↔ state.aiPose
POST /api/motions, /api/motions/analyze, /api/motions/generate   (core/src/motions.rs + motion_ai.rs)
```

Semua di-bundle/di-bridge lewat `window.MotionDSL / MotionRegistry /
MotionRuntime` + `window.__agent` (lihat `src/client/bundle-entry.ts`).

# 1. Main Goal

User bisa membuat/mengedit motion secara visual, lalu motion itu tersedia untuk
LLM. Arsitektur akhir:

```text
USER → CHAT/LLM → AI MOTION DIRECTOR → MOTION REGISTRY → SCHEDULER → RUNTIME → LIVE2D MODEL
```

LLM TIDAK boleh memanipulasi parameter ID Live2D secara langsung — hanya
memilih semantic motion ID + properti tingkat tinggi. Runtime yang
menterjemahkan tindakan semantik menjadi animasi model.

# 2. Core Design Principle: Motion Asset

Motion Asset = definisi animasi semantik yang independent dari model.
Bisa berupa: keyframe buatan user, `.motion3.json` native, gesture prosedural,
atau hasil AI. Semuanya tampak sama bagi LLM:

```text
motion ID · description · tags · emotion compatibility · duration · intensity range · availability
```

# 3. Jangan expose parameter mentah ke LLM

❌ `{"ParamAngleX": -12, ...}` — ✅ `{"type":"motion","id":"think","intensity":0.7}`

Layer semantik memakai nama field kanonik. Kosakata v1: `ax ay ex ey bodyX
bodyY bodyZ mouthForm`; **diperluas 2026-09-29** (field ekspresi, semua role
yang SUDAH dipetakan `role-mapping.ts`): `az` (tilt kepala), `browLY/browRY`
(alis naik-turun), `browLF/browRF` (bentuk alis), `smileL/smileR` (senyum
mata), `mouthOpen` (bukaan mulut). Dua kategori semantik nilai:

- **Simetris** (default): 0 = netral, ±bound = ekstrem — `az` ±30 derajat,
  sisanya ±1.
- **Deviasi-dari-default** (`NORM_DEF_FIELDS`: `smileL/smileR/mouthOpen`):
  0 = **default milik model** (pose istirahat), +1 = max, −1 = min — dipetakan
  `devToActual` (`role-mapping.ts`), bukan midpoint, supaya rig dengan default
  non-nol tidak tersenyum permanen saat track pulang ke 0. Konversi role→param
  (`rolesToParamTracks`, harness, preview) sudah def-true sejak awal dan
  otomatis benar untuk kedua kategori.

Playback (app.js): field simetris ikut jalur `applyPoseDelta`→`POSE_FIELDS`
seperti v1; field deviasi ditulis **aditif** (`targetDev` = offset dari
default model) sehingga blink/lipsync/pose framework tetap pemilik baseline —
bukan SET yang menimpanya. Capability baru `brow` (dari `caps.hasBrow` + role
map); model tanpa alis melewatkan track-nya dengan anggun.

Resolusi role → parameter ID dilakukan sistem role-mapping model
(`static/js/app.js`, lihat `MODEL-AGNOSTIC-RULES.md`). Jangan pernah berasumsi
dua model memakai parameter ID yang sama. Kedip sengaja TIDAK masuk kosakata
(`eyeLOpen/eyeROpen` milik blink updater framework).

# 4–5. UI Editor

Motion Studio = tab 🎬 (`static/js/motion-editor.js`): library + preview Live2D
realtime + timeline keyframe. Preview harus realtime: geser slider / ketik
angka / scrub playhead → model langsung berubah. Dua tingkat akses:

- **Semantic mode** (default): Head (turn X/Y, tilt Z), Eyes (look X/Y), Body
  (lean X/Y, rotation), Face (smile, mouth open, eye openness, brow bila ada),
  Energy (bounce, amplitude).
- **Advanced mode** (opsional, tidak wajib): memperlihatkan parameter rig yang
  ter-resolve. Implementasi melangkah lebih jauh: timeline bekerja pada
  **parameter mentah rig** (satu track per parameter, seperti Cubism Editor),
  dengan mode semantik 8 field tetap bisa dibuka (migrasi via
  `rolesToParamTracks` + peta role model aktif, nilai diproyeksikan ke range
  asli parameter).

# 6. Timeline

Operasi wajib: add/move/delete/duplicate keyframe, edit value & timestamp,
scrub, play/pause/stop/loop, change duration. Interpolasi smooth (linear,
ease-in, ease-out, ease-in-out) — `src/client/animation/easing.ts`. Tidak boleh
ada parameter snap mendadak kecuali user memilih stepped.

# 7. Motion File Format

```text
data/motions/<model-key>/<id>.motion.json
```

Format inti: `version, id, name, description, tags[], duration, loop,
intensity{min,max,default}, emotionCompatibility{...}, tracks[{target,
keys[{t,v,easing?}]}]`. Extensible. Field `sourceModelId` menandai motion
berbasis parameter mentah **terikat ke model asalnya**: dibuka di model lain,
parameter yang tidak ada dilewati dengan aman (track abu-abu "tidak ada di
model ini") — tidak error, tidak merusak data.

# 8. Motion Registry

```js
MotionRegistry.createRegistry()  // static/js/bundle.js → window.MotionRegistry
register(asset) · get(id) · has(id) · list() · remove(id, source) · search({tags, emotion})
```

Registry menggabungkan DUA sumber tanpa menyalin datanya:

1. **native** — klip `.motion3.json` milik model, **per-klip** (priority 90,
   via `registerNativeClips`; tiap entri membawa `native:{group,index}` untuk
   playback exact)
2. **user** — Motion Asset buatan Motion Studio / agent (`replaceUserMotions`)

> **Gesture bawaan aplikasi (9 gesture prosedural `GESTURE_LIBRARY`) DIHAPUS**
> (keputusan user, 2026-09-27): model Live2D tidak bisa memakainya secara
> bermakna, dan daftarnya justru memenuhi prompt LLM. Gerakan kini seluruhnya
> dari klip native model + motion user/preset 'gerak'.

Setiap entri: `id, name, description, source, tags, duration,
emotionCompatibility, intensityRange, cooldown, priority, capabilities`.

# 9–10. Native & Gesture Integration

**Discovery & adopsi (revisi 2026-09-25).** Klip native ditemukan dua jalur
yang bertemu di manifest in-memory (`buildModelSettings` app.js):

- **Deklarasi rigger** — grup di `FileReferences.Motions` model3.json.
- **Adopsi klip yatim** — `GET /api/model/motions` (core/src/motion_files.rs)
  scan disk rekursif; file `.motion3.json` yang tidak dideklarasikan masuk
  sebagai grup baru satu-klip (nama grup = stem file, bentrok → akhiran _2;
  stem yang sudah dideklarasikan dilewati — salinan `runtime/`, folder
  nested tidak menggandakan entri). Padanan persis adopsi `.exp3`; manifest
  hasil adopsi TIDAK pernah ditulis ke disk. Durasi klip dari `Meta.Duration`.

**Registrasi per-klip, bukan per-grup.** `src/client/engine/native-clips.ts`
membangun daftar klip dari manifest: id = `motion_<grup>` untuk grup bernama
ber-1 klip (paritas perilaku lama), selain itu `motion_<stem>` (+ akhiran _n
bila bentrok). Grup bernama string kosong (`""`) sah di Cubism dan klipnya
ikut didaftarkan — dulu klip di grup `""` dan di grup multi-klip tidak pernah
bisa dimainkan (hanya "acak per grup"). Runtime meneruskan `native:{group,
index}` ke `bridge.playNative`, jadi tiap klip teralamat exact.

Taxonomy (`src/client/engine/motion-taxonomy.ts`) tetap mekanisme otoritatif
penemuan/klasifikasi klip native; native clips masuk registry sebagai entri
`source:"native"`. Kalau preset user punya nama semantik yang sama, berlaku
precedence sheet (`user` > `ai`; lihat `SHEET-SYSTEM.md` aturan #3) — tidak
pernah timpan diam-diam.

# 11. Motion Runtime

```js
MotionRuntime.createRuntime(registry, bridge)   // window.MotionRuntime
play(id, {intensity, blendIn, blendOut, fitToMs}) · stop(id) · stopAll() · isPlaying(id) · getActive()
```

Satu pintu playback, MULTI-LAYER: N motion boleh berjalan paralel; tiap frame
runtime menghitung gabungan semua layer dan menerapkannya dalam SATU
`applyPoseDelta` + `applyParamDrive` (bridge app.js unwind-then-apply, jadi
tidak ada dua penulis per frame). Bagian lain aplikasi tidak boleh memanipulasi
state motion secara langsung — app.js men-bridge hasil evaluasi runtime ke
`state.aiPose` tiap frame (8 POSE_FIELDS), plus delegasi `motion_<group>` untuk
klip native.

# 12. Scheduler / Prioritas

```text
100  manual user control          60  gesture          20  idle/fidget
 90  native motion clip           40  emotion          10  breathing
 80  explicit LLM motion
```

Multi-layer (ownership per field): layer baru MENGGANTIKAN semua layer
prioritas <= miliknya (same band & di bawah — paritas cut perilaku lama) dan
BERJALAN BERSAMA layer prioritas lebih tinggi. Field/param hanya ditulis layer
prioritas tertinggi yang menganimasikannya; klaim ownership tetap berlaku walau
nilai sedang 0 (track yang melintasi nol tidak melepas kepemilikan). Cap 4
layer: play yang lebih rendah ditolak saat penuh — band sama tetap bisa
menggantikan. Konsekuensi yang diinginkan: gesture kini menyusun DI BAWAH
`[MOTION:id]` (brain memainkan keduanya; field benturan otomatis ditekan,
sisa field seperti mata/badan tetap bergerak). Native clip tidak menyentuh
layer DSL — app.js punya guard `clipUntil` sendiri selama klip main. Cooldown
lewat registry (`canPlay`/`markPlayed`; dari LLM dihormati, manual bypass).
Watchdog 250 ms di samping rAF mencegah motion yatim mengunci parameter.

**Paritas protokol prioritas di framework (revisi 2026-09-25).** Aturan
"band sama menggantikan" juga berlaku pada antrean motion native Cubism:
`Live2DUserModel.startMotionGroup` mengizinkan replace band-sama (klip loop
`Meta.Loop` tidak pernah `isFinished` — tanpa ini satu klip mengunci semua
play sesama band), dan `Live2DUserModel.update` memanggil `updateMotion` tanpa
syarat supaya `_currentPriority` ter-reset saat antrean kosong (dulu lengket
selamanya). app.js menghentikan klip loop lewat `stopMotions()` facade saat
`clipUntil` habis — auto-idle kembali masuk.

# 13–14. Blending & Intensity

Transisi smooth (`blendIn` default 120 ms, `blendOut` 250 ms + envelope
amplitude) — jangan pernah `idle → motion → idle` tanpa blend. Parameter-drive
blending menginterpolasi dari `paramBase`. Intensity menskalakan motion
semantik (`[INTENSITY:]` clamp 0.1..1), bukan mengalikan semua parameter
 secara buta; scaling per-track dipakai bila perlu.

Stretch (`fitToMs`, dihitung `estimateSpeechMs` di brain dari panjang teks
segmen): playback `[MOTION:id]` dilar agar mengisi seluruh durasi bicara TTS —
pelambatan dibatasi 2× (`STRETCH_MAX`), sisanya menahan nilai keyframe
terakhir sampai fade. Motion tidak pernah dipercepat, loop tidak di-stretch
(sudah mengisi waktu sendiri). Blend-out (fade) boleh disela playback
prioritas lebih rendah — fade dianggap bukan "masih main"; playback utama
tetap dilindungi aturan prioritas.

# 15. Metadata Editor

Setiap motion punya panel metadata: Name, ID, Description, Tags, compatible
emotions (senang/normal/malu/sedih/…), intensity min/default/max, cooldown,
priority, loop, AI enabled.

# 16. AI Analyze Motion

`POST /api/motions/analyze` menerima representasi semantik (duration, tracks
dengan range + jumlah keyframe — `summaryForLLM`), BUKAN state internal
aplikasi. Return: description, tags, emotionCompatibility. **User harus
approve** sebelum disimpan.

# 17. AI Motion Generation

`POST /api/motions/generate` — user minta gerak dengan teks ("Buat gerakan
malu, kepala menunduk lalu melihat ke samping") → draft DSL semantik →
Preview → approval → Save → Registry → tersedia untuk LLM. Draft disanitasi
server (sanitize via `motion-dsl`, clamp bounds, id dinormalisasi).

**Model-aware (revisi 2026-09-26).** Klien mengirim `model` (folder model
aktif) + `roleMap` (peta role→paramId hasil role-mapping engine). Server
menganalisis motion milik model dari disk (`motion_analysis`) dan menyisipkan
konteks ke prompt: amplitudo teramati per role, role yang terpetakan ke param
output physics (dilarang), atau catatan "belum ada motion referensi". Tanpa
`model`/`roleMap`, prompt byte-per-byte sama seperti semula (backward compat).
Angka konteks murni engine (dari disk) — LLM hanya MENERIMA konteks, balasan
LLM tetap tanpa range, clamp server tetap `FIELD_BOUNDS`.

**Kosakata diperluas (revisi 2026-09-29).** Prompt generate, legend analyze,
dan daftar fix memuat 16 field (v1 8 field + `az/mouthOpen/smileL/smileR/
browLY/browRY/browLF/browRF`). Karena `roleMap` klien dibangun dari iterasi
`ROLE_FOR_FIELD`, konteks amplitudo per field baru ikut terisi otomatis dari
analisis disk — tanpa perubahan `motion_analysis`.

# 17a. Analisis Model & Validasi Independen (revisi 2026-09-26)

Pola dari referensi live2d-add-motion-sample-web-ui: **loop analisis →
desain → validasi independen → perbaiki sendiri → simpan**.

- **`motion_analysis`** (`core/src/motion_analysis.rs`) memindai semua
  `.motion3.json` + `physics3.json` + `cdi3.json` model dari disk:
  range nilai observasi per param, **base pose** (modus keyframe pertama),
  dan **output physics3** (★ — destination `PhysicsSettings[].Output[]`).
  Inferensi role TETAP satu sumber di `role-mapping.ts` (klien); server hanya
  melipat peta `role→paramId` yang dikirim klien, tidak menebak sendiri.
  Endpoint: `GET /api/model/motion-analysis?name=X&roles={...}`.
- **`motion_validation`** (`core/src/motion_validation.rs`) — validator
  TERPISAH dari generator: struktural (gerbang `motion_dsl::sanitize`),
  kualitas raw (keyframe di luar durasi/tak terurut/di-clamp dilaporkan,
  bukan dibuang diam-diam), dan semantik vs analisis (di luar range
  observasi, target output physics, tidak pulang ke base pose). Advisory —
  sanitize server tetap gerbang akhir saat Simpan.
  Endpoint: `POST /api/motions/validate {model?, roleMap?, motion}`.
- **Tool agent bawaan** (`core/src/agent/motion_tools.rs`):
  `motion_analyze` (safe) → agent mendesain track role → `motion_validate`
  (safe, agent mengoreksi issue-nya sendiri) → `motion_save` (mutating,
  lewat kartu persetujuan). Model aktif + roleMap dikirim panel saat
  `POST /api/assistant/start` (`Runtime.model`/`Runtime.role_map`).
- **Aturan kualitas** (dari referensi, mengikat untuk AI authoring): output
  physics TIDAK PERNAH dianimasikan langsung (gerakkan penyebabnya — angka
  badan/kepala — lalu fisika mengikutkan); aksi satu-tembakan mulai dari dan
  PULANG ke base pose; nilai di dalam range terobservasi model.

# 17b. Critic Visual — Jalur Vision (revisi 2026-09-26)

Implementasi Fase 4d `PLAN-MOTION-PIPELINE.md`. Agent/studio bisa meminta
**penilaian visual** atas draft motion:

- **`motion_vision`** (`core/src/motion_vision.rs`): buka halaman harness
  (`static/harness-motion.html` + `src/client/harness/harness-motion.ts`,
  satu jalur render — live2d-view.mjs) di browser terkelola → muat model +
  asset (migrasi role→param deterministik di harness) → **8 frame** → kirim
  filmstrip ke LLM role **`motion-vision`** → verdict JSON
  `{playing, matchesIntent, artifacts[], notes, confidence}`.
- **Capture deterministik**: jendela ter-occlude mematikan rAF & kompositor
  (screenshot permukaan CDP = frame basi). Harness karenanya render eksplisit
  per frame — `pixiApp.render()` (clear) → `renderer.draw()` (update pipeline
  + gambar Cubism) — lalu baca buffer via `canvas.toDataURL()` **dalam task
  yang sama** (komposit alpha ke latar gelap dulu; JPEG tanpa alpha).
- **Role `motion-vision`**: koneksi HARUS ditandai eksplisit
  (`roles:["motion-vision"]` di panel Koneksi AI); wildcard tidak pernah
  dipakai untuk gambar (model teks tidak boleh menerima gambar). Tanpa
  koneksi → verdict `{skipped:true}` + petunjuk (degrade anggun).
- **Akses**: tool agent `motion_verify` (safe) — loop
  analyze→design→validate→**verify**→save; endpoint `POST /api/motions/verify`
  + tombol "Cek Visual" di Motion Studio.
- **Privasi**: yang dikirim ke VLM = render canvas model Live2D (aset milik
  user), BUKAN frame webcam — aturan "webcam tak pernah di-upload" tidak
  tersentuh (amanat PLAN 2d).

# 18–19. LLM Integration & Catalog

Format lama (`{text, emotion, gesture, intensity}`) dan format baru
(`actions[]`) dinormalisasi ke representasi internal yang sama — jangan
pernah mematahkan format lama. LLM menerima catalog ringkas dari registry
(`catalogForLLM`, slice terbatas): id, description, tags, compatibleEmotions,
plus catatan INTENSITY. Aturan untuk LLM:

```text
Hanya pakai motion ID yang ada di registry. Jangan pernah mengarang ID.
Pilih motion yang semantiknya cocok. Jangan pakai motion yang bertentangan
dengan emosi. Hormati cooldown dan availability.
```

# 20. LLM Tidak Punya Kebebasan Tanpa Batas

ID motion yang tidak ada → **ditolak server, dibuang runtime, jatuh ke gesture
biasa**. Validasi: motion exists, enabled, model support, intensity dalam
range, duration valid, target valid, nilai keyframe dalam batas aman
(`sanitizeMotionAsset`). Cegah NaN/Infinity/timestamp invalid/duration
negatif/target asing.

# 21. Context-aware Selection

Motion Director (LLM) mempertimbangkan konteks percakapan, emosi aktif,
motion sebelumnya, cooldown, kemampuan model. Contoh: "Aku pergi dulu." →
`sedih/normal` + `wave_goodbye`; "HAHAHAHA" → `senang` + `laugh_bounce`;
"Tunggu, aku mikir." → `normal` + `think`. **LLM = director semantik;
runtime = executor deterministik.**

# 22. Idle System

Micro-gesture/idle tetap ada, sebagai layer motion prioritas TERENDAH. Idle
otomatis mundur saat motion prioritas lebih tinggi memegang parameter
relevan (`lockAI()` membekukan fidget & interaksi selama playback segmen;
unlock kini terjadi SEKALI di akhir chain — selesai alami atau chain
digulingkan policy speech preempt, `brain.playSegments` onPreempted).

# 23. Model Capability Awareness

Setiap asset dievaluasi terhadap kemampuan model (`fieldCapability`,
`state.modelParams`). Model tanpa parameter body → jalankan track yang ada,
skip sisanya. **Degrade gracefully, tidak pernah gagal.**

# 24–25. UX & Undo/Redo

Editor terasa: cepat, visual, forgiving, non-destructive, preview mudah.
Hindari: modal berlebihan, raw JSON sebagai UI utama, ratusan parameter
Cubism tampil default. Undo/redo untuk edit timeline; persist hanya saat
save eksplisit (atau autosave terkendali) — jangan tulis disk tiap klik.

# 26. Persistence

```text
data/motions/<model-key>/<motion-id>.motion.json
```

Jangan timpan motion user yang ada diam-diam — konflik ID → tanya user atau
generate ID aman (server: 409 duplicate). Data versi lama kompatibel: copy
`motions/` dari arsip → `data/motions/`.

# 27. API

```text
GET    /api/motions?model=<key>        GET    /api/motions/<id>
POST   /api/motions                    PUT    /api/motions/<id>
DELETE /api/motions/<id>
POST   /api/motions/analyze            POST   /api/motions/generate
POST   /api/motions/validate           POST   /api/motions/verify
GET    /api/model/motion-analysis
```

API key tetap hanya di server — jangan pindah ke browser. (Semua endpoint di
`core/src/` — mis. motions.rs, sheet.rs, director.rs.)

# 28. Security / Validation

Tidak pernah percaya ID motion dari LLM. Server dan runtime sama-sama
memvalidasi; nilai di-clamp; target tak dikenal ditolak.

# 29. Testing

Minimal: registry (register/get/remove/search/duplicate), parser (valid,
invalid, missing fields, keyframe invalid, target asing), runtime
(play/stop/blend/intensity/cooldown/priority/ownership), LLM (motion valid,
ID asing, intensity invalid, format lama + baru), capability (full model,
head-only, tanpa mata, tanpa body). Status: `bun run test` — unit TS (directive parser,
DSL, registry, taxonomy, dispatcher server, voice-input) + guard legacy
`test/legacy/` (role-mapping, param-scaling, sheet schema, exp3-adoption,
api-origin). Guard runtime motion belum ada — tulis bersamaan saat modul
runtime disentuh.

# 30. Implementation Strategy (status)

Fase 1 (core tanpa UI) — ✅. Fase 2 (sambungkan gesture/taxonomy/native) — ✅.
Fase 3 (Motion Studio UI) — ✅. Fase 4 (metadata editor) — ✅.
Fase 5 (integrasi LLM, dua format) — ✅. Fase 6 (AI analyze) — ✅.
Fase 7 (AI generation) — ✅ (`/api/motions/generate`).

# 31. Architectural Rule

Tepat SATU pipeline konseptual eksekusi motion:

```text
Motion Asset → Registry → Scheduler → Runtime → Live2D
```

Jangan membuat engine motion kedua. `app.js`, agent, gesture system, editor,
idle system — semuanya lewat Motion Runtime, bukan menulis parameter sendiri.

# 32. Quality Bar

Berhasil bila: user bisa buat motion visual → edit keyframe → preview → save
→ reload → beri metadata → lihat di registry → dipakai dari chat. LLM bisa
menemukan motion, memilih yang tepat, mengatur intensity, menggabungkan
dengan emosi, dan TIDAK PERNAH mengarang ID. Runtime bisa blend, mencegah
penulis parameter bertabrakan, hormati prioritas & cooldown, degrade sesuai
kemampuan model. Aplikasi lama tetap jalan utuh (gestures, native motions,
sheets, format LLM lama).

# 33. Final Principle

Tujuan Motion Studio bukan sekadar timeline animasi:

> **Mengubah animasi menjadi kemampuan semantik yang bisa dipahami dan
> dipakai AI agent.**

User membuat `shy_look_away` dengan description + tags +
emotionCompatibility → Registry → LLM melihatnya → user bilang hal
memalukan → LLM memilih `emotion=malu, motion=shy_look_away, intensity=0.8`
→ Scheduler → Runtime → karakter Live2D melakukannya.

Optimalkan untuk: **kejelasan semantik + eksekusi deterministik + animasi
smooth + extensibility + kompatibilitas dengan project** — bukan jumlah fitur.
