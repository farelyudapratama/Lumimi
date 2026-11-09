/** Renderer: Pixi 8 WebGL + Cubism Framework 5-r.5 (Core 6.0.1).
 * Koreksi sesuai pola resmi: pipeline update dua fase di Live2DUserModel,
 * save/restore GL di sekitar drawModel (drawModel tidak mengembalikan state
 * host), frame process offscreen manager untuk model blend-enabled, shader
 * load asinkron cukup diatasi dengan terus menggambar (frame hitam awal
 * adalah by design), dan FBO default di-capture sekali untuk setRenderState. */
import { CubismFramework } from "./cubism/live2dcubismframework";
import { CubismUserModel } from "./cubism/model/cubismusermodel";
import { CubismModelSettingJson } from "./cubism/cubismmodelsettingjson";
import { CubismMatrix44 } from "./cubism/math/cubismmatrix44";
import { CubismModelMatrix } from "./cubism/math/cubismmodelmatrix";
import { CubismWebGLOffscreenManager } from "./cubism/rendering/cubismoffscreenmanager";
import type { CubismRenderer_WebGL } from "./cubism/rendering/cubismrenderer_webgl";
import { LookParameterData } from "./cubism/effect/cubismlook";
import { BreathParameterData } from "./cubism/effect/cubismbreath";
import { ParameterController, type ParamInfo } from "./ParameterController";
import { inspectModel, type ModelProfile } from "./ModelInspector";
import { RoleController } from "./RoleController";
import { ParameterArbiter, type SourceId } from "./ParameterArbiter";
import { ArbiterUpdater } from "./ArbiterUpdater";
import { CubismUpdateOrder } from "./cubism/motion/icubismupdater";
import { Live2DUserModel, MotionPriority } from "./Live2DUserModel";

let frameworkStarted = false;
function ensureFramework() {
  if (frameworkStarted) return;
  CubismFramework.startUp({
    logFunction: (msg: string) => console.log("[CSM] " + msg),
    loggingLevel: 2 as any, // Info — cukup, Verbose terlalu berisik
  } as any);
  CubismFramework.initialize();
  frameworkStarted = true;
}

export class Live2DRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | WebGLRenderingContext;
  private userModel: Live2DUserModel | null = null;
  private setting: CubismModelSettingJson | null = null;
  private baseDir = "";
  private modelMatrix: CubismModelMatrix | null = null;
  private proj = new CubismMatrix44();
  private mvp = new CubismMatrix44();
  private shaderPath = "/shaders/cubism/WebGL/";
  private textures: WebGLTexture[] = [];
  private roleCtrl: RoleController | null = null;
  private arbiter = new ParameterArbiter();
  private officialGroups = { eyeBlinkIds: [] as string[], lipSyncIds: [] as string[] };
  private frameBuffer: WebGLFramebuffer | null = null;
  private lastFrameMs: number | null = null;
  private mvpProvider: (() => Float32Array) | null = null;
  private clearColor: [number, number, number, number] | null = [0.909, 0.909, 0.909, 1.0];
  /** View integrasi: reset state GL Pixi 8 setelah drawModel (GL-set murni,
   * tanpa glGet) — menggantikan saveProfile/restoreProfile yang memaksa
   * sinkronisasi CPU–GPU tiap frame. Null = jalur lama (halaman proof). */
  private pixiStateReset: (() => void) | null = null;
  /** Matriks MVP dipakai ulang — draw() berjalan tiap frame. */
  private mvpTmp = new CubismMatrix44();
  /** Controller parameter di-cache (wraps model — dibuat sekali per model). */
  private paramCtrl: ParameterController | null = null;
  /** Gain keekspresivan gaze per grup sendi (0..2; 1 = netral). */
  private gazeGain: { head: number; eyes: number; body: number } = { head: 1, eyes: 1, body: 1 };

  /** Integrasi view: mvp dihitung facade (x/y/scale/anchor → matriks),
   * bukan framing bawaan proof. Null = kembali framing proof. */
  setMvpProvider(fn: (() => Float32Array) | null): void {
    this.mvpProvider = fn;
  }

  /** Integrasi view: reset state GL Pixi setelah drawModel. Lihat catatan
   * Live2DView.init — saveProfile/restoreProfile (glGet storm) membuat
   * CPU menunggu GPU tiap frame. */
  setPixiStateReset(fn: (() => void) | null): void {
    this.pixiStateReset = fn;
  }

  /** Integrasi view: null = jangan clear (latar dari CSS #stage, canvas
   * transparan — proof pages tetap pakai clear abu untuk readPixels). */
  setClear(color: [number, number, number, number] | null): void {
    this.clearColor = color;
  }

  /** Ukuran canvas model (unit canvas Cubism) — dasar lebar/tinggi facade. */
  getModelCanvasSize(): { width: number; height: number } {
    return this.modelMatrix
      ? { width: this.canvasInfo.width, height: this.canvasInfo.height }
      : { width: 1, height: 1 };
  }
  private canvasInfo = { width: 1, height: 1 };

  constructor(canvas: HTMLCanvasElement, gl?: WebGL2RenderingContext | WebGLRenderingContext) {
    this.canvas = canvas;
    this.gl = (gl ?? (canvas.getContext("webgl2") as any) ?? canvas.getContext("webgl")!) as any;
    if (!this.gl) throw new Error("WebGL tidak tersedia");
    // FBO terikat saat ini (framebuffer default untuk konteks bersih) —
    // inilah yang dipass ke setRenderState tiap frame, bukan null mutlak.
    this.frameBuffer = this.gl.getParameter(this.gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    ensureFramework();
  }

  async loadModel(model3Path: string, opts?: {
    /** efek yang TIDAK didaftarkan — dipunyai driver app.js (integrasi view) */
    effects?: { blink?: boolean; look?: boolean; breath?: boolean };
    /** false = tanpa idle otomatis framework (app.js punya scheduler idle sendiri) */
    autoIdle?: boolean;
    /** Manifest adopsi .exp3 yatim dari buildModelSettings (hanya menambah
     * yang belum dideklarasikan rigger; aturan user>ai dan opt-out dipatuhi
     * di sana). Null = pakai manifest asli. Tidak pernah ditulis ke disk. */
    adoptedManifest?: unknown;
  }): Promise<{ mocVersion: number; drawable: number; offscreen: number }> {
    const res = await fetch(model3Path);
    if (!res.ok) throw new Error(`fetch model3 ${res.status} ${model3Path}`);
    let manifestBuf: ArrayBuffer;
    if (opts?.adoptedManifest && typeof opts.adoptedManifest === "object") {
      manifestBuf = new TextEncoder().encode(
        JSON.stringify(opts.adoptedManifest),
      ).buffer as ArrayBuffer;
    } else {
      manifestBuf = await res.arrayBuffer();
    }
    this.setting = new CubismModelSettingJson(manifestBuf, manifestBuf.byteLength);
    this.baseDir = model3Path.slice(0, model3Path.lastIndexOf("/") + 1);

    // moc
    const mocFile = this.setting.getModelFileName();
    const mocBuf = await (await fetch(this.baseDir + mocFile)).arrayBuffer();
    const core = (globalThis as any).Live2DCubismCore;
    const mocVersion = core
      ? core.Version.csmGetMocVersion(mocBuf, mocBuf.byteLength)
      : -1;

    this.userModel = new Live2DUserModel();
    this.paramCtrl = null; // model baru — controller lama basi
    // Arbiter hidup per-renderer: nilai sticky pose model lama tidak boleh
    // dibawa ke model baru (id param bisa sama, dan getParameter membaca
    // arbiter lebih dulu dari model).
    this.arbiter.clearAll();
    this.userModel.loadModel(mocBuf, false);

    // id grup resmi (EyeBlink/LipSync) — otoritatif soal keanggotaan,
    // dipilih by-name, tidak pernah by-indeks.
    const s: any = this.setting;
    const eyeBlinkIds: string[] = [];
    const lipSyncIds: string[] = [];
    const ec = s.getEyeBlinkParameterCount?.() ?? 0;
    for (let i = 0; i < ec; i++) eyeBlinkIds.push(s.getEyeBlinkParameterId(i).getString());
    const lc = s.getLipSyncParameterCount?.() ?? 0;
    for (let i = 0; i < lc; i++) lipSyncIds.push(s.getLipSyncParameterId(i).getString());
    this.officialGroups = { eyeBlinkIds: [...eyeBlinkIds], lipSyncIds: [...lipSyncIds] };
    this.userModel.attachSetting(this.setting, this.baseDir, eyeBlinkIds, lipSyncIds);

    // physics / pose
    let hasPhysics = false;
    let hasPose = false;
    const phys = this.setting.getPhysicsFileName();
    if (phys) {
      const b = await (await fetch(this.baseDir + phys)).arrayBuffer();
      this.userModel.loadPhysics(b, b.byteLength);
      hasPhysics = true;
    }
    const poseFile = this.setting.getPoseFileName();
    if (poseFile) {
      const b = await (await fetch(this.baseDir + poseFile)).arrayBuffer();
      this.userModel.loadPose(b, b.byteLength);
      hasPose = true;
    }

    // renderer — shader loadShaders() asinkron: drawModel memanggilnya
    // idempotent tiap frame, jadi cukup terus menggambar; frame awal hitam
    // by design (drawMeshWebGL early-return sampai isShaderLoaded).
    const w = this.canvas.width, h = this.canvas.height;
    this.userModel.createRenderer(w, h, 1);
    const renderer: any = this.userModel.getRenderer();
    renderer.setIsPremultipliedAlpha(true);
    renderer.startUp(this.gl);
    renderer.loadShaders(this.shaderPath);

    // textures — premultiplied (pasangan setIsPremultipliedAlpha(true)) +
    // mipmap seperti sample resmi. Via createImageBitmap: img.decode()
    // pernah diantre 94 dtk di webview sibuk-GPU (decoder starved oleh loop
    // render) — bitmap path decode-nya tidak lewat antrean itu.
    const texCount = this.setting.getTextureCount();
    for (let i = 0; i < texCount; i++) {
      const texPath = this.baseDir + this.setting.getTextureFileName(i);
      let source: ImageBitmap | HTMLImageElement;
      try {
        const res = await fetch(texPath);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${texPath}`);
        source = await createImageBitmap(await res.blob());
      } catch (e) {
        console.warn(`[Live2DRenderer] bitmap gagal ${texPath}, fallback <img>`, e);
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = texPath;
        try { await img.decode(); } catch (e2) { console.warn(`[Live2DRenderer] img decode gagal ${texPath}`, e2); }
        source = img;
      }
      const tex = this.gl.createTexture()!;
      this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
      this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, source);
      this.gl.generateMipmap(this.gl.TEXTURE_2D);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR_MIPMAP_LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
      const err = this.gl.getError();
      if (err) console.warn(`[Live2DRenderer] glError setelah tex ${i}: ${err}`);
      renderer.bindTexture(i, tex);
      this.textures.push(tex);
    }

    // model matrix + info canvas (untuk facade transform)
    const model = this.userModel.getModel();
    if (model) {
      this.canvasInfo = { width: model.getCanvasWidth(), height: model.getCanvasHeight() };
      this.modelMatrix = new CubismModelMatrix(model.getCanvasWidth(), model.getCanvasHeight());
    } else {
      this.modelMatrix = new CubismModelMatrix(1, 1);
    }
    this.userModel.autoIdle = opts?.autoIdle ?? true;

    const drawable = model?.getDrawableCount?.() ?? 0;
    const offscreen = (model as any)?.getOffscreenCount?.() ?? 0;

    // Bangun RoleController (model-agnostic)
    try {
      const paramSet = new Set<string>();
      const pc = model ? model.getParameterCount() : 0;
      for (let i = 0; i < pc; i++) paramSet.add(model!.getParameterId(i).getString());
      this.roleCtrl = new RoleController(model!, paramSet, { eyeBlinkIds, lipSyncIds });
      console.log(`[Live2DRenderer] role map`, this.roleCtrl.getRoleMap());
    } catch (e) { console.warn("[Live2DRenderer] role map gagal", e); }

    // Blink resmi dibangun dari grup EyeBlink manifest; rig tanpa grup
    // (mis. 面饼0) menghasilkan instance 0-id — isi dengan id mata dari
    // role mapping (model-agnostic, by-name). Deklarasi rigger menang.
    if (this.roleCtrl) {
      const fallbackIds: any[] = [];
      const idMgr = CubismFramework.getIdManager();
      for (const role of ["eyeLOpen", "eyeROpen"]) {
        const info = this.roleCtrl.roleInfo(role);
        if (info) fallbackIds.push(idMgr.getId(info.id));
      }
      this.userModel.ensureEyeBlink(fallbackIds);
    }

    // Daftarkan updater efek (blink/expr/look/breath/physics/pose) dengan
    // look & breath diskalakan dari range aktual model (role-space), lalu
    // arbiter sebagai updater manual order 900 — setelah semua efek.
    // View integrasi menonaktifkan blink/look/breath (driver app.js pemiliknya).
    this.userModel.registerEffectUpdaters({
      look: this.buildLookData(),
      breath: this.buildBreathData(),
      enabled: opts?.effects,
    });
    // Updater mulut dari provider; model tanpa role mulut tidak mendaftar.
    const mouth = this.roleCtrl?.roleInfo("mouthOpenY");
    if (mouth) {
      const idMgr = CubismFramework.getIdManager();
      this.userModel.registerLipsync(idMgr.getId(mouth.id), mouth.min, mouth.max);
    }
    this.userModel.updateScheduler.addUpdatableList(new ArbiterUpdater(this.arbiter));
    // Pass pra-physics: hanya param INPUT physics, order < 600 (Physics),
    // supaya role/pose manual yang menggerakkan input memicu pendulum.
    const physInputIds = this.userModel.getPhysicsInputParamIds();
    if (physInputIds.length) {
      this.userModel.updateScheduler.addUpdatableList(
        new ArbiterUpdater(
          this.arbiter,
          CubismUpdateOrder.CubismUpdateOrder_Physics - 10,
          new Set(physInputIds),
        ),
      );
    }
    this.userModel.updateScheduler.sortUpdatableList();
    if (hasPhysics) this.userModel.stabilizePhysics();

    return { mocVersion, drawable, offscreen };
  }

  /** Faktor look per sendi (±30 kepala, ±10 badan, ±1 bola mata; bodyAngleY
   * ±0,75 half-range) dikalikan gain keekspresivan grup saat build. */
  private buildLookData(): LookParameterData[] {
    const SPEC: Record<string, {
      stdHalf: number; fx: number; fy: number; fxy: number;
      group: "head" | "eyes" | "body";
    }> = {
      angleX: { stdHalf: 30, fx: 30, fy: 0, fxy: 0, group: "head" },
      angleY: { stdHalf: 30, fx: 0, fy: 30, fxy: 0, group: "head" },
      angleZ: { stdHalf: 30, fx: 0, fy: 0, fxy: -30, group: "head" },
      bodyAngleX: { stdHalf: 10, fx: 10, fy: 0, fxy: 0, group: "body" },
      bodyAngleY: { stdHalf: 10, fx: 0, fy: 7.5, fxy: 0, group: "body" },
      eyeBallX: { stdHalf: 1, fx: 1, fy: 0, fxy: 0, group: "eyes" },
      eyeBallY: { stdHalf: 1, fx: 0, fy: 1, fxy: 0, group: "eyes" },
    };
    const idMgr = CubismFramework.getIdManager();
    const out: LookParameterData[] = [];
    for (const role in SPEC) {
      const info = this.roleCtrl?.roleInfo(role);
      if (!info) continue;
      const spec = SPEC[role];
      const scale = ((info.max - info.min) / 2) / spec.stdHalf;
      const g = this.gazeGain[spec.group] ?? 1;
      out.push(new LookParameterData(
        idMgr.getId(info.id),
        spec.fx * scale * g,
        spec.fy * scale * g,
        spec.fxy * scale * g,
      ));
    }
    return out;
  }

  /** Gain keekspresivan gaze per grup sendi (0..2; 1 = netral) — dipasang
   * dari config user via view. Membangun ulang data look tanpa membuat
   * ulang updater. */
  setGazeGain(gain: { head?: number; eyes?: number; body?: number } | null | undefined): void {
    const g = gain ?? {};
    const cl = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 1;
    };
    this.gazeGain = { head: cl(g.head), eyes: cl(g.eyes), body: cl(g.body) };
    if (this.userModel && this.roleCtrl) {
      this.userModel.setLookParameters(this.buildLookData());
    }
  }

  /** Terapkan override role user (sheet v5 probeApprovals, layer `user`):
   * rebuild RoleController lalu refresh look/breath + fallback blink yang
   * membaca peta role. Murah — hanya peta + range, tanpa re-load model.
   * Catatan batas: updater lipsync memegang id load-time, jadi override
   * mouthOpenY baru mengikat penuh setelah model di-load ulang. */
  setRoleOverrides(overrides: Record<string, string> | null | undefined): void {
    const model = this.userModel?.getModel?.();
    if (!model || !this.userModel) return;
    try {
      const paramSet = new Set<string>();
      const pc = model.getParameterCount();
      for (let i = 0; i < pc; i++) paramSet.add(model.getParameterId(i).getString());
      this.roleCtrl = new RoleController(model, paramSet, {
        eyeBlinkIds: this.officialGroups.eyeBlinkIds,
        lipSyncIds: this.officialGroups.lipSyncIds,
      }, overrides ?? undefined);
      this.userModel.setLookParameters(this.buildLookData());
      this.userModel.setBreathParameters(this.buildBreathData());
      // Fallback blink mengikuti peta role baru (deklarasi rigger tetap menang).
      const fallbackIds: any[] = [];
      const idMgr = CubismFramework.getIdManager();
      for (const role of ["eyeLOpen", "eyeROpen"]) {
        const info = this.roleCtrl.roleInfo(role);
        if (info) fallbackIds.push(idMgr.getId(info.id));
      }
      this.userModel.ensureEyeBlink(fallbackIds);
    } catch (e) {
      console.warn("[Live2DRenderer] setRoleOverrides gagal", e);
    }
  }

  /** Puncak breath std resmi diskalakan ke range aktual; offset = default. */
  private buildBreathData(): BreathParameterData[] {
    const SPEC: Record<string, { stdHalf: number; peakStd: number; cycle: number; weight: number }> = {
      angleX: { stdHalf: 30, peakStd: 15, cycle: 6.5345, weight: 0.5 },
      angleY: { stdHalf: 30, peakStd: 8, cycle: 3.5345, weight: 0.5 },
      angleZ: { stdHalf: 30, peakStd: 10, cycle: 5.5345, weight: 0.5 },
      bodyAngleX: { stdHalf: 10, peakStd: 4, cycle: 15.5345, weight: 0.5 },
      breath: { stdHalf: 0.5, peakStd: 0.5, cycle: 3.2345, weight: 1 },
    };
    const idMgr = CubismFramework.getIdManager();
    const out: BreathParameterData[] = [];
    for (const role in SPEC) {
      const info = this.roleCtrl?.roleInfo(role);
      if (!info) continue;
      const spec = SPEC[role];
      const scale = ((info.max - info.min) / 2) / spec.stdHalf;
      out.push(new BreathParameterData(idMgr.getId(info.id), info.def, spec.peakStd * scale, spec.cycle, spec.weight));
    }
    return out;
  }

  /** Gambar satu frame — dipanggil dari rAF. dt dalam detik (tiap manager
   * meng-akumulasi userTimeSeconds sendiri), frame pertama di-clamp. */
  draw(nowMs?: number) {
    if (!this.userModel) return;
    const now = nowMs ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
    let dt = this.lastFrameMs == null ? 1 / 60 : (now - this.lastFrameMs) / 1000;
    this.lastFrameMs = now;
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    if (dt > 0.25) dt = 0.25;

    const offscreenMgr = CubismWebGLOffscreenManager.getInstance();
    offscreenMgr.beginFrameProcess(this.gl);
    try {
      this.userModel.update(dt);

      const renderer = this.userModel.getRenderer() as CubismRenderer_WebGL | null;
      if (!renderer) return;

      const w = (this.gl as any).drawingBufferWidth ?? this.canvas.width;
      const h = (this.gl as any).drawingBufferHeight ?? this.canvas.height;
      if (this.clearColor) {
        // proof pages: clear abu supaya readPixels bisa beda latar vs model.
        // View: setClear(null) — latar dari CSS #stage, canvas transparan.
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.viewport(0, 0, w, h);
        this.gl.clearColor(...this.clearColor);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
      }

      // drawModel tidak mengembalikan state GL host. Dua jalur:
      //  - pixiStateReset (view integrasi): GL-set murni + invalidate cache
      //    Pixi — TANPA glGet, GPU dan CPU tetap overlap.
      //  - saveProfile/restoreProfile (halaman proof): baca-tulis state
      //    via glGet — benar tapi setiap glGet setelah draw submission
      //    memaksa CPU menunggu GPU selesai (stall ±40 ms/frame).
      if (!this.pixiStateReset) {
        (renderer as any).saveProfile?.();
      }
      renderer.setRenderState(this.frameBuffer as WebGLFramebuffer, [0, 0, w, h]);

      if (this.mvpProvider) {
        this.mvpTmp.setMatrix(this.mvpProvider());
        renderer.setMvpMatrix(this.mvpTmp);
      } else {
        this.proj.loadIdentity();
        // framing mirip LAppView: scale agar tinggi model ~80% canvas, center
        const scale = 1.45;
        this.proj.scale(scale, scale * (this.canvas.width / this.canvas.height));
        this.proj.translateY(-0.12);
        if (this.modelMatrix) {
          this.mvp.loadIdentity();
          this.mvp.multiplyByMatrix(this.proj);
          this.mvp.multiplyByMatrix(this.modelMatrix);
          renderer.setMvpMatrix(this.mvp);
        } else {
          renderer.setMvpMatrix(this.proj);
        }
      }
      renderer.drawModel(this.shaderPath);
      if (this.pixiStateReset) {
        this.pixiStateReset();
      } else {
        (renderer as any).restoreProfile?.();
      }
    } finally {
      offscreenMgr.endFrameProcess(this.gl);
    }
  }

  /** Grup resmi manifest (EyeBlink/LipSync) — untuk facade view. */
  getOfficialGroups(): { eyeBlinkIds: string[]; lipSyncIds: string[] } {
    return { eyeBlinkIds: [...this.officialGroups.eyeBlinkIds], lipSyncIds: [...this.officialGroups.lipSyncIds] };
  }

  getDrawableCount(): number {
    return this.userModel?.getModel()?.getDrawableCount?.() ?? 0;
  }

  // Parameter API (model-agnostic: id dicek via model, bukan hardcode)
  /** Controller di-cache — stateless di atas model yang sama; getParameter
   * dipanggil driver app.js ±10× per frame (lerp pose & emosi). */
  private ctrl(): ParameterController | null {
    const m = this.userModel?.getModel();
    if (!m) return null;
    if (!this.paramCtrl) this.paramCtrl = new ParameterController(m);
    return this.paramCtrl;
  }
  getParameters(): string[] {
    const c = this.ctrl();
    return c ? c.getParameters() : [];
  }
  getParameterInfo(id: string): ParamInfo | null {
    const c = this.ctrl();
    return c ? c.getParameterInfo(id) : null;
  }
  getParameter(id: string): number | null {
    const c = this.ctrl();
    if (!c) return null;
    // bila ada pending arbiter, kembalikan resolved, bukan langsung model
    const pending = this.arbiter.resolveFinal().get(id);
    if (pending !== undefined) return pending;
    return c.getParameter(id);
  }
  setParameter(id: string, value: number, source: SourceId = 'manual'): boolean {
    const c = this.ctrl();
    if (!c) return false;
    if (!c.getParameterInfo(id)) return false;
    this.arbiter.set(id, value, source);
    return true;
  }

  // Helpers arbiter
  getArbiter(): ParameterArbiter { return this.arbiter; }
  hasConflict(id: string): boolean { return this.arbiter.hasConflict(id); }

  // Model Inspector
  getModelProfile(): ModelProfile | null {
    const m = this.userModel?.getModel();
    if (!m || !this.setting) return null;
    return inspectModel(m, this.setting);
  }

  // Role API (model-agnostic)
  getRoleMap(): Record<string, string> | null {
    return this.roleCtrl ? this.roleCtrl.getRoleMap() : null;
  }
  setRole(role: string, vRef: number, source: SourceId = 'manual'): boolean {
    if (!this.roleCtrl) return false;
    const resolved = this.roleCtrl.resolveRole(role, vRef);
    if (!resolved) return false;
    this.arbiter.set(resolved.id, resolved.actual, source);
    return true;
  }
  getRole(role: string): number | null {
    return this.roleCtrl ? this.roleCtrl.getRole(role) : null;
  }
  /** Reset role ke default asli model (bukan 0-ref — eyeOpen dsb. punya
   * default ≠ 0), ditulis lewat arbiter supaya satu jalur dengan source. */
  setRoleDefault(role: string, source: SourceId = 'manual'): boolean {
    if (!this.roleCtrl) return false;
    const d = this.roleCtrl.roleDefaultActual(role);
    if (!d) return false;
    this.arbiter.set(d.id, d.def, source);
    return true;
  }

  // Motion & ekspresi native — dipakai MotionBridge/IntentDirector.
  async playNativeMotion(group: string, index = 0, priority: number = MotionPriority.Normal): Promise<number> {
    if (!this.userModel) return -1;
    return this.userModel.startMotionGroup(group, index, priority);
  }
  /** Hentikan semua motion native — klip loop tak pernah selesai sendiri. */
  stopNativeMotions(): void {
    this.userModel?.stopNativeMotions();
  }
  async playExpression(name: string): Promise<boolean> {
    if (!this.userModel) return false;
    return this.userModel.playExpression(name);
  }
  /** Target look/gaze view-coords ±1 — di-ease CubismTargetPoint. */
  setLookTarget(x: number, y: number): void {
    this.userModel?.setLookTarget(x, y);
  }

  destroy() {
    // dispose: cache motion/ekspresi + scheduler, baru rantai release() base
    try { this.userModel?.dispose(); } catch {}
    for (const t of this.textures) try { this.gl.deleteTexture(t); } catch {}
    this.textures = [];
    this.userModel = null;
  }
}

// referensi tipe agar CubismUserModel tetap bagian dari kontrak public adapter
export type { CubismUserModel };
