/**
 * client/bundle-entry.ts — Single entrypoint that bundles the TS client core into
 * static/js/bundle.js and installs it onto `window` for the legacy static/js/app.js
 * (engine/UI) to consume.
 *
 * This makes the TypeScript code the LIVE source-of-truth for:
 *   - the motion DSL        → window.MotionDSL  (namespace of pure functions)
 *   - the motion registry   → window.MotionRegistry  (the CLASS, so .createRegistry() works)
 *   - the motion runtime    → window.MotionRuntime   (the CLASS, so .createRuntime() works)
 *   - the motion taxonomy   → window.MotionTaxonomy  (namespace of pure functions)
 *   - the agent brain       → window.__agent  (installed inside brain.ts)
 *
 * app.js still owns model loading, the render loop, and the UI; it calls
 * MotionRegistry.createRegistry() / MotionRuntime.createRuntime(...) — hence the
 * classes (with their static factory facades) are installed directly, not wrapped
 * in a namespace. No render loop is started here, so there is no conflict.
 */
import type {} from "./window-contract";
import * as MotionDSL from "./animation/motion-dsl";
import { toMotion3, motion3ToAsset } from "./animation/motion-io";
import { MotionRegistry } from "./animation/motion-registry";
import { MotionRuntime } from "./animation/motion-runtime";
import * as MotionTaxonomy from "./engine/motion-taxonomy";
import * as Framing from "./engine/framing";
import * as RoleMapping from "./engine/role-mapping";
import * as MouthCandidates from "./engine/mouth-candidates";
import { collectNativeExpressions } from "./engine/native-expressions";
import { buildNativeClips, buildNativeClipsFromCounts } from "./engine/native-clips";
import * as LipSync from "./speech/lip-sync";
import { createSpeechPolicy } from "./speech/speech-policy";
import * as Character from "./character/runtime";
import { directorToIntents, behaviorToIntents } from "./character/adapters";
import * as i18n from "./i18n/index";
import { transport } from "./transport/index";
import "./agent/directive-parser";
import "./agent/brain"; // installs window.__agent at module load
import { startWorkbench } from "./agent/panel/workbench";
import { startProjekRail } from "./shell/projek";
import { startBrowserPanel } from "./browser/panel";
import { startStageHintFade } from "./shell/stage-hint";

if (typeof window !== "undefined") {
  window.MotionDSL = MotionDSL;
  window.MotionRegistry = MotionRegistry;
  window.MotionRuntime = MotionRuntime;
  window.MotionTaxonomy = MotionTaxonomy;
  window.LipSync = LipSync;
  // Policy/kepemilikan speech (boundary §15–16): producer menyebut kelas,
  // controller menentukan ALLOW/PREEMPT/QUEUE/SUPPRESS. Executor-nya
  // didaftarkan app.js (speak/runSpeech) — tanpa executor tidak ada audio.
  window.__speech = createSpeechPolicy();
  // Role mapping & skala referensi (murni) — sumber kebenaran tunggal;
  // app.js legacy memanggil lewat window.__roleMapping (wrapper tipis).
  window.__roleMapping = RoleMapping;
  // Kandidat param mulut (Lab Mulut) — murni; keputusan kepemilikan milik user.
  window.__mouthCandidates = MouthCandidates;
  window.__nativeExpressions = { collect: collectNativeExpressions };
  // Klip motion native per-file — app.js memakainya untuk registry per-klip:
  // grup "" dan klip di grup multi-klip kini teralamat exact (bukan acak).
  window.__nativeClips = {
    build: buildNativeClips,
    buildFromCounts: buildNativeClipsFromCounts,
  };
  // Konversi dua arah Motion Asset ↔ .motion3.json — dipakai Motion Studio
  // (tombol Ekspor + Impor). Murni; role→param di-resolve pemanggil.
  window.__motionIO = { toMotion3, motion3ToAsset };
  // Character Runtime + adapter keputusan → Intent semantik. Adapter murni
  // (Director/behavior dinormalkan dulu); runtime-lah yang mengarbitrase slot
  // base/action/expression — tak pernah menyentuh param Live2D langsung.
  window.__characterRuntime = {
    CharacterRuntime: Character.CharacterRuntime,
    create: () => new Character.CharacterRuntime(),
    directorToIntents,
    behaviorToIntents,
  };
  // Rumus framing panggung (murni) — dipakai legacy frameModel. upper/full
  // hanya fungsi TINGGI stage (anti-gepeng saat splitter didrag).
  window.__framing = Framing;
  // i18n: init() sinkron menyweep atribut data-i18n* di DOM statis SEBELUM
  // app.js dieksekusi (script di akhir body → DOM sudah ter-parse), lalu
  // app.js/motion-editor/mode-runtime memakai window.__i18n.t() saat runtime.
  window.__i18n = i18n;
  // Seam transport (satu binary, satu proses) — titik tunggal komunikasi ke
  // backend. Call-site baru pakai window.__transport.
  // Lihat docs/ARCHITECTURE-TAURI-RUST.md.
  window.__transport = transport;
  // Boot transport: temukan port loopback (embedded) sedini mungkin supaya
  // httpBase() tepat sebelum fetch pertama. Non-blokir.
  transport.initLoopback().catch(() => {});
  // Indikator core native: embedded → command IPC; dev → HTTP. Non-blokir.
  transport.coreVersion().then((v) => {
    if (v) document.title = document.title + " · core v" + v + " (native)";
  }).catch(() => { /* server belum naik → biarkan */ });
  // Panel agent (mode Assistant) — dipanggil mode-runtime.js saat tab
  // assistant aktif. Remake tampilan ala ZCode tinggal di sini (TS).
  window.__agentPanel = { start: startWorkbench };
  // Rail projek shell (activity bar kiri) — start sekali di boot app.
  window.__shellProjek = { start: startProjekRail };
  window.__browserPanel = { start: startBrowserPanel };
  try { startProjekRail(); } catch {}
  // Hint panggung memudar setelah interaksi pertama (drag/zoom).
  try { startStageHintFade(); } catch {}
  // Mount ada setelah panel Assistant membangun halaman teknis; panel memanggil
  // start ulang saat tab Browser tersedia.
  i18n.init();
  console.log("🎭 Lumimi: TS core installed (MotionDSL/Registry/Runtime/Taxonomy/LipSync + brain + i18n)");
}
