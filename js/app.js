(function () {
  "use strict";

  const STORAGE_KEY = "omni-purify-settings-v1";
  const $ = (id) => document.getElementById(id);

  const el = {
    dropzone: $("dropzone"),
    file: $("file"),
    fileCard: $("fileCard"),
    fileName: $("fileName"),
    fileSize: $("fileSize"),
    fileDims: $("fileDims"),
    detectBadge: $("detectBadge"),
    fileWarning: $("fileWarning"),
    resetBtn: $("resetBtn"),
    batchCard: $("batchCard"),
    batchList: $("batchList"),
    batchStatus: $("batchStatus"),
    batchError: $("batchError"),
    batchOverall: $("batchOverall"),
    batchStop: $("batchStop"),
    batchSaveDir: $("batchSaveDir"),
    batchDownloadAll: $("batchDownloadAll"),
    batchClear: $("batchClear"),
    pasteBtn: $("pasteBtn"),
    pasteBtnLabel: $("pasteBtnLabel"),
    pasteHint: $("pasteHint"),
    dzMain: $("dzMain"),
    dzSub: $("dzSub"),
    mobileNote: $("mobileNote"),
    supportCard: $("supportCard"),
    supportTitle: $("supportTitle"),
    supportBody: $("supportBody"),
    supportList: $("supportList"),
    shareBtn: $("shareBtn"),
    batchNote: $("batchNote"),
    previewBtn: $("previewBtn"),
    detectBtn: $("detectBtn"),
    cleanPreviewBtn: $("cleanPreviewBtn"),
    cleanPreview: $("cleanPreview"),
    runBtn: $("runBtn"),
    canvasBox: $("canvasBox"),
    canvas: $("preview"),
    compare: $("compare"),
    compareRange: $("compareRange"),
    compareHint: $("compareHint"),
    afterTag: $("afterTag"),
    zoomBtn: $("zoomBtn"),
    zoomLabel: $("zoomLabel"),
    frameTime: $("frameTime"),
    frameTimeVal: $("frameTimeVal"),
    splitVal: $("splitVal"),
    detectStatus: $("detectStatus"),
    detectStatusIcon: $("detectStatusIcon"),
    detectStatusText: $("detectStatusText"),
    progressBox: $("progressBox"),
    stage: $("stage"),
    percent: $("percent"),
    barFill: $("barFill"),
    engineLog: $("engineLog"),
    result: $("result"),
    resultVideo: $("resultVideo"),
    download: $("download"),
    resultSize: $("resultSize"),
    againBtn: $("againBtn"),
    topProgress: $("topProgress"),
    dropOverlay: $("dropOverlay"),
    error: $("error"),
    engineMode: $("engineMode"),
    bitrateMult: $("bitrateMult"),
    strength: $("strength"),
    strengthVal: $("strengthVal"),
    edgeMode: $("edgeMode"),
    cleanup: $("cleanup"),
    cleanupVal: $("cleanupVal"),
    pinPosition: $("pinPosition"),
    posDx: $("posDx"),
    posDy: $("posDy"),
    posSize: $("posSize"),
    forceRun: $("forceRun"),
    applyBtn: $("applyBtn"),
    applyStatus: $("applyStatus"),
    resetSettingsBtn: $("resetSettingsBtn"),
    debugLog: $("debugLog"),
  };

  const STAGE_LABELS = {
    detect: "Scanning frames for the watermark…",
    demux: "Reading video…",
    analyze: "Locating the watermark…",
    process: "Erasing watermark, frame by frame…",
    mux: "Packaging the clean video…",
    done: "Done",
  };

  const STATUS_ICONS = {
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5.5M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  };

  let currentFile = null;
  let currentBuffer = null;
  let resultUrl = null;
  let resultShareFile = null;
  let previewImage = null;
  let busy = false;
  let previewToken = 0;   // cancels an auto-preview when a new file is loaded
  let detection = null;   // cached __erasioDetect.detect() result for this file
  let batchItems = [];
  let batchRunning = false;
  let batchStopRequested = false;
  let newMaps = null;
  let canProcess = true;
  let lastProgressAt = Date.now();
  let stallNoticeAt = 0;
  let zoomed = false;
  let splitBeforeZoom = 50;
  let supportsDisplayTransition;

  const isTouch = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  const caps = { base: false, decoder: null, encoder: null };
  const DRAG_HINT = isTouch
    ? "Swipe the handle to compare before and after."
    : "Drag the handle to compare before and after.";

  // Erasio's shipped video defaults (Object.freeze `Ru` in the side panel).
  const settings = {
    logoVersion: "old",
    opacityMode: "auto",
    opacityCustom: 0.8,
    ceiling: 0.99,
    overlayValue: 255,
    edgeMode: "auto",
    edgeStrength: 0.6,
    edgeRadius: 2,
    edgePasses: 120,
    baseStrength: 1,
    bitrateMult: 1,
    maskScale: 1,
    maskPosition: null,
  };

  const debugLines = [];

  function dbg(line) {
    debugLines.push(line);
    if (debugLines.length > 60) debugLines.shift();
    el.debugLog.textContent = debugLines.join("\n");
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
  }

  function clearError() {
    el.error.hidden = true;
    el.error.textContent = "";
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  // Probe whether display: none transitions actually animate on this engine
  // (Firefox parses transition-behavior: allow-discrete but hides immediately).
  function canTransitionDisplay() {
    if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
    if (!window.CSS || typeof window.CSS.supports !== "function" ||
        !window.CSS.supports("transition-behavior", "allow-discrete") || !document.body) {
      supportsDisplayTransition = false;
      return false;
    }
    const probe = document.createElement("div");
    probe.style.cssText = "transition: display 1s allow-discrete !important; display: block;";
    document.body.appendChild(probe);
    getComputedStyle(probe).display;
    probe.style.display = "none";
    supportsDisplayTransition = getComputedStyle(probe).display === "block";
    probe.remove();
    return supportsDisplayTransition;
  }

  function showElement(node) {
    if (!node) return;
    node.removeAttribute("data-closing");
    node.hidden = false;
  }

  async function hideElement(node) {
    if (!node || node.hidden) return;
    if (canTransitionDisplay()) {
      node.hidden = true;
      return;
    }
    node.setAttribute("data-closing", "");
    const animations = typeof node.getAnimations === "function" ? node.getAnimations() : [];
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((r) => setTimeout(r, 400)),
      ]);
    }
    if (node.hasAttribute("data-closing")) {
      node.removeAttribute("data-closing");
      node.hidden = true;
    }
  }

  // Turn engine errors into something actionable on a phone.
  function explainError(err) {
    const msg = err && err.message ? err.message : String(err);
    const low = msg.toLowerCase();
    if (low.includes("encoder") || low.includes("webcodecs")) {
      return msg + " — this browser cannot encode H.264. On iPhone use Safari with the latest " +
        "iOS; on Android use Chrome, Edge or Samsung Internet (Firefox Android is unsupported).";
    }
    if (low.includes("out of memory") || low.includes("allocation failed") ||
        low.includes("array buffer allocation") || low.includes("quota")) {
      return "The browser ran out of memory. Close other tabs, try a shorter or 720p clip, " +
        "keep the screen on and run it again. (" + msg + ")";
    }
    return msg;
  }

  function setDims(width, height) {
    if (!width || !height) return;
    el.fileDims.textContent = width + "×" + height;
    el.fileDims.hidden = false;
  }

  function setDetectStatus(kind, text) {
    el.detectStatus.hidden = false;
    el.detectStatus.className = "status " + (kind || "");
    el.detectStatusIcon.innerHTML = STATUS_ICONS[kind] || STATUS_ICONS.info;
    el.detectStatusText.textContent = text;
  }

  function setDetectBadge(d) {
    if (!el.detectBadge) return;
    if (!d) {
      el.detectBadge.hidden = true;
      return;
    }
    if (d.chosen === "veo") {
      el.detectBadge.textContent = "Veo wordmark";
      el.detectBadge.className = "chip accent";
    } else if (d.chosen === "diamond" && d.logo) {
      el.detectBadge.textContent = d.logo.family === "new" ? "2026 sparkle" : "Logo sparkle";
      el.detectBadge.className = "chip accent";
    } else {
      el.detectBadge.textContent = "No mark detected";
      el.detectBadge.className = "chip warn";
    }
    el.detectBadge.hidden = false;
  }

  // Before/after comparator: clip the cleaned layer from the left by `v`%.
  function setCompare(v) {
    const value = Math.max(0, Math.min(100, Number(v) || 0));
    el.compare.style.setProperty("--split", value + "%");
    el.compareRange.value = String(value);
    if (el.splitVal) el.splitVal.textContent = "Split " + Math.round(value) + "%";
  }

  function updateZoomOrigin(box, width, height) {
    if (!el.compare) return;
    if (!box || !width || !height) {
      el.compare.style.setProperty("--zx", "88%");
      el.compare.style.setProperty("--zy", "88%");
      return;
    }
    const cx = Math.max(10, Math.min(95, ((box.x + box.w / 2) / width) * 100));
    const cy = Math.max(10, Math.min(95, ((box.y + box.h / 2) / height) * 100));
    el.compare.style.setProperty("--zx", cx.toFixed(1) + "%");
    el.compare.style.setProperty("--zy", cy.toFixed(1) + "%");
  }

  function setZoom(on) {
    const next = !!on;
    if (next === zoomed) return;
    zoomed = next;
    el.compare.classList.toggle("is-zoomed", zoomed);
    if (el.zoomBtn) el.zoomBtn.setAttribute("aria-pressed", String(zoomed));
    if (el.zoomLabel) el.zoomLabel.textContent = zoomed ? "Zoom 3×" : "Zoom 1×";
    if (el.canvasBox.classList.contains("has-after")) {
      if (zoomed) {
        splitBeforeZoom = Number(el.compareRange.value) || 50;
        const zx = parseFloat(el.compare.style.getPropertyValue("--zx")) || 88;
        setCompare(zx);
      } else {
        setCompare(splitBeforeZoom);
      }
    }
  }

  function currentFrameFraction() {
    if (!el.frameTime) return 0.05;
    const pct = Math.max(5, Math.min(95, Number(el.frameTime.value) || 5));
    return pct / 100;
  }

  function resetUI() {
    previewToken++;
    currentFile = null;
    currentBuffer = null;
    previewImage = null;
    detection = null;
    setZoom(false);
    updateZoomOrigin(null);
    if (el.frameTime) el.frameTime.value = "5";
    if (el.frameTimeVal) el.frameTimeVal.textContent = "5%";
    el.file.value = "";
    el.fileCard.hidden = true;
    el.fileDims.hidden = true;
    if (el.detectBadge) el.detectBadge.hidden = true;
    el.fileWarning.hidden = true;
    el.canvasBox.hidden = true;
    el.canvasBox.classList.remove("has-after", "preview-working");
    el.afterTag.textContent = "After";
    el.afterTag.classList.remove("working");
    el.detectStatus.hidden = true;
    el.progressBox.hidden = true;
    el.result.hidden = true;
    el.shareBtn.hidden = true;
    if (el.topProgress) {
      el.topProgress.style.width = "0%";
      el.topProgress.classList.remove("active");
    }
    if (el.resultVideo) {
      el.resultVideo.pause();
      el.resultVideo.removeAttribute("src");
      el.resultVideo.hidden = true;
    }
    resultShareFile = null;
    clearError();
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      resultUrl = null;
    }
  }

  // ---------- support detection ----------

  function platformName() {
    const ua = navigator.userAgent || "";
    if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
    if (/Android/i.test(ua)) return "android";
    if (/Firefox/i.test(ua)) return "firefox";
    return "desktop";
  }

  async function testEncoder() {
    if (typeof VideoEncoder === "undefined") return null;
    const base = { width: 1280, height: 720, bitrate: 3000000, framerate: 30, avc: { format: "avc" } };
    for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.42001f"]) {
      try {
        const r = await VideoEncoder.isConfigSupported(Object.assign({ codec }, base));
        if (r && r.supported) return codec;
      } catch (err) { /* try the next profile */ }
    }
    return null;
  }

  async function testDecoder() {
    if (typeof VideoDecoder === "undefined") return null;
    for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.42001f"]) {
      try {
        const r = await VideoDecoder.isConfigSupported({ codec, codedWidth: 1280, codedHeight: 720 });
        if (r && r.supported) return codec;
      } catch (err) { /* try the next profile */ }
    }
    return null;
  }

  function supportsEncoderMessage() {
    const platform = platformName();
    const tips = [];
    if (platform === "ios") {
      tips.push("<strong>iPhone / iPad:</strong> update to the latest iOS and use Safari. " +
        "Chrome and Firefox on iOS run on Safari's engine, so switching browsers will not help.");
      tips.push("<strong>Older iOS:</strong> WebCodecs video encoding needs iOS 16.4+ and is " +
        "most reliable on iOS 17.4 or newer.");
      tips.push("<strong>Workaround:</strong> process the same clip in Chrome or Edge on a computer — " +
        "the output is identical.");
    } else if (platform === "android") {
      tips.push("<strong>Android:</strong> open this page in Chrome, Edge or Samsung Internet 17+ " +
        "and update Android System WebView from the Play Store.");
      tips.push("<strong>Low-end devices:</strong> some Android builds do not expose a hardware " +
        "H.264 encoder to the browser. Try a different browser or a desktop.");
    } else if (platform === "firefox") {
      tips.push("<strong>Firefox</strong> (desktop and Android) does not expose a WebCodecs video " +
        "encoder yet.");
      tips.push("Open the page in <strong>Chrome or Edge</strong> instead.");
    } else {
      tips.push("Use a recent <strong>Chrome / Edge 94+</strong>, or <strong>Safari 17.4+</strong>.");
      tips.push("Make sure hardware acceleration is enabled for the browser.");
    }
    return {
      title: "This browser cannot re-encode video on this device",
      body: "WebCodecs H.264 encoding is not available here, so the cleaned MP4 cannot be written. " +
        "Everything runs locally in the tab, which is why a real video encoder is required.",
      tips,
    };
  }

  function showSupport(info) {
    el.supportTitle.textContent = info.title;
    el.supportBody.textContent = info.body;
    el.supportList.replaceChildren();
    for (const tip of info.tips || []) {
      const li = document.createElement("li");
      li.innerHTML = tip; // fixed guidance strings only
      el.supportList.appendChild(li);
    }
    el.supportCard.hidden = false;
  }

  function blockProcessing() {
    canProcess = false;
    el.dropzone.classList.add("disabled");
    el.dropzone.setAttribute("aria-disabled", "true");
    el.dropzone.tabIndex = -1;
    el.pasteBtn.disabled = true;
  }

  async function checkSupport() {
    const missing = [];
    if (typeof MP4Box === "undefined") missing.push("MP4Box");
    if (typeof Mp4Muxer === "undefined") missing.push("Mp4Muxer");
    if (typeof window.__purifyVideo !== "function") missing.push("video engine");
    if (typeof window.__purifyVeoVideo !== "function") missing.push("Veo engine");
    if (typeof window.__erasioDetect !== "object") missing.push("detector");
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") missing.push("OffscreenCanvas");

    if (missing.length) {
      showSupport({
        title: "The page did not load its video engine",
        body: "Missing: " + missing.join(", ") + ".",
        tips: ["Serve this folder over https:// or http:// — opening index.html directly from " +
          "file:// blocks the mask images and scripts.", "Then reload with Ctrl+F5."],
      });
      blockProcessing();
      return false;
    }

    if (typeof VideoDecoder === "undefined" || typeof VideoEncoder === "undefined") {
      showSupport(supportsEncoderMessage());
      blockProcessing();
      return false;
    }

    caps.decoder = await testDecoder();
    caps.encoder = await testEncoder();
    caps.base = true;

    if (!caps.decoder) {
      showSupport({
        title: "This browser cannot decode H.264 video",
        body: "WebCodecs is present, but this device reports no H.264 decoder. The input MP4 " +
          "cannot be read, so nothing can be cleaned.",
        tips: ["Update the browser and the operating system.", "On Android, update Chrome and " +
          "Android System WebView from the Play Store.", "On iOS, update to the latest version."],
      });
      blockProcessing();
      return false;
    }

    if (!caps.encoder) {
      showSupport(supportsEncoderMessage());
      blockProcessing();
      return false;
    }

    dbg("browser: H.264 encoder " + caps.encoder + ", decoder " + caps.decoder);
    return true;
  }

  // ---------- phone layout ----------

  function adaptForTouch() {
    if (!isTouch) return;
    document.documentElement.classList.add("is-touch");
    el.dzMain.textContent = "Tap to choose your MP4s";
    el.dzSub.textContent = "Pick one or several at once. 720p / 1080p only. " +
      "Clipboard paste works only if your browser allows it.";
    el.pasteBtnLabel.textContent = "Paste from clipboard";
    el.pasteHint.textContent = "On a phone, Browse is the reliable way to pick a video.";
    el.batchNote.textContent = "Phones: process one or two clips at a time, download each result, " +
      "then tap Clear queue to free memory. Keep this tab open and the screen on.";
    el.mobileNote.hidden = false;
  }

  // ---------- settings & persistence ----------

  function saveStoredSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        engineMode: el.engineMode.value,
        bitrateMult: el.bitrateMult ? el.bitrateMult.value : "1",
        strength: el.strength.value,
        edgeMode: el.edgeMode.value,
        cleanup: el.cleanup.value,
        forceRun: el.forceRun.checked,
      }));
    } catch (err) { /* ignore storage restrictions */ }
  }

  function loadStoredSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.engineMode && ["auto", "old", "new", "veo"].includes(saved.engineMode)) {
        el.engineMode.value = saved.engineMode;
      }
      if (el.bitrateMult && saved.bitrateMult && ["0.8", "1", "1.35"].includes(String(saved.bitrateMult))) {
        el.bitrateMult.value = String(saved.bitrateMult);
      }
      if (saved.strength != null) el.strength.value = String(saved.strength);
      if (saved.edgeMode && ["auto", "on", "off"].includes(saved.edgeMode)) {
        el.edgeMode.value = saved.edgeMode;
      }
      if (saved.cleanup != null) el.cleanup.value = String(saved.cleanup);
      if (typeof saved.forceRun === "boolean") el.forceRun.checked = saved.forceRun;
    } catch (err) { /* ignore malformed storage */ }
  }

  async function publishConfig() {
    if (!newMaps) newMaps = await window.__erasioDetect.loadNewMaps();
    const config = {
      image: { logoVersion: "old" },
      video: { ...settings },
      newMaps,
    };
    window.postMessage({ channel: "AIP_CONFIG", config }, "*");
  }

  // Surface the engines' own diagnostics in the UI.
  function captureConsole() {
    const original = console.log.bind(console);
    console.log = function (...args) {
      const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
      if (text.includes("[Erasio Video]") || text.includes("[Erasio Veo]")) {
        dbg(text.replace(/^.*\[Erasio (?:Video|Veo)\]\s*/, ""));
      }
      original(...args);
    };
  }

  function syncLabels() {
    el.strengthVal.textContent = Number(el.strength.value).toFixed(2) + "×";
    el.cleanupVal.textContent = Number(el.cleanup.value).toFixed(2);
    el.cleanup.disabled = el.edgeMode.value === "off";
  }

  function resetSettings() {
    el.engineMode.value = "auto";
    if (el.bitrateMult) el.bitrateMult.value = "1";
    el.strength.value = "1";
    el.edgeMode.value = "auto";
    el.cleanup.value = "0.6";
    el.pinPosition.checked = false;
    el.posDx.value = "96";
    el.posDy.value = "96";
    el.posSize.value = "48";
    el.forceRun.checked = false;
    try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
    syncLabels();
    readSettings();
    detection = null;
    el.applyStatus.textContent = "Reset to Erasio defaults.";
    publishConfig().catch(() => {});
  }

  function uiFamily() {
    const mode = el.engineMode.value;
    if (mode === "new" || mode === "old") return mode;
    if (mode === "auto" && detection && detection.family) return detection.family;
    return "old"; // Erasio's default
  }

  // Our pin UI is "gap between the frame edge and the mark". The engine stores
  // the mask's top-left as `width - dx`, so convert on the way in.
  function pinBox(width, height, maskSize) {
    const size = Math.max(8, Math.round(Number(el.posSize.value) || maskSize || 48));
    const dx = Math.max(0, Math.round(Number(el.posDx.value)));
    const dy = Math.max(0, Math.round(Number(el.posDy.value)));
    return {
      size,
      dx,
      dy,
      x: Math.max(0, Math.min(width - size, width - dx - size)),
      y: Math.max(0, Math.min(height - size, height - dy - size)),
    };
  }

  function baseMaskSize(family, width, height) {
    const is1080 = (width === 1920 && height === 1080) || (width === 1080 && height === 1920);
    return window.__erasioDetect.maskSpec(family, is1080, 1).base;
  }

  /**
   * Fill the engine tuning from the UI for one clip size.
   * Returns the mask size the pin resolved to (for the preview box).
   */
  function applyEngineSettings(width, height) {
    const family = uiFamily();
    settings.logoVersion = family;
    settings.baseStrength = Number(el.strength.value);
    settings.bitrateMult = el.bitrateMult ? Number(el.bitrateMult.value) || 1 : 1;
    settings.edgeMode = el.edgeMode.value;
    settings.edgeStrength = Number(el.cleanup.value);
    settings.maskScale = 1;
    settings.maskPosition = null;

    if (el.pinPosition.checked) {
      const base = baseMaskSize(family, width, height);
      const box = pinBox(width, height, base);
      settings.maskScale = Math.min(3, Math.max(0.5, box.size / base));
      const is1080 = (width === 1920 && height === 1080) || (width === 1080 && height === 1920);
      const mapSize = window.__erasioDetect.maskSpec(family, is1080, settings.maskScale).size;
      settings.maskPosition = { mode: "pinned", dx: width - box.x, dy: height - box.y };
      // Resolve exactly like the engine does, so the preview box is the treated one.
      const x = Math.max(0, Math.min(width - mapSize, width - settings.maskPosition.dx));
      const y = Math.max(0, Math.min(height - mapSize, height - settings.maskPosition.dy));
      return { family, pinned: true, box: { x, y, w: mapSize, h: mapSize } };
    }

    // A mark that scored clearly better off the inset table: pin the engine to
    // the position the detector measured instead of the fixed offsets.
    if (detection && detection.logo && detection.logo.drifted) {
      settings.maskPosition = {
        mode: "pinned",
        dx: width - detection.logo.x,
        dy: height - detection.logo.y,
      };
      return {
        family,
        pinned: true,
        box: { x: detection.logo.x, y: detection.logo.y, w: detection.logo.side, h: detection.logo.side },
      };
    }

    return {
      family,
      pinned: false,
      box: detection && detection.logo
        ? { x: detection.logo.x, y: detection.logo.y, w: detection.logo.side, h: detection.logo.side }
        : null,
    };
  }

  async function applySettings() {
    readSettings();
    saveStoredSettings();
    await publishConfig();
    el.applyStatus.textContent = "Saved & applied.";
    detection = null; // pin/size may have changed
  }

  function readSettings() {
    settings.opacityMode = "auto";
    settings.baseStrength = Number(el.strength.value);
    settings.bitrateMult = el.bitrateMult ? Number(el.bitrateMult.value) || 1 : 1;
    settings.edgeMode = el.edgeMode.value;
    settings.edgeStrength = Number(el.cleanup.value);
  }

  async function acceptFile(file) {
    if (!file) return;
    if (!canProcess) {
      el.supportCard.hidden = false;
      el.supportCard.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (!/\.mp4$/i.test(file.name) && file.type !== "video/mp4") {
      showError("Please choose an MP4 file.");
      return;
    }
    clearError();
    const token = ++previewToken;
    currentFile = file;
    detection = null;
    previewImage = null;
    setZoom(false);
    updateZoomOrigin(null);
    if (el.frameTime) el.frameTime.value = "5";
    if (el.frameTimeVal) el.frameTimeVal.textContent = "5%";
    currentBuffer = await file.arrayBuffer();
    if (token !== previewToken) return; // a newer file was selected meanwhile
    el.fileName.textContent = file.name;
    el.fileSize.textContent = formatBytes(file.size);
    el.fileDims.hidden = true;
    setDetectBadge(null);
    el.fileCard.hidden = false;
    el.fileWarning.hidden = true;
    if (isTouch) {
      const mb = file.size / 1048576;
      if (mb >= 180) {
        el.fileWarning.textContent = "This clip is " + mb.toFixed(0) +
          " MB. Phones can run out of memory — try a shorter clip or the 720p version if it fails.";
        el.fileWarning.hidden = false;
      }
      el.fileCard.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    el.canvasBox.hidden = true;
    el.canvasBox.classList.remove("has-after", "preview-working");
    el.afterTag.textContent = "After";
    el.afterTag.classList.remove("working");
    el.detectStatus.hidden = true;
    el.progressBox.hidden = true;
    el.result.hidden = true;
    // Show the before frame immediately, then reveal the cleaned side once
    // detection has located the mark — no button press needed.
    void autoPreview(token);
  }

  // ---------- preview ----------

  function paintBefore(imageData, box) {
    el.canvas.width = imageData.width;
    el.canvas.height = imageData.height;
    const ctx = el.canvas.getContext("2d");
    ctx.putImageData(imageData, 0, 0);
    if (box) {
      ctx.save();
      ctx.strokeStyle = "#0abab5";
      ctx.lineWidth = Math.max(1, Math.round(imageData.width / 640));
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h);
      ctx.restore();
    }
    updateZoomOrigin(box, imageData.width, imageData.height);
    el.canvasBox.classList.remove("has-after");
    el.compareHint.textContent = box
      ? "Teal box marks the watermark being reversed. Use Zoom 3× or Preview cleaned to inspect."
      : "Run “Preview cleaned” to compare before and after.";
    el.canvasBox.hidden = false;
  }

  function candidateBox(candidate) {
    return candidate
      ? { x: candidate.x, y: candidate.y, w: candidate.alphaMap.width, h: candidate.alphaMap.height }
      : null;
  }

  async function previewFrame() {
    if (!currentBuffer || busy) return;
    clearError();
    el.previewBtn.disabled = true;
    try {
      const frame = await window.__decodeVideoFrame(currentBuffer, currentFrameFraction());
      previewImage = frame.imageData;
      setDims(frame.width, frame.height);
      const box = detection && detection.logo
        ? { x: detection.logo.x, y: detection.logo.y, w: detection.logo.side, h: detection.logo.side }
        : detection && detection.veo
          ? { x: detection.veo.x, y: detection.veo.y, w: detection.veo.width, h: detection.veo.height }
          : null;
      paintBefore(previewImage, box);
      dbg(`preview: ${frame.width}x${frame.height} @ ${Math.round(currentFrameFraction() * 100)}%` +
        (detection ? "" : " (run Detect for a box)"));
    } catch (err) {
      showError("Preview failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      el.previewBtn.disabled = false;
    }
  }

  async function scrubFrame() {
    if (!currentBuffer || busy) return;
    const pct = Math.max(5, Math.min(95, Number(el.frameTime.value) || 5));
    if (el.frameTimeVal) el.frameTimeVal.textContent = pct + "%";
    const token = previewToken;
    try {
      const frame = await window.__decodeVideoFrame(currentBuffer, pct / 100);
      if (token !== previewToken) return;
      previewImage = frame.imageData;
      setDims(frame.width, frame.height);
      const hasAfter = el.canvasBox.classList.contains("has-after");
      if (hasAfter) {
        const candidate = await previewCandidate(previewImage);
        if (token !== previewToken) return;
        if (candidate) {
          const prevSplit = Number(el.compareRange.value) || 50;
          showCleanPreview(candidate, prevSplit);
          return;
        }
      }
      const box = detection && detection.logo
        ? { x: detection.logo.x, y: detection.logo.y, w: detection.logo.side, h: detection.logo.side }
        : detection && detection.veo
          ? { x: detection.veo.x, y: detection.veo.y, w: detection.veo.width, h: detection.veo.height }
          : null;
      paintBefore(previewImage, box);
    } catch (err) {
      showError("Frame scrub failed: " + (err && err.message ? err.message : String(err)));
    }
  }

  // ---------- detection ----------

  function describeDetection(d) {
    const bits = [];
    if (d.logo) {
      bits.push(`${d.logo.family === "new" ? "2026 sparkle" : "logo"} r=${d.logo.score.toFixed(2)} ` +
        `at ${d.logo.x},${d.logo.y} (${d.logo.side}px, opacity ${d.logo.opacity.toFixed(2)}` +
        (d.logo.drifted ? ", moved" : "") + ")");
    }
    if (d.veo) bits.push(`Veo NCC ${d.veo.ncc.toFixed(2)} at ${d.veo.x},${d.veo.y} (${d.veo.templateId})`);
    return bits.join(" · ");
  }

  async function detectWatermark(quiet, token) {
    if (!currentBuffer) return null;
    clearError();
    if (!quiet) {
      el.detectBtn.disabled = true;
      setDetectStatus("", "Scanning frames…");
    }
    try {
      const d = await window.__erasioDetect.detect(currentBuffer, {
        family: el.engineMode.value === "veo" ? "auto" : el.engineMode.value,
        settings: {
          maskScale: 1,
          baseStrength: Number(el.strength.value),
          edgeMode: el.edgeMode.value,
          edgeStrength: Number(el.cleanup.value),
        },
        onProgress: (r) => {
          if (!quiet) el.detectStatusText.textContent = `Scanning frames… ${Math.round(r * 100)}%`;
        },
      });
      if (token && token !== previewToken) return null; // a newer file was dropped
      detection = d;
      setDims(d.width, d.height);
      setDetectBadge(d);
      for (const note of d.notes || []) dbg("detect · " + note);
      dbg(`detect: ${d.width}x${d.height} — ${d.reason}`);

      let text = describeDetection(d) || "no template matched";
      if (d.chosen === "veo") text = "Veo wordmark found — " + text;
      else if (d.chosen === "diamond") text = "Watermark found — " + text;
      else text = "Nothing found — " + text;

      setDetectStatus(d.chosen ? "ok" : "warn", text);

      if (d.logo) {
        el.posSize.value = d.logo.side;
        el.posDx.value = d.width - (d.logo.x + d.logo.side);
        el.posDy.value = d.height - (d.logo.y + d.logo.side);
      }
      if (!quiet && previewImage) {
        const box = d.chosen === "diamond" && d.logo
          ? { x: d.logo.x, y: d.logo.y, w: d.logo.side, h: d.logo.side }
          : d.chosen === "veo" && d.veo
            ? { x: d.veo.x, y: d.veo.y, w: d.veo.width, h: d.veo.height }
            : null;
        paintBefore(previewImage, box);
      }
      return d;
    } catch (err) {
      showError("Detection failed: " + (err && err.message ? err.message : String(err)));
      return null;
    } finally {
      if (!quiet) el.detectBtn.disabled = false;
    }
  }

  // A candidate for the clean preview: the detector's calibrated one, or one
  // built at the pinned position.
  async function previewCandidate(imageData) {
    const width = imageData.width, height = imageData.height;
    if (el.pinPosition.checked) {
      const family = uiFamily();
      const info = applyEngineSettings(width, height);
      return window.__erasioDetect.buildCandidate(width, height, {
        x: info.box.x, y: info.box.y,
        family,
        frame: imageData,
        settings: {
          baseStrength: Number(el.strength.value),
          edgeMode: el.edgeMode.value,
          edgeStrength: Number(el.cleanup.value),
        },
      });
    }
    if (!detection || !detection.candidate) return null;
    return detection.candidate;
  }

  // ---------- clean preview ----------

  function endWorking() {
    el.canvasBox.classList.remove("preview-working");
    el.afterTag.textContent = "After";
    el.afterTag.classList.remove("working");
  }

  // Paint the cleaned frame and turn the single frame into a before/after slider.
  function showCleanPreview(candidate, splitPct) {
    const clone = new ImageData(new Uint8ClampedArray(previewImage.data), previewImage.width, previewImage.height);
    const out = window.__erasioInpaintFrame(clone, candidate);

    const box = candidateBox(candidate);
    paintBefore(previewImage, box);
    el.cleanPreview.width = out.width;
    el.cleanPreview.height = out.height;
    el.cleanPreview.getContext("2d").putImageData(out, 0, 0);

    el.canvasBox.classList.add("has-after");
    endWorking();
    el.canvasBox.hidden = false;
    setCompare(splitPct != null ? splitPct : 50);
    el.compareHint.textContent = DRAG_HINT + " Toggle Zoom 3× to inspect the corner up close.";
    dbg(`preview clean: pos=(${candidate.x},${candidate.y}) box=${candidate.alphaMap.width}px ` +
      `strength=${candidate.baseStrength.toFixed(2)} opacity=${candidate.opacity} ` +
      `cleanup=${candidate.edgeCleanup ? candidate.edgeCleanup.strength : "off"}`);
    return out;
  }

  // Runs automatically as soon as a file is dropped: show the original frame
  // straight away, locate the mark, then reveal the cleaned half of the slider.
  async function autoPreview(token) {
    if (!currentBuffer) return;
    try {
      const frame = await window.__decodeVideoFrame(currentBuffer, currentFrameFraction());
      if (token !== previewToken) return;
      previewImage = frame.imageData;
      setDims(frame.width, frame.height);
      paintBefore(previewImage, null);

      el.canvasBox.classList.add("preview-working");
      el.afterTag.textContent = "Detecting…";
      el.afterTag.classList.add("working");
      el.compareHint.textContent = "Reading the video and locating the watermark…";

      // Non-quiet so the user sees the scan progress and the result pill.
      const d = await detectWatermark(false, token);
      if (token !== previewToken) return;

      if (!d && !el.pinPosition.checked) {
        endWorking();
        el.compareHint.textContent = "No watermark found — showing the original frame only.";
        return;
      }
      if (d && d.chosen === "veo") {
        endWorking();
        el.compareHint.textContent = "Veo wordmark found — before/after preview is not available; run “Remove watermark”.";
        return;
      }

      const candidate = await previewCandidate(previewImage);
      if (token !== previewToken) return;
      if (!candidate) {
        endWorking();
        el.compareHint.textContent = "Could not build the cleaned preview — run “Remove watermark” to check this clip.";
        return;
      }
      showCleanPreview(candidate, 50);
    } catch (err) {
      if (token !== previewToken) return;
      endWorking();
      showError("Preview failed: " + (err && err.message ? err.message : String(err)));
    }
  }

  async function cleanPreview() {
    if (!currentBuffer || busy) return;
    clearError();
    el.cleanPreviewBtn.disabled = true;
    el.canvasBox.classList.remove("has-after");
    try {
      if (!previewImage) {
        const frame = await window.__decodeVideoFrame(currentBuffer, currentFrameFraction());
        previewImage = frame.imageData;
        setDims(frame.width, frame.height);
      }
      if (!detection) await detectWatermark(true);
      const mode = el.engineMode.value;
      if (mode === "veo" || (mode === "auto" && detection && detection.chosen === "veo")) {
        showError("The Veo wordmark preview is not available yet — run the removal to check it.");
        return;
      }
      const candidate = await previewCandidate(previewImage);
      if (!candidate) {
        showError("No watermark position to preview. Run Detect first, or pin the position manually.");
        return;
      }
      showCleanPreview(candidate, Number(el.compareRange.value) || 50);
    } catch (err) {
      showError("Clean preview failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      el.cleanPreviewBtn.disabled = false;
    }
  }

  // ---------- run ----------

  function setProgress(stage, ratio) {
    lastProgressAt = Date.now();
    stallNoticeAt = 0;
    el.stage.textContent = STAGE_LABELS[stage] || stage || "Working…";
    const pct = Math.round((ratio || 0) * 100);
    el.percent.textContent = pct + "%";
    el.barFill.style.width = pct + "%";
    if (el.topProgress) {
      el.topProgress.style.width = pct + "%";
      el.topProgress.classList.toggle("active", !!stage && stage !== "done");
    }
    if (stage) el.engineLog.textContent = "engine stage: " + stage;
  }

  function selectEngine(d) {
    const mode = el.engineMode.value;
    const chosen = d ? d.chosen : null;
    const useVeo = mode === "veo" || (mode === "auto" && chosen === "veo");
    const sparkleRequested = mode === "old" || mode === "new" ||
      (mode === "auto" && chosen === "diamond");
    return {
      useVeo,
      useSparkle: !useVeo && (sparkleRequested || el.pinPosition.checked || el.forceRun.checked),
    };
  }

  async function run() {
    if (!currentBuffer || busy || batchRunning) return;
    busy = true;
    const startedAt = performance.now();
    lastProgressAt = Date.now();
    stallNoticeAt = 0;
    clearError();
    el.result.hidden = true;
    el.progressBox.hidden = false;
    el.runBtn.disabled = true;
    el.previewBtn.disabled = true;
    el.detectBtn.disabled = true;
    setProgress("detect", 0);

    try {
      readSettings();

      if (!detection) {
        const d = await detectWatermark(true);
        if (!d && !el.pinPosition.checked && !el.forceRun.checked) {
          throw new Error("no watermark detected — nothing was re-encoded. " +
            "Use Preview cleaned to check the box, pin the position manually, or tick " +
            "\"Run even if nothing is detected\".");
        }
      }

      const { useVeo, useSparkle } = selectEngine(detection);

      if (!useVeo && !useSparkle) {
        throw new Error("no watermark detected — nothing was re-encoded. Use Preview " +
          "cleaned to check the box, pin the position manually, or tick " +
          "\"Run even if nothing is detected\".");
      }

      // Detection carries the clip size; when it failed, take it from a frame.
      let width = detection && detection.width;
      let height = detection && detection.height;
      if (!width || !height) {
        const frame = await window.__decodeVideoFrame(currentBuffer, 0.05);
        width = frame.width;
        height = frame.height;
      }

      let blob;
      if (useVeo) {
        dbg("engine: Veo wordmark");
        try {
          blob = await window.__purifyVeoVideo(currentBuffer, {
            onProgress: ({ stage, ratio }) => setProgress(stage, ratio),
          });
        } catch (err) {
          if (err && err.code === "ERASIO_NO_WATERMARK") {
            throw new Error("the Veo wordmark was not found in this clip — pick " +
              "\"Logo only\" if it is a Gemini/Omni sparkle video.");
          }
          throw err;
        }
      } else {
        // The engine runs Erasio's own calibration (fixed inset table, Pearson
        // score, two-level opacity, edge rule). We only hand it the family and
        // an optional pinned position.
        const info = applyEngineSettings(width, height);
        await publishConfig();
        dbg(`engine: sparkle family=${info.family}` +
          (settings.maskPosition
            ? ` pinned dx=${settings.maskPosition.dx} dy=${settings.maskPosition.dy}`
            : " offsets") +
          ` strength=${settings.baseStrength.toFixed(2)} bitrate=${settings.bitrateMult}x edge=${settings.edgeMode}`);
        blob = await window.__purifyVideo(currentBuffer, {
          onProgress: ({ stage, ratio }) => setProgress(stage, ratio),
        });
        if (info.box) dbg(`box: ${info.box.w}px at ${info.box.x},${info.box.y}`);
      }

      const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(1);
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(blob);
      el.download.href = resultUrl;
      const base = (currentFile ? currentFile.name : "video").replace(/\.[^.]+$/, "");
      el.download.download = base + "-nowatermark.mp4";
      el.resultSize.textContent = `${formatBytes(blob.size)} output · cleaned in ${elapsedSec}s`;
      if (el.resultVideo) {
        el.resultVideo.src = resultUrl;
        el.resultVideo.hidden = false;
      }
      el.shareBtn.hidden = true;
      resultShareFile = null;
      if (isTouch && navigator.canShare) {
        try {
          const file = new File([blob], base + "-nowatermark.mp4", { type: "video/mp4" });
          if (navigator.canShare({ files: [file] })) {
            resultShareFile = file;
            el.shareBtn.hidden = false;
          }
        } catch (err) { /* share is a bonus, never block the download */ }
      }
      setProgress("done", 1);
      el.result.hidden = false;
      if (isTouch) el.result.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (err) {
      const msg = explainError(err);
      showError("Processing failed: " + msg +
        (msg.includes("Unsupported dimensions")
          ? " — this engine is calibrated for 720p / 1080p (16:9 or 9:16) only."
          : ""));
    } finally {
      busy = false;
      el.runBtn.disabled = false;
      el.previewBtn.disabled = false;
      el.detectBtn.disabled = false;
    }
  }

  // ---------- bulk processing ----------

  function showBatchError(message) {
    el.batchError.textContent = message || "";
    el.batchError.hidden = !message;
  }

  function outputName(item) {
    return item.name.replace(/\.[^.]+$/, "") + "-nowatermark.mp4";
  }

  function acceptFiles(files) {
    if (!canProcess) {
      if (files && files.length) {
        el.supportCard.hidden = false;
        el.supportCard.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }
    const list = Array.from(files || []);
    if (!list.length) return;
    const videos = list.filter((f) => /\.mp4$/i.test(f.name) || f.type === "video/mp4");
    showBatchError(videos.length === list.length ? "" :
      "Skipped " + (list.length - videos.length) + " non-MP4 file(s) — bulk mode accepts MP4 only.");
    if (!videos.length) return;
    if (videos.length === 1 && !batchItems.length && !batchRunning) {
      void acceptFile(videos[0]); // normal single-file flow
      return;
    }
    addBatchFiles(videos);
  }

  function addBatchFiles(files) {
    for (const file of files) {
      batchItems.push({
        file, name: file.name, size: file.size,
        status: "queued", statusText: null, blob: null, url: null, error: null,
      });
    }
    batchStopRequested = false;
    resetUI(); // hide the single-file editor and its stale preview
    el.batchCard.hidden = false;
    if (isTouch) el.batchCard.scrollIntoView({ behavior: "smooth", block: "start" });
    showBatchError("");
    renderBatch();
    updateBatchSummary();
    if (!batchRunning) void runBatch();
  }

  function removeBatchItem(item) {
    if (item.status === "working") return;
    if (item.url) URL.revokeObjectURL(item.url);
    batchItems = batchItems.filter((i) => i !== item);
    if (!batchItems.length && !batchRunning) {
      clearBatch();
      return;
    }
    renderBatch();
    updateBatchSummary();
  }

  function retryBatchItem(item) {
    if (item.status !== "error") return;
    item.status = "queued";
    item.statusText = null;
    item.error = null;
    batchStopRequested = false;
    renderBatch();
    updateBatchSummary();
    if (!batchRunning) void runBatch();
  }

  function renderBatch() {
    el.batchList.replaceChildren();
    batchItems.forEach((item) => {
      const row = document.createElement("li");
      row.className = "batch-row " + item.status;

      const icon = document.createElement("span");
      icon.className = "batch-icon";
      icon.textContent = "MP4";

      const info = document.createElement("div");
      info.className = "batch-info";
      const name = document.createElement("strong");
      name.textContent = item.name;
      name.title = item.name;
      const sub = document.createElement("span");
      sub.className = "batch-sub";
      const status = document.createElement("span");
      status.className = "batch-status " + item.status;
      status.textContent = statusLabel(item);
      const size = document.createElement("span");
      size.textContent = formatBytes(item.size);
      sub.append(status, document.createTextNode("·"), size);
      const barBox = document.createElement("div");
      barBox.className = "batch-bar";
      barBox.hidden = item.status !== "working";
      const barFill = document.createElement("div");
      barBox.appendChild(barFill);
      info.append(name, sub, barBox);

      const rowActions = document.createElement("div");
      rowActions.className = "batch-row-actions";

      const link = document.createElement("a");
      link.className = "btn sm batch-dl";
      link.textContent = "Download";
      link.download = outputName(item);
      link.hidden = item.status !== "done" || !item.url;
      if (item.url) link.href = item.url;
      rowActions.appendChild(link);

      if (item.status === "error") {
        const retryBtn = document.createElement("button");
        retryBtn.type = "button";
        retryBtn.className = "btn sm";
        retryBtn.textContent = "Retry";
        retryBtn.addEventListener("click", () => retryBatchItem(item));
        rowActions.appendChild(retryBtn);
      }

      if (item.status !== "working") {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "btn sm ghost";
        removeBtn.textContent = "Remove";
        removeBtn.setAttribute("aria-label", `Remove ${item.name}`);
        removeBtn.addEventListener("click", () => removeBatchItem(item));
        rowActions.appendChild(removeBtn);
      }

      row.append(icon, info, rowActions);
      el.batchList.appendChild(row);
      item.rowEl = row;
      item.statusEl = status;
      item.barBox = barBox;
      item.barFill = barFill;
      item.linkEl = link;
    });
  }

  function setRowStatus(item, status, text) {
    item.status = status;
    item.statusText = text || null;
    if (status === "done" || status === "error") {
      renderBatch();
    } else if (item.rowEl) {
      item.rowEl.className = "batch-row " + status;
      item.statusEl.className = "batch-status " + status;
      item.statusEl.textContent = statusLabel(item);
      if (status === "working") item.barBox.hidden = false;
    }
    updateBatchSummary();
  }

  function statusLabel(item) {
    return item.statusText ||
      ({ queued: "Queued", working: "Working", done: "Done", error: "Failed" })[item.status];
  }

  function setRowProgress(item, ratio) {
    if (!item.barBox) return;
    lastProgressAt = Date.now();
    stallNoticeAt = 0;
    item.barBox.hidden = false;
    item.barFill.style.width = Math.round(Math.max(0, Math.min(1, ratio || 0)) * 100) + "%";
  }

  function updateBatchSummary() {
    if (!batchItems.length) {
      el.batchStatus.textContent = "No files queued.";
      el.batchOverall.style.width = "0%";
      el.batchDownloadAll.disabled = true;
      if (el.batchSaveDir) el.batchSaveDir.hidden = true;
      if (el.batchStop) el.batchStop.hidden = true;
      el.batchClear.disabled = false;
      return;
    }
    const total = batchItems.length;
    const done = batchItems.filter((i) => i.status === "done").length;
    const failed = batchItems.filter((i) => i.status === "error").length;
    const queued = batchItems.filter((i) => i.status === "queued").length;
    const active = batchItems.find((i) => i.status === "working");
    el.batchOverall.style.width = Math.round(((done + failed) / total) * 100) + "%";
    el.batchDownloadAll.disabled = done === 0;
    el.batchClear.disabled = batchRunning;

    if (el.batchSaveDir) {
      el.batchSaveDir.hidden = !(typeof window.showDirectoryPicker === "function" && done > 0);
    }
    if (el.batchStop) {
      if (batchRunning) {
        el.batchStop.hidden = false;
        el.batchStop.disabled = batchStopRequested;
        el.batchStop.textContent = batchStopRequested ? "Stopping…" : "Stop queue";
      } else if (queued > 0) {
        el.batchStop.hidden = false;
        el.batchStop.disabled = false;
        el.batchStop.textContent = "Resume queue";
      } else {
        el.batchStop.hidden = true;
      }
    }

    el.batchStatus.textContent = active
      ? `Processing ${batchItems.indexOf(active) + 1} of ${total}: ${active.name}`
      : batchRunning
        ? `Starting next file… (${done + failed}/${total} finished)`
        : queued > 0
          ? `Paused — ${done} cleaned, ${queued} queued out of ${total}.`
          : `Finished — ${done} cleaned, ${failed} failed out of ${total}.`;
  }

  async function processBatchItem(item) {
    lastProgressAt = Date.now();
    stallNoticeAt = 0;
    setRowStatus(item, "working", "Reading…");
    setRowProgress(item, 0);
    try {
      readSettings();
      const buffer = await item.file.arrayBuffer();
      const frame = await window.__decodeVideoFrame(buffer, 0.05);
      const width = frame.width, height = frame.height;

      setRowStatus(item, "working", "Detecting…");
      setRowProgress(item, 0.08);
      const d = await window.__erasioDetect.detect(buffer, {
        family: el.engineMode.value === "veo" ? "auto" : el.engineMode.value,
        settings: {
          maskScale: 1,
          baseStrength: Number(el.strength.value),
          edgeMode: el.edgeMode.value,
          edgeStrength: Number(el.cleanup.value),
        },
        onProgress: (r) => {
          setRowProgress(item, 0.08 + (r || 0) * 0.22);
          setRowStatus(item, "working", `Detecting… ${Math.round((r || 0) * 100)}%`);
        },
      });
      item.detection = d;
      detection = d; // applyEngineSettings() uses the cached detection for drifted marks

      const { useVeo, useSparkle } = selectEngine(d);
      if (!useVeo && !useSparkle) throw new Error("no watermark detected — nothing was re-encoded");

      const onEngineProgress = ({ stage, ratio }) => {
        setRowProgress(item, 0.3 + (ratio || 0) * 0.7);
        setRowStatus(item, "working", (STAGE_LABELS[stage] || stage || "Processing").replace("…", ""));
      };

      let blob;
      if (useVeo) {
        try {
          blob = await window.__purifyVeoVideo(buffer, { onProgress: onEngineProgress });
        } catch (err) {
          if (err && err.code === "ERASIO_NO_WATERMARK") throw new Error("Veo wordmark not found in this clip");
          throw err;
        }
      } else {
        const info = applyEngineSettings(width, height);
        await publishConfig();
        dbg(`batch ${item.name}: family=${info.family}` +
          (info.box ? ` box=${info.box.w}px at ${info.box.x},${info.box.y}` : " offsets"));
        blob = await window.__purifyVideo(buffer, { onProgress: onEngineProgress });
      }

      item.blob = blob;
      item.url = URL.createObjectURL(blob);
      setRowProgress(item, 1);
      setRowStatus(item, "done", "Done · " + formatBytes(blob.size));
    } catch (err) {
      const msg = explainError(err);
      item.error = msg;
      setRowStatus(item, "error", msg.length > 90 ? msg.slice(0, 90) + "…" : msg);
      dbg(`batch ${item.name} FAILED: ${msg}`);
    }
  }

  async function runBatch() {
    if (batchRunning) return;
    batchRunning = true;
    renderBatch();
    updateBatchSummary();
    try {
      while (!batchStopRequested) {
        const item = batchItems.find((i) => i.status === "queued");
        if (!item) break;
        renderBatch();
        await processBatchItem(item);
      }
    } finally {
      batchRunning = false;
      batchStopRequested = false;
      renderBatch();
      updateBatchSummary();
    }
  }

  function toggleBatchStopOrResume() {
    if (batchRunning) {
      batchStopRequested = true;
      updateBatchSummary();
      return;
    }
    const hasQueued = batchItems.some((i) => i.status === "queued");
    if (hasQueued) {
      batchStopRequested = false;
      void runBatch();
    }
  }

  async function saveBatchToFolder() {
    const items = batchItems.filter((i) => i.status === "done" && i.blob);
    if (!items.length || typeof window.showDirectoryPicker !== "function") return;
    try {
      const dir = await window.showDirectoryPicker({ mode: "readwrite" });
      const used = new Set();
      let saved = 0;
      for (const item of items) {
        let name = outputName(item);
        if (used.has(name)) {
          const base = name.replace(/\.mp4$/i, "");
          let n = 2;
          while (used.has(name)) name = base + "-" + n++ + ".mp4";
        }
        used.add(name);
        const fh = await dir.getFileHandle(name, { create: true });
        const writable = await fh.createWritable();
        await writable.write(item.blob);
        await writable.close();
        saved++;
      }
      el.batchStatus.textContent = `Saved ${saved} clean MP4(s) to "${dir.name}".`;
    } catch (err) {
      if (err && err.name !== "AbortError") {
        showBatchError("Could not save to folder: " + (err.message || String(err)));
      }
    }
  }

  function clearBatch() {
    if (batchRunning) return;
    for (const item of batchItems) if (item.url) URL.revokeObjectURL(item.url);
    batchItems = [];
    batchStopRequested = false;
    el.batchList.replaceChildren();
    el.batchCard.hidden = true;
    el.batchOverall.style.width = "0%";
    el.batchDownloadAll.disabled = true;
    showBatchError("");
    resetUI();
  }

  function downloadAll() {
    const items = batchItems.filter((i) => i.status === "done" && i.url);
    if (!items.length) return;
    const used = new Set();
    for (const item of items) {
      let name = outputName(item);
      if (used.has(name)) {
        const base = name.replace(/\.mp4$/i, "");
        let n = 2;
        while (used.has(name)) name = base + "-" + n++ + ".mp4";
      }
      used.add(name);
      const a = document.createElement("a");
      a.href = item.url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    el.batchStatus.textContent = `Started ${items.length} separate downloads — allow multiple downloads if Chrome asks.`;
  }

  // ---------- paste ----------

  function onPaste(event) {
    const files = event.clipboardData && event.clipboardData.files;
    if (!files || !files.length) return;
    const videos = Array.from(files).filter((f) => /^video\//i.test(f.type) || /\.mp4$/i.test(f.name));
    if (!videos.length) return;
    event.preventDefault();
    el.pasteHint.textContent = "Pasted " + videos.length + " video file(s).";
    acceptFiles(videos);
  }

  async function pasteFromClipboard() {
    if (navigator.clipboard && typeof navigator.clipboard.read === "function") {
      el.pasteBtn.disabled = true;
      el.pasteBtn.classList.add("busy");
      el.pasteHint.textContent = "Reading clipboard…";
      try {
        const items = await navigator.clipboard.read();
        const files = [];
        for (const item of items) {
          const types = item.types.filter((t) => /^video\//i.test(t) || t === "application/octet-stream");
          if (!types.length) continue;
          const blob = await item.getType(types[0]);
          const ext = (blob.type && blob.type.split("/")[1]) || "mp4";
          files.push(new File([blob], "pasted-video-" + (files.length + 1) + "." + ext.replace(/[^a-z0-9]/gi, ""), {
            type: blob.type || types[0],
          }));
        }
        if (files.length) {
          el.pasteHint.textContent = "Pasted " + files.length + " video(s) from the clipboard.";
          acceptFiles(files);
          return;
        }
      } catch (err) {
        // Permission denied or unsupported — show the guidance below.
      } finally {
        el.pasteBtn.disabled = false;
        el.pasteBtn.classList.remove("busy");
      }
    }
    el.pasteHint.textContent = isTouch
      ? "No video on the clipboard. On a phone, tap Browse to pick the MP4."
      : "No MP4 on the clipboard. Browsers only expose images/text from a copied file — drop the MP4 or use Browse instead.";
  }

  async function shareResult() {
    if (!resultShareFile) return;
    try {
      await navigator.share({ files: [resultShareFile], title: "Clean video" });
    } catch (err) {
      if (err && err.name !== "AbortError") {
        showError("Sharing failed: " + (err.message || String(err)) +
          " — use Download clean MP4 instead.");
      }
    }
  }

  function bindEvents() {
    document.addEventListener("paste", onPaste);
    el.pasteBtn.addEventListener("click", pasteFromClipboard);
    el.shareBtn.addEventListener("click", shareResult);
    el.againBtn.addEventListener("click", () => {
      resetUI();
      el.dropzone.scrollIntoView({ behavior: "smooth", block: "center" });
      if (!isTouch) el.file.click();
    });
    el.resetSettingsBtn.addEventListener("click", resetSettings);
    el.dropzone.addEventListener("click", () => {
      if (!canProcess) {
        el.supportCard.hidden = false;
        el.supportCard.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      el.file.click();
    });
    el.dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && canProcess) {
        e.preventDefault();
        el.file.click();
      } else if (e.key === " ") {
        e.preventDefault(); // prevent scroll; trigger on keyup per native button
      }
    });
    el.dropzone.addEventListener("keyup", (e) => {
      if (e.key === " " && canProcess) {
        el.file.click();
      }
    });
    ["dragenter", "dragover"].forEach((type) =>
      el.dropzone.addEventListener(type, (e) => {
        e.preventDefault();
        el.dropzone.classList.add("drag");
      })
    );
    ["dragleave", "drop"].forEach((type) =>
      el.dropzone.addEventListener(type, (e) => {
        e.preventDefault();
        el.dropzone.classList.remove("drag");
      })
    );
    el.dropzone.addEventListener("drop", (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) acceptFiles(files);
    });

    // Page-wide drop target: dropping anywhere outside the dropzone works too.
    let dragDepth = 0;
    const hasFiles = (e) =>
      !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"));
    window.addEventListener("dragenter", (e) => {
      if (!hasFiles(e) || !canProcess) return;
      e.preventDefault();
      dragDepth++;
      showElement(el.dropOverlay);
    });
    window.addEventListener("dragover", (e) => {
      if (!hasFiles(e) || !canProcess) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    window.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) void hideElement(el.dropOverlay);
    });
    window.addEventListener("drop", (e) => {
      dragDepth = 0;
      void hideElement(el.dropOverlay);
      if (e.defaultPrevented) return; // the dropzone already handled it
      if (!hasFiles(e) || !canProcess) return;
      e.preventDefault();
      const files = e.dataTransfer.files;
      if (files && files.length) acceptFiles(files);
    });

    el.file.addEventListener("change", (e) => {
      acceptFiles(e.target.files);
      e.target.value = ""; // allow picking the same file(s) again
    });

    if (el.batchStop) el.batchStop.addEventListener("click", toggleBatchStopOrResume);
    if (el.batchSaveDir) el.batchSaveDir.addEventListener("click", saveBatchToFolder);
    el.batchDownloadAll.addEventListener("click", downloadAll);
    el.batchClear.addEventListener("click", clearBatch);
    el.resetBtn.addEventListener("click", resetUI);
    el.previewBtn.addEventListener("click", previewFrame);
    el.detectBtn.addEventListener("click", () => detectWatermark(false));
    el.cleanPreviewBtn.addEventListener("click", cleanPreview);
    el.runBtn.addEventListener("click", run);
    el.applyBtn.addEventListener("click", applySettings);
    el.compareRange.addEventListener("input", () => setCompare(el.compareRange.value));

    if (el.zoomBtn) {
      el.zoomBtn.addEventListener("click", () => setZoom(!zoomed));
    }
    if (el.frameTime) {
      el.frameTime.addEventListener("input", () => {
        if (el.frameTimeVal) el.frameTimeVal.textContent = el.frameTime.value + "%";
      });
      el.frameTime.addEventListener("change", scrubFrame);
    }

    [el.strength, el.cleanup].forEach((input) =>
      input.addEventListener("input", () => {
        syncLabels();
        saveStoredSettings();
      })
    );
    [el.edgeMode, el.bitrateMult, el.forceRun].forEach((ctrl) => {
      if (!ctrl) return;
      ctrl.addEventListener("change", () => {
        syncLabels();
        readSettings();
        saveStoredSettings();
      });
    });
    el.engineMode.addEventListener("change", () => {
      detection = null;
      el.applyStatus.textContent = "";
      saveStoredSettings();
    });
  }

  function watchForStall() {
    if (!busy && !batchRunning) return;
    if (Date.now() - lastProgressAt < 120000) return;
    if (stallNoticeAt && Date.now() - stallNoticeAt < 120000) return;
    stallNoticeAt = Date.now();
    const note = "No progress for 2 minutes — this device's encoder may be stuck. Keep " +
      "waiting, or reload the page and try a shorter 720p clip.";
    if (batchRunning) el.batchStatus.textContent = note;
    else el.engineLog.textContent = note;
    dbg("stall warning: no engine progress for 2 minutes");
  }

  (async function init() {
    captureConsole();
    loadStoredSettings();
    syncLabels();
    readSettings();
    setCompare(50);
    adaptForTouch();
    bindEvents();
    setInterval(watchForStall, 10000);
    const ok = await checkSupport();
    if (!ok) return;
    try {
      await publishConfig();
    } catch (err) {
      showError("Could not initialise watermark maps: " + (err && err.message ? err.message : String(err)));
    }
  })();
})();
