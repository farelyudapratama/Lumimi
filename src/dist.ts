/**
 * dist.ts — Rakit folder release PORTABLE Lumimi.
 *
 * Hasil: dist/Lumimi/ yang bisa di-zip dan dibagikan — user cukup
 * dobel-klik SATU exe. Isi folder:
 *
 *   Lumimi.exe    SATU-SATUNYA exe: shell Tauri (WebView2) yang
 *                       meng-host server Rust (axum, loopback) IN-PROCESS.
 *                       Dobel-klik = server + jendela nyala satu proses.
 *                       TTS/STT native in-process (lib live2d-engine);
 *                       STT butuh build --features engine-stt.
 *   static/             frontend (index.html, app.js, bundle.js, dll.)
 *   data/               DIBUAT saat first-run — sengaja tidak disertakan
 *                       agar konfigurasi/API key user tidak ikut paket
 *
 * Bun + cargo HANYA dipakai sebagai driver build di mesin dev — tidak
 * ikut ke folder release dan tidak dijalankan saat runtime.
 *
 * Bila Inno Setup 6 (ISCC) terpasang, langkah terakhir juga membungkus folder
 * ini menjadi SATU file: dist/Lumimi-Setup.exe — installer per-user
 * tanpa admin (lihat installer.iss).
 *
 * Pemakaian:
 *   bun run src/dist.ts                 # target = OS host (Windows ini)
 *
 * Catatan lintas-OS: live2d-core (Rust) & shell Tauri per-OS dibangun di OS-nya
 * masing-masing (biasanya lewat CI runner).
 */
import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const REPO = join(import.meta.dir, ".."); // src/ → repo root
const OUT_DIR_NAME = "Lumimi";
const OUT = join(REPO, "dist", OUT_DIR_NAME);
// SATU exe SATU proses: shell Tauri yang meng-host server Rust in-process.
// Dobel-klik Lumimi.exe = semuanya nyala (tak ada exe server kedua).
const SHELL_EXE = join(REPO, "target", "release", "Lumimi.exe");

const BUN = process.execPath; // bun.exe saat dev — HANYA driver build (bundle frontend)

function fail(msg: string): never {
  console.error(`  [!] ${msg}`);
  process.exit(1);
}

console.log(`╔══════════════════════════════════════════════╗`);
console.log(`║  Lumimi — rakit release portable       ║`);
console.log(`╚══════════════════════════════════════════════╝`);
console.log(`  Target : host (${process.platform})`);
console.log(`  Output : dist/${OUT_DIR_NAME}/`);
console.log("");

// 1) Client bundle (bundle.js wajib ada — server menampilkan halaman mati tanpanya).
//    Bun di sini = alat bundling build-time saja, tidak ikut ke release.
console.log("  [1/4] Bundle client → static/js/bundle.js");
const build = spawnSync(BUN, ["run", join(REPO, "src", "build.ts")], {
  cwd: REPO,
  stdio: "inherit",
});
if (build.status !== 0) fail("build client gagal");

// 2) Build SATU exe → Lumimi.exe (shell + server Rust in-process).
console.log("  [2/4] Build Lumimi.exe (cargo --release)");
const cargo = spawnSync("cargo", ["build", "--release", "-p", "lumimi"], { cwd: REPO, stdio: "inherit" });
if (cargo.status !== 0) fail("build Lumimi gagal (pasang Rust toolchain / cek error di atas)");
if (!existsSync(SHELL_EXE)) fail(`Lumimi.exe tidak ditemukan di ${SHELL_EXE}`);

// 3) Frontend statik (folder dibersihkan lalu diisi ulang) + satu exe.
console.log("  [3/4] Salin static/ + Lumimi.exe");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(REPO, "static"), join(OUT, "static"), { recursive: true });
{
  const dst = join(OUT, "Lumimi.exe");
  cpSync(SHELL_EXE, dst);
  const mb = (statSync(dst).size / 1024 / 1024).toFixed(1);
  console.log(`        [OK] Lumimi.exe (${mb} MB) — shell + server satu proses`);
}

// Mesin inferensi native (TTS SuperTonic + STT Whisper) adalah LIB yang
// di-link in-process — tidak ada exe sidecar. Model TIDAK dibundel dan TIDAK
// diunduh otomatis (on-demand belum diport ke core): taruh manual di
// ~/.cache/supertonic3 atau <root>/engines/models/supertonic3 (TTS), dan
// <root>/engines/models/ggml-<model>.bin (STT; butuh build --features engine-stt).

writeFileSync(
  join(OUT, "BACA-SAYA.txt"),
  [
    "Lumimi — versi portable",
    "=============================",
    "",
    "Cara pakai:",
    "  1. Dobel-klik Lumimi.exe — server + jendela app nyala dalam satu proses.",
    "  2. Impor model Live2D (folder .model3.json atau .zip) lewat tombol impor di app.",
    "  3. Isi API key LLM (pengaturan koneksi) & TTS lewat UI — tersimpan di data/config.json.",
    "",
    "Catatan:",
    "  - Taruh folder ini di lokasi yang boleh ditulis (mis. Desktop/D:/),",
    "    BUKAN di bawah C:\\Program Files — data/config.json ditulis di samping exe.",
    "  - Windows: WebView2 sudah bawaan Windows 10/11.",
    "  - Semua data user hidup di folder data/ — pindahkan folder ini = pindah semua.",
    "",
  ].join("\r\n"),
  "utf8",
);

// Ringkasan ukuran
function dirSize(p: string): number {
  let total = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const full = join(p, e.name);
    total += e.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}
const mb = (n: number) => (n / 1024 / 1024).toFixed(1) + " MB";

// 4) Installer Windows (Inno Setup) — folder di atas dibungkus jadi SATU file:
//    dist/Lumimi-Setup.exe — install per-user ke %LOCALAPPDATA%\Programs
//    (tanpa admin) sehingga kontrak "data/ di samping exe" tetap berlaku.
//    ISCC dicari di lokasi bawaan winget & installer resmi; env ISCC bisa
//    memaksa path lain. Tanpa ISCC, zip folder seperti biasa.
console.log("  [4/4] Installer Windows (Inno Setup)");
const SETUP_EXE = join(REPO, "dist", "Lumimi-Setup.exe");
if (process.platform !== "win32") {
  console.log("        [i] Bukan Windows — installer hanya dibangun di Windows.");
} else {
  const iscc = [
    process.env.ISCC,
    join(process.env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe"),
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  ].find((p) => p && existsSync(p));
  if (!iscc) {
    console.log("        [i] ISCC (Inno Setup 6) tidak ditemukan — zip folder release seperti biasa,");
    console.log("            atau pasang dulu: winget install JRSoftware.InnoSetup");
  } else {
    const version = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
    const iss = spawnSync(iscc, [`/DAPP_VERSION=${version}`, "installer.iss"], { cwd: REPO, stdio: "inherit" });
    if (iss.status !== 0) fail("build installer gagal");
    console.log(`        [OK] Lumimi-Setup.exe (${mb(statSync(SETUP_EXE).size)}) — satu file siap dibagikan`);
  }
}

console.log("");
console.log(`  [OK] Release siap: dist/${OUT_DIR_NAME}/  (${mb(dirSize(OUT))})`);
console.log("       Zip foldernya untuk dibagikan — atau bagikan Lumimi-Setup.exe.");
