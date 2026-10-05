// transport.test.ts — seam komunikasi frontend↔backend (satu binary).
// Menjaga:
// - dev/browser: derivasi origin (http/https → location.origin; selain itu →
//   fallback literal 8310) — kontrak guard test-api-origin.js.
// - embedded (shell Lumimi): loopback proses-sendiri (port via IPC
//   server_port, default 8310) + domain termigrasi via IPC (modeGet/modeSet,
//   coreVersion) dengan jembatan HTTP sementara.
import { test, expect, afterEach } from "bun:test";
import {
  apiBase,
  apiUrl,
  isEmbedded,
  initLoopback,
  httpBase,
  _resetLoopbackForTest,
} from "../src/client/transport";

const g = globalThis as any;
afterEach(() => {
  delete g.location;
  delete g.__TAURI__;
  delete g.fetch;
  _resetLoopbackForTest();
});

test("apiBase: http → location.origin", () => {
  g.location = { protocol: "http:", origin: "http://127.0.0.1:8312" };
  expect(apiBase()).toBe("http://127.0.0.1:8312");
});

test("apiBase: https → location.origin", () => {
  g.location = { protocol: "https:", origin: "https://lumi.local" };
  expect(apiBase()).toBe("https://lumi.local");
});

test("apiBase: file:// → fallback literal 8310 (dokumented)", () => {
  g.location = { protocol: "file:", origin: "null" };
  expect(apiBase()).toBe("http://127.0.0.1:8310");
});

test("apiBase: origin diturunkan pada port non-8310 (bukan literal)", () => {
  // Server bisa jalan di port mana pun; seam harus ikut, bukan hardcode 8310.
  g.location = { protocol: "http:", origin: "http://127.0.0.1:9999" };
  expect(apiBase()).toBe("http://127.0.0.1:9999");
});

test("apiUrl: gabung path relatif ke base", () => {
  g.location = { protocol: "http:", origin: "http://127.0.0.1:8310" };
  expect(apiUrl("/api/config")).toBe("http://127.0.0.1:8310/api/config");
  expect(apiUrl("api/config")).toBe("http://127.0.0.1:8310/api/config");
});

test("apiUrl: URL absolut dibiarkan apa adanya", () => {
  g.location = { protocol: "http:", origin: "http://127.0.0.1:8310" };
  expect(apiUrl("https://cdn.example/x.png")).toBe("https://cdn.example/x.png");
});

test("isEmbedded: false tanpa __TAURI__, true di shell", () => {
  expect(isEmbedded()).toBe(false);
  g.__TAURI__ = {};
  expect(isEmbedded()).toBe(true);
});

test("embedded: httpBase default loopback:8310 sebelum init", () => {
  g.__TAURI__ = {};
  g.location = { protocol: "https:", origin: "https://tauri.localhost" };
  expect(httpBase()).toBe("http://127.0.0.1:8310");
});

test("embedded: initLoopback membaca port dari IPC server_port (lolos handshake)", async () => {
  g.__TAURI__ = {
    core: {
      invoke: async (cmd: string) => (cmd === "server_port" ? 8317 : undefined),
    },
  };
  g.location = { protocol: "https:", origin: "https://tauri.localhost" };
  g.fetch = async (url: any) => {
    if (String(url) === "http://127.0.0.1:8317/api/version") {
      return new Response(JSON.stringify({ core_version: "0.1.1" }));
    }
    throw new TypeError("Failed to fetch");
  };
  expect(await initLoopback()).toBe(8317);
  expect(httpBase()).toBe("http://127.0.0.1:8317");
  expect(apiBase()).toBe("http://127.0.0.1:8317");
});

test("embedded: initLoopback gagal → null, base tetap default", async () => {
  g.__TAURI__ = {
    core: {
      invoke: async () => {
        throw new Error("denied");
      },
    },
  };
  // Probe fallback harus selalu ter-mock — tanpa ini test menyentuh loopback
  // sungguhan (aturan: tidak ada test yang memanggil jaringan).
  g.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  expect(await initLoopback()).toBeNull();
  expect(httpBase()).toBe("http://127.0.0.1:8310");
});

test("embedded: initLoopback gagal TIDAK di-cache — panggilan berikut mencoba lagi", async () => {
  let portCalls = 0;
  g.__TAURI__ = {
    core: {
      invoke: async (cmd: string) => {
        if (cmd === "server_token") return undefined;
        if (cmd === "server_port") {
          portCalls++;
          if (portCalls === 1) throw new Error("denied");
          return 8317;
        }
        return undefined;
      },
    },
  };
  g.location = { protocol: "https:", origin: "https://tauri.localhost" };
  // Server "belum jalan" saat percobaan pertama — IPC gagal DAN probe kosong.
  let up = false;
  g.fetch = async (url: any) => {
    if (!up) throw new TypeError("Failed to fetch");
    if (String(url) === "http://127.0.0.1:8317/api/version") {
      return new Response(JSON.stringify({ core_version: "0.1.1" }));
    }
    throw new TypeError("Failed to fetch");
  };
  expect(await initLoopback()).toBeNull(); // percobaan 1: IPC gagal, probe kosong
  up = true;
  expect(await initLoopback()).toBe(8317); // percobaan 2: IPC sukses + lolos handshake
  expect(portCalls).toBe(2);
  expect(httpBase()).toBe("http://127.0.0.1:8317");
});

test("embedded: IPC gagal → probe menemukan server kita (/api/version ber-core_version)", async () => {
  const probed: string[] = [];
  g.__TAURI__ = {
    core: {
      invoke: async () => {
        throw new Error("denied");
      },
    },
  };
  g.location = { protocol: "https:", origin: "https://tauri.localhost" };
  g.fetch = async (url: any) => {
    probed.push(String(url));
    if (String(url).startsWith("http://127.0.0.1:8311/")) {
      return new Response(JSON.stringify({ core_version: "0.1.1" }));
    }
    throw new TypeError("Failed to fetch");
  };
  expect(await initLoopback()).toBe(8311);
  expect(probed[0]).toBe("http://127.0.0.1:8310/api/version");
  expect(probed[1]).toBe("http://127.0.0.1:8311/api/version");
  expect(httpBase()).toBe("http://127.0.0.1:8311");
});

test("embedded: probe melewati listener asing (JSON tanpa core_version)", async () => {
  g.__TAURI__ = {
    core: {
      invoke: async () => {
        throw new Error("denied");
      },
    },
  };
  g.location = { protocol: "https:", origin: "https://tauri.localhost" };
  g.fetch = async (url: any) => {
    const s = String(url);
    if (s.startsWith("http://127.0.0.1:8310/")) {
      return new Response(JSON.stringify({ hello: 1 }));
    }
    if (s.startsWith("http://127.0.0.1:8312/")) {
      return new Response(JSON.stringify({ core_version: "0.1.1" }));
    }
    throw new TypeError("Failed to fetch");
  };
  expect(await initLoopback()).toBe(8312);
  expect(httpBase()).toBe("http://127.0.0.1:8312");
});

test("handshake: probe menolak instalasi Lumimi LAIN (instance beda token)", async () => {
  g.__TAURI__ = {
    core: {
      invoke: async (cmd: string) => (cmd === "server_token" ? "lumimi-aaa" : undefined),
    },
  };
  g.location = { protocol: "https:", origin: "https://tauri.localhost" };
  g.fetch = async (url: any) => {
    const s = String(url);
    if (s.startsWith("http://127.0.0.1:8310/")) {
      // Instalasi lain: bentuknya persis server Lumimi, tapi token beda.
      return new Response(JSON.stringify({ core_version: "0.1.1", instance: "lumimi-bbb" }));
    }
    if (s.startsWith("http://127.0.0.1:8313/")) {
      return new Response(JSON.stringify({ core_version: "0.1.1", instance: "lumimi-aaa" }));
    }
    throw new TypeError("Failed to fetch");
  };
  expect(await initLoopback()).toBe(8313);
  expect(httpBase()).toBe("http://127.0.0.1:8313");
});

test("handshake: port dari IPC ternyata bukan server kita → probe cari yang benar", async () => {
  g.__TAURI__ = {
    core: {
      invoke: async (cmd: string) => {
        if (cmd === "server_token") return "lumimi-aaa";
        if (cmd === "server_port") return 8310;
        return undefined;
      },
    },
  };
  g.location = { protocol: "https:", origin: "https://tauri.localhost" };
  g.fetch = async (url: any) => {
    const s = String(url);
    if (s === "http://127.0.0.1:8310/api/version") {
      // Aplikasi asing naik belakangan di port milik shell — jawabannya bukan
      // server Lumimi. Frontend TIDAK BOLEH bicara ke sini.
      return new Response(JSON.stringify({ hello: 1 }));
    }
    if (s === "http://127.0.0.1:8311/api/version") {
      return new Response(JSON.stringify({ core_version: "0.1.1", instance: "lumimi-aaa" }));
    }
    throw new TypeError("Failed to fetch");
  };
  expect(await initLoopback()).toBe(8311);
  expect(httpBase()).toBe("http://127.0.0.1:8311");
});

test("dev/browser tidak pernah probe (origin sudah benar by construction)", async () => {
  let fetched = 0;
  g.location = { protocol: "http:", origin: "http://127.0.0.1:8456" };
  g.fetch = async () => {
    fetched++;
    throw new TypeError("Failed to fetch");
  };
  expect(await initLoopback()).toBeNull();
  expect(fetched).toBe(0);
  expect(httpBase()).toBe("http://127.0.0.1:8456");
});

test("apiFetch: embedded, koneksi gagal → re-resolve & retry sekali di basis baru", async () => {
  g.__TAURI__ = {
    core: { invoke: async (cmd: string) => (cmd === "server_port" ? 8317 : undefined) },
  };
  g.location = { protocol: "https:", origin: "https://tauri.localhost" };
  const urls: string[] = [];
  g.fetch = async (url: any) => {
    const s = String(url);
    if (s === "http://127.0.0.1:8317/api/version") {
      // handshake re-resolve: server baru menjawab sebagai Lumimi
      return new Response(JSON.stringify({ core_version: "0.1.1" }));
    }
    urls.push(s);
    if (s === "http://127.0.0.1:8310/api/config") {
      throw new TypeError("Failed to fetch"); // port default salah
    }
    return new Response("{}", { status: 200 }); // retry di basis baru
  };
  const { transport } = await import("../src/client/transport");
  const r = await transport.fetch("/api/config");
  expect(r.ok).toBe(true);
  expect(urls).toEqual([
    "http://127.0.0.1:8310/api/config",
    "http://127.0.0.1:8317/api/config",
  ]);
});

test("apiFetch: re-resolve tidak mengubah basis → tanpa retry (lempar error awal)", async () => {
  g.__TAURI__ = {
    core: {
      invoke: async () => {
        throw new Error("denied");
      },
    },
  };
  g.location = { protocol: "https:", origin: "https://tauri.localhost" };
  let n = 0;
  g.fetch = async () => {
    n++;
    throw new TypeError("Failed to fetch");
  };
  const { transport } = await import("../src/client/transport");
  await expect(transport.fetch("/api/config")).rejects.toThrow();
  // 1 call awal + 90 probe (semua gagal) — tanpa retry berikutnya.
  expect(n).toBe(91);
});

test("apiFetch: dev/browser gagal koneksi → lempar langsung tanpa re-resolve", async () => {
  let n = 0;
  g.location = { protocol: "http:", origin: "http://127.0.0.1:8310" };
  g.fetch = async () => {
    n++;
    throw new TypeError("Failed to fetch");
  };
  const { transport } = await import("../src/client/transport");
  await expect(transport.fetch("/api/config")).rejects.toThrow();
  expect(n).toBe(1);
});

test("modeGet/modeSet: embedded via IPC", async () => {
  const seen: any[] = [];
  g.__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        seen.push([cmd, args]);
        if (cmd === "get_mode") return { active: "stage" };
        if (cmd === "set_mode") return { ok: true };
        return undefined;
      },
    },
  };
  const { transport } = await import("../src/client/transport");
  expect(await transport.modeGet()).toEqual({ active: "stage" });
  expect(await transport.modeSet("vtuber")).toEqual({ ok: true });
  expect(seen).toEqual([
    ["get_mode", undefined],
    ["set_mode", { mode: "vtuber" }],
  ]);
});

test("coreVersion: embedded via IPC", async () => {
  g.__TAURI__ = { invoke: async (cmd: string) => (cmd === "core_version" ? "0.1.0" : undefined) };
  const { transport } = await import("../src/client/transport");
  expect(await transport.coreVersion()).toBe("0.1.0");
});

test("modelImportDialog: dev browser → undefined (fallback alur webkitdirectory)", async () => {
  const { transport } = await import("../src/client/transport");
  expect(await transport.modelImportDialog()).toBeUndefined();
});

test("modelImportDialog: embedded → invoke dengan nama preferensi", async () => {
  const seen: any[] = [];
  g.__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        seen.push([cmd, args]);
        if (cmd === "import_model_dialog") {
          return { ok: true, name: "mao_pro", path: "model/mao_pro/mao_pro.model3.json" };
        }
        return undefined;
      },
    },
  };
  const { transport } = await import("../src/client/transport");
  const r = await transport.modelImportDialog("Mao");
  expect(r?.ok).toBe(true);
  expect(r?.name).toBe("mao_pro");
  expect(seen).toEqual([["import_model_dialog", { name: "Mao" }]]);
});

test("modelImportDialog: nama kosong → undefined arg (biar core turunkan dari stem)", async () => {
  const seen: any[] = [];
  g.__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        seen.push([cmd, args]);
        return { ok: false, cancelled: true };
      },
    },
  };
  const { transport } = await import("../src/client/transport");
  expect(await transport.modelImportDialog("")).toEqual({ ok: false, cancelled: true });
  expect(seen).toEqual([["import_model_dialog", { name: undefined }]]);
});

test("modelImportDialog: IPC gagal → undefined (jembatan transisi, bukan throw)", async () => {
  g.__TAURI__ = {
    core: {
      invoke: async () => {
        throw new Error("denied");
      },
    },
  };
  const { transport } = await import("../src/client/transport");
  expect(await transport.modelImportDialog()).toBeUndefined();
});

test("transport: permukaan seam lengkap", async () => {
  const { transport } = await import("../src/client/transport");
  for (const k of ["fetch", "getJson", "postJson", "invoke", "modeGet", "modeSet", "coreVersion", "modelImportDialog", "initLoopback", "httpBase", "isEmbedded"]) {
    expect(typeof (transport as any)[k], k).toBe("function");
  }
});
