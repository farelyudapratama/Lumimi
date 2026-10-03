#!/usr/bin/env node
/* test-param-notes-ui.js — popup "Penjelasan Parameter": pencarian + header grup
 * + label cdi3, dan payload analyze-sheet yang membawa grup.
 *
 * WHY THIS EXISTS
 * Popup memuat 200+ baris slider (lumine: 223) — tanpa pencarian dan tanpa
 * header grup, navigasinya buta. Label pun harusnya nama ASLI rigger dari
 * cdi3.json ("heart eye", "eyelashes shake4"), bukan id mentah yang diketik
 * ulang. Sementara itu payload saran preset AI kini mengirim grup supaya LLM
 * tahu param mana yang sekeluarga (dan tidak menebak makna dari id).
 *
 * Run: node test/legacy/test-param-notes-ui.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'static', 'css', 'app.css'), 'utf8');
// Server = Rust core (arsip Bun src/server dihapus Batch A 2026-09-23). Prompt
// saran preset dirakit di core/src/sheet_ai.rs — kontrak "[grup: …]" dijaga di
// sana (cargo test) DAN sumber-levelnya di-guard di bawah.
const serverSrc = fs.readFileSync(path.join(ROOT, 'core', 'src', 'sheet_ai.rs'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── 1. UI pencarian ──────────────────────────────────────────────────────────
section('kotak pencarian popup');
ok('input #pn-search ada di index.html (di dalam popup paramnotes)',
  /id="paramnotes-popup"[\s\S]{0,2000}id="pn-search"/.test(htmlSrc));
ok('pnSearch ter-wire ke event input',
  /const pnSearch = \$\('#pn-search'\);/.test(appSrc) &&
  /pnSearch\.addEventListener\('input', applyPnFilter\)/.test(appSrc));
ok('applyPnFilter membaca catatan yang sedang diedit (bukan hanya label)',
  /function applyPnFilter\(\)[\s\S]{0,600}\.pn-input[\s\S]{0,300}pn-hidden/.test(appSrc));
ok('header grup tanpa baris terlihat ikut disembunyikan',
  /pn-group-header[\s\S]{0,900}classList\.toggle\('pn-hidden', !anyInGroup\)/.test(appSrc));
ok('CSS: .pn-hidden & .pn-group-header terdefinisi',
  /\.pn-row\.pn-hidden \{ display: none; \}/.test(cssSrc) &&
  /\.pn-group-header \{/.test(cssSrc));

// ── 2. header grup ───────────────────────────────────────────────────────────
section('header grup dari resolveParamGroup');
ok('renderParamNotesPopup mengelompokkan param sebelum render',
  /const byGroup = new Map\(\);[\s\S]{0,600}appendGroupHeader\(pnList, g, members\.length\)/.test(appSrc));
ok('appendGroupHeader menulis judul + jumlah param',
  /function appendGroupHeader\(list, title, count\)[\s\S]{0,500}textContent = count \+ ' param'/.test(appSrc));
ok('Bagian (Parts) tetap jadi grup sendiri di ujung (label lewat i18n)',
  /appendGroupHeader\(pnList, __t\("sheet\.groupParts"\), parts\.length\)/.test(appSrc));
ok('ID param = teks utama di baris slider; label hanya pelengkap (audit i18n 2026-09-29)',
  /idEl\.textContent = id;/.test(appSrc) &&
  /if \(label && label !== id\) \{[\s\S]{0,200}lEl\.textContent = "· " \+ label;/.test(appSrc));

// ── 3. label cdi3 ────────────────────────────────────────────────────────────
section('label + grup asli rigger dari cdi3');
ok('prefetchCdiInfo dipanggil saat loadModel (fire-and-forget)',
  /prefetchCdiInfo\(\)/.test(appSrc));
ok('cdi3 diambil via DisplayInfo dari model3.json',
  /FileReferences && m3\.FileReferences\.DisplayInfo/.test(appSrc));
ok('state.cdiInfo dibuang saat model diganti (id param antar model tak bisa dipertukarkan)',
  /state\.cdiInfo = null;/.test(appSrc));
ok('inspectModel memakai label cdi3 bila ada, id mentah sebagai fallback',
  /const label = \(cdiById && cdiById\.get\(rp\.id\) && cdiById\.get\(rp\.id\)\.label\) \|\| rp\.id;/.test(appSrc));
ok('judul grup rigger diberi penanda "Rig: " + label anggota',
  /function cdiGroupTitle\(gid\)[\s\S]{0,500}'Rig: ' \+ named\[0\]/.test(appSrc));
ok('sheet yang sudah ada di-patch in place saat cdi3 tiba (tanpa menunggu re-inspect)',
  /p\.label !== info\.label\) \{ p\.label = info\.label; changed = true; \}/.test(appSrc));
ok('render ulang popup hanya lewat jembatan (scope terpisah, tanpa akses langsung)',
  /window\.__pnRefreshIfOpen\(\)/.test(appSrc) &&
  /window\.__pnRefreshIfOpen = \(\) => \{/.test(appSrc));

// ── 4. payload analyze-sheet ─────────────────────────────────────────────────
section('payload saran preset AI membawa grup');
ok('allParams menyertakan group hasil resolveParamGroup',
  /\.map\(p => \(\{ id: p\.id, min: p\.min, max: p\.max, def: p\.def, label: p\.label \|\| '',[\s\S]{0,200}group: resolveParamGroup\(sheet, p\.id, p\.group\) \}\)\)/.test(appSrc));
ok('server menulis [grup: …] ke baris param prompt',
  /format!\(" \[grup: \{\}\]", s\.chars\(\)\.take\(40\)/.test(serverSrc));
ok('server tetap memvalidasi tipe group (string sebelum dipakai)',
  /get\("group"\)\.and_then\(\|v\| v\.as_str\(\)\)\.map\(\|s\| s\.trim\(\)\)\.filter\(\|s\| !s\.is_empty\(\)\)/.test(serverSrc));

// ── 5. pose preset bisa dibatalkan + tes ekspresi teradopsi ─────────────────
section('reset pose preset & tes ekspresi');
ok('applyPreset mencatat param yang di-sticky (basis tombol Reset Pose)',
  /setSticky\(id, Math\.max\(lo, Math\.min\(hi, Number\(raw\)\)\), 1\);[\s\S]{0,80}presetPoseParams\.add\(id\);/.test(appSrc));
ok('opacity part dicatat SEBELUM diubah sebagai dasar pemulihan',
  /if \(!presetPoseParts\.has\(id\)\) \{[\s\S]{0,400}getPartOpacityById\(id\);/.test(appSrc));
ok('releasePresetPose menghapus override + memulihkan part + resetEmotion',
  /function releasePresetPose\(\)[\s\S]{0,900}delete state\.overrides\[id\];[\s\S]{0,1400}setPartOpacityById\(id,[\s\S]{0,1600}resetEmotion\(\);/.test(appSrc));
ok('releasePresetPose total: SEMUA override + motion berhenti + aiPose di-nol-kan + param ke default',
  /for \(const id in state\.overrides\) delete state\.overrides\[id\];[\s\S]*?stopAllMotions\(\);[\s\S]*?state\.aiPose = \{[\s\S]*?setParameterValueById\(id, def, 1\);/.test(appSrc));
ok('tombol Reset Pose ada di atas daftar preset (label lewat i18n)',
  /resetBtn\.textContent = __t\("sheet\.resetPose"\);/.test(appSrc));
ok('setiap ekspresi teradopsi punya tombol tes (pasang di model, label lewat i18n)',
  /testBtn\.textContent = __t\("sheet\.testBtn"\);/.test(appSrc) &&
  /await state\.model\.expression\(e\.Name\)/.test(appSrc));
ok('tes ekspresi yang belum dikenal model memicu muat ulang lalu status jujur (bukan gagal senyap)',
  /state\.modelExpressions \|\| \[\]\)\.some\(/.test(appSrc) &&
  /if \(!known\) \{[\s\S]{0,400}await loadModel\(state\.modelPath\);/.test(appSrc) &&
  /__t\("sheet\.exprFail"/.test(appSrc));
ok('hint System Prompt menjelaskan scope koneksi (persona tetap di Catatan Karakter)',
  /Persona karakter jangan di sini: pakai Catatan Karakter/.test(htmlSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
