/** Control plane Browser pada tab teknis; DOM aman tanpa innerHTML. */
import type { BrowserState } from "../../shared/browser-types";
import { apiUrl } from "../transport";
import { t } from "../i18n/index";

const DEFAULT_URL = "https://example.com";

type PointRect = { left: number; top: number; width: number; height: number };
type PendingNav = { path: "/api/browser/open" | "/api/browser/navigate"; url: string };

export function normalizeAddress(raw: string): string {
  const text = String(raw || "").trim();
  if (!text) return DEFAULT_URL;
  return new URL(/^https?:\/\//i.test(text) ? text : "https://" + text).href;
}

export function previewPoint(clientX: number, clientY: number, rect: PointRect): { x: number; y: number } | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || rect.width <= 0 || rect.height <= 0) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function post(path: string, body: object): Promise<any> {
  const response = await fetch(apiUrl(path), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function isVisible(root: HTMLElement): boolean {
  return root.offsetParent !== null && !root.closest(".hidden");
}

function mountBrowserPanel(root: HTMLElement): () => void {
  if (root.dataset.mounted === "1") return () => {};
  root.dataset.mounted = "1";
  root.className = "br-panel";

  const toolbar = el("div", "br-toolbar");
  const back = el("button", "br-icon", "‹");
  const forward = el("button", "br-icon", "›");
  const reload = el("button", "br-icon", "↻");
  const address = el("input", "br-address") as HTMLInputElement;
  const go = el("button", "br-btn", t("browser.go"));
  for (const [button, key] of [[back, "browser.back"], [forward, "browser.forward"], [reload, "browser.reload"]] as const) {
    button.type = "button";
    button.title = t(key);
  }
  address.type = "url";
  address.placeholder = t("browser.addressPh");
  address.setAttribute("aria-label", t("browser.addressPh"));
  toolbar.append(back, forward, reload, address, go);

  const meta = el("div", "br-meta");
  const title = el("strong", "br-title", t("browser.closed"));
  const badges = el("span", "br-badges");
  const engine = el("span", "br-badge", "—");
  const connection = el("span", "br-badge", t("browser.closed"));
  const grant = el("span", "br-badge hidden", t("browser.granted"));
  badges.append(engine, connection, grant);
  meta.append(title, badges);

  const actions = el("div", "br-actions");
  const open = el("button", "br-btn", t("browser.open"));
  const focus = el("button", "br-btn", t("browser.focus"));
  const close = el("button", "br-btn br-danger", t("browser.close"));
  const allow = el("button", "br-btn br-allow hidden", t("browser.allowPrivate"));
  actions.append(open, focus, close, allow);

  const notice = el("div", "br-notice", t("browser.closedHint"));
  notice.setAttribute("aria-live", "polite");
  const preview = el("div", "br-preview");
  const image = el("img", "br-image") as HTMLImageElement;
  image.alt = t("browser.previewAlt");
  image.draggable = false;
  const placeholder = el("div", "br-placeholder", t("browser.previewEmpty"));
  preview.append(image, placeholder);
  const footer = el("div", "br-preview-foot");
  const previewLabel = el("span", "", t("browser.preview"));
  const timestamp = el("time", "", t("browser.previewNever"));
  footer.append(previewLabel, timestamp);
  root.append(toolbar, meta, actions, allow, notice, preview, footer);

  let destroyed = false;
  let busy = false;
  let running = false;
  let connected = false;
  let objectUrl: string | null = null;
  let pending: PendingNav | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let screenshotTimer: ReturnType<typeof setInterval> | null = null;
  let observer: MutationObserver | null = null;

  function setNotice(text: string, error = false): void {
    notice.textContent = text;
    notice.classList.toggle("error", error);
  }

  function setState(state: BrowserState): void {
    running = state.running;
    connected = state.connected;
    back.disabled = !state.canBack;
    forward.disabled = !state.canForward;
    focus.disabled = !state.running;
    close.disabled = !state.running;
    engine.textContent = state.engine ? state.engine.toUpperCase() : t("browser.noEngine");
    connection.textContent = state.connected ? t("browser.connected") : state.running ? t("browser.disconnected") : t("browser.closed");
    grant.classList.toggle("hidden", !state.originGranted);
    title.textContent = state.title || state.url || (state.available ? t("browser.closed") : t("browser.unavailable"));
    if (state.url && document.activeElement !== address) address.value = state.url;
    if (!state.available) setNotice(t("browser.unavailableHint"), true);
    else if (!state.running) setNotice(t("browser.closedHint"));
    else if (!state.connected) setNotice(t("browser.disconnectedHint"), true);
    else if (state.error) setNotice(state.error, true);
    else setNotice(t("browser.liveHint"));
  }

  async function refreshStatus(): Promise<void> {
    if (!isVisible(root) || destroyed) return;
    try {
      const response = await fetch(apiUrl("/api/browser/status"), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setState(await response.json());
    } catch (error) {
      setNotice(t("browser.statusFailed", { msg: error instanceof Error ? error.message : String(error) }), true);
    }
  }

  async function refreshScreenshot(): Promise<void> {
    if (!isVisible(root) || destroyed || busy || !connected) return;
    try {
      const response = await fetch(apiUrl(`/api/browser/screenshot?format=jpeg&quality=70&_=${Date.now()}`), { cache: "no-store" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const next = URL.createObjectURL(blob);
      const previous = objectUrl;
      objectUrl = next;
      image.onload = null;
      image.src = next;
      if (previous) URL.revokeObjectURL(previous);
      image.classList.add("ready");
      placeholder.classList.add("hidden");
      const raw = Number(response.headers.get("X-Browser-Timestamp")) || Date.now();
      timestamp.dateTime = new Date(raw).toISOString();
      timestamp.textContent = t("browser.previewAt", { time: new Date(raw).toLocaleTimeString() });
    } catch (error) {
      image.classList.remove("ready");
      placeholder.classList.remove("hidden");
      placeholder.textContent = t("browser.previewStale");
      timestamp.textContent = t("browser.previewDisconnected");
    }
  }

  async function run(action: () => Promise<any>): Promise<void> {
    if (busy) return;
    busy = true;
    root.classList.add("busy");
    try {
      const state = await action();
      pending = null;
      allow.classList.add("hidden");
      if (state && typeof state === "object" && "available" in state) setState(state as BrowserState);
      await refreshStatus();
      await refreshScreenshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const approval = /origin privat memerlukan persetujuan user/i.test(message);
      allow.classList.toggle("hidden", !approval || !pending);
      setNotice(message, true);
    } finally {
      busy = false;
      root.classList.remove("busy");
    }
  }

  function requestedUrl(): string {
    try { return normalizeAddress(address.value); }
    catch { throw new Error(t("browser.invalidUrl")); }
  }

  function navigate(): void {
    let url: string;
    try { url = requestedUrl(); } catch (error) { setNotice(String((error as Error).message), true); return; }
    const path: PendingNav["path"] = running ? "/api/browser/navigate" : "/api/browser/open";
    pending = { path, url };
    void run(() => post(path, { url }));
  }

  back.addEventListener("click", () => void run(() => post("/api/browser/history", { action: "back" })));
  forward.addEventListener("click", () => void run(() => post("/api/browser/history", { action: "forward" })));
  reload.addEventListener("click", () => void run(() => post("/api/browser/history", { action: "reload" })));
  go.addEventListener("click", navigate);
  open.addEventListener("click", () => {
    let url: string;
    try { url = requestedUrl(); } catch (error) { setNotice(String((error as Error).message), true); return; }
    pending = { path: "/api/browser/open", url };
    void run(() => post("/api/browser/open", { url }));
  });
  address.addEventListener("keydown", (event) => { if (event.key === "Enter") navigate(); });
  focus.addEventListener("click", () => void run(() => post("/api/browser/focus", {})));
  close.addEventListener("click", () => void run(() => post("/api/browser/close", {})));
  allow.addEventListener("click", () => {
    if (!pending) return;
    const retry = pending;
    let origin: string;
    try { origin = new URL(retry.url).origin; } catch { setNotice(t("browser.invalidUrl"), true); return; }
    void run(async () => {
      await post("/api/browser/grant", { origin });
      return post(retry.path, { url: retry.url });
    });
  });
  image.addEventListener("click", (event) => {
    const point = previewPoint(event.clientX, event.clientY, image.getBoundingClientRect());
    if (point) void run(() => post("/api/browser/point", point));
  });

  function syncPolling(): void {
    if (!isVisible(root) || destroyed) return;
    void refreshStatus();
    void refreshScreenshot();
  }
  observer = new MutationObserver(syncPolling);
  observer.observe(root.parentElement ?? root, { attributes: true, attributeFilter: ["class", "style", "hidden"] });
  statusTimer = setInterval(() => void refreshStatus(), 2_000);
  screenshotTimer = setInterval(() => void refreshScreenshot(), 3_000);
  syncPolling();

  return () => {
    destroyed = true;
    observer?.disconnect();
    if (statusTimer) clearInterval(statusTimer);
    if (screenshotTimer) clearInterval(screenshotTimer);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    root.replaceChildren();
    delete root.dataset.mounted;
  };
}

export function startBrowserPanel(): () => void {
  const root = document.getElementById("as-browser-root");
  return root ? mountBrowserPanel(root) : () => {};
}

