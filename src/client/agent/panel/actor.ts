/**
 * client/agent/panel/actor.ts — Direktur akting karakter (port dari
 * mode-runtime.js saat remake panel agent).
 *
 * "Otak akting" sisi klien: memetakan event aktivitas agent ke gaze,
 * ekspresi, dan komentar. Semua reaksi diberi cooldown agar karakter tidak
 * "kebablasan". Komentar: LLM persona DULU via /api/assistant/quip
 * (role "chat") dengan label event asli — template i18n (as.actor.*) hanya
 * jaring pengaman bila quip gagal/tak datang dalam batas waktu. Dalam masa
 * cooldown quip karakter DIAM, bukan mengucap kalimat kaleng.
 *
 * Mapping (per-event, bukan generik):
 *   - task_classified → ACK PEMBUKA per jenis tugas (as.ack.*) — satu-satunya
 *     suara pertama yang boleh keluar; SEBELUM event ini companion DIAM
 *     (aturan alur respons #1: tidak bicara sebelum jenis tugas diketahui).
 *   - thinking_start → pose mikir TANPA komentar (ack sudah bicara); filler
 *     kabar status hanya bila mikir > 18 dtk.
 *   - verification_result gagal → error + komentar; lolos → "done" ringan
 *     TANPA komentar (jangan mengganggu saat kerjaan lancar).
 *   - subagent_completed → "done" tanpa komentar; spawned → "tool" + komentar.
 *   - tool_call_start/end → "tool"; komentar hanya di start.
 *   - plan_revised → gaze "think" + komentar.
 *   - permission_resolved disetujui → "done" (lega); ditolak → TANPA reaksi
 *     (jangan terasa "menghukum" user yang menolak).
 * Semua dependensi di-inject (L, t, post, now, fallbackMs) supaya bisa
 * di-stub di test.
 */

export type ActorEvent = { type: string; label?: string };

export type ActorDeps = {
  /** Karakter Live2D (window.__live2dAgent) — boleh absen. */
  L?: any;
  /** Terjemah string runtime. */
  t?: (key: string, vars?: Record<string, string | number>) => string;
  /** POST JSON ke server (dipakai /api/assistant/quip). */
  post?: (path: string, body: any) => Promise<any>;
  /** Suara sebagai karakter (bubble + TTS) — kelas default worker_actor
   *  (dekoratif, tier 0 policy speech §15–16). */
  speakAsCharacter?: (text: string, cls?: string) => void;
  /** Jam untuk cooldown — di-inject agar test deterministik. */
  now?: () => number;
  fallbacks?: { think?: string; tool?: string; done?: string; error?: string; revised?: string; stillWorking?: string };
  /** Batas tunggu quip sebelum template fallback diucapkan — di-inject agar
   *  test tidak menunggu ribuan ms. Default QUIP_FALLBACK_MS. */
  fallbackMs?: number;
  /** Masa grasi sebelum quip diminta — di-inject terpisah dari fallbackMs
   *  agar test bisa membuktikan asal template (catch vs timer). Default =
   *  fallbackMs. */
  graceMs?: number;
};

const QUIP_COOLDOWN = 15000;   // komentar LLM maks ~1 per 15 dtk
const MOTION_COOLDOWN = 2500;  // gerakan reaksi maks 1 per 2,5 dtk
/** Dua peran (nilai sama, di-inject sebagai fallbackMs di test): (1) masa
 *  grasi sebelum quip progres diminta — tugas yang tuntas lebih cepat tidak
 *  perlu dinarasi; (2) batas tunggu quip sebelum template fallback diucapkan.
 *  Cukup pendek supaya jeda tidak terasa mati, cukup panjang untuk LLM role
 *  "chat" yang lazimnya jawab 1-3 dtk. */
const QUIP_FALLBACK_MS = 4500;

export function makeActor(deps: ActorDeps = {}) {
  const L = deps.L;
  const t = deps.t || ((k: string) => k);
  const post = deps.post || (() => Promise.resolve({}));
  const speak = deps.speakAsCharacter || (() => {});
  const now = deps.now || (() => Date.now());
  const fb = deps.fallbacks || {};
  const fbMs = deps.fallbackMs ?? QUIP_FALLBACK_MS;
  const graceMs = deps.graceMs ?? fbMs;

  let lastQuip = 0;
  let lastMotion = 0;
  let fillerTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let actorPersona = "";
  /** Aturan alur respons #1: companion DIAM sampai jenis tugas diketahui
   *  (event task_classified dari server). False mengebungkam semua comment()
   *  progres; hanya ack() yang boleh bicara pertama kali. */
  let taskKnown = false;
  /** Teks input user tugas berjalan (dari workbench.send) — konteks bagi
   *  ack agar konfirmasinya spesifik ("aku carikan config.json ya"). */
  let taskInput = "";
  /** Naik setiap kali jalur quip dibatalkan (selesai/speak/stop/comment baru)
   *  — respons POST yang telat diabaikan lewat cek epoch, bukan cuma cek
   *  timer, supaya quip progres tidak menyusul jawaban final. */
  let quipEpoch = 0;

  /** Rotasi varian template fallback per kunci dasar: pemakaian ke-0 kunci
   *  dasar, lalu .v2/.v3 bergantian. Mencegah kalimat identik diulang saat
   *  quip LLM lama tak tersedia — pengulangan itulah yang bikin karakter
   *  terasa mati. t() mengembalikan nama kunci bila varian absen, jadi
   *  pasangan .v2/.v3 wajib ada di kedua kamus (dijaga test parity i18n). */
  const variantUse = new Map<string, number>();
  function pickVariant(key: string): string {
    const n = variantUse.get(key) || 0;
    variantUse.set(key, n + 1);
    return n % 3 === 1 ? `${key}.v2` : n % 3 === 2 ? `${key}.v3` : key;
  }

  const clearFiller = () => {
    if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
  };
  const clearFallback = () => {
    quipEpoch++;
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
  };

  /** Gerakan/ekspresi reaksi — rate-limited supaya tidak saling menimpa. */
  function react(kind: "tool" | "done" | "error" | "approval" | "think"): void {
    if (!L || now() - lastMotion < MOTION_COOLDOWN) return;
    lastMotion = now();
    try {
      if (kind === "tool") {
        L.setGazeIntent?.("glance", { hold: 1600 });
        L.expressEmotion?.("bingung");
      } else if (kind === "done") {
        L.setGazeIntent?.("up", { hold: 1200 });
        L.expressEmotion?.("senang");
      } else if (kind === "error") {
        L.setGazeIntent?.("lookaway-down", { hold: 2000 });
        L.expressEmotion?.("kesal");
      } else if (kind === "approval") {
        L.setGazeIntent?.("face-user", { hold: 2500 });
        L.expressEmotion?.("kaget");
      } else if (kind === "think") {
        L.setGazeIntent?.("think", { hold: 6000 });
      }
    } catch { /* engine belum siap — akting boleh gagal senyap */ }
  }

  /**
   * Komentar berkarakter: LLM DULU, template cuma jaring pengaman.
   *
   * Dulu template diucapkan langsung lalu quip LLM menyusul — user selalu
   * mendengar kalimat kaleng ("Hmm, dia lagi periksa berkas…") sebelum versi
   * persona, dan mayoritas event bahkan tak pernah minta quip (allowLLM:
   * false) sehingga karakter cuma hafalan template. Sekarang:
   *   1. Dalam masa cooldown quip → DIAM (bukan template). Cooldown artinya
   *      "baru bicara", bukan izin mengucap kalimat kaleng.
   *   2. Di luar cooldown → tunggu MASA GRASI fbMs dulu. Tugas yang tuntas
   *      cepat (tanya singkat → langsung dijawab) membatalkan timer lewat
   *      clearFallback pada event selesai → tidak ada narasi progres untuk
   *      pekerjaan yang sudah beres. Hanya kalau pekerjaan MASIH berjalan,
   *      quip diminta dengan label event asli — label inilah yang bikin
   *      komentar spesifik ("aku lagi baca package.json", bukan generik).
   *   3. Quip gagal/tak datang dalam fbMs lagi → template fallback diucapkan
   *      (berotasi varian). Quip datang → template dibatalkan. Respons quip
   *      yang telat diabaikan lewat epoch — quip progres tidak boleh
   *      menyusul jawaban final.
   */
  function comment(fallbackKey: string, eventLabel: string, allowLLM: boolean): void {
    // Aturan #1: sebelum jenis tugas diketahui, tidak ada respons apa pun.
    if (!taskKnown) return;
    if (!allowLLM || now() - lastQuip < QUIP_COOLDOWN) return;
    lastQuip = now();
    const key = fallbackKey;
    clearFallback();
    const epoch = quipEpoch;
    graceTimer = setTimeout(() => {
      graceTimer = null;
      // Template jaring pengaman kalau quip tak kunjung datang.
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        speak(t(pickVariant(key)));
      }, fbMs);
      post("/api/assistant/quip", { persona: actorPersona, event: eventLabel })
        .then((d) => {
          // Timer hidup = template belum bicara (jangan dobel); epoch sama =
          // jalur belum dibatalkan selesai/speak (jangan nyelip setelah
          // jawaban final).
          if (d?.quip && fallbackTimer && epoch === quipEpoch) {
            clearFallback();
            speak(d.quip);
          }
        })
        .catch(() => {
          // Quip gagal → template segera (bila timer belum menggugatkan) —
          // kalau sudah gugat, biarkan template yang bicara, jangan dobel.
          if (fallbackTimer && epoch === quipEpoch) {
            clearFallback();
            speak(t(pickVariant(key)));
          }
        });
    }, graceMs);
  }

  /**
   * ACK pembuka (aturan alur respons #1–#2): respons PERTAMA companion,
   * hanya setelah task_classified tiba — jenis tugas sudah pasti, jadi tidak
   * ada masa grasi. Diksi mengikuti tipe: greeting → balas sapa; search →
   * konfirmasi apa yang dicari; coding/general → konfirmasi mulai kerja.
   *
   * ACK SENGAJA tidak menyetel cooldown quip (lastQuip): ini kalimat pembuka
   * tugas, bukan quip progres — menyetelnya akan membungkam quip tool pertama
   * (yang sudah tertahan masa grasi sendiri) dan membuat tugas pendek tanpa
   * satu pun kabar. Ack ganda tetap mustahil: satu slot tugas, satu
   * task_classified per ask.
   */
  function ack(type: string): void {
    const known = ["greeting", "search", "coding", "general"];
    const kind = known.includes(type) ? type : "general";
    const key = `as.ack.${kind}`;
    clearFallback();
    const epoch = quipEpoch;
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null;
      speak(t(key));
    }, fbMs);
    post("/api/assistant/quip", { persona: actorPersona, ackType: kind, input: taskInput })
      .then((d) => {
        if (d?.quip && fallbackTimer && epoch === quipEpoch) {
          clearFallback();
          speak(d.quip);
        }
      })
      .catch(() => {
        if (fallbackTimer && epoch === quipEpoch) {
          clearFallback();
          speak(t(key));
        }
      });
  }

  return {
    /** Persona di-set tiap start panel (dari sheet userNote). */
    setPersona(p: string): void {
      actorPersona = String(p || "").slice(0, 800);
    },

    /** Teks input user tugas berjalan — konteks ack (aturan #2). */
    setTaskInput(text: string): void {
      taskInput = String(text || "").slice(0, 160);
    },

    onActivity(ev: ActorEvent): void {
      if (!ev) return;
      clearFiller();
      // Label asli event — dikirim ke prompt quip supaya komentar mengacu
      // pada pekerjaan yang nyata, bukan kalimat generik.
      const label = (ev.label || "").slice(0, 160);
      // Nama event kanonik dari server/agent/bus.ts
      switch (ev.type) {
        case "task_classified":
          // Jenis tugas diketahui → boleh bicara (#1). ACK langsung tanpa
          // grasi (#2): sapaan → balas sapa; search/coding/general →
          // konfirmasi singkat, eksekusi menyusul di loop.
          taskKnown = true;
          ack(label || "general");
          break;
        case "thinking_start":
          // Mulai mikir: tatap jauh (pose mikir). TANPA komentar — ack
          // task_classified sudah menjadi kalimat pembukanya (#1); quip
          // progres menunggu event tool yang nyata.
          react("think");
          // Filler: kalau lama tak ada kabar, karakter memberi kabar status
          // sendiri — pekerja yang menepati janji "kabar berikutnya
          // sebentar lagi".
          fillerTimer = setTimeout(() => {
            speak(t(fb.stillWorking || "as.actor.working"));
          }, 18000);
          break;
        case "tool_call_start":
          react("tool");
          comment(fb.tool || "as.actor.tool",
            label || "kamu sedang memeriksa berkas dan isi folder kerja", true);
          break;
        case "tool_call_end":
          // Tanpa komentar — hasil tool sudah tereport di transcript; cukup
          // reaksi pandang agar karakter tampak mengikuti.
          react("tool");
          break;
        case "permission_request":
          react("approval");
          comment(fb.think || "as.actor.think",
            label || "kamu butuh izin user untuk melanjutkan aksimu", false);
          break;
        case "permission_resolved": {
          // Disetujui → lega; ditolak → diam (jangan menghukum user).
          if (/^disetujui/i.test(ev.label || "")) react("done");
          break;
        }
        case "speak":
          // Komentar persona (dibuat server lewat role "chat") — teks utama
          // yang diucapkan; jangan ditimpa fallback.
          clearFallback();
          react("done");
          speak(ev.label || t(fb.done || "as.actor.done"));
          break;
        case "final_answer":
          // Simpulan akhir: laporan lisan datang lewat SSE speak (versi
          // tersanitasi jawaban). clearFallback membatalkan quip progres
          // yang masih menggantung — tugas sudah beres, "aku lagi nulis nih"
          // tak boleh menyusul. comment DI DAHULU (tugas ini sudah
          // diklasifikasi), lalu flag di-reset: tugas berikutnya kembali
          // diam sampai task_classified berikutnya (#1).
          react("done");
          clearFallback();
          if (!ev.label || !/^⏳/.test(ev.label)) {
            comment(fb.done || "as.actor.done",
              label || "kamu baru saja menyelesaikan tugasnya", true);
          }
          taskKnown = false;
          taskInput = "";
          break;
        case "error":
          // Kejadian penting (gagal): gugurkan narasi progres yang tak lagi
          // relevan, komentari kegagalan tugas YANG SUDAH dikenal, lalu reset.
          react("error");
          clearFallback();
          comment(fb.error || "as.actor.error",
            label || "kamu menemui kendala saat bekerja", true);
          taskKnown = false;
          taskInput = "";
          break;
        case "verification_result":
          // Gagal → prihatin + komentar; lolos → reaksi ringan tanpa komentar.
          if (/^gagal/i.test(ev.label || "")) {
            react("error");
            comment(fb.error || "as.actor.error",
              label || "kamu menemukan masalah saat memverifikasi hasil kerjamu", true);
          } else {
            react("done");
          }
          break;
        case "plan_revised":
          // Rencana berubah di tengah jalan — karakter ikut berpikir ulang.
          react("think");
          comment(fb.revised || "as.actor.revised",
            label || "kamu menyesuaikan rencana kerjamu", true);
          break;
        case "subagent_spawned":
          // Pekerjaan paralel — tetap karakternya yang mengerjakan, hanya
          // dibagi beberapa bagian.
          react("tool");
          comment(fb.tool || "as.actor.tool",
            label || "kamu mengerjakan beberapa bagian kecil secara paralel", true);
          break;
        case "subagent_completed":
          // Satu subtask tuntas — reaksi ringan, tanpa komentar.
          react("done");
          break;
      }
    },

    stop(): void {
      clearFiller();
      clearFallback();
      taskKnown = false;
      taskInput = "";
    },
  };
}

export type Actor = ReturnType<typeof makeActor>;
