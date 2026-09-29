/**
 * shared/config.ts — helper paritas perilaku config events (mirror logika
 * `save_events` di `core/src/config.rs`; dijaga `test/server-parity.test.ts`).
 * Manajemen config produksi sepenuhnya di Rust core — sisa era server TS
 * (ConfigManager + tulis atomik + merge koneksi) sudah dihapus karena tidak
 * pernah diimpor siapa pun setelah `src/server/` dipensiunkan.
 */

export const KNOWN_EVENT_KEYS = ["idleSpeak","idleMs","idleRepeatMs","awaySpeak","returnSpeak","awayHiddenMs","quietMs"];

export function mergeEventsIntoConfig(prev: any, incoming: any): any {
  const base = (typeof prev === "object" && prev) ? prev : {};
  const merged = Object.assign({}, base.events || {}, incoming || {});
  const clean: Record<string, unknown> = {};
  for (const k of KNOWN_EVENT_KEYS) if (k in merged) (clean as any)[k] = (merged as any)[k];
  return Object.assign({}, base, { events: clean });
}
