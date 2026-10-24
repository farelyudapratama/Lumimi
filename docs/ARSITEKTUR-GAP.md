# GAP AUDIT: sisa follow-up

> Audit Phase A/B/C terhadap [`ARSITEKTUR-TARGET.md`](ARSITEKTUR-TARGET.md), dibuat
> 2026-09-19 di branch `migration/pixi8-cubism`. **Rework perilaku (Fase 2 sampai 6,
> gap §6-12 / §15-18 / §32-34) sudah tertutup 2026-09-19.** Yang tersisa di bawah ini
> hanya item terbuka, dengan status diverifikasi terhadap kode saat kondensasi
> (2026-09-24). (Handoff sesi lama `STATUS-CUBISM5-EFEK.md` kini lokal/di-gitignore,
> bukan acuan contributor.)

## Sisa follow-up

- **Verifikasi runtime visual VTuber overlay (OBS).** Wiring `window.__live2dView`
  sudah ada di `static/vtuber.html` (loadModel + setLipsyncProvider; ekspresi native
  aman no-op bila model tak punya yang cocok). Yang belum tercatat: menjalankan
  verifikasi runtime penuh model + TTS + overlay OBS bersamaan. (§7)
- **`CapabilityAnalyzer.ts` — SELESAI: DIHAPUS (2026-09-29).** Orphan sejak
  audit ini (produksi memakai `detectModelCapabilities` di `app.js` +
  `getCapabilityProfile` di `Live2DView.ts`); file beserta blok testnya
  dibuang sebagai kode mati terverifikasi.
- **Expression semantik cocok native by-name saja (tanpa alias).** Nama emosi
  seperti "happy" tidak otomatis cocok dengan `.exp3` bernama "smile". (§21)

## Known by-design (bukan TODO, jangan "diperbaiki" tanpa alasan)

- **Dua kanal tulis manual di order 900 hidup berdampingan:** `AppWriteUpdater`
  (jalur app.js) dan `ArbiterUpdater` (`ParameterArbiter`, praktis dormant di
  integrasi view). `coreModel` sengaja bocor sebagai pintu tulis legacy yang
  ditampung aman.

Aturan per fase (ARSITEKTUR-TARGET §46): satu boundary per waktu; guard/test
diperbarui di commit yang sama; verifikasi runtime setelah perubahan; jangan
memperbaiki masalah satu layer lewat layer lain.

## Follow-up motion pipeline (baru diverifikasi 2026-10-17)

Bukan bagian Fase A/B/C, tapi sisa backlog [`PLAN-MOTION-PIPELINE.md`](PLAN-MOTION-PIPELINE.md)
dicatat di sini supaya tidak hilang. Rincian status per fase ada di blok
"Status implementasi" dokumen itu:

- Cache-hash/stale UI untuk **rig report** (approve panel kini memvalidasi
  `modelHash` entri approve, tapi laporan rig-report sendiri masih di-fetch
  ulang tiap buka studio/panel).
- Probe: sweep bersyarat `coupled_with`, atribusi per mesh/drawable, penanda
  kiri/kanan frame untuk `side` (cross-check `side` menunggu penanda ini;
  region-vs-bbox sudah ter-wire di panel approve).
- Refine LLM terpetaan per `beatId` (server kini refine dengan validator
  generik maks 3x; klien refine per-beat deterministik via panel Terima Batch).
- Feed distribusi jerk native dari disk ke critic numerik (UI masih heuristic;
  `motion-editor.js` saat ini mengirim `{ nativeJerkSamples: null }` —
  placeholder yang terlihat seperti sudah ter-wired padahal tidak).
- holdEnd beats: prompt beats menyuruh LLM "berakhir di pose", tapi compiler
  masih selalu pulang ke base (`returnToDefault` hardcoded) — buat holdEnd
  sungguhan di compiler, atau koreksi promptnya (tambahan 2026-10-24, lihat
  §17c `MOTION-SYSTEM-SPEC.md`).
- Kebijakan layering 4f — SEBAGIAN sudah ada lewat metode lain: `ParameterArbiter`
  (`src/live2d/ParameterArbiter.ts`) sudah menentukan pemenang per param
  (prioritas sumber menang, seri → seq terbaru = deterministik) + `hasConflict`;
  additive berjalan lewat updater ber-gate (blink/breath/look/lipsync) +
  `pokeAddParam`. Yang belum: log pemenang per field, test kebijakan eksplisit,
  dan dua tabel prioritas (arbiter render-side vs playback runtime) belum
  disatukan/diuji (koreksi 2026-10-24 — sebelumnya ditulis "belum ada").
- Fixture multi-model dengan label manual + pengukuran akurasi probe (Fase 5 penuh).
  Panel approve (2026-10-24) sudah menyediakan alur promosi; yang kurang tinggal
  fixture berlabel + metrik akurasi.

Selesai 2026-10-24 (dibangun sebagai "Fase 3 bentuk asli", lihat
`MOTION-SYSTEM-SPEC.md` §17c–§17d): panel approve batch + persist
`probeApprovals.user` (sheet v5), wiring `crossCheck` (region-vs-bbox di panel),
konsumen `modelHash` (badge stale + validasi entri), override role-mapping
tier 0 (`mapRoles` + `setRoleOverrides` runtime), beat kind param di planner
(`probeParams` → `parse_beats` → compiler track `kind:"param"`).
