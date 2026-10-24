// motion-probe.ts — RENCANA backlog Fase 2 (utiliti ringan, bebas render).
//
// Logika analisis probe yang bisa diuji murni. Tangkapan canvas & physics settle
// tetap ada di layer view/UI (karena butuh canvas+renderer); modul ini hanya
// berisi perhitungan diff metrik, cross-check, dan klasifikasi.

export interface BBox { x: number; y: number; w: number; h: number; }
export interface ProbeMetrics {
  bbox: BBox | null;
  changedPixels: number;
  centroid: { x: number; y: number } | null;
  diffRatio: number;
}

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

export interface VlmStructured {
  notes?: string;
  sign?: number;
  side?: "karakter_kiri" | "karakter_kanan" | "tengah" | string;
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

export function crossCheck(vlm: VlmStructured, metrics: ProbeMetrics, frameMarkedLeftX: number, frameMarkedRightX: number): CrossCheckResult {
  const reasons: string[] = [];
  let conflict = false;
  const bbox = metrics.bbox;
  const conf = isNum(vlm.confidence) ? (vlm.confidence as number) : 0.5;

  // Region vs bbox area heuristic (reserved; butan aturan sederhana):
  // kalau bbox kosong tapi VLM klaim ada gerakan → konflik.
  if (!bbox && (vlm.region || "").length > 0) {
    conflict = true;
    reasons.push("bbox kosong tapi VLM mengklaim region bergerak");
  }
  // Side: centroid kiri/kanan layar vs side klaim.
  if (bbox && metrics.centroid) {
    const cx = metrics.centroid.x;
    const isLeft = cx < (frameMarkedLeftX + frameMarkedRightX) / 2;
    if (vlm.side === "karakter_kiri" && !isLeft) { conflict = true; reasons.push("side karakter_kiri tapi centroid di layar kanan"); }
    if (vlm.side === "karakter_kanan" && isLeft) { conflict = true; reasons.push("side karakter_kanan tapi centroid di layar kiri"); }
  }
  // Sign: arah centroid vs sign? Placeholder: jika centroid bergerak ke kanan dan sign -1 → konflik ringan.
  // (Logika penuh butuh dua snapshot; disediakan hook di sini untuk pengembangan.)
  const confidence = conflict ? Math.max(0.1, conf - 0.3) : conf;
  return { conflict, reasons, confidence };
}

function isNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }

export function classifyDead(changedPixels: number, threshold = 8): boolean {
  return changedPixels < threshold;
}

export default { bboxFromDiff, centroidFromDiff, diffRatio, crossCheck, classifyDead };