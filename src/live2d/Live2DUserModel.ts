/**
 * Live2DUserModel — pipeline update dua fase resmi (pola LAppModel 5-r.5)
 * di atas CubismUserModel vendored, yang TIDAK punya update(dt) maupun
 * scheduler sendiri. Urutan per frame (aturan paling sering dilanggar):
 *   loadParameters → motion → saveParameters → scheduler.onLateUpdate →
 *   model.update — motion satu-satunya penulis persisten; tulisan efek
 *   dibuang loadParameters() frame berikutnya supaya efek aditif
 * (breath/look/lipsync) tidak menumpuk tanpa batas.
 * dt dalam DETIK; tiap manager meng-akumulasi userTimeSeconds sendiri.
 */
import { CubismUserModel } from "./cubism/model/cubismusermodel";
import type { CubismModel } from "./cubism/model/cubismmodel";
import type { CubismModelSettingJson } from "./cubism/cubismmodelsettingjson";
import { CubismUpdateScheduler } from "./cubism/motion/cubismupdatescheduler";
import { ICubismUpdater, CubismUpdateOrder } from "./cubism/motion/icubismupdater";
import { CubismEyeBlink } from "./cubism/effect/cubismeyeblink";
import { CubismEyeBlinkUpdater } from "./cubism/motion/cubismeyeblinkupdater";
import { CubismExpressionUpdater } from "./cubism/motion/cubismexpressionupdater";
import { CubismLook, LookParameterData } from "./cubism/effect/cubismlook";
import { CubismLookUpdater } from "./cubism/motion/cubismlookupdater";
import { CubismBreath, BreathParameterData } from "./cubism/effect/cubismbreath";
import { CubismBreathUpdater } from "./cubism/motion/cubismbreathupdater";
import { CubismPhysicsUpdater } from "./cubism/motion/cubismphysicsupdater";
import { CubismPoseUpdater } from "./cubism/motion/cubismposeupdater";
import type { CubismMotion } from "./cubism/motion/cubismmotion";
import { ACubismMotion } from "./cubism/motion/acubismmotion";
import { CubismFramework } from "./cubism/live2dcubismframework";
import type { CubismIdHandle } from "./cubism/id/cubismid";
import { CubismMotionCurveTarget } from "./cubism/motion/cubismmotioninternal";
import {
  applyBaselineRelease,
  collectMotionCurveIds,
  CURVE_TARGET_PARAMETER,
  planBaselineRelease,
  type BaselineReleasePlan,
} from "./baseline-release";

/** Konvensi prioritas motion sample resmi (LAppDefine). */
export const MotionPriority = {
  None: 0,
  Idle: 1,
  Normal: 2,
  Force: 3,
} as const;

/** Durasi ease pose terakhir klip → default model saat window play berakhir
 * (pelepasan kepemilikan motion atas parameter). */
const BASELINE_RELEASE_MS = 450;

/** Updater lipsync: menulis param mulut (role-resolved) dari penyedia
 * nilai 0..1, diskalakan ke range aktual param. Provider null = tidak
 * bicara → nilai base/motion yang tampil (tulisan efek frame-transien).
 * SET, bukan add: mulut terbuka menggantikan base saat bicara. */
class LipsyncUpdater extends ICubismUpdater {
  constructor(
    private provider: () => number | null,
    private id: CubismIdHandle,
    private min: number,
    private max: number,
    order: number,
  ) {
    super(order);
  }
  onLateUpdate(model: CubismModel, _dt: number): void {
    const v = this.provider();
    if (v == null) return;
    const openness = Math.max(0, Math.min(1, v));
    model.setParameterValueById(
      this.id,
      this.min + openness * (this.max - this.min),
      1,
    );
  }
}

/** Updater ber-gate runtime. Tulisan efek frame-transien (dibuang
 * loadParameters frame berikutnya) — gate false berarti nilai base motion
 * yang tampil, tanpa restore manual. Dipakai breath; blink memakai
 * callback _motionUpdated. */
class GatedUpdater extends ICubismUpdater {
  constructor(
    private inner: ICubismUpdater,
    private gate: () => boolean,
    order: number,
  ) {
    super(order);
  }
  onLateUpdate(model: CubismModel, dt: number): void {
    if (this.gate()) this.inner.onLateUpdate(model, dt);
  }
}

export class Live2DUserModel extends CubismUserModel {
  readonly updateScheduler = new CubismUpdateScheduler();
  /** View integrasi mematikan ini: app.js punya idle scheduler sendiri
   * (startIdleMotion, interval 7 dtk) — dua idle = dua sumber motion. */
  autoIdle = true;
  /** Gate kedip: false = updater melewatkan frame itu. Diputuskan app.js
   * dari konfigurasi sheet (blinkEnabled) + state.frozen. */
  blinkGate: (() => boolean) | null = null;
  /** Gate napas: hasBreath + frozen + motion layer aktif (kurva klip bisa
   * membawa breath sendiri). */
  breathGate: (() => boolean) | null = null;
  /** Gate gaze: off saat otak/klip memegang pose (aiLock/frozen/motion
   * layer) supaya tidak dobel dengan gaze driver. */
  lookGate: (() => boolean) | null = null;
  /** Penyedia lipsync: nilai 0..1 saat bicara, null saat tidak — dipasang
   * app.js (analisis audio TTS lokal milik driver). */
  lipsyncProvider: (() => number | null) | null = null;

  /** Pasang updater lipsync untuk SATU param mulut (role-resolved).
   * Dipanggil renderer setelah role map siap; model tanpa role mulut
   * tidak mendaftar apa pun. */
  registerLipsync(id: CubismIdHandle, min: number, max: number): void {
    this.updateScheduler.addUpdatableList(
      new LipsyncUpdater(() => this.lipsyncProvider?.() ?? null, id, min, max, 450),
    );
  }

  /** Ganti data look (gain keekspresivan gaze per grup sendi) tanpa membuat
   * ulang updater — dipanggil renderer saat config user berubah. */
  setLookParameters(list: LookParameterData[]): void {
    this._look?.setParameters(list);
  }

  /** Fallback blink: rig tanpa grup EyeBlink di manifest menghasilkan
   * instance ber-0 id — isi id mata dari role mapping (by-name). Id milik
   * deklarasi rigger selalu menang (no-op bila sudah ada). */
  ensureEyeBlink(ids: CubismIdHandle[]): void {
    if (!ids.length) return;
    if (this._eyeBlink) {
      if (this._eyeBlink.getParameterIds().length) return;
      this._eyeBlink.setParameterIds(ids);
      return;
    }
    this._eyeBlink = new CubismEyeBlink(null as any);
    this._eyeBlink.setParameterIds(ids);
  }
  private _setting: CubismModelSettingJson | null = null;
  private _baseUrl = "";
  private _motionCache = new Map<string, CubismMotion>();
  private _expressionCache = new Map<string, ACubismMotion>();
  private _motionUpdated = false;
  private _eyeBlinkIds: CubismIdHandle[] = [];
  private _lipSyncIds: CubismIdHandle[] = [];
  private _look: CubismLook | null = null;
  /** Kurva param klip yang main pada window play berjalan (akumulasi lintas
   * penggantian klip — klip baru tak selalu menganimasi param klip lama).
   * Isinya id mentah (CubismIdHandle) — diteruskan apa adanya ke
   * getParameterIndex. */
  private _playCurveIds = new Set<unknown>();
  private _wasMotionPlaying = false;
  private _baselineRelease: {
    plan: BaselineReleasePlan;
    elapsedMs: number;
  } | null = null;

  /** Kaitkan manifest + direktori dasar setelah moc termuat.
   * Id blink/lipsync dari grup resmi manifest (by-name, bukan indeks). */
  attachSetting(
    setting: CubismModelSettingJson,
    baseUrl: string,
    eyeBlinkIds: string[],
    lipSyncIds: string[],
  ): void {
    this._setting = setting;
    this._baseUrl = baseUrl;
    const idMgr = CubismFramework.getIdManager();
    this._eyeBlinkIds = eyeBlinkIds.map((id) => idMgr.getId(id));
    this._lipSyncIds = lipSyncIds.map((id) => idMgr.getId(id));
    // Base class menaruh _eyeBlink = null; blink dikonstruksi dari manifest.
    this._eyeBlink = CubismEyeBlink.create(setting);
  }

  /** Daftarkan updater efek ke scheduler (urut execution order).
   * Dipanggil SETELAH role map siap karena look/breath diskalakan dari
   * range aktual model (role-space), bukan angka std ±30/±1. Opsi enabled
   * untuk integrasi view: fitur yang app.js miliki (blink/look/breath
   * driver lama) TIDAK didaftarkan — satu fitur satu pemilik. */
  registerEffectUpdaters(opts: {
    look: LookParameterData[];
    breath: BreathParameterData[];
    enabled?: { blink?: boolean; look?: boolean; breath?: boolean };
  }): void {
    const en = { blink: true, look: true, breath: true, ...(opts.enabled ?? {}) };
    if (this._eyeBlink && en.blink) {
      // Kedip mundur otomatis saat motion menganimasikan param frame itu
      // (callback resmi _motionUpdated) atau saat gate ditutup.
      this.updateScheduler.addUpdatableList(
        new CubismEyeBlinkUpdater(
          () => this._motionUpdated || !(this.blinkGate?.() ?? true),
          this._eyeBlink,
        ),
      );
    }
    this.updateScheduler.addUpdatableList(
      new CubismExpressionUpdater(this._expressionManager),
    );
    if (en.look) {
      this._look = CubismLook.create();
      if (opts.look.length) this._look.setParameters(opts.look);
      // Gaze aditif; target di-ease CubismTargetPoint.
      this.updateScheduler.addUpdatableList(
        new GatedUpdater(
          new CubismLookUpdater(this._look, this._dragManager),
          () => this.lookGate?.() ?? true,
          CubismUpdateOrder.CubismUpdateOrder_Drag,
        ),
      );
    }
    if (en.breath) {
      this._breath = CubismBreath.create();
      if (opts.breath.length) this._breath.setParameters(opts.breath);
      // Napas aditif di atas motion; gate menahan saat frozen / motion
      // layer membawa kurva breath sendiri.
      this.updateScheduler.addUpdatableList(
        new GatedUpdater(
          new CubismBreathUpdater(this._breath),
          () => this.breathGate?.() ?? true,
          CubismUpdateOrder.CubismUpdateOrder_Breath,
        ),
      );
    }
    if (this._physics) {
      this.updateScheduler.addUpdatableList(new CubismPhysicsUpdater(this._physics));
    }
    if (this._pose) {
      this.updateScheduler.addUpdatableList(new CubismPoseUpdater(this._pose));
    }
    this.updateScheduler.sortUpdatableList();
  }

  /** Settle simulasi fisika seketika (panggil sekali setelah load /
   * setelah teleport pose) — tanpa ini rambut/ekor berayun liar detik awal. */
  stabilizePhysics(): void {
    const model = this.getModel();
    if (model && this._physics) this._physics.stabilization(model);
  }

  /** Id parameter yang jadi INPUT physics (source.id tiap input di rig).
   * Physics.evaluate() (order 600) MEMBACA nilai id ini dari model; tulisan
   * manual yang di-flush di order 900 dibaca satu frame terlambat DAN —
   * karena saveParameters() mendahului scheduler — tak pernah sampai, jadi
   * memindah param input tidak pernah memicu ayunan. Pemanggil memakai set
   * ini untuk mem-flush tulisan input SEBELUM physics (order < 600). Kosong
   * bila model tanpa physics. */
  getPhysicsInputParamIds(): string[] {
    const rig = (this._physics as any)?._physicsRig;
    const inputs = rig?.inputs;
    if (!inputs || !inputs.length) return [];
    const out: string[] = [];
    for (const inp of inputs) {
      const id = inp?.source?.id?.getString?.();
      if (id) out.push(id);
    }
    return out;
  }

  /** Pipeline dua fase resmi — dipanggil tiap frame sebelum draw. */
  update(dtSeconds: number): void {
    const model = this.getModel();
    if (!model) return;
    // Kurva klip yang main direkam SEBELUM updateMotion — entri yang selesai
    // dihapus di dalamnya. Isinya dipakai saat window play berakhir untuk
    // melepas baseline kembali ke default model (pelepasan kepemilikan).
    if (!this._motionManager.isFinished()) {
      collectMotionCurveIds(
        this._motionManager.getCubismMotionQueueEntries(),
        CURVE_TARGET_PARAMETER,
        this._playCurveIds,
      );
    }
    model.loadParameters();
    this._motionUpdated = false;
    // updateMotion dipanggil TANPA syarat: reset _currentPriority hidup di
    // ekornya. Jalur lama (isFinished → skip updateMotion) membuat prioritas
    // motion terakhir "lengket" selamanya — reserveMotion menolak semua play
    // sesama band, akar "klip native cuma bisa diputar sekali".
    this._motionUpdated = this._motionManager.updateMotion(model, dtSeconds);
    const finishedNow = this._motionManager.isFinished();
    if (this._wasMotionPlaying && finishedNow) this._beginBaselineRelease(model);
    this._wasMotionPlaying = !finishedNow;
    if (finishedNow) {
      // Tulis SEBELUM saveParameters supaya baseline-nya ikut pulang (bukan
      // tulisan frame-transien yang dibuang loadParameters berikutnya).
      this._applyBaselineRelease(model, dtSeconds);
    } else {
      // Motion baru masuk → pelepasan yang berjalan dibatalkan; motion yang
      // memegang param itu lagi adalah pemilik sah barunya.
      this._baselineRelease = null;
    }
    if (finishedNow && this.autoIdle) {
      this.startIdleIfAvailable();
    }
    model.saveParameters();
    this.updateScheduler.onLateUpdate(model, dtSeconds);
    model.update();
  }

  /** Awali pelepasan baseline: param kurva window play terakhir di-ease ke
   * default model selama BASELINE_RELEASE_MS. Tanpa ini pose terakhir klip
   * tertahan selamanya di buffer saveParameters — sistem aditif (gaze/
   * liveliness/breath) hanya menulis offset di atasnya dan Core meng-clamp
   * hasilnya ke range param, jadi bagian yang dianimasikan klip tampak
   * beku/kaku setelah klip selesai. */
  private _beginBaselineRelease(model: CubismModel): void {
    this._baselineRelease = null;
    const core = (model as any)._model;
    const defaults = core?.parameters?.defaultValues;
    if (!defaults) {
      this._playCurveIds.clear();
      return;
    }
    const plan = planBaselineRelease(
      this._playCurveIds,
      (id) => model.getParameterIndex(id),
      () => model.getParameterCount(),
      (i) => model.getParameterValueByIndex(i),
      (i) => Number(defaults[i]),
    );
    this._playCurveIds.clear();
    if (plan) this._baselineRelease = { plan, elapsedMs: 0 };
  }

  private _applyBaselineRelease(model: CubismModel, dtSeconds: number): void {
    const rel = this._baselineRelease;
    if (!rel) return;
    rel.elapsedMs += dtSeconds * 1000;
    const k = Math.min(1, rel.elapsedMs / BASELINE_RELEASE_MS);
    applyBaselineRelease(rel.plan, k, (i, v) => model.setParameterValueByIndex(i, v, 1));
    if (k >= 1) this._baselineRelease = null;
  }

  /** Grup "Idle" dicari by-name dari manifest; model tanpa grup ini
   * dibiarkan diam (pose + efek saja) — tidak ada nama grup yang dipaksakan. */
  private startIdleIfAvailable(): void {
    const s = this._setting;
    if (!s) return;
    for (let i = 0; i < s.getMotionGroupCount(); i++) {
      if (s.getMotionGroupName(i) !== "Idle") continue;
      const count = s.getMotionCount("Idle");
      if (count > 0) {
        const idx = Math.floor(Math.random() * count);
        void this.startMotionGroup("Idle", idx, MotionPriority.Idle);
      }
      return;
    }
  }

  /** Putar motion native: lazy-fetch per manifest, cache milik model,
   * protokol prioritas resmi (reserveMotion → startMotionPriority).
   * Return -1 = kalah prioritas / grup tidak ada / gagal load (reservasi
   * sudah direset); 1 = motion masuk antrean. (Port vendored mengembalikan
   * objek CubismMotionQueueEntry dari startMotionPriority — kontrak adapter
   * diratakan jadi angka; polling per-entry belum dibutuhkan.) */
  async startMotionGroup(
    group: string,
    index: number,
    priority: number,
  ): Promise<number> {
    const s = this._setting;
    if (!s) return -1;
    let known = false;
    for (let i = 0; i < s.getMotionGroupCount(); i++) {
      if (s.getMotionGroupName(i) === group) {
        known = true;
        break;
      }
    }
    if (!known) {
      console.warn(`[Live2DUserModel] grup motion "${group}" tidak ada di manifest`);
      return -1;
    }
    if (index < 0 || index >= s.getMotionCount(group)) return -1;
    // Paritas spesifikasi motion (§12): motion band sama MENGGANTIKAN yang
    // sedang main, bukan ditolak. Klip native kerap Meta.Loop=true — tidak
    // pernah isFinished sehingga _currentPriority tidak pernah reset sendiri;
    // tanpa ini satu klip loop mengunci semua play sesama band selamanya
    // (dan auto-idle tak pernah kembali setelahnya). Force tetap lewat
    // jalur resminya; band lebih rendah tetap ditolak reserveMotion.
    const sameBand =
      priority !== MotionPriority.Force &&
      priority === this._motionManager.getCurrentPriority();
    if (
      priority !== MotionPriority.Force &&
      !sameBand &&
      !this._motionManager.reserveMotion(priority)
    ) {
      return -1;
    }
    if (priority === MotionPriority.Force) {
      this._motionManager.setReservePriority(priority);
    }
    const key = `${group}_${index}`;
    let motion = this._motionCache.get(key);
    if (!motion) {
      const file = s.getMotionFileName(group, index);
      if (!file) {
        this._motionManager.setReservePriority(MotionPriority.None);
        return -1;
      }
      let buf: ArrayBuffer;
      try {
        const res = await fetch(this._baseUrl + file);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buf = await res.arrayBuffer();
      } catch (e) {
        console.warn(`[Live2DUserModel] fetch motion ${file} gagal`, e);
        this._motionManager.setReservePriority(MotionPriority.None);
        return -1;
      }
      motion = this.loadMotion(buf, buf.byteLength, key, undefined, undefined, s, group, index);
      if (!motion) {
        this._motionManager.setReservePriority(MotionPriority.None);
        return -1;
      }
      // beri tahu motion kurva mana milik blink/lipsync supaya auto-blink
      // berdiri turun saat motion menganimasikan mata
      motion.setEffectIds(this._eyeBlinkIds, this._lipSyncIds);
      this._motionCache.set(key, motion);
    }
    const started = this._motionManager.startMotionPriority(motion, false, priority);
    return started ? 1 : -1;
  }

  /** Hentikan semua motion native (fade-out anggun oleh queue manager).
   * Dipakai app.js untuk klip Meta.Loop setelah clipUntil habis — framework
   * tidak mengenal konsep clipUntil app, klip loop tidak pernah selesai
   * sendiri sehingga auto-idle tidak bisa masuk. _currentPriority ikut reset
   * otomatis: updateMotion me-reset saat isFinished setelah antrean kosong. */
  stopNativeMotions(): void {
    this._motionManager.stopAllMotions();
    this._motionManager.setReservePriority(MotionPriority.None);
  }

  /** Putar ekspresi by-name dari manifest. 5-r.5: ekspresi TANPA prioritas —
   * startMotion baru akan cross-fade menimpa yang lama. Return false bila
   * nama tidak ada di manifest / gagal load. */
  async playExpression(name: string): Promise<boolean> {
    const s = this._setting;
    if (!s) return false;
    let file: string | null = null;
    for (let i = 0; i < s.getExpressionCount(); i++) {
      if (s.getExpressionName(i) === name) {
        file = s.getExpressionFileName(i);
        break;
      }
    }
    if (!file) return false;
    let expr = this._expressionCache.get(name);
    if (!expr) {
      let buf: ArrayBuffer;
      try {
        const res = await fetch(this._baseUrl + file);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buf = await res.arrayBuffer();
      } catch (e) {
        console.warn(`[Live2DUserModel] fetch ekspresi ${file} gagal`, e);
        return false;
      }
      expr = this.loadExpression(buf, buf.byteLength, name);
      if (!expr) return false;
      this._expressionCache.set(name, expr);
    }
    // autoDelete=false: cache milik model, dihapus eksplisit saat dispose.
    this._expressionManager.startMotion(expr, false);
    return true;
  }

  /** Target look/gaze (view coords ±1) — di-ease CubismTargetPoint. */
  setLookTarget(x: number, y: number): void {
    this.setDragging(x, y);
  }

  /** Teardown lengkap: cache motion/ekspresi dihapus eksplisit (Core-side
   * tidak di-GC), scheduler dilepas, baru rantai release() base dijalankan. */
  dispose(): void {
    for (const m of this._motionCache.values()) ACubismMotion.delete(m);
    this._motionCache.clear();
    for (const e of this._expressionCache.values()) ACubismMotion.delete(e);
    this._expressionCache.clear();
    if (this._look) {
      CubismLook.delete(this._look);
      this._look = null;
    }
    this.updateScheduler.release();
    this.release();
  }
}
