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
  // Standard: 48 Stunden. Für einen schnellen Reveal-Test: ?demo=1 → 20 Sekunden.
  const REAL_DEVELOP_MS = 48 * 60 * 60 * 1000;
  const TEST_DEVELOP_MS = 20 * 1000;
  const DEVELOP_MS = params.has("demo") ? TEST_DEVELOP_MS : REAL_DEVELOP_MS;

  /* ---------- Foto-Upload zu Google Drive (Apps Script Web App) ----------
     Jedes Foto wird zusätzlich zur lokalen Speicherung in einen Drive-Ordner
     hochgeladen – pro Gast ein eigener Unterordner. Der Upload läuft über eine
     Google-Apps-Script-Web-App (siehe google-apps-script/Code.gs), die unter dem
     Konto des Ordner-Eigentümers schreibt (keine Zugangsdaten im Client).
     >>> Nach dem Deploy hier die Web-App-URL (…/exec) eintragen. Leer = Upload aus. */
  const UPLOAD_ENDPOINT = "https://script.google.com/macros/s/AKfycbwQ7P7hgEfF5om07Fgjh-aKPVfFaunB_bazbJssZJ8t2mZbBmwe71uKv1z12v4In0Y/exec";
  const UPLOAD_SECRET = "lumave-2026"; // muss mit SECRET im Apps Script übereinstimmen
  const uploadEnabled = () => /^https:\/\//.test(UPLOAD_ENDPOINT);

  /* ---------- Filterpreset (.cube-LUT) ----------
     Das Lumave-Look-Preset wird clientseitig auf jede Aufnahme angewendet
     (Apps Script kann keine Pixel bearbeiten). Pro Foto gehen zwei Dateien
     nach Drive: Original in den Gast-Ordner, die entwickelte Version in den
     Unterordner "Edited". */
  const LUT_URL = "lumave-look.cube?v=1";
  const EDITED_SUBFOLDER = "Edited";
  let LUT = null; // { n, data: Float32Array } — null = Preset nicht verfügbar
  const CAPTURE_W = 1638;
  const CAPTURE_H = 2048; // 4:5-Filmformat, lange Kante 2048 px
  const JPEG_QUALITY = 0.85;
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Tiny DOM helpers ---------- */
  const $ = (id) => document.getElementById(id);
  const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  function recToStore(rec) {
    return {
      id: rec.id, blob: rec.blob, takenAt: rec.takenAt, readyAt: rec.readyAt,
      uploaded: !!rec.uploaded, filename: rec.filename || null,
      guest: rec.guest || null, guestId: rec.guestId || null, seq: rec.seq || null,
      editedBlob: rec.editedBlob || null, uploadedEdited: !!rec.uploadedEdited,
    };
  }
  async function persistPhoto(rec) {
    try { await idbPut(recToStore(rec)); }
    catch (e) { if (memStore.indexOf(rec) === -1) memStore.push(rec); }
  }
  function withUrls(r) {
    return {
      ...r,
      url: r.url || URL.createObjectURL(r.blob),
      editedUrl: r.editedUrl || (r.editedBlob ? URL.createObjectURL(r.editedBlob) : null),
    };
  }
  // Galerie/Lightbox zeigen die entwickelte (LUT-)Version — identisch mit der
  // Datei im Drive-Ordner "Edited", nur direkt aus dem lokalen Speicher.
  function displayUrl(rec) { return rec.editedUrl || rec.url; }

  async function loadPhotos() {
    try {
      const rows = await idbAll();
      const src = rows.length || !memStore.length ? rows : memStore;
      return src.map(withUrls).sort((a, b) => a.takenAt - b.takenAt);
    } catch (e) {
      return memStore.map(withUrls).sort((a, b) => a.takenAt - b.takenAt);
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
    cloud:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.4A3.5 3.5 0 0 1 18 18z"/><path d="M12 15.5v-5M9.8 12.2 12 10l2.2 2.2"/></svg>',
  };

  /* ============================================================
     LUT — Lumave-Look (.cube) clientseitig anwenden
     ============================================================ */
  async function loadLUT() {
    try {
      const res = await fetch(LUT_URL);
      if (!res.ok) throw new Error("lut-fetch " + res.status);
      LUT = parseCube(await res.text());
    } catch (e) {
      LUT = null; // Preset fehlt → App läuft weiter, nur ohne Edited-Uploads
    }
  }

  function parseCube(text) {
    const lines = text.split(/\r?\n/);
    let n = 0, data = null, idx = 0;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li].trim();
      if (!line || line[0] === "#") continue;
      if (/^(TITLE|DOMAIN_MIN|DOMAIN_MAX)/i.test(line)) continue; // Standard-Domain 0..1
      const m = line.match(/^LUT_3D_SIZE\s+(\d+)/i);
      if (m) { n = +m[1]; data = new Float32Array(n * n * n * 3); continue; }
      if (/^LUT_1D_SIZE/i.test(line)) throw new Error("1D-LUT nicht unterstützt");
      if (!data) continue;
      const p = line.split(/\s+/);
      if (p.length < 3) continue;
      data[idx++] = +p[0]; data[idx++] = +p[1]; data[idx++] = +p[2];
    }
    if (!n || !data || idx < n * n * n * 3) throw new Error("lut-parse");
    return { n, data };
  }

  // Trilineare Interpolation, in-place auf ImageData. (Rot läuft im .cube am schnellsten.)
  function applyLutToImageData(im, lut) {
    const d = im.data, n = lut.n, t = lut.data, n2 = n * n, mx = n - 1, s = mx / 255;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] * s, g = d[i + 1] * s, b = d[i + 2] * s;
      const r0 = r | 0, g0 = g | 0, b0 = b | 0;
      const fr = r - r0, fg = g - g0, fb = b - b0;
      const r1 = r0 < mx ? r0 + 1 : mx, g1 = g0 < mx ? g0 + 1 : mx, b1 = b0 < mx ? b0 + 1 : mx;
      const g0n = g0 * n, g1n = g1 * n, b0n = b0 * n2, b1n = b1 * n2;
      const i000 = (r0 + g0n + b0n) * 3, i100 = (r1 + g0n + b0n) * 3;
      const i010 = (r0 + g1n + b0n) * 3, i110 = (r1 + g1n + b0n) * 3;
      const i001 = (r0 + g0n + b1n) * 3, i101 = (r1 + g0n + b1n) * 3;
      const i011 = (r0 + g1n + b1n) * 3, i111 = (r1 + g1n + b1n) * 3;
      for (let c = 0; c < 3; c++) {
        const c00 = t[i000 + c] + (t[i100 + c] - t[i000 + c]) * fr;
        const c10 = t[i010 + c] + (t[i110 + c] - t[i010 + c]) * fr;
        const c01 = t[i001 + c] + (t[i101 + c] - t[i001 + c]) * fr;
        const c11 = t[i011 + c] + (t[i111 + c] - t[i011 + c]) * fr;
        const c0 = c00 + (c10 - c00) * fg;
        const c1 = c01 + (c11 - c01) * fg;
        let v = (c0 + (c1 - c0) * fb) * 255;
        d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }

  function makeEditedBlob(srcCanvas) {
    if (!LUT) return Promise.resolve(null);
    const cv = document.createElement("canvas");
    cv.width = srcCanvas.width; cv.height = srcCanvas.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(srcCanvas, 0, 0);
    const im = ctx.getImageData(0, 0, cv.width, cv.height);
    applyLutToImageData(im, LUT);
    ctx.putImageData(im, 0, 0);
    return canvasToBlob(cv);
  }

  function blobToCanvas(blob) {
    return new Promise((res, rej) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        const cv = document.createElement("canvas");
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext("2d").drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        res(cv);
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("img-load")); };
      img.src = url;
    });
  }

  // Edited-Version nachträglich erzeugen (ältere Fotos ohne editedBlob, Retries).
  async function ensureEdited(rec) {
    if (rec.editedBlob || !LUT || !rec.blob) return;
    try {
      rec.editedBlob = await makeEditedBlob(await blobToCanvas(rec.blob));
      rec.editedUrl = URL.createObjectURL(rec.editedBlob);
      await persistPhoto(rec);
    } catch (e) { /* nächster Flush versucht es erneut */ }
  }

  /* ============================================================
     UPLOAD zu Google Drive (pro Gast ein Ordner)
     ============================================================ */
  const pad2 = (n) => String(n).padStart(2, "0");
  function stamp(ms) {
    const d = new Date(ms);
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      "-" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }
  function genId() { return Math.random().toString(36).slice(2, 8); }

  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(",")[1] || "");
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  function setUploadStatus(id, status) {
    const cell = document.querySelector('.dev-cell[data-id="' + id + '"] .dev-cell__up');
    if (cell) cell.dataset.status = status; // "pending" | "up" | "done"
  }

  // Vollständig synchronisiert = Original + (falls Preset aktiv) Edited hochgeladen.
  function syncDone(rec) {
    return !!rec.uploaded && (!LUT || !!rec.uploadedEdited);
  }

  // Eine Datei hochladen: kind = "original" | "edited".
  async function uploadOne(rec, kind) {
    const isEdited = kind === "edited";
    const blob = isEdited ? rec.editedBlob : rec.blob;
    if (!blob) return false;
    const base64 = await blobToBase64(blob);
    const payload = {
      secret: UPLOAD_SECRET,
      guest: rec.guest || (state.guest && state.guest.name) || "Gast",
      guestId: rec.guestId || (state.guest && state.guest.guestId) || "anon",
      filename: rec.filename,
      mimeType: "image/jpeg",
      takenAt: rec.takenAt,
      dataBase64: base64,
    };
    if (isEdited) payload.subfolder = EDITED_SUBFOLDER;
    // text/plain => "simple request", vermeidet CORS-Preflight bei Apps Script.
    const res = await fetch(UPLOAD_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    let j = null;
    try { j = await res.json(); } catch (e) { /* opaque */ }
    // Edited zählt nur, wenn das Script den Unterordner bestätigt (j.sub).
    // Ein altes Script ohne subfolder-Support meldet kein sub → Retry, bis
    // die neue Script-Version deployt ist (selbstheilend, idempotent).
    return !!(res.ok && j && j.ok && (!isEdited || j.sub === EDITED_SUBFOLDER));
  }

  async function uploadPhoto(rec) {
    if (!uploadEnabled() || rec._uploading || syncDone(rec)) return syncDone(rec);
    rec._uploading = true;
    setUploadStatus(rec.id, "up");
    try {
      if (!rec.filename) rec.filename = "Lumave_" + stamp(rec.takenAt || Date.now()) + "_" + rec.id + ".jpg";
      if (!rec.uploaded) {
        if (!(await uploadOne(rec, "original"))) throw new Error("orig-failed");
        rec.uploaded = true;
        await persistPhoto(rec);
      }
      if (LUT && !rec.uploadedEdited) {
        await ensureEdited(rec);
        if (!rec.editedBlob) throw new Error("edited-missing");
        if (!(await uploadOne(rec, "edited"))) throw new Error("edited-failed");
        rec.uploadedEdited = true;
        await persistPhoto(rec);
      }
      setUploadStatus(rec.id, "done");
      return true;
    } catch (e) {
      setUploadStatus(rec.id, "pending");
      return false;
    } finally {
      rec._uploading = false;
    }
  }

  // Retry-Schleife für unvollständige Uploads (Offline / Fehler / altes Script).
  let flushing = false;
  async function flushUploads() {
    if (!uploadEnabled() || flushing || !navigator.onLine) return;
    flushing = true;
    try {
      for (const rec of state.photos) {
        if (!syncDone(rec)) await uploadPhoto(rec);
      }
    } finally { flushing = false; }
  }

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
    const consent = $("consentCheck");
    const btn = $("joinBtn");

    const existing = loadGuest();
    if (existing && existing.name) input.value = existing.name;
    if (existing && existing.consentAt) consent.checked = true;

    const nameOk = () => input.value.trim().length >= 2;

    // Button bleibt ausgegraut, bis Name eingegeben UND Datenschutz/AGB bestätigt sind.
    function updateJoinButton() {
      btn.disabled = !(nameOk() && consent.checked);
    }

    on(input, "input", () => {
      err.classList.remove("is-visible");
      input.setAttribute("aria-invalid", "false");
      updateJoinButton();
    });
    on(consent, "change", () => {
      if (consent.checked) err.classList.remove("is-visible");
      updateJoinButton();
    });
    updateJoinButton();

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
      if (!consent.checked) {
        err.textContent = "Bitte stimme Datenschutz und AGB zu, um beizutreten.";
        err.classList.add("is-visible");
        return;
      }
      const gid = (existing && existing.guestId) || genId();
      state.guest = existing && existing.joinedAt
        ? { ...existing, name, guestId: gid, consentAt: existing.consentAt || Date.now() }
        : { name, joinedAt: Date.now(), guestId: gid, consentAt: Date.now() };
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
        // Maximal verfügbare Sensorauflösung anfordern (ideal = best effort,
        // der Browser wählt das Maximum der Kamera). Nötig, damit die
        // 2048er-Ausgabe echte Details trägt statt hochskaliertem 1080p.
        width: { ideal: 4096 },
        height: { ideal: 4096 },
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
    // grain (Dichte skaliert mit der Fläche, damit der Look bei jeder Größe stimmt)
    ctx.globalAlpha = 0.05;
    const specks = Math.round((w * h) / 1620);
    for (let i = 0; i < specks; i++) {
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
      // Original bleibt ungefiltert — der Lumave-Look entsteht über die
      // .cube-LUT in der Edited-Version (kein Doppel-Grading).
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
      if (cv.toBlob) cv.toBlob((b) => res(b), "image/jpeg", JPEG_QUALITY);
      else {
        const data = cv.toDataURL("image/jpeg", JPEG_QUALITY);
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

    /* Blitz-Sequenz: Der Torch braucht nach applyConstraints ~300–500 ms, bis er
       physisch leuchtet und die Kamera nachbelichtet hat. Deshalb: Blitz an →
       Aufwärmzeit → DANN auslösen → Blitz aus. Ohne Torch (Frontkamera) dient
       das hell gehaltene Display als Frontblitz, ebenfalls VOR der Aufnahme. */
    let torchUsed = false;
    let screenFlash = false;
    const fo = $("flashOverlay");

    try {
      if (state.flashMode === "on") {
        torchUsed = await setTorch(true);
        if (torchUsed) {
          await sleep(500); // LED aufleuchten + Belichtung anpassen lassen
        } else {
          screenFlash = true; // kein Torch (z. B. Selfie) → Display-Blitz
          fo.classList.add("is-hold");
          await sleep(320);
        }
      } else if (state.flashMode === "auto") {
        // Auto: kurzer ästhetischer Flash-Effekt (Umgebungslicht ist im
        // Browser nicht zuverlässig messbar), keine Auslöse-Verzögerung.
        fo.classList.remove("is-firing"); void fo.offsetWidth; fo.classList.add("is-firing");
      }

      // Mechanischer Shutter-Blink im Moment der Aufnahme.
      const blink = $("shutterBlink");
      blink.classList.remove("is-firing"); void blink.offsetWidth; blink.classList.add("is-firing");
      haptic(18);

      const cv = captureCanvas();

      // Blitz direkt nach dem eingefangenen Frame beenden.
      if (torchUsed) { setTorch(false); torchUsed = false; }
      if (screenFlash) {
        fo.classList.remove("is-hold");
        fo.classList.remove("is-fade"); void fo.offsetWidth; fo.classList.add("is-fade");
        screenFlash = false;
      }
      const blob = await canvasToBlob(cv);
      const now = Date.now();
      const seq = state.photos.length + 1;
      const gname = (state.guest && state.guest.name) || "Gast";
      const gid = (state.guest && state.guest.guestId) || "anon";
      const rec = {
        id: "p" + now + "-" + Math.random().toString(36).slice(2, 7),
        blob, takenAt: now, readyAt: now + DEVELOP_MS,
        filename: "Lumave_" + pad2(seq) + "_" + stamp(now) + ".jpg",
        uploaded: false, guest: gname, guestId: gid, seq,
        editedBlob: null, uploadedEdited: false,
      };
      await persistPhoto(rec);
      rec.url = URL.createObjectURL(blob);
      state.photos.push(rec);
      updateCounter();
      updateGalleryButton();

      // Nachgelagert (blockiert den Auslöser nicht): Lumave-Look anwenden,
      // dann Original + Edited best-effort nach Drive laden.
      (async () => {
        if (LUT) {
          try {
            rec.editedBlob = await makeEditedBlob(cv);
            rec.editedUrl = URL.createObjectURL(rec.editedBlob);
            await persistPhoto(rec);
            updateGalleryButton(); // Thumbnail auf die entwickelte Version heben
          } catch (e) { /* ensureEdited holt das im Flush nach */ }
        }
        uploadPhoto(rec);
      })();

      const left = MAX_SHOTS - state.photos.length;
      if (left === 0) toast("Letzte Aufnahme! Dein Film ist voll.", true);
      else toast("Festgehalten · " + left + " übrig", true);
    } catch (e) {
      toast("Aufnahme fehlgeschlagen – versuch es nochmal.");
    } finally {
      if (torchUsed) await setTorch(false);
      fo.classList.remove("is-hold");
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
      img.src = displayUrl(last);
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
        '<img src="' + displayUrl(p) + '" alt="Aufnahme ' + (i + 1) + ' – wird entwickelt" />' +
        '<div class="dev-cell__overlay">' +
          '<span class="dev-cell__ico">' + ICONS.hourglass + "</span>" +
          '<span class="dev-cell__time">--:--:--</span>' +
          '<span class="dev-cell__state">In Entwicklung</span>' +
        "</div>" +
        (uploadEnabled()
          ? '<span class="dev-cell__up" data-status="' + (syncDone(p) ? "done" : "pending") +
            '" title="Google-Drive-Upload">' + ICONS.cloud + "</span>"
          : "") +
        '<span class="dev-cell__ready">' + ICONS.check + "</span>" +
        '<span class="dev-cell__meta">' + String(i + 1).padStart(2, "0") + "</span>" +
        '<div class="dev-cell__bar"><i></i></div>';
      on(cell, "click", () => {
        if (cell.classList.contains("is-ready")) openLightbox(displayUrl(p));
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

    // Bereits beigetretener Gast? In derselben Session bleiben: direkt zur Kamera,
    // NICHT erneut "beitreten" lassen. Sonst würde bei jedem Reload für dieselbe
    // Person ein neuer Drive-Ordner entstehen. Die guestId bleibt stabil im
    // localStorage, damit alle Fotos im selben Gast-Ordner landen.
    const g = loadGuest();
    if (g && g.name) {
      if (!g.guestId) { g.guestId = genId(); saveGuest(g); }
      state.guest = g;
      if (g.consentAt) show("camera"); // schon beigetreten → Sucher direkt öffnen
    }

    // Noch nicht hochgeladene Fotos (Offline/Fehler) im Hintergrund nachreichen.
    // Erst die LUT laden, damit auch ältere Fotos ihre Edited-Version bekommen.
    if (uploadEnabled()) {
      await loadLUT();
      flushUploads();
      on(window, "online", flushUploads);
      setInterval(flushUploads, 30000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
