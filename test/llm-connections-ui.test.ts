import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectionNames, connectionPayload, connectionState, errorSummary, ROLE_KEYS, type EditorValues } from "../src/client/shell/llm-connections-model";
import { DICT_ID } from "../src/client/i18n/dict-id";
import { DICT_EN } from "../src/client/i18n/dict-en";

const values: EditorValues = {
  name: "Mock lokal", provider: "mock", baseUrl: "", apiKey: "", model: "mock",
  systemPrompt: "", maxTokens: "", temperature: "", stream: false, roles: ["chat"],
};

describe("presentasi koneksi AI", () => {
  test("nonaktif mengalahkan default, error, dan cooldown", () => {
    expect(connectionState({ id: "off", enabled: false, testStatus: "error", rateLimitedUntil: "2999-01-01" })).toBe("disabled");
    expect(connectionState({ id: "missing" })).toBe("disabled");
  });
  test("cooldown hanya tampil sebelum waktu berakhir", () => {
    const conn = { id: "a", enabled: true, rateLimitedUntil: "2026-01-02T00:00:00Z", testStatus: "success" };
    expect(connectionState(conn, Date.parse("2026-01-01"))).toBe("cooldown");
    expect(connectionState(conn, Date.parse("2026-01-03"))).toBe("success");
    expect(connectionState({ ...conn, rateLimitedUntil: "rusak" })).toBe("success");
  });
  test("hasil terakhir dan belum diuji dibedakan tanpa mengklaim terhubung", () => {
    expect(connectionState({ id: "a", enabled: true })).toBe("untested");
    expect(connectionState({ id: "a", enabled: true, lastError: "timeout", testStatus: "success" })).toBe("error");
  });
  test("nama sama diberi identitas stabil agar kandidat dapat dibedakan", () => {
    const list = [{ id: "conn_123456", name: "Router" }, { id: "conn_abcdef", name: "Router" }, { id: "other", name: "Lokal" }];
    const names = connectionNames(list);
    expect(names.get("conn_123456")).toBe("Router · 123456");
    expect(names.get("conn_abcdef")).toBe("Router · abcdef");
    expect(names.get("other")).toBe("Lokal");
  });
  test("error JSON diringkas menjadi pesan, teks biasa tetap tersedia", () => {
    expect(errorSummary('{"error":{"message":"429: Rate limit exceeded"}}')).toBe("429: Rate limit exceeded");
    expect(errorSummary("error sending request\n to localhost")).toBe("error sending request to localhost");
    expect(errorSummary("{rusak")).toBe("{rusak");
  });
});

describe("payload editor koneksi", () => {
  test("tambah mengaktifkan secara eksplisit, edit tidak mengubah enabled", () => {
    expect(connectionPayload(values, null)).toMatchObject({ action: "add", connection: { enabled: true } });
    const edit = connectionPayload(values, "old") as any;
    expect(edit).toMatchObject({ action: "update", id: "old" });
    expect(edit.connection).not.toHaveProperty("enabled");
  });
  test("API key kosong tidak menimpa kunci lama", () => {
    expect((connectionPayload(values, "old") as any).connection).not.toHaveProperty("apiKey");
    expect((connectionPayload({ ...values, apiKey: "  mock-key  " }, "old") as any).connection.apiKey).toBe("mock-key");
  });
  test("angka nol disimpan dan mengosongkan angka mengembalikan default", () => {
    expect((connectionPayload({ ...values, temperature: "0", maxTokens: "8192" }, "old") as any).connection).toMatchObject({ temperature: 0, maxTokens: 8192 });
    expect((connectionPayload(values, "old") as any).connection).toMatchObject({ temperature: null, maxTokens: null });
    expect((connectionPayload(values, null) as any).connection).not.toHaveProperty("maxTokens");
  });
  test("role kosong tetap kosong, bukan menambahkan role khusus secara diam-diam", () => {
    expect((connectionPayload({ ...values, roles: [] }, "old") as any).connection.roles).toEqual([]);
  });
});

describe("kontrak panel baru", () => {
  const repo = join(import.meta.dir, "..");
  test("satu mount, CSS panel dan editor benar-benar dimuat", () => {
    const html = readFileSync(join(repo, "static/index.html"), "utf8");
    expect((html.match(/id="conn-list"/g) || []).length).toBe(1);
    expect(html).toContain('href="css/ai-connections.css"');
    expect(html).not.toContain('id="conn-modal"');
    const legacy = readFileSync(join(repo, "static/js/app.js"), "utf8");
    expect(legacy).not.toContain("function renderConns(");
  });
  test("seluruh copy panel dan editor tersedia dalam kedua bahasa", () => {
    const source = ["llm-routing.ts", "llm-connection-editor.ts"].map((file) => readFileSync(join(repo, "src/client/shell", file), "utf8")).join("\n");
    const keys = [...source.matchAll(/"((?:api|conn|cfg)\.[\w.]+)"/g)].map((match) => match[1]);
    keys.push(...Object.values(ROLE_KEYS), ...["disabled", "cooldown", "error", "success", "untested"].map((state) => `api.state.${state}`));
    for (const key of keys) {
      expect(DICT_ID[key], key).toBeTruthy();
      expect(DICT_EN[key], key).toBeTruthy();
    }
  });
});
