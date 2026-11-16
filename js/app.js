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
  async function publishConfig() {
    const [s48, s96] = await Promise.all([
      loadMask("masks/sparkle-2026-48.png", 48),
      loadMask("masks/sparkle-2026-96.png", 96),
    ]);
    const config = {
      image: { logoVersion: "new" },
      video: {
        logoVersion: "new",   // 2026 Gemini / Omni sparkle
        opacityMode: "auto",  // engine calibrates 1.0 vs 0.62 from first frames
        baseStrength: 1,
        ceiling: 0.99,
        overlayValue: 255,
        edgeMode: "auto",
        edgeStrength: 0.6,
        edgeRadius: 2,
        edgePasses: 120,
        bitrateMult: 1,
        maskScale: 1,
      },
      newMaps: { s48, s96 },
    };
    window.postMessage({ channel: "AIP_CONFIG", config }, "*");
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
    } catch (err) {
      showError("Preview failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      el.previewBtn.disabled = false;
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
    el.runBtn.addEventListener("click", run);
  }

  (async function init() {
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
