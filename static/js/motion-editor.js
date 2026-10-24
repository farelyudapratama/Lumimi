/* motion-editor.js — Motion Studio UI (Raw Parameter Mode)
 *
 * TERISOLASI (docs/CRITICAL UI & FLOW CONSTRAINTS.md §9): seluruh editor hidup
 * di file ini dan hanya berbicara dengan app.js lewat window.__live2dAgent.
 *
 * MODE TUNGGAL: editor bekerja langsung pada PARAMETER MENTAH model (seperti
 * timeline Cubism Editor) — satu track per parameter, keyframe sendiri-sendiri.
 * Semantic Mode (8 field abstrak) dihapus dari UI; motion lama yang memakainya
 * tetap bisa dibuka dan otomatis diterjemahkan menjadi track parameter.
 *
 * Preview realtime adalah inti, bukan pelengkap: setiap perubahan nilai (drag
 * slider, ketik angka, geser key, scrub playhead) langsung ditulis ke model
 * lewat setRawDrive(), yang di-assert ulang SETIAP frame di app.js. Menulis
 * sekali saja tidak cukup karena update internal model menimpa parameter di
 * antara frame.
 */
(function () {
  'use strict';

  // Basis HTTP via seam transport (bundle.js, dimuat sebelum file ini):
  // embedded → loopback proses-sendiri; dev → origin halaman.
  const apiBase = () =>
    window.__transport && typeof window.__transport.httpBase === "function"
      ? window.__transport.httpBase()
      : (typeof location !== 'undefined' && /^https?:$/.test(location.protocol))
        ? location.origin : 'http://127.0.0.1:8310';

  const $ = (s) => document.querySelector(s);
  const L2D = () => window.__live2dAgent;

  // i18n: window.__i18n dipasang bundle.js (dimuat sebelum file ini).
  const __t = (k, v) => (window.__i18n ? window.__i18n.t(k, v) : k);
  const DSL = () => window.MotionDSL;

  const PREVIEW_ID = '__ms_preview__';
  const EASINGS = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'stepped'];

  const state = {
    open: false,
    draft: null,          // Motion Asset yang sedang diedit
    dirty: false,
    selected: null,       // { param, index }
    playing: false,
    scrubT: 0,            // detik
    undoStack: [],
    redoStack: [],
    userMotions: [],
    emotions: ['senang', 'sedih', 'malu', 'kaget', 'normal'],
    params: [],           // daftar parameter model: {id,label,group,min,max,def}
    paramById: new Map(),
    clipboardKey: null,   // { v, easing } untuk copy/paste antar track
    search: '',
    groupFilter: '',
    analysis: null,       // hasil /api/model/motion-analysis (angka engine dari disk)
    rigReport: null,      // hasil /api/model/rig-report (provenance + hash)
    stagedBeats: null,    // staging panel Terima Batch: {meta, beats, prompt, rig}
    probePanel: null,     // panel approve probe: {rows: [...], hash: modelHash}
  };

  function blankDraft() {
    return {
      version: 1, id: '', name: '', description: '', tags: [],
      source: 'user', type: 'keyframe', duration: 1.5, loop: false,
      intensity: { min: 0.3, max: 1.0, default: 0.8 },
      emotionCompatibility: {}, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [], tracks: [],
      sourceModelId: modelKey(),
    };
  }

  function modelKey() {
    const l2d = L2D();
    return (l2d && l2d.modelKey) ? l2d.modelKey() : 'default';
  }

  function setStatus(msg, kind) {
    const el = $('#ms-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.remove('ok', 'err');
    if (kind) el.classList.add(kind);
  }

  // ── Analisis model dari disk (motion_analysis di core) ────────────
  // Sumber angka = engine (Rust memindai motion + physics3 milik model).
  // Dipakai untuk: konteks prompt generate, badge ★ physics, dan lint.
  function roleMapForModel() {
    const dsl = DSL();
    const l2d = L2D();
    const out = {};
    if (!dsl || !dsl.ROLE_FOR_FIELD || !l2d || !l2d.roleIdFor) return out;
    for (const field in dsl.ROLE_FOR_FIELD) {
      const id = l2d.roleIdFor(dsl.ROLE_FOR_FIELD[field]);
      if (id) out[field] = id;
    }
    return out;
  }

  function rigForCompiler() {
    const rr = state.rigReport;
    if (!rr) return null;
    const roleMap = roleMapForModel();
    const params = {};
    for (const field in roleMap) {
      const pid = roleMap[field];
      const st = rr.params && rr.params[pid];
      if (st) params[field] = st;
    }
    // Map physics paramIds back to role fields.
    const physicsOutputs = (rr.physicsOutputs || []).map(pid => {
      for (const f in roleMap) if (roleMap[f] === pid) return f;
      return null;
    }).filter(Boolean);
    // Beat kind param (paramId hasil approve user): statistik mentah per
    // paramId + daftar output physics mentah — compiler memakainya untuk
    // amplitudo/clamp dan physics gate param.
    return {
      params,
      physicsOutputs,
      paramsById: rr.params || {},
      physicsParamIds: rr.physicsOutputs || [],
    };
  }

  async function fetchAnalysis() {
    state.analysis = null;
    try {
      const roles = encodeURIComponent(JSON.stringify(roleMapForModel()));
      const r = await fetch(apiBase() + '/api/model/motion-analysis?name='
        + encodeURIComponent(modelKey()) + '&roles=' + roles);
      if (r.ok) state.analysis = await r.json();
      const rr = await fetch(apiBase() + '/api/model/rig-report?name=' + encodeURIComponent(modelKey()));
      if (rr.ok) state.rigReport = await rr.json();
    } catch (e) { /* advisory: gagal → lanjut tanpa badge/lint semantik */ }
  }

  // Lint independen: validasi draft SEBELUM disimpan (validator terpisah
  // dari generator di core). Advisory — tidak memblokir Simpan.
  async function runLint() {
    const host = $('#ms-lint');
    if (!host) return;
    const d = state.draft;
    if (!d || !d.tracks || !d.tracks.length) {
      host.classList.add('hidden'); host.innerHTML = ''; return;
    }
    try {
      const r = await fetch(apiBase() + '/api/motions/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelKey(), roleMap: roleMapForModel(), motion: d }),
      });
      if (!r.ok) { host.classList.add('hidden'); return; }
      renderLint(await r.json());
    } catch (e) { host.classList.add('hidden'); }
  }

  function renderLint(rep) {
    const host = $('#ms-lint');
    if (!host) return;
    const issues = Array.isArray(rep.issues) ? rep.issues : [];
    if (!issues.length) { host.classList.add('hidden'); host.innerHTML = ''; return; }
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const rows = issues.slice(0, 12).map((i) =>
      '<div class="ms-lint-item"><span class="lv ' + esc(i.level) + '">'
      + esc(__t('ms.lint.' + i.level)) + '</span><span class="msg">'
      + esc(i.message) + '</span></div>'
    ).join('');
    const more = issues.length > 12
      ? '<div class="ms-lint-item"><span class="msg">…+' + (issues.length - 12) + '</span></div>'
      : '';
    host.innerHTML = '<div class="ms-lint-title">'
      + esc(__t('ms.lint.title', { e: rep.errorCount || 0, w: rep.warnCount || 0, n: rep.infoCount || 0 }))
      + '</div>' + rows + more;
    host.classList.remove('hidden');
  }

  // ── Undo/redo: snapshot draft utuh (SPEC §25) ────────────────────
  // Snapshot penuh, bukan diff: draft kecil dan diff-per-operasi jauh lebih
  // mudah salah. Tidak ada penulisan ke disk di sini — hanya saat tombol Simpan.
  function pushUndo() {
    if (!state.draft) return;
    state.undoStack.push(JSON.stringify(state.draft));
    if (state.undoStack.length > 60) state.undoStack.shift();
    state.redoStack.length = 0;
    state.dirty = true;
    renderUndoButtons();
  }
  function undo() {
    if (!state.undoStack.length) { setStatus(__t('ms.undoEmpty')); return; }
    state.redoStack.push(JSON.stringify(state.draft));
    state.draft = JSON.parse(state.undoStack.pop());
    state.selected = null;
    renderAll(); applyScrubPose();
  }
  function redo() {
    if (!state.redoStack.length) { setStatus(__t('ms.redoEmpty')); return; }
    state.undoStack.push(JSON.stringify(state.draft));
    state.draft = JSON.parse(state.redoStack.pop());
    state.selected = null;
    renderAll(); applyScrubPose();
  }

  // ── Akses track / keyframe (track = satu parameter mentah) ───────
  function trackFor(paramId, create) {
    if (!state.draft || !Array.isArray(state.draft.tracks)) return null;
    let t = state.draft.tracks.find(x => x.kind === 'param' && x.param === paramId);
    if (!t && create) {
      const meta = state.paramById.get(paramId);
      t = {
        kind: 'param', param: paramId, interp: 'linear', keys: [],
        label: meta ? meta.label : paramId,
      };
      if (meta) { t.min = meta.min; t.max = meta.max; }
      state.draft.tracks.push(t);
    }
    return t || null;
  }

  // Range yang dipakai slider/clamp: prioritaskan definisi model yang SEDANG
  // dimuat (itu yang sebenarnya membatasi rig), lalu range yang tersimpan di
  // track (untuk motion dari model lain), baru fallback aman.
  function rangeOf(paramId) {
    const meta = state.paramById.get(paramId);
    if (meta && Number.isFinite(meta.min) && Number.isFinite(meta.max)) return meta;
    const tr = state.draft && state.draft.tracks.find(x => x.param === paramId);
    if (tr && Number.isFinite(tr.min) && Number.isFinite(tr.max)) {
      return { min: tr.min, max: tr.max, def: (tr.min + tr.max) / 2 };
    }
    return { min: -30, max: 30, def: 0 };
  }

  // Parameter ada di model yang sedang dimuat? Track yang tidak ada ditandai
  // di UI dan dilewati runtime — motion model-scoped tidak boleh bikin error.
  function paramAvailable(paramId) { return state.paramById.has(paramId); }

  function addKey(paramId, t, v, easing) {
    const tr = trackFor(paramId, true);
    const dur = state.draft.duration;
    const tt = Math.max(0, Math.min(dur, Number(t) || 0));
    const r = rangeOf(paramId);
    const vv = Math.max(r.min, Math.min(r.max, Number(v)));
    const key = { t: +tt.toFixed(3), v: +vv.toFixed(4) };
    if (EASINGS.includes(easing)) key.easing = easing;
    const exist = tr.keys.findIndex(k => Math.abs(k.t - tt) < 0.001);
    if (exist >= 0) tr.keys[exist] = key;
    else tr.keys.push(key);
    tr.keys.sort((a, b) => a.t - b.t);
    return tr.keys.findIndex(k => Math.abs(k.t - tt) < 0.001);
  }

  function removeKey(paramId, index) {
    const tr = trackFor(paramId, false);
    if (!tr || !tr.keys[index]) return;
    tr.keys.splice(index, 1);
    // Track tanpa key tidak dihapus otomatis: user sering menghapus key untuk
    // menata ulang, dan membuang track-nya berarti mereka harus mencari
    // parameter itu lagi di daftar 223 item. Track kosong dibuang saat Simpan.
  }

  function removeTrack(paramId) {
    if (!state.draft) return;
    state.draft.tracks = state.draft.tracks.filter(x => x.param !== paramId);
    if (state.selected && state.selected.param === paramId) state.selected = null;
  }

  // Nilai track pada waktu t menurut draft — memakai evaluator DSL yang sama
  // dengan runtime, jadi preview editor dan hasil akhir tidak pernah beda.
  function sampleParam(paramId, t) {
    const tr = trackFor(paramId, false);
    if (!tr || !tr.keys.length) return null;
    const dsl = DSL();
    return dsl ? dsl.evalTrack(tr, t) : tr.keys[0].v;
  }

  // ── Preview realtime ─────────────────────────────────────────────
  // Semua nilai track pada posisi playhead ditulis ke model lewat setRawDrive,
  // yang di-assert ulang setiap frame di app.js. Dipanggil dari SETIAP jalur
  // perubahan: scrub, drag key, ketik angka, undo/redo, ganti draft.
  function applyScrubPose() {
    const l2d = L2D();
    if (!l2d || !l2d.setRawDrive || !state.draft) return;
    if (!Array.isArray(state.draft.tracks)) return; // draft tidak sah — jangan crash
    const patch = {};
    for (const tr of state.draft.tracks) {
      if (tr.kind !== 'param' || !tr.keys.length) continue;
      if (!paramAvailable(tr.param)) continue;   // model ini tak punya param itu
      const v = sampleParam(tr.param, state.scrubT);
      if (v != null) patch[tr.param] = v;
    }
    l2d.setRawDrive(patch);
  }

  // Lepas SEMUA parameter yang sedang dikemudikan editor. Dipakai saat menutup
  // editor dan sebelum menyerahkan kendali ke runtime (Play).
  function releaseAllDriven() {
    const l2d = L2D();
    if (!l2d || !l2d.setRawDrive || !state.draft) return;
    const patch = {};
    for (const tr of state.draft.tracks) {
      if (tr.kind === 'param') patch[tr.param] = null;
    }
    l2d.setRawDrive(patch);
  }

  // ── Tooltip seret keyframe (satu elemen dipakai bergantian) ──────
  let dragTipEl = null;
  function showDragTip(ev, t, v) {
    if (!dragTipEl) {
      dragTipEl = document.createElement('div');
      dragTipEl.className = 'ms-dragtip';
      document.body.appendChild(dragTipEl);
    }
    dragTipEl.textContent = t.toFixed(2) + 's · ' + (+Number(v).toFixed(2));
    dragTipEl.style.left = (ev.clientX + 14) + 'px';
    dragTipEl.style.top = (ev.clientY - 30) + 'px';
    dragTipEl.classList.add('show');
  }
  function hideDragTip() { if (dragTipEl) dragTipEl.classList.remove('show'); }

  // Kurva nilai track sebagai polyline SVG — cukup untuk MEMBACA BENTUK gerak
  // (interpolasi linear antar key; easing halus tetap dirender runtime saat Play).
  function curveSvgFor(tr, dur) {
    const r = rangeOf(tr.param);
    const span = Math.abs(r.max - r.min) || 1;
    const pts = [[0, tr.keys[0].v]];
    for (const k of tr.keys) pts.push([k.t, k.v]);
    pts.push([dur, tr.keys[tr.keys.length - 1].v]);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ms-curve');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', pts.map(([t, v]) =>
      ((t / dur) * 100).toFixed(2) + ',' + (100 - ((v - r.min) / span) * 100).toFixed(2)
    ).join(' '));
    svg.appendChild(poly);
    return svg;
  }

  // ── Render: panel daftar parameter model ─────────────────────────
  function renderParamPanel() {
    const host = $('#ms-param-list');
    const groupSel = $('#ms-param-group');
    const countEl = $('#ms-param-count');
    if (!host) return;

    // Isi dropdown kategori sekali per daftar parameter.
    if (groupSel && groupSel.dataset.filled !== String(state.params.length)) {
      const groups = [...new Set(state.params.map(p => p.group).filter(Boolean))].sort();
      groupSel.innerHTML = '<option value="">' + __t('ms.allCats') + '</option>'
        + groups.map(g => '<option>' + g + '</option>').join('');
      groupSel.value = state.groupFilter;
      groupSel.dataset.filled = String(state.params.length);
    }

    const q = state.search.trim().toLowerCase();
    const filtered = state.params.filter(p => {
      if (state.groupFilter && p.group !== state.groupFilter) return false;
      if (!q) return true;
      return p.id.toLowerCase().includes(q)
        || (p.label || '').toLowerCase().includes(q)
        || (p.userNote || '').toLowerCase().includes(q);
    });

    // Escape HTML — daftar parameter isi-nya bisa apa saja (id, label, catatan
    // user). Tanpa ini, label berisi tag bisa menyuntik HTML.
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // InnerHTML TIDAK dibatasi 200 lagi — membangun string jauh lebih cepat
    // dari pada ratusan DOM node per keystroke pencarian (aturan performa lama
    // "slice(0,200)" dihapus; rig ratusan param kini tampil penuh). Klik
    // ditangani terpusat agar ribuan baris tidak butuh listener masing-masing.
    // ★ = output physics3 (dianalisis dari disk): diputar oleh simulasi
    // fisika, menulis nilai langsung hanya akan dilawan physics.
    const physSet = state.analysis && Array.isArray(state.analysis.physicsOutputs)
      ? new Set(state.analysis.physicsOutputs) : null;
    const rows = filtered.map(p => {
      const active = !!trackFor(p.id, false);
      const phys = physSet ? physSet.has(p.id) : false;
      // ID param = teks utama; label (cdi3/AI) hanya pelengkap.
      const nm = (p.label && p.label !== p.id) ? esc(p.id + '  —  ' + p.label) : esc(p.id);
      return '<button type="button" class="ms-param-item' + (active ? ' added' : '') + '"'
        + ' data-param="' + esc(p.id) + '"'
        + ' title="' + esc(p.id + '  (' + p.min + ' … ' + p.max + ', default ' + p.def + ')'
          + (phys ? '\n★ ' + __t('ms.physNote') : '')
          + (p.userNote ? '\n' + p.userNote : '')) + '">'
        + '<span class="ms-param-name">' + nm + (phys ? '<span class="ms-phys">★</span>' : '') + '</span>'
        + '<span class="ms-param-group">' + esc(p.group || '') + '</span>'
        + '</button>';
    }).join('');
    host.innerHTML = rows;

    // Delegated click: satu listener untuk seluruh daftar.
    if (!host.dataset.listener) {
      host.dataset.listener = '1';
      host.addEventListener('click', (ev) => {
        const btn = ev.target.closest && ev.target.closest('.ms-param-item');
        if (!btn || !btn.dataset.param) return;
        openParam(btn.dataset.param);
      });
    }

    if (countEl) {
      let txt = __t('ms.paramCount', { a: filtered.length, b: state.params.length });
      // Ringkasan analisis: konteks kualitas data di balik lint/konteks AI.
      if (state.analysis && state.analysis.hasReference) {
        const nPhys = Array.isArray(state.analysis.physicsOutputs) ? state.analysis.physicsOutputs.length : 0;
        txt += ' · ' + __t('ms.analysis.count', { n: state.analysis.motionCount, f: nPhys });
      }
      countEl.textContent = txt;
    }
  }

  // Fokus track param dari daftar (dipanggil item + klikan terpusat).
  function openParam(id) {
    if (trackFor(id, false)) {
      // Klik kedua = pilih track itu, bukan bikin duplikat.
      const tr = trackFor(id, false);
      state.selected = tr.keys.length ? { param: id, index: 0 } : null;
      renderAll();
      setStatus(__t('ms.trackExists', { id }));
      return;
    }
    pushUndo();
    trackFor(id, true);
    // Key pertama diseed dari nilai parameter yang SEDANG terlihat di model,
    // supaya menambah track tidak mengubah pose sama sekali — user mulai dari
    // kondisi sekarang, bukan dari nol yang bisa berarti pose ekstrem.
    const l2d = L2D();
    const cur = (l2d && l2d.readParameter) ? l2d.readParameter(id) : undefined;
    const p = state.params.find(x => x.id === id);
    const idx = addKey(id, state.scrubT, Number.isFinite(cur) ? cur : (p ? p.def : 0));
    state.selected = { param: id, index: idx };
    renderAll(); applyScrubPose();
    setStatus(__t('ms.trackAdded', { id }));
  }

  // ── Render: timeline ─────────────────────────────────────────────
  function renderRuler() {
    const el = $('#ms-ruler');
    if (!el || !state.draft) return;
    const dur = state.draft.duration;
    const stepChoices = [0.25, 0.5, 1, 2, 5];
    const step = stepChoices.find(s => dur / s <= 8) || 5;
    let html = '';
    for (let t = 0; t <= dur + 1e-6; t += step) {
      html += '<span style="left:' + ((t / dur) * 100).toFixed(2) + '%">' + (+t.toFixed(2)) + 's</span>';
    }
    el.innerHTML = html;
  }

  function renderTracks() {
    const host = $('#ms-tracks');
    const emptyEl = $('#ms-tracks-empty');
    if (!host || !state.draft) return;
    const dur = state.draft.duration || 1;
    const paramTracks = state.draft.tracks.filter(t => t.kind === 'param');
    if (emptyEl) emptyEl.classList.toggle('hidden', paramTracks.length > 0);
    host.innerHTML = '';

    for (const tr of paramTracks) {
      const avail = paramAvailable(tr.param);
      const row = document.createElement('div');
      row.className = 'ms-track';

      const name = document.createElement('span');
      name.className = 'ms-track-name' + (avail ? '' : ' off');
      name.textContent = tr.param + (tr.label && tr.label !== tr.param ? '  —  ' + tr.label : '');
      name.title = avail
        ? tr.param
        : __t('ms.trackUnavailable', { param: tr.param });
      row.appendChild(name);

      const lane = document.createElement('div');
      lane.className = 'ms-track-lane' + (avail ? '' : ' off');
      lane.dataset.param = tr.param;

      // Klik lane = geser playhead SAJA. Dulu sekali klik langsung membuat
      // keyframe — salah klik berarti key liar + undo stack terkotori.
      // Saat preview diputar, scrub dikunci: playhead sedang milik playback.
      lane.addEventListener('click', (ev) => {
        if (ev.target !== lane || state.playing) return;
        const rect = lane.getBoundingClientRect();
        const t = Math.max(0, Math.min(dur, ((ev.clientX - rect.left) / rect.width) * dur));
        state.scrubT = t;
        renderPlayheads(); applyScrubPose();
      });
      // Klik dua kali = tambah keyframe pada waktu itu (snap 50 ms), dengan nilai
      // hasil interpolasi saat ini, jadi menambah titik tidak mengubah bentuk kurva.
      lane.addEventListener('dblclick', (ev) => {
        if (ev.target !== lane) return;
        // Klik pertama double-click adalah scrub; kalau jalur itu membangun ulang
        // lane, event dblclick tiba di elemen yang sudah lepas dari DOM — rect-nya
        // kosong dan t terhitung = durasi (key "di ujung"). Scrub kini bebas
        // rebuild, dan sebagai pengaman kedua rect diambil dari lane yang HIDUP.
        const live = document.querySelector('.ms-track-lane[data-param="' + (lane.dataset.param || '').replace(/"/g, '') + '"]') || lane;
        const rect = live.getBoundingClientRect();
        if (!rect.width) return;
        let t = ((ev.clientX - rect.left) / rect.width) * dur;
        t = Math.round(Math.max(0, Math.min(dur, t)) / 0.05) * 0.05;
        pushUndo();
        const cur = sampleParam(tr.param, t);
        const r = rangeOf(tr.param);
        const idx = addKey(tr.param, t, cur != null ? cur : r.def);
        state.selected = { param: tr.param, index: idx };
        state.scrubT = t;
        renderAll(); applyScrubPose();
      });

      const r = rangeOf(tr.param);
      const span = Math.abs(r.max - r.min) || 1;

      lane.appendChild(curveSvgFor(tr, dur));

      tr.keys.forEach((k, i) => {
        const dot = document.createElement('div');
        const sel = state.selected && state.selected.param === tr.param && state.selected.index === i;
        dot.className = 'ms-key' + (sel ? ' sel' : '') + (k.easing === 'stepped' ? ' stepped' : '');
        dot.style.left = ((k.t / dur) * 100).toFixed(2) + '%';
        // Dot menempel pada kurva: posisi vertikal = nilai key, bukan tengah lane —
        // seretan vertikal (ubah nilai) jadi terlihat sebagai gerakan dot itu sendiri.
        dot.style.top = (100 - ((k.v - r.min) / span) * 100).toFixed(2) + '%';
        dot.title = k.t.toFixed(2) + 's = ' + k.v + (k.easing ? '  (' + k.easing + ')' : '');
        dot.addEventListener('click', (ev) => {
          ev.stopPropagation();
          state.selected = { param: tr.param, index: i };
          state.scrubT = k.t;
          renderAll(); applyScrubPose();
        });
        // Seret key: sumbu DIKUNCI pada gerakan pertama — horizontal = waktu
        // (snap 50 ms), vertikal = nilai. Shift = bebas tanpa snap. Tooltip
        // mengikuti kursor supaya waktu/nilai terbaca sambil menyeret.
        dot.addEventListener('pointerdown', (ev) => {
          if (state.playing) return;   // playback jalan — jangan rebut kendali
          ev.stopPropagation();
          ev.preventDefault();
          const rect = lane.getBoundingClientRect();
          const r = rangeOf(tr.param);
          const span = Math.abs(r.max - r.min) || 1;
          const vStep = span <= 2 ? 0.01 : (span <= 60 ? 0.1 : 1);
          const startT = k.t, startV = k.v;
          const startX = ev.clientX, startY = ev.clientY;
          let axis = null, moved = false, prevT = startT, curT = startT, curV = startV;
          pushUndo();
          showDragTip(ev, curT, curV);
          const onMove = (mv) => {
            const dx = mv.clientX - startX, dy = mv.clientY - startY;
            if (!axis && (Math.abs(dx) > 3 || Math.abs(dy) > 3))
              axis = Math.abs(dx) >= Math.abs(dy) ? 't' : 'v';
            if (!axis) return;
            moved = true;
            if (axis === 't') {
              let t = startT + (dx / rect.width) * dur;
              if (!mv.shiftKey) t = Math.round(t / 0.05) * 0.05;
              curT = Math.max(0, Math.min(dur, t));
            } else {
              let v = startV - (dy / rect.height) * span;
              if (!mv.shiftKey) v = Math.round(v / vStep) * vStep;
              curV = Math.max(r.min, Math.min(r.max, v));
            }
            const cur = trackFor(tr.param, false);
            const at = cur.keys.findIndex(x => Math.abs(x.t - prevT) < 0.0005);
            if (at >= 0) cur.keys.splice(at, 1);
            const idx = addKey(tr.param, curT, curV, k.easing);
            prevT = curT;
            state.selected = { param: tr.param, index: idx };
            state.scrubT = curT;
            renderTracks(); renderTime(); renderKeyBox(); applyScrubPose();
            showDragTip(mv, curT, curV);
          };
          const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            hideDragTip();
            if (!moved) state.undoStack.pop();   // klik biasa: jangan kotori undo
          };
          state.scrubT = k.t;
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
        });
        lane.appendChild(dot);
      });

      const head = document.createElement('div');
      head.className = 'ms-playhead';
      head.style.left = ((state.scrubT / dur) * 100).toFixed(2) + '%';
      lane.appendChild(head);
      row.appendChild(lane);

      const del = document.createElement('button');
      del.className = 'ms-track-x';
      del.type = 'button';
      del.textContent = '✕';
      del.title = __t('ms.delTrackTip', { param: tr.param });
      del.addEventListener('click', () => {
        pushUndo();
        const l2d = L2D();
        if (l2d && l2d.setRawDrive) l2d.setRawDrive({ [tr.param]: null });
        removeTrack(tr.param);
        renderAll(); applyScrubPose();
      });
      row.appendChild(del);

      host.appendChild(row);
    }
  }

  // ── Render: editor keyframe terpilih ─────────────────────────────
  function renderKeyBox() {
    const lbl = $('#ms-key-label');
    const tIn = $('#ms-key-t');
    const vIn = $('#ms-key-v');
    const vNum = $('#ms-key-v-num');
    const vOut = $('#ms-key-v-out');
    const easeSel = $('#ms-key-easing');
    const rangeHint = $('#ms-key-range');
    if (!lbl || !tIn || !vIn) return;

    const sel = state.selected;
    const tr = sel ? trackFor(sel.param, false) : null;
    const key = tr && tr.keys[sel.index];
    const enable = (on) => {
      tIn.disabled = vIn.disabled = !on;
      if (vNum) vNum.disabled = !on;
      if (easeSel) easeSel.disabled = !on;
    };

    if (!key) {
      lbl.textContent = __t('ms.noKeySel');
      tIn.value = ''; vIn.value = '0';
      if (vNum) vNum.value = '';
      if (vOut) vOut.textContent = '';
      if (rangeHint) rangeHint.textContent = '';
      enable(false);
      return;
    }

    const r = rangeOf(sel.param);
    // Step slider disesuaikan lebar range: rig 0..1 butuh langkah 0.01,
    // rig 0..100 tidak akan pernah terasa halus dengan langkah sebesar itu.
    const span = Math.abs(r.max - r.min);
    const step = span <= 2 ? 0.01 : (span <= 60 ? 0.1 : 1);
    vIn.min = String(r.min); vIn.max = String(r.max); vIn.step = String(step);
    if (vNum) { vNum.min = String(r.min); vNum.max = String(r.max); vNum.step = String(step); }
    tIn.max = String(state.draft.duration);
    tIn.step = '0.05';

    enable(true);
    const avail = paramAvailable(sel.param);
    lbl.textContent = sel.param + ' — key ' + (sel.index + 1) + '/' + tr.keys.length
      + (tr.label && tr.label !== sel.param ? '  —  ' + tr.label : '')
      + (avail ? '' : '  ' + __t('ms.notInModel'));
    tIn.value = String(key.t);
    vIn.value = String(key.v);
    if (vNum) vNum.value = String(key.v);
    if (vOut) vOut.textContent = String(+Number(key.v).toFixed(3));
    if (easeSel) easeSel.value = key.easing || tr.interp || 'linear';
    if (rangeHint) rangeHint.textContent = r.min + ' … ' + r.max;
  }

  // ── Render: metadata ─────────────────────────────────────────────
  function renderMeta() {
    const d = state.draft;
    if (!d) return;
    const set = (sel, val) => { const el = $(sel); if (el) el.value = val; };
    set('#ms-name', d.name || '');
    set('#ms-id', d.id || '');
    set('#ms-desc', d.description || '');
    set('#ms-tags', (d.tags || []).join(', '));
    set('#ms-duration', String(d.duration));
    set('#ms-cooldown', String(d.cooldown || 0));
    set('#ms-priority', String(d.priority != null ? d.priority : 60));
    const iv = $('#ms-intensity-def');
    if (iv) {
      iv.value = String(d.intensity ? d.intensity.default : 0.8);
      const out = $('#ms-intensity-def-out');
      if (out) out.textContent = Number(iv.value).toFixed(2);
    }
    const ai = $('#ms-ai-enabled'); if (ai) ai.checked = d.aiEnabled !== false;
    const lp = $('#ms-loop-meta'); if (lp) lp.checked = !!d.loop;
    const lp2 = $('#ms-loop'); if (lp2) lp2.checked = !!d.loop;

    // Slider kecocokan emosi — daftar dari sheet model ini, bukan hardcode.
    // Emosi yang sudah tersimpan di asset ikut ditampilkan walau tak ada di
    // daftar sheet saat ini, supaya nilainya bisa diubah/dihapus, tidak
    // tersimpan tapi tak terlihat.
    const host = $('#ms-emo-list');
    if (host) {
      host.innerHTML = '';
      const shown = state.emotions.slice();
      for (const k of Object.keys(d.emotionCompatibility || {})) {
        if (!shown.includes(k)) shown.push(k);
      }
      for (const emo of shown) {
        const row = document.createElement('div');
        row.className = 'ms-emo-row';
        const nm = document.createElement('span');
        nm.className = 'ms-emo-name'; nm.textContent = emo;
        const rng = document.createElement('input');
        rng.type = 'range'; rng.min = '0'; rng.max = '1'; rng.step = '0.1';
        rng.value = String((d.emotionCompatibility || {})[emo] || 0);
        rng.setAttribute('aria-label', __t('ms.emoFitAria', { emo }));
        const out = document.createElement('output');
        out.textContent = Number(rng.value).toFixed(1);
        rng.addEventListener('input', () => {
          out.textContent = Number(rng.value).toFixed(1);
          const v = Number(rng.value);
          if (!d.emotionCompatibility) d.emotionCompatibility = {};
          if (v <= 0) delete d.emotionCompatibility[emo];
          else d.emotionCompatibility[emo] = v;
          state.dirty = true;
        });
        rng.addEventListener('change', pushUndo);
        row.appendChild(nm); row.appendChild(rng); row.appendChild(out);
        host.appendChild(row);
      }
    }
  }

  function renderLibrary() {
    const sel = $('#ms-lib');
    if (!sel) return;
    const cur = state.draft ? state.draft.id : '';
    const draftIsSaved = !!state.draft && state.userMotions.some(m => m.id === cur);
    sel.innerHTML = '';
    // Draft yang belum tersimpan (hasil impor / draft baru) tampil sebagai opsi
    // terpilih tersendiri supaya nama di dropdown COCOK dengan yang sedang
    // diedit — bukan nyangkut di motion tersimpan pertama. Value sentinel
    // '__draft__' diabaikan handler change (memilihnya tidak menimpa draft).
    if (state.draft && !draftIsSaved) {
      const o = document.createElement('option');
      o.value = '__draft__';
      const nm = (state.draft.name || state.draft.id || '').trim();
      o.textContent = nm ? (nm + '  ' + __t('ms.draftUnsaved')) : __t('ms.draftNew');
      o.selected = true;
      sel.appendChild(o);
    }
    if (!state.userMotions.length && !state.draft) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = __t('ms.libEmpty');
      sel.appendChild(o);
    }
    for (const m of state.userMotions) {
      const o = document.createElement('option');
      o.value = m.id;
      // Motion dari model lain ditandai: parameternya mungkin tidak cocok.
      const foreign = m.sourceModelId && m.sourceModelId !== modelKey();
      o.textContent = (m.name || m.id) + (foreign ? '  (model lain)' : '');
      if (draftIsSaved && m.id === cur) o.selected = true;
      sel.appendChild(o);
    }
  }

  function renderTime() {
    const el = $('#ms-time');
    if (el) el.textContent = state.scrubT.toFixed(2) + 's';
    const scrub = $('#ms-scrub');
    if (scrub && state.draft) scrub.value = String(Math.round((state.scrubT / state.draft.duration) * 1000));
  }

  // Geser playhead TANPA membangun ulang lane. renderTracks() di tengah interaksi
  // klik adalah penyebab dblclick menghitung posisi dari elemen yang sudah lepas
  // dari DOM (rect kosong → key selalu mendarat di ujung timeline) — sekaligus
  // pemborosan: yang perlu berubah saat scrub cuma garis playhead.
  function renderPlayheads() {
    const dur = state.draft ? (state.draft.duration || 1) : 1;
    document.querySelectorAll('.ms-playhead').forEach(head => {
      // Clamp 0..100%: key terjauh boleh melebihi draft.duration (runtime
      // memakai max(durasi, key terjauh)) — tanpa clamp playhead menembus
      // tepi lane.
      const pct = Math.max(0, Math.min(100, (state.scrubT / dur) * 100));
      head.style.left = pct.toFixed(2) + '%';
    });
    renderTime();
  }

  // ── Sweep playhead selama preview diputar ────────────────────────
  // Playhead kini MENGIKUTI klok runtime, bukan menghitung waktunya sendiri.
  // Dulu editor memakai rAF + watchdog dengan rumus t = (now - t0) yang
  // berbeda dari runtime: runtime menunda mulainya selama blend-in, loop-nya
  // me-reset start di awal tiap siklus dan menambah blendOut di akhir —
  // playhead pasti desinkron (jalan duluan/mundur sendiri padahal pose
  // diam). Sekarang runtime memanggil onProgress(p) tiap frame tick yang
  // SAMA dengan yang menggerakkan model; p = t / totalMs, dan tSec yang
  // benar dikembalikan lewat closure playPreview().
  let sweepActive = false;
  function stopPlayheadSweep() {
    sweepActive = false;
  }
  function startPlayheadSweep() {
    stopPlayheadSweep();
    sweepActive = true;
  }

  function renderUndoButtons() {
    const u = $('#ms-undo'), r = $('#ms-redo');
    if (u) u.disabled = !state.undoStack.length;
    if (r) r.disabled = !state.redoStack.length;
  }

  function renderAll() {
    if (!state.draft) return;
    renderParamPanel(); renderRuler(); renderTracks();
    renderKeyBox(); renderMeta(); renderLibrary(); renderTime();
    renderUndoButtons();
  }

  // ── Preview via runtime (Play) ───────────────────────────────────
  // Draft ephemeral didaftarkan dengan id sementara supaya preview tidak
  // menimpa versi tersimpan di registry sebelum user menekan Simpan.
  function playPreview() {
    const l2d = L2D();
    if (!l2d || !l2d.registerUserMotion || !state.draft) return;
    const usable = state.draft.tracks.filter(t => t.kind === 'param' && t.keys.length);
    if (!usable.length) { setStatus(__t('ms.noKeysToPlay'), 'err'); return; }
    // Editor sedang menahan parameter pada posisi playhead. Kalau tidak dilepas,
    // tulisan editor dan tulisan runtime bertumpuk pada frame yang sama dan
    // yang terakhir menang secara acak — motion terlihat macet di satu pose.
    releaseAllDriven();
    const probe = Object.assign({}, state.draft, { id: PREVIEW_ID, aiEnabled: false });
    const r = l2d.registerUserMotion(probe);
    if (!r.ok) { setStatus(__t('sys.errGeneric', { msg: r.error }), 'err'); return; }
    const startT = state.scrubT;
    const loop = !!state.draft.loop;
    // totalMs HARUS identik dengan computePlaybackPlan runtime:
    // max(durasi, key terjauh, 200ms) + blendOut. Kalau beda, p di onProgress
    // menskalakan ke durasi yang salah dan playhead melenceng lagi.
    let maxKey = 0;
    for (const t of state.draft.tracks) for (const k of (t.keys || [])) if (k.t > maxKey) maxKey = k.t;
    const durSec = Math.max(state.draft.duration || 0, maxKey, 0.2);
    const blendInS = 0.12, blendOutS = 0.25;
    const totalS = durSec + blendOutS;
    stopPlayheadSweep();
    const okPlay = l2d.playMotion(PREVIEW_ID, {
      intensity: state.draft.intensity ? state.draft.intensity.default : 0.8,
      priority: 100, blendIn: 120, blendOut: 250,
      onProgress: (p) => {
        if (!sweepActive) return;
        // p = t / totalMs dari klok runtime (tick yang sama dengan yang
        // menggerakkan pose) — tidak mungkin desinkron. Konversi balik ke
        // detik timeline draft: tMs = p*totalMs; tSec = (tMs - blendIn)/1000;
        // posisi di luar [0,dur] dicukat (blend-out) atau di-modulo (loop —
        // runtime me-reset start tiap siklus, jadi t runtime memang naik
        // terus melampaui dur; modulo mengembalikan posisi siklusnya).
        let tSec = (p * totalS - blendInS);
        if (tSec < 0) tSec = 0;
        if (loop) tSec = tSec % durSec;
        else if (tSec > durSec) tSec = durSec;
        state.scrubT = tSec;
        renderPlayheads();
      },
      onDone: () => {
        state.playing = false;
        stopPlayheadSweep();
        if (l2d.removeUserMotion) l2d.removeUserMotion(PREVIEW_ID);
        // Loop: kembali ke titik mulai (playhead sudah di posisi siklus
        // terakhir). Non-loop: playhead menempel di ujung — konteks edit
        // "nyangkut" di ujung justru benar, pose edit tetap terlihat.
        state.scrubT = loop ? Math.min(startT, durSec) : durSec;
        applyScrubPose();
        renderPlayheads();
        setStatus(__t('ms.played'));
      },
    });
    state.playing = okPlay;
    if (okPlay) startPlayheadSweep();
    setStatus(okPlay ? '▶ memutar…' : 'ditolak scheduler', okPlay ? null : 'err');
  }

  function stopPreview() {
    stopPlayheadSweep();
    const l2d = L2D();
    if (l2d && l2d.stopAllMotions) l2d.stopAllMotions();
    if (l2d && l2d.removeUserMotion) l2d.removeUserMotion(PREVIEW_ID);
    state.playing = false;
    applyScrubPose();
  }

  // ── Muat / simpan ────────────────────────────────────────────────
  async function fetchUserMotions() {
    try {
      const r = await fetch(apiBase() + '/api/motions?model=' + encodeURIComponent(modelKey()));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      state.userMotions = Array.isArray(d.motions) ? d.motions : [];
    } catch (e) {
      state.userMotions = [];
    }
  }

  function refreshParams() {
    const l2d = L2D();
    state.params = (l2d && l2d.listModelParams) ? l2d.listModelParams() : [];
    state.paramById = new Map(state.params.map(p => [p.id, p]));
  }

  async function refreshEmotions() {
    const l2d = L2D();
    if (!l2d || !l2d.getCapabilityProfile) return;
    try {
      const p = await l2d.getCapabilityProfile();
      if (!p) return;
      const list = (p.emotions || []).filter(Boolean);
      state.emotions = list.length ? list.slice(0, 12) : state.emotions;
      if (!state.emotions.includes('normal')) state.emotions.push('normal');
    } catch (e) { /* biarkan default */ }
  }

  // Migrasi motion lama: track semantik (8 field) diterjemahkan ke parameter
  // mentah memakai peta peran milik model INI. Peta + range di-ambil dari
  // app.js (roleIdFor + listModelParams), bukan ditebak ulang di sini —
  // itu peta yang sama dengan yang dipakai engine saat render.
  function migrateSemanticTracks(asset) {
    const dsl = DSL();
    const l2d = L2D();
    if (!dsl || !dsl.rolesToParamTracks || !l2d) return asset;
    const hasRole = (asset.tracks || []).some(t => t.kind !== 'param' && t.target);
    if (!hasRole) return asset;
    const roleMap = {};
    for (const field in (dsl.ROLE_FOR_FIELD || {})) {
      const role = dsl.ROLE_FOR_FIELD[field];
      const id = l2d.roleIdFor ? l2d.roleIdFor(role) : null;
      if (id) roleMap[role] = id;
    }
    const ranges = {};
    for (const p of state.params) ranges[p.id] = { min: p.min, max: p.max, def: p.def };
    const out = dsl.rolesToParamTracks(asset, roleMap, ranges);
    const leftover = (out.tracks || []).filter(t => t.kind !== 'param').length;
    if (leftover) {
      setStatus(__t('ms.tracksNoMatch', { n: leftover }), 'err');
    } else {
      setStatus(__t('ms.converted'));
    }
    return out;
  }

  function loadDraft(id) {
    const found = state.userMotions.find(m => m.id === id);
    let draft = found ? JSON.parse(JSON.stringify(found)) : blankDraft();
    // .motion3.json mentah (hasil copas dari tool lain / versi lama) tidak punya
    // `tracks` — tanpa ini editor crash di trackFor dan popup nyangkut saat
    // ditutup. File berformat Cubism (punya Curves) dikonversi jadi draft DSL;
    // sisanya di-blank-kan agar editor tetap terbuka dan BISA ditutup.
    if (draft && !Array.isArray(draft.tracks)) {
      if (Array.isArray(draft.Curves)) {
        const io = window.__motionIO;
        const res = io && io.motion3ToAsset
          ? io.motion3ToAsset(draft, {
              id: (found && found.id) || id,
              name: (found && (found.name || found.id)) || id,
              sourceModelId: modelKey(),
            })
          : null;
        if (res && res.asset) {
          draft = res.asset;
          setStatus(__t('ms.importedOk', { name: draft.name || id }));
        } else {
          draft = blankDraft();
        }
      } else {
        draft = blankDraft();
      }
    }
    // Normalkan sekali: track lama tidak punya `kind`.
    for (const tr of (draft.tracks || [])) {
      if (!tr.kind) tr.kind = tr.param ? 'param' : 'role';
    }
    if (found) draft = migrateSemanticTracks(draft);
    if (!draft.sourceModelId) draft.sourceModelId = modelKey();
    state.draft = draft;
    state.selected = null;
    state.scrubT = 0;
    state.undoStack.length = 0;
    state.redoStack.length = 0;
    state.dirty = false;
    renderAll();
    applyScrubPose();
    runLint();
  }

  function collectMeta() {
    const d = state.draft;
    if (!d) return;
    const val = (sel) => { const el = $(sel); return el ? el.value : ''; };
    d.name = val('#ms-name').trim();
    d.id = val('#ms-id').trim();
    d.description = val('#ms-desc').trim();
    d.tags = val('#ms-tags').split(',').map(s => s.trim()).filter(Boolean);
    const dur = Number(val('#ms-duration'));
    if (Number.isFinite(dur) && dur >= 0.1) d.duration = dur;
    const cd = Number(val('#ms-cooldown'));
    d.cooldown = Number.isFinite(cd) && cd >= 0 ? cd : 0;
    const pr = Number(val('#ms-priority'));
    d.priority = Number.isFinite(pr) ? Math.max(0, Math.min(100, pr)) : 60;
    const iv = Number(val('#ms-intensity-def'));
    if (Number.isFinite(iv)) d.intensity = Object.assign({ min: 0.3, max: 1 }, d.intensity, { default: iv });
    const ai = $('#ms-ai-enabled'); if (ai) d.aiEnabled = ai.checked;
    const lp = $('#ms-loop-meta'); if (lp) d.loop = lp.checked;
  }

  async function saveDraft() {
    collectMeta();
    const d = state.draft;
    if (!d) return;
    if (!d.id) {
      d.id = (d.name || 'gerakan').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'gerakan';
      const el = $('#ms-id'); if (el) el.value = d.id;
    }
    // Track kosong dibuang di sini (bukan saat key terakhir dihapus): user
    // sering mengosongkan track untuk menatanya ulang.
    d.tracks = (d.tracks || []).filter(t => t.keys && t.keys.length);
    if (!d.tracks.length) { setStatus(__t('ms.needKeyframe'), 'err'); return; }

    const l2d = L2D();
    const reg = l2d && l2d.registerUserMotion ? l2d.registerUserMotion(d) : { ok: false, error: 'modul motion tidak termuat' };
    if (!reg.ok) { setStatus(__t('sys.errGeneric', { msg: reg.error }), 'err'); return; }

    const exists = state.userMotions.some(m => m.id === d.id);
    setStatus(__t('sys.saving'));
    try {
      const r = await fetch(apiBase() + '/api/motions' + (exists ? '/' + encodeURIComponent(d.id) : ''), {
        method: exists ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelKey(), motion: d }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      state.dirty = false;
      await fetchUserMotions();
      loadDraft(d.id);
      try { window.__agent && window.__agent.invalidateCapabilityProfile && window.__agent.invalidateCapabilityProfile(); } catch (e) {}
      renderRegistryList();
      setStatus(__t('ms.savedOk'), 'ok');
    } catch (e) {
      setStatus(__t('ms.saveFail', { msg: e.message }), 'err');
    }
  }

  async function deleteDraft() {
    const d = state.draft;
    if (!d || !d.id) { setStatus(__t('ms.nothingToDelete')); return; }
    if (!state.userMotions.some(m => m.id === d.id)) { loadDraft(''); setStatus(__t('ms.draftCleared')); return; }
    if (!confirm(__t('ms.delConfirm', { name: d.name || d.id }))) return;
    try {
      const r = await fetch(apiBase() + '/api/motions/' + encodeURIComponent(d.id) + '?model=' + encodeURIComponent(modelKey()), { method: 'DELETE' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const l2d = L2D();
      if (l2d && l2d.removeUserMotion) l2d.removeUserMotion(d.id);
      releaseAllDriven();
      await fetchUserMotions();
      loadDraft(state.userMotions.length ? state.userMotions[0].id : '');
      try { window.__agent && window.__agent.invalidateCapabilityProfile && window.__agent.invalidateCapabilityProfile(); } catch (e) {}
      renderRegistryList();
      setStatus(__t('ms.deleted'), 'ok');
    } catch (e) {
      setStatus(__t('ms.delFail', { msg: e.message }), 'err');
    }
  }

  function duplicateDraft() {
    collectMeta();
    if (!state.draft) return;
    const copy = JSON.parse(JSON.stringify(state.draft));
    copy.id = (copy.id || 'gerakan') + '_copy';
    copy.name = (copy.name || 'Gerakan') + ' (copy)';
    state.draft = copy;
    state.dirty = true;
    state.undoStack.length = 0; state.redoStack.length = 0;
    renderAll();
    setStatus(__t('ms.dupMade'));
  }

  // ── Ekspor / impor .motion3.json (konversi via window.__motionIO) ──
  // Ekspor = unduh file native dari draft (metadata semantik tetap tinggal
  // di .motion.json sumber). Impor = klip native dibuka jadi draft milikmu;
  // native asli tidak pernah ditulis ulang.
  function roleNamesForModel() {
    // Map NAMA ROLE (angleX, …) → param id — bentuk yang dimakan
    // rolesToParamTracks di motion-dsl (bukan map per-field).
    const dsl = DSL();
    const l2d = L2D();
    const out = {};
    if (!dsl || !dsl.ROLE_FOR_FIELD || !l2d || !l2d.roleIdFor) return out;
    for (const field in dsl.ROLE_FOR_FIELD) {
      const role = dsl.ROLE_FOR_FIELD[field];
      const id = l2d.roleIdFor(role);
      if (id) out[role] = id;
    }
    return out;
  }

  function exportDraftToMotion3() {
    collectMeta();
    const d = state.draft;
    const io = window.__motionIO;
    if (!io || !io.toMotion3) { setStatus(__t('ms.importFail', { msg: 'motion IO tidak termuat' }), 'err'); return; }
    if (!d || !d.tracks || !d.tracks.length) { setStatus(__t('ms.exportEmpty'), 'err'); return; }
    const ranges = {};
    for (const p of state.params) ranges[p.id] = { min: p.min, max: p.max, def: p.def };
    const res = io.toMotion3(d, { roleMap: roleNamesForModel(), ranges });
    if (!res.json) { setStatus(__t('ms.importFail', { msg: (res.errors || []).join('; ') }), 'err'); return; }
    const blob = new Blob([JSON.stringify(res.json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (d.id || 'motion') + '.motion3.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    if (res.skipped.length) setStatus(__t('ms.exportSkipped', { n: res.skipped.length }));
    else setStatus(__t('ms.exported', { name: d.id || 'motion' }), 'ok');
  }

  async function importMotion3Text(text, fallbackName) {
    const io = window.__motionIO;
    if (!io || !io.motion3ToAsset) { setStatus(__t('ms.importFail', { msg: 'motion IO tidak termuat' }), 'err'); return; }
    let json;
    try { json = JSON.parse(text); } catch (e) { setStatus(__t('ms.importFail', { msg: e.message }), 'err'); return; }
    const res = io.motion3ToAsset(json, { id: fallbackName, name: fallbackName, sourceModelId: modelKey() });
    if (!res.asset) { setStatus(__t('ms.importFail', { msg: (res.errors || []).join('; ') }), 'err'); return; }
    state.draft = res.asset;
    state.selected = null;
    state.scrubT = 0;
    state.undoStack.length = 0; state.redoStack.length = 0;
    state.dirty = true;
    renderAll();
    applyScrubPose();
    runLint();
    if (res.warnings && res.warnings.length) setStatus(__t('ms.importedWarn', { name: res.asset.name, n: res.warnings.length }));
    else setStatus(__t('ms.importedOk', { name: res.asset.name }), 'ok');
  }

  async function importNativeClip(a) {
    const l2d = L2D();
    if (!l2d || !l2d.fetchNativeMotionText) { setStatus(__t('ms.importFail', { msg: 'bridge tidak termuat' }), 'err'); return; }
    try {
      const text = await l2d.fetchNativeMotionText(a.file);
      await importMotion3Text(text, (a.name || a.id || '').replace(/^motion_/, ''));
    } catch (e) {
      setStatus(__t('ms.importFail', { msg: e.message }), 'err');
    }
  }

  async function renameNativeClip(a) {
    const l2d = L2D();
    if (!l2d || !l2d.renameNativeMotion || !a.file) return;
    const name = prompt(__t('ms.renameNativePrompt', { name: a.name || a.id }), a.name || a.id);
    if (name === null) return;
    const res = await l2d.renameNativeMotion(a.file, name.trim());
    if (!res.ok) { setStatus(__t('ms.renameFail', { msg: res.error }), 'err'); return; }
    renderRegistryList();
    setStatus(name.trim() ? __t('ms.renameOk', { name: name.trim() }) : __t('ms.renameReset'), 'ok');
  }

  function pickImportFile() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const text = await f.text();
      await importMotion3Text(text, (f.name || '').replace(/\.motion3\.json$/i, '').replace(/\.json$/i, ''));
    });
    inp.click();
  }

  // ── Daftar gerakan di tab Motion (semua sumber) ──────────────────
  function renderRegistryList() {
    const host = $('#motion-registry-list');
    if (!host) return;
    const l2d = L2D();
    const list = (l2d && l2d.listRegistryMotions) ? l2d.listRegistryMotions() : [];
    host.innerHTML = '';
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = __t('ms.noData');
      host.appendChild(p);
      return;
    }
    const LABEL = { builtin: __t('ms.srcBuiltin'), native: __t('ms.srcNative'), user: __t('ms.srcUser') };
    for (const a of list.slice().sort((x, y) => (x.source + x.id).localeCompare(y.source + y.id))) {
      if (a.id === PREVIEW_ID || /^preset_/.test(a.id)) continue;
      const card = document.createElement('div');
      card.className = 'motion-card';
      const nm = document.createElement('span');
      nm.className = 'mc-name';
      nm.textContent = a.name || a.id;
      if (a.description) nm.title = a.description;
      const src = document.createElement('span');
      src.className = 'mc-src' + (a.source === 'user' ? ' user' : '');
      src.textContent = LABEL[a.source] || a.source;
      const play = document.createElement('button');
      play.className = 'mini-btn ms-icon';
      play.textContent = '▶';
      play.title = __t('ms.tryTip');
      play.addEventListener('click', () => {
        if (l2d && l2d.playMotion) l2d.playMotion(a.id, { priority: 100 });
      });
      card.appendChild(nm); card.appendChild(src); card.appendChild(play);
      if (a.source === 'user') {
        const edit = document.createElement('button');
        edit.className = 'mini-btn ms-icon ms-hover';
        edit.textContent = __t('ms.editBtn');
        edit.title = __t('ms.editTip');
        edit.addEventListener('click', async () => { await openStudio(); loadDraft(a.id); });
        card.appendChild(edit);
      }
      if (a.source === 'native' && a.file) {
        // Impor = salin isi klip native jadi draft milikmu (file model tidak
        // disentuh); rename = overlay alias di data/, bukan edit model3.json.
        const imp = document.createElement('button');
        imp.className = 'mini-btn ms-icon ms-hover';
        imp.textContent = '⤓';
        imp.title = __t('ms.importNativeTip');
        // Buka studio DULU baru impor: openStudio() memanggil loadDraft() yang
        // me-reset state.draft, jadi impor harus jadi tulisan terakhir supaya
        // klip native yang dipilih tidak ketimpa draft default.
        imp.addEventListener('click', async () => { await openStudio(); await importNativeClip(a); });
        card.appendChild(imp);
        const ren = document.createElement('button');
        ren.className = 'mini-btn ms-icon ms-hover';
        ren.textContent = '✎';
        ren.title = __t('ms.renameNativeTip');
        ren.addEventListener('click', () => renameNativeClip(a));
        card.appendChild(ren);
      }
      host.appendChild(card);
    }
  }

  // ── Buka / tutup ─────────────────────────────────────────────────
  // ── Popup bisa digeser (drag lewat headernya) ──────────────────
  // Dipasang via onpointerdown/onpointermove (bukan addEventListener) supaya
  // tidak bisa dilepas oleh wiring lain. Posisi = left/top absolut via custom
  // property --ms-x/--ms-y + rule #motion-studio-popup.dragged (!important).
  // Saat pointerdown, rect popup di-snapshot dan width/height dikunci inline
  // DULU sebelum .dragged dipasang — tanpa itu popup "melompat" (anchored
  // right/bottom → left/top, dan stretch top+bottom → height auto) sehingga
  // delta drag terhitung dari posisi yang salah. Delta kursor = delta popup,
  // di-clamp supaya minimal 120px lebar / 48px tinggi tetap terlihat.
  //
  // Performa: selama drag popup digerakkan via transform (--ms-dx/--ms-dy,
  // kelas .dragging) — murni kerja compositor, isi popup tidak di-layout
  // ulang tiap frame. (backdrop-filter sudah dihapus dari semua CSS — blur
  // di atas canvas WebGL dihitung ulang tiap frame saat popup bergerak.)
  // localStorage TIDAK ditulis per pointermove (I/O sinkron di
  // main thread = jank): di-throttle 250ms, dan dipaksa tersimpan saat
  // lepas. Dobel-klik header = kembali ke posisi bawaan.
  function makePopupDraggable() {
    const pop = $('#motion-studio-popup');
    const head = pop ? pop.querySelector('.pn-popup-head') : null;
    if (!pop || !head) return;
    head.classList.add('drag-handle');
    head.title = __t('ms.headTip');
    let drag = null;
    let lastSave = 0;
    const savePos = (x, y, w, h, force) => {
      const now = performance.now();
      if (!force && now - lastSave < 250) return;
      lastSave = now;
      try { localStorage.setItem('ms-popup-pos', JSON.stringify({ left: Math.round(x), top: Math.round(y), w: Math.round(w), h: Math.round(h) })); } catch (err) {}
    };
    head.onpointerdown = (e) => {
      if (e.target.closest('button, input, select, a, details')) return;
      const r = pop.getBoundingClientRect();
      pop.style.width = Math.round(r.width) + 'px';
      pop.style.height = Math.round(r.height) + 'px';
      pop.classList.add('dragged');
      pop.style.setProperty('--ms-x', Math.round(r.left) + 'px');
      pop.style.setProperty('--ms-y', Math.round(r.top) + 'px');
      pop.style.setProperty('--ms-dx', '0px');
      pop.style.setProperty('--ms-dy', '0px');
      pop.classList.add('dragging');
      drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, w: r.width, h: r.height, tx: r.left, ty: r.top };
      head.classList.add('grabbing');
      try { head.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    };
    head.onpointermove = (e) => {
      if (!drag) return;
      const x = Math.max(120 - drag.w, Math.min(window.innerWidth - 120, drag.ox + (e.clientX - drag.sx)));
      const y = Math.max(8, Math.min(window.innerHeight - 48, drag.oy + (e.clientY - drag.sy)));
      drag.tx = x; drag.ty = y;
      // Hanya transform yang berubah selama drag — murah untuk compositor.
      pop.style.setProperty('--ms-dx', Math.round(x - drag.ox) + 'px');
      pop.style.setProperty('--ms-dy', Math.round(y - drag.oy) + 'px');
      savePos(x, y, drag.w, drag.h);
    };
    const end = (e) => {
      if (drag) {
        // Commit posisi akhir ke left/top lalu reset transform — pikselnya
        // identik, jadi tidak ada lompatan saat melepas tombol.
        pop.style.setProperty('--ms-x', Math.round(drag.tx) + 'px');
        pop.style.setProperty('--ms-y', Math.round(drag.ty) + 'px');
        savePos(drag.tx, drag.ty, drag.w, drag.h, true);
        drag = null;
      }
      pop.classList.remove('dragging');
      pop.style.removeProperty('--ms-dx');
      pop.style.removeProperty('--ms-dy');
      head.classList.remove('grabbing');
      try { head.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    head.onpointerup = end;
    head.onpointercancel = end;
    head.ondblclick = (e) => {
      if (e.target.closest('button, input, select, a')) return;
      pop.classList.remove('dragged');
      pop.style.removeProperty('--ms-x');
      pop.style.removeProperty('--ms-y');
      pop.style.removeProperty('width');
      pop.style.removeProperty('height');
      try { localStorage.removeItem('ms-popup-pos'); } catch (err) {}
    };
    restorePopupPos();
  }

  function restorePopupPos() {
    const pop = $('#motion-studio-popup');
    if (!pop) return;
    // Key lama berisi offset skema right/bottom yang arah dragnya terbalik —
    // dibuang agar posisi kacau dari sesi sebelumnya tidak dihidupkan lagi.
    try { localStorage.removeItem('ms-popup-shift'); } catch (e) {}
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem('ms-popup-pos') || 'null'); } catch (e) {}
    if (!pos || !Number.isFinite(pos.left) || !Number.isFinite(pos.top)) return;
    // Di-clamp ke viewport sekarang (jendela bisa saja di-resize/di-pindah
    // monitor sejak terakhir kali posisi disimpan).
    const w = Math.min(Number.isFinite(pos.w) ? pos.w : 960, window.innerWidth - 16);
    const x = Math.max(120 - w, Math.min(window.innerWidth - 120, pos.left));
    const y = Math.max(8, Math.min(window.innerHeight - 48, pos.top));
    pop.classList.add('dragged');
    pop.style.width = Math.round(w) + 'px';
    if (Number.isFinite(pos.h)) pop.style.height = Math.round(pos.h) + 'px';
    pop.style.setProperty('--ms-x', Math.round(x) + 'px');
    pop.style.setProperty('--ms-y', Math.round(y) + 'px');
  }

  async function openStudio() {
    const pop = $('#motion-studio-popup');
    if (!pop) return;
    const l2d = L2D();
    if (!l2d || !l2d.isReady || !l2d.isReady()) {
      const st = $('#motion-open-status');
      if (st) st.textContent = __t('ms.modelNotReady');
      return;
    }
    pop.classList.remove('hidden');
    pop.setAttribute('aria-hidden', 'false');
    state.open = true;
    makePopupDraggable();
    // Freeze yang SAMA dengan editor preset (persistent): tanpa ini idle/blink/
    // napas ikut menulis parameter dan pose hasil edit tak terlihat apa adanya.
    if (l2d.freezeForEdit) l2d.freezeForEdit($('#ms-status'), true);
    // Emosi dimuat DULU karena getCapabilityProfile() juga yang mengisi
    // state.lastSheet di app.js — dan sheet itulah sumber label + kategori
    // parameter. Tanpa urutan ini, panel parameter kosong pada pembukaan
    // pertama sampai ada sesuatu yang lain memuat sheet.
    await refreshEmotions();
    refreshParams();
    // Analisis model (range observasi + physics) SEBELUM render panel
    // parameter supaya badge ★ langsung muncul pada pembukaan pertama.
    await fetchAnalysis();
    await fetchUserMotions();
    loadDraft(state.userMotions.length ? state.userMotions[0].id : '');
    renderRegistryList();
    setStatus(state.params.length
      ? (state.userMotions.length ? __t('ms.readyParams', { n: state.params.length })
                                  : __t('ms.pickParamHint'))
      : __t('ms.noParamsInspect'));
  }

  function closeStudio() {
    const pop = $('#motion-studio-popup');
    if (!pop) return;
    // Sembunyikan DULU sebelum pembersihan: langkah cleanup tidak boleh bisa
    // membuat popup nyangkut (pernah terjadi via stopPreview→applyScrubPose
    // pada draft rusak). Pose aneh sisa cleanup gagal bisa diterima — stuck tidak.
    pop.classList.add('hidden');
    pop.setAttribute('aria-hidden', 'true');
    state.open = false;
    try {
      stopPreview();
      // Lepas semua parameter yang dikemudikan editor SEBELUM unfreeze, kalau
      // tidak nilai terakhir menempel dan model terlihat nyangkut di pose edit.
      releaseAllDriven();
      const l2d = L2D();
      if (l2d && l2d.clearRawDrive) l2d.clearRawDrive();
      if (l2d && l2d.unfreezeForEdit) l2d.unfreezeForEdit();
    } catch (e) { /* popup tetap tertutup */ }
    if (state.dirty) {
      const st = $('#motion-open-status');
      if (st) st.textContent = __t('ms.unsavedChanges');
    }
  }

  // ── ✨ Analisa AI (deskripsi + tag + kecocokan emosi) ─────────────
  // Hasilnya WAJIB disetujui user: kita hanya mengisi field, tidak menyimpan.
  async function analyzeWithAI() {
    collectMeta();
    const d = state.draft;
    if (!d || !d.tracks.some(t => t.keys && t.keys.length)) {
      setStatus(__t('ms.needKeyframeAnalyze'), 'err'); return;
    }
    setStatus(__t('ms.analyzing'));
    try {
      const r = await fetch(apiBase() + '/api/motions/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ motion: d, emotions: state.emotions }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      // Snapshot SEBELUM menimpa, supaya Undo mengembalikan tulisan user.
      pushUndo();
      if (data.description) d.description = data.description;
      if (Array.isArray(data.tags) && data.tags.length) d.tags = data.tags;
      if (data.emotionCompatibility && typeof data.emotionCompatibility === 'object') {
        d.emotionCompatibility = data.emotionCompatibility;
      }
      renderMeta();
      setStatus(__t('ms.aiFilled'), 'ok');
    } catch (e) {
      setStatus(__t('ms.analyzeFail', { msg: e.message }), 'err');
    }
  }

  // ── 🪄 Buat dari teks (AI Motion Generation) ──────────────────────
  // Output LLM berupa track SEMANTIK (LLM tidak boleh diberi daftar 223 nama
  // parameter rig — itu hanya mengundang halusinasi id). Hasilnya langsung
  // dikonversi ke track parameter memakai peta peran model ini, jadi begitu
  // muncul di editor ia sudah berupa raw track yang bisa disunting.
  function toggleGenBox(force) {
    const box = $('#ms-gen-box');
    if (!box) return;
    const show = force !== undefined ? force : box.classList.contains('hidden');
    box.classList.toggle('hidden', !show);
    if (show) {
      const inp = $('#ms-gen-input');
      if (inp) { inp.focus(); inp.select(); }
    }
  }

  /** Terima hasil generate (tracks final) ke draft — satu titik pemakaian
   *  bersama: jalur lama (LLM tracks langsung) dan Terima Batch staging. */
  function acceptGeneratedDraft(raw, nameFallback) {
    pushUndo();
    const gen = migrateSemanticTracks(raw);
    state.draft = Object.assign(blankDraft(), gen, {
      id: state.draft && state.draft.id ? state.draft.id : gen.id,
      name: state.draft && state.draft.name ? state.draft.name : (gen.name || nameFallback || 'draft'),
      sourceModelId: modelKey(),
    });
    state.selected = null;
    state.dirty = true;
    renderAll(); applyScrubPose();
    runLint();
    // langsung preview: user lihat gerakannya seketika
    try { playPreview(); } catch (e) {}
    setStatus(__t('ms.generated', { name: gen.name || nameFallback || 'draft', n: (gen.tracks || []).length }), 'ok');
    try { runCriticNow(); } catch (e) {}
  }

  // ── Panel Terima Batch (staging beat → compiler deterministik) ─────
  // Hasil generate mode beats ISTIRAHAT di panel ini sampai user Terimakan.
  // Refine per-beat = slider intensitas / tanda ±, lalu recompile — compiler
  // satu sumber kebenaran (keyframe tetap tulisan compiler, bukan LLM) dan
  // critic auto jalan setelah diterima.
  function stageBeats(meta, beats, promptText) {
    state.stagedBeats = { meta, beats, prompt: promptText, rig: rigForCompiler() };
    renderStage();
  }

  function renderStage() {
    const host = $('#ms-stage');
    if (!host) return;
    const stg = state.stagedBeats;
    if (!stg) { host.innerHTML = ''; host.classList.add('hidden'); return; }
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const rows = ['<div class="ms-lint-title">' + esc(__t('ms.stage.title')) + '</div>'];
    stg.beats.forEach((b, i) => {
      const signLabel = b.sign === -1 ? '−' : '+';
      const inten = Number(b.intensity != null ? b.intensity : 0.8);
      rows.push(
        '<div class="ms-stage-row" style="display:flex;gap:6px;align-items:center;margin:4px 0;">'
        + '<input type="checkbox" data-inc="' + i + '"' + (b._inc ? ' checked' : '') + '>'
        + '<span style="min-width:130px;overflow:hidden;text-overflow:ellipsis;">' + esc(b.beatId + ' · ' + (b.param || b.role)) + '</span>'
        + '<span style="min-width:104px;font-size:0.85em;">' + esc('t=' + Number(b.start || 0).toFixed(2) + 's d=' + Number(b.duration || 0).toFixed(2) + 's') + '</span>'
        + '<input type="range" min="0" max="1" step="0.05" data-int="' + i + '" value="' + esc(String(inten)) + '" style="flex:1;min-width:80px;">'
        + '<span data-intlab="' + i + '" style="min-width:52px;font-size:0.85em;">int ' + esc(inten.toFixed(2)) + '</span>'
        + '<button class="mini-btn ms-small" data-sign="' + i + '" style="width:26px;min-width:26px;">' + esc(signLabel) + '</button>'
        + '</div>');
    });
    rows.push('<div style="display:flex;gap:8px;margin-top:6px;">'
      + '<button id="ms-stage-apply" class="mini-btn ms-small">'
      + esc(__t('ms.stage.apply', { n: stg.beats.filter((b) => b._inc).length })) + '</button>'
      + '<button id="ms-stage-clear" class="mini-btn ms-small">' + esc(__t('ms.stage.clear')) + '</button>'
      + '</div>');
    host.innerHTML = rows.join('');
    host.classList.remove('hidden');
    host.querySelectorAll('[data-inc]').forEach((el) => el.addEventListener('change', () => {
      const i = Number(el.getAttribute('data-inc'));
      if (stg.beats[i]) { stg.beats[i]._inc = !!el.checked; renderStage(); }
    }));
    host.querySelectorAll('[data-int]').forEach((el) => el.addEventListener('input', () => {
      const i = Number(el.getAttribute('data-int'));
      if (stg.beats[i]) {
        stg.beats[i].intensity = Number(el.value);
        const lab = host.querySelector('[data-intlab="' + i + '"]');
        if (lab) lab.textContent = 'int ' + Number(el.value).toFixed(2);
      }
    }));
    host.querySelectorAll('[data-sign]').forEach((el) => el.addEventListener('click', () => {
      const i = Number(el.getAttribute('data-sign'));
      if (stg.beats[i]) { stg.beats[i].sign = (stg.beats[i].sign === -1) ? 1 : -1; renderStage(); }
    }));
    const apply = host.querySelector('#ms-stage-apply');
    if (apply) apply.addEventListener('click', applyStagedBeats);
    const clear = host.querySelector('#ms-stage-clear');
    if (clear) clear.addEventListener('click', () => { state.stagedBeats = null; renderStage(); });
  }

  function applyStagedBeats() {
    const stg = state.stagedBeats;
    if (!stg) return;
    const chosen = stg.beats.filter((b) => b._inc);
    if (!chosen.length) { setStatus(__t('ms.stage.empty'), 'err'); return; }
    const MC = (window.MotionCompiler || window.__motionCompiler);
    if (!MC || typeof MC.compileMotion !== 'function') { setStatus('MotionCompiler tidak tersedia — jalankan bun run build', 'err'); return; }
    try {
      const compiled = MC.compileMotion(chosen, { defaultIntensity: 0.8 }, stg.rig);
      if (!compiled || !compiled.tracks || !compiled.tracks.length) throw new Error('compiler tak menghasilkan track');
      const raw = Object.assign({}, stg.meta, {
        tracks: compiled.tracks.map((t) => {
          const tr = {
            target: t.target,
            keys: (t.keys || []).map((k) => ({ t: k.t, v: k.v })),
            easing: t.easing,
          };
          // Track kind param (paramId hasil approve user): bawa identitas
          // param + min/max safeRange — sanitize server menerima apa adanya.
          if (t.kind === 'param' && t.param) {
            tr.kind = 'param';
            tr.param = t.param;
            if (t.min != null) tr.min = t.min;
            if (t.max != null) tr.max = t.max;
          }
          return tr;
        }),
        duration: compiled.duration,
      });
      acceptGeneratedDraft(raw, (stg.meta && stg.meta.name) || stg.prompt || '');
      state.stagedBeats = null;
      renderStage();
    } catch (e) {
      setStatus(__t('ms.stage.applyFail', { msg: e.message }), 'err');
    }
  }

  async function generateFromText(promptArg) {
    const box = $('#ms-gen-box');
    const input = $('#ms-gen-input');
    const prompt = promptArg || (input ? input.value : '');
    if (!prompt || !prompt.trim()) { toggleGenBox(true); setStatus(__t('ms.describeFirst'), 'err'); return; }
    setStatus(__t('ms.generating'));
    // Param ekstra hasil approve user (layer user, role=null) → boleh jadi
    // target beat via field "param". Kosakata role kanonik tetap 16; param
    // asing tetap ditolak server (parse_beats).
    const sheetApi = window.__live2dAgent && window.__live2dAgent.sheet;
    const approvals = (sheetApi && typeof sheetApi.getProbeApprovals === 'function')
      ? (sheetApi.getProbeApprovals() || {}) : {};
    const probeParams = Object.keys(approvals)
      .filter(pid => approvals[pid] && !approvals[pid].role)
      .map(pid => ({
        id: pid,
        label: approvals[pid].label || '',
        safeRange: approvals[pid].safeRange || null,
        sign: approvals[pid].sign != null ? approvals[pid].sign : 1,
      }));
    try {
      const r = await fetch(apiBase() + '/api/motions/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          emotions: state.emotions,
          // Konteks model: server menganalisis motion model ini dari disk
          // dan menyisipkan amplitudo per role + daftar physics ke prompt.
          model: modelKey(),
          roleMap: roleMapForModel(),
          mode: 'beats',
          probeParams,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      // MODE BEATS → compiler klien punya umpan; LLM hanya storyboard.
      // Hasil TIDAK langsung mengganti draft: masuk panel Terima Batch —
      // user menyetel/menyaring per-beat, lalu Terimakan; keyframe tetap
      // tulisan compiler deterministik, bukan LLM.
      let raw = data.motion;
      if (data.beats && Array.isArray(raw && raw.beats)) {
        const beats = raw.beats.map((b, i) => ({
          beatId: b.beatId || ('g' + (i + 1)),
          role: b.role,
          // Beat kind param: paramId approve + safeRange-nya (dari layer user,
          // BUKAN dari LLM — angka tetap bukan milik LLM).
          param: (typeof b.param === 'string' && b.param && approvals[b.param]) ? b.param : null,
          safeRange: (b.param && approvals[b.param] && approvals[b.param].safeRange) || null,
          start: b.start || 0,
          duration: b.duration || 0.3,
          intensity: (typeof b.intensity === 'number' && Number.isFinite(b.intensity))
            ? Math.max(0, Math.min(1, b.intensity)) : 0.8,
          sign: b.sign === -1 ? -1 : 1,
          holdEnd: !!b.holdEnd,
          _inc: true,
        }));
        if (!beats.length) throw new Error('AI tidak menghasilkan beat');
        const meta = Object.assign({}, raw);
        delete meta.beats;
        stageBeats(meta, beats, prompt.trim());
        setStatus(__t('ms.stage.hint'), 'ok');
        return;
      }
      if (!raw || !Array.isArray(raw.tracks) || !raw.tracks.length) {
        throw new Error(data.error || 'AI tidak menghasilkan keyframe yang valid');
      }
      acceptGeneratedDraft(raw, prompt.trim().slice(0, 40));
      if (box) box.classList.add('hidden');
    } catch (e) {
      setStatus(__t('ms.genFail', { msg: e.message }), 'err');
    }
  }

  // ── 👁 Cek Visual (critic visual — PLAN-MOTION-PIPELINE 4d) ────────
  // Render filmstrip di harness + VLM role motion-vision menilai. Tanpa
  // koneksi vision → skipped dengan petunjuk mengaktifkan.
  async function verifyWithAI() {
    const d = state.draft;
    if (!d || !d.tracks.some(t => t.keys && t.keys.length)) {
      setStatus(__t('ms.needKeyframeAnalyze'), 'err'); return;
    }
    const intent = prompt(__t('ms.verify.prompt'), d.description || d.name || '');
    if (intent == null) return; // dibatalkan user
    setStatus(__t('ms.verify.doing'));
    try {
      const r = await fetch(apiBase() + '/api/motions/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelKey(), roleMap: roleMapForModel(), motion: d,
          intent: (intent || '').trim() || (d.description || d.name || ''),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (data.skipped) { setStatus(__t('ms.verify.skipped', { msg: data.reason || '' }), 'err'); return; }
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      renderVisualVerdict(data);
      setStatus(__t('ms.verify.done'), 'ok');
    } catch (e) {
      setStatus(__t('ms.verify.fail', { msg: e.message }), 'err');
    }
  }

  function runCriticNow() {
    const d = state.draft;
    const host = $('#ms-lint');
    if (!d || !d.tracks || !d.tracks.some(t => t.keys && t.keys.length)) {
      setStatus(__t('ms.needKeyframeAnalyze'), 'err'); return;
    }
    const CM = (window.MotionCritic || window.__motionCritic);
    if (!CM || typeof CM.critique !== 'function') { setStatus('MotionCritic tidak tersedia — jalankan bun run build', 'err'); return; }
    try {
      const report = CM.critique(d, state.rigReport ? { nativeJerkSamples: null } : {});
      const lines = ['<div class="ms-lint-title">Kritik kurva — skor ' + (report.score || 0) + '/100</div>'];
      if (report.findings && report.findings.length) {
        for (const f of report.findings) {
          lines.push('<div class="ms-lint-item"><span class="lv ' + (f.severity === 'error' ? 'err' : (f.severity === 'warn' ? 'warn' : 'info')) + '">' + (f.kind || '') + '</span><span class="msg">' + String(f.message || '') + '</span></div>');
        }
      } else {
        lines.push('<div class="ms-lint-item"><span class="lv info">ok</span><span class="msg">tidak ada temuan</span></div>');
      }
      if (host) { host.innerHTML = lines.join(''); host.classList.remove('hidden'); }
      setStatus('Critic: skor ' + (report.score || 0) + '/100', report.score >= 70 ? 'ok' : 'err');
    } catch (e) {
      setStatus('Critic gagal: ' + e.message, 'err');
    }
  }

  /** PROBE PARAM (backlog Fase 2, tombol): sweep parameter yang sedang dipilih
   *  di harness core (settle physics + capture) + attribution VLM. Butuh satu
   *  keyframe terpilih supaya paramId jelas; hasil berupa status + lint. */
  async function runProbeNow() {
    const sel = state.selected;
    const pid = (sel && sel.param)
      || (state.draft.tracks.find(t => t.kind === 'param' && t.keys && t.keys.length) || {}).param;
    if (!pid) { setStatus(__t('ms.probe.needParam'), 'err'); return; }
    setStatus(__t('ms.probe.running'));
    try {
      const r = await fetch(apiBase() + '/api/model/probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelKey(), params: [pid] }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      const item = (data.params || [])[0] || {};
      if (item.error) throw new Error(item.error);
      if (item.dead) { setStatus(__t('ms.probe.dead'), 'warn'); return; }
      const vis = item.vision || {};
      const region = vis.skipped ? '(skipped: tanpa koneksi vision)' : (vis.region || '?');
      if ($('#ms-lint')) {
        renderVisualVerdictLikeProbe(pid, item);
      }
      setStatus(__t('ms.probe.ok', { region }), 'ok');
    } catch (e) {
      setStatus(__t('ms.probe.fail', { msg: e.message }), 'err');
    }
  }

  /** Satu tampilan lint ringan hasil probe (bbox/metrik + region VLM). */
  function renderVisualVerdictLikeProbe(pid, item) {
    const host = $('#ms-lint');
    if (!host) return;
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const rows = ['<div class="ms-lint-title">Probe ' + esc(pid) + '</div>'];
    const metrics = (item.metrics || []).filter(m => m && m.changedPixels != null);
    for (const m of metrics.slice(1)) {
      const bb = m.bbox ? ('bbox ' + Math.round(m.bbox.w) + '×' + Math.round(m.bbox.h)) : 'tanpa bbox';
      rows.push('<div class="ms-lint-item"><span class="lv ' + (m.changedPixels > 0 ? 'info' : 'warn') + '">v=' + esc(m.v) + '</span><span class="msg">' + esc(bb) + ' · piksel berubah: ' + esc(m.changedPixels) + '</span></div>');
    }
    const vis = item.vision || {};
    if (vis.skipped) {
      rows.push('<div class="ms-lint-item"><span class="lv warn">vision</span><span class="msg">' + esc(vis.reason || 'skipped') + '</span></div>');
    } else if (vis.region) {
      rows.push('<div class="ms-lint-item"><span class="lv info">region</span><span class="msg">' + esc(vis.region) + (vis.sign != null ? ' · sign ' + esc(vis.sign) : '') + (vis.confidence != null ? ' · ' + Math.round(vis.confidence * 100) + '%' : '') + '</span></div>');
    }
    host.innerHTML = rows.join('');
    host.classList.remove('hidden');
  }

  // ── Panel Approve Batch (Fase 3: promosi param probe → layer user) ──
  // Probe batch param unclassified → baris per param, urut paling perlu
  // mata manusia di atas (konflik → mati/gagal → tanpa vision → percaya
  // rendah → konsisten) → user pilih role kanonik ATAU param ekstra →
  // Setujui → sheet layer `user` (mutlak, selamat re-inspeksi).
  // Stale: modelHash approve ≠ modelHash rig report kini → badge, tawarkan
  // probe ulang — jangan dipakai buta (amanat PLAN Fase 1).
  function agentSheetApi() {
    const s = window.__live2dAgent && window.__live2dAgent.sheet;
    return (s && typeof s.approveProbe === 'function') ? s : null;
  }

  function roleChoicesForDropdown() {
    const rm = window.__roleMapping;
    const keys = rm && rm.ROLE_KEYWORDS ? Object.keys(rm.ROLE_KEYWORDS) : [];
    return keys.sort();
  }

  /** Bangun satu baris panel dari hasil probe. Cross-check VLM ↔ metrik
   *  piksel (Fase 2e) dijalankan di sini — konflik region → baris naik ke
   *  paling atas. Region "tidak_terlihat" bukan klaim (bukan konflik). */
  function probeRowFromResult(pid, item, cdiLabel) {
    const frames = (item.metrics || []).filter(m => m && m.changedPixels != null);
    const worst = frames.reduce(
      (a, b) => ((b.changedPixels || 0) > (a.changedPixels || 0) ? b : a),
      { changedPixels: 0 },
    );
    const vis = item.vision || {};
    let conflict = false;
    let reasons = [];
    const MP = window.MotionProbe;
    if (MP && typeof MP.crossCheck === 'function' && !vis.skipped && vis.ok !== false
      && vis.region && vis.region !== 'tidak_terlihat') {
      const cc = MP.crossCheck(
        { region: vis.region, sign: vis.sign, confidence: vis.confidence, notes: vis.notes },
        { bbox: worst.bbox || null, centroid: worst.centroid || null, changedPixels: worst.changedPixels || 0, diffRatio: worst.diffRatio || 0 },
        0, 0,
      );
      conflict = !!cc.conflict;
      reasons = cc.reasons || [];
    }
    return {
      paramId: pid,
      label: cdiLabel || pid,
      error: null,
      dead: !!item.dead,
      conflict, reasons,
      region: vis.region || '',
      sign: vis.sign,
      confidence: vis.confidence,
      safeRange: vis.safeRange || null,
      notes: vis.notes || '',
      range: item.range || null,
      worst,
      visionSkipped: !!vis.skipped,
      roleChoice: '',
      include: !item.dead && !conflict,
    };
  }

  function probeRowSeverity(r) {
    if (r.error) return 2;      // probe gagal — tak terverifikasi
    if (r.conflict) return 0;   // konflik VLM vs piksel — wajib mata manusia
    if (r.dead) return 1;       // dead: kategori sendiri, tidak dikubur
    if (r.visionSkipped) return 2;
    if (typeof r.confidence === 'number' && r.confidence < 0.6) return 3;
    return 4;                   // konsisten
  }

  async function runApprovePanel() {
    const sheetApi = agentSheetApi();
    if (!sheetApi) { setStatus(__t('ms.approve.needSheet'), 'err'); return; }
    try {
      // Rig report segar: modelHash terkini + daftar unclassified.
      let rr = null;
      try {
        const r = await fetch(apiBase() + '/api/model/rig-report?name=' + encodeURIComponent(modelKey()));
        if (r.ok) rr = await r.json();
      } catch (e) { /* fallback ke cache */ }
      if (!rr) rr = state.rigReport;
      if (!rr) throw new Error('rig report tidak tersedia');
      state.rigReport = rr;

      const approved = sheetApi.getProbeApprovals();
      const unclassified = (rr.unclassified || []).filter(p => !(p in approved));
      if (!unclassified.length) {
        state.probePanel = { rows: [], hash: rr.modelHash || '' };
        renderApprovePanel();
        setStatus(__t('ms.approve.empty'));
        return;
      }

      // Batch 6 param/panggilan (batas server), sekuensial supaya progres jujur.
      const rows = [];
      const batches = [];
      for (let i = 0; i < unclassified.length; i += 6) batches.push(unclassified.slice(i, i + 6));
      for (let bi = 0; bi < batches.length; bi++) {
        setStatus(__t('ms.approve.running', { i: bi + 1, n: batches.length }));
        const r = await fetch(apiBase() + '/api/model/probe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelKey(), params: batches[bi] }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
        for (const item of (data.params || [])) {
          const cdi = (rr.provenance && rr.provenance[item.paramId] && rr.provenance[item.paramId].label) || '';
          if (item.error) {
            rows.push({
              paramId: item.paramId, label: cdi || item.paramId, error: item.error,
              dead: false, conflict: false, reasons: [], region: '', sign: null,
              confidence: null, safeRange: null, notes: '', range: null, worst: null,
              visionSkipped: true, roleChoice: '', include: false,
            });
          } else {
            rows.push(probeRowFromResult(item.paramId, item, cdi));
          }
        }
      }
      rows.sort((a, b) => probeRowSeverity(a) - probeRowSeverity(b));
      state.probePanel = { rows, hash: rr.modelHash || '' };
      renderApprovePanel();
      setStatus(__t('ms.approve.hint'));
    } catch (e) {
      setStatus(__t('ms.approve.probeFail', { msg: e.message }), 'err');
    }
  }

  function renderApprovePanel() {
    const host = $('#ms-approve-panel');
    if (!host) return;
    const pp = state.probePanel;
    const sheetApi = agentSheetApi();
    if (!pp || !sheetApi) { host.innerHTML = ''; host.classList.add('hidden'); return; }
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const lines = ['<div class="ms-lint-title">' + esc(__t('ms.approve.title')) + '</div>'];

    // Bagian 1: sudah di layer user (dengan badge stale + hapus).
    const approved = sheetApi.getProbeApprovals() || {};
    const approvedIds = Object.keys(approved);
    if (approvedIds.length) {
      lines.push('<div style="font-size:0.85em;opacity:.85;margin:2px 0 4px;">' + esc(__t('ms.approve.approvedTitle')) + '</div>');
      for (const pid of approvedIds) {
        const a = approved[pid];
        const stale = !!(pp.hash && a.modelHash && a.modelHash !== pp.hash);
        lines.push(
          '<div class="ms-stage-row" style="display:flex;gap:6px;align-items:center;margin:3px 0;">'
          + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'
          + esc(pid + (a.label ? ' · ' + a.label : ''))
          + ' <span class="lv info">' + esc(a.role ? ('role ' + a.role) : __t('ms.approve.roleNone')) + '</span>'
          + (stale ? ' <span class="lv warn">' + esc(__t('ms.approve.stale')) + '</span>' : '')
          + '</span>'
          + '<button class="mini-btn ms-small" data-rm="' + esc(pid) + '">' + esc(__t('ms.approve.remove')) + '</button>'
          + '</div>');
      }
    }

    // Bagian 2: hasil probe baru — urut severity (atas = paling perlu mata manusia).
    const rows = pp.rows || [];
    if (rows.length) {
      const roleKeys = roleChoicesForDropdown();
      rows.forEach((r, i) => {
        const sev = probeRowSeverity(r);
        const disabled = !!(r.dead || r.error);
        const badge = r.error
          ? '<span class="lv err">' + esc(__t('ms.approve.probeErr')) + '</span>'
          : r.conflict
            ? '<span class="lv err">' + esc(__t('ms.approve.conflict')) + '</span>'
            : r.dead
              ? '<span class="lv warn">' + esc(__t('ms.approve.dead')) + '</span>'
              : r.visionSkipped
                ? '<span class="lv warn">' + esc(__t('ms.approve.noVision')) + '</span>'
                : (sev === 3 ? '<span class="lv warn">' + esc(__t('ms.approve.lowconf')) + '</span>' : '<span class="lv info">ok</span>');
        const ev = [];
        if (r.region) ev.push(esc(r.region));
        if (r.sign != null) ev.push('sign ' + esc(r.sign));
        if (r.confidence != null) ev.push(Math.round(r.confidence * 100) + '%');
        if (r.worst && r.worst.changedPixels != null) ev.push(esc(r.worst.changedPixels) + ' px');
        if (r.safeRange) ev.push('[' + esc(r.safeRange[0]) + ', ' + esc(r.safeRange[1]) + ']');
        if (r.error) ev.push(esc(r.error));
        if (r.reasons && r.reasons.length) ev.push(esc(r.reasons.join('; ')));
        const roleOpts = ['<option value="">' + esc(__t('ms.approve.roleNone')) + '</option>']
          .concat(roleKeys.map((k) => '<option value="' + esc(k) + '"' + (r.roleChoice === k ? ' selected' : '') + '>' + esc(k) + '</option>'))
          .join('');
        lines.push(
          '<div class="ms-stage-row" style="display:flex;gap:6px;align-items:center;margin:3px 0;flex-wrap:wrap;">'
          + '<input type="checkbox" data-inc="' + i + '"' + (r.include ? ' checked' : '') + (disabled ? ' disabled' : '') + '>'
          + '<span style="min-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(r.paramId) + '">' + badge + ' ' + esc(r.paramId) + '</span>'
          + '<input type="text" data-lbl="' + i + '" value="' + esc(r.labelEdit != null ? r.labelEdit : r.label) + '" maxlength="80" style="width:130px;" title="' + esc(__t('ms.approve.labelHint')) + '">'
          + '<select data-role="' + i + '" style="max-width:140px;">' + roleOpts + '</select>'
          + '<span style="flex:1;min-width:180px;font-size:0.85em;opacity:.9;">' + ev.join(' · ') + '</span>'
          + '</div>');
      });
      const n = rows.filter((r) => r.include).length;
      lines.push('<div style="display:flex;gap:8px;margin-top:6px;">'
        + '<button id="ms-approve-apply" class="mini-btn ms-small">' + esc(__t('ms.approve.apply', { n })) + '</button>'
        + '<button id="ms-approve-close" class="mini-btn ms-small">' + esc(__t('ms.approve.clear')) + '</button>'
        + '</div>');
    }

    host.innerHTML = lines.join('');
    host.classList.remove('hidden');

    host.querySelectorAll('[data-inc]').forEach((el) => el.addEventListener('change', () => {
      const i = Number(el.getAttribute('data-inc'));
      if (rows[i] && !rows[i].dead && !rows[i].error) { rows[i].include = !!el.checked; renderApprovePanel(); }
    }));
    host.querySelectorAll('[data-lbl]').forEach((el) => el.addEventListener('input', () => {
      const i = Number(el.getAttribute('data-lbl'));
      if (rows[i]) rows[i].labelEdit = el.value;
    }));
    host.querySelectorAll('[data-role]').forEach((el) => el.addEventListener('change', () => {
      const i = Number(el.getAttribute('data-role'));
      if (rows[i]) rows[i].roleChoice = el.value;
    }));
    host.querySelectorAll('[data-rm]').forEach((el) => el.addEventListener('click', async () => {
      const pid = el.getAttribute('data-rm');
      try {
        await sheetApi.removeProbeApproval(pid);
        setStatus(__t('ms.approve.removed', { pid }), 'ok');
        renderApprovePanel();
      } catch (e) {
        setStatus(__t('ms.approve.applyFail', { msg: e.message }), 'err');
      }
    }));
    const apply = host.querySelector('#ms-approve-apply');
    if (apply) apply.addEventListener('click', applyApproveRows);
    const close = host.querySelector('#ms-approve-close');
    if (close) close.addEventListener('click', () => { state.probePanel = null; renderApprovePanel(); });
  }

  async function applyApproveRows() {
    const pp = state.probePanel;
    const sheetApi = agentSheetApi();
    if (!pp || !sheetApi) return;
    const chosen = (pp.rows || []).filter((r) => r.include && !r.dead && !r.error);
    if (!chosen.length) { setStatus(__t('ms.approve.noSelection'), 'err'); return; }
    try {
      const entries = chosen.map((r) => ({
        paramId: r.paramId,
        role: r.roleChoice || null,
        label: (r.labelEdit != null ? r.labelEdit : r.label) || '',
        region: r.region || '',
        sign: r.sign,
        safeRange: r.safeRange,
        confidence: r.confidence,
        modelHash: pp.hash || '',
        // Konflik cross-check diawetkan sebagai notes — bukti audit kenapa
        // param ini perlu mata manusia saat approve.
        notes: (r.reasons && r.reasons.length)
          ? ('cross-check konflik: ' + r.reasons.join('; '))
          : (r.notes || ''),
      }));
      await sheetApi.approveProbe(entries);
      setStatus(__t('ms.approve.applyOk', { n: entries.length }), 'ok');
      state.probePanel.rows = (pp.rows || []).filter((r) => !r.include);
      renderApprovePanel();
    } catch (e) {
      setStatus(__t('ms.approve.applyFail', { msg: e.message }), 'err');
    }
  }

  function renderVisualVerdict(v) {
    const host = $('#ms-lint');
    if (!host) return;
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const row = (cls, label, msg) =>
      '<div class="ms-lint-item"><span class="lv ' + cls + '">' + esc(label) + '</span><span class="msg">' + esc(msg) + '</span></div>';
    const conf = (v.confidence != null) ? Math.round(v.confidence * 100) + '%' : '?';
    const rows = ['<div class="ms-lint-title">' + esc(__t('ms.verify.title', { c: conf })) + '</div>'];
    rows.push(row(v.playing ? 'info' : 'err', __t('ms.verify.playing'), v.playing ? __t('ms.verify.yes') : __t('ms.verify.no')));
    rows.push(row(v.matchesIntent ? 'info' : 'warn', __t('ms.verify.intent'), v.matchesIntent ? __t('ms.verify.yes') : __t('ms.verify.no')));
    for (const a of (v.artifacts || [])) rows.push(row('warn', __t('ms.verify.artifacts'), a));
    if (v.notes) rows.push(row('info', __t('ms.verify.notes'), v.notes));
    host.innerHTML = rows.join('');
    host.classList.remove('hidden');
  }

  // ── Wiring ───────────────────────────────────────────────────────
  function on(sel, ev, fn) { const el = $(sel); if (el) el.addEventListener(ev, fn); }

  // Ubah nilai key terpilih + langsung tulis ke model (preview realtime).
  function setSelectedValue(v, commit) {
    const sel = state.selected;
    if (!sel) return;
    const tr = trackFor(sel.param, false);
    const key = tr && tr.keys[sel.index];
    if (!key) return;
    const r = rangeOf(sel.param);
    const nv = Math.max(r.min, Math.min(r.max, Number(v)));
    if (!Number.isFinite(nv)) return;
    if (commit) pushUndo();
    key.v = +nv.toFixed(4);
    state.dirty = true;
    state.scrubT = key.t;
    const vIn = $('#ms-key-v'), vNum = $('#ms-key-v-num'), vOut = $('#ms-key-v-out');
    if (vIn) vIn.value = String(key.v);
    if (vNum) vNum.value = String(key.v);
    if (vOut) vOut.textContent = String(+Number(key.v).toFixed(3));
    renderTracks(); renderTime(); applyScrubPose();
  }

  function wire() {
    on('#btn-open-motion-studio', 'click', openStudio);
    on('#motion-studio-close', 'click', closeStudio);

    on('#ms-lib', 'change', (e) => {
      // Opsi draft belum tersimpan: bukan tujuan pindah — biarkan draft apa adanya.
      if (e.target.value === '__draft__') return;
      if (state.dirty && !confirm(__t('ms.confirmSwitch'))) { renderLibrary(); return; }
      releaseAllDriven();
      loadDraft(e.target.value);
    });
    on('#ms-new', 'click', () => {
      if (state.dirty && !confirm(__t('ms.confirmNew'))) return;
      releaseAllDriven();
      state.draft = blankDraft();
      state.selected = null; state.scrubT = 0; state.dirty = false;
      state.undoStack.length = 0; state.redoStack.length = 0;
      renderAll();
      setStatus(__t('ms.newMotion'));
    });
    on('#ms-dup', 'click', duplicateDraft);
    on('#ms-del', 'click', deleteDraft);
    on('#ms-export', 'click', exportDraftToMotion3);
    on('#ms-import', 'click', pickImportFile);

    on('#ms-play', 'click', () => { collectMeta(); renderAll(); playPreview(); });
    on('#ms-stop', 'click', () => { stopPreview(); setStatus(__t('ms.stopped')); });
    on('#ms-loop', 'change', (e) => {
      if (state.draft) state.draft.loop = e.target.checked;
      const m = $('#ms-loop-meta'); if (m) m.checked = e.target.checked;
      state.dirty = true;
    });
    on('#ms-undo', 'click', undo);
    on('#ms-redo', 'click', redo);

    // Panel parameter
    on('#ms-param-search', 'input', (e) => { state.search = e.target.value; renderParamPanel(); });
    on('#ms-param-group', 'change', (e) => { state.groupFilter = e.target.value; renderParamPanel(); });

    // Scrub playhead → pose model langsung ikut (bukan cuma saat Play).
    on('#ms-scrub', 'input', (e) => {
      if (!state.draft || state.playing) return;
      state.scrubT = (Number(e.target.value) / 1000) * state.draft.duration;
      renderPlayheads(); applyScrubPose();
    });

    // Ruler = permukaan scrub kedua: klik/seret langsung di atas angka waktu.
    const ruler = $('#ms-ruler');
    if (ruler) {
      let scrubbing = false;
      const scrubFromEvent = (ev) => {
        if (!state.draft || !state.draft.duration || state.playing) return;
        const rect = ruler.getBoundingClientRect();
        const t = Math.max(0, Math.min(state.draft.duration,
          ((ev.clientX - rect.left) / rect.width) * state.draft.duration));
        state.scrubT = t;
        renderPlayheads(); applyScrubPose();
      };
      ruler.addEventListener('pointerdown', (ev) => {
        scrubbing = true;
        try { ruler.setPointerCapture(ev.pointerId); } catch (err) {}
        scrubFromEvent(ev);
      });
      ruler.addEventListener('pointermove', (ev) => { if (scrubbing) scrubFromEvent(ev); });
      ruler.addEventListener('pointerup', () => { scrubbing = false; });
      ruler.addEventListener('pointercancel', () => { scrubbing = false; });
    }

    on('#ms-key-t', 'change', (e) => {
      const sel = state.selected;
      if (!sel) return;
      const tr = trackFor(sel.param, false);
      const key = tr && tr.keys[sel.index];
      if (!key) return;
      pushUndo();
      const v = key.v, easing = key.easing;
      removeKey(sel.param, sel.index);
      const idx = addKey(sel.param, Number(e.target.value), v, easing);
      state.selected = { param: sel.param, index: idx };
      state.scrubT = trackFor(sel.param, false).keys[idx].t;
      renderAll(); applyScrubPose();
    });
    // Slider: live edit tiap gerakan (input), snapshot undo saat lepas (change).
    on('#ms-key-v', 'input', (e) => setSelectedValue(e.target.value, false));
    on('#ms-key-v', 'change', () => pushUndo());
    // Angka pas: ter-apply saat diketik, tidak menunggu blur.
    on('#ms-key-v-num', 'input', (e) => setSelectedValue(e.target.value, false));
    on('#ms-key-v-num', 'change', () => pushUndo());

    on('#ms-key-easing', 'change', (e) => {
      const sel = state.selected;
      if (!sel) return;
      const tr = trackFor(sel.param, false);
      const key = tr && tr.keys[sel.index];
      if (!key) return;
      pushUndo();
      key.easing = e.target.value;
      state.dirty = true;
      renderTracks(); applyScrubPose();
    });

    on('#ms-key-add', 'click', () => {
      const sel = state.selected;
      const paramId = sel ? sel.param
        : (state.draft.tracks.find(t => t.kind === 'param') || {}).param;
      if (!paramId) { setStatus(__t('ms.needTrack'), 'err'); return; }
      pushUndo();
      const cur = sampleParam(paramId, state.scrubT);
      const r = rangeOf(paramId);
      const idx = addKey(paramId, state.scrubT, cur != null ? cur : r.def);
      state.selected = { param: paramId, index: idx };
      renderAll(); applyScrubPose();
    });
    on('#ms-key-dupe', 'click', () => {
      const sel = state.selected;
      if (!sel) { setStatus(__t('ms.needKeySel')); return; }
      const tr = trackFor(sel.param, false);
      const key = tr && tr.keys[sel.index];
      if (!key) return;
      pushUndo();
      const idx = addKey(sel.param, Math.min(state.draft.duration, key.t + 0.2), key.v, key.easing);
      state.selected = { param: sel.param, index: idx };
      renderAll(); applyScrubPose();
    });
    on('#ms-key-copy', 'click', () => {
      const sel = state.selected;
      const tr = sel ? trackFor(sel.param, false) : null;
      const key = tr && tr.keys[sel.index];
      if (!key) { setStatus(__t('ms.needKeySel')); return; }
      state.clipboardKey = { v: key.v, easing: key.easing };
      setStatus(__t('ms.keyCopied', { v: key.v }));
    });
    on('#ms-key-paste', 'click', () => {
      if (!state.clipboardKey) { setStatus(__t('ms.nothingCopied')); return; }
      const sel = state.selected;
      const paramId = sel ? sel.param
        : (state.draft.tracks.find(t => t.kind === 'param') || {}).param;
      if (!paramId) { setStatus(__t('ms.needTargetTrack'), 'err'); return; }
      pushUndo();
      // Nilai di-clamp ke range track TUJUAN: paste dari rig 0..100 ke param
      // 0..1 tanpa clamp akan menulis nilai di luar range dan pose rusak.
      const idx = addKey(paramId, state.scrubT, state.clipboardKey.v, state.clipboardKey.easing);
      state.selected = { param: paramId, index: idx };
      renderAll(); applyScrubPose();
      setStatus(__t('ms.keyPasted', { param: paramId }));
    });
    on('#ms-key-del', 'click', () => {
      const sel = state.selected;
      if (!sel) { setStatus(__t('ms.needKeySel')); return; }
      pushUndo();
      removeKey(sel.param, sel.index);
      state.selected = null;
      renderAll(); applyScrubPose();
    });

    on('#ms-duration', 'change', () => { pushUndo(); collectMeta(); renderAll(); });
    on('#ms-intensity-def', 'input', (e) => {
      const out = $('#ms-intensity-def-out');
      if (out) out.textContent = Number(e.target.value).toFixed(2);
      state.dirty = true;
    });
    for (const s of ['#ms-name', '#ms-id', '#ms-desc', '#ms-tags', '#ms-cooldown', '#ms-priority']) {
      on(s, 'change', () => { pushUndo(); collectMeta(); });
    }
    on('#ms-ai-enabled', 'change', () => { pushUndo(); collectMeta(); });
    on('#ms-loop-meta', 'change', () => {
      pushUndo(); collectMeta();
      const t = $('#ms-loop'); if (t && state.draft) t.checked = !!state.draft.loop;
    });

    on('#ms-save', 'click', saveDraft);
    on('#ms-analyze', 'click', analyzeWithAI);
    on('#ms-verify', 'click', verifyWithAI);
    on('#ms-critic', 'click', runCriticNow);
  on('#ms-probe', 'click', () => { try { runProbeNow(); } catch (e) { setStatus('Probe gagal: ' + e.message, 'err'); } });
    on('#ms-approve', 'click', () => { try { runApprovePanel(); } catch (e) { setStatus(__t('ms.approve.probeFail', { msg: e.message }), 'err'); } });
    on('#ms-generate', 'click', () => toggleGenBox());
    on('#ms-gen-go', 'click', () => generateFromText());
    on('#ms-gen-input', 'keydown', (ev) => { if (ev.key === 'Enter') generateFromText(); });
    document.querySelectorAll('.ms-gen-chip').forEach((ch) => ch.addEventListener('click', () => {
      const inp = $('#ms-gen-input');
      if (inp) inp.value = ch.dataset.q || '';
      generateFromText(ch.dataset.q || '');
    }));

    // Keyboard: Space = putar/berhenti · Delete/Backspace = hapus key terpilih ·
    // Ctrl+Z / Ctrl+Y (atau Ctrl+Shift+Z) = undo/redo · Escape = tutup.
    // Diabaikan saat fokus di field input — mengetik angka tidak boleh memicu aksi.
    document.addEventListener('keydown', (e) => {
      if (!state.open) return;
      if (e.key === 'Escape') { closeStudio(); return; }
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (state.playing) { stopPreview(); setStatus(__t('ms.stopped')); }
        else { collectMeta(); renderAll(); playPreview(); }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
        e.preventDefault();
        pushUndo();
        removeKey(state.selected.param, state.selected.index);
        state.selected = null;
        renderAll(); applyScrubPose();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault(); undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault(); redo();
      }
    });

    const motionTab = document.querySelector('.tab[data-tab="motion"]');
    if (motionTab) motionTab.addEventListener('click', () => setTimeout(renderRegistryList, 50));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  // Permukaan kecil untuk test/QA — tidak dipakai UI.
  window.__motionStudio = {
    open: openStudio, close: closeStudio,
    _state: () => ({
      id: state.draft && state.draft.id,
      dirty: state.dirty,
      tracks: state.draft ? state.draft.tracks.length : 0,
      params: state.params.length,
      scrubT: state.scrubT,
      selected: state.selected,
    }),
  };
})();
