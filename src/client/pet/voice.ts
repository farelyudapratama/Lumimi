/**
 * pet/voice — perekam press-to-talk (getUserMedia → AudioWorklet → Float32).
 *
 * TIDAK mengirim audio ke mana pun di sini: hasilnya Uint8Array WAV yang
 * dikirim pemanggil ke /api/stt (whisper in-process loopback 127.0.0.1 —
 * proses lokal, bukan jaringan; provider cloud HANYA bila user memilihnya
 * sadar, aturan repo). AudioWorklet dimuat dari Blob URL agar halaman pet
 * tetap satu file logika tanpa aset tambahan.
 */

import { concatFloat32, encodeWav } from "./wav";

export interface Recorder {
  /** Mulai rekam (mic nyala). Gagal → melempar (pemanggil menampilkan i18n). */
  start(): Promise<void>;
  /** Berhenti + kembalikan WAV PCM16 mono (null bila tak pernah start). */
  stop(): Promise<{ wav: Uint8Array; sampleRate: number } | null>;
  /** Mic sedang nyala? */
  isOn(): boolean;
}

/** Worklet: kumpulkan buffer input, kirim ke main thread (transfer). */
const WORKLET_SRC = `
class PetCollector extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor("pet-collector", PetCollector);
`;

export function createRecorder(opts: { sampleRate?: number } = {}): Recorder {
  const targetRate = opts.sampleRate ?? 16000;
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let chunks: Float32Array[] = [];
  let on = false;

  return {
    isOn() {
      return on;
    },
    async start(): Promise<void> {
      if (on) return;
      chunks = [];
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      ctx = new AudioContext({ sampleRate: targetRate });
      const url = URL.createObjectURL(
        new Blob([WORKLET_SRC], { type: "application/javascript" }),
      );
      try {
        await ctx.audioWorklet.addModule(url);
        const node = new AudioWorkletNode(ctx, "pet-collector");
        node.port.onmessage = (e: MessageEvent) => {
          if (on && e.data instanceof Float32Array) chunks.push(e.data);
        };
        ctx.createMediaStreamSource(stream).connect(node);
        // Worklet tidak ke destination (mic tidak di-echo ke speaker).
      } finally {
        URL.revokeObjectURL(url);
      }
      on = true;
    },
    async stop(): Promise<{ wav: Uint8Array; sampleRate: number } | null> {
      if (!on || !ctx) return null;
      on = false;
      const rate = ctx.sampleRate;
      try {
        await ctx.close();
      } catch {}
      ctx = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      return { wav: encodeWav(concatFloat32(chunks), rate), sampleRate: rate };
    },
  };
}
