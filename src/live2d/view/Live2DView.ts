/**
 * Live2DView — satu-satunya jalur render: Pixi 8 + Cubism 5-r.5 di atas
 * canvas panggung; dipakai app utama dan pet.html.
 *
 * Pembagian kepemilikan: framework memutar motion/ekspresi/physics/pose dan
 * efek blink/breath/gaze/lipsync (updater ber-gate di Live2DUserModel);
 * app.js menyumbang komposisi jiwa secara ADITIF (liveliness, emosi, raw
 * drive) lewat backend coreModel di file ini, di-flush updater order 900 —
 * setelah semua efek framework, sebelum model.update.
 *
 * Gaze kursor masuk lewat setLookTarget (CubismTargetPoint); target & gate
 * (blink/breath/look/lipsync) dipasang app.js sesuai konfigurasi per-model.
 */
import * as PIXI from "pixi.js";
import { Live2DRenderer } from "../Live2DRenderer";
import { Live2DUserModel, MotionPriority } from "../Live2DUserModel";
import { ICubismUpdater, CubismUpdateOrder } from "../cubism/motion/icubismupdater";
import type { CubismModel } from "../cubism/model/cubismmodel";
import { CubismFramework } from "../cubism/live2dcubismframework";
import {
  computeModelMvp,
  localToScreen,
  screenToLocal,
  type FacadeTransform,
} from "./framing";

/** Satuan px CSS per unit canvas — konstanta bebas: frameModel app.js
 * menyetel scale agar model pas stage, jadi nilai ini terkompensasi. */
const MODEL_UNIT_PX = 400;

/** Flush tulisan app.js tiap frame SETELAH semua efek framework: SET dulu
 * (pose absolut brain/motion-layer), lalu ADD (offset liveliness di atas
 * motion + gaze framework).
 *
 * Pengecualian param INPUT physics: nilainya di-flush lebih awal oleh
 * AppWriteInputUpdater (order < 600) supaya CubismPhysics.evaluate() bereaksi
 * di frame yang sama; entri itu di-consume di sana agar tak dobel-tulis. */
class AppWriteUpdater extends ICubismUpdater {
  private pending = new Map<string, { v: number; w: number }>();
  private pendingAdd = new Map<string, { v: number; w: number }>();
  /** Cache id handle per string — getId membangun CubismId bila belum ada;
   * tanpa cache tiap poke app.js melewatinya tiap frame. */
  private ids = new Map<string, unknown>();
  /** Id parameter INPUT physics (source.id rig) — di-set ulang tiap loadModel;
   * kosong = model tanpa physics (semua tulisan lewat jalur order 900 biasa). */
  physicsInputIds: Set<string> = new Set();

  constructor() {
    super(900);
  }

  /** backend coreModel app.js — satu-satunya pintu tulis dari legacy. */
  readonly coreModel = {
    setParameterValueById: (id: string, v: number, w = 1) => {
      this.pending.set(id, { v, w });
    },
    addParameterValueById: (id: string, v: number, w = 1) => {
      this.pendingAdd.set(id, { v, w });
    },
    getParameterValueById: (_id: string) => 0, // di-overview Live2DView (butuh renderer)
    setPartOpacityById: (_id: string, _v: number) => {}, // idem
    getModel: () => null, // idem
  };

  /** Buang sisa tulisan model lama — wajib dipanggil tiap ganti model supaya
   * poke untuk id model sebelumnya tidak bocor ke model baru. */
  resetPending(): void {
    this.pending.clear();
    this.pendingAdd.clear();
  }

  private idOf(idMgr: any, id: string): any {
    let h: any = this.ids.get(id);
    if (!h) {
      h = idMgr.getId(id);
      this.ids.set(id, h);
    }
    return h;
  }

  /** Pass pra-physics: terapkan & CONSUME tulisan untuk param INPUT physics
   * saja, dipanggil dari AppWriteInputUpdater di order < 600. Consume (delete)
   * wajib supaya flush order 900 tidak menerapkan ADD input dua kali. */
  flushInputs(model: CubismModel): void {
    if (!this.physicsInputIds.size) return;
    if (!this.pending.size && !this.pendingAdd.size) return;
    const idMgr = CubismFramework.getIdManager();
    for (const [id, { v, w }] of this.pending) {
      if (!this.physicsInputIds.has(id)) continue;
      model.setParameterValueById(this.idOf(idMgr, id), v, w);
      this.pending.delete(id);
    }
    for (const [id, { v, w }] of this.pendingAdd) {
      if (!this.physicsInputIds.has(id)) continue;
      model.addParameterValueById(this.idOf(idMgr, id), v, w);
      this.pendingAdd.delete(id);
    }
  }

  onLateUpdate(model: CubismModel, _dt: number): void {
    if (!this.pending.size && !this.pendingAdd.size) return;
    const idMgr = CubismFramework.getIdManager();
    // SET dulu (pose absolut brain/motion-layer), lalu ADD (offset
    // liveliness di atas motion + gaze framework).
    for (const [id, { v, w }] of this.pending) {
      model.setParameterValueById(this.idOf(idMgr, id), v, w);
    }
    this.pending.clear();
    for (const [id, { v, w }] of this.pendingAdd) {
      model.addParameterValueById(this.idOf(idMgr, id), v, w);
    }
    this.pendingAdd.clear();
  }
}

/** Companion AppWriteUpdater: flush tulisan app.js untuk param INPUT physics
 * TEPAT sebelum Physics(600) supaya simulasi pendulum bereaksi terhadap
 * param yang dipindah di frame yang sama. Order antara Breath(500) dan
 * Physics(600); model tanpa physics → no-op. */
class AppWriteInputUpdater extends ICubismUpdater {
  constructor(private parent: AppWriteUpdater) {
    super(CubismUpdateOrder.CubismUpdateOrder_Physics - 10);
  }
  onLateUpdate(model: CubismModel, _dt: number): void {
    this.parent.flushInputs(model);
  }
}

export class Live2DView {
  pixiApp: PIXI.Application | null = null;
  renderer: Live2DRenderer | null = null;
  private writes = new AppWriteUpdater();
  private writesInput = new AppWriteInputUpdater(this.writes);
  private facade: any = null;
  private transform: FacadeTransform | null = null;
  private rafId: number | null = null;
  private initPromise: Promise<void> | null = null;
  /** Gate kedip — diputuskan app.js (blinkEnabled + frozen). */
  private blinkGate: (() => boolean) | null = null;
  /** Gate breath — diputuskan app.js (hasBreath + frozen + motion layer). */
  private breathGate: (() => boolean) | null = null;
  /** Gate gaze — diputuskan app.js (aiLock + frozen + motion layer). */
  private lookGate: (() => boolean) | null = null;

  /** Pasang gate kedip; null = selalu kedip. */
  setBlinkGate(fn: (() => boolean) | null): void {
    this.blinkGate = fn;
    const um = (this.renderer as any)?.userModel as Live2DUserModel | undefined;
    if (um) um.blinkGate = fn;
  }

  /** Pasang gate breath (hasBreath/frozen/motion-layer). */
  setBreathGate(fn: (() => boolean) | null): void {
    this.breathGate = fn;
    const um = (this.renderer as any)?.userModel as Live2DUserModel | undefined;
    if (um) um.breathGate = fn;
  }

  /** Pasang gate gaze (aiLock/frozen/motion-layer). */
  setLookGate(fn: (() => boolean) | null): void {
    this.lookGate = fn;
    const um = (this.renderer as any)?.userModel as Live2DUserModel | undefined;
    if (um) um.lookGate = fn;
  }

  setLookTarget(x: number, y: number): void {
    this.renderer?.setLookTarget(x, y);
  }

  /** Gain keekspresivan gaze per grup sendi (kepala/mata/badan), 0..2. */
  setGazeGain(gain: { head?: number; eyes?: number; body?: number } | null | undefined): void {
    this.renderer?.setGazeGain(gain);
  }

  /** Override role user (sheet v5 probeApprovals): rebuild peta role runtime
   * tanpa re-load model — dipanggil app.js saat sheet termuat / approval baru. */
  setRoleOverrides(overrides: Record<string, string> | null | undefined): void {
    this.renderer?.setRoleOverrides(overrides);
  }

  /** Pasang penyedia lipsync 0..1 (sumber audio tetap di app.js). */
  setLipsyncProvider(fn: (() => number | null) | null): void {
    const um = (this.renderer as any)?.userModel as Live2DUserModel | undefined;
    if (um) um.lipsyncProvider = fn;
  }

  /** Miliki canvas panggung: Pixi 8 Application di atas #live2d-canvas
   * (transparan — latar dari CSS #stage; alpha context dipertahankan
   * untuk blend Atop/Out moc3 v6, pelajaran patchCore6Compat lama). */
  async init(canvas: HTMLCanvasElement, cssW: number, cssH: number): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const resolution = Math.min(window.devicePixelRatio || 1, 2);
      const pixiApp = new PIXI.Application();
      await pixiApp.init({
        canvas,
        width: cssW,
        height: cssH,
        backgroundAlpha: 0,
        antialias: true,
        resolution,
        autoDensity: true,
        preference: "webgl",
        // OBS Browser Source & alat capture membaca drawing buffer DI LUAR
        // siklus frame. Dengan preserveDrawingBuffer=false, WebGL mengembalikan
        // buffer yang di-auto-clear ke gl.clearColor saat itu — dan clearColor
        // tersisa PUTIH dari clear buffer mask Cubism (renderer_webgl:220 dst).
        // Akibatnya overlay tampak putih buram di OBS walau on-screen transparan.
        // preserveDrawingBuffer=true → buffer yang dibaca = frame yang digambar
        // (transparan + model). Wajib untuk transparansi overlay.
        preserveDrawingBuffer: true,
      });
      this.pixiApp = pixiApp;
      const gl = (canvas.getContext("webgl2") || canvas.getContext("webgl")) as WebGL2RenderingContext;
      this.renderer = new Live2DRenderer(canvas, gl);
      // latar dari CSS stage — Cubism tidak clear
      this.renderer.setClear(null);
      // Jembatan state GL setelah Cubism menggambar. drawModel memutasi GL
      // (blend/frontFace/colorMask/program/VAO) dan mesin state Pixi 8 murni
      // cache — TIDAK pernah glGet — jadi tanpa reset cache-nya basi. Jalur
      // saveProfile/restoreProfile framework (±15 glGet) menciptakan
      // sinkronisasi CPU–GPU paksa tiap frame tepat setelah antrean GPU penuh
      // drawModel — TERUKUR ±40 ms/frame (26 FPS vs 60 FPS stack lama).
      // Reset di sini = GL-set murni (tanpa glGet) + pembatalan cache Pixi:
      // stateId=0 memaksa state.set() berikutnya menerbitkan ulang semua bit
      // enable/disable, blendMode="" memaksa blendFunc, _blendEq memaksa
      // blendEquation — Pixi mengembalikan state yang ia butuhkan sendiri.
      this.renderer.setPixiStateReset(() => {
        gl.colorMask(true, true, true, true);
        gl.depthMask(true);
        gl.frontFace(gl.CCW);
        gl.activeTexture(gl.TEXTURE0);
        // Buffer mask Cubism meninggalkan clearColor PUTIH (renderer_webgl:220).
        // Kembalikan ke transparan tiap frame: bila alat capture (OBS/screenshot)
        // membaca buffer di luar frame, auto-clear-nya transparan, bukan putih.
        gl.clearColor(0, 0, 0, 0);
        const st = (pixiApp.renderer as any).state;
        if (st) {
          st.stateId = 0;
          st.blendMode = "";
          st._glFrontFace = false;
          st._frontFaceDirty = false;
          st._blendEq = true;
        }
      });
      const draw = () => {
        this.renderer?.draw();
        this.rafId = requestAnimationFrame(draw);
      };
      // riset: build ESM Pixi 8 minimal tanpa TickerPlugin — guard + rAF sendiri.
      // Prioritas ticker WAJIB di bawah render Pixi (LOW=-25): draw Cubism
      // harus SETELAH clear Pixi — bila tidak, render Pixi menghapus hasilnya
      // tiap frame (canvas tampak kosong). rAF fallback otomatis aman
      // karena selalu berjalan setelah ticker.
      if (pixiApp?.ticker && typeof pixiApp.ticker.add === "function") {
        pixiApp.ticker.add(() => this.renderer?.draw(), null, -50);
      } else {
        this.rafId = requestAnimationFrame(draw);
      }
    })();
    return this.initPromise;
  }

  async loadModel(modelPath: string, adoptedManifest?: unknown): Promise<any> {
    if (!this.renderer) throw new Error("Live2DView belum init");
    const prev = this.facade;
    if (prev?.destroy) { try { prev.destroy(); } catch {} }
    this.facade = null;

    await this.renderer.loadModel(modelPath, {
      // Semua efek diputar framework; gate runtime dipasang app.js.
      // autoIdle=false: app.js startIdleMotion pemilik idle.
      effects: { blink: true, look: true, breath: true },
      autoIdle: false,
      // Manifest adopsi exp3 dari app.js bila ada; null = manifest asli.
      adoptedManifest,
    });

    const userModel = (this.renderer as any).userModel as Live2DUserModel;
    userModel.blinkGate = this.blinkGate;
    userModel.breathGate = this.breathGate;
    userModel.lookGate = this.lookGate;
    // Scheduler dibuat BARU tiap loadModel (userModel baru di
    // Live2DRenderer.loadModel) — updater tulisan wajib didaftar ulang tiap
    // load. Guard lama (__writesRegistered di renderer) membuat poke app.js
    // mati diam-diam setelah ganti model: pending tak pernah dikonsumsi dan
    // flush pra-physics ikut mati.
    this.writes.resetPending();
    userModel.updateScheduler.addUpdatableList(this.writes);
    // Pass pra-physics (order < 600) untuk param INPUT physics — lockstep
    // dengan this.writes: keduanya masuk scheduler yang sama.
    userModel.updateScheduler.addUpdatableList(this.writesInput);
    userModel.updateScheduler.sortUpdatableList();
    // Set id input physics tiap load (userModel + physics baru tiap loadModel).
    this.writes.physicsInputIds = new Set(userModel.getPhysicsInputParamIds());

    const info = this.renderer.getModelCanvasSize();
    const groups = this.renderer.getOfficialGroups();
    const profile = this.renderer.getModelProfile();
    const t: FacadeTransform = {
      x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0,
      anchorX: 0, anchorY: 0,
      origW: MODEL_UNIT_PX * info.width,
      origH: MODEL_UNIT_PX * info.height,
      canvasW: info.width, canvasH: info.height,
      stageW: this.pixiApp!.screen.width,
      stageH: this.pixiApp!.screen.height,
      resolution: this.pixiApp!.renderer.resolution,
    };
    this.transform = t;
    this.renderer.setMvpProvider(() => computeModelMvp(this.transform!));

    // backend untuk coreModel() app.js
    const renderer = this.renderer;
    const self = this;
    const backend = {
      setParameterValueById(id: string, v: number, w = 1) {
        self.writes.coreModel.setParameterValueById(id, v, w);
      },
      addParameterValueById(id: string, v: number, w = 1) {
        self.writes.coreModel.addParameterValueById(id, v, w);
      },
      getParameterValueById(id: string) {
        return renderer.getParameter(id) ?? 0;
      },
      setPartOpacityById(id: string, v: number) {
        const m = (renderer as any).userModel?.getModel() as any;
        if (!m) return;
        try {
          const h = CubismFramework.getIdManager().getId(id);
          const idx = m.getPartIndex?.(h);
          if (idx != null && idx >= 0) m.setPartOpacityByIndex?.(idx, v);
        } catch (e) {}
      },
      getModel() {
        const m = (renderer as any).userModel?.getModel() as any;
        if (!m) return null;
        const partCount = () => m.getPartCount?.() ?? 0;
        return {
          // API part — enumerateParts app.js (sheet/inspeksi)
          getPartCount: partCount,
          getPartIds: () => {
            const n = partCount();
            const out: string[] = [];
            for (let i = 0; i < n; i++) out.push(m.getPartId?.(i)?.getString?.() ?? "");
            return out;
          },
          getPartOpacityByIndex: (i: number) => m.getPartOpacityByIndex?.(i) ?? 1,
          // API parameter — detectModelCapabilities app.js: roleMap (via
          // m.getParameterIds jalur resmi) + paramRange (min/max/def per id).
          // getParameterId wajib mengembalikan STRING — itu kunci paramRange.
          getParameterCount: () => m.getParameterCount?.() ?? 0,
          getParameterId: (i: number) => m.getParameterId?.(i)?.getString?.() ?? "",
          // Wajib ada: inspectModel app.js (cabang "wrapper-accessors") butuh
          // daftar id plural — tanpa ini semua param ter-skip saat inspeksi dan
          // sheet jatuh ke rentang tebakan -1..1 (slider panel param jadi
          // hampir tak berpengaruh pada rig ber-range lebar, mis. ±30).
          getParameterIds: () => {
            const n = m.getParameterCount?.() ?? 0;
            const out: string[] = [];
            for (let i = 0; i < n; i++)
              out.push(m.getParameterId?.(i)?.getString?.() ?? "");
            return out;
          },
          getParameterMinimumValue: (i: number) => m.getParameterMinimumValue?.(i) ?? 0,
          getParameterMaximumValue: (i: number) => m.getParameterMaximumValue?.(i) ?? 0,
          getParameterDefaultValue: (i: number) => m.getParameterDefaultValue?.(i) ?? 0,
        };
      },
    };

    const exprDefs = (profile?.expressions ?? []).map((name) => ({
      Name: name, File: `expressions/${name}.exp3.json`,
    }));
    const motionDefs: Record<string, unknown[]> = {};
    for (const g of profile?.motions ?? []) motionDefs[g.group] = new Array(g.count).fill({});

    const facade = {
      get x() { return t.x }, set x(v: number) { t.x = v },
      get y() { return t.y }, set y(v: number) { t.y = v },
      get rotation() { return t.rotation }, set rotation(v: number) { t.rotation = v },
      get zIndex() { return 0 }, set zIndex(_: number) {},
      get width() { return t.origW * t.scaleX },
      get height() { return t.origH * t.scaleY },
      scale: {
        get x() { return t.scaleX }, set x(v: number) { t.scaleX = v },
        get y() { return t.scaleY }, set y(v: number) { t.scaleY = v },
        set(v: number) { t.scaleX = v; t.scaleY = v; },
      },
      anchor: {
        get x() { return t.anchorX }, set x(v: number) { t.anchorX = v },
        get y() { return t.anchorY }, set y(v: number) { t.anchorY = v },
        set(x: number, y: number) { t.anchorX = x; t.anchorY = y; },
      },
      toGlobal(p: { x: number; y: number }) {
        return localToScreen(t, p.x, p.y);
      },
      /** Padanan toLocal pixi — zoom-anchored app.js (setScaleAroundPoint)
       * wajib memilikinya; tanpa ini zoom jatuh ke jalur fallback yang
       * center-kan seluruh box ke kursor tiap tick → melompat. */
      toLocal(p: { x: number; y: number }) {
        return screenToLocal(t, p.x, p.y);
      },
      /** AABB dunia (CSS) dari 4 pojok box lokal — padanan getBounds pixi
       * untuk frameModel/applyStageLayout (natW/natH = bounds / scale). */
      getBounds() {
        const pts = [
          localToScreen(t, 0, 0),
          localToScreen(t, t.origW, 0),
          localToScreen(t, t.origW, t.origH),
          localToScreen(t, 0, t.origH),
        ];
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
      },
      /** Jalur resmi #1 detectModelCapabilities (capProbe "pixi-api"):
       * daftar id parameter sebagai string[]. */
      getParameterIds() {
        return renderer.getParameters();
      },
      /** prioritas lama 1/2/3 = Idle/Normal/Force; index -1 = acak grup. */
      motion(group: string, index: number, priority: number): void {
        const prio = priority >= 3 ? MotionPriority.Force : priority >= 2 ? MotionPriority.Normal : MotionPriority.Idle;
        const cnt = (motionDefs[group] || []).length;
        const idx = index < 0 ? Math.floor(Math.random() * cnt) : index;
        void renderer.playNativeMotion(group, Math.max(0, idx), prio)
          .then((h) => { if (h < 0) console.warn(`[view] motion ${group} tidak jalan (prioritas/grup)`); });
      },
      async expression(name: string): Promise<boolean> {
        return renderer.playExpression(name);
      },
      /** Hentikan motion native — klip Meta.Loop tidak pernah isFinished
       * sendiri, app.js memanggil ini saat clipUntil klip loop habis supaya
       * auto-idle bisa masuk kembali. */
      stopMotions(): void {
        renderer.stopNativeMotions();
      },
      expressions: exprDefs,
      destroy() { self.destroyModel(); },
      internalModel: {
        coreModel: backend,
        // startIdleMotion app.js hanya Object.keys(definitions)
        motionManager: {
          definitions: motionDefs,
          // jalur freeze app.js (frozen state) memanggil stopAllMotions()
          stopAllMotions: () => renderer.stopNativeMotions(),
          expressionManager: { definitions: exprDefs },
        },
        settings: {
          expressions: exprDefs,
          getLipSyncParameters: () => groups.lipSyncIds,
          getEyeBlinkParameters: () => groups.eyeBlinkIds,
        },
        eyeBlinkIds: groups.eyeBlinkIds,
        lipSyncIds: groups.lipSyncIds,
        focusController: { x: 0, y: 0 },
        // `on` sengaja tidak ada: installOverrideGuard dilewati — padanannya
        // (re-tulis sticky tiap frame setelah framework) = AppWriteUpdater.
      },
    };
    this.facade = facade;
    return facade;
  }

  destroyModel(): void {
    // rAF loop TIDAK dibatalkan: ganti model menghancurkan model lama lalu
    // loadModel baru — loop menunggu (draw() early-return saat userModel null).
    this.renderer?.destroy();
  }

  resize(w: number, h: number): void {
    this.pixiApp?.renderer.resize(w, h);
    if (this.transform) {
      this.transform.stageW = this.pixiApp!.screen.width;
      this.transform.stageH = this.pixiApp!.screen.height;
    }
  }

  setBackground(hex: number): void {
    const bg: any = (this.pixiApp?.renderer as any)?.background;
    if (bg) bg.color = hex;
  }
}
