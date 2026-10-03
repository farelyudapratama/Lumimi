#!/usr/bin/env node
/* test-api-origin.js — the backend origin must be DERIVED, never a literal port.
 *
 * WHY THIS EXISTS
 * The server honours `process.env.PORT` (`const PORT =
 * Number(process.env.PORT) || 8310`), but the frontend once had `http://127.0.0.1:8310`
 * written out in 11 places across js/app.js and agent.js. Start the server on any
 * other port — a second instance for testing, or 8310 already taken — and the page
 * loads fine (it's served by that server) while every single fetch goes to a port
 * with nothing on it. Symptom: config never loads, chat does nothing, model list
 * empty, no obvious cause.
 *
 * Satu-exe (2026-09-22): halaman di-embed di Companion.exe (origin lokal
 * tauri.localhost) → basis HTTP default (location.origin) SALAH untuk API/model
 * (server statis embed tak punya /api/* dan data/ runtime). Basis disamakan ke
 * loopback proses-sendiri: app.js via refreshApiBase() (IPC server_port),
 * modul TS via transport.httpBase(). Guard ini mengunci: derivasi default
 * tetap location.origin-or-literal (dev/browser tak berubah), tanpa literal
 * liar, dan app.js memuat refresh IPC.
 *
 * Run: node test/test-api-origin.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'app.js'), 'utf8');
// v2: otak agent kini TS (src/client/agent/brain.ts) — guard yang sama berlaku.
const agentSrc = fs.readFileSync(path.join(ROOT, 'src', 'client', 'agent', 'brain.ts'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── 1. no stray literals ─────────────────────────────────────────────────────
section('no hardcoded origin outside the documented fallback');

for (const [label, src] of [['static/js/app.js', appSrc], ['src/client/agent/brain.ts', agentSrc]]) {
  const lines = src.split(/\r?\n/);
  const hits = [];
  lines.forEach((line, i) => {
    if (!/127\.0\.0\.1:8310|localhost:8310/.test(line)) return;
    // Allowed: the comment explaining the fix, and the single file:// fallback
    // literal in the API derivation.
    const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
    const isFallback = /:\s*['"]http:\/\/127\.0\.0\.1:8310['"]\s*;?\s*$/.test(line);
    if (isComment || isFallback) return;
    hits.push(`${i + 1}: ${line.trim()}`);
  });
  ok(`${label}: no literal :8310 in live code`, hits.length === 0,
    hits.length ? hits.join(' | ') : 'clean');
}

// Every fetch must go through the derived constant (app.js legacy) atau seam
// transport (brain.ts TS — single source di src/client/transport).
{
  const fetches = appSrc.match(/fetch\(\s*['"`]https?:\/\/[^'"`]+/g) || [];
  ok(`static/js/app.js: no fetch() to an absolute literal URL`, fetches.length === 0,
    fetches.length ? fetches.join(' | ') : 'clean');
  const viaApi = (appSrc.match(/fetch\(API\s*\+/g) || []).length;
  ok(`static/js/app.js: fetches route through API constant`, viaApi > 0, viaApi + ' call site(s)');
}
{
  const fetches = agentSrc.match(/fetch\(\s*['"`]https?:\/\/[^'"`]+/g) || [];
  ok(`src/client/agent/brain.ts: no fetch() to an absolute literal URL`, fetches.length === 0,
    fetches.length ? fetches.join(' | ') : 'clean');
  // brain.ts tak lagi punya const API sendiri — basis via transport.httpBase
  // (+ modeGet untuk domain MODE). Perilaku transport diuji di
  // test/transport.test.ts (bun), bukan di sini.
  ok(`src/client/agent/brain.ts: no own API literal`, !/127\.0\.0\.1:8310|localhost:8310/.test(agentSrc), 'clean');
  ok(`src/client/agent/brain.ts: routes through transport seam`,
    /from\s*["']\.\.\/transport["']/.test(agentSrc) && /httpBase\(\)/.test(agentSrc), 'httpBase in use');
  ok(`src/client/agent/brain.ts: mode domain via IPC helper`, /transport\.modeGet\(\)/.test(agentSrc), 'transport.modeGet in use');
}

// ── 2. the derivation behaves ────────────────────────────────────────────────
section('derivation under each protocol');

// The file uses CRLF, so anchor on the fallback literal rather than ';\n'.
// app.js memakai `let` (satu-exe) — terima keduanya.
const API_EXPR_RE = /(const|let) API = \(typeof location[\s\S]*?'http:\/\/127\.0\.0\.1:8310';/;

function deriveWith(locObj) {
  // Extract and evaluate the REAL expression from js/app.js rather than a copy.
  // `const` does not create a property on the vm global, so export it explicitly.
  const m = appSrc.match(API_EXPR_RE);
  if (!m) return { err: 'expression not found' };
  const sandbox = { location: locObj, __out: undefined };
  vm.createContext(sandbox);
  vm.runInContext(m[0] + '\n;__out = API;', sandbox);
  return { api: sandbox.__out };
}

ok('API derivation expression extracted from js/app.js', API_EXPR_RE.test(appSrc));

let r = deriveWith({ protocol: 'http:', origin: 'http://127.0.0.1:8310' });
ok('default port → same origin', r.api === 'http://127.0.0.1:8310', r.api);

r = deriveWith({ protocol: 'http:', origin: 'http://127.0.0.1:8399' });
ok('PORT=8399 → follows the page, not the literal', r.api === 'http://127.0.0.1:8399', r.api);

r = deriveWith({ protocol: 'http:', origin: 'http://192.168.1.50:8310' });
ok('LAN host → keeps the host (would 404 on 127.0.0.1 from another device)',
  r.api === 'http://192.168.1.50:8310', r.api);

r = deriveWith({ protocol: 'https:', origin: 'https://live2d.example.com' });
ok('https origin preserved (no mixed-content downgrade)',
  r.api === 'https://live2d.example.com', r.api);

r = deriveWith({ protocol: 'file:', origin: 'null' });
ok('file:// → falls back to the literal (origin is "null" there)',
  r.api === 'http://127.0.0.1:8310', r.api);

// A missing `location` must not throw at load time — app.js is also parsed by
// the other test harnesses in this directory.
const m = appSrc.match(API_EXPR_RE);
let threw = false;
try {
  const sb = { __out: undefined };
  vm.createContext(sb);
  vm.runInContext(m[0] + '\n;__out = API;', sb);
  ok('no location at all → literal fallback, no throw', sb.__out === 'http://127.0.0.1:8310', sb.__out);
} catch (e) { threw = true; }
ok('derivation never throws on a headless context', !threw);

// ── 3. server side actually honours PORT (Rust core — Bun server dihapus) ───
section('server side of the contract (core/src — Rust)');
const srvSrc = fs.readFileSync(path.join(ROOT, 'core', 'src', 'main.rs'), 'utf8')
  + fs.readFileSync(path.join(ROOT, 'core', 'src', 'lib.rs'), 'utf8');
ok('core reads env PORT', /env::var\("PORT"\)/.test(srvSrc));
ok('core default is still 8310 (no behaviour change for normal use)',
  /unwrap_or\(8310\)/.test(srvSrc));

// ── 4. satu-exe: app.js memuat refresh IPC + loader absolut ────────────────
section('satu-exe wiring (static/js/app.js)');
ok('app.js: refreshApiBase() ada (IPC server_port saat embedded)',
  /function refreshApiBase\(\)/.test(appSrc) && /server_port/.test(appSrc));
ok('app.js: boot menunggu basis sebelum fetch pertama',
  /await refreshApiBase\(\)/.test(appSrc));
// Boot fetcher yang jalan saat eval (sebelum boot utama) WAJIB menunggu basis
// dulu — di exe, API awal = tauri.localhost sampai IPC server_port selesai.
ok('loadAppConfig menunggu basis sebelum fetch (race embedded)',
  /async function loadAppConfig\(\) \{[\s\S]{0,500}await refreshApiBase\(\)/.test(appSrc), 'synced');
ok('updateTTSNativeStatus menunggu basis sebelum fetch (race embedded)',
  /async function updateTTSNativeStatus\(\) \{[\s\S]{0,300}await refreshApiBase\(\)/.test(appSrc), 'synced');
ok('app.js: loader model pakai URL absolut (origin embed)',
  /const modelUrl = \/\^https/.test(appSrc) && /loadModel\(modelUrl, settings\)/.test(appSrc));
ok('app.js: settings.url berbasis API (bukan location.href)',
  /settings\.url = new URL\([\s\S]*?,\s*API \+ "\/"\s*,?\s*\)/.test(appSrc));

// ── 5. the brain's derivation lives in transport (bun-tested) ──────────────
section('brain.ts via transport (perilaku di test/transport.test.ts)');
ok('brain.ts tidak lagi menanam derivasi origin sendiri',
  !/typeof location/.test(agentSrc), 'single source: transport');

// ── 6. src/client: dilarang fetch relatif mentah (origin embed salah arah) ──
section('src/client: semua panggilan API lewat seam transport');
// fetch("/api/..") benar di dev (same-origin) tapi TIDAK di exe — halaman
// embedded ber-origin tauri.localhost, bukan loopback; /api tak ada di sana.
// Kelas bug yang sama dengan literal :8310, hanya lebih senyap. Dilarang:
// fetch/EventSource/WebSocket dengan string literal relatif ("/...").
function walkTs(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, acc);
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) acc.push(p);
  }
  return acc;
}
{
  const tsFiles = walkTs(path.join(ROOT, 'src', 'client'), []);
  const rawCalls = [];
  for (const f of tsFiles) {
    // Seam transport adalah satu-satunya pengecualian — di situlah fetch
    // langsung memang duplikat seam (komentar dokumennya pun memuat contoh).
    if (/transport[\\/]/.test(path.relative(path.join(ROOT, 'src', 'client'), f))) continue;
    const src = fs.readFileSync(f, 'utf8');
    const rel = src.match(/(?:fetch|new EventSource|new WebSocket)\(\s*['"`]\/[^'"`]/g) || [];
    if (rel.length) rawCalls.push(path.relative(ROOT, f) + ' → ' + rel.join(' | '));
  }
  ok('tidak ada fetch/EventSource/WebSocket relatif mentah di src/client',
    rawCalls.length === 0, rawCalls.length ? rawCalls.join(' | ') : 'clean');
  const seamUsers = tsFiles.filter(
    (f) => /from\s*["'][./]*transport["']/.test(fs.readFileSync(f, 'utf8')),
  ).length;
  ok('seam transport dipakai modul TS (bukan pola acuh)', seamUsers > 0, seamUsers + ' file');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
