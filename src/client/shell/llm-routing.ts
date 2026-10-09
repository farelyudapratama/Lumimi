import { getLang, t } from "../i18n/index";
import { openConnectionEditor } from "./llm-connection-editor";
import {
  connectionNames, connectionRequest, connectionState, errorSummary, ROLE_KEYS,
  type Connection, type ConnectionConfig, type RolePlan,
} from "./llm-connections-model";

let activeDestroy: (() => void) | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
}
function button(text: string, action: () => void, cls = "api-button") {
  const node = el("button", cls, text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}
function roleName(role: string) { return ROLE_KEYS[role] ? t(ROLE_KEYS[role]) : role; }
function timeLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString(getLang(), { hour: "2-digit", minute: "2-digit" }) : value;
}

export function startLlmRouting(): () => void {
  activeDestroy?.();
  const host = document.getElementById("conn-list");
  if (!host) return () => {};
  host.className = "api-management";
  const pane = host.closest(".tab-pane");
  const drawer = host.closest("#controls-panel");
  const header = el("header", "api-header");
  const heading = el("h2", "api-heading", t("cfg.connTitle"));
  const count = el("p", "api-help");
  const titleGroup = el("div");
  titleGroup.append(heading, count);
  let editorClose: (() => void) | null = null;
  const add = button(t("api.add"), () => {
    editorClose = openConnectionEditor(null, () => { void refresh(true); });
  }, "api-button api-primary");
  header.append(titleGroup, add);
  const tabs = el("div", "api-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", t("api.sections"));
  const connectionPanel = el("div", "api-connections");
  connectionPanel.id = "api-connections-panel";
  connectionPanel.setAttribute("role", "tabpanel");
  connectionPanel.setAttribute("aria-labelledby", "api-connections-tab");
  const routingPanel = el("div", "api-routes");
  routingPanel.id = "api-routes-panel";
  routingPanel.setAttribute("role", "tabpanel");
  routingPanel.setAttribute("aria-labelledby", "api-routes-tab");
  const views = [connectionPanel, routingPanel];
  const tabButtons = ["api.connections", "api.routing"].map((key, index) => {
    const tab = button(t(key), () => selectView(index), "api-tab");
    tab.id = index ? "api-routes-tab" : "api-connections-tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", views[index].id);
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
      selectView(next);
      tabButtons[next].focus();
    });
    return tab;
  });
  function selectView(index: number) {
    tabButtons.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      views[i].hidden = i !== index;
    });
  }
  tabs.append(...tabButtons);
  const notice = el("div", "api-notice");
  notice.hidden = true;
  notice.setAttribute("role", "status");
  const list = el("div", "api-connection-list");
  connectionPanel.append(list);
  list.append(el("p", "api-empty", t("api.loading")));
  const routingHint = el("p", "api-help api-route-hint", t("api.routingHint"));
  const routeList = el("div", "api-route-list");
  routingPanel.append(routingHint, routeList);
  routeList.append(el("p", "api-empty", t("api.loadingRoutes")));
  host.replaceChildren(header, tabs, notice, connectionPanel, routingPanel);
  selectView(0);

  let alive = true;
  let busy = false;
  let inFlight = false;
  let revision = 0;
  let timer = 0;
  let controller: AbortController | null = null;
  let config: ConnectionConfig = { connections: [], activeId: null };
  let names = new Map<string, string>();
  let routeSignature = "";
  const cards = new Map<string, { signature: string; node: HTMLElement }>();
  const lifetime = new AbortController();
  function visible() { return !document.hidden && host!.getClientRects().length > 0; }
  function message(text: string, error = false) {
    notice.replaceChildren(el("span", "", text));
    notice.dataset.kind = error ? "error" : "success";
    notice.hidden = false;
  }
  function formatRoles(conn: Connection) {
    const roles = conn.roles || [];
    if (!roles.length) return t("api.allRoles");
    return roles.length > 2 ? t("api.roleCount", { count: roles.length }) : roles.map(roleName).join(", ");
  }

  function createCard(conn: Connection): HTMLElement {
    const name = names.get(conn.id) || conn.id;
    const state = connectionState(conn);
    const row = el("article", "api-connection");
    row.dataset.id = conn.id;
    row.dataset.state = state;
    const toggle = el("button", "api-toggle");
    toggle.type = "button";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(conn.enabled === true));
    toggle.setAttribute("aria-label", t("api.enable", { name }));
    toggle.append(el("span", "api-toggle-track"));
    toggle.addEventListener("click", () => {
      void mutate(toggle, { action: "update", id: conn.id, connection: { enabled: conn.enabled !== true } }, t(conn.enabled === true ? "api.disabledNotice" : "api.enabledNotice", { name }));
    });
    const details = el("details", "api-connection-details");
    const summary = el("summary", "api-connection-summary");
    summary.setAttribute("aria-label", t("api.detailsFor", { name }));
    const top = el("span", "api-row-top");
    const identity = el("span", "api-identity");
    identity.append(el("strong", "api-name", name));
    if (conn.id === config.activeId) identity.append(el("span", "api-default", t("api.default")));
    const status = el("span", "api-state", t(`api.state.${state}`));
    status.dataset.state = state;
    top.append(identity, status, el("span", "api-chevron"));
    const model = el("span", "api-model", conn.model || conn.provider || t("api.modelUnset"));
    model.title = [conn.provider, conn.model].filter(Boolean).join(" · ");
    const meta = el("span", "api-row-meta");
    meta.append(model, el("span", "api-role-summary", formatRoles(conn)));
    summary.append(top, meta);
    const body = el("div", "api-connection-body");
    const info = el("dl", "api-info");
    const datum = (label: string, value: string) => info.append(el("dt", "", label), el("dd", "", value));
    datum(t("cfg.provider"), conn.provider || t("api.unspecified"));
    datum(t("cfg.modelLabel"), conn.model || t("api.modelUnset"));
    datum(t("conn.roles"), conn.roles?.length ? conn.roles.map(roleName).join(", ") : t("api.allRoles"));
    if (conn.id === config.activeId) body.append(el("p", "api-help", t("api.defaultHint")));
    if (conn.rateLimitedUntil && Date.parse(conn.rateLimitedUntil) > Date.now()) datum(t("api.cooldownUntil"), timeLabel(conn.rateLimitedUntil));
    body.append(info);
    if (conn.lastError) {
      const errorDetails = el("details", "api-error-details");
      errorDetails.append(el("summary", "", t("api.errorDetail")), el("p", "api-error-message", errorSummary(conn.lastError)));
      body.append(errorDetails);
    }
    const actions = el("div", "api-actions");
    const edit = button(t("conn.edit"), () => {
      editorClose = openConnectionEditor(conn, () => { void refresh(true); });
    });
    const test = button(t("conn.test"), () => { void testConnection(conn, test); });
    const setDefault = button(t("api.setDefault"), () => { void mutate(setDefault, { action: "setActive", id: conn.id }, t("api.defaultNotice", { name })); });
    setDefault.disabled = conn.id === config.activeId;
    const deletion = el("div", "api-delete-confirm");
    deletion.hidden = true;
    const deleteButton = button(t("conn.delete"), () => { deletion.hidden = false; cancel.focus(); }, "api-button api-danger");
    const cancel = button(t("conn.cancel"), () => { deletion.hidden = true; deleteButton.focus(); });
    const confirm = button(t("api.confirmDelete"), () => { void mutate(confirm, { action: "delete", id: conn.id }, t("api.deletedNotice", { name })); }, "api-button api-danger");
    deletion.append(el("p", "", t("api.deleteQuestion", { name })), cancel, confirm);
    actions.append(edit, test, setDefault, deleteButton);
    body.append(actions, deletion);
    details.append(summary, body);
    row.append(toggle, details);
    return row;
  }

  function renderConnections(next: ConnectionConfig) {
    config = next;
    names = connectionNames(next.connections);
    count.textContent = t("api.count", { enabled: next.connections.filter((c) => c.enabled === true).length, total: next.connections.length });
    const ids = new Set(next.connections.map((c) => c.id));
    for (const [id, card] of cards) {
      if (ids.has(id)) continue;
      if (card.node.contains(document.activeElement)) add.focus();
      card.node.remove();
      cards.delete(id);
    }
    if (!next.connections.length) {
      list.replaceChildren(el("p", "api-empty", t("api.empty")));
      return;
    }
    list.querySelector(":scope > .api-empty")?.remove();
    next.connections.forEach((conn, index) => {
      const signature = JSON.stringify([conn, names.get(conn.id), conn.id === next.activeId, connectionState(conn), getLang()]);
      const old = cards.get(conn.id);
      let node = old?.node;
      if (!old || old.signature !== signature) {
        node = createCard(conn);
        if (old) {
          const open = old.node.querySelector("details")?.open || false;
          const errorOpen = old.node.querySelector<HTMLDetailsElement>(".api-error-details")?.open || false;
          node.querySelector("details")!.open = open;
          const errorDetails = node.querySelector<HTMLDetailsElement>(".api-error-details");
          if (errorDetails) errorDetails.open = errorOpen;
          const focused = old.node.contains(document.activeElement);
          old.node.replaceWith(node);
          if (focused) node.querySelector("summary")?.focus();
        }
        cards.set(conn.id, { signature, node });
      }
      if (list.children[index] !== node) list.insertBefore(node!, list.children[index] || null);
    });
  }

  function renderRoutes(plans: RolePlan[]) {
    const signature = JSON.stringify([plans, [...names], getLang()]);
    if (signature === routeSignature) return;
    routeSignature = signature;
    const openRoles = new Set([...routeList.querySelectorAll<HTMLDetailsElement>("details[open]")].map((node) => node.dataset.role));
    routeList.replaceChildren(...plans.map((plan) => {
      const details = el("details", "api-route");
      details.dataset.role = plan.role;
      details.open = openRoles.has(plan.role);
      const summary = el("summary");
      summary.setAttribute("aria-label", t("api.routeFor", { role: roleName(plan.role) }));
      const primary = plan.candidates[0];
      summary.append(el("span", "api-route-role", roleName(plan.role)));
      const routeName = el("span", "api-route-name", primary ? names.get(primary.id) || primary.id : t("api.noCandidates"));
      summary.append(routeName);
      if (plan.candidates.length > 1) summary.append(el("span", "api-fallback-count", `+${plan.candidates.length - 1}`));
      summary.append(el("span", "api-chevron"));
      const body = el("div", "api-route-body");
      if (!primary) body.append(el("p", "api-help", t("api.noCandidatesHint")));
      const ordered = el("ol", "api-candidates");
      for (const candidate of plan.candidates) {
        const row = el("li");
        row.append(el("strong", "", names.get(candidate.id) || candidate.id));
        row.append(el("span", "api-help", t(candidate.match === "explicit" ? "api.explicit" : "api.wildcard")));
        if (candidate.status === "cooldown") row.append(el("span", "api-help", t("api.routeCooldown", { time: candidate.cooldownUntil ? timeLabel(candidate.cooldownUntil) : t("api.unspecified") })));
        ordered.append(row);
      }
      body.append(ordered);
      details.append(summary, body);
      return details;
    }));
    if (!plans.length) routeList.append(el("p", "api-empty", t("api.noRoutes")));
  }

  async function mutate(control: HTMLButtonElement, payload: unknown, success: string) {
    if (busy) return;
    busy = true;
    revision++;
    controller?.abort();
    control.disabled = true;
    try {
      await connectionRequest("/api/config", payload, lifetime.signal);
      if (!alive) return;
      message(success);
    } catch (error) {
      if (alive) message(t("api.actionFailed", { error: (error as Error).message }), true);
    } finally {
      busy = false;
      if (alive) { control.disabled = false; void refresh(true); }
    }
  }
  async function testConnection(conn: Connection, control: HTMLButtonElement) {
    if (busy) return;
    busy = true;
    revision++;
    controller?.abort();
    control.disabled = true;
    control.textContent = t("cfg.testing");
    try {
      const response = await connectionRequest<{ valid: boolean; reply?: string }>("/api/test", { connection: conn }, lifetime.signal);
      if (!alive) return;
      message(response.valid ? t("api.testPassed", { name: names.get(conn.id) || conn.id }) : t("api.testFailed", { name: names.get(conn.id) || conn.id }), !response.valid);
    } catch (error) {
      if (alive) message(t("api.testError", { name: names.get(conn.id) || conn.id, error: (error as Error).message }), true);
    } finally {
      busy = false;
      if (alive) { control.disabled = false; control.textContent = t("conn.test"); void refresh(true); }
    }
  }

  async function refresh(force = false): Promise<void> {
    if (!alive || busy || (!force && (!visible() || document.activeElement?.closest("dialog")))) return;
    if (inFlight) { if (force) { revision++; controller?.abort(); } else return; }
    const generation = ++revision;
    controller = new AbortController();
    const signal = controller.signal;
    inFlight = true;
    window.clearTimeout(timer);
    try {
      const [configResult, routingResult] = await Promise.allSettled([
        connectionRequest<ConnectionConfig>("/api/config", undefined, signal),
        connectionRequest<{ roles: RolePlan[] }>("/api/llm/routing", undefined, signal),
      ]);
      if (!alive || signal.aborted || generation !== revision) return;
      if (configResult.status === "fulfilled") {
        renderConnections(configResult.value);
      } else {
        message(t("api.loadFailed"), true);
        notice.append(button(t("api.retry"), () => { void refresh(true); }));
        if (!cards.size) list.replaceChildren(el("p", "api-empty", t("api.noConnectionData")));
      }
      if (routingResult.status === "fulfilled") renderRoutes(routingResult.value.roles);
      else {
        routeSignature = "";
        routeList.replaceChildren(el("p", "api-empty", t("api.routesFailed")), button(t("api.retry"), () => { void refresh(true); }));
      }
    } finally {
      if (generation === revision) inFlight = false;
      if (alive && generation === revision && visible()) timer = window.setTimeout(() => { void refresh(); }, 15000);
    }
  }
  const visibility = () => {
    if (visible()) void refresh();
    else { window.clearTimeout(timer); controller?.abort(); }
  };
  const observer = new MutationObserver(visibility);
  for (const target of [pane, drawer]) if (target) observer.observe(target, { attributes: true, attributeFilter: ["class", "hidden"] });
  document.addEventListener("visibilitychange", visibility);
  void refresh();
  function destroy() {
    alive = false;
    revision++;
    lifetime.abort();
    controller?.abort();
    editorClose?.();
    window.clearTimeout(timer);
    observer.disconnect();
    document.removeEventListener("visibilitychange", visibility);
    host!.replaceChildren();
    if (activeDestroy === destroy) activeDestroy = null;
  }
  activeDestroy = destroy;
  return destroy;
}
