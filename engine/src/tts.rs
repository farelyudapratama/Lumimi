//! Port pipeline SuperTonic (supertonic/core.py::Supertonic.__call__) ke Rust.
//!
//! Urutan 4 ONNX (identik Python):
//!   1. duration_predictor: (text_ids, style_dp, text_mask) → dur[1]
//!   2. text_encoder:       (text_ids, style_ttl, text_mask) → text_emb[1,256,seq]
//!   3. vector_estimator (loop total_step kali, diffusion):
//!        (noisy_latent, text_emb, style_ttl, text_mask, current_step,
//!         total_step, latent_mask) → latent[1,144,T]
//!   4. vocoder:            (latent) → wav[1,samples]
//!
//! Konstanta dari onnx/tts.json:
//!   sample_rate=44100, base_chunk_size=512 (ae), chunk_compress_factor=6 (ttl),
//!   ldim=24 → latent_dim = 24*6 = 144.

use std::path::Path;

use ndarray::{Array, Array1, Array3, IxDyn};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use rand::Rng;

use crate::text::UnicodeProcessor;

// Konstanta model (tetap untuk supertonic-3; dibaca dari tts.json saat load).
const SAMPLE_RATE: u32 = 44100;

pub struct SuperTonic {
    dp: Session,
    text_enc: Session,
    vector_est: Session,
    vocoder: Session,
    proc: UnicodeProcessor,
    sample_rate: u32,
    base_chunk_size: i64,
    chunk_compress_factor: i64,
    ldim: i64,
}

/// Voice style: dua tensor (data flat + bentuk). Bentuk diambil dari file
/// (style_ttl biasanya [1,50,256], style_dp [1,8,16]) — JANGAN hardcode.
pub struct Style {
    pub ttl: Vec<f32>,
    pub ttl_dims: Vec<usize>,
    pub dp: Vec<f32>,
    pub dp_dims: Vec<usize>,
}

impl SuperTonic {
    /// Muat dari direktori model (berisi onnx/ + voice_styles/).
    pub fn load(model_dir: &Path) -> Result<Self, String> {
        let onnx = model_dir.join("onnx");
        let cfg_text = std::fs::read_to_string(onnx.join("tts.json"))
            .map_err(|e| format!("gagal baca tts.json: {e}"))?;
        let cfg: serde_json::Value =
            serde_json::from_str(&cfg_text).map_err(|e| format!("tts.json rusak: {e}"))?;

        let sample_rate = cfg["ae"]["sample_rate"].as_u64().unwrap_or(SAMPLE_RATE as u64) as u32;
        let base_chunk_size = cfg["ae"]["base_chunk_size"].as_i64().unwrap_or(512);
        let chunk_compress_factor = cfg["ttl"]["chunk_compress_factor"].as_i64().unwrap_or(6);
        let ldim = cfg["ttl"]["latent_dim"].as_i64().unwrap_or(24);

        let indexer_text = std::fs::read_to_string(onnx.join("unicode_indexer.json"))
            .map_err(|e| format!("gagal baca unicode_indexer.json: {e}"))?;
        let proc = UnicodeProcessor::from_indexer_json(&indexer_text)?;

        let mk = |name: &str| -> Result<Session, String> {
            Session::builder()
                .map_err(|e| format!("session builder: {e}"))?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|e| format!("opt level: {e}"))?
                .commit_from_file(onnx.join(name))
                .map_err(|e| format!("gagal muat {name}: {e}"))
        };

        Ok(Self {
            dp: mk("duration_predictor.onnx")?,
            text_enc: mk("text_encoder.onnx")?,
            vector_est: mk("vector_estimator.onnx")?,
            vocoder: mk("vocoder.onnx")?,
            proc,
            sample_rate,
            base_chunk_size,
            chunk_compress_factor,
            ldim,
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Muat voice style JSON (format {style_ttl:{dims,data}, style_dp:{...}}).
    pub fn load_style(model_dir: &Path, name: &str) -> Result<Style, String> {
        let path = model_dir.join("voice_styles").join(format!("{name}.json"));
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("voice style '{name}' tak ditemukan: {e}"))?;
        let j: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("voice style rusak: {e}"))?;
        // data JSON bersarang ([[[...]]]) — ratakan rekursif jadi flat Vec<f32>,
        // seperti np.array(data).reshape(dims) di Python.
        let parse = |key: &str| -> Result<(Vec<f32>, Vec<usize>), String> {
            let node = &j[key];
            let dims: Vec<usize> = node["dims"]
                .as_array()
                .ok_or_else(|| format!("voice style tanpa {key}.dims"))?
                .iter()
                .map(|v| v.as_u64().unwrap_or(0) as usize)
                .collect();
            let mut flat = Vec::new();
            flatten(&node["data"], &mut flat);
            let want: usize = dims.iter().product();
            if flat.len() != want {
                return Err(format!(
                    "voice style {key}: data {} != produk dims {want}",
                    flat.len()
                ));
            }
            Ok((flat, dims))
        };
        let (ttl, ttl_dims) = parse("style_ttl")?;
        let (dp, dp_dims) = parse("style_dp")?;
        Ok(Style { ttl, ttl_dims, dp, dp_dims })
    }

    /// Sintesis satu chunk teks → sampel f32. `lang` mis. Some("id"); None = v1.
    fn synth_chunk(
        &mut self,
        text: &str,
        style: &Style,
        total_step: i64,
        speed: f32,
        lang: Option<&str>,
    ) -> Result<Vec<f32>, String> {
        let ids = self.proc.encode(text, lang);
        let seq = ids.len();
        if seq == 0 {
            return Ok(vec![]);
        }
        // text_mask semua 1 (batch=1).
        let mask: Vec<f32> = vec![1.0; seq];

        let style_ttl = Array::from_shape_vec(IxDyn(&style.ttl_dims), style.ttl.clone())
            .map_err(|e| format!("style_ttl shape: {e}"))?;
        let style_dp = Array::from_shape_vec(IxDyn(&style.dp_dims), style.dp.clone())
            .map_err(|e| format!("style_dp shape: {e}"))?;

        let text_ids_arr =
            Array::from_shape_vec(IxDyn(&[1, seq]), ids.clone()).map_err(|e| e.to_string())?;
        let text_mask_arr =
            Array::from_shape_vec(IxDyn(&[1, 1, seq]), mask.clone()).map_err(|e| e.to_string())?;

        // ── 1. duration predictor ──
        let dur_out = self.dp.run(ort::inputs![
            "text_ids" => Tensor::from_array(text_ids_arr.clone()).map_err(|e| e.to_string())?,
            "style_dp" => Tensor::from_array(style_dp).map_err(|e| e.to_string())?,
            "text_mask" => Tensor::from_array(text_mask_arr.clone()).map_err(|e| e.to_string())?,
        ]).map_err(|e| format!("dp run: {e}"))?;
        let (_, dur_data) = dur_out["duration"]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        let dur = dur_data[0] / speed;

        // ── 2. text encoder ──
        let emb_out = self.text_enc.run(ort::inputs![
            "text_ids" => Tensor::from_array(text_ids_arr).map_err(|e| e.to_string())?,
            "style_ttl" => Tensor::from_array(style_ttl.clone()).map_err(|e| e.to_string())?,
            "text_mask" => Tensor::from_array(text_mask_arr.clone()).map_err(|e| e.to_string())?,
        ]).map_err(|e| format!("text_enc run: {e}"))?;
        let (emb_shape, emb_data) = emb_out["text_emb"]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        let emb_shape: Vec<usize> = emb_shape.iter().map(|&d| d as usize).collect();
        let text_emb = Array::from_shape_vec(IxDyn(&emb_shape), emb_data.to_vec())
            .map_err(|e| e.to_string())?;

        // ── noisy latent ──
        let latent_dim = (self.ldim * self.chunk_compress_factor) as usize; // 144
        let chunk_size = (self.base_chunk_size * self.chunk_compress_factor) as f32; // 3072
        let wav_len_max = dur * self.sample_rate as f32;
        let latent_len = ((wav_len_max + chunk_size - 1.0) / chunk_size).floor() as usize;
        let latent_len = latent_len.max(1);

        let mut rng = rand::thread_rng();
        let normal = rand_distr::StandardNormal;
        let noisy: Vec<f32> = (0..latent_dim * latent_len)
            .map(|_| rng.sample::<f32, _>(normal))
            .collect();
        // latent_mask semua 1 (batch=1) → noisy tak berubah.
        let mut xt = Array3::from_shape_vec((1, latent_dim, latent_len), noisy)
            .map_err(|e| e.to_string())?
            .into_dyn();
        let latent_mask = Array::from_elem(IxDyn(&[1, 1, latent_len]), 1.0f32);

        // ── 3. vector estimator (diffusion) ──
        let total_step_arr = Array1::from_vec(vec![total_step as f32]).into_dyn();
        for step in 0..total_step {
            let cur = Array1::from_vec(vec![step as f32]).into_dyn();
            let out = self.vector_est.run(ort::inputs![
                "noisy_latent" => Tensor::from_array(xt.clone()).map_err(|e| e.to_string())?,
                "text_emb" => Tensor::from_array(text_emb.clone()).map_err(|e| e.to_string())?,
                "style_ttl" => Tensor::from_array(style_ttl.clone()).map_err(|e| e.to_string())?,
                "text_mask" => Tensor::from_array(text_mask_arr.clone()).map_err(|e| e.to_string())?,
                "current_step" => Tensor::from_array(cur).map_err(|e| e.to_string())?,
                "total_step" => Tensor::from_array(total_step_arr.clone()).map_err(|e| e.to_string())?,
                "latent_mask" => Tensor::from_array(latent_mask.clone()).map_err(|e| e.to_string())?,
            ]).map_err(|e| format!("vector_est run: {e}"))?;
            let (sh, data) = out["denoised_latent"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            let sh: Vec<usize> = sh.iter().map(|&d| d as usize).collect();
            xt = Array::from_shape_vec(IxDyn(&sh), data.to_vec()).map_err(|e| e.to_string())?;
        }

        // ── 4. vocoder ──
        let voc = self.vocoder.run(ort::inputs![
            "latent" => Tensor::from_array(xt).map_err(|e| e.to_string())?,
        ]).map_err(|e| format!("vocoder run: {e}"))?;
        let (_, wav_data) = voc["wav_tts"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        Ok(wav_data.to_vec())
    }

    /// Sintesis penuh: chunk teks, sintesis tiap chunk, sisipkan senyap.
    pub fn synthesize(
        &mut self,
        text: &str,
        style: &Style,
        total_step: i64,
        speed: f32,
        silence_s: f32,
        lang: Option<&str>,
    ) -> Result<Vec<f32>, String> {
        let chunks = chunk_text(text, 300);
        if chunks.is_empty() {
            return Err("teks kosong".into());
        }
        let silence = vec![0.0f32; (silence_s * self.sample_rate as f32) as usize];
        let mut out: Vec<f32> = Vec::new();
        for (i, chunk) in chunks.iter().enumerate() {
            let wav = self.synth_chunk(chunk, style, total_step, speed, lang)?;
            out.extend_from_slice(&wav);
            if i < chunks.len() - 1 {
                out.extend_from_slice(&silence);
            }
        }
        Ok(out)
    }
}

/// Ratakan array JSON bersarang (angka atau array) → Vec<f32>, depth-first.
fn flatten(node: &serde_json::Value, out: &mut Vec<f32>) {
    match node {
        serde_json::Value::Array(a) => {
            for v in a {
                flatten(v, out);
            }
        }
        serde_json::Value::Number(n) => out.push(n.as_f64().unwrap_or(0.0) as f32),
        _ => {}
    }
}

/// Port `utils.chunk_text` — pisah paragraf lalu kalimat, gabung ≤ max_len.
/// Versi ringkas: pisah pada [.!?] + spasi (abaikan singkatan umum sederhana).
pub fn chunk_text(text: &str, max_len: usize) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return vec![];
    }
    let mut chunks = Vec::new();
    for paragraph in text.split("\n\n") {
        let p = paragraph.trim();
        if p.is_empty() {
            continue;
        }
        let sentences = split_sentences(p);
        let mut cur = String::new();
        for s in sentences {
            let s = s.trim();
            if s.is_empty() {
                continue;
            }
            if cur.len() + s.len() + 1 <= max_len {
                if !cur.is_empty() {
                    cur.push(' ');
                }
                cur.push_str(s);
            } else {
                if !cur.is_empty() {
                    chunks.push(cur.trim().to_string());
                }
                cur = s.to_string();
            }
        }
        if !cur.trim().is_empty() {
            chunks.push(cur.trim().to_string());
        }
    }
    chunks
}

/// Pisah kalimat pada tanda akhir + spasi, mempertahankan tanda baca.
fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        cur.push(c);
        if matches!(c, '.' | '!' | '?') {
            let next_is_space = chars.get(i + 1).map(|n| n.is_whitespace()).unwrap_or(true);
            if next_is_space {
                out.push(std::mem::take(&mut cur));
            }
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

// ── DSP pasca-sintesis (untuk efek pitch/cempreng) ──────────────────
// Pitch-shift ala kartun: resample linear + kompensasi durasi di pemanggil
// (synth dengan speed lebih lambat, lalu resample naik) — pitch naik, tempo
// kembali normal. Sengaja tanpa dependensi; untuk faktor moderat (≤1.5×)
// kualitasnya cukup dan karakter "saluran suara kecil" justru tercapai.

/// Resample linear sebesar `factor` (>1 = lebih pendek + pitch naik).
/// factor di luar (0, ∞) atau ≈1 → salinan apa adanya.
pub fn pitch_resample(samples: &[f32], factor: f32) -> Vec<f32> {
    if !factor.is_finite() || factor <= 0.0 || (factor - 1.0).abs() < 1e-6 || samples.len() < 2 {
        return samples.to_vec();
    }
    let out_len = ((samples.len() as f32 - 1.0) / factor).floor() as usize + 1;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f32 * factor;
        let i0 = pos.floor() as usize;
        let i1 = (i0 + 1).min(samples.len() - 1);
        let t = pos - i0 as f32;
        out.push(samples[i0] * (1.0 - t) + samples[i1] * t);
    }
    out
}

/// Penekanan resonansi "hidung" (cempreng) via peaking biquad (RBJ cookbook)
/// di sekitar 1.8 kHz — pita formant yang membuat suara terdengar nasal.
/// `amount` 0..1 → gain 0..+8 dB. amount ≤ 0 → salinan apa adanya.
pub fn nasal_filter(samples: &[f32], sample_rate: u32, amount: f32) -> Vec<f32> {
    if amount <= 0.0 || !amount.is_finite() || samples.is_empty() {
        return samples.to_vec();
    }
    let gain_db = (amount.clamp(0.0, 1.0)) * 8.0;
    let a = 10.0f32.powf(gain_db / 40.0);
    let w0 = 2.0 * std::f32::consts::PI * 1800.0 / sample_rate.max(8000) as f32;
    let cos = w0.cos();
    let alpha = w0.sin() / (2.0 * 1.4f32); // Q = 1.4
    let a0 = 1.0 + alpha / a;
    let (b0, b1, b2) = ((1.0 + alpha * a) / a0, (-2.0 * cos) / a0, (1.0 - alpha * a) / a0);
    let (a1, a2) = ((-2.0 * cos) / a0, (1.0 - alpha / a) / a0);
    let mut x1 = 0.0f32;
    let mut x2 = 0.0f32;
    let mut y1 = 0.0f32;
    let mut y2 = 0.0f32;
    samples
        .iter()
        .map(|&x| {
            let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1;
            x1 = x;
            y2 = y1;
            y1 = y;
            y
        })
        .collect()
}

#[cfg(test)]
mod dsp_tests {
    use super::*;

    #[test]
    fn resample_mengubah_panjang_dan_frekuensi() {
        // Sinus dengan periode tak bulat (hindari nol eksak di indeks sampel —
        // deteksi crossing sensitif float): ~10 siklus per 1000 sampel.
        let sr_period = 100.3f32;
        let samples: Vec<f32> = (0..1000)
            .map(|i| (2.0 * std::f32::consts::PI * i as f32 / sr_period).sin())
            .collect();
        let up = pitch_resample(&samples, 2.0);
        // Panjang mendekati setengah; jumlah siklus (≈ frekuensi) terjaga ±1.
        assert!((up.len() as f32 - 500.0).abs() <= 2.0);
        let crossings = |s: &[f32]| -> usize {
            s.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count()
        };
        let c0 = crossings(&samples);
        let c1 = crossings(&up);
        assert!(c1.abs_diff(c0) <= 1, "crossings {c0} vs {c1}");
        // factor 1.0 / tak valid → salinan.
        assert_eq!(pitch_resample(&samples, 1.0), samples);
        assert_eq!(pitch_resample(&samples, 0.0), samples);
    }

    #[test]
    fn nasal_filter_identity_di_nol_dan_boost_di_pusat() {
        let sr = 22050u32;
        let sine = |f: f32, n: usize| -> Vec<f32> {
            (0..n).map(|i| (2.0 * std::f32::consts::PI * f * i as f32 / sr as f32).sin()).collect()
        };
        let s = sine(1800.0, sr as usize / 2);
        // amount 0 = identik.
        assert_eq!(nasal_filter(&s, sr, 0.0), s);
        // RMS di frekuensi pusat naik, jauh di bawah (200 Hz) hampir netral.
        let rms = |x: &[f32]| -> f32 { (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt() };
        let boosted = nasal_filter(&s, sr, 1.0);
        let low = nasal_filter(&sine(200.0, sr as usize / 2), sr, 1.0);
        assert!(rms(&boosted) > rms(&s) * 1.2);
        assert!(rms(&low) < rms(&sine(200.0, sr as usize / 2)) * 1.35);
    }
}
