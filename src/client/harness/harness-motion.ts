/**
 * client/harness/harness-motion.ts — driver halaman harness render untuk
 * critic visual (PLAN-MOTION-PIPELINE 4d). Dikendalikan core via CDP
 * Runtime.evaluate:
 *
 *   await __motionHarness.load({ model, asset, roleMap })  // muat model + asset
 *   __motionHarness.seek(t)                                // pose di detik t
 *   __motionHarness.state()                                // {ready, modelOk, …}
 *   __motionHarness.probe(paramId)                         // sweep param + settle physics + capture
 *                                                          // (probe: asset BOLEH kosong — pose murni dari drive)
 *
 * Tulisan parameter lewat backend coreModel facade (antrean `writes` yang
 * di-flush updater order 900 tiap frame) — jalur tulis resmi yang sama
 * dengan app.js. Blink/breath/gaze dimatikan supaya pose murni dari asset
 * (deterministik untuk screenshot). Physics tetap jalan: sway rambut adalah
 * noise alami, bukan bagian yang dinilai.
 *
 * Halaman ini hanya untuk harness internal — bukan permukaan user.
 */

type AnyRec = Record<string, any>;

// Metrik diff piksel probe — logika murni di motion-probe.ts (teruji unit),
// harness hanya menyediakan piksel canvas.
import { bboxFromDiff, centroidFromDiff, classifyDead } from "../animation/motion-probe";

interface HarnessState {
  ready: boolean;
  modelOk: boolean;
  duration: number;
  uncoveredRoles: number;
  error: string;
}

const st: HarnessState = {
  ready: false,
  modelOk: false,
  duration: 1,
  uncoveredRoles: 0,
  error: "",
};

let facade: AnyRec | null = null;
let rangesCache: Record<string, { min: number; max: number; def: number }> | null = null;
let assetCache: AnyRec | null = null;

function w(): AnyRec {
  return window as unknown as AnyRec;
}

function status(text?: string) {
  const el = document.getElementById("harness-status");
  if (!el) return;
  el.textContent = text
    ?? `harness: ${st.ready ? "ready" : "busy"} model=${st.modelOk} dur=${st.duration.toFixed(2)}s${st.error ? " ERR=" + st.error : ""}`;
}

function boot() {
  const v = w().__live2dView;
  if (!v || !v.ready) {
    setTimeout(boot, 100);
    return;
  }
  // Deterministik: efek frame-transien mati — pose murni dari asset.
  v.setBlinkGate(() => false);
  v.setBreathGate(() => false);
  v.setLookGate(() => false);
  st.ready = true;
  status();
}

/** Kumpulkan range param aktual dari Core (bukan tebakan) untuk migrasi
 *  role→param dan clamp nilai. */
function paramRanges(f: AnyRec): Record<string, { min: number; max: number; def: number }> {
  const out: Record<string, { min: number; max: number; def: number }> = {};
  const m = f.internalModel?.coreModel?.getModel?.();
  if (!m) return out;
  const n = m.getParameterCount?.() ?? 0;
  for (let i = 0; i < n; i++) {
    const id = m.getParameterId?.(i);
    if (typeof id !== "string" || !id) continue;
    out[id] = {
      min: m.getParameterMinimumValue?.(i) ?? 0,
      max: m.getParameterMaximumValue?.(i) ?? 0,
      def: m.getParameterDefaultValue?.(i) ?? 0,
    };
  }
  return out;
}

/** Muat model + siapkan asset. `model` = URL model3.json relatif origin
 *  (mis. "model/lumine/lumine.model3.json"); `roleMap` = {ax: "ParamAngleX"}.
 *  `asset` BOLEH null (probe runtime: pose murni dari drive patch).
 *  Return Promise — Runtime.evaluate menunggu lewat awaitPromise. */
async function load(req: { model: string; asset?: AnyRec | null; roleMap?: AnyRec }): Promise<AnyRec> {
  st.ready = false;
  st.error = "";
  status("harness: loading model…");
  const v = w().__live2dView;
  const dsl = w().MotionDSL;
  if (!v || !v.ready) throw new Error("renderer belum siap");
  if (!dsl) throw new Error("MotionDSL tidak tersedia (bundle.js)");

  const loaded: AnyRec = await v.loadModel(req.model);
  facade = loaded;

  rangesCache = paramRanges(loaded);
  let asset = req.asset ?? null;
  // Migrasi role→param deterministik. Peta dari core ber-kunci FIELD
  // ({ay: "ParamAngleY"} — konsisten dengan prompt/analysis); rolesToParamTracks
  // mencari dengan kunci NAMA ROLE ({angleY: …} via ROLE_FOR_FIELD) —
  // terjemahkan di sini. Sumber inferensi role tetap role-mapping.ts.
  try {
    if (dsl.rolesToParamTracks && Array.isArray(asset?.tracks)) {
      const roleFor = dsl.ROLE_FOR_FIELD || {};
      const roleNameMap: AnyRec = {};
      for (const field of Object.keys(req.roleMap || {})) {
        const roleName = roleFor[field] || field;
        roleNameMap[roleName] = (req.roleMap as AnyRec)[field];
      }
      asset = dsl.rolesToParamTracks(asset, roleNameMap, rangesCache!);
    }
  } catch (e: any) {
    st.error = "migrate: " + (e?.message || e);
  }
  assetCache = asset;
  st.duration = Number(asset?.duration) > 0 ? Number(asset?.duration) : 1;
  st.uncoveredRoles = (asset?.tracks || []).filter((t: AnyRec) => t.kind !== "param").length;
  st.modelOk = !!facade;
  st.ready = true;
  fitToCanvas();
  if (assetCache) seek(0);
  status();
  return { ok: true, duration: st.duration, uncoveredRoles: st.uncoveredRoles, params: Object.keys(rangesCache || {}).length };
}

/** Samakan ukuran/posisi model dengan canvas (fit + center). Framing penuh
 *  ini dasar kedua mode capture — "upper" diambil lewat crop dari capture
 *  penuh (tanpa mengubah transform MVP). */
function fitToCanvas() {
  if (!facade) return;
  const canvas = document.querySelector("#live2d-canvas") as HTMLCanvasElement | null;
  const cw = canvas?.clientWidth || 800;
  const ch = canvas?.clientHeight || 600;
  const b = facade.getBounds();
  if (!b || !b.width || !b.height) return;
  const s = Math.min((cw * 0.85) / b.width, (ch * 0.9) / b.height);
  facade.scale.set(s);
  const b2 = facade.getBounds();
  facade.x = facade.x + (cw - b2.width) / 2 - b2.x;
  facade.y = facade.y + (ch - b2.height) / 2 - b2.y;
}

/** Patch drive aktif — di-re-queue TIAP FRAME. Wajib: AppWriteUpdater
 *  mem-flush antrean sekali lalu clear, dan loadParameters() frame berikutnya
 *  memulihkan pose dasar — pola yang sama dipakai app.js (applyRawDrive di
 *  rAF sendiri). Tanpa ini pose kembali ke dasar 1 frame setelah seek. */
let drivePatch: Record<string, number> = {};
let driveLoopRunning = false;

/** Canvas 2D bantu (dipakai ulang) untuk deteksi bbox konten + komposit. */
let scratch: HTMLCanvasElement | null = null;
function scratchCtx(w: number, h: number): CanvasRenderingContext2D {
  if (!scratch) scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d context tidak tersedia");
  return ctx;
}

function driveLoop() {
  const cm = facade?.internalModel?.coreModel;
  if (cm) {
    for (const id of Object.keys(drivePatch)) {
      cm.setParameterValueById(id, drivePatch[id], 1);
    }
  }
  requestAnimationFrame(driveLoop);
}

/** Pose asset di detik t → pasang patch drive (diulang tiap frame sampai
 *  seek berikutnya). Nilai di-clamp ke range Core. */
function seek(t: number): AnyRec {
  const dsl = w().MotionDSL;
  if (!facade || !dsl || !assetCache) return { ok: false };
  const ranges = rangesCache || {};
  const owned = new Set(Object.keys(ranges));
  const supports = new Set(["head", "eyes", "mouth", "body"]);
  const res = dsl.evaluateAsset(assetCache, Number(t) || 0, 1, supports, owned);
  const cm = facade.internalModel?.coreModel;
  if (!cm) return { ok: false };
  let wrote = 0;
  const patch: AnyRec = { ...(res.params || {}) };
  drivePatch = {};
  for (const id of Object.keys(patch)) {
    let v = Number(patch[id]);
    if (!Number.isFinite(v)) continue;
    const r = ranges[id];
    if (r) v = Math.max(r.min, Math.min(r.max, v));
    drivePatch[id] = v;
    // Tulis LANGSUNG ke antrean flush (order 900) — draw() berikutnya
    // menerapkannya walau rAF mati. driveLoop hanya menjaga nilai tetap
    // ter-queue saat ticker hidup (pending di-consume tiap flush).
    cm.setParameterValueById(id, v, 1);
    wrote++;
  }
  if (!driveLoopRunning) {
    driveLoopRunning = true;
    requestAnimationFrame(driveLoop);
  }
  return { ok: true, wrote };
}

/** Capture crop dari kondisi canvas SAAT INI (render dulu lewat frame()/settle
 *  oleh pemanggil). Diambil dari body snap agar probe bisa memakainya tanpa
 *  seek asset. `keepPixels` = sertakan ImageData hasil crop untuk metrik diff
 *  probe (INTERNAL — jangan dikirim ke CDP, serialisasi piksel boros).
 *
 *  mode:
 *  - "upper": crop area kepala/wajah dari capture penuh (piksel asli 1:1 —
 *    detail ekspresi halus terbaca; tanpa utak-atik transform MVP).
 *  - "full": seluruh model (kepala sampai kaki) + margin.
 */
function capture(mode: "upper" | "full", keepPixels = false): AnyRec {
  const canvas = document.querySelector("#live2d-canvas") as HTMLCanvasElement | null;
  if (!canvas) return { ok: false, error: "canvas tidak ada" };
  try {
    // Deteksi bbox konten dari PIKSEL ALPHA (box model Cubism sering lebih
    // besar dari karakter terlihat — crop berdasar bounds bisa mayoritas
    // ruang hampa). Stride 2px cukup presisi dan murah.
    const x = scratchCtx(canvas.width, canvas.height);
    x.clearRect(0, 0, canvas.width, canvas.height);
    x.drawImage(canvas, 0, 0);
    const img = x.getImageData(0, 0, canvas.width, canvas.height);
    let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
    for (let py = 0; py < canvas.height; py += 2) {
      const row = py * canvas.width * 4;
      for (let px = 0; px < canvas.width; px += 2) {
        if (img.data[row + px * 4 + 3] > 12) {
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
      }
    }
    if (maxX < 0) return { ok: false, error: "canvas kosong (tanpa piksel model)" };
    const vx = minX, vy = minY, vw = maxX - minX + 2, vh = maxY - minY + 2;
    let sx: number, sy: number, sw: number, sh: number;
    if (mode === "upper") {
      // tubuh atas: kepala+wajah+bahu dari bbox konten terlihat
      // (kepala menempati ~0-25% tinggi konten — mulai sedikit di atasnya)
      sx = Math.max(0, vx + vw * 0.10);
      sy = Math.max(0, vy - vh * 0.04);
      sw = vw * 0.80;
      sh = vh * 0.44;
    } else {
      sx = Math.max(0, vx - vw * 0.06);
      sy = Math.max(0, vy - vh * 0.06);
      sw = Math.min(canvas.width - sx, vw * 1.12);
      sh = Math.min(canvas.height - sy, vh * 1.12);
    }
    // komposit: latar gelap + crop sumber (alpha canvas → hitam bila langsung JPEG)
    const scaleUp = mode === "upper" ? 2 : 1; // wajah kecil → perbesar agar detail terbaca VLM
    const out = document.createElement("canvas");
    out.width = sw * scaleUp;
    out.height = sh * scaleUp;
    const ctx = out.getContext("2d");
    if (!ctx) return { ok: false, error: "ctx 2d tidak tersedia" };
    ctx.fillStyle = "#10131a";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const outRes: AnyRec = { ok: true, dataUrl: out.toDataURL("image/jpeg", 0.72) };
    if (keepPixels) outRes.im = ctx.getImageData(0, 0, out.width, out.height);
    return outRes;
  } catch (e: any) {
    return { ok: false, error: "toDataURL: " + (e?.message || e) };
  }
}

/** Diff piksel dua frame (RGB; komposit latar gelap sama — alpha stabil).
 *  changed = |Δr|+|Δg|+|Δb| > 24. Return metrik ala motion-probe.ts:
 *  bbox/centroid dihitung dari peta piksel berubah (alpha 255/0). */
function diffImageData(a: ImageData, b: ImageData): AnyRec {
  const w = a.width, h = a.height;
  const diff = new Uint8ClampedArray(w * h * 4);
  let changed = 0;
  for (let i = 0; i < w * h * 4; i += 4) {
    const d = Math.abs(a.data[i] - b.data[i])
      + Math.abs(a.data[i + 1] - b.data[i + 1])
      + Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (d > 24) {
      diff[i + 3] = 255;
      changed++;
    }
  }
  const bbox = bboxFromDiff(diff, w, h);
  const centroid = centroidFromDiff(diff, w, h);
  return { changedPixels: changed, diffRatio: changed / Math.max(1, w * h), bbox, centroid };
}

w().__motionHarness = {
  load,
  seek,
  /** Render SATU frame eksplisit di t: seek → siklus frame resmi renderer
   *  (pixi clear → renderer.draw() yang memutar update pipeline + menggambar
   *  Cubism langsung ke canvas GL). TANPA rAF/ticker — jendela ter-occlude
   *  mematikan rAF, capture tidak boleh bergantung pada siklus frame. */
  frame(t: number): AnyRec {
    const seekRes = seek(t);
    const v = w().__live2dView?.view;
    if (!v?.renderer || !v?.pixiApp) {
      return { ok: false, seek: seekRes, error: "renderer/pixiApp tidak tersedia" };
    }
    try {
      v.pixiApp.render();
      v.renderer.draw();
    } catch (e: any) {
      return { ok: false, seek: seekRes, error: "frame: " + (e?.message || e) };
    }
    return { ok: true, seek: seekRes };
  },
  /** Render + CAPTURE dalam task yang sama: seek → update pipeline resmi →
   *  app.render() → renderer.draw() → crop dari canvas.toDataURL().
   *  Kunci determinisme: tanpa rAF/kompositor (jendela ter-occlude mematikan
   *  rAF dan kompositor tak meng-commit frame, jadi screenshot permukaan
   *  CDP akan frame basi) — buffer WebGL dibaca langsung setelah render sinkron. */
  snap(t: number, mode?: "upper" | "full"): AnyRec {
    const frameRes = this.frame(t);
    if (!frameRes.ok) return frameRes;
    return capture((mode || "full") as "upper" | "full", false);
  },
  /** PROBE RUNTIME (backlog Fase 2): sweep satu parameter ke beberapa nilai,
   *  settle physics sebelum tiap capture, lalu metrik diff piksel vs frame
   *  default. Asset TIDAK diperlukan — pose murni dari drive patch, jadi
   *  probe jalan untuk model polos (evidensa role-mapping param unclassified).
   *
   *  Return {ok, paramId, range, dead, frames:[{v, dataUrl, changedPixels,
   *  diffRatio, bbox, centroid}]}. `dead` = sweep max tak mengubah piksel —
   *  kandidat param mati (tidak perlu jadi kandidat role).
   */
  probe(paramId: string, values?: number[]): AnyRec {
    if (!facade) return { ok: false, error: "model belum dimuat" };
    const r = (rangesCache || {})[paramId];
    if (!r) return { ok: false, error: "param tidak ada: " + paramId };
    const vals = (Array.isArray(values) && values.length
      ? values
      : [r.def, r.min, (r.min + r.max) / 2, r.max])
      .map(Number).filter(Number.isFinite)
      .map((v: number) => Math.max(r.min, Math.min(r.max, v)));
    if (vals.length < 2) return { ok: false, error: "butuh >= 2 nilai sweep" };
    const frames: AnyRec[] = [];
    for (const v of vals) {
      const d = this.drive(paramId, v);
      if (!d.ok) return d;
      const s = this.settle();
      if (!s.ok) return s;
      const c = capture("full", true);
      if (!c.ok) return c;
      frames.push({ v, dataUrl: c.dataUrl, im: c.im });
    }
    // Metrik diff vs basis (frame pertama = default). `im` TIDAK dikirim keluar
    // (CDP serialize array piksel = boros) — hanya angka + bbox.
    const base = frames[0];
    const out = frames.map((f: AnyRec, i: number) => {
      if (i === 0) {
        return { v: f.v, dataUrl: f.dataUrl, changedPixels: 0, diffRatio: 0, bbox: null, centroid: null };
      }
      const m = diffImageData(base.im, f.im);
      return { v: f.v, dataUrl: f.dataUrl, ...m };
    });
    const worst = out.slice(1).reduce(
      (acc: AnyRec, cur: AnyRec) => ((cur.changedPixels > acc.changedPixels) ? cur : acc),
      out[1]!
    );
    const dead = classifyDead(worst?.changedPixels ?? 0);
    return {
      ok: true,
      paramId,
      range: r,
      dead,
      frames: out.map((f: AnyRec) => { const { im: _im, ...rest } = f; return rest; }),
    };
  },
  /** Set nilai param via drive patch (di-re-queue tiap frame). Clamp ke range
   *  Core. Tanpa asset — dipakai probe. */
  drive(paramId: string, value: number): AnyRec {
    if (!facade) return { ok: false, error: "model belum dimuat" };
    const r = (rangesCache || {})[paramId];
    if (!r) return { ok: false, error: "param tidak ada: " + paramId };
    let v = Number(value);
    if (!Number.isFinite(v)) v = r.def;
    v = Math.max(r.min, Math.min(r.max, v));
    drivePatch = { [paramId]: v };
    const cm = facade.internalModel?.coreModel;
    if (cm) cm.setParameterValueById(paramId, v, 1);
    if (!driveLoopRunning) {
      driveLoopRunning = true;
      requestAnimationFrame(driveLoop);
    }
    return { ok: true, v, min: r.min, max: r.max, def: r.def };
  },
  /** Render N frame satu per satu (physics/pose settle). Tanpa seek — dipakai
   *  probe setelah drive patch agar sway physics steady-state sebelum capture. */
  settle(n?: number): AnyRec {
    const count = Math.max(1, Math.min(120, Number(n) || 24));
    const v = w().__live2dView?.view;
    if (!v?.renderer || !v?.pixiApp) {
      return { ok: false, error: "renderer/pixiApp tidak tersedia" };
    }
    try {
      for (let i = 0; i < count; i++) {
        v.pixiApp.render();
        v.renderer.draw();
      }
    } catch (e: any) {
      return { ok: false, error: "settle: " + (e?.message || e) };
    }
    return { ok: true, frames: count };
  },
  state(): HarnessState {
    return { ...st };
  },
};

boot();

export {};
