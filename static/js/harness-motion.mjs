// src/client/animation/motion-probe.ts
function bboxFromDiff(diffAlpha, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0;y < height; y++) {
    for (let x = 0;x < width; x++) {
      const i = (y * width + x) * 4 + 3;
      const a = diffAlpha[i] ?? 0;
      if (a > 16) {
        count++;
        if (x < minX)
          minX = x;
        if (y < minY)
          minY = y;
        if (x > maxX)
          maxX = x;
        if (y > maxY)
          maxY = y;
      }
    }
  }
  if (count === 0)
    return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
function centroidFromDiff(diffAlpha, width, height) {
  let sx = 0, sy = 0, w = 0;
  for (let y = 0;y < height; y++) {
    for (let x = 0;x < width; x++) {
      const a = diffAlpha[(y * width + x) * 4 + 3] ?? 0;
      if (a > 16) {
        sx += x * a;
        sy += y * a;
        w += a;
      }
    }
  }
  if (w === 0)
    return null;
  return { x: sx / w, y: sy / w };
}
function classifyDead(changedPixels, threshold = 8) {
  return changedPixels < threshold;
}

// src/client/harness/harness-motion.ts
var st = {
  ready: false,
  modelOk: false,
  duration: 1,
  uncoveredRoles: 0,
  error: ""
};
var facade = null;
var rangesCache = null;
var assetCache = null;
function w() {
  return window;
}
function status(text) {
  const el = document.getElementById("harness-status");
  if (!el)
    return;
  el.textContent = text ?? `harness: ${st.ready ? "ready" : "busy"} model=${st.modelOk} dur=${st.duration.toFixed(2)}s${st.error ? " ERR=" + st.error : ""}`;
}
function boot() {
  const v = w().__live2dView;
  if (!v || !v.ready) {
    setTimeout(boot, 100);
    return;
  }
  v.setBlinkGate(() => false);
  v.setBreathGate(() => false);
  v.setLookGate(() => false);
  st.ready = true;
  status();
}
function paramRanges(f) {
  const out = {};
  const m = f.internalModel?.coreModel?.getModel?.();
  if (!m)
    return out;
  const n = m.getParameterCount?.() ?? 0;
  for (let i = 0;i < n; i++) {
    const id = m.getParameterId?.(i);
    if (typeof id !== "string" || !id)
      continue;
    out[id] = {
      min: m.getParameterMinimumValue?.(i) ?? 0,
      max: m.getParameterMaximumValue?.(i) ?? 0,
      def: m.getParameterDefaultValue?.(i) ?? 0
    };
  }
  return out;
}
async function load(req) {
  st.ready = false;
  st.error = "";
  status("harness: loading model…");
  const v = w().__live2dView;
  const dsl = w().MotionDSL;
  if (!v || !v.ready)
    throw new Error("renderer belum siap");
  if (!dsl)
    throw new Error("MotionDSL tidak tersedia (bundle.js)");
  const loaded = await v.loadModel(req.model);
  facade = loaded;
  rangesCache = paramRanges(loaded);
  let asset = req.asset ?? null;
  try {
    if (dsl.rolesToParamTracks && Array.isArray(asset?.tracks)) {
      const roleFor = dsl.ROLE_FOR_FIELD || {};
      const roleNameMap = {};
      for (const field of Object.keys(req.roleMap || {})) {
        const roleName = roleFor[field] || field;
        roleNameMap[roleName] = req.roleMap[field];
      }
      asset = dsl.rolesToParamTracks(asset, roleNameMap, rangesCache);
    }
  } catch (e) {
    st.error = "migrate: " + (e?.message || e);
  }
  assetCache = asset;
  st.duration = Number(asset?.duration) > 0 ? Number(asset?.duration) : 1;
  st.uncoveredRoles = (asset?.tracks || []).filter((t) => t.kind !== "param").length;
  st.modelOk = !!facade;
  st.ready = true;
  fitToCanvas();
  if (assetCache)
    seek(0);
  status();
  return { ok: true, duration: st.duration, uncoveredRoles: st.uncoveredRoles, params: Object.keys(rangesCache || {}).length };
}
function fitToCanvas() {
  if (!facade)
    return;
  const canvas = document.querySelector("#live2d-canvas");
  const cw = canvas?.clientWidth || 800;
  const ch = canvas?.clientHeight || 600;
  const b = facade.getBounds();
  if (!b || !b.width || !b.height)
    return;
  const s = Math.min(cw * 0.85 / b.width, ch * 0.9 / b.height);
  facade.scale.set(s);
  const b2 = facade.getBounds();
  facade.x = facade.x + (cw - b2.width) / 2 - b2.x;
  facade.y = facade.y + (ch - b2.height) / 2 - b2.y;
}
var drivePatch = {};
var driveLoopRunning = false;
var scratch = null;
function scratchCtx(w2, h) {
  if (!scratch)
    scratch = document.createElement("canvas");
  scratch.width = w2;
  scratch.height = h;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx)
    throw new Error("2d context tidak tersedia");
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
function seek(t) {
  const dsl = w().MotionDSL;
  if (!facade || !dsl || !assetCache)
    return { ok: false };
  const ranges = rangesCache || {};
  const owned = new Set(Object.keys(ranges));
  const supports = new Set(["head", "eyes", "mouth", "body"]);
  const res = dsl.evaluateAsset(assetCache, Number(t) || 0, 1, supports, owned);
  const cm = facade.internalModel?.coreModel;
  if (!cm)
    return { ok: false };
  let wrote = 0;
  const patch = { ...res.params || {} };
  drivePatch = {};
  for (const id of Object.keys(patch)) {
    let v = Number(patch[id]);
    if (!Number.isFinite(v))
      continue;
    const r = ranges[id];
    if (r)
      v = Math.max(r.min, Math.min(r.max, v));
    drivePatch[id] = v;
    cm.setParameterValueById(id, v, 1);
    wrote++;
  }
  if (!driveLoopRunning) {
    driveLoopRunning = true;
    requestAnimationFrame(driveLoop);
  }
  return { ok: true, wrote };
}
function capture(mode, keepPixels = false) {
  const canvas = document.querySelector("#live2d-canvas");
  if (!canvas)
    return { ok: false, error: "canvas tidak ada" };
  try {
    const x = scratchCtx(canvas.width, canvas.height);
    x.clearRect(0, 0, canvas.width, canvas.height);
    x.drawImage(canvas, 0, 0);
    const img = x.getImageData(0, 0, canvas.width, canvas.height);
    let { width: minX, height: minY } = canvas, maxX = -1, maxY = -1;
    for (let py = 0;py < canvas.height; py += 2) {
      const row = py * canvas.width * 4;
      for (let px = 0;px < canvas.width; px += 2) {
        if (img.data[row + px * 4 + 3] > 12) {
          if (px < minX)
            minX = px;
          if (px > maxX)
            maxX = px;
          if (py < minY)
            minY = py;
          if (py > maxY)
            maxY = py;
        }
      }
    }
    if (maxX < 0)
      return { ok: false, error: "canvas kosong (tanpa piksel model)" };
    const vx = minX, vy = minY, vw = maxX - minX + 2, vh = maxY - minY + 2;
    let sx, sy, sw, sh;
    if (mode === "upper") {
      sx = Math.max(0, vx + vw * 0.1);
      sy = Math.max(0, vy - vh * 0.04);
      sw = vw * 0.8;
      sh = vh * 0.44;
    } else {
      sx = Math.max(0, vx - vw * 0.06);
      sy = Math.max(0, vy - vh * 0.06);
      sw = Math.min(canvas.width - sx, vw * 1.12);
      sh = Math.min(canvas.height - sy, vh * 1.12);
    }
    const scaleUp = mode === "upper" ? 2 : 1;
    const out = document.createElement("canvas");
    out.width = sw * scaleUp;
    out.height = sh * scaleUp;
    const ctx = out.getContext("2d");
    if (!ctx)
      return { ok: false, error: "ctx 2d tidak tersedia" };
    ctx.fillStyle = "#10131a";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const outRes = { ok: true, dataUrl: out.toDataURL("image/jpeg", 0.72) };
    if (keepPixels)
      outRes.im = ctx.getImageData(0, 0, out.width, out.height);
    return outRes;
  } catch (e) {
    return { ok: false, error: "toDataURL: " + (e?.message || e) };
  }
}
function diffImageData(a, b) {
  const { width: w2, height: h } = a;
  const diff = new Uint8ClampedArray(w2 * h * 4);
  let changed = 0;
  for (let i = 0;i < w2 * h * 4; i += 4) {
    const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (d > 24) {
      diff[i + 3] = 255;
      changed++;
    }
  }
  const bbox = bboxFromDiff(diff, w2, h);
  const centroid = centroidFromDiff(diff, w2, h);
  return { changedPixels: changed, diffRatio: changed / Math.max(1, w2 * h), bbox, centroid };
}
w().__motionHarness = {
  load,
  seek,
  frame(t) {
    const seekRes = seek(t);
    const v = w().__live2dView?.view;
    if (!v?.renderer || !v?.pixiApp) {
      return { ok: false, seek: seekRes, error: "renderer/pixiApp tidak tersedia" };
    }
    try {
      v.pixiApp.render();
      v.renderer.draw();
    } catch (e) {
      return { ok: false, seek: seekRes, error: "frame: " + (e?.message || e) };
    }
    return { ok: true, seek: seekRes };
  },
  snap(t, mode) {
    const frameRes = this.frame(t);
    if (!frameRes.ok)
      return frameRes;
    return capture(mode || "full", false);
  },
  probe(paramId, values) {
    if (!facade)
      return { ok: false, error: "model belum dimuat" };
    const r = (rangesCache || {})[paramId];
    if (!r)
      return { ok: false, error: "param tidak ada: " + paramId };
    const vals = (Array.isArray(values) && values.length ? values : [r.def, r.min, (r.min + r.max) / 2, r.max]).map(Number).filter(Number.isFinite).map((v) => Math.max(r.min, Math.min(r.max, v)));
    if (vals.length < 2)
      return { ok: false, error: "butuh >= 2 nilai sweep" };
    const frames = [];
    for (const v of vals) {
      const d = this.drive(paramId, v);
      if (!d.ok)
        return d;
      const s = this.settle();
      if (!s.ok)
        return s;
      const c = capture("full", true);
      if (!c.ok)
        return c;
      frames.push({ v, dataUrl: c.dataUrl, im: c.im });
    }
    const base = frames[0];
    const out = frames.map((f, i) => {
      if (i === 0) {
        return { v: f.v, dataUrl: f.dataUrl, changedPixels: 0, diffRatio: 0, bbox: null, centroid: null };
      }
      const m = diffImageData(base.im, f.im);
      return { v: f.v, dataUrl: f.dataUrl, ...m };
    });
    const worst = out.slice(1).reduce((acc, cur) => cur.changedPixels > acc.changedPixels ? cur : acc, out[1]);
    const dead = classifyDead(worst?.changedPixels ?? 0);
    return {
      ok: true,
      paramId,
      range: r,
      dead,
      frames: out.map((f) => {
        const { im: _im, ...rest } = f;
        return rest;
      })
    };
  },
  drive(paramId, value) {
    if (!facade)
      return { ok: false, error: "model belum dimuat" };
    const r = (rangesCache || {})[paramId];
    if (!r)
      return { ok: false, error: "param tidak ada: " + paramId };
    let v = Number(value);
    if (!Number.isFinite(v))
      v = r.def;
    v = Math.max(r.min, Math.min(r.max, v));
    drivePatch = { [paramId]: v };
    const cm = facade.internalModel?.coreModel;
    if (cm)
      cm.setParameterValueById(paramId, v, 1);
    if (!driveLoopRunning) {
      driveLoopRunning = true;
      requestAnimationFrame(driveLoop);
    }
    return { ok: true, v, min: r.min, max: r.max, def: r.def };
  },
  settle(n) {
    const count = Math.max(1, Math.min(120, Number(n) || 24));
    const v = w().__live2dView?.view;
    if (!v?.renderer || !v?.pixiApp) {
      return { ok: false, error: "renderer/pixiApp tidak tersedia" };
    }
    try {
      for (let i = 0;i < count; i++) {
        v.pixiApp.render();
        v.renderer.draw();
      }
    } catch (e) {
      return { ok: false, error: "settle: " + (e?.message || e) };
    }
    return { ok: true, frames: count };
  },
  state() {
    return { ...st };
  }
};
boot();
