(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = {
    dropzone: $("dropzone"),
    file: $("file"),
    fileCard: $("fileCard"),
    fileName: $("fileName"),
    fileSize: $("fileSize"),
    resetBtn: $("resetBtn"),
    previewBtn: $("previewBtn"),
    cleanPreviewBtn: $("cleanPreviewBtn"),
    cleanPreview: $("cleanPreview"),
    runBtn: $("runBtn"),
    canvasBox: $("canvasBox"),
    canvas: $("preview"),
    progressBox: $("progressBox"),
    stage: $("stage"),
    percent: $("percent"),
    barFill: $("barFill"),
    engineLog: $("engineLog"),
    result: $("result"),
    download: $("download"),
    resultSize: $("resultSize"),
    error: $("error"),
    opacityMode: $("opacityMode"),
    opacityCustom: $("opacityCustom"),
    opacityCustomVal: $("opacityCustomVal"),
    maskScale: $("maskScale"),
    maskScaleVal: $("maskScaleVal"),
    baseStrength: $("baseStrength"),
    baseStrengthVal: $("baseStrengthVal"),
    ceiling: $("ceiling"),
    ceilingVal: $("ceilingVal"),
    pinPosition: $("pinPosition"),
    posDx: $("posDx"),
    posDy: $("posDy"),
    detectBtn: $("detectBtn"),
    applyBtn: $("applyBtn"),
    applyStatus: $("applyStatus"),
    debugLog: $("debugLog"),
  };

  const STAGE_LABELS = {
    demux: "Reading video…",
    analyze: "Locating the watermark…",
    process: "Erasing watermark, frame by frame…",
    mux: "Packaging the clean video…",
    done: "Finishing…",
  };

  let currentFile = null;
  let currentBuffer = null;
  let resultUrl = null;
  let busy = false;

  // Settings mirror the original side panel's video tuning. They are re-sent
  // to the engine through AIP_CONFIG before every run.
  const settings = {
    logoVersion: "new",
    opacityMode: "auto",
    opacityCustom: 0.8,
    maskScale: 1,
    baseStrength: 1,
    ceiling: 0.99,
    overlayValue: 255,
    edgeMode: "auto",
    edgeStrength: 0.6,
    edgeRadius: 2,
    edgePasses: 120,
    bitrateMult: 1,
    maskPosition: null,
  };

  const debugLines = [];
  let imageEngine = null;

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
  }

  function clearError() {
    el.error.hidden = true;
    el.error.textContent = "";
  }

  function resetUI() {
    currentFile = null;
    currentBuffer = null;
    el.file.value = "";
    el.fileCard.hidden = true;
    el.canvasBox.hidden = true;
    el.progressBox.hidden = true;
    el.result.hidden = true;
    clearError();
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      resultUrl = null;
    }
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function checkSupport() {
    const missing = [];
    if (typeof MP4Box === "undefined") missing.push("MP4Box");
    if (typeof Mp4Muxer === "undefined") missing.push("Mp4Muxer");
    if (typeof window.__purifyVideo !== "function") missing.push("video engine");
    if (typeof VideoDecoder === "undefined" || typeof VideoEncoder === "undefined") missing.push("WebCodecs");
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") missing.push("OffscreenCanvas");
    if (missing.length) {
      showError("Missing required browser APIs: " + missing.join(", ") +
        ". Open this page in a recent Chrome or Edge over http:// (or GitHub Pages).");
      return false;
    }
    return true;
  }

  // Decode a calibrated mask PNG exactly the way the extension does:
  // grayscale-on-black capture -> max(R,G,B) / 255 per pixel.
  async function loadMask(url, size) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Cannot load " + url + " (HTTP " + res.status + ")");
    const bmp = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, size, size);
    bmp.close();
    const data = ctx.getImageData(0, 0, size, size).data;
    const values = new Float32Array(size * size);
    for (let i = 0; i < values.length; i++) {
      const o = i * 4;
      values[i] = Math.max(data[o], data[o + 1], data[o + 2]) / 255;
    }
    return { side: size, values };
  }

  // The engine receives its settings over an in-page message channel.
  // Supplying the 2026 ("new" / Omni) maps here reproduces the extension's
  // exact watermark-removal behaviour for Gemini/Omni videos.
  let masks = null;

  async function publishConfig() {
    if (!masks) {
      const [s48, s96] = await Promise.all([
        loadMask("masks/sparkle-2026-48.png", 48),
        loadMask("masks/sparkle-2026-96.png", 96),
      ]);
      masks = { s48, s96 };
    }
    const config = {
      image: { logoVersion: "new" },
      video: { ...settings },
      newMaps: masks,
    };
    window.postMessage({ channel: "AIP_CONFIG", config }, "*");
  }

  // Capture the engine's own log lines (position / score / opacity) so the
  // user can see whether it actually detected the watermark.
  function captureConsole() {
    const original = console.log.bind(console);
    console.log = function (...args) {
      const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
      if (text.includes("[Erasio Video]")) {
        debugLines.push(text.replace(/^.*\[Erasio Video\]\s*/, ""));
        if (debugLines.length > 12) debugLines.shift();
        el.debugLog.textContent = debugLines.join("\n");
      }
      original(...args);
    };
  }

  function syncSliderLabels() {
    el.opacityCustomVal.textContent = Number(el.opacityCustom.value).toFixed(2);
    el.maskScaleVal.textContent = Number(el.maskScale.value).toFixed(2) + "×";
    el.baseStrengthVal.textContent = Number(el.baseStrength.value).toFixed(2);
    el.ceilingVal.textContent = Number(el.ceiling.value).toFixed(2);
  }

  function readSettingsFromUI() {
    settings.opacityMode = el.opacityMode.value;
    settings.opacityCustom = Number(el.opacityCustom.value);
    settings.maskScale = Number(el.maskScale.value);
    settings.baseStrength = Number(el.baseStrength.value);
    settings.ceiling = Number(el.ceiling.value);
    settings.maskPosition = el.pinPosition.checked
      ? { mode: "pinned", dx: Number(el.posDx.value), dy: Number(el.posDy.value) }
      : null;
  }

  async function applySettings() {
    readSettingsFromUI();
    await publishConfig();
    el.applyStatus.textContent = "Applied — next run will use these settings.";
  }

  async function acceptFile(file) {
    if (!file) return;
    if (!/\.mp4$/i.test(file.name) && file.type !== "video/mp4") {
      showError("Please choose an MP4 file.");
      return;
    }
    clearError();
    currentFile = file;
    currentBuffer = await file.arrayBuffer();
    el.fileName.textContent = file.name;
    el.fileSize.textContent = formatBytes(file.size);
    el.fileCard.hidden = false;
    el.canvasBox.hidden = true;
    el.progressBox.hidden = true;
    el.result.hidden = true;
  }

  async function previewFrame() {
    if (!currentBuffer || busy) return;
    clearError();
    el.previewBtn.disabled = true;
    try {
      const { imageData, width, height } = await window.__decodeVideoFrame(currentBuffer, 0.05);
      el.canvas.width = width;
      el.canvas.height = height;
      el.canvas.getContext("2d").putImageData(imageData, 0, 0);
      el.canvasBox.hidden = false;

      // Fill in the calibrated corner offsets for this resolution.
      const is1080 = (width === 1920 && height === 1080) || (width === 1080 && height === 1920);
      const def = is1080 ? [222, 186] : [144, 120];
      el.posDx.value = def[0];
      el.posDy.value = def[1];
      debugLines.push(`preview: ${width}x${height}, default corner offsets ${def[0]}/${def[1]}`);
      el.debugLog.textContent = debugLines.join("\n");
    } catch (err) {
      showError("Preview failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      el.previewBtn.disabled = false;
    }
  }

  async function ensureImageEngine() {
    if (imageEngine) return;
    const Engine = window.__erasioImageEngine && window.__erasioImageEngine.GeminiWatermarkEngine;
    if (!Engine) throw new Error("image engine not loaded");
    imageEngine = new Engine();
    await imageEngine.init(
      "masks/bg_48.png", "masks/bg_96.png",
      "masks/sparkle-2026-48.png", "masks/sparkle-2026-96.png"
    );
  }

  // Clean one frame with the image engine so the user can see whether the
  // watermark was detected and whether the current settings remove it — without
  // waiting for the whole video to re-encode.
  async function cleanPreview() {
    if (!currentBuffer || busy) return;
    clearError();
    el.cleanPreviewBtn.disabled = true;
    try {
      await ensureImageEngine();

      const { imageData, width, height } = await window.__decodeVideoFrame(currentBuffer, 0.05);
      el.canvas.width = width;
      el.canvas.height = height;
      el.canvas.getContext("2d").putImageData(imageData, 0, 0);
      el.canvasBox.hidden = false;

      const is1080 = (width === 1920 && height === 1080) || (width === 1080 && height === 1920);
      const size = is1080 ? 96 : 48;
      let forcePosition = null;
      if (settings.maskPosition) {
        const dx = Number(settings.maskPosition.dx);
        const dy = Number(settings.maskPosition.dy);
        forcePosition = {
          x: Math.max(0, Math.min(width - size, Math.round(width - dx))),
          y: Math.max(0, Math.min(height - size, Math.round(height - dy))),
          size,
        };
      }

      const clone = new ImageData(new Uint8ClampedArray(imageData.data), width, height);
      const result = imageEngine.removeWatermarkAuto(clone, {
        logoVersion: "new",
        maskScale: settings.maskScale,
        logoValue: settings.overlayValue,
        maxAlpha: settings.ceiling,
        forcePosition,
      });

      el.cleanPreview.width = width;
      el.cleanPreview.height = height;
      el.cleanPreview.getContext("2d").putImageData(clone, 0, 0);

      debugLines.push(
        `preview clean: success=${result.success} confidence=${Number(result.confidence || 0).toFixed(3)} ` +
        `pos=(${result.position.x},${result.position.y}) size=${result.size} ` +
        `method=${result.method} pixels=${result.pixelsModified}`
      );
      el.debugLog.textContent = debugLines.join("\n");
      if (!result.success) {
        el.applyStatus.textContent = "No watermark detected in this frame — try pinning the position.";
      }
    } catch (err) {
      showError("Clean preview failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      el.cleanPreviewBtn.disabled = false;
    }
  }

  // The video engine checks only a few fixed corner offsets. The image engine
  // scans the whole frame, so use it to find the real position and pin it for
  // the video pass. This fixes "output produced but watermark still visible".
  async function detectAndPin() {
    if (!currentBuffer || busy) return;
    clearError();
    el.detectBtn.disabled = true;
    el.applyStatus.textContent = "Scanning first frame…";
    try {
      await ensureImageEngine();
      const { imageData, width, height } = await window.__decodeVideoFrame(currentBuffer, 0.05);
      const clone = new ImageData(new Uint8ClampedArray(imageData.data), width, height);
      const result = imageEngine.removeWatermarkAuto(clone, { logoVersion: "new" });

      debugLines.push(
        `detect: success=${result.success} confidence=${Number(result.confidence || 0).toFixed(3)} ` +
        `pos=(${result.position.x},${result.position.y}) size=${result.size}`
      );
      el.debugLog.textContent = debugLines.join("\n");

      if (!result.success || Number(result.confidence || 0) < 0.2) {
        el.applyStatus.textContent =
          "No confident detection — use 'Preview cleaned' and pin the position manually.";
        return;
      }

      const dx = Math.max(0, Math.round(width - result.position.x));
      const dy = Math.max(0, Math.round(height - result.position.y));
      el.posDx.value = dx;
      el.posDy.value = dy;
      el.pinPosition.checked = true;
      await applySettings();
      el.applyStatus.textContent =
        `Pinned at (${result.position.x},${result.position.y}), confidence ` +
        `${Number(result.confidence).toFixed(2)} — run again.`;
    } catch (err) {
      showError("Detection failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      el.detectBtn.disabled = false;
    }
  }

  function setProgress(stage, ratio) {
    el.stage.textContent = STAGE_LABELS[stage] || stage || "Working…";
    const pct = Math.round((ratio || 0) * 100);
    el.percent.textContent = pct + "%";
    el.barFill.style.width = pct + "%";
    if (stage) el.engineLog.textContent = "engine stage: " + stage;
  }

  async function run() {
    if (!currentBuffer || busy) return;
    busy = true;
    clearError();
    el.result.hidden = true;
    el.progressBox.hidden = false;
    el.runBtn.disabled = true;
    el.previewBtn.disabled = true;
    setProgress("demux", 0);

    try {
      // Re-publish current tuning so a slider change always reaches the engine,
      // even if the user forgot to click "Apply settings".
      await publishConfig();
      const blob = await window.__purifyVideo(currentBuffer, {
        onProgress: (p) => setProgress(p.stage, p.ratio),
      });
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(blob);
      el.download.href = resultUrl;
      const base = (currentFile ? currentFile.name : "video").replace(/\.[^.]+$/, "");
      el.download.download = base + "-nowatermark.mp4";
      el.resultSize.textContent = formatBytes(blob.size) + " output file";
      setProgress("done", 1);
      el.result.hidden = false;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      showError("Processing failed: " + msg +
        (msg.includes("Unsupported dimensions")
          ? " — this engine is calibrated for 720p / 1080p (16:9 or 9:16) only."
          : ""));
    } finally {
      busy = false;
      el.runBtn.disabled = false;
      el.previewBtn.disabled = false;
    }
  }

  function bindEvents() {
    el.dropzone.addEventListener("click", () => el.file.click());
    el.dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.file.click(); }
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
      const file = e.dataTransfer && e.dataTransfer.files[0];
      if (file) acceptFile(file);
    });
    el.file.addEventListener("change", (e) => acceptFile(e.target.files[0]));
    el.resetBtn.addEventListener("click", resetUI);
    el.previewBtn.addEventListener("click", previewFrame);
    el.cleanPreviewBtn.addEventListener("click", cleanPreview);
    el.detectBtn.addEventListener("click", detectAndPin);
    el.runBtn.addEventListener("click", run);
    el.applyBtn.addEventListener("click", applySettings);

    [el.opacityCustom, el.maskScale, el.baseStrength, el.ceiling].forEach((input) =>
      input.addEventListener("input", syncSliderLabels)
    );
    el.opacityMode.addEventListener("change", () => {
      el.opacityCustom.disabled = el.opacityMode.value !== "custom";
    });
  }

  (async function init() {
    captureConsole();
    syncSliderLabels();
    el.opacityCustom.disabled = el.opacityMode.value !== "custom";
    if (!checkSupport()) return;
    try {
      await publishConfig();
    } catch (err) {
      showError("Could not initialise watermark maps: " + (err && err.message ? err.message : String(err)));
      return;
    }
    bindEvents();
  })();
})();
