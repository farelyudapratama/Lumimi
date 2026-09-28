/**
 * js/mode-runtime.js — Sistem mode: chat (default) / vtuber / assistant / pet.
 * Aturan ketat: HANYA SATU mode aktif. Pindah mode = runtime lama dihancurkan
 * (interval, listener, feed dibersihkan) sebelum yang baru dinyalakan.
 */
(function () {
  // Basis HTTP via seam transport (bundle.js, dimuat sebelum file ini):
  // embedded → loopback proses-sendiri; dev → origin halaman.
  const apiBase = () =>
    window.__transport && typeof window.__transport.httpBase === "function"
      ? window.__transport.httpBase()
      : location.origin;
  // Domain MODE via helper IPC-nya (embedded → command, dev → HTTP).
  const modeGet = () =>
    window.__transport && typeof window.__transport.modeGet === "function"
      ? window.__transport.modeGet()
      : fetch(apiBase() + "/api/mode").then((r) => r.json());
  const modeSet = (mode) =>
    window.__transport && typeof window.__transport.modeSet === "function"
      ? window.__transport.modeSet(mode)
      : post("/api/mode", { mode });
  // i18n: window.__i18n dipasang bundle.js (dimuat sebelum file ini).
  const __t = (k, v) => (window.__i18n ? window.__i18n.t(k, v) : k);
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  let active = "chat";
  let destroyFn = null;
  let pollTimer = null;

  // ── Util ─────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  async function post(path, body) {
    const r = await fetch(apiBase() + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(d.error || "HTTP " + r.status);
    return d;
  }

  // ── Mode switching ───────────────────────────────────────────
  function setPanel(mode) {
    $$(".mode-panel").forEach((p) => p.classList.add("hidden"));
    const panel = $("#mode-" + mode);
    if (panel) panel.classList.remove("hidden");
    $$("#mode-switch button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    // Workspace agent melebar dan pane teknis hanya hidup di mode Assistant.
    const workspace = $("#agent-workspace");
    if (workspace) workspace.classList.toggle("agent-wide", mode === "assistant");
    const tech = $("#agent-tech");
    if (tech) tech.classList.toggle("hidden", mode !== "assistant");
    // Mode Agent saja: panggung bersih — HUD (hint/Full Body/strip status)
    // disembunyikan via CSS body.mode-agent. Mode lain tanpa perubahan.
    document.body.classList.toggle("mode-agent", mode === "assistant");
    // Mode Chat: strip telemetri (presence/mood/masa tenang) ikut disembunyikan
    // — itu instrumen pacing siaran (VTuber), bukan bagian dari ngobrol.
    document.body.classList.toggle("mode-chat", mode === "chat");
    const labels = { chat: "Chat", vtuber: "VTuber", assistant: "Assistant", pet: "Pet" };
    const lbl = $("#mode-label");
    if (lbl) lbl.textContent = labels[mode] || mode;
  }

  async function switchMode(mode) {
    if (mode === active) { setPanel(mode); return; }
    // 1) hancurkan runtime client lama (UI saja — assistant & pet di server
    //    adalah layanan mandiri, tidak ikut dimatikan). Speech aktif ikut
    //    dihentikan (checklist §36 arsitektur: bicara tidak menyambung silang
    //    antar mode).
    try { if (destroyFn) destroyFn(); } catch (e) { console.warn("[mode] teardown lama gagal:", e); }
    destroyFn = null;
    try { window.__live2dAgent && window.__live2dAgent.stopSpeaking && window.__live2dAgent.stopSpeaking(); } catch (e) {}
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    // 2) mode aktif untuk PANEL; server hanya membongkar runtime vtuber.
    //    Kosakata server tidak mengenal "chat" — panel chat = "stage" di API.
    //    Tanpa pemetaan ini POST-nya 400 dan `active` di server nyangkut di
    //    mode lama (invarian MODES.md: /api/mode satu-satunya pintu).
    const serverMode = mode === "chat" ? "stage" : mode;
    try { await modeSet(serverMode); } catch (e) { console.warn("[mode] server switch:", e.message); }
    active = mode;
    setPanel(mode);
    // 3) nyalakan runtime client baru
    if (mode === "vtuber") destroyFn = startVtuberClient();
    else if (mode === "assistant") destroyFn = startAssistantClient();
    else if (mode === "pet") destroyFn = startPetClient();
  }

  // ═════════════════════════════════════════════════════════════
  // VTUBER — feed live + alert donasi + bicara balasan server.
  // Behavior (dedup/cooldown audience, antrean donation FIFO-20, antrean
  // operator + precedence, LLM balasan) hidup di SERVER
  // (vtuber-scheduler.ts) — klien ini hanya LAYAR: render feed, alert
  // donasi, dan memutar balasan (event "agent") saat overlay OBS tidak
  // on-air (heartbeat server yang memutuskan siapa yang bicara).
  // ═════════════════════════════════════════════════════════════
  function startVtuberClient() {
    const feed = $("#vt-feed");
    const status = $("#vt-status");
    const alertBox = $("#vt-alert");
    let cursor = 0;
    let stopped = false;
    let running = false;
    // Overlay OBS (vtuber.html) terhubung → app utama mundur: balasan
    // dibicarakan overlay, bukan di dua tempat sekaligus.
    let overlayOn = false;

    function line(ev) {
      const cls = ev.type === "donation" ? "donation" : ev.type === "system" ? "system" : ev.type === "agent" ? "agent" : "";
      const row = el("div", "vt-line " + cls);
      if (ev.type === "donation") row.appendChild(el("span", "vt-amount", String(ev.amount || "")));
      row.appendChild(el("span", "vt-user", ev.user));
      row.appendChild(document.createTextNode(ev.text || ""));
      feed.appendChild(row);
      while (feed.children.length > 120) feed.removeChild(feed.firstChild);
      feed.scrollTop = feed.scrollHeight;
    }

    function alert(ev) {
      alertBox.textContent = __t("vtOv.alert", {
        user: ev.user,
        amount: ev.amount || "",
      });
      alertBox.classList.remove("hidden");
      setTimeout(() => alertBox.classList.add("hidden"), 6000);
    }

    // Balasan server dibicarakan lewat pipeline speech app utama
    // (__debugSpeak → policy speech kelas "vtuber", Fase 2). Ekspresi + gerak
    // ditambahkan lewat brain (expressReply, visual-saja) sehingga karakter
    // berreaksi saat membalas donasi/chat — audio tetap satu pipeline.
    function speak(text) {
      try {
        if (window.__agent && window.__agent.expressReply) window.__agent.expressReply(text);
      } catch (e) {}
      try {
        if (window.__debugSpeak) window.__debugSpeak(text);
        else if (window.__addChat) window.__addChat("agent", text);
      } catch (e) {}
    }

    async function poll() {
      if (stopped) return;
      try {
        const r = await fetch(apiBase() + "/api/vtuber/events?since=" + cursor);
        const d = await r.json();
        cursor = d.cursor || cursor;
        const nowOverlay = !!d.overlay;
        if (nowOverlay && !overlayOn)
          line({ type: "system", user: "system", text: __t("vt.overlayYield") });
        overlayOn = nowOverlay;
        for (const ev of d.events || []) {
          line(ev);
          if (ev.type === "donation") alert(ev);
          // Balasan behavior server — app utama bicara saat overlay tidak
          // on-air; overlay memutar sendiri versinya di jendelanya.
          if (ev.type === "agent" && !overlayOn) speak(ev.text);
        }
      } catch (e) { /* server restart dsb — coba lagi */ }
    }

    // wiring tombol start/stop
    const vtStartBtn = $("#vt-start");
    const vtStopBtn = $("#vt-stop");
    const setStatus = (text, color) => {
      status.textContent = text;
      status.style.color = color || "";
    };
    const reflectRunning = (r) => {
      // State tombol = state stream: tidak ada dua aksi aktif sekaligus.
      vtStartBtn.disabled = r;
      vtStopBtn.disabled = !r;
    };
    reflectRunning(false);
    const onStart = async () => {
      const provider = ($("#vt-provider") || {}).value || "mock";
      const body = { provider };
      if (provider === "twitch") body.channel = ($("#vt-channel") || {}).value || "";
      if (provider === "youtube") {
        body.videoId = ($("#vt-video-id") || {}).value || "";
        body.apiKey = ($("#vt-yt-key") || {}).value || "";
      }
      // Behavior engine (§7): config dikirim sekali di start; perubahan form
      // selama runtime jalan lewat onConfigChange (POST /api/vtuber/config).
      body.persona = ($("#vt-persona") || {}).value || "";
      body.cooldownMs = Math.max(5, Number(($("#vt-cooldown") || {}).value) || 12) * 1000;
      body.respondChat = !!($("#vt-respond") || {}).checked;
      body.respondDonation = !!($("#vt-donate-respond") || {}).checked;
      vtStartBtn.disabled = true; // cegah dobel-klik selama request
      try {
        await post("/api/vtuber/start", body);
        running = true;
        setStatus(__t("vt.statusActive", { provider }), "var(--mint)");
        reflectRunning(true);
        cursor = 0;
        feed.textContent = "";
      } catch (e) {
        setStatus(__t("sys.errGeneric", { msg: e.message }), "var(--coral)");
        reflectRunning(false);
      }
    };
    const onStop = async () => {
      running = false;
      vtStopBtn.disabled = true;
      try { await post("/api/vtuber/stop"); } catch (e) {}
      setStatus(__t("vt.inactive"));
      reflectRunning(false);
    };
    // Perubahan form saat runtime JALAN diteruskan tanpa restart stream.
    const onConfigChange = () => {
      if (!running || stopped) return;
      post("/api/vtuber/config", {
        persona: ($("#vt-persona") || {}).value || "",
        cooldownMs: Math.max(5, Number(($("#vt-cooldown") || {}).value) || 12) * 1000,
        respondChat: !!($("#vt-respond") || {}).checked,
        respondDonation: !!($("#vt-donate-respond") || {}).checked,
      }).catch(() => {});
    };
    // Operator (§7): instruksi eksplisit streamer → antrean operator server.
    // Gagal TIDAK boleh senyap — tanpa umpan balik tombol terasa mati
    // (runtime belum Start adalah kasus paling umum).
    const onOperatorSend = async () => {
      const input = $("#vt-operator");
      if (!input) return;
      const text = (input.value || "").trim();
      if (!text) return;
      const status = $("#vt-op-status");
      const say = (key) => { if (status) status.textContent = __t(key); };
      try {
        await post("/api/vtuber/operator", { text });
        input.value = "";
        say("vt.operatorSent");
      } catch (e) {
        say("vt.operatorNotRunning");
      }
      if (status) {
        clearTimeout(onOperatorSend._t);
        onOperatorSend._t = setTimeout(() => { status.textContent = ""; }, 4000);
      }
    };
    const onOperatorKey = (e) => { if (e.key === "Enter") onOperatorSend(); };
    const onProviderChange = () => {
      const v = ($("#vt-provider") || {}).value;
      $("#vt-row-channel").classList.toggle("hidden", v !== "twitch");
      $("#vt-row-ytid").classList.toggle("hidden", v !== "youtube");
      $("#vt-row-ytkey").classList.toggle("hidden", v !== "youtube");
    };
    $("#vt-start").addEventListener("click", onStart);
    $("#vt-stop").addEventListener("click", onStop);
    $("#vt-provider").addEventListener("change", onProviderChange);
    for (const id of ["#vt-persona", "#vt-cooldown", "#vt-respond", "#vt-donate-respond"]) {
      const elx = $(id);
      if (elx) elx.addEventListener("change", onConfigChange);
    }
    const operatorBtn = $("#vt-operator-send");
    if (operatorBtn) operatorBtn.addEventListener("click", onOperatorSend);
    const operatorInput = $("#vt-operator");
    if (operatorInput) operatorInput.addEventListener("keydown", onOperatorKey);
    onProviderChange();
    // Prefill dari koneksi stream tersimpan (server: config.vtuber) supaya
    // API key YouTube / channel Twitch / persona tidak diketik ulang tiap
    // sesi. apiKey datang TERMASK — biarkan di field (placeholder bukti key
    // ada); saat Start, key masked tidak menimpa yang tersimpan (server
    // saveVtuberConn menolaknya). Video ID sengaja diprefill juga; kalau
    // ganti tiap stream user tinggal menimpanya.
    (async () => {
      try {
        const saved = await fetch(apiBase() + "/api/vtuber/conn").then((r) => r.json());
        if (!saved || stopped) return;
        const setVal = (id, v) => { const e = $(id); if (e && v != null && v !== "") e.value = v; };
        if (saved.provider) { const p = $("#vt-provider"); if (p) p.value = saved.provider; }
        setVal("#vt-channel", saved.channel);
        setVal("#vt-video-id", saved.videoId);
        if (saved.apiKey) { const k = $("#vt-yt-key"); if (k) { k.value = ""; k.placeholder = saved.apiKey; } }
        setVal("#vt-persona", saved.persona);
        if (Number.isFinite(saved.cooldownMs)) setVal("#vt-cooldown", Math.round(saved.cooldownMs / 1000));
        if (typeof saved.respondChat === "boolean") { const c = $("#vt-respond"); if (c) c.checked = saved.respondChat; }
        if (typeof saved.respondDonation === "boolean") { const c = $("#vt-donate-respond"); if (c) c.checked = saved.respondDonation; }
        onProviderChange();
      } catch (e) { /* server lewat — form default */ }
    })();
    // Overlay OBS: halaman transparan untuk Browser Source. Dibuka dengan
    // ?hud=1 (panel preferensi tampil); URL untuk OBS = tanpa ?hud=1.
    const onOverlayOpen = () => window.open(apiBase() + "/vtuber.html?hud=1", "_blank");
    $("#vt-overlay-open").addEventListener("click", onOverlayOpen);
    pollTimer = setInterval(poll, 2500);

    return function destroy() {
      stopped = true;
      $("#vt-start").removeEventListener("click", onStart);
      $("#vt-stop").removeEventListener("click", onStop);
      $("#vt-provider").removeEventListener("change", onProviderChange);
      for (const id of ["#vt-persona", "#vt-cooldown", "#vt-respond", "#vt-donate-respond"]) {
        const elx = $(id);
        if (elx) elx.removeEventListener("change", onConfigChange);
      }
      if (operatorBtn) operatorBtn.removeEventListener("click", onOperatorSend);
      if (operatorInput) operatorInput.removeEventListener("keydown", onOperatorKey);
      $("#vt-overlay-open").removeEventListener("click", onOverlayOpen);
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      post("/api/vtuber/stop").catch(() => {});
      feed.textContent = "";
      reflectRunning(false);
    };
  }

  // ═════════════════════════════════════════════════════════════
  // ASSISTANT — panel agent (remake ala ZCode)
  // Seluruh logic panel (streaming SSE, transcript, kartu tool/approval,
  // plan, memory, direktur akting) sudah port ke TS:
  //   src/client/agent/panel/ → window.__agentPanel (bundle.js)
  // File ini hanya bridge mode: pasang/lepas UI, tanpa logika.
  // Panel ini hanya LAYAR: runtime assistant di server adalah layanan
  // mandiri (tetap hidup saat pindah panel / CLI agent memakainya juga).
  // ═════════════════════════════════════════════════════════════
  function startAssistantClient() {
    if (window.__agentPanel && typeof window.__agentPanel.start === "function") {
      try {
        return window.__agentPanel.start();
      } catch (e) {
        console.warn("[assistant] panel gagal nyala:", e);
        return function () {};
      }
    }
    // bundle belum terpasang (build lama / gagal) — degrade gracefully,
    // jangan crash (pola sama dengan brain di app.js).
    console.warn("[assistant] window.__agentPanel tidak ada — jalankan `bun run build`");
    return function () {};
  }

  // ═════════════════════════════════════════════════════════════
  // PET — jendela overlay terpisah
  // ═════════════════════════════════════════════════════════════
  function startPetClient() {
    const status = $("#pet-status");
    let throughOn = false;
    async function checkStatus() {
      try {
        const st = await modeGet();
        if (!st.pet?.running) {
          status.textContent = __t("pet.notOpen");
          throughOn = false;
        } else if (st.pet.shell) {
          status.textContent =
            (st.pet.shell === "tauri"
              ? __t("pet.shellTauri")
              : __t("pet.shellBrowser")) +
            (st.pet.clickThrough ? __t("pet.clickThroughOn") : "") +
            (st.pet.shell === "tauri" ? "" : __t("pet.noClickThrough"));
        } else {
          status.textContent = __t("pet.windowOpen");
        }
        paintThrough();
      } catch (e) { status.textContent = ""; }
    }
    function paintThrough() {
      const b = $("#pet-through");
      if (b) {
        b.textContent = throughOn ? __t("pet.clickThroughOnBtn") : __t("pet.clickThrough");
        b.classList.toggle("active", throughOn);
      }
    }
    const onLaunch = async () => {
      status.textContent = __t("pet.opening");
      try {
        const d = await post("/api/pet/launch");
        status.textContent = d.how ? __t("pet.openedHow", { how: d.how }) : __t("pet.opened");
        checkStatus();
      } catch (e) {
        status.textContent = __t("sys.errGeneric", { msg: e.message });
      }
    };
    const onClose = async () => {
      try { await post("/api/pet/close"); } catch (e) {}
      throughOn = false;
      paintThrough();
      status.textContent = __t("pet.closed");
    };
    // Klik-tembus hanya ada di shell Tauri; server mengabaikan bila shell
    // browser. Saat menyala, satu-satunya cara mematikan adalah dari sini —
    // klik pada jendela pet menembus ke desktop.
    const onThrough = async () => {
      throughOn = !throughOn;
      paintThrough();
      try {
        const d = await post("/api/pet/clickthrough", { on: throughOn });
        throughOn = !!d.clickThrough;
        paintThrough();
      } catch (e) {
        throughOn = false;
        paintThrough();
      }
    };
    $("#pet-launch").addEventListener("click", onLaunch);
    $("#pet-close").addEventListener("click", onClose);
    $("#pet-through").addEventListener("click", onThrough);
    checkStatus();
    const iv = setInterval(checkStatus, 5000);
    // Auto-buka saat panel pet dipilih — TAPI hanya kalau jendela belum
    // jalan; onLaunch mematikan-menyalakan, jadi re-enter panel tidak
    // me-restart jendela yang sudah ada.
    (async () => {
      try {
        const st = await modeGet();
        if (st.pet?.running) { checkStatus(); return; }
      } catch (e) {}
      onLaunch();
    })();

    return function destroy() {
      // Panel ditutup ≠ jendela pet ditutup: pet adalah layanan mandiri
      // (kontrak baru sejak shell Tauri). Yang dilepas hanya UI panel.
      $("#pet-launch").removeEventListener("click", onLaunch);
      $("#pet-close").removeEventListener("click", onClose);
      $("#pet-through").removeEventListener("click", onThrough);
      clearInterval(iv);
    };
  }

  // ── Boot ─────────────────────────────────────────────────────
  $$("#mode-switch button").forEach((b) => b.addEventListener("click", () => switchMode(b.dataset.mode)));
  modeGet().then((st) => {
    // mode tersimpan di server hanya berlaku sesi runtime; UI selalu mulai chat
    setPanel("chat");
  }).catch(() => setPanel("chat"));

  // ekspor untuk debug
  window.__modeRuntime = { switchMode, get active() { return active; } };
})();
