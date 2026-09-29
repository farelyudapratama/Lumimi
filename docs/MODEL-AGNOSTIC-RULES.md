# ATURAN: Sistem Harus Model-Agnostic

> **Prinsip yang tidak bisa dinegosiasikan.** Sistem ini harus jalan dengan
> model Live2D Cubism **apa pun** yang diimpor user — bukan cuma model yang
> kebetulan ada di `data/model/` sekarang (lumine, 神宫白子). Jangan pernah
> menyetel parameter spesifik hanya untuk model-model itu.
>
> Berlaku untuk SEMUA kode di repo ini, legacy maupun TS. Setiap pelanggaran
> pada tabel di bawah nyata pernah terjadi — kode yang memicunya masih hidup
> di `static/js/app.js`, jadi aturan ini jauh dari teoretis.

## Kenapa aturan ini ada

Kegagalannya **senyap**. Kalau sebuah fitur mengambil makna dari nama, angka,
atau urutan yang bebas ditentukan rigger, tidak akan ada error — karakternya
cuma jadi datar, salah gerak, atau menggerakkan bagian tubuh yang keliru.
User baru sadar setelah lama memakai. Empat pelanggaran nyata yang pernah ada
di kode ini:

| # | Pelanggaran | Akibat terukur |
|---|---|---|
| 1 | `ROLE_KEYWORDS.blush` menaruh `'Param91'` di prioritas tertinggi | Model lain yang punya `Param91` untuk keperluan berbeda (ekor, kancing) akan menggerakkan bagian itu setiap karakter malu |
| 2 | `PARAM_META` hardcode 9 id aksesoris bernomor dari satu model | `9` aksesoris terdeteksi di satu model, `0` di model lain. Blok itu ternyata **100% redundan** — aturan generik sudah menangkap 9/9 |
| 3 | `mapRoles()` memakai `lipSyncIds[0]` | Urutan grup `model3.json` **arbitrer**. Di lumine indeks 0 = `ParamMouthForm`, jadi `mouthOpenY` beralias ke `mouthForm` → 3 penulis berebut 1 param → **mulut tidak pernah membuka** |
| 4 | `eyeBlinkIds[0]`/`[1]` diasumsikan L-lalu-R | Rigger yang menulis R dulu akan membuat mata kiri/kanan tertukar |
| 5 | `ParamHair*` spekulatif di `PARAM_META` | 0/3 cocok di kedua model — murni tebakan |
| 6 | **Nilai literal ditulis langsung ke param role** (bypass skala) | `pokeParam(eyeLOpen, 0/1)`, `pokeParam(breath, 0..1)`, lip-sync `Math.min(1, …)`, mouth-rest `0`. Kedua model bundled **sama-sama** pakai `eyeOpen` 0..1 dan `angle` ±30 — itulah kenapa bypass ini tak pernah kelihatan |
| 7 | **Kemampuan model dibaca dari manifest saja, bukan dari disk** | `model3.json` lumine mendaftarkan 0 `FileReferences.Expressions` padahal ada 19 `.exp3.json` di folder. `pixi-live2d-display` hanya membuat ExpressionManager kalau `settings.expressions` truthy, jadi 19 aset mati **tanpa error** dan model tampak "tidak punya ekspresi" |

Nomor 3 dan 4 satu spesies dengan 1 dan 2: **mengambil makna dari urutan array
sama rapuhnya dengan mengambil makna dari nama.** Nomor 6 juga: **menulis angka
literal ke param role sama saja mengasumsikan konvensi numerik rigger.**
Nomor 7 adalah sisi lain koin yang sama: **mempercayai deklarasi rigger sebagai
inventaris lengkap** — manifest bisa tidak lengkap, dan diam-diam kehilangan
19 aset terasa persis sama seperti model yang memang datar.

## Menulis ke parameter: HANYA lewat role space

Semua gerak ditulis dalam **skala referensi** (±30 untuk role derajat, ±1 untuk
role ternormalisasi), lalu dipetakan ke range **nyata** milik model. Jangan pernah
menulis angka literal ke param role.

| Helper | Untuk | Arti |
|---|---|---|
| `pokeRoleRef(role, vRef)` | sudut, arah pandang | `vRef` skala referensi → dipetakan proporsional ke range model |
| `pokeRoleNorm(role, t)` | kedip, napas, buka mulut | `t` 0..1 → `min`..`max` milik model |
| `roleDefault(role)` | nilai istirahat | default **milik model**, bukan `0` |

Kenapa penting: rig yang memakai `eyeOpen` 0..100 akan menerima `pokeParam(id, 1)`
sebagai **1% terbuka** — matanya tampak terpejam terus, tanpa satu pun error.
Begitu juga rig yang `mouthOpen`-nya istirahat di nilai bukan-nol, atau yang
range kepalanya asimetris (`-10..+40`, netral di `+15`) — mengasumsikan `0`
sebagai tengah membuat kepalanya miring permanen.

## Tingkatan sumber makna (pakai dari atas)

1. **Kurva `.motion3.json`** — mengukur apa yang klip *benar-benar lakukan*. Paling tepercaya.
2. **`.cdi3.json` display name** — label asli si rigger (`Param92` → `"生气"`). Ikut di setiap ekspor Cubism dan sering dilupakan.
3. **`model3.json` `Groups`** — otoritatif soal param mana yang **anggota** grup, **tapi tidak soal urutannya**. Pakai sebagai kumpulan kandidat, lalu pilih berdasarkan nama.
4. **ID kanonik Cubism** (`ParamMouthOpenY`) — biasanya ada, tidak dijamin.
5. **Regex nama** — hanya pemecah seri. **Jangan pernah** memuat id bernomor.

## Yang dilarang

- ❌ ID bernomor (`Param91`, `Param92`) di tabel universal mana pun
- ❌ Mengambil makna dari indeks array (`lipSyncIds[0]`, `eyeBlinkIds[1]`)
- ❌ Mendaftar aksesoris secara manual — **deteksi bentuknya**: range 0..1, default 0, bukan role
- ❌ Menebak lalu diam. Kalau ambigu, **jangan resolve** — tidak ada lebih aman daripada salah
- ❌ Menambah satu regex per nama yang tidak cocok (begitulah 7 pola khusus Ichika dulu menyusup)
- ❌ Menyimpulkan kemampuan model **hanya** dari `model3.json` — periksa juga apa yang benar-benar ada di disk

## Yang wajib

- ✅ **Ukur dari model**, jangan asumsikan dari daftar
- ✅ Gate setiap penulisan param: `state.modelParams.has(id)` / `sheet.controls`
- ✅ Invariant eksplisit: `mouthOpenY !== mouthForm` (dicek di `mapRoles`, `static/js/app.js`)
- ✅ Tolak id dari `Groups` yang tidak dimiliki model (metadata bisa basi)
- ✅ Laporkan provenance, bukan cuma persen: `curveClassified / nameOnly / unclassified`
- ✅ Kalau melengkapi manifest yang tidak lengkap: **in-memory saja**, jangan tulis
  ke file model, dan jangan pernah menimpa apa yang rigger sudah deklarasikan

## Di mana aturan ini hidup di kode

| Logika | Lokasi |
|---|---|
| Role mapping client (`ROLE_KEYWORDS`, `pokeRole*`, `toActual`) | `src/client/engine/role-mapping.ts` → `static/js/bundle.js`; dipakai app.js |
| Role mapping renderer (roleInfo, faktor look/breath, fallback blink) | `src/live2d/RoleController.ts` + `Live2DRenderer.ts` |
| Tulis parameter dari driver/UI | backend `coreModel` di `src/live2d/view/Live2DView.ts` (SET + ADD, flush order 900) |
| Pipeline motion (evaluator, sanitize, bounds) | `src/client/animation/motion-dsl.ts` → `static/js/bundle.js` |
| Klasifikasi klip native (kurva + cdi3 + name-hint) | `src/client/engine/motion-taxonomy.ts` (server & bundle) |
| Adopsi `.exp3` yatim (discovery) | `core/src/expressions.rs` (`expressions::discover`) → diteruskan ke renderer via `loadModel(path, settings)` |

Aturan model-agnostic berlaku ke SEMUA lokasi itu — termasuk file TS baru: jangan
pernah memasukkan nama model, id `Param…`, atau range spesifik ke
`src/client/animation/*.ts` maupun `core/src/*`.

## Cara membuktikan tidak melanggar

Guard model-agnostic: uji invariansi penggantian nama di
`test/role-mapping.test.ts` (rig Inggris/Jepang/Mandarin resolve ke role yang
sama; rig opaque `m_001`..`m_020` resolve ke nol role) plus guard di
`test/legacy/` (param-notes-ui, sheet-schema, exp3-adoption, api-origin,
core6-compat) dan `test/motion-taxonomy.test.ts`, dijalankan lewat runner
sendiri:

```bash
bun run test:guards   # hanya guard legacy
bun run test:unit     # unit test TS (parser, DSL/registry, dispatcher server)
bun run test          # keduanya
```

`test-role-mapping.js` melakukan **uji invariansi penggantian nama**: rig yang
sama dideskripsikan dalam kosakata Inggris / Jepang / Mandarin harus me-resolve
ke *role* yang sama. Ada juga kasus **model opaque** (`m_001`..`m_020`) yang
harus resolve ke **nol role** — membuktikan tidak ada positif palsu — dan dua
**guard yang membaca `static/js/app.js` langsung**, sehingga id bernomor tidak
bisa menyusup balik tanpa memerahkan test.

Kalau menambah logika yang menyimpulkan makna: jalankan ulang dengan semua nama
diganti `m_001` / `モーション1` / hash, lalu bandingkan. Kalau distribusi
hasilnya kolaps, logika itu masih bergantung nama.

## Catatan sheet

`data/sheets/*.json` adalah **cache hasil scan**, bukan sumber kebenaran. Kalau
logika role-mapping berubah, sheet lama jadi basi dan menyimpan hasil resolusi
yang salah. Bagian H `test-role-mapping.js` me-resolve ulang dari daftar param
dan akan memberi tahu kalau sheet di disk perlu di-scan ulang.
