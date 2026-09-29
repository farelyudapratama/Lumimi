# Arsitektur, Alur, dan Behavioral Modes — Kontrak Perilaku

> **Status (2026-09-29): KONTRAK PERILAKU BEKU — bukan target, bukan tutorial.**
> Rework Fase 2–6 selesai 2026-09-19; integrasi ulang View → Engine sudah
> jalan. Dokumen yang dulu 48 seksi (±1.746 baris) dipadatkan ke kontrak yang
> masih dirujuk kode: §§1–18 (mental model + policy) dan §§32–34 (§36
> checklist pindah mode, dengan koreksi: pengecualian teardown penuh =
> `MODES.md`). Yang dibuang: tutorial contoh debug, fase integrasi yang sudah
> lewat, golden rules/meta sesi lama, dan seksi yang otoritasnya sudah pindah
> (engine motion/parameter → `MOTION-SYSTEM-SPEC.md` + `MODEL-AGNOSTIC-RULES.md`).
>
> **Aturan baca:** dokumen ini mengikat HANYA untuk kontrak perilaku di bawah.
> Untuk motion baca `MOTION-SYSTEM-SPEC.md`, untuk makna parameter baca
> `MODEL-AGNOSTIC-RULES.md`, untuk mode baca `MODES.md`. Kalau bertentangan,
> tiga dokumen itu yang menang.

---

## 1. Prinsip Utama

Project terdiri dari empat lapisan besar:

```text
VIEW / UI
    ↓
BEHAVIOR / AGENT
    ↓
ENGINE
    ↓
LIVE2D RUNTIME / RENDERER
```

Tanggung jawab:

- **View:** menerima input, menampilkan state, memilih konteks/surface.
- **Behavior:** menentukan apa yang seharusnya dilakukan.
- **Engine:** menerjemahkan keputusan menjadi aksi karakter.
- **Live2D Runtime:** mengeksekusi model dan rendering.

Aturan:

1. View tidak mengatur parameter Cubism secara langsung.
2. LLM/Behavior tidak menulis parameter Cubism secara langsung.
3. Renderer tidak mengambil keputusan AI.
4. Mode tidak membutuhkan renderer yang berbeda.
5. Execution state dan speech state tidak boleh otomatis dianggap sama.
6. Sebelum implementasi, audit actual repo terlebih dahulu.

---

# 2. Mental Model Produk

Ada tiga pengalaman utama:

```text
                         APPLICATION
                              │
             ┌────────────────┼────────────────┐
             │                │                │
             ▼                ▼                ▼
         CHAT VIEW        VTUBER VIEW     ASSISTANT VIEW
             │                │                │
             ▼                ▼                ▼
        COMPANION          VTUBER            WORKER
        / PET-LIKE         BEHAVIOR          BEHAVIOR
```

## Chat View

Chat View adalah pengalaman **Companion / PET-like**.

Karakter:

- diajak ngobrol;
- punya personality;
- merespons user;
- dapat berbicara;
- dapat melakukan motion/expression;
- dapat memiliki proactive behavior.

## VTuber View

Karakter diposisikan sebagai streamer/performer.

Event utama:

- Audience
- Donation
- Operator

## Assistant / Harness View

Orientasinya adalah pekerjaan/task.

Agent dapat:

- menjalankan task;
- memakai tools;
- meminta approval;
- melakukan cancel;
- melakukan queue/park;
- memodifikasi task.

---

# 3. Behavioral Identity vs View

Jangan menyamakan View dengan behavioral identity.

Pemetaan konseptual:

```text
Chat View
    ↓
COMPANION

VTuber View
    ↓
VTUBER

Assistant View
    ↓
WORKER
```

Jika Harness memiliki dua surface:

```text
HARNESS
├── Chat Dock
│     └── COMPANION
│
└── Worker input
      └── WORKER
```

Kesimpulan:

> **Chat View = Companion/PET-like behavioral surface.**

Tidak perlu membuat Chat Engine dan PET Engine terpisah hanya karena nama View berbeda.

---

# 4. Tiga Behavioral Context

## 4.1 COMPANION

Tujuan: interaksi natural antara user dan karakter.

```text
User
 ↓
Conversation
 ↓
Companion
 ↓
LLM
 ↓
Decision
 ↓
Motion / Expression / Speech
```

## 4.2 VTUBER

Tujuan: karakter sebagai streamer.

```text
Audience / Donation / Operator
              ↓
       Event Policy
              ↓
        VTuber Behavior
              ↓
             LLM
              ↓
       Response / Action
```

## 4.3 WORKER

Tujuan: menyelesaikan pekerjaan.

```text
Task
 ↓
Worker Agent
 ↓
LLM
 ↓
Tools
 ↓
Approval / More tools
 ↓
Result
```

Live2D hanya merepresentasikan state/action agent; task state tetap berada di Worker.

---

# 5. End-to-End Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                         VIEW / UI                            │
│ Chat · VTuber · Assistant/Harness                            │
└─────────────────────────────┬────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                     BEHAVIOR / AGENT                         │
│ Companion · VTuber Behavior · Worker Behavior                │
└─────────────────────────────┬────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                         ENGINE                               │
│ Motion · Expression · Parameters · Speech · Model State      │
└─────────────────────────────┬────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                    LIVE2D RUNTIME                            │
│ Adapter · Cubism Framework/Core · PixiJS/WebGL               │
└──────────────────────────────────────────────────────────────┘
```

---

# 6. Chat Flow

```text
Chat View
   │
   ▼
User message
   │
   ▼
Companion Behavior
   │
   ▼
LLM
   │
   ▼
Decision / Response
   │
   ├── Text
   ├── Emotion
   ├── Motion
   ├── Expression
   └── Speech
          │
          ▼
        Engine
          │
          ├── Motion
          ├── Expression
          ├── Parameters
          └── Speech
          │
          ▼
      Live2D Runtime
```

## Companion concurrency

### THINKING + new input

Target behavior:

**MERGE**

```text
Request A
   ↓
THINKING
   ↓
User sends B
   ↓
A + B
   ↓
single continued thinking flow
```

### SPEAKING + new input

Target behavior:

**PREEMPT**

```text
A sedang berbicara
       ↓
User mengirim B
       ↓
speech/chain A dipreempt
       ↓
process B
```

Speech yang dipotong tidak otomatis dianggap completed.

---

# 7. VTuber Flow

```text
VTUBER VIEW
    │
    ├──────────────┬───────────────┐
    ▼              ▼               ▼
 Audience       Donation        Operator
    │              │               │
    ▼              ▼               ▼
 Suppression      FIFO             FIFO
    │              │               │
    └──────────────┼───────────────┘
                   ▼
            VTuber Behavior
                   │
                   ▼
                  LLM
                   │
                   ▼
          Speech / Motion / Expression
```

## Audience

Audience bersifat noisy/high-volume.

Target behavior:

```text
event
 ↓
duplicate?
 ├─ yes → DROP
 └─ no
     ↓
cooldown?
 ├─ yes → DROP
 └─ no
     ↓
accept
```

## Donation

Donation memakai queue:

```text
Donation
   ↓
FIFO Queue
   ↓
Active item
   ↓
LLM
   ↓
Speech
   ↓
Done
   ↓
Next item
```

Target queue yang pernah ditetapkan:

- FIFO;
- maksimum 20;
- item baru ketika penuh ditolak;
- tidak silent-evict item lama.

## Operator

Operator adalah event class tersendiri:

```text
Operator
   ↓
Operator Queue
   ↓
VTuber Behavior
   ↓
Response
```

Donation dan Operator berbagi active scheduling slot.

Jika sebuah item sedang aktif, item tersebut tidak dipreempt oleh class lain.

Jika donation dan operator sama-sama menunggu, scheduling precedence yang pernah dikunci adalah Donation sebelum Operator.

---

# 8. Worker / Assistant Flow

```text
Assistant View
      ↓
Worker Input
      ↓
Worker Agent
      ↓
┌─────┼───────────────────┐
│     │                   │
LLM  Tool              Approval
│     │                   │
└─────┼───────────────────┘
      ↓
More work / Result
```

Worker berbeda dari Companion karena fokusnya adalah **task completion**, bukan percakapan natural.

---

# 9. Worker Task Identity

Worker tidak idealnya hanya mempunyai:

```text
busy = true
```

Tetapi:

```text
activeTask
parkedTasks[]
taskId
```

Contoh:

```text
ACTIVE
┌──────────────┐
│ t_1 RUNNING  │
└──────────────┘

PARKED
┌──────────────┐
│ t_2          │
├──────────────┤
│ t_3          │
├──────────────┤
│ t_4          │
└──────────────┘
```

Target queue:

- FIFO;
- maksimum 20;
- task baru tidak mematikan active task;
- overflow ditolak dengan feedback eksplisit.

---

# 10. Worker Pause / Approval

Approval pause tetap mempertahankan ownership task:

```text
RUNNING
   ↓
WAITING APPROVAL
   ↓
PAUSED
```

Saat paused:

```text
ACTIVE SLOT = task tersebut
```

Task baru tetap park/queue.

---

# 11. Worker Cancel

Gunakan task identity:

```text
cancel(taskId)
```

Target dapat berupa:

- active task;
- paused task;
- parked task.

Cancel bersifat cooperative.

Penting:

> Cancel tidak berarti side effect yang sudah terjadi otomatis di-undo.

---

# 12. Worker Modify

Modify active task bukan sekadar task independen baru.

Target ordering:

```text
A → A' → B → C
```

Jika A running:

```text
A RUNNING
   ↓
cancel requested
   ↓
A terminal
   ↓
A' active
```

Jika A paused:

```text
A PAUSED
   ↓
A terminal
   ↓
A' active
```

Replacement mewarisi posisi A.

---

# 13. Harness: Dua Lane

Harness bukan dua engine.

```text
                         HARNESS
                            │
                ┌───────────┴───────────┐
                │                       │
                ▼                       ▼
        Companion Lane             Worker Lane
                │                       │
            AgentBrain              Agent Loop
                │                       │
            /api/chat             /api/assistant/*
```

Input surface menentukan lane:

```text
Chat Dock
   → Companion

Worker/#as-input
   → Worker
```

Jika boundary surface sudah cukup jelas, tidak perlu menambah IntentRouter hanya untuk membedakan dua lane.

---

# 14. Execution State Isolation

Companion dan Worker harus mempunyai state yang berbeda.

```text
COMPANION
├── conversation history
├── busy/request state
├── request generation
├── conversational chain
└── companion context

WORKER
├── task context
├── activeTask
├── parkedTasks
├── approvals
├── cancellation
└── task identity
```

Worker tidak boleh:

- mengubah Companion history;
- membatalkan Companion request;
- mengubah Companion thinking state.

Companion tidak boleh:

- membatalkan Worker task;
- mengubah Worker queue;
- mengambil alih Worker task state.

Boleh berbagi karakter/engine; tidak boleh mencampur execution state.

---

# 15. Speech Ownership

Speech adalah resource yang berbeda dari execution.

```text
Execution
    ↓
menghasilkan speech intent

Speech
    ↓
menghasilkan audio
```

Jangan otomatis menyamakan:

```text
speech done == task done
```

kecuali flow tertentu memang sengaja mengikat keduanya.

Potential producers:

```text
Companion
VTuber Audience
VTuber Donation
VTuber Operator
Worker Actor
Direct/App fallback
```

Target boundary:

```text
Speech Producer
      ↓
Speech Policy / Ownership
      ↓
TTS / Audio
```

Policy dapat menghasilkan:

```text
ALLOW
SUPPRESS
PREEMPT
QUEUE
CANCEL
```

---

# 16. Speech Conflict Rules

Behavioral contract yang pernah dikunci:

### Companion explicit user input vs Worker speech

Companion user input dapat memenangkan audio.

```text
Companion user
      >
Worker decorative speech
```

### Worker speech vs live Companion chain

Worker tidak boleh memotong Companion yang sedang berbicara.

```text
Companion speaking
       +
Worker speech
       ↓
Worker SUPPRESS
```

### Worker vs Worker

Worker speech harus serialized.

Tidak boleh hanya mengandalkan last-claim-wins.

---

# 17. Proactive Behavior

Proactive event berbeda dari explicit user input.

Contoh:

```text
idle
user away
user returned
mood event
```

Target:

```text
reactEvent()
    ↓
proactiveAllowed?
    │
 ┌──┴──┐
 NO   YES
 │      │
DROP   process
```

Gate harus terjadi sebelum:

- LLM request;
- director processing;
- side effect;
- speech.

---

# 18. Proactive Context Policy

Secara behavioral target:

### Companion aktif

Proactive behavior boleh berjalan sesuai quiet/idle rules.

### VTuber aktif

Companion-style idle/away/return/mood proactive sebaiknya ditekan karena VTuber memiliki event model sendiri.

### Worker RUNNING / PAUSED

Companion proactive sebaiknya ditekan agar tidak mengganggu task.

### Brain OFF

Companion proactive tidak berjalan.

> Ini adalah target policy dari arsitektur sebelumnya. Repo hasil revert harus diverifikasi ulang sebelum mengklaim sudah memiliki behavior tersebut.

---

# 19. Engine Layer — DICABUT (2026-09-29)

Tutorial boundary behavior → aksi; otoritasnya kini di `MOTION-SYSTEM-SPEC.md`
+ `MODEL-AGNOSTIC-RULES.md`. Riwayat lengkap ada di git.

---

# 20. Semantic Motion — DICABUT (2026-09-29)

Duplikat `MOTION-SYSTEM-SPEC.md` §2 (Motion Asset). Riwayat lengkap ada di git.

---

# 21. Expression — DICABUT (2026-09-29)

Duplikat `MOTION-SYSTEM-SPEC.md` (registry emosi) + `MODEL-AGNOSTIC-RULES.md`
(jangan mengarang arti id opaque). Riwayat lengkap ada di git.

---

# 22. Parameter API — DICABUT (2026-09-29)

Duplikat `MODEL-AGNOSTIC-RULES.md` (role space). Riwayat lengkap ada di git.

---

# 23. Parameter Arbitration — DICABUT (2026-09-29)

Inti ownership multi-writer kini hidup di `MOTION-SYSTEM-SPEC.md` §12 +
runtime. Riwayat lengkap ada di git.

---

# 24. Mouse Follow — DICABUT (2026-09-29)

Tutorial pipeline gain/normalize/clamp. Riwayat lengkap ada di git.

---

# 25. Idle Motion vs Mouse Follow — DICABUT (2026-09-29)

Tutorial definisi; bukan kontrak. Riwayat lengkap ada di git.

---

# 26. Framework Effects — DICABUT (2026-09-29)

Prinsip "jangan duplikat efek framework" kini bagian arsitektur satu jalur
render (`AGENTS.md`). Riwayat lengkap ada di git.

---

# 27. Eye Blink Ownership — DICABUT (2026-09-29)

Satu-writer blink kini digate di runtime. Riwayat lengkap ada di git.

---

# 28. Breath dan Update Order — DICABUT (2026-09-29)

Tutorial urutan update; yang berlaku = implementasi aktual terverifikasi.
Riwayat lengkap ada di git.

---

# 29. Live2D Runtime — DICABUT (2026-09-29)

Daftar tanggung jawab runtime era pra-migrasi; arsitektur kini di `AGENTS.md`
+ `ARCHITECTURE-TAURI-RUST.md`. Riwayat lengkap ada di git.

---

# 30. Renderer Responsibility — DICABUT (2026-09-29)

Prinsip umum GPU vs AI; bukan kontrak perilaku. Riwayat lengkap ada di git.

---

# 31. Model Capability — DICABUT (2026-09-29)

Duplikat `MODEL-AGNOSTIC-RULES.md` (ukur dari disk). Riwayat lengkap ada di
git.

---

# 32. Request Lifecycle

Companion request ideal:

```text
INPUT
  ↓
CLAIM
  ↓
LOAD CONTEXT
  ↓
LLM
  ↓
DIRECTOR
  ↓
ENGINE
  ↓
SPEECH / MOTION
  ↓
DONE
```

Request perlu:

- cancellation;
- timeout;
- generation/stale protection;
- cleanup.

---

# 33. Stale Request Protection

Contoh:

```text
Request A
   ↓
await network
   ↓
Request B menjadi current
   ↓
A kembali terlambat
```

A tidak boleh menulis state milik B.

```text
generation A != current generation
        ↓
discard A
```

---

# 34. Model Loading Race

Hal yang sama berlaku untuk model loading:

```text
Load A
  ↓
await

Load B
  ↓
B menjadi current

A kembali terlambat
  ↓
A tidak boleh menggantikan B
```

Setiap continuation setelah await harus memeriksa generation/identity.

Stale resource milik A boleh perlu dibersihkan, tetapi jangan mengubah state model B.

---

# 35. Context Switching — DICABUT (2026-09-29)

Bagian ini bertentangan dengan `MODES.md` (teardown penuh saat pindah mode)
dan konflik itu sudah diputuskan: **yang menang = `MODES.md`**. Jangan
menghidupkan kembali isi lama bagian ini dari history git.

---

# 36. Mode Transition Checklist

Setiap perpindahan context harus menjawab:

1. Apa yang tetap hidup?
2. Apa yang dihentikan?
3. Apa yang disuppress?
4. Apa yang di-reset?
5. Apakah speech aktif dihentikan?
6. Apakah Worker task tetap berjalan?
7. Apakah Companion history dipertahankan?
8. Apakah VTuber queue tetap berjalan?

Jangan menyelesaikan semua pertanyaan dengan satu `resetEverything()`.

---

# 37. Data Flow — DICABUT (2026-09-29)

Tutorial aliran View → Behavior → Engine → Runtime; tidak ada kontrak yang
tidak sudah tercakup §§1–18. Riwayat lengkap ada di git.

---

# 38. Debugging Principle — DICABUT (2026-09-29)

Tutorial "cari titik pertama expected vs actual"; bukan kontrak perilaku.
Riwayat lengkap ada di git.

---

# 39. Contoh Debug Mouse Follow — DICABUT (2026-09-29)

Contoh tutorial; bukan kontrak. Riwayat lengkap ada di git.

---

# 40. Contoh Debug Companion Speech — DICABUT (2026-09-29)

Contoh tutorial; bukan kontrak. Riwayat lengkap ada di git.

---

# 41. Contoh Debug Worker — DICABUT (2026-09-29)

Contoh tutorial; bukan kontrak. Riwayat lengkap ada di git.

---

# 42. Anti-Patterns

## View langsung menulis parameter

```text
button
 ↓
model.AngleX = 30
```

Hindari.

## LLM langsung menulis Cubism

```text
LLM
 ↓
ParamAngleX = ...
```

Hindari.

## Setiap mode mempunyai renderer sendiri

Hindari kecuali ada kebutuhan teknis yang terbukti.

## Global state untuk Companion dan Worker

Jangan mencampur:

```text
history
busy
cancel
task
```

dalam satu state global.

## IntentRouter tanpa kebutuhan

Jika surface sudah menentukan:

```text
Chat → Companion
Assistant → Worker
VTuber → VTuber
```

tidak perlu menambah router hanya untuk memecahkan masalah yang sudah terselesaikan oleh boundary.

## Banyak writer parameter tanpa ownership

Ini berpotensi menghasilkan motion regression.

## Proactive event langsung memanggil LLM

Harus melewati policy gate terlebih dahulu.

## Reset seluruh aplikasi ketika pindah View

Context switch tidak otomatis berarti full destruction.

---

# 43. Single Engine Principle

Target:

```text
Companion ─┐
VTuber ────┼──→ ONE ENGINE ─→ LIVE2D RUNTIME
Worker ────┘
```

Bukan:

```text
Companion → Engine A
VTuber    → Engine B
Worker    → Engine C
```

Satu engine memungkinkan:

- model yang sama;
- parameter system yang sama;
- motion system yang sama;
- expression system yang sama;
- renderer yang sama.

Perbedaan berada pada behavior/policy.

---

# 44. Shared vs Isolated

## Shared

Boleh shared:

- Live2D model;
- model loader;
- Cubism runtime;
- renderer;
- Parameter API;
- motion API;
- expression API;
- engine;
- capability metadata;
- speech adapter.

## Isolated

Sebaiknya terisolasi:

- Companion history/state;
- Worker task state;
- VTuber queues;
- request generation;
- cancellation;
- approval;
- proactive state;
- mode-specific event queues.

---

# 45. Urutan Integrasi Ulang — SELESAI, DIARSIPKAN (2026-09-29)

Phase A–F selesai 2026-09-19. Detail fase dihapus; riwayat lengkap ada di git.
Jangan memulai "fase integrasi" baru dari bagian ini.

---

# 46. Golden Rules untuk Coding Agent — DICABUT (2026-09-29)

Aturan sesi rework yang sudah lewat; yang masih berlaku kini tinggal di
`AGENTS.md` ("Aturan kerja"). Riwayat lengkap ada di git.

---

# 47. Final Mental Model — DICABUT (2026-09-29)

Duplikat §§2–4 dalam bentuk diagram; bukan kontrak tambahan. Kalimat intinya
tetap dikutip di §4. Riwayat lengkap ada di git.

---

# 48. Status dan Batas Dokumen — DICABUT (2026-09-29)

Prosedur kerja sesi rework ("audit actual repo → … → runtime verify") sudah
digantikan definisi "selesai" di `AGENTS.md`. Riwayat lengkap ada di git.

