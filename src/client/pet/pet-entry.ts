/**
 * pet-entry — pin Desktop Pet: model + indra + punch-through + sentuhan.
 *
 * Halaman static/pet.html tinggal markup; SEMUA logika di sini (bundle
 * static/js/pet.js, entry ke-5 src/build.ts). Modul murni (senses/hit/punch/
 * touch/swing/react) diuji bun test; file ini penebar kabel DOM/IPC-nya.
 *
 * Dua sumber sampel kursor:
 * - Embedded (shell Lumimi): event push `pet://cursor` dari thread native
 *   (pet_native.rs, GetAsyncKeyState = keadaan tombol GLOBAL — bebas
 *   feedback loop saat jendela digeser). SATU-SATUNYA sumber touch/punch
 *   di shell; DOM tak dipakai untuk itu (klik-tembus ON memang tak
 *   menyampai event DOM, dan drag jendela mengubah client koordinat).
 * - Dev browser (tanpa shell): DOM pointer events → detektor tetap hidup
 *   (reaksi boop/pat jalan), tanpa pindah-jendela (butuh koordinat fisik).
 *
 * Gaze + sway + swing = rAF lokal, TANPA IPC per-frame (aturan arsitektur).
 */
import { transport } from "../transport";
import { createSenses } from "./senses";
import { expandAABB, physicalToClient, type AABB } from "./hit";
import { createPunchController } from "./punch";
import { createTouchDetector, type TouchEvent } from "./touch";
import { initialSwingState, swingStep } from "./swing";
import { REACTION_VERBS, pickLine, resolveExpressionForVerb, resolveMotionForVerb } from "./react";

const w = window as any;
const t = (k: string, v?: Record<string, unknown>) =>
  w.__i18n ? w.__i18n.t(k, v) : k;

// ── Kontrak halaman (pet.html hanya markup) ─────────────────────────────
// Flag diminta SEBELUM modul view dieksekusi: script klasik ini jalan lebih
// dulu daripada module live2d-view.mjs (module = deferred).
w.__live2dRendererRequested = true;
w.__live2dStageSize = () => ({ w: window.innerWidth, h: window.innerHeight });
if (!w.__live2dViewWait) {
  w.__live2dViewWait = new Promise((res: (v: unknown) => void) => {
    w.__live2dViewReadyResolve = res;
  });
}

const el = (id: string) => document.getElementById(id);
const bubbleEl = el("bubble") as HTMLElement | null;
const bubbleText = el("bubble-text") as HTMLElement | null;

let bubbleTimer = 0;
function bubble(text: string, ms = 3500): void {
  if (!bubbleEl || !bubbleText) return;
  bubbleText.textContent = text;
  bubbleEl.style.display = "block";
  window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => {
    if (bubbleEl) bubbleEl.style.display = "none";
  }, ms);
}

const state = {
  model: null as any,
  clickThrough: false,
  /** Rotasi sway idle (rad) — swing menumpuk di atasnya. */
  swayT: 0,
  swing: initialSwingState(),
  /** Akselerasi pivot (px/s²) — dari pergeseran kursor fisik saat digrab. */
  winAx: 0,
  lastPhysX: 0,
  lastPhysT: 0,
  lastPhysVx: null as number | null,
  lastReaction: "",
  /** Posisi fisik kursor saat grab mulai (acuan pindah jendela). */
  dragPhys: null as { x: number; y: number } | null,
  /** Native stream hidup? (fallback DOM bila tidak). */
  nativeSeen: 0,
};

// ── Indra ────────────────────────────────────────────────────────────────
const senses = createSenses();
const touch = createTouchDetector();

// ── Tauri window API jendela pet (null di dev browser) ──────────────────
function petWin(): any | null {
  try {
    const ta = w.__TAURI__;
    return ta?.window?.getCurrentWindow?.() ?? null;
  } catch {
    return null;
  }
}

// Origin jendela (fisik) + scaleFactor, cache 120 ms — dibaca ulang segera
// setelah jendela dipindah (drag) supaya konversi kursor tak basi.
let winCache: { o: { x: number; y: number }; s: number; at: number } | null = null;
async function winOrigin(force = false): Promise<{ o: { x: number; y: number }; s: number } | null> {
  const win = petWin();
  if (!win) return null;
  const now = performance.now();
  if (!force && winCache && now - winCache.at < 120) return winCache;
  try {
    const [pos, s] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
    const scale = typeof s === "number" && s > 0 ? s : 1;
    winCache = { o: { x: pos.x, y: pos.y }, s: scale, at: now };
    return winCache;
  } catch {
    return null;
  }
}

// ── Punch-through ────────────────────────────────────────────────────────
let ignoreSeq = 0;
let ignoreNow = false;
async function setIgnoreCursor(on: boolean): Promise<void> {
  const seq = ++ignoreSeq;
  const win = petWin();
  if (!win) return;
  try {
    await win.setIgnoreCursorEvents(on);
    if (seq === ignoreSeq) ignoreNow = on;
  } catch {
    // dev browser: tidak ada — biarkan
  }
}
const punch = createPunchController({
  setIgnore: (on) => void setIgnoreCursor(on),
  getBounds: () => modelBounds(),
  getClickThrough: () => state.clickThrough,
  enterPad: 4,
  exitPad: 24,
});

function modelBounds(): AABB | null {
  const m = state.model;
  if (!m) return null;
  try {
    return m.getBounds() as AABB;
  } catch {
    return null;
  }
}

/** bounds + pad untuk hit sentuhan (grab lebih longgar dari punch). */
function insideModel(x: number, y: number): boolean {
  const b = modelBounds();
  if (!b) return false;
  const e = expandAABB(b, 8);
  return x >= e.x && x <= e.x + e.width && y >= e.y && y <= e.y + e.height;
}

// ── Reaksi ───────────────────────────────────────────────────────────────
function reactTo(verb: string): void {
  const m = state.model;
  if (!m) return;
  const verbs = REACTION_VERBS[verb] ?? [verb];
  let group: string | null = null;
  for (const v of verbs) {
    group = resolveMotionForVerb(m.internalModel?.motionManager?.definitions, v);
    if (group) break;
  }
  if (group) m.motion(group, -1, 2);
  let expr: string | null = null;
  for (const v of verbs) {
    expr = resolveExpressionForVerb(m.expressions, v);
    if (expr) break;
  }
  if (expr) void m.expression(expr);
  const key = `pet.touch.${verb}`;
  const line = pickLine([t(key)], state.lastReaction);
  if (line && line !== key) {
    state.lastReaction = line;
    bubble(line);
  }
}

// ── Umpan swing + pindah jendela saat digrab ────────────────────────────
function feedSwing(physX: number, nowMs: number): void {
  if (state.lastPhysT) {
    const dt = Math.max(1, nowMs - state.lastPhysT) / 1000;
    const vx = (physX - state.lastPhysX) / dt; // px/s
    if (state.lastPhysVx !== null) {
      const ax = (vx - state.lastPhysVx) / dt; // px/s²
      state.winAx += (ax - state.winAx) * 0.5; // EMA — kursor native berisik
    }
    state.lastPhysVx = vx;
  }
  state.lastPhysX = physX;
  state.lastPhysT = nowMs;
}

/** Pindahkan jendela pet mengikuti kursor (delta fisik layar). */
async function moveWindowByCursor(phys: { x: number; y: number }): Promise<void> {
  const win = petWin();
  if (!win || !state.dragPhys) return;
  const ndx = phys.x - state.dragPhys.x;
  const ndy = phys.y - state.dragPhys.y;
  if (!ndx && !ndy) return;
  try {
    const o = await winOrigin(true);
    if (!o) return;
    const P = w.__TAURI__?.window?.PhysicalPosition;
    const pos = P ? new P(o.o.x + ndx, o.o.y + ndy) : { x: o.o.x + ndx, y: o.o.y + ndy };
    await win.setPosition(pos);
  } catch {}
}

// ── Event sentuh → reaksi / drag jendela ────────────────────────────────
function handleTouchEvents(events: TouchEvent[], phys: { x: number; y: number } | null): void {
  for (const ev of events) {
    switch (ev.kind) {
      case "grab":
        state.dragPhys = phys;
        state.winAx = 0;
        state.lastPhysT = 0;
        state.lastPhysVx = null;
        reactTo("grab");
        break;
      case "drag":
        if (phys) {
          feedSwing(phys.x, performance.now());
          void moveWindowByCursor(phys);
        }
        break;
      case "boop":
        reactTo("boop");
        break;
      case "pat":
        reactTo("pat");
        break;
      case "release":
        state.dragPhys = null;
        if (ev.grabbed) reactTo("wave"); // lepas — sapa kecil, ayun dari fisika
        break;
    }
  }
}

// ── Jalur sampel utama ───────────────────────────────────────────────────
function onSample(x: number, y: number, down: boolean, tNow: number, phys: { x: number; y: number } | null): void {
  senses.feed({ x, y, down, t: tNow });
  punch.feed(x, y);
  const events = touch.feed(x, y, down, tNow);
  if (events.length) handleTouchEvents(events, phys);
}

async function listenNativeCursor(): Promise<void> {
  const listen = w.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  try {
    await listen("pet://cursor", (e: { payload: { x: number; y: number; down: boolean } }) => {
      void (async () => {
        state.nativeSeen = performance.now();
        const wo = await winOrigin();
        const p = e.payload;
        if (!wo) return;
        const c = physicalToClient(p, wo.o, wo.s);
        onSample(c.x, c.y, !!p.down, performance.now(), { x: p.x, y: p.y });
      })();
    });
  } catch {
    // event tidak tersedia (shell lama) — jalur DOM fallback
  }
}

/** DOM fallback (dev browser ATAU shell tanpa event native): gaze selalu;
 *  touch hanya bila native tidak terlihat dalam 1 dtk terakhir. */
function listenDomPointer(): void {
  window.addEventListener("pointermove", (e) => {
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = (e.clientY / window.innerHeight) * 2 - 1;
    w.__live2dView?.setLookTarget?.(nx, -ny);
    if (performance.now() - state.nativeSeen > 1000) {
      onSample(e.clientX, e.clientY, e.buttons % 2 === 1, performance.now(), null);
    }
  });
  window.addEventListener("pointerdown", (e) => {
    if (performance.now() - state.nativeSeen > 1000) {
      onSample(e.clientX, e.clientY, true, performance.now(), null);
    }
  });
  window.addEventListener("pointerup", (e) => {
    if (performance.now() - state.nativeSeen > 1000) {
      onSample(e.clientX, e.clientY, false, performance.now(), null);
    }
  });
}

// ── Loop frame: sway + swing (SEMUA lokal — tak ada IPC per-frame) ───────
function startFrameLoop(): void {
  let last = performance.now();
  const tick = (): void => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const m = state.model;
    if (m) {
      state.swayT += dt;
      // Swing disuapi akselerasi HANYA saat digrab; setelah lepas ayun
      // mereda sendiri oleh redaman (zeta) — tanpa dorongan baru.
      const st = swingStep(state.swing, {
        axPx: touch.isGrabbing() ? state.winAx : 0,
        heightPx: m.height ?? 400,
        dt,
      });
      state.swing = { phi: st.phi, omega: st.omega };
      m.rotation = Math.sin(state.swayT * 0.9) * 0.012 + st.shownAngle;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── Poll state server (sumber kebenaran klik-tembus) ─────────────────────
function paintThrough(on: boolean): void {
  const b = el("b-through");
  if (!b) return;
  b.classList.toggle("active", on);
  b.textContent = on ? t("petWindow.ctOn") : t("petWindow.ctOff");
}

function startClickThroughPoll(): void {
  setInterval(async () => {
    if (!transport.isEmbedded()) return;
    try {
      const st = await transport.getJson<{ running: boolean; clickThrough: boolean }>("/api/pet/state");
      const on = !!st.clickThrough;
      if (on !== state.clickThrough) {
        state.clickThrough = on;
        applyClickThroughBaseline(on);
      }
      paintThrough(on);
    } catch {}
  }, 1500);
}

/** Baseline ignore saat klik-tembus berubah: ON → menembus penuh (lubang
 * punch akan membuka sendiri saat kursor di atas model); OFF → normal. */
function applyClickThroughBaseline(on: boolean): void {
  if (on) punch.force(true);
  else punch.openInput();
}

// ── Boot ─────────────────────────────────────────────────────────────────
function absUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return transport.apiUrl(String(path).replace(/^\/+/, ""));
}

async function petModelArg(): Promise<string | null> {
  const q = new URLSearchParams(location.search).get("model");
  if (q) return q;
  if (transport.isEmbedded()) {
    const m = await transport.invoke<string>("pet_model");
    if (m) return m;
  }
  return null;
}

async function boot(): Promise<void> {
  await transport.initLoopback().catch(() => null);
  const status = el("status");
  if (status) status.textContent = t("petWindow.loadingModel");
  let path = await petModelArg();
  if (!path) {
    try {
      const d = await transport.getJson<{ models?: string[] }>("/api/models");
      const first = (d.models || [])[0];
      if (first) {
        const dp = await transport.getJson<{ path?: string }>(
          "/api/model/path?name=" + encodeURIComponent(first),
        );
        path = dp.path ?? null;
      }
    } catch {}
  }
  if (!path) {
    if (status) status.textContent = t("petWindow.noModel");
    return;
  }
  await w.__live2dViewWait;
  state.model = await w.__live2dView.loadModel(absUrl(path));
  const m = state.model;
  const nat = m.getBounds();
  const natW = nat.width / m.scale.x;
  const natH = nat.height / m.scale.y;
  const s = Math.min((window.innerWidth * 0.9) / natW, (window.innerHeight * 0.92) / natH);
  m.scale.set(s);
  m.x = (window.innerWidth - natW * s) / 2;
  m.y = (window.innerHeight - natH * s) / 2 - window.innerHeight * 0.03;
  if (status) status.textContent = t("petWindow.active");
  startFrameLoop();
  startIdleChatter();
}

// Sapa berkala kecil (fase 1; fase 2 menggantinya otak ber-budget).
function startIdleChatter(): void {
  const lines = [
    t("petWindow.idle1"), t("petWindow.idle2"), t("petWindow.idle3"),
    t("petWindow.idle4"), t("petWindow.idle5"), t("petWindow.idle6"),
  ].filter((l) => l && !l.startsWith("petWindow."));
  setInterval(() => {
    if (Math.random() < 0.5) {
      const line = pickLine(lines, state.lastReaction);
      if (line) {
        state.lastReaction = line;
        bubble(line);
      }
    }
  }, 90000);
}

// ── Tombol bar ───────────────────────────────────────────────────────────
async function closePet(): Promise<void> {
  try {
    await transport.postJson("/api/pet/close", {});
  } catch {}
  const win = petWin();
  if (win) {
    try { await win.destroy(); } catch {}
  }
  window.close();
}

function wireButtons(): void {
  el("b-wave")?.addEventListener("click", () => reactTo("greet"));
  el("b-talk")?.addEventListener("click", () => {
    const lines = [t("petWindow.talk1"), t("petWindow.talk2"), t("petWindow.talk3")]
      .filter((l) => l && !l.startsWith("petWindow."));
    const line = pickLine(lines);
    if (line) bubble(line);
  });
  const bThrough = el("b-through");
  bThrough?.addEventListener("click", async () => {
    try {
      const d = await transport.postJson<{ clickThrough: boolean }>("/api/pet/clickthrough", {
        on: !bThrough.classList.contains("active"),
      });
      state.clickThrough = !!d.clickThrough;
      applyClickThroughBaseline(state.clickThrough);
      paintThrough(state.clickThrough);
    } catch {}
  });
  if (!transport.isEmbedded() && bThrough) bThrough.hidden = true;
  el("b-close")?.addEventListener("click", () => void closePet());
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") void closePet();
  });
}

wireButtons();
void listenNativeCursor();
listenDomPointer();
startClickThroughPoll();
void boot().catch((e) => {
  // Fail-loud: jendela pet kosong tanpa petunjuk adalah kegagalan senyap.
  w.__petBootError = String((e as Error)?.stack || (e as Error)?.message || e);
  console.error("[pet] boot gagal:", e);
  const status = el("status");
  if (status) status.textContent = t("sys.errGeneric", { msg: (e as Error)?.message });
});
