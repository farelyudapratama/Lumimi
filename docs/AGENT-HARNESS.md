# AGENT-HARNESS.md — Desain & matriks fitur (hasil riset 2026-10-11)

> Dokumen desain untuk harness agent di `core/src/agent/`. Bukan dokumen aturan
> mengikat seperti SHEET-SYSTEM/MODES — ini peta keputusan + matriks use case,
> supaya perubahan berikutnya punya acuan "kenapa begini". Kode yang benar tetap
> menang bila bertentangan.

## 1. Sumber riset (2026-10-11)

- [Anthropic — Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents):
  pola sederhana yang komposabel; **evaluator-optimizer** (loop verifikasi
  dgn umpan balik) adalah satu dari lima pola inti; investasi terbesar ada di
  desain tool.
- [Anthropic — Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents):
  kompaksi, note-taking terstruktur, sub-agent utk isolasi konteks.
- [SWE-agent (ACI paper, arXiv 2405.15793)](https://arxiv.org/abs/2405.15793):
  **desain antarmuka > kemampuan mentah** — tool yang dipagari (edit ditolak
  bila tidak compile, file-view berbatas) mengalahkan akses shell bebas.
- [OpenHands](https://www.openhands.dev): event-stream runtime; loop
  aksi→observasi dengan sandbox; verifikasi loop = inti skor SWE-bench.
- [Playwright MCP](https://github.com/microsoft/playwright-mcp): snapshot
  **accessibility tree ber-ref** (bukan HTML mentah/screenshot) + primitive tab
  eksplisit (list/select) — pola yang sama sudah dipakai browser agent kita.
- Context engineering (Splunk/Redis/Weaviate ringkasan): **offloading,
  isolation, retrieval, kompaksi, caching**; mitigasi "lost in the middle"
  (instruksi penting di awal/akhir, bukan tengah).

## 2. Peta keputusan (riset → implementasi)

| Temuan riset | Keputusan di Lumimi | Status |
|---|---|---|
| Evaluator-optimizer loop | Read-back verifikasi mutasi file; aturan 13 "bukti sebelum klaim selesai"; guard jawaban-final saat plan belum beres | ✅ terimplementasi (read-back, aturan 13, guard final, plan evidence) |
| ACI: edit berpagar | edit_file menolak old ganda/kosong (sudah ada); read-back menolak hasil yang tak cocok (baru) | ✅ terimplementasi |
| Kompaksi konteks | trim history (60 pesan + 120k char) | sudah ada |
| Retrieval selektif | memory_recall (fakta user) + `run_history` (tugas & hasil tool masa lalu dari store) | ✅ terimplementasi (memory_recall ada; run_history + store SQLite) |
| Offloading | hasil tool besar di-clip di history, teks penuh tak disimpan di konteks | sudah ada |
| Isolasi (sub-agent) | spawn_subagent read-only, maks 4, ringkasan saja | sudah ada |
| Snapshot AX ber-ref | browser_inspect + snapshotId/ref | sudah ada |
| Tab primitives eksplisit | `browser_tabs` (list/new/select/close) | ✅ terimplementasi (live-tested) |
| Bukti visual | `browser_screenshot` (simpan file, path dikembalikan) | ✅ terimplementasi (live-tested) |
| Observability | SQLite `data/agent-store.db`: runs/tool_execs/plan_steps + endpoint `/api/assistant/runs` | ✅ terimplementasi |
| Antrean LLM & retry | llm_sched (backoff + Retry-After + antrean + cancel) | sudah ada |

## 3. Matriks fitur × use case

| Use case | Fitur kunci yang dilibatkan |
|---|---|
| Tanya-jawab singkat | tanpa tool (aturan 1), streaming chat SSE |
| Riset web / berita | browser_open→navigate→inspect(+tabs)→click/type, captcha & login human-in-the-loop |
| Coding multi-file | update_plan + approval gate plan, write/edit (read-back), run_command (test), git_diff, verifikasi aturan 13 |
| Debugging | search_code, read_file, run_command, run_history (jejak percobaan sebelumnya) |
| Terminal/tugas sistem | run_command berpagar command_escape + approval per-perintah |
| Form tanpa kredensial | browser_type (+submit) |
| Situs berautentikasi | jeda login (user isi kredensial), profil persisten, google_blocked dijelaskan jujur |
| Motion asset | motion_analyze→validate→save (paksa), motion_verify (vision) |
| Memori lintas sesi | remember/recall + memory_recall (fakta user) + run_history (pekerjaan lampau) |

## 4. Temuan uji live (2026-10-11, sandbox + model gratis)

- **Akar nyata kegagalan provider non-premium #1 (dibuktikan live)**: router/
  proxy lokal menempel `data: [DONE]` SSE di akhir body JSON — parser ketat
  menolak SELURUH respons. Fix: fallback `jsonx::extract_json` di semua cabang
  provider (+ regresi test). Setelah fix, model via router lolos SEMUA skenario.
- Uji live 2 model (free/gpt-6-luna via apinex; mistral/codestral via router
  gratis): S1 jawaban langsung, S2 write_file + approval otomatis + read-back
  verifikasi + run/tool_exec tercatat di store, S3 tool run_history
  mengembalikan riwayat — SEMUA PASS. Skenario browser (screenshot + tabs
  new/list/select/close) live-tested di Chrome nyata — PASS.
- Provider gratis bisa throttled berat (retry scheduler bekerja sesuai desain);
  kecepatan provider ≠ kegagalan harness.

## 5. Batasan yang diakui jujur

- Model lemah ≠ setara premium: floor budget + umpan balik menaikkan peluang,
  bukan menjamin. Kegagalan format berulang dihentikan dengan pesan jujur.
- Google (dan situs serupa) memblokir sign-in dari browser otomatis — kebijakan
  mereka; kita TIDAK mengakali. Login = jalur human-in-the-loop.
- Frame webcam TIDAK pernah di-upload; audio mic cloud hanya dengan persetujuan
  sadar (aturan berlaku juga ke semua fitur baru).
- Panel membaca observability via HTTP `/api/assistant/runs` (mengikuti pola
  bridge assistant yang ada); migrasi IPC per-domain menyusul sesuai aturan
  ARSITEKTUR-TAURI-RUST.
