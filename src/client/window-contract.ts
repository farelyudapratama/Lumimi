import type * as RoleMapping from "./engine/role-mapping";
import type * as MouthCandidates from "./engine/mouth-candidates";
import type * as Framing from "./engine/framing";
import type * as MotionDSL from "./animation/motion-dsl";
import type { MotionRegistry } from "./animation/motion-registry";
import type { MotionRuntime } from "./animation/motion-runtime";
import type * as MotionTaxonomy from "./engine/motion-taxonomy";
import type * as LipSync from "./speech/lip-sync";
import type { Transport } from "./transport/index";
import type {
  SpeechClass,
  SpeechController,
  SpeechJob,
} from "./speech/speech-policy";
import type { collectNativeExpressions } from "./engine/native-expressions";
import type {
  buildNativeClips,
  buildNativeClipsFromCounts,
} from "./engine/native-clips";
import type { toMotion3, motion3ToAsset } from "./animation/motion-io";
import type { CharacterRuntime } from "./character/runtime";
import type { directorToIntents, behaviorToIntents } from "./character/adapters";
import type * as I18n from "./i18n/index";

export type Destroy = () => void;

export type SpeakOpts = {
  /** Kelas produser untuk policy speech — default app.js: "direct". */
  cls?: string;
  /** Cleanup producer saat ucapan ini digulingkan (onDone TIDAK dipanggil). */
  onPreempted?: () => void;
};

export type Live2DLegacyBridge = {
  getCapabilityProfile?: () => Promise<{ userNote?: string }>;
  /** Nama folder model aktif (untuk konteks tool motion di server). */
  modelKey?: () => string;
  /** Param id untuk nama role (hasil role-mapping engine; sumber tunggal di TS). */
  roleIdFor?: (role: string) => string | null;
  speak?: (text: string, onDone?: () => void, opts?: SpeakOpts) => void;
  stopSpeaking?: () => void;
};

declare global {
  interface Window {
    MotionDSL?: typeof MotionDSL;
    MotionRegistry?: typeof MotionRegistry;
    MotionRuntime?: typeof MotionRuntime;
    MotionTaxonomy?: typeof MotionTaxonomy;
    LipSync?: typeof LipSync;
    __agentPanel?: { start(): Destroy };
    __shellProjek?: { start(): Destroy };
    __browserPanel?: { start(): Destroy };
    __roleMapping?: typeof RoleMapping;
    /** Kandidat param mulut (Lab Mulut) — murni; verdict kepemilikan milik user. */
    __mouthCandidates?: typeof MouthCandidates;
    __framing?: typeof Framing;
    __nativeExpressions?: { collect: typeof collectNativeExpressions };
    /** Klip motion native per-file — registry per-klip + playback exact. */
    __nativeClips?: {
      build: typeof buildNativeClips;
      buildFromCounts: typeof buildNativeClipsFromCounts;
    };
    /** Konversi dua arah Motion Asset ↔ .motion3.json (Motion Studio). */
    __motionIO?: {
      toMotion3: typeof toMotion3;
      motion3ToAsset: typeof motion3ToAsset;
    };
    /** Character Runtime (arbitrase slot) + adapter keputusan → Intent semantik. */
    __characterRuntime?: {
      CharacterRuntime: typeof CharacterRuntime;
      create(): CharacterRuntime;
      directorToIntents: typeof directorToIntents;
      behaviorToIntents: typeof behaviorToIntents;
    };
    __i18n?: typeof I18n;
    /** Seam transport (Stage 1a) — titik tunggal komunikasi ke backend. */
    __transport?: Transport;
    __live2dAgent?: Live2DLegacyBridge;
    __addChat?: (role: string, text: string) => void;
    /** Policy speech (bundle) — app.js executor mendaftar lewat setExecutor. */
    __speech?: SpeechController;
  }
}

export type { SpeechClass, SpeechJob };

export {};
