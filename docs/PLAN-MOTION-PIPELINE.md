# RENCANA — Pipeline Motion Studio: Rig Report → Probe → Planner/Compiler/Critic

> **Status: ARSIP + BACKLOG (2026-09-29). Rencana ini TIDAK mengikat — yang
> mengikat = `MOTION-SYSTEM-SPEC.md` (+ §17a/§17b untuk fondasi yang sudah
> dibangun).** Diarsipkan 2026-09-24; dimulai 2026-09-26 dengan urutan adaptif
> (fondasi + vision dulu, bukan Fase 1 penuh). Yang SUDAH dibangun:
> - **Fondasi analisis & validasi** (`core/src/motion_analysis.rs` +
>   `motion_validation.rs` + endpoint `/api/model/motion-analysis` &
>   `/api/motions/validate`) — meng cover sebagian kebutuhan Fase 1
>   (statistik gaya native: range observasi, base pose, output physics)
>   dan Fase 4c (cek bound, end-stuck, physics target) dalam bentuk lint,
>   bukan critic persentil penuh.
> - **Image parts di `core/src/llm.rs`** (OpenAI `image_url` / Gemini
>   `inline_data` / Anthropic image block) + role koneksi **`motion-vision`**
>   (prasyarat Fase 2d & 4d) — prasyarat Fase 2.
> - **Fase 4d critic visual** (`core/src/motion_vision.rs` + harness render
>   `static/harness-motion.html` + `src/client/harness/harness-motion.ts` +
>   tool agent `motion_verify` + endpoint `POST /api/motions/verify`):
>   filmstrip 8 frame → VLM menilai playing/matchesIntent/artifacts.
>   Catatan desain penting yang ditemukan saat implementasi: jendela browser
>   ter-occlude mematikan rAF & kompositor → capture WAJIB render eksplisit
>   (`pixiApp.render()` + `renderer.draw()`) lalu `canvas.toDataURL()` sinkron.
>
> Yang BELUM (backlog, dikerjakan hanya bila diminta eksplisit): Fase 1 rig
> report penuh (provenance, hash cache), Fase 2 probe, Fase 3 panel approve,
> Fase 4a-b planner 2-langkah + compiler, 4c critic persentil penuh, 4e refine
> loop terpetakan, 4f kebijakan layering, Fase 5 ukuran keberhasilan.
>
> Detail fase di bawah dipertahankan sebagai backlog; kalau dokumen dan kode
> bertentangan, kode yang benar. Baca bersama `MOTION-SYSTEM-SPEC.md` (pipeline
> eksekusi yang ada) dan `MODEL-AGNOSTIC-RULES.md` (pagar model-agnostic).

## Sasaran

AI memahami parameter model Live2D **apa pun** lewat penyelidikan sekali per
model, lalu membuat motion yang halus dan ter-grounding pada rig itu.

Tiga prinsip yang tidak boleh dilanggar sepanjang pipeline ini:

1. **LLM tidak pernah memegang ID param mentah.** Dia bicara dalam kosakata
   semantik hasil approve user (§3 MOTION-SYSTEM-SPEC tetap berlaku);
   resolusi label → ID param + range dilakukan **kode** (role mapping /
   compiler) dari rig report.
2. **Compiler bekerja dari field terstruktur, bukan teks bebas.** Notes
   berupa kalimat ("membuka kelopak mata kiri") terlalu lemah untuk memutuskan
   arah dan tanda — resolver membaca `sign`, `side`, `region`, dll.; teks hanya
   untuk manusia.
3. **`user` > `ai` tetap absolut** (SHEET-SYSTEM): approve user adalah
   pintu terakhir sebelum save; hasil AI tak pernah menimpa tulisan user.

### Konteks yang sudah ada di repo (jangan dibangun ulang)

- `paramNotes` **teks-bebas** sudah ada: `core/src/director.rs::format_param_notes`
  (dipakai prompt director), `notes` di prompt `sheet_ai.rs` (penjelasan user
  per param, cap 300 char), guard `test/legacy/test-param-notes-ui.js`.
  Rencana ini **meng-upgrade** jalur itu ke field terstruktur — bukan
  menggantinya dari nol; format lama kompatibel dibiarkan baca.
- `core/src/motion_taxonomy.rs` / `src/client/engine/motion-taxonomy.ts`:
  `decodeCurve`, `curveFeatures`, `buildRoleMap` (cdi3), `classifyClip` —
  sumber provenance & statistik.
- `src/client/animation/motion-dsl.ts`: sanitize satu pintu, `evaluateAsset`,
  `rolesToParamTracks`, track `kind:"param"` + `sourceModelId`/`modelScoped`
  (degradasi aman lintas model).
- Semua model di `data/model/` punya `.physics3.json` + `.cdi3.json`.

---

## Fase 1 — Rig Report (deterministik, dari disk, tanpa LLM)

Endpoint baru `GET /api/rig-report?model=<key>` — modul baru
`core/src/rig_report.rs`, mengikuti pola scan `sheet.rs`; klasifikasi kurva
memakai logika taxonomy yang sudah ada.

Data per parameter:

- id, min/max/default (dari moc3/cdi3), label cdi3 display name.
- **Input vs output physics** — baca `physics3.json`; parameter yang adalah
  **output** physics (rambut/baju/ekor/aksesoris yang ikut bergoyang) 
  **DILARANG di-keyframe** oleh siapa pun (user/AI): menguncinya bertarung
  dengan physics engine. Dipasang gate di compiler + sanitize.
- Hasil resolusi berurutan: Groups (`model3.json`) → id kanonik Cubism →
  cdi3 display name → kurva native → regex pemecah seri, dengan **provenance**
  per param: `curveClassified` / `displayLabel` / `canonicalId` / `group` /
  `unclassified`. Param `unclassified` masuk antrean probe (Fase 2).
- **Statistik gaya native per role**: distribusi amplitudo & durasi klip
  `.motion3.json` model ini — nanti jadi sumber threshold critic (Fase 4,
  poin 8) dan batas amplitudo planner (bukan hard-code ±5..15).

### Invalidasi cache (poin 12 — wajib eksplisit)

Cache rig report **di-key ke hash gabungan `moc3` + `cdi3` + `physics3`**.
Model diganti / file di-update → hash beda → cache ditandai **`stale`**,
ditampilkan stale di panel (bukan dipakai buta), user di-offer re-probe.
Guard unit: hash sama → valid; hash beda → stale.

### Penyimpanan

Schema menyentuh area sheet → **wajib baca `docs/SHEET-SYSTEM.md` + guard
`test/legacy/test-fase1-sheet-schema.js` dulu** sebelum menulis kode.
`user` > `ai` berlaku penuh untuk notes/approval yang menyimpan di sini.

---

## Fase 2 — Probe Visual: contact sheet + metrik lokal + VLM terstruktur

Dijalankan dari Motion Studio (`static/js/motion-editor.js` untuk UI/preview;
logika di modul TS teruji). Hanya untuk param `unclassified` — yang sudah
`curveClassified`/`displayLabel` tidak di-probe (hemat panggilan).

### 2a. Setup capture: physics di-settle/dimatikan (poin 4)

Sebelum sweep, physics **di-settle** (biarkan konvergen ke pose awal lalu
freeze) atau dimatikan (stop `CubismPhysics`) supaya rambut/aksesori tidak
menggerakkan piksel dan mengotori diff. Hasil probe dicatat
`physicsDisabled: true`.

### 2b. Sweep bertingkat + retry bersyarat (poin 3)

1. Sweep param di pose default: `default → min → default → max` + 2 titik
   tengah (untuk deteksi linear vs lonjakan). Hitung diff.
2. **Diff nol ≠ mati.** Beberapa param bersyarat tidak menghasilkan diff di
   pose default (blush, air mata, `MouthForm` yang hanya terlihat saat mulut
   terbuka, part opacity yang butuh ekspresi aktif). Untuk diff-nol: ulangi
   sweep dengan **param terkait di-set dulu** — kandidat dari `coupled_with`
   (kalau sudah ada), Groups resmi, atau korelasi kurva native. Batasi retry
   (maks ~3 kombinasi) agar tidak meledak jumlah capture.
3. Masih nol setelah retry bersyarat → kandidat **`dead`** — kategori
   terpisah di panel review, **bukan menumpuk diam-diam di `unclassified`**.

### 2c. Metrik lokal (murni offline, murah)

Per sweep: **bbox** perubahan piksel, besar geseran, arah centroid, atribusi
per **drawable/mesh** mana yang bergerak, profil nilai (linear vs lonjakan
dari 5 titik), **simetri** kiri-kanan. Semua ini dasar cross-check 2d dan
angka yang ditampilkan ke user di panel.

### 2d. VLM → field terstruktur (poin 1)

Contact sheet **5 frame** + gambar selisih dikirim ke VLM → JSON:

```json
{
  "notes": "membuka kelopak mata kiri (untuk manusia)",
  "sign": +1,
  "side": "karakter_kiri",
  "region": "mata",
  "coupled_with": ["mouthOpenY"],
  "safe_range": [0, 1],
  "confidence": 0.85
}
```

- `sign` (+1/−1): arah/tanda gerakan — resolver memakai ini untuk memutuskan
  tanda, bukan menebak dari kalimat.
- `side`: sisi **karakter** (bukan layar). Frame diberi penanda kiri/kanan
  eksplisit agar VLM tidak tertukar.
- `region`: region tubuh (kepala/mata/mulut/badan/ekspresi/aksesoris/…).
- `coupled_with`: param lain yang tampak ikut terpengaruh / diperlukan.
- `safe_range`: rentang yang tampak wajar dari hasil sweep probe.
- `confidence`: keyakinan VLM sendiri.
- `notes`: teks bebas **hanya untuk manusia** — compiler/mapper tidak
  pernah membacanya.

Butuh **image parts** di `core/src/llm.rs` (OpenAI `image_url` / Gemini
`inline_data` base64) + role koneksi **`motion-vision`** (role sudah
direncanakan/ada; hanya jalur multimodalnya yang dibangun).

**Tanpa provider multimodal** → fase probe terstruktur dilewati: notes
kosong, generate tetap jalan dengan jalur 8-role + kurva/cdi3 (degrade
gracefully, bukan gagal).

Catatan privasi: yang dikirim adalah **render model Live2D, bukan frame
webcam** — aturan "webcam tak pernah di-upload" tidak tersentuh. Tulis
eksplisit di docs keamanan saat implementasi.

### 2e. Cross-check VLM ↔ metrik lokal (poin 2)

Validasi otomatis, murah, tanpa model tambahan:

- **Region**: bbox perubahan vs region yang diklaim VLM (klaim "mata" tapi
  bbox di area mulut → **konflik**).
- **Sign**: arah geser centroid vs `sign`.
- **Side**: sisi layar mana yang bergerak (dengan penanda kiri/kanan frame)
  vs `side`.

Konflik → turunkan `confidence`, tandai `conflict` + alasan teknisnya,
tampil menonjol di panel. Ini menangkap banyak salah label tanpa mata
manusia.

---

## Fase 3 — Panel Approve per Batch (poin 10)

Panel review di Motion Studio, **diurut berdasarkan confidence & status**:

1. `conflict` / confidence rendah / `dead` → **di atas**, wajib mata
   manusia; tampilkan alasan konflik + thumbnail contact sheet + angka metrik.
2. `konsisten` (VLM cocok metrik lokal, confidence tinggi) → di bawah,
   tersedia **approve massal** ("setujui semua yang konsisten").

Aturan:

- Approve → field terstruktur promosi ke layer **`user`** (mutlak);
  tolak → kembali `unclassified` / tawaran probe ulang.
- `user` > `ai` tetap utuh; tidak ada dialog per-param untuk 100+ param —
  seleksi massal aman **hanya** untuk yang sudah `konsisten`.
- Untuk 100+ param, urutan ini yang mencegah user berhenti mereview
  di tengah jalan (pekerjaan berat di depan, yang otomatis di belakang).

---

## Fase 4 — Generate: Planner 2-langkah → Compiler → Critic → Refine

### 4a. Planner 2-langkah (poin 11 — kontrol ukuran prompt)

Jangan kirim seluruh vocabulary ke prompt:

- **Langkah A**: planner memilih **region/role dulu** dari daftar ringkas
  (kepala / mata / mulut / badan / ekspresi / aksesoris / …).
- **Langkah B**: hanya **label di region itu** dari rig report (yang sudah
  di-approve) yang dimuat ke prompt berikutnya.
- **Label di luar vocabulary → ditolak + explicit retry**, tidak dibuang
  diam-diam (polanya sama seperti ID motion asing di §20).

Output planner = storyboard beat (pose semantik + timing + intensitas),
bukan keyframe. Echo-retry yang ada dipertahankan; kalau JSON tetap gagal →
fallback ke jalur 8-role lama.

### 4b. Compiler — `src/client/animation/motion-compiler.ts` (baru)

Beat → keyframe dengan jaminan deterministik:

- **`returnToDefault` default `true`**: keyframe terakhir kembali ke
  default role/param. **`holdEnd` eksplisit dari planner** membolehkan
  gerakan berakhir di pose tertentu (duduk, menoleh lalu bertahan) tanpa
  dipaksa pulang (poin 5). **Loop tetap wajib menutup** (nilai awal ==
  nilai akhir) tanpa kecuali.
- Easing default `ease-in-out`; `linear` harus eksplisit dari planner.
- Beat terlalu cepat → di-stretch, bukan di-snap.
- Clamp ke `safe_range` dari rig report; amplitudo realistis dari statistik
  native (Fase 1), bukan hard-code.
- Gate capability: model tanpa bagian itu → track skip (graceful).
- **Larang track untuk output physics** (gate dari Fase 1).
- **`beatId` disematkan di tiap beat DAN tiap keyframe** hasil compile
  (poin 7) — kunci agar laporan critic bisa dipetakan balik.

### 4c. Critic numerik — `src/client/animation/motion-critic.ts` (baru)

Sampling `evaluateAsset` per ~25 ms → skor + daftar temuan:

- **Jerk** (turunan kecepatan kedua; metrik halus vs kaku).
- Diskontinuitas antar-keyframe bersebelahan.
- Nilai akhir ≠ default (kecuali `holdEnd`) → "nyangkut".
- Pelanggaran bound `safe_range`.
- Dua track rebutan satu field (contention).
- Track untuk output physics (harusnya mustahil setelah compiler — tetap dicek).

**Threshold persentil, bukan hard-code (poin 8):** distribusi jerk dihitung
dari **klip native model** (Fase 1) → batas = **p90** (configurable). Rig
lincah dan rig kalem otomatis dapat standar berbeda. Native sedikit/absen →
fallback nilai global + temuan ditandai `heuristic`.

### 4d. Critic visual opsional (poin 6 — beda dengan critic numerik)

Critic numerik **hanya membaca kurva** — jerk rendah tidak berarti nodding
terlihat ragu, dan artefak deformer (mesh menembus, kelopak tidak menutup
penuh saat dua param digabung) tidak kelihatan dari kurva. Karena itu:

- Render **filmstrip 8–12 frame** hasil playback → VLM (role `motion-vision`)
  menilai **kecocokan dengan intent storyboard** + memeriksa artefak
  deformer.
- **Tanpa provider multimodal → tetap jalan dengan critic numerik saja**
  (degrade graceful, bukan gagal).

### 4e. Laporan terpetakan ke beat + refine loop (poin 7)

Setiap temuan wajib bisa dipetakan:

```text
"jerk melonjak di 0.9s, beat #3, role head.pitch, jerk 4.2 > p90 1.8"
```

Refine loop (maks 3 iterasi) → storyboard + laporan terpetakan → LLM
merevisi **beat saja** (angka keyframe hasil compile tak pernah disentuh
LLM) → compile ulang → critic lagi. Laporan tanpa `beatId` tidak valid untuk
loop.

### 4f. Kebijakan layering eksplisit (poin 9 — didokumentasikan di MOTION-SYSTEM-SPEC)

Prioritas yang sudah ada: `100 manual → 90 native → 80 explicit LLM →
60 gesture → 40 emotion → 20 idle → 10 breathing`. Yang harus dibuat
eksplisit (dan diuji):

- **Pemenang per field** saat contention: prioritas lebih tinggi menang;
  tie → deterministik (urutan registry).
- **Mode per lapis**:
  - **Override**: action/LLM atas idle/breath (cut sama seperti perilaku
    lama saat ini).
  - **Additive**: breath / look-at / **lip-sync** di atas pose yang lebih
    tinggi — lip-sync & look-at tidak boleh membunuh pose bicara.
- Debuggability: log siapa menang per field (menjembatani ke
  watchdog/telemetry yang ada).

Approval user tetap pintu terakhir sebelum save (§17 tidak berubah).

---

## Fase 5 — Ukuran Keberhasilan (poin 13)

Tanpa ini, "berhasil" cuma perasaan:

1. **2–3 model uji dengan gaya rig berbeda** (contoh lokal: lumine, ren,
   神宫白子 — TIDAK ikut repo, contributor memakai model sendiri) dengan
   **label manual sebagai kunci jawaban** — fixture di `test/`, bukan
   menulis di `data/` produksi.
2. **Akurasi probe**: label benar **dan tanda `sign`/`side` benar** vs kunci
   manual — diprose sebagai persentase dalam test.
3. **Critic naik-turun vs turun**: pada gerakan uji, skor critic **wajib
   turun** setelah refine — assertion di test, bukan grafik yang dilihat
   sekali.
4. Threshold & mekanisme ditulis di `MOTION-SYSTEM-SPEC.md`.

---

## Urutan eksekusi

1. **Fase 1** — rig report + invalidasi hash (fondasi, tanpa LLM).
2. **Fase 3** — struktur notes + panel batch (skeleton dulu, bisa tanpa isi).
3. **Fase 2** — probe (settle physics, sweep bertingkat, metrik lokal,
   VLM terstruktur + cross-check) — butuh image parts di `llm.rs`.
4. **Fase 4** — planner 2-langkah + compiler + critic persentil + critic
   visual opsional + refine terpetakan + kebijakan layering.
5. **Fase 5** — fixture uji + akurasi + assertion critic turun; tests &
   docs menyertai tiap fase (bukan menumpuk di akhir).

## Tests & docs pendamping (sekaligus, tiap fase)

- **Unit TS**: compiler (holdEnd, returnToDefault, loop-closure, beatId,
  physics-gate), critic (persentil native, jerk/end-stuck/contention,
  laporan terpetakan), label→resolve, cross-check konflik, stale-cache.
- **Rust**: rig_report parse (physics split, provenance, hash invalidation),
  image-parts serialisasi, planner retry label di luar vocab.
- **Guard baru**: path `motion_ai` tak boleh memuat `Param[X]` mentah di
  luar rig report; loop `holdEnd` tetap menutup (tidak ada loop terbuka).
- **i18n**: semua string UI baru di `src/client/i18n/` id + en (dicek
  `test/i18n.test.ts`).
- **Docs**: entri pipeline baru di `MOTION-SYSTEM-SPEC.md` §16–17 +
  kebijakan layering + ukuran sukses; catatan provenance/notes & definisi
   `side` = karakter di `MODEL-AGNOSTIC-RULES.md`; progres dicatat di handoff
   lokal (di-gitignore, bukan acuan contributor).
- **Gate akhir**: `bun run build` + `bunx tsc --noEmit` + `bun run test` +
  `cargo test --workspace` semua hijau.

## Risiko

- `static/js/motion-editor.js` legacy (±1.700 baris, belum dijaga guard) —
  UI panel di sana tapi **logika baru di modul TS yang teruji**.
- Prompt planner lebih panjang dari sekarang → dua-langkah (4a) membatasi
  ukuran; echo-retry + fallback jalur 8-role lama bila JSON gagal.
- Sheet schema baru → cek `SHEET-SYSTEM.md` + guard `test-fase1-sheet-schema`
  sebelum menyentuh penyimpanan.
- Sweep bersyarat menaikkan jumlah capture/VLM call → batasi retry
  `coupled_with` (maks ~3 kombinasi).
- Rencana ini mengubah perilaku generate; jalur lama (`/api/motions/generate`
  satu-tembak) dipertahankan sebagai fallback sampai Fase 4 stabil.
