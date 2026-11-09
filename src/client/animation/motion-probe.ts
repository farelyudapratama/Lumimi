// motion-probe.ts — logika murni analisis probe (bebas render, teruji unit).
//
// Tangkapan canvas & physics settle tetap di layer view/harness (butuh
// canvas+renderer); modul ini hanya perhitungan diff metrik, signature frame
// (deteksi konvergensi settle), cross-check VLM ↔ piksel, dan klasifikasi.

export interface BBox { x: number; y: number; w: number; h: number; }
export interface ProbeMetrics {
  bbox: BBox | null;
  changedPixels: number;
  centroid: { x: number; y: number } | null;
  diffRatio: number;
}
/** Bbox konten model di koordinat frame capture (dipakai normalisasi
 *  cross-check — fraksi tinggi/lebar konten, bukan koordinat model). */
export interface ContentBox { x: number; y: number; w: number; h: number; }

export function bboxFromDiff(diffAlpha: Uint8ClampedArray | number[], width: number, height: number): BBox | null {
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4 + 3; // alpha channel
      const a = diffAlpha[i] ?? 0;
      if (a > 16) {
        count++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (count === 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function centroidFromDiff(diffAlpha: Uint8ClampedArray | number[], width: number, height: number): { x: number; y: number } | null {
  let sx = 0, sy = 0, w = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = (diffAlpha[(y * width + x) * 4 + 3] ?? 0);
      if (a > 16) { sx += x * a; sy += y * a; w += a; }
    }
  }
  if (w === 0) return null;
  return { x: sx / w, y: sy / w };
}

export function diffRatio(changedPixels: number, totalPixels: number): number {
  if (totalPixels <= 0) return 0;
  return Math.max(0, Math.min(1, changedPixels / totalPixels));
}

/** Signature grayscale ringan (1 byte/piksel) dari ImageData — dipakai harness
 *  untuk mendeteksi konvergensi settle antar frame tanpa menyimpan piksel
 *  penuh. Murni, teruji unit. */
export function signatureFromImageData(img: ImageData): Uint8Array {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = ((img.data[o] + img.data[o + 1] + img.data[o + 2]) / 3) | 0;
  }
  return out;
}

/** Rerata selisih absolut dua signature (0..255). Panjang beda/nol → 255
 *  (dianggap beda total — pemanggil menganggap belum konvergen). */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length === 0 || a.length !== b.length) return 255;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

export interface VlmStructured {
  notes?: string;
  sign?: number;
  /** Sisi GAMBAR tempat perubahan terlihat — layar_kiri/layar_kanan/tengah
   *  (sudut pandang penonton; nilai karakter_* menunggu info arah hadap
   *  model dan TIDAK dicek cross-check). */
  side?: string;
  region?: string;
  coupled_with?: string[];
  safe_range?: [number, number];
  confidence?: number;
}

export interface CrossCheckResult {
  conflict: boolean;
  reasons: string[];
  confidence: number;
}

/** Pita vertikal kira-kira tiap region — fraksi tinggi KONTEN model di frame
 *  (relatif bbox konten, bukan koordinat model: model-agnostic). Longgar by
 *  design: penangkap salah label kasar, bukan klaim anatomi presisi. */
const REGION_BANDS: Record<string, [number, number]> = {
  rambut: [0.0, 0.32],
  kepala: [0.0, 0.38],
  mata: [0.04, 0.42],
  mulut: [0.1, 0.52],
  badan: [0.3, 1.0],
  tangan: [0.22, 1.0],
};
const BAND_MARGIN = 0.15;

/** Cross-check VLM ↔ metrik piksel (Fase 2e):
 *  - bbox kosong tapi VLM klaim region bergerak → konflik;
 *  - region vs pita vertikal centroid perubahan (klaim "badan" tapi piksel
 *    berubah di 5% tinggi konten → konflik);
 *  - side layar_* vs posisi centroid terhadap garis tengah konten.
 *  `content` = bbox konten model di koordinat frame capture (disediakan
 *  harness di tiap metrik frame). Side karakter_* TIDAK dicek — butuh info
 *  arah hadap model, bukan asumsi. */
export function crossCheck(vlm: VlmStructured, metrics: ProbeMetrics, content?: ContentBox | null): CrossCheckResult {
  const reasons: string[] = [];
  let conflict = false;
  const bbox = metrics.bbox;
  const conf = isNum(vlm.confidence) ? (vlm.confidence as number) : 0.5;

  // bbox kosong tapi klaim ada gerakan → konflik ("tidak_terlihat" bukan klaim).
  const region = (vlm.region || "").trim();
  if (!bbox && region.length > 0 && region !== "tidak_terlihat") {
    conflict = true;
    reasons.push("bbox kosong tapi VLM mengklaim region bergerak");
  }

  const cx = metrics.centroid?.x;
  const cy = metrics.centroid?.y;
  if (content && content.w > 0 && content.h > 0 && cx != null && cy != null) {
    // Region vs pita vertikal (centroid di luar konten → skip, bukan konflik).
    const ny = (cy - content.y) / content.h;
    const band = REGION_BANDS[region.toLowerCase()];
    if (band && ny >= 0 && ny <= 1) {
      if (ny < band[0] - BAND_MARGIN || ny > band[1] + BAND_MARGIN) {
        conflict = true;
        reasons.push(`region ${region} tapi pusat perubahan di ${Math.round(ny * 100)}% tinggi konten`);
      }
    }
    // Side layar (sudut pandang penonton — tanpa asumsi arah hadap model).
    const mid = content.x + content.w / 2;
    if (vlm.side === "layar_kiri" && cx > mid) {
      conflict = true;
      reasons.push("side layar_kiri tapi centroid di kanan tengah konten");
    }
    if (vlm.side === "layar_kanan" && cx < mid) {
      conflict = true;
      reasons.push("side layar_kanan tapi centroid di kiri tengah konten");
    }
  }

  const confidence = conflict ? Math.max(0.1, conf - 0.3) : conf;
  return { conflict, reasons, confidence };
}

function isNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }

export function classifyDead(changedPixels: number, threshold = 8): boolean {
  return changedPixels < threshold;
}

/** Param mati relatif NOISE FLOOR: sweep harus melampaui k× lantai noise
 *  (sway physics sisa antar dua capture pose sama) ATAU ambang dasar —
 *  tanpa ini, getar rambut sisa membuat param hidup salah dianggap mati
 *  (sebaliknya floor tinggi menuntut perubahan lebih besar). */
export function classifyDeadWithFloor(changedPixels: number, noiseFloor: number, k = 3, base = 8): boolean {
  const threshold = Math.max(base, k * Math.max(0, noiseFloor));
  return changedPixels < threshold;
}

export default {
  bboxFromDiff, centroidFromDiff, diffRatio, crossCheck, classifyDead,
  classifyDeadWithFloor, signatureFromImageData, meanAbsDiff,
};
