import { t } from "../i18n/index";
import { connectionPayload, connectionRequest, ROLE_KEYS, type Connection } from "./llm-connections-model";

let closeCurrent: (() => void) | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
}

export function openConnectionEditor(conn: Connection | null, onSaved: () => void): () => void {
  closeCurrent?.();
  const opener = document.activeElement as HTMLElement | null;
  const dialog = el("dialog", "api-editor");
  dialog.setAttribute("aria-labelledby", "api-editor-title");
  const form = el("form", "api-editor-form");
  const header = el("header", "api-editor-head");
  const title = el("h2", "", t(conn ? "api.editTitle" : "api.addTitle"));
  title.id = "api-editor-title";
  const closeButton = el("button", "api-icon-button", "×");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", t("api.closeEditor"));
  header.append(title, closeButton);
  const body = el("div", "api-editor-body");

  function input(type: string, value = "", placeholder = "") {
    const control = el("input");
    control.type = type;
    control.value = value;
    control.placeholder = placeholder;
    return control;
  }
  function field(label: string, control: HTMLElement, hint?: string) {
    const wrapper = el("label", "api-field");
    wrapper.append(el("span", "api-field-label", label), control);
    if (hint) wrapper.append(el("span", "api-help", hint));
    return wrapper;
  }
  const name = input("text", conn?.name || "", t("conn.namePh"));
  name.required = true;
  const provider = el("select");
  for (const [value, key] of [
    ["openai-compatible", "conn.prov.openaiCompat"], ["systemone", "conn.prov.systemone"],
    ["gemini", "conn.prov.gemini"], ["groq", "conn.prov.groq"], ["openai", "conn.prov.openai"],
    ["anthropic", "conn.prov.anthropic"], ["mock", "conn.prov.mock"],
  ]) {
    const option = el("option", "", t(key));
    option.value = value;
    provider.append(option);
  }
  provider.value = conn?.provider || "openai-compatible";
  const baseUrl = input("url", conn?.baseUrl || "", "https://api.example.com/v1");
  const apiKey = input("password", "", t(conn ? "api.keepKey" : "conn.apiKeyPh"));
  apiKey.autocomplete = "new-password";
  const model = input("text", conn?.model || "", t("api.modelPlaceholder"));
  const system = el("textarea");
  system.rows = 3;
  system.value = conn?.systemPrompt || "";
  const maxTokens = input("number", conn?.maxTokens == null ? "" : String(conn.maxTokens), "2048");
  maxTokens.min = "64";
  maxTokens.max = "200000";
  maxTokens.step = "1";
  const temperature = input("number", conn?.temperature == null ? "" : String(conn.temperature), "0.8");
  temperature.min = "0";
  temperature.max = "2";
  temperature.step = "0.1";
  const stream = input("checkbox");
  stream.checked = conn?.stream === true;
  const streamField = el("label", "api-check");
  streamField.append(stream, el("span", "", t("conn.stream")));

  const identity = el("div", "api-field-pair");
  identity.append(field(t("conn.name"), name), field(t("cfg.provider"), provider));
  body.append(identity, field(t("conn.baseUrl"), baseUrl), field(t("cfg.apiKey"), apiKey), field(t("cfg.modelLabel"), model));
  const roles = el("fieldset", "api-role-fields");
  roles.append(el("legend", "", t("conn.roles")), el("p", "api-help", t("api.rolesHint")));
  const roleGrid = el("div", "api-role-grid");
  const roleInputs = new Map<string, HTMLInputElement>();
  for (const [role, key] of Object.entries(ROLE_KEYS)) {
    const checkbox = input("checkbox");
    checkbox.checked = conn?.roles?.includes(role) || false;
    const label = el("label", "api-check");
    label.append(checkbox, el("span", "", t(key)));
    roleGrid.append(label);
    roleInputs.set(role, checkbox);
  }
  roles.append(roleGrid);
  body.append(roles);
  const advanced = el("details", "api-advanced");
  advanced.append(el("summary", "", t("api.advanced")));
  const numbers = el("div", "api-field-pair");
  numbers.append(field(t("api.maxTokens"), maxTokens), field(t("api.temperature"), temperature));
  advanced.append(field(t("conn.systemPrompt"), system, t("conn.systemHint")), numbers, streamField);
  body.append(advanced);
  function syncProvider() {
    advanced.hidden = provider.value === "systemone";
    baseUrl.placeholder = provider.value === "systemone" ? "https://api.typesafe.ai" : "https://api.example.com/v1";
  }
  provider.addEventListener("change", syncProvider);
  syncProvider();

  const error = el("p", "api-notice");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const footer = el("footer", "api-editor-foot");
  const cancel = el("button", "api-button", t("conn.cancel"));
  cancel.type = "button";
  const save = el("button", "api-button api-primary", t("conn.save"));
  save.type = "submit";
  footer.append(cancel, save);
  body.append(error);
  form.append(header, body, footer);
  dialog.append(form);
  document.body.append(dialog);
  const request = new AbortController();
  let closed = false;
  let saving = false;
  function close() {
    if (closed) return;
    closed = true;
    request.abort();
    if (dialog.open) dialog.close();
    dialog.remove();
    if (closeCurrent === close) closeCurrent = null;
    if (opener?.isConnected) opener.focus();
  }
  closeCurrent = close;
  closeButton.addEventListener("click", close);
  cancel.addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    name.setCustomValidity(name.value.trim() ? "" : t("api.nameRequired"));
    if (!form.reportValidity()) return;
    saving = true;
    save.disabled = true;
    save.textContent = t("api.saving");
    error.hidden = true;
    const payload = connectionPayload({
      name: name.value, provider: provider.value, baseUrl: baseUrl.value, apiKey: apiKey.value,
      model: model.value, systemPrompt: system.value, maxTokens: maxTokens.value,
      temperature: temperature.value, stream: stream.checked,
      roles: [...roleInputs].filter(([, checkbox]) => checkbox.checked).map(([role]) => role),
    }, conn?.id || null);
    try {
      await connectionRequest("/api/config", payload, request.signal);
      if (closed) return;
      close();
      onSaved();
    } catch (e) {
      if (closed) return;
      error.textContent = t("api.saveFailed", { error: (e as Error).message });
      error.hidden = false;
      save.disabled = false;
      save.textContent = t("conn.save");
      saving = false;
    }
  });
  name.addEventListener("input", () => name.setCustomValidity(""));
  dialog.showModal();
  name.focus();
  return close;
}
