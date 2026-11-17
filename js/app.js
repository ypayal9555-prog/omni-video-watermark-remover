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
    detectBtn: $("detectBtn"),
    cleanPreviewBtn: $("cleanPreviewBtn"),
    cleanPreview: $("cleanPreview"),
    runBtn: $("runBtn"),
    canvasBox: $("canvasBox"),
    canvas: $("preview"),
    detectStatus: $("detectStatus"),
    progressBox: $("progressBox"),
    stage: $("stage"),
    percent: $("percent"),
    barFill: $("barFill"),
    engineLog: $("engineLog"),
    result: $("result"),
    download: $("download"),
    resultSize: $("resultSize"),
    error: $("error"),
    engineMode: $("engineMode"),
    strength: $("strength"),
    strengthVal: $("strengthVal"),
    cleanup: $("cleanup"),
    cleanupVal: $("cleanupVal"),
    pinPosition: $("pinPosition"),
    posDx: $("posDx"),
    posDy: $("posDy"),
    posSize: $("posSize"),
    forceRun: $("forceRun"),
    applyBtn: $("applyBtn"),
    applyStatus: $("applyStatus"),
    debugLog: $("debugLog"),
  };

  const STAGE_LABELS = {
    detect: "Scanning frames for the watermark…",
    demux: "Reading video…",
    analyze: "Locating the watermark…",
    process: "Erasing watermark, frame by frame…",
    mux: "Packaging the clean video…",
    done: "Finishing…",
  };

  let currentFile = null;
  let currentBuffer = null;
  let resultUrl = null;
  let previewImage = null;
  let busy = false;
  let detection = null;   // cached __erasioDetect.detect() result for this file

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

  function dbg(line) {
    debugLines.push(line);
    if (debugLines.length > 40) debugLines.shift();
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

  function resetUI() {
    currentFile = null;
    currentBuffer = null;
    previewImage = null;
    detection = null;
    el.file.value = "";
    el.fileCard.hidden = true;
    el.canvasBox.hidden = true;
    el.detectStatus.hidden = true;
    el.progressBox.hidden = true;
    el.result.hidden = true;
    clearError();
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      resultUrl = null;
    }
  }

  function checkSupport() {
    const missing = [];
    if (typeof MP4Box === "undefined") missing.push("MP4Box");
    if (typeof Mp4Muxer === "undefined") missing.push("Mp4Muxer");
    if (typeof window.__purifyVideo !== "function") missing.push("video engine");
    if (typeof window.__purifyVeoVideo !== "function") missing.push("Veo engine");
    if (typeof VideoDecoder === "undefined" || typeof VideoEncoder === "undefined") missing.push("WebCodecs");
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") missing.push("OffscreenCanvas");
    if (missing.length) {
      showError("Missing required browser APIs: " + missing.join(", ") +
        ". Open this page in a recent Chrome or Edge over http:// (or GitHub Pages).");
      return false;
    }
    return true;
  }

  // The engine keeps a copy of the side panel's video tuning. The detector path
  // sets position/opacity itself, but the tuning still drives the engine's
  // non-detector fallback, so keep it in sync.
  let masks = null;

  async function publishConfig() {
    if (!masks) masks = await window.__erasioDetect.loadMaps();
    const config = {
      image: { logoVersion: "new" },
      video: { ...settings },
      newMaps: masks,
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
  }

  function readSettings() {
    settings.opacityMode = "auto";
    settings.baseStrength = Number(el.strength.value);
    settings.edgeStrength = Number(el.cleanup.value);
    settings.edgeMode = Number(el.cleanup.value) > 0 ? "on" : "off";
    settings.maskPosition = el.pinPosition.checked
      ? { mode: "pinned", dx: Number(el.posDx.value), dy: Number(el.posDy.value) }
      : null;
  }

  async function applySettings() {
    readSettings();
    await publishConfig();
    el.applyStatus.textContent = "Applied.";
    detection = null; // pin/size may have changed
  }

  async function acceptFile(file) {
    if (!file) return;
    if (!/\.mp4$/i.test(file.name) && file.type !== "video/mp4") {
      showError("Please choose an MP4 file.");
      return;
    }
    clearError();
    currentFile = file;
    detection = null;
    previewImage = null;
    currentBuffer = await file.arrayBuffer();
    el.fileName.textContent = file.name;
    el.fileSize.textContent = formatBytes(file.size);
    el.fileCard.hidden = false;
    el.canvasBox.hidden = true;
    el.detectStatus.hidden = true;
    el.progressBox.hidden = true;
    el.result.hidden = true;
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
    el.canvasBox.hidden = false;
  }

  async function previewFrame() {
    if (!currentBuffer || busy) return;
    clearError();
    el.previewBtn.disabled = true;
    try {
      const frame = await window.__decodeVideoFrame(currentBuffer, 0.05);
      previewImage = frame.imageData;
      paintBefore(previewImage, detection && detection.chosen === "diamond" && detection.diamond
        ? { x: detection.diamond.x, y: detection.diamond.y, w: detection.diamond.side, h: detection.diamond.side }
        : null);
      dbg(`preview: ${frame.width}x${frame.height}` + (detection ? "" : " (run Detect for a box)"));
    } catch (err) {
      showError("Preview failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      el.previewBtn.disabled = false;
    }
  }

  // ---------- detection ----------

  function candidateFromPin(width, height) {
    const det = detection && detection.diamond;
    const side = Math.max(8, Math.min(
      Math.round(Number(el.posSize.value) || (det ? det.side : 48)),
      Math.min(width, height)
    ));
    // dx/dy are the mark's inset from the right/bottom frame edge, i.e. the
    // gap between the corner and the watermark itself — the number the Gemini
    // docs quote. The mask's top-left is that inset back from the corner.
    const dx = Math.max(0, Math.round(Number(el.posDx.value)));
    const dy = Math.max(0, Math.round(Number(el.posDy.value)));
    const x = Math.max(0, Math.min(width - side, width - dx - side));
    const y = Math.max(0, Math.min(height - side, height - dy - side));
    return window.__erasioDetect.buildDiamondCandidate(
      { x, y, side, gain: det && det.gain != null ? det.gain : 1 },
      width, height,
      { maps: masks, cleanup: Number(el.cleanup.value), strength: Number(el.strength.value) }
    );
  }

  function diamondCandidate(width, height) {
    if (el.pinPosition.checked) return candidateFromPin(width, height);
    if (!detection || !detection.diamond) return null;
    // Only trust a position the scorer actually accepted. The best-scoring
    // spot on a clip with NO mark is still a spot — painting it would punch a
    // hole in clean footage. Explicit "Diamond only" / force-run are overrides.
    const trusted = detection.chosen === "diamond";
    const override = el.engineMode.value === "diamond" || el.forceRun.checked;
    if (!trusted && !override) return null;
    return window.__erasioDetect.buildDiamondCandidate(
      detection.diamond, width, height,
      { maps: masks, cleanup: Number(el.cleanup.value) }
    );
  }

  function describeDetection(d) {
    const bits = [];
    if (d.diamond) {
      bits.push(`diamond NCC ${d.diamond.ncc.toFixed(2)} at ${d.diamond.x},${d.diamond.y} ` +
        `(${d.diamond.side}px` + (d.diamond.alpha != null ? `, alpha ${d.diamond.alpha.toFixed(2)}` : "") + ")");
    }
    if (d.veo) {
      bits.push(`Veo NCC ${d.veo.ncc.toFixed(2)} at ${d.veo.x},${d.veo.y} (${d.veo.templateId})`);
    }
    return bits.join(" · ");
  }

  async function detectWatermark(quiet) {
    if (!currentBuffer) return null;
    clearError();
    if (!quiet) {
      el.detectBtn.disabled = true;
      el.detectStatus.hidden = false;
      el.detectStatus.textContent = "Scanning frames…";
    }
    try {
      const d = await window.__erasioDetect.detect(currentBuffer, {
        maps: masks,
        onProgress: (r) => { if (!quiet) el.detectStatus.textContent = `Scanning frames… ${Math.round(r * 100)}%`; },
      });
      detection = d;
      dbg(`detect: ${d.width}x${d.height} — ${describeDetection(d)}`);

      let text = describeDetection(d) || "no template matched";
      if (d.chosen === "veo") text = "Veo wordmark found — " + text;
      else if (d.chosen === "diamond") text = "Diamond found — " + text;
      else text = "Nothing found — " + text;

      el.detectStatus.hidden = false;
      el.detectStatus.textContent = text;
      el.detectStatus.className = "status " + (d.chosen ? "ok" : "warn");

      if (d.diamond) {
        el.posSize.value = d.diamond.side;
        el.posDx.value = d.width - (d.diamond.x + d.diamond.side);
        el.posDy.value = d.height - (d.diamond.y + d.diamond.side);
      }
      if (!quiet && previewImage) {
        const box = d.chosen === "diamond" && d.diamond
          ? { x: d.diamond.x, y: d.diamond.y, w: d.diamond.side, h: d.diamond.side }
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

  // ---------- clean preview ----------

  async function cleanPreview() {
    if (!currentBuffer || busy) return;
    clearError();
    el.cleanPreviewBtn.disabled = true;
    try {
      if (!previewImage) {
        const frame = await window.__decodeVideoFrame(currentBuffer, 0.05);
        previewImage = frame.imageData;
      }
      if (!detection || !detection.chosen) await detectWatermark(true);
      const mode = el.engineMode.value;
      if (mode === "veo" || (mode === "auto" && detection && detection.chosen === "veo")) {
        showError("The Veo wordmark preview is not available yet — run the removal to check it.");
        return;
      }
      const candidate = diamondCandidate(previewImage.width, previewImage.height);
      if (!candidate) {
        showError("No diamond position to preview. Run Detect first, or pin the position manually.");
        return;
      }
      candidate.baseStrength *= Number(el.strength.value);

      const clone = new ImageData(new Uint8ClampedArray(previewImage.data), previewImage.width, previewImage.height);
      const out = window.__erasioInpaintFrame(clone, candidate);

      paintBefore(previewImage, { x: candidate.x, y: candidate.y, w: candidate.alphaMap.width, h: candidate.alphaMap.height });
      el.cleanPreview.width = out.width;
      el.cleanPreview.height = out.height;
      el.cleanPreview.getContext("2d").putImageData(out, 0, 0);

      dbg(`preview clean: pos=(${candidate.x},${candidate.y}) box=${candidate.alphaMap.width}px ` +
        `gain=${candidate.baseStrength.toFixed(2)} cleanup=${el.cleanup.value}`);
    } catch (err) {
      showError("Clean preview failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      el.cleanPreviewBtn.disabled = false;
    }
  }

  // ---------- run ----------

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
    el.detectBtn.disabled = true;
    setProgress("detect", 0);

    try {
      readSettings();
      await publishConfig();

      if (!detection) {
        const d = await detectWatermark(true);
        // A failed detection must not block the manual paths: the whole point
        // of pinning a position (or forcing a run) is to clean a clip the
        // scorer isn't sure about.
        if (!d && !el.pinPosition.checked && !el.forceRun.checked) {
          throw new Error("no watermark detected — nothing was re-encoded. " +
            "Use Preview cleaned to check the box, pin the position manually, or tick " +
            "\"Run even if nothing is detected\".");
        }
      }

      const mode = el.engineMode.value;
      const chosen = detection ? detection.chosen : null;
      const useVeo = mode === "veo" || (mode === "auto" && chosen === "veo");
      const diamondRequested = mode === "diamond" || (mode === "auto" && chosen === "diamond");
      const useDiamond = !useVeo &&
        (diamondRequested || el.pinPosition.checked || el.forceRun.checked);

      if (!useVeo && !useDiamond) {
        throw new Error("no watermark detected — nothing was re-encoded. Use Preview " +
          "cleaned to check the box, pin the position manually, or tick " +
          "\"Run even if nothing is detected\".");
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
              "\"Diamond only\" if it is a Gemini/Omni diamond video.");
          }
          throw err;
        }
      } else {
        // Detection carries the clip size; when it failed, take it from a frame.
        let width = detection && detection.width;
        let height = detection && detection.height;
        if (!width || !height) {
          const frame = await window.__decodeVideoFrame(currentBuffer, 0.05);
          width = frame.width;
          height = frame.height;
        }
        const candidate = diamondCandidate(width, height);
        if (!candidate) throw new Error("no diamond candidate — run Detect or pin the position");
        candidate.baseStrength *= Number(el.strength.value);
        dbg(`engine: diamond pos=(${candidate.x},${candidate.y}) box=${candidate.alphaMap.width}px ` +
          `gain=${candidate.baseStrength.toFixed(2)}`);
        blob = await window.__purifyVideo(currentBuffer, {
          detector: () => candidate,
          detectorLabel: "diamond",
          onProgress: ({ stage, ratio }) => setProgress(stage, ratio),
        });
      }

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
      el.detectBtn.disabled = false;
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
    el.detectBtn.addEventListener("click", () => detectWatermark(false));
    el.cleanPreviewBtn.addEventListener("click", cleanPreview);
    el.runBtn.addEventListener("click", run);
    el.applyBtn.addEventListener("click", applySettings);
    [el.strength, el.cleanup].forEach((input) => input.addEventListener("input", syncLabels));
    el.engineMode.addEventListener("change", () => {
      detection = null;
      el.applyStatus.textContent = "";
    });
  }

  (async function init() {
    captureConsole();
    syncLabels();
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
