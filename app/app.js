/* ============================================================
   LUMAVE — Kamera-Webapp
   Flow:  QR öffnen → Name eingeben → Kamera → Entwicklung (48h)
   Photos live in IndexedDB (Blobs), guest info in localStorage.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- Config ---------- */
  const MAX_SHOTS = 24;
  const params = new URLSearchParams(location.search);
  // Entwicklungszeit, bis Fotos sichtbar werden.
  // Aktueller Test-Stand: 20 Sekunden. Für die echten 48 Stunden: ?real=1 an die URL.
  const REAL_DEVELOP_MS = 48 * 60 * 60 * 1000;
  const TEST_DEVELOP_MS = 20 * 1000;
  const DEVELOP_MS = params.has("real") ? REAL_DEVELOP_MS : TEST_DEVELOP_MS;
  const CAPTURE_W = 1080;
  const CAPTURE_H = 1350; // 4:5 film frame
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Tiny DOM helpers ---------- */
  const $ = (id) => document.getElementById(id);
  const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);

  /* ---------- Elements ---------- */
  const app = $("app");
  const views = {
    join: $("viewJoin"),
    camera: $("viewCamera"),
    gallery: $("viewGallery"),
  };

  /* ============================================================
     STATE
     ============================================================ */
  const state = {
    guest: null,          // { name, joinedAt }
    stream: null,
    track: null,
    facing: "environment",
    flashMode: "auto",    // off | auto | on
    torchOn: false,
    busy: false,
    photos: [],           // [{ id, blob, takenAt, readyAt, url }]
    started: false,
  };

  /* ============================================================
     PERSISTENCE — localStorage (guest) + IndexedDB (photos)
     ============================================================ */
  const GUEST_KEY = "lumave_guest";

  function loadGuest() {
    try { return JSON.parse(localStorage.getItem(GUEST_KEY) || "null"); }
    catch (e) { return null; }
  }
  function saveGuest(g) {
    try { localStorage.setItem(GUEST_KEY, JSON.stringify(g)); } catch (e) {}
  }

  const DB_NAME = "lumave-cam";
  const STORE = "photos";
  let dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((res, rej) => {
      if (!("indexedDB" in window)) return rej(new Error("no-idb"));
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbPromise;
  }
  async function idbPut(rec) {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }
  async function idbAll() {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction(STORE, "readonly");
      const rq = tx.objectStore(STORE).getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });
  }

  // In-memory fallback if IndexedDB is unavailable (private mode, etc.)
  const memStore = [];
  async function persistPhoto(rec) {
    try { await idbPut({ id: rec.id, blob: rec.blob, takenAt: rec.takenAt, readyAt: rec.readyAt }); }
    catch (e) { memStore.push(rec); }
  }
  async function loadPhotos() {
    try {
      const rows = await idbAll();
      const src = rows.length || !memStore.length ? rows : memStore;
      return src
        .map((r) => ({ ...r, url: URL.createObjectURL(r.blob) }))
        .sort((a, b) => a.takenAt - b.takenAt);
    } catch (e) {
      return memStore
        .map((r) => ({ ...r, url: r.url || URL.createObjectURL(r.blob) }))
        .sort((a, b) => a.takenAt - b.takenAt);
    }
  }

  /* ============================================================
     ICONS (inline SVG — no emoji)
     ============================================================ */
  const ICONS = {
    flashAuto:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2 4 13h5l-1 7 6-9h-4z"/><text x="17.5" y="9" font-size="8" font-family="Host Grotesk, sans-serif" font-weight="700" fill="currentColor" stroke="none">A</text></svg>',
    flashOn:
      '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
    flashOff:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2 4 13h5l-1 7 6-9"/><path d="M3 3l18 18"/></svg>',
    lock:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
    warn:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20z"/><path d="M12 9v5M12 17h.01"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    hourglass:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12M6 21h12M7 3c0 5 4 5 5 9 1-4 5-4 5-9M7 21c0-5 4-5 5-9 1 4 5 4 5 9"/></svg>',
  };

  /* ============================================================
     VIEW ROUTER
     ============================================================ */
  function show(name) {
    Object.entries(views).forEach(([k, el]) =>
      el.classList.toggle("is-active", k === name)
    );
    if (name === "camera") ensureCamera();
    if (name === "gallery") renderGallery();
    // Pause camera stream when leaving the finder to save battery
    if (name !== "camera") setTorch(false);
  }

  /* ============================================================
     TOAST
     ============================================================ */
  let toastTimer;
  function toast(msg, accent) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("toast--accent", !!accent);
    t.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("is-visible"), 2600);
  }

  function haptic(ms) {
    if (!prefersReduced && navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} }
  }

  // Human-readable develop time, keeps the gallery note in sync with DEVELOP_MS.
  function formatDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s >= 3600) { const h = Math.round(s / 3600); return h + " Stunde" + (h === 1 ? "" : "n"); }
    if (s >= 60)   { const m = Math.round(s / 60);   return m + " Minute" + (m === 1 ? "" : "n"); }
    return s + " Sekunde" + (s === 1 ? "" : "n");
  }

  /* ============================================================
     JOIN
     ============================================================ */
  function initJoin() {
    // Personalise couple name from the QR link, e.g. ?couple=Julia%20%26%20Max
    const couple = params.get("couple") || params.get("paar");
    if (couple) $("coupleName").textContent = couple;

    const form = $("joinForm");
    const input = $("nameInput");
    const err = $("nameError");

    const existing = loadGuest();
    if (existing && existing.name) {
      input.value = existing.name;
    }

    on(input, "input", () => {
      err.classList.remove("is-visible");
      input.setAttribute("aria-invalid", "false");
    });

    on(form, "submit", (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (name.length < 2) {
        err.textContent = "Bitte gib deinen Namen ein, damit wir deine Bilder zuordnen können.";
        err.classList.add("is-visible");
        input.setAttribute("aria-invalid", "true");
        input.focus();
        return;
      }
      state.guest = existing && existing.joinedAt
        ? { ...existing, name }
        : { name, joinedAt: Date.now() };
      saveGuest(state.guest);
      input.blur();
      haptic(12);
      show("camera");
    });
  }

  /* ============================================================
     CAMERA
     ============================================================ */
  const video = $("camVideo");
  const finder = $("viewfinder");

  function setStatus(mode, opts) {
    opts = opts || {};
    const box = $("camStatus");
    const spin = $("camSpinner");
    const icon = $("camStatusIcon");
    const title = $("camStatusTitle");
    const text = $("camStatusText");
    const retry = $("camRetry");

    if (mode === "hidden") { box.classList.remove("is-visible"); return; }
    box.classList.add("is-visible");
    const loading = mode === "loading";
    spin.hidden = !loading;
    icon.hidden = loading;
    retry.hidden = !opts.retry;
    if (!loading && opts.icon) icon.innerHTML = ICONS[opts.icon] || "";
    title.textContent = opts.title || "";
    text.textContent = opts.text || "";
    if (opts.retryLabel) retry.querySelector(".btn__label").textContent = opts.retryLabel;
  }

  async function startStream(facing) {
    stopStream();
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.stream = stream;
    state.track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    video.classList.toggle("is-mirrored", facing === "user");
    finder.classList.remove("is-fallback");
    await video.play().catch(() => {});
  }

  function stopStream() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
    }
    state.stream = null;
    state.track = null;
    state.torchOn = false;
  }

  async function ensureCamera() {
    if (state.stream) return; // already live
    const supported =
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    if (!supported) return enterFallback("unsupported");

    setStatus("loading", { title: "Kamera wird gestartet…", text: "Einen Moment – wir aktivieren deinen Sucher." });
    try {
      await startStream(state.facing);
      setStatus("hidden");
    } catch (err) {
      handleCamError(err);
    }
  }

  function handleCamError(err) {
    const name = err && err.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      // Could be denied permission OR an insecure context (file://, http).
      if (!window.isSecureContext) return enterFallback("insecure");
      setStatus("error", {
        icon: "lock",
        title: "Kamerazugriff nötig",
        text: "Erlaube den Kamerazugriff in deinem Browser, um Fotos aufzunehmen.",
        retry: true,
        retryLabel: "Kamera erlauben",
      });
    } else if (name === "NotFoundError" || name === "OverconstrainedError") {
      enterFallback("nocam");
    } else if (!window.isSecureContext) {
      enterFallback("insecure");
    } else {
      setStatus("error", {
        icon: "warn",
        title: "Kamera nicht verfügbar",
        text: "Da ist etwas schiefgelaufen. Versuch es noch einmal.",
        retry: true,
        retryLabel: "Erneut versuchen",
      });
    }
  }

  // Fallback: no live camera (insecure context / no device). We still let the
  // whole flow work by generating filmic frames, so the concept is testable
  // e.g. when opened from file:// during design review.
  let fallbackReason = null;
  function enterFallback(reason) {
    fallbackReason = reason;
    finder.classList.add("is-fallback");
    drawFallbackPreview();
    setStatus("hidden");
    const msg =
      reason === "insecure"
        ? "Kamera braucht HTTPS – Vorschaumodus aktiv."
        : reason === "nocam"
        ? "Keine Kamera gefunden – Vorschaumodus aktiv."
        : "Vorschaumodus aktiv.";
    toast(msg);
  }

  /* ---------- Flash ---------- */
  function renderFlash() {
    const ico = $("flashIco");
    const label = $("flashLabel");
    const btn = $("flashBtn");
    const map = {
      auto: { icon: "flashAuto", text: "Auto", pressed: "false" },
      on:   { icon: "flashOn",   text: "An",   pressed: "true"  },
      off:  { icon: "flashOff",  text: "Aus",  pressed: "false" },
    };
    const m = map[state.flashMode];
    ico.innerHTML = ICONS[m.icon];
    label.textContent = m.text;
    btn.setAttribute("aria-label", "Blitz: " + m.text);
    btn.setAttribute("aria-pressed", m.pressed);
    btn.classList.toggle("is-active", state.flashMode === "on");
  }

  function cycleFlash() {
    const order = ["auto", "on", "off"];
    state.flashMode = order[(order.indexOf(state.flashMode) + 1) % order.length];
    renderFlash();
    haptic(8);
  }

  async function setTorch(onFlag) {
    if (!state.track || !state.track.getCapabilities) return false;
    try {
      const caps = state.track.getCapabilities();
      if (!caps.torch) return false;
      await state.track.applyConstraints({ advanced: [{ torch: !!onFlag }] });
      state.torchOn = !!onFlag;
      return true;
    } catch (e) { return false; }
  }

  /* ---------- Capture ---------- */
  function coverCrop(sw, sh, tw, th) {
    // returns sx, sy, sWidth, sHeight to draw source (sw×sh) into target (tw×th) as "cover"
    const sr = sw / sh;
    const tr = tw / th;
    let sWidth, sHeight;
    if (sr > tr) { sHeight = sh; sWidth = sh * tr; }
    else { sWidth = sw; sHeight = sw / tr; }
    const sx = (sw - sWidth) / 2;
    const sy = (sh - sHeight) / 2;
    return [sx, sy, sWidth, sHeight];
  }

  // Warm filmic gradient frame for the fallback preview / capture.
  const PALETTES = [
    ["#ffe6b0", "#d98b4a", "#3d211a"],
    ["#ffd9c4", "#b06a52", "#4b2a2c"],
    ["#ffe9df", "#cf9a92", "#6d4646"],
    ["#f4c98f", "#5f4360", "#2a2233"],
    ["#ffcf87", "#7a4a26", "#1c110c"],
    ["#f3ead0", "#8a8560", "#3e3a2b"],
  ];
  function paintFilmic(ctx, w, h, pal) {
    const g = ctx.createLinearGradient(0, 0, w * 0.4, h);
    g.addColorStop(0, pal[0]);
    g.addColorStop(0.5, pal[1]);
    g.addColorStop(1, pal[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // soft highlight
    const rg = ctx.createRadialGradient(w * 0.72, h * 0.16, 0, w * 0.72, h * 0.16, w * 0.9);
    rg.addColorStop(0, "rgba(255,235,190,0.5)");
    rg.addColorStop(0.5, "rgba(255,235,190,0)");
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
    // vignette
    const vg = ctx.createRadialGradient(w / 2, h * 0.45, h * 0.3, w / 2, h * 0.45, h * 0.8);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(8,5,3,0.6)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
    // grain
    ctx.globalAlpha = 0.05;
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = Math.random() > 0.5 ? "#fff" : "#000";
      ctx.fillRect(Math.random() * w, Math.random() * h, 1.4, 1.4);
    }
    ctx.globalAlpha = 1;
  }

  let fallbackPal = PALETTES[Math.floor(Math.random() * PALETTES.length)];
  function drawFallbackPreview() {
    const cv = $("fallbackCanvas");
    const ctx = cv.getContext("2d");
    paintFilmic(ctx, cv.width, cv.height, fallbackPal);
  }

  function captureCanvas() {
    const cv = document.createElement("canvas");
    cv.width = CAPTURE_W;
    cv.height = CAPTURE_H;
    const ctx = cv.getContext("2d");

    if (state.stream && video.videoWidth) {
      const [sx, sy, sw, sh] = coverCrop(video.videoWidth, video.videoHeight, CAPTURE_W, CAPTURE_H);
      if (state.facing === "user") {
        ctx.translate(CAPTURE_W, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, CAPTURE_W, CAPTURE_H);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // gentle warm grade so captures share the Lumave signature
      ctx.globalCompositeOperation = "overlay";
      ctx.fillStyle = "rgba(210,150,80,0.10)";
      ctx.fillRect(0, 0, CAPTURE_W, CAPTURE_H);
      ctx.globalCompositeOperation = "source-over";
    } else {
      // fallback filmic frame — new palette each shot for variety
      fallbackPal = PALETTES[Math.floor(Math.random() * PALETTES.length)];
      paintFilmic(ctx, CAPTURE_W, CAPTURE_H, fallbackPal);
      drawFallbackPreview();
    }
    return cv;
  }

  function canvasToBlob(cv) {
    return new Promise((res) => {
      if (cv.toBlob) cv.toBlob((b) => res(b), "image/jpeg", 0.72);
      else {
        const data = cv.toDataURL("image/jpeg", 0.72);
        const bin = atob(data.split(",")[1]);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        res(new Blob([arr], { type: "image/jpeg" }));
      }
    });
  }

  async function capture() {
    if (state.busy) return;
    const remaining = MAX_SHOTS - state.photos.length;
    if (remaining <= 0) {
      $("app").classList.add("shake");
      setTimeout(() => $("app").classList.remove("shake"), 450);
      toast("Dein Film ist voll – 24 Aufnahmen aufgebraucht.");
      haptic([20, 40, 20]);
      return;
    }

    state.busy = true;
    const shutter = $("shutterBtn");
    shutter.disabled = true;

    // Flash: fire torch + white flash when on (or auto in the fallback we skip torch)
    const fireFlash = state.flashMode === "on" || state.flashMode === "auto";
    let torchUsed = false;
    if (state.flashMode === "on") torchUsed = await setTorch(true);

    // Mechanical shutter blink always; white flash only when flash fires.
    const blink = $("shutterBlink");
    blink.classList.remove("is-firing"); void blink.offsetWidth; blink.classList.add("is-firing");
    if (fireFlash) {
      const fo = $("flashOverlay");
      fo.classList.remove("is-firing"); void fo.offsetWidth; fo.classList.add("is-firing");
    }
    haptic(18);

    try {
      const cv = captureCanvas();
      const blob = await canvasToBlob(cv);
      const now = Date.now();
      const rec = { id: "p" + now + "-" + Math.random().toString(36).slice(2, 7), blob, takenAt: now, readyAt: now + DEVELOP_MS };
      await persistPhoto(rec);
      rec.url = URL.createObjectURL(blob);
      state.photos.push(rec);
      updateCounter();
      updateGalleryButton();

      const left = MAX_SHOTS - state.photos.length;
      if (left === 0) toast("Letzte Aufnahme! Dein Film ist voll.", true);
      else toast("Festgehalten · " + left + " übrig", true);
    } catch (e) {
      toast("Aufnahme fehlgeschlagen – versuch es nochmal.");
    } finally {
      if (torchUsed) await setTorch(false);
      shutter.disabled = false;
      state.busy = false;
    }
  }

  /* ---------- Counter + gallery button ---------- */
  function updateCounter() {
    const left = MAX_SHOTS - state.photos.length;
    const num = $("counterNum");
    num.textContent = String(left);
    num.classList.toggle("is-low", left <= 5);
  }

  function updateGalleryButton() {
    const count = state.photos.length;
    const badge = $("galleryBadge");
    const thumb = $("galleryThumb");
    const img = $("galleryThumbImg");
    badge.textContent = String(count);
    badge.classList.toggle("is-hidden", count === 0);
    if (count > 0) {
      const last = state.photos[state.photos.length - 1];
      img.src = last.url;
      img.hidden = false;
      thumb.classList.remove("is-empty");
    } else {
      img.hidden = true;
      thumb.classList.add("is-empty");
    }
  }

  /* ============================================================
     GALLERY / DEVELOPMENT
     ============================================================ */
  function fmtCountdown(ms) {
    if (ms <= 0) return "00:00:00";
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    return p(h) + ":" + p(m) + ":" + p(sec);
  }

  function renderGallery() {
    const grid = $("developGrid");
    const empty = $("galleryEmpty");
    const scroll = $("developScroll");
    const countLabel = $("galleryCountLabel");
    const n = state.photos.length;

    countLabel.textContent = n === 1 ? "1 Aufnahme" : n + " Aufnahmen";

    if (n === 0) {
      empty.classList.add("is-visible");
      scroll.style.display = "none";
      return;
    }
    empty.classList.remove("is-visible");
    scroll.style.display = "";

    grid.innerHTML = "";
    state.photos.forEach((p, i) => {
      const cell = document.createElement("div");
      cell.className = "dev-cell";
      cell.dataset.id = p.id;
      cell.dataset.ready = String(p.readyAt);
      cell.style.animationDelay = Math.min(i * 0.05, 0.4) + "s";
      cell.innerHTML =
        '<img src="' + p.url + '" alt="Aufnahme ' + (i + 1) + ' – wird entwickelt" />' +
        '<div class="dev-cell__overlay">' +
          '<span class="dev-cell__ico">' + ICONS.hourglass + "</span>" +
          '<span class="dev-cell__time">--:--:--</span>' +
          '<span class="dev-cell__state">In Entwicklung</span>' +
        "</div>" +
        '<span class="dev-cell__ready">' + ICONS.check + "</span>" +
        '<span class="dev-cell__meta">' + String(i + 1).padStart(2, "0") + "</span>" +
        '<div class="dev-cell__bar"><i></i></div>';
      on(cell, "click", () => {
        if (cell.classList.contains("is-ready")) openLightbox(p.url);
      });
      grid.appendChild(cell);
    });

    tick(); // paint immediately
  }

  function tick() {
    const now = Date.now();
    document.querySelectorAll(".dev-cell").forEach((cell) => {
      const readyAt = Number(cell.dataset.ready);
      const rec = state.photos.find((p) => p.id === cell.dataset.id);
      const remaining = readyAt - now;
      if (remaining <= 0) {
        if (!cell.classList.contains("is-ready")) {
          cell.classList.add("is-ready");
          const st = cell.querySelector(".dev-cell__state");
          if (st) st.textContent = "Entwickelt";
          // Clear the inline blur so the CSS reveal (.is-ready img) can take over.
          const rImg = cell.querySelector("img");
          if (rImg) rImg.style.filter = "";
        }
        return;
      }
      const timeEl = cell.querySelector(".dev-cell__time");
      if (timeEl) timeEl.textContent = fmtCountdown(remaining);
      // progress + progressive (never-recognizable) de-blur
      const total = rec ? rec.readyAt - rec.takenAt : DEVELOP_MS;
      const progress = Math.min(1, Math.max(0, 1 - remaining / total));
      const bar = cell.querySelector(".dev-cell__bar i");
      if (bar) bar.style.width = (progress * 100).toFixed(1) + "%";
      const img = cell.querySelector("img");
      if (img && !prefersReduced) {
        const blur = 26 - progress * 10; // 26px → 16px, stays abstract until reveal
        img.style.filter = "blur(" + blur.toFixed(1) + "px) saturate(0.8) brightness(0.85)";
      }
    });
  }

  // Global 1s clock drives both the gallery countdowns and reveals.
  setInterval(() => {
    if (views.gallery.classList.contains("is-active")) tick();
  }, 1000);

  /* ---------- Lightbox ---------- */
  function openLightbox(url) {
    const lb = $("lightbox");
    $("lightboxImg").src = url;
    lb.classList.add("is-open");
    haptic(8);
  }
  function closeLightbox() {
    $("lightbox").classList.remove("is-open");
  }

  /* ============================================================
     WIRE UP
     ============================================================ */
  function bind() {
    on($("flashBtn"), "click", cycleFlash);
    on($("shutterBtn"), "click", capture);
    on($("flipBtn"), "click", async () => {
      if (fallbackReason) { toast("Im Vorschaumodus nicht verfügbar."); return; }
      state.facing = state.facing === "environment" ? "user" : "environment";
      try {
        setStatus("loading", { title: "Wird gewechselt…", text: "" });
        await startStream(state.facing);
        setStatus("hidden");
      } catch (e) { handleCamError(e); }
    });
    on($("galleryBtn"), "click", () => show("gallery"));
    on($("galleryBack"), "click", () => show("camera"));
    on($("galleryToCam"), "click", () => show("camera"));
    on($("emptyToCam"), "click", () => show("camera"));
    on($("camRetry"), "click", () => { state.stream = null; ensureCamera(); });

    on($("lightboxClose"), "click", closeLightbox);
    on($("lightbox"), "click", (e) => { if (e.target === $("lightbox")) closeLightbox(); });
    on(document, "keydown", (e) => { if (e.key === "Escape") closeLightbox(); });

    // Space / Enter triggers shutter when camera is active (desktop testing)
    on(document, "keydown", (e) => {
      if ((e.key === " " || e.key === "Enter") && views.camera.classList.contains("is-active") && document.activeElement === document.body) {
        e.preventDefault();
        capture();
      }
    });

    // Reclaim camera when tab becomes visible again
    on(document, "visibilitychange", () => {
      if (document.hidden) { stopStream(); }
      else if (views.camera.classList.contains("is-active")) { state.stream = null; ensureCamera(); }
    });
  }

  /* ============================================================
     INIT
     ============================================================ */
  async function init() {
    renderFlash();
    initJoin();
    bind();

    // Keep the "develops after X" note truthful for whatever timer is active.
    const durEl = $("developDurationText");
    if (durEl) durEl.textContent = formatDuration(DEVELOP_MS);

    state.photos = await loadPhotos();
    updateCounter();
    updateGalleryButton();

    // Returning guest with an unfinished film? Drop them straight to the camera.
    const g = loadGuest();
    if (g && g.name) {
      state.guest = g;
      // Keep them on the join screen (pre-filled) so they confirm — feels
      // intentional. Change to `show("camera")` to skip. We stay on join.
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
