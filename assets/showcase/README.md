# Aset Showcase Lumimi

Folder terpisah untuk materi showcase produk: tangkapan layar, GIF, dan video
demo yang dipakai di `README.md` / `README-ID.md`, halaman `landing/`, atau
keperluan promosi lain.

## Struktur

```text
assets/showcase/
  screenshots/   tangkapan layar & GIF (mode, panel agent, panggung, dst.)
  videos/        rekaman demo (mp4/webm)
```

## Konvensi

- Nama berkas kebab-case yang deskriptif, mis. `assistant-mode-chat.png`,
  `motion-studio-demo.mp4` — bukan `Screenshot (1).png`.
- Asal aset showcase, taruh di sini; **logo brand tetap di `assets/`**
  (`lumimi-logo.svg`, `lumimi-icon.svg`) karena sudah direferensikan README.
- Video besar bikin repo bengkak: untuk rekaman panjang, pertimbangkan
  kompres dulu atau simpan di luar repo (tautan), cukup sertakan poster frame
  di `screenshots/`.
- Jangan menaruh isi `data/` (model berlisensi, `config.json` berisi apiKey)
  ke folder ini.
