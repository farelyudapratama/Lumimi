/**
 * character/runtime.ts — Character Runtime: komposisi deterministik sumber
 * keputusan karakter.
 *
 * Peran (ARSITEKTUR-TARGET, Gambar 2): LLM Speaker menghasilkan teks;
 * Animation Director + decision model (Laya/Jev lewat role behavior/motion)
 * menghasilkan INTENT semantik; runtime ini yang mengARBITRASI dan
 * MENJADULKAN; eksekutor existing (MotionRuntime, expression manager,
 * LipsyncUpdater, bridge app.js) yang menulis ke Live2D lewat mapping
 * model-specific (role space + registry). Runtime TIDAK PERNAH menyentuh
 * parameter Live2D — satu-satunya mata uang adalah domain semantik.
 *
 * Konsep slot (menggantikan "satu currentMotion"):
 *   base       — behavior loop; saat di-override ia DI-PAUSE (handle tetap),
 *                bukan dihancurkan, lalu di-RESUME otomatis.
 *   actions[]  — intent temporer ber-TTL + priority + fade (di eksekutor).
 *   expression — state afek persisten sampai diganti/dilepas; bisa di-override
 *                sementara oleh action yang klaim domain affect.
 *   speech     — sinyal aktif/tidak (pemilik speech policy tetap di luar).
 *   lipsync    — sinyal frame-bound; PEMILIK default domain apertur saat speech.
 *
 * ATURAN ARBITRASE (normatif — implementasi + test wajib mengikuti):
 *   R1  Intent dinilai konflik bila domains-nya beririsan dengan domain yang
 *       sedang dipegang holder aktif (base/action/expression) ATAU pemilik
 *       tetap (apertur milik lipsync saat speech aktif, kecuali
 *       intent.flags.aperture).
 *   R2  Tanpa konflik → OVERLAY (jalan bersama).
 *   R3  Konflik + priority LEBIH TINGGI dari semua holder yang berbenturan
 *       → OVERRIDE: holder kalah di-pause PADA DOMAIN BENTURAN saja (base
 *       di-pause via bridge, action kalah di-stop), dan di-resume otomatis
 *       saat semua pengambil alihnya selesai.
 *   R4  Konflik + priority SAMA → QUEUE (FIFO) bila intent berdurasi, selama
 *       slot action belum penuh (maxActions); tanpa durasi → REJECT.
 *   R5  Konflik + priority LEBIH RENDAH → REJECT (dengan alasan).
 *   R6  Tie-break OVERLAY/OVERRIDE seragam: priority → sourceRank → umur
 *       (lebih tua menang pada seri).
 *   R7  TTL habis di tick → lepas holder, resume yang di-pause, admit antrian
 *       (urutan FIFO, tiap admit dinilai ulang lewat R1–R6).
 *   R8  Expression selalu bisa diganti expression baru (bukan konflik — slot
 *       tunggal, ganti langsung, log "replace").
 *   R9  Base: setBase baru menggantikan base lama (stop via bridge); action
 *       vs base selalu R3/R4/R5 sesuai priority (base priority = 0).
 *   R10 Semua keputusan (termasuk REJECT/QUEUE) dicatat ke log ring (max 50)
 *       dengan alasan — bahan indikator Runtime Lab.
 */

export type Domain = "apertur" | "affect" | "head" | "eyes" | "gaze" | "body";

export type IntentKind = "base" | "action" | "expression";

export type IntentSource =
  | "manual"
  | "director"
  | "laya"
  | "jev"
  | "behavior"
  | "base";

export interface Intent {
  kind: IntentKind;
  /** Id semantik — bukan id param Live2D (mis. "surprise", "happy_conversation"). */
  id: string;
  domains: Domain[];
  /** Undefined = berlaku sampai dilepas (base/expression). Action wajib berdurasi. */
  durationMs?: number;
  /** 0..100. Base selalu 0; normal 60; high 80. */
  priority: number;
  source: IntentSource;
  /** Ms — diisi runtime dari bridge.now() bila absen. */
  at?: number;
  /** flag.aperture = action ini BOLEH mengklaim apertur saat speech aktif. */
  flags?: { aperture?: boolean };
}

export type PolicyMode = "overlay" | "override" | "queue" | "reject" | "replace";

export interface PolicyDecision {
  mode: PolicyMode;
  reason: string;
  intentId: string;
}

export interface DecisionEntry extends PolicyDecision {
  at: number;
  domains: Domain[];
  priority: number;
  source: IntentSource;
}

export interface RuntimeConfig {
  sourceRank: Record<IntentSource, number>;
  maxActions: number;
  /** Pemilik apertur saat speech aktif. Mouth Lab verdicts akan men-inject di sini. */
  apertureOwnerDuringSpeech: "lipsync" | "action";
}

export interface SlotView {
  id: string;
  status: "running" | "paused" | "stopped" | "active" | "queued";
  priority: number;
  remainingMs?: number;
  domains: Domain[];
  source: IntentSource;
}

export interface RuntimeSnapshot {
  now: number;
  base: SlotView | null;
  actions: SlotView[];
  expression: SlotView | null;
  speech: { active: boolean };
  lipsync: { active: boolean };
  /** Pemegang efektif tiap domain saat ini: domain → intent id. */
  holders: Record<string, string>;
  lastDecision: DecisionEntry | null;
}

/** Jembatan ke eksekutor existing. Semua opsional kecuali now(); runtime
 * menoleransi bridge parsial (guard tiap pemanggilan). */
export interface CharacterBridge {
  now(): number;
  startBase(intent: Intent): unknown | null;
  /** Pause base PADA DOMAIN TERTENTU saja; bridge memutuskan caranya. */
  pauseBase(handle: unknown, domains: Domain[]): void;
  resumeBase(handle: unknown, domains: Domain[]): void;
  stopBase(handle: unknown): void;
  startAction(intent: Intent): unknown | null;
  stopAction(handle: unknown): void;
  setExpression(intent: Intent): void;
  clearExpression(): void;
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  sourceRank: { manual: 3, director: 2, laya: 2, jev: 2, behavior: 1, base: 0 },
  maxActions: 3,
  apertureOwnerDuringSpeech: "lipsync",
};

type HolderKind = "base" | "action" | "expression";

/** Referensi holder yang berbenturan dengan intent masuk. */
interface HolderRef {
  kind: HolderKind;
  intent: Intent;
  slot?: ActionSlot;
}

interface BaseSlot {
  intent: Intent;
  handle: unknown;
  /** Domain base yang sedang diambil alih holder lain (pause per-domain). */
  paused: Set<Domain>;
}

interface ActionSlot {
  intent: Intent;
  handle: unknown;
  /** Null selama mengantre; TTL mulai berjalan saat admit. */
  expiresAt: number | null;
  status: "active" | "queued";
}

interface ExpressionSlot {
  intent: Intent;
  /** "deferred" = ditunda karena di-override action; dikembalikan saat bebas. */
  status: "active" | "deferred";
}

/** Hasil penilaian R1–R6 tanpa efek samping (dipakai submit dan admit antrian). */
interface EvalVerdict {
  mode: "overlay" | "override" | "queue" | "reject";
  reason: string;
  conflicts: HolderRef[];
  replaced: boolean;
}

const LOG_MAX = 50;

export class CharacterRuntime {
  private bridge: CharacterBridge | null = null;
  private cfg: RuntimeConfig;
  private base: BaseSlot | null = null;
  /** Slot action: entri aktif dan yang mengantre (FIFO sesuai urutan array). */
  private actions: ActionSlot[] = [];
  private expression: ExpressionSlot | null = null;
  private speech = false;
  private lipsync = false;
  /** Ring log keputusan — terbaru di akhir, maks LOG_MAX. */
  private log: DecisionEntry[] = [];

  constructor(config?: Partial<RuntimeConfig>) {
    this.cfg = {
      sourceRank: { ...DEFAULT_CONFIG.sourceRank, ...(config?.sourceRank ?? {}) },
      maxActions: config?.maxActions ?? DEFAULT_CONFIG.maxActions,
      apertureOwnerDuringSpeech:
        config?.apertureOwnerDuringSpeech ?? DEFAULT_CONFIG.apertureOwnerDuringSpeech,
    };
  }

  attach(bridge: CharacterBridge): void {
    this.bridge = bridge;
  }

  /** Mulai/ganti base behavior. Base lama di-stop via bridge (R9). */
  setBase(intent: Intent): PolicyDecision {
    const now = intent.at ?? this.now();
    intent.at = now;
    // R9: setBase selalu menggantikan — tidak dinilai R4/R5 melawan holder.
    // Domain yang dipegang action/expression lebih tinggi tetap menang lewat
    // pause per-domain (syncBase); apertur saat speech tetap milik lipsync
    // di peta holders.
    const hadBase = this.base !== null;
    const old = this.base;
    if (old && old.handle != null) this.bridge?.stopBase?.(old.handle);
    const handle = this.bridge?.startBase?.(intent) ?? null;
    this.base = { intent, handle, paused: new Set() };
    this.syncBase();
    const mode: PolicyMode = hadBase ? "replace" : "overlay";
    const reason = hadBase ? "base baru menggantikan base lama (R9)" : "base pertama — tanpa konflik";
    this.logDecision(mode, reason, intent, now);
    return { mode, reason, intentId: intent.id };
  }

  stopBase(): void {
    if (!this.base) return;
    if (this.base.handle != null) this.bridge?.stopBase?.(this.base.handle);
    this.base = null;
  }

  /** Masukkan intent action/expression — dinilai R1–R8. */
  submit(intent: Intent): PolicyDecision {
    const now = intent.at ?? this.now();
    intent.at = now;
    if (intent.kind === "base") return this.setBase(intent);
    // Kontrak: action wajib berdurasi — validasi intent sebelum arbitrase.
    if (intent.kind === "action" && !(typeof intent.durationMs === "number" && intent.durationMs > 0)) {
      return this.finish("reject", "action wajib berdurasi (durationMs > 0)", intent, now);
    }
    const v = this.evaluateIntent(intent);
    if (v.mode === "overlay" || v.mode === "override") {
      if (v.mode === "override") this.defeatConflicting(v.conflicts);
      if (intent.kind === "expression") {
        const reason =
          v.mode === "override"
            ? `${v.reason}${v.replaced ? "; expression lama turun dari slot" : ""}`
            : v.replaced
              ? "expression diganti — slot tunggal, ganti langsung (R8)"
              : "expression pertama — tanpa konflik";
        return this.takeExpressionSlot(intent, now, v.mode === "override", v.replaced, reason);
      }
      this.admitAction(intent, now);
      return this.finish(v.mode, v.reason, intent, now);
    }
    if (v.mode === "queue") {
      this.actions.push({ intent, handle: null, expiresAt: null, status: "queued" });
      return this.finish("queue", v.reason, intent, now);
    }
    return this.finish("reject", v.reason, intent, now);
  }

  /** Lepas expression saat ini (clearExpression via bridge). */
  releaseExpression(): void {
    if (!this.expression) return;
    if (this.expression.status === "active") this.bridge?.clearExpression?.();
    this.expression = null;
    this.syncBase();
  }

  speechActive(active: boolean): void {
    this.speech = active;
  }

  lipsyncActive(active: boolean): void {
    this.lipsync = active;
  }

  /** Expire TTL (R7), resume paused, admit antrian. Dipanggil app.js tiap tick. */
  tick(nowMs?: number): RuntimeSnapshot {
    const now = nowMs ?? this.now();

    // R7-1: TTL habis → lepas holder (action di-stop utuh; pause base
    // dicerminkan sekali lewat syncBase setelah restore expression).
    for (let i = 0; i < this.actions.length; ) {
      const a = this.actions[i];
      if (a.status === "active" && a.expiresAt !== null && a.expiresAt <= now) {
        if (a.handle != null) this.bridge?.stopAction?.(a.handle);
        this.actions.splice(i, 1);
        continue;
      }
      i++;
    }

    // R7-2: kembalikan expression yang ditunda bila domainnya bebas dari
    // action aktif. Expression ditunda whole-slot (eksekutor tidak bisa pause
    // per-domain), jadi syarat pengembaliannya bebas penuh.
    if (this.expression && this.expression.status === "deferred") {
      const blocked = this.actions.some(
        (a) =>
          a.status === "active" &&
          a.intent.domains.some((d) => this.expression!.intent.domains.includes(d)),
      );
      if (!blocked) {
        this.expression.status = "active";
        this.bridge?.setExpression?.(this.expression.intent);
      }
    }
    this.syncBase();

    // R7-3: admit antrian FIFO satu-satu; tiap admit dinilai ulang R1–R6.
    // Indeks tidak selalu maju: elemen berikutnya bergeser saat slot dihapus.
    for (let i = 0; i < this.actions.length; ) {
      const slot = this.actions[i];
      if (slot.status !== "queued") {
        i++;
        continue;
      }
      const v = this.evaluateIntent(slot.intent, slot);
      if (v.mode === "reject") {
        this.actions.splice(i, 1);
        this.logDecision("reject", `antrian ditolak: ${v.reason}`, slot.intent, now);
        continue;
      }
      if (v.mode === "queue") {
        i++;
        continue;
      }
      this.actions.splice(i, 1);
      if (v.mode === "override") this.defeatConflicting(v.conflicts);
      this.admitAction(slot.intent, now);
      this.logDecision(v.mode, `antrian admit: ${v.reason}`, slot.intent, now);
    }

    return this.buildSnapshot(now);
  }

  snapshot(): RuntimeSnapshot {
    return this.tick();
  }

  /** Ring log keputusan (terbaru di akhir, maks 50). */
  decisions(): DecisionEntry[] {
    return this.log.slice();
  }

  /** Stop semua slot + kosongkan antrian/log (ganti model). */
  reset(): void {
    for (const a of this.actions) {
      if (a.status === "active" && a.handle != null) this.bridge?.stopAction?.(a.handle);
    }
    if (this.base && this.base.handle != null) this.bridge?.stopBase?.(this.base.handle);
    if (this.expression && this.expression.status === "active") this.bridge?.clearExpression?.();
    this.base = null;
    this.actions = [];
    this.expression = null;
    this.speech = false;
    this.lipsync = false;
    this.log = [];
  }

  // ===== internals =====

  private now(): number {
    const t = this.bridge?.now?.();
    return typeof t === "number" ? t : Date.now();
  }

  /** Catat keputusan ke ring log (R10) dan balikkan sebagai PolicyDecision. */
  private finish(mode: PolicyMode, reason: string, intent: Intent, at: number): PolicyDecision {
    this.logDecision(mode, reason, intent, at);
    return { mode, reason, intentId: intent.id };
  }

  private logDecision(mode: PolicyMode, reason: string, intent: Intent, at: number): void {
    this.log.push({
      mode,
      reason,
      intentId: intent.id,
      at,
      domains: [...intent.domains],
      priority: intent.priority,
      source: intent.source,
    });
    if (this.log.length > LOG_MAX) this.log.shift();
  }

  /** R6 — pembanding seragam: priority → sourceRank → umur (lebih tua menang).
   * Seri absolut membuat pemegang bertahan. */
  private beats(a: Intent, b: Intent): boolean {
    if (a.priority !== b.priority) return a.priority > b.priority;
    const ra = this.cfg.sourceRank[a.source] ?? 0;
    const rb = this.cfg.sourceRank[b.source] ?? 0;
    if (ra !== rb) return ra > rb;
    return (a.at ?? 0) < (b.at ?? 0);
  }

  /** Pemilik tetap apertur (R1): saat speech aktif apertur milik lipsync,
   * kecuali intent membawa flags.aperture — tidak bisa di-override priority. */
  private apertureOwnedByLipsync(intent: Intent): boolean {
    return (
      this.speech &&
      this.cfg.apertureOwnerDuringSpeech === "lipsync" &&
      intent.domains.includes("apertur") &&
      intent.flags?.aperture !== true
    );
  }

  /** Holder aktif yang berbenturan dengan intent (R1). Expression tidak
   * dihitung untuk intent expression — slot tunggal, selalu R8 (ganti langsung). */
  private conflictingHolders(intent: Intent): HolderRef[] {
    const hits = (doms: Domain[]) => doms.some((d) => intent.domains.includes(d));
    const out: HolderRef[] = [];
    if (this.base) {
      // Base yang ter-pause sebagian tetap memegang domain sisanya.
      const eff = this.base.intent.domains.filter((d) => !this.base!.paused.has(d));
      if (eff.length > 0 && hits(eff)) out.push({ kind: "base", intent: this.base.intent });
    }
    if (intent.kind === "action") {
      if (
        this.expression &&
        this.expression.status === "active" &&
        hits(this.expression.intent.domains)
      ) {
        out.push({ kind: "expression", intent: this.expression.intent });
      }
      for (const a of this.actions) {
        if (a.status === "active" && hits(a.intent.domains)) {
          out.push({ kind: "action", intent: a.intent, slot: a });
        }
      }
    }
    return out;
  }

  /** Penilaian murni R1–R6 (tanpa mutasi/log). selfSlot = slot antrian milik
   * intent yang dinilai — dikeluarkan dari hitungan kapasitas agar admit
   * ulang tidak menghitung dirinya dua kali. */
  private evaluateIntent(intent: Intent, selfSlot?: ActionSlot): EvalVerdict {
    const replaced = intent.kind === "expression" && this.expression !== null;
    if (this.apertureOwnedByLipsync(intent)) {
      return {
        mode: "reject",
        reason: "apertur milik lipsync saat speech aktif (butuh flags.aperture)",
        conflicts: [],
        replaced,
      };
    }
    const conflicts = this.conflictingHolders(intent);
    if (conflicts.length === 0) {
      // Kapasitas maxActions mengikat setiap admit action baru (overlay maupun
      // antrian); override bypass karena ia membebaskan slot yang kalah.
      if (intent.kind === "action" && this.usedSlots(selfSlot) >= this.cfg.maxActions) {
        return { mode: "reject", reason: `slot action penuh (${this.cfg.maxActions})`, conflicts, replaced };
      }
      return { mode: "overlay", reason: "tanpa konflik domain — overlay bersama holder aktif", conflicts, replaced };
    }
    const maxP = Math.max(...conflicts.map((c) => c.intent.priority));
    if (conflicts.every((c) => this.beats(intent, c.intent))) {
      return {
        mode: "override",
        reason: `priority ${intent.priority} mengambil alih ${conflicts.length} holder (tertinggi ${maxP})`,
        conflicts,
        replaced,
      };
    }
    if (intent.priority < maxP) {
      return {
        mode: "reject",
        reason: `priority ${intent.priority} < priority holder tertinggi ${maxP}`,
        conflicts,
        replaced,
      };
    }
    // Priority sama dengan holder tertinggi tapi kalah tie-break R6 → R4.
    if (intent.kind === "expression") {
      return {
        mode: "reject",
        reason: "priority sama dengan holder & kalah tie-break — expression tidak mengantre",
        conflicts,
        replaced,
      };
    }
    if (this.usedSlots(selfSlot) >= this.cfg.maxActions) {
      return { mode: "reject", reason: `slot action penuh (${this.cfg.maxActions})`, conflicts, replaced };
    }
    return {
      mode: "queue",
      reason: `priority sama dengan holder tertinggi (${maxP}) & kalah tie-break — masuk antrian FIFO`,
      conflicts,
      replaced,
    };
  }

  private usedSlots(selfSlot?: ActionSlot): number {
    return this.actions.length - (selfSlot ? 1 : 0);
  }

  /** Eksekusi OVERRIDE terhadap holder kalah (R3): action kalah di-stop,
   * expression kalah ditunda; base kalah di-pause per-domain oleh syncBase
   * setelah intent pemenang di-admit. */
  private defeatConflicting(conflicts: HolderRef[]): void {
    for (const c of conflicts) {
      if (c.kind === "action" && c.slot) {
        if (c.slot.handle != null) this.bridge?.stopAction?.(c.slot.handle);
        this.actions = this.actions.filter((a) => a !== c.slot);
      } else if (
        c.kind === "expression" &&
        this.expression &&
        this.expression.intent === c.intent &&
        this.expression.status === "active"
      ) {
        this.bridge?.clearExpression?.();
        this.expression.status = "deferred";
      }
    }
  }

  private admitAction(intent: Intent, now: number): void {
    const handle = this.bridge?.startAction?.(intent) ?? null;
    this.actions.push({ intent, handle, expiresAt: now + (intent.durationMs ?? 0), status: "active" });
    this.syncBase();
  }

  private takeExpressionSlot(
    intent: Intent,
    now: number,
    wonOverride: boolean,
    replaced: boolean,
    reason: string,
  ): PolicyDecision {
    this.expression = { intent, status: "active" };
    this.bridge?.setExpression?.(intent);
    this.syncBase();
    const mode: PolicyMode = wonOverride ? "override" : replaced ? "replace" : "overlay";
    return this.finish(mode, reason, intent, now);
  }

  /** Holder non-base yang sedang memegang domain (expression aktif + action
   * aktif). Base yang ter-pause sebagian tetap memegang sisanya — dihitung
   * terpisah oleh pemanggil. */
  private activeHolders(): { intent: Intent; domains: Domain[] }[] {
    const out: { intent: Intent; domains: Domain[] }[] = [];
    if (this.expression && this.expression.status === "active") {
      out.push({ intent: this.expression.intent, domains: [...this.expression.intent.domains] });
    }
    for (const a of this.actions) {
      if (a.status === "active") out.push({ intent: a.intent, domains: [...a.intent.domains] });
    }
    return out;
  }

  /** Cerminan pause/resume base ke bridge: pause pada domain yang kini dipegang
   * holder lain, resume pada domain yang sudah bebas dari SEMUA pengambil alih
   * (R3 "resume saat semua pengambil alih selesai"). Dipanggil setiap kali
   * populasi holder berubah. */
  private syncBase(): void {
    const base = this.base;
    if (!base) return;
    const desired = new Set<Domain>();
    for (const h of this.activeHolders()) {
      for (const d of h.domains) if (base.intent.domains.includes(d)) desired.add(d);
    }
    const added: Domain[] = [];
    const removed: Domain[] = [];
    for (const d of desired) if (!base.paused.has(d)) added.push(d);
    for (const d of base.paused) if (!desired.has(d)) removed.push(d);
    if (added.length > 0) {
      for (const d of added) base.paused.add(d);
      this.bridge?.pauseBase?.(base.handle, added);
    }
    if (removed.length > 0) {
      for (const d of removed) base.paused.delete(d);
      this.bridge?.resumeBase?.(base.handle, removed);
    }
  }

  private buildSnapshot(now: number): RuntimeSnapshot {
    const actions: SlotView[] = this.actions.map((a) => ({
      id: a.intent.id,
      status: a.status,
      priority: a.intent.priority,
      ...(a.status === "active" && a.expiresAt !== null
        ? { remainingMs: Math.max(0, a.expiresAt - now) }
        : {}),
      domains: [...a.intent.domains],
      source: a.intent.source,
    }));
    const base: SlotView | null = this.base
      ? {
          id: this.base.intent.id,
          status: this.base.paused.size > 0 ? "paused" : "running",
          priority: this.base.intent.priority,
          domains: [...this.base.intent.domains],
          source: this.base.intent.source,
        }
      : null;
    const expression: SlotView | null = this.expression
      ? {
          id: this.expression.intent.id,
          status: this.expression.status === "active" ? "active" : "paused",
          priority: this.expression.intent.priority,
          domains: [...this.expression.intent.domains],
          source: this.expression.intent.source,
        }
      : null;
    // Urutan penetapan pemegang efektif: base → expression → pemilik tetap
    // apertur → action (action selalu menang karena hanya ia yang bisa
    // mengambil alih seluruh holder lain lewat R3).
    const holders: Record<string, string> = {};
    if (this.base) {
      for (const d of this.base.intent.domains) {
        if (!this.base.paused.has(d)) holders[d] = this.base.intent.id;
      }
    }
    if (this.expression && this.expression.status === "active") {
      for (const d of this.expression.intent.domains) holders[d] = this.expression.intent.id;
    }
    if (this.speech && this.cfg.apertureOwnerDuringSpeech === "lipsync") {
      holders.apertur = "lipsync";
    }
    for (const a of this.actions) {
      if (a.status === "active") {
        for (const d of a.intent.domains) holders[d] = a.intent.id;
      }
    }
    return {
      now,
      base,
      actions,
      expression,
      speech: { active: this.speech },
      lipsync: { active: this.lipsync },
      holders,
      lastDecision: this.log.length > 0 ? this.log[this.log.length - 1] : null,
    };
  }
}
