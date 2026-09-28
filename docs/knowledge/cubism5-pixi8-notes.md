# Catatan: Cubism 5.3 (SDK Web 5-r.5 / Core 6.0.1) + PixiJS 8 (Pendahuluan → Fase 2 terkunci)

> Wajib sebelum Fase 0. SDK diunduh dari situs resmi Live2D
> (`CubismSdkForWeb-5-r.5.zip`) dan diekstrak ke direktori temp lokal.
> Tidak ada kode aplikasi yang diubah di fase ini; hanya riset + spike terisolasi.
> Fase 2 (2026-09-18): versi di atas dikunci sebagai target.
> (Catatan historis: hack `patchCubismCore` + stack Pixi 6 sudah DIHAPUS total
> pasca-migrasi — tidak ada MOC-version-hack di kode sekarang.)

## 1. Versi yang dipakai + alasan

| Komponen | Versi pasti | Sumber verifikasi |
|---|---|---|
| Cubism SDK for Web | **5-r.5** (2026-04-02, `Framework/CHANGELOG.md` tag `5-r.5`) | Ekstrak ZIP, cek CHANGELOG + `Core/CHANGELOG.md` |
| Cubism Core (WASM) | **6.0.1** (`Core/live2dcubismcore.min.js`, `Version 0x06000001`) | `spike-log.txt` → `Live2D Cubism SDK Core Version 6.0.1`, probe `C.Version.csmGetVersion()` |
| PixiJS | **8.20.1** (exact, `registry.npmjs.org/pixi.js/8.20.1`, shasum `233621f…`) | Registry fetch + `bun add pixi.js@8.20.1` di env spike |
| Model uji | Ren (SDK sample, `Samples/Resources/Ren/Ren.moc3`, moc **v6**) | `spike-log.txt` → `moc v6` via `C.Version.csmGetMocVersion(mocBytes)` |

Alasan: 5-r.5 adalah tag stabil terbaru (rilis 2026-04-02, post-R5 beta3). Core 6.0.1 = Core pertama yang mengenali moc v6 tanpa byte-hack (`MocVersion_53 = 6`). Pixi 8.20.1 = patch stabil Agustus 2026 (3 minggu field exposure); 8.21.0 baru rilis hari-H belum ada jejak. Ren dipilih sebagai golden model paling bermasalah: 198 drawable + 24 offscreen + `isBlendModeEnabled()=true` + `isUsingMasking()=true` — kalau ini lolos, lumine (v5, 0 offscreen) hampir pasti lolos.

## 2. Breaking changes relevan ke proyek

### Cubism 5.3 SDK (5-r.5 vs 5-r.4 ke bawah)
- **Renderer pipeline berubah total**: `CubismRenderer_WebGL` sekarang membedakan `Drawable` vs `Offscreen` sebagai `DrawableObjectType`; draw order gabungan `Model.getRenderOrders()` (menggantikan `getDrawableRenderOrders()`), render loop via `drawObjectLoop()` + `renderObject()` + `submitDrawToParentOffscreen()`.
- **Blend mode & offscreen drawing baru**: 5-r.5 menambahkan `CubismOffscreenRenderTarget_WebGL`/`CubismWebGLOffscreenManager`, framebuffer copy + Porter-Duff frag (`ColorBlend`, `AlphaBlend`). **Syarat WebGL2** (`WebGL2RenderingContext.blitFramebuffer` dipakai).
- **Shader terpisah**: `Framework/Shaders/WebGL/*.vert/*.frag` — 13 file. `CubismShader_WebGL.loadShaders()` fetch asinkron; sampai selesai `isShaderLoaded=false` dan `drawMeshWebGL` early-return (karakter hitam/blank tanpa error).
- **Core API**: `csmGetDrawableRenderOrders` → `csmGetRenderOrders`; `csmGetMocVersion` overload baru; `MocVersion_53` ditambahkan.
- **Lifecycle `CubismFramework`**: `startUp({ logFunction, loggingLevel })` wajib diberi logger, kalau tidak semua `CubismLog*` tertelan (silent-fail). `initialize()` guard `s_isInitialized`.
- **High-precision mask**: bila `isBlendModeEnabled()` renderer paksa `useHighPrecisionMask(true)` dan butuh `CubismRenderTarget_WebGL` terpisah untuk mask vs drawable.
- **`CubismUserModel.createRenderer(width,height,maskBufferCount)`** → renderer konstruktor `(width,height)` saja (tanpa canvas); `startUp(gl)` kemudian; `setRenderState(fbo, viewport)` tiap frame.

### PixiJS 8 (v6→v8)
- **Package tunggal**: `pixi.js` (dulu `@pixi/*`). Import `import * as PIXI from 'pixi.js'`.
- **Async init**: `new PIXI.Application(); await app.init({ width,height,backgroundAlpha,background,antialias })`. Opsi dipindah dari konstruktor ke `init()`. Canvas via `app.canvas` (bukan `app.view`).
- **Ticker tidak otomatis**: build ESM minimal tidak menyertakan `TickerPlugin`; `app.ticker` = `undefined`. Render manual via `app.render()` atau `requestAnimationFrame` sendiri. Jangan pakai `app.ticker.add` tanpa verifikasi.
- **Texture system**: `BaseTexture` hilang → `TextureSource` family (`ImageSource`, `CanvasSource`, ...). `Texture.from(url)` tidak auto-load; harus `Assets.load` dulu.
- **Graphics**: `beginFill/drawRect/endFill` → `rect().fill()`, `lineStyle` → `stroke()`, `GraphicsGeometry` → `GraphicsContext`.
- **Mesh/Shader**: shader tidak lagi uniform blob; WebGL+WebGPU dual path via `GlProgram` + `resources` (`TextureSource`, `UniformGroup`, `BufferResource`).
- **DisplayObject hilang**: `Container` jadi base; `updateTransform` → `onRender`.
- **Filter/advanced-blend-modes**: import eksplisit `import 'pixi.js/advanced-blend-modes'`.
- **Ticker callback**: `(ticker) => ticker.deltaTime` (bukan `dt` langsung).
- **Wajib cek**: `Bundle` + `Extensions` system; `Culler`/`CullerPlugin` opsional.

## 3. Adapter yang akan dipakai (keputusan)

**Tidak memakai `pixi-live2d-display@0.4.0` (Pixi 6 only, issue Pixi 8 belum ada solusi upstream). Tidak memakai fork pihak ketiga sebagai ketergantungan langsung.**

Keputusan: **adapter tipis di atas Cubism SDK resmi** di atas **PixiJS 8 WebGLRenderer**:

```
model3.json -> CubismMoc.create(buffer) -> CubismModel -> CubismModelMatrix
  -> CubismUserModel.createRenderer(w,h) -> startUp(gl dari app.canvas)
  -> loadShaders('/Framework/Shaders/WebGL/')
  -> bindTexture(i, glTexture) manual
  -> per frame: model.update() + renderer.setRenderState(null, viewport)
               + setMvpMatrix(mvp) + drawModel(shaderPath)
  -> Pixi 8 hanya menyediakan canvas+GL context + rendering stage 2D (UI),
     ordering frame: app.render() dulu, lalu Cubism draw ke framebuffer default
```

Alasan: pipeline offscreen/blend 5.3 terlalu dalam untuk di-reimplementasi di mesh custom Pixi (multi-FBO, `blitFramebuffer`, blend shader Porter-Duff). Boundary resmi (`renderer.resetState()`-style `setRenderState` + `drawModel`) sudah menangani mask, inverted mask, multiple masks, mask hierarchy, dan blend mode — spike membuktikan drawable/offscreen sudah ter-load tanpa custom mesh.

## 4. Cara jawab 3 pertanyaan DoD (tanpa buka docs lagi)

- **Custom shader/mask di Pixi 8**: via `Shader.from({ gl:{vertex,fragment}, gpu:{...}, resources:{...}})`, mask via `Culler`/`stencil` tidak dipakai untuk Live2D — Live2D punya mask texture sendiri (`CubismRenderTarget_WebGL`). Di Pixi 8, shader resource tidak lagi uniform biasa; filter/blend advance perlu `pixi.js/advanced-blend-modes`.
- **Lifecycle render loop Pixi 8**: `await app.init(opts)` → `document.body.appendChild(app.canvas)` → `app.render()` manual atau `Ticker.shared.add((ticker)=>...)`. `Ticker` sekarang kirim objek ticker, dan build minimal tanpa plugin tidak punya `app.ticker` (harus guard).
- **Load `.model3.json` native tanpa MOC hack**: `CubismModelSettingJson` parse JSON (butuh byteLength benar) → `fetch(Moc)` → `CubismMoc.create(arrayBuffer, false)` → `Core.Moc.fromArrayBuffer` langsung mengenali v6 (`MocVersion_53`) → `createModel()` → `model.getDrawableCount()/getOffscreenCount()/getRenderOrders()`. Tidak ada ubah byte MOC.

## 5. Risiko & batas untuk fase berikutnya

- Shader load asinkron: sampai `isShaderLoaded` true, frame pertama hitam — fase berikut butuh guard/polling log `[W]Shader program is not initialized`.
- Offscreen `blendModeEnabled=true` membuat 3 `modelRenderTargets` ukuran viewport — butuh ukuran benar di `createRenderer`/`startUp`.
- Spike fase awal hanya memakai model SDK Ren; verifikasi multi-model
  (termasuk model user di `data/model/`) menyusul di fase migrasi dan sudah
  lolos sebelum stack lama dipensiunkan.
- Pixi 8 headless (swiftshader) tidak bisa screenshot Playwright deterministik; bukti pakai `canvas.toDataURL` + `readPixels` grid.

## 6. Referensi

- `https://pixijs.com/8.x/guides/migrations/v8` (migration guide resmi, async init, texture, graphics, shader, filter, particle, other breakings)
- `https://registry.npmjs.org/pixi.js/8.20.1` (manifest, shasum, integrity)
- `https://docs.live2d.com/en/cubism-sdk-manual/compatibility-with-cubism-5-3/` (5 SDK vs 5.3 SDK, renderer restructure, Core API `getRenderOrders`)
- `CubismSdkForWeb-5-r.5/Framework/CHANGELOG.md` (5-r.5, beta3.1, beta3, beta2, beta1)
- `CubismSdkForWeb-5-r.5/Core/CHANGELOG.md` (06.00.0001 2026-01-08, 06.00.0000 2025-08-26)
- `CubismSdkForWeb-5-r.5/Framework/src/rendering/cubismrenderer_webgl.ts` (setRenderState, preDraw, drawObjectLoop, drawMeshWebGL, startUp)
- `CubismSdkForWeb-5-r.5/Framework/src/rendering/cubismshader_webgl.ts` (loadShader fetch, generateShaders async, isShaderLoaded gate)
- `CubismSdkForWeb-5-r.5/Framework/src/live2dcubismframework.ts` (startUp logFunction guard, initialize guard)
- `C:\Users\Admin\AppData\Local\Temp\opencode\lumi-cubism5r5-research-20260917\spike-log.txt` + `spike-proof.png` (bukti spike)
- `guansss/pixi-live2d-display` README (Pixi 6 only — tidak dipilih)
