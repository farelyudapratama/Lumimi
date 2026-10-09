import { apiFetch } from "../transport";

export type Connection = {
  id: string;
  name?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number | null;
  temperature?: number | null;
  stream?: boolean;
  roles?: string[];
  enabled?: boolean;
  testStatus?: string;
  lastError?: string;
  rateLimitedUntil?: string | null;
};

export type Candidate = {
  id: string;
  priority: number;
  match: "explicit" | "wildcard";
  status: "ready" | "cooldown";
  cooldownUntil: string | null;
  lastError: string;
};
export type RolePlan = { role: string; candidates: Candidate[] };
export type ConnectionConfig = { connections: Connection[]; activeId: string | null };
export type ConnectionState = "disabled" | "cooldown" | "error" | "success" | "untested";

export const ROLE_KEYS: Record<string, string> = {
  chat: "api.role.chat",
  assistant: "api.role.assistant",
  motion: "api.role.motion",
  sheet: "api.role.sheet",
  "motion-vision": "api.role.motionVision",
  behavior: "api.role.behavior",
  memory: "api.role.memory",
};

export function connectionState(conn: Connection, now = Date.now()): ConnectionState {
  if (conn.enabled !== true) return "disabled";
  if (conn.rateLimitedUntil && Date.parse(conn.rateLimitedUntil) > now) return "cooldown";
  if (conn.lastError || conn.testStatus === "error") return "error";
  if (conn.testStatus === "success") return "success";
  return "untested";
}

export function connectionNames(conns: Connection[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const c of conns) {
    const name = c.name?.trim() || c.id;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return new Map(conns.map((c) => {
    const name = c.name?.trim() || c.id;
    const suffix = conns.some((other) => other.id !== c.id && other.id.slice(-6) === c.id.slice(-6)) ? c.id : c.id.slice(-6);
    return [c.id, (counts.get(name) || 0) > 1 ? `${name} · ${suffix}` : name];
  }));
}

export function errorSummary(raw: string): string {
  let text = raw;
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof message === "string") text = message;
  } catch {}
  return text.replace(/\s+/g, " ").trim();
}

export type EditorValues = {
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  maxTokens: string;
  temperature: string;
  stream: boolean;
  roles: string[];
};

export function connectionPayload(values: EditorValues, id: string | null): Record<string, unknown> {
  const connection: Record<string, unknown> = {
    name: values.name.trim(),
    provider: values.provider,
    baseUrl: values.baseUrl.trim(),
    model: values.model.trim(),
    systemPrompt: values.systemPrompt,
    stream: values.stream,
    roles: values.roles,
  };
  // Kunci mask tidak pernah dikirim balik; kosong saat edit mempertahankan kunci tersimpan.
  if (values.apiKey.trim()) connection.apiKey = values.apiKey.trim();
  if (!id) connection.enabled = true;
  for (const [key, raw] of [["maxTokens", values.maxTokens], ["temperature", values.temperature]] as const) {
    if (raw.trim() && Number.isFinite(Number(raw))) connection[key] = Number(raw);
    else if (id) connection[key] = null;
  }
  return id ? { action: "update", id, connection } : { action: "add", connection };
}

export async function connectionRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await apiFetch(path, {
    ...(body === undefined ? {} : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    signal,
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(errorSummary(String(data.error || `HTTP ${response.status}`)));
  return data as T;
}
