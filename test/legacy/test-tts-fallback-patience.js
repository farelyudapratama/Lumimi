#!/usr/bin/env node
/* test-tts-fallback-patience.js — kontrak kesabaran TTS remote.
 *
 * WHY THIS EXISTS
 * Laporan user: generate provider yang lambat (Gemini terukur 10-16 dtk,
 * paket hematRequest ±800 char, antrean Gradio) tiba-tiba DIGANTIKAN suara
 * browser. Penyebabnya timeout absolut pendek (20/45 dtk) di fetchTTSAudio
 * yang meng-abort request yang masih sehat, retry ikut timeout, lalu catch
 * jatuh ke browserTTS — generate lambat diperlakukan seperti kegagalan.
 * Kontrak yang dijaga di sini: generate lambat BUKAN gagal. Fallback suara
 * browser hanya boleh terjadi saat provider benar-benar error (HTTP/
 * network) atau request menggantung melebihi budget lebar; watchdog
 * pipeline re-arm per fase supaya segmen lambat tidak terpotong di tengah
 * menunggu/memutar.
 *
 * Run: node test/legacy/test-tts-fallback-patience.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// Potong tubuh fetchTTSAudio (fungsi berikutnya di region TTS: playTTSAudio).
const mFetch = appSrc.match(/async function fetchTTSAudio\([\s\S]*?\n  function playTTSAudio/);
ok('fetchTTSAudio ditemukan di app.js', !!mFetch);
const fetchBody = mFetch ? mFetch[0] : '';

function evalNum(expr, hasLang) {
  try {
    const v = Function('"use strict"; const hasLang = ' + JSON.stringify(hasLang) +
      '; return (' + expr + ');')();
    return typeof v === 'number' && isFinite(v) ? v : NaN;
  } catch (e) { return NaN; }
}

section('budget timeout fetchTTSAudio (jaring penggantung, bukan ukur kegagalan)');
const mBudget = fetchBody.match(/const budgetMs = ([^;]+);/);
ok('budgetMs satu konstanta yang bisa dihitung', !!mBudget);
const noLang = mBudget ? evalNum(mBudget[1], false) : NaN;
const withLang = mBudget ? evalNum(mBudget[1], true) : NaN;
ok('budget tanpa bahasa tetap >= 120 dtk (melebihi upstream server 60 dtk + retry internal)',
  noLang >= 120000, isFinite(noLang) ? noLang + ' ms' : 'budgetMs tidak ditemukan/tak terhitung');
ok('budget bahasa tetap >= 150 dtk (server bisa terjemah LLM dulu, +60 dtk)',
  withLang >= 150000, isFinite(withLang) ? withLang + ' ms' : 'budgetMs tidak ditemukan/tak terhitung');
ok('tanpa timeout absolut pendek (20/45 dtk) tersisa di fetchTTSAudio',
  !/\b(20000|45000)\b/.test(fetchBody));

section('retry & abort claim');
ok('preempt/stop (parentSignal sudah aborted) tidak di-retry',
  fetchBody.indexOf('parentSignal.aborted') !== -1 &&
  fetchBody.indexOf('parentSignal.aborted') < fetchBody.indexOf('attempt >= 1'));

section('watchdog pipeline per-fase (bukan flat 60 dtk)');
const mWatch = appSrc.match(/const WATCHDOG_FETCH_MS = (\d+);/);
ok('watchdog fase menunggu sintesis >= 150 dtk',
  !!mWatch && Number(mWatch[1]) >= 150000, mWatch ? mWatch[1] + ' ms' : 'tidak ditemukan');
ok('watchdog fetch re-arm setelah pemutaran selesai (segmen berikutnya)',
  /if \(i \+ 1 < segments\.length\) guard\(WATCHDOG_FETCH_MS\);/.test(appSrc));
ok('watchdog pemutar ikut durasi segmen (playbackRate 0.5 → durasi 2×)',
  /guard\(segText\.length \* 150 \+ 25000\)/.test(appSrc));

section('jalur satu segmen: watchdog pemutar ikut panjang teks');
ok('paket hematRequest (±800 char ≈ >1 menit audio) tidak terpotong flat 45 dtk',
  /Math\.max\(45000, text\.length \* 150 \+ 20000\)/.test(appSrc));

section('fallback suara browser tetap ada HANYA untuk kegagalan nyata');
ok('error request tunggal → browserTTS (HTTP/network, bukan lambat)',
  /remote gagal, fallback ke browser/.test(appSrc));
ok('segmen gagal → sisa kalimat via browserTTS',
  /segmen " \+ i \+ " gagal/.test(appSrc));
ok('watchdog lama dicabut sebelum browserTTS di jalur pipeline',
  /if \(sess\.fallbackTimer\) clearTimeout\(sess\.fallbackTimer\);[\s\S]{0,120}browserTTS\(remaining/.test(appSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
