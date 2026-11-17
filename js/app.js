(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = {
    dropzone: $("dropzone"),
    file: $("file"),
    fileCard: $("fileCard"),
    fileName: $("fileName"),
    fileSize: $("fileSize"),
    fileDims: $("fileDims"),
    resetBtn: $("resetBtn"),
    batchCard: $("batchCard"),
    batchList: $("batchList"),
    batchStatus: $("batchStatus"),
    batchError: $("batchError"),
    batchOverall: $("batchOverall"),
    batchDownloadAll: $("batchDownloadAll"),
    batchClear: $("batchClear"),
    pasteBtn: $("pasteBtn"),
    pasteHint: $("pasteHint"),
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
  let previewToken = 0;   // cancels an auto-preview when a new file is loaded
  let detection = null;   // cached __erasioDetect.detect() result for this file
  let batchItems = [];
  let batchRunning = false;
  let newMaps = null;

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

  function setDims(width, height) {
    if (!width || !height) return;
    el.fileDims.textContent = width + "×" + height;
    el.fileDims.hidden = false;
  }

  // Before/after comparator: clip the cleaned layer from the left by `v`%.
  function setCompare(v) {
    const value = Math.max(0, Math.min(100, Number(v) || 0));
    el.compare.style.setProperty("--split", value + "%");
    el.compareRange.value = String(value);
  }

  function resetUI() {
    previewToken++;
    currentFile = null;
    currentBuffer = null;
    previewImage = null;
    detection = null;
    el.file.value = "";
    el.fileCard.hidden = true;
    el.fileDims.hidden = true;
    el.canvasBox.hidden = true;
    el.canvasBox.classList.remove("has-after", "preview-working");
    el.afterTag.textContent = "After";
    el.afterTag.classList.remove("working");
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
    if (typeof window.__erasioDetect !== "object") missing.push("detector");
    if (typeof VideoDecoder === "undefined" || typeof VideoEncoder === "undefined") missing.push("WebCodecs");
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") missing.push("OffscreenCanvas");
    if (missing.length) {
      showError("Missing required browser APIs: " + missing.join(", ") +
        ". Open this page in a recent Chrome or Edge over http:// (or GitHub Pages).");
      return false;
    }
    return true;
  }

  // The vendored engine calibrates position + opacity itself, exactly like the
  // extension, so all it needs is the tuning. The detector is not involved in
  // the re-encode.
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

  // ---------- settings ----------

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
    await publishConfig();
    el.applyStatus.textContent = "Applied.";
    detection = null; // pin/size may have changed
  }

  function readSettings() {
    settings.opacityMode = "auto";
    settings.baseStrength = Number(el.strength.value);
    settings.edgeMode = el.edgeMode.value;
    settings.edgeStrength = Number(el.cleanup.value);
  }

  async function acceptFile(file) {
    if (!file) return;
    if (!/\.mp4$/i.test(file.name) && file.type !== "video/mp4") {
      showError("Please choose an MP4 file.");
      return;
    }
    clearError();
    const token = ++previewToken;
    currentFile = file;
    detection = null;
    previewImage = null;
    currentBuffer = await file.arrayBuffer();
    if (token !== previewToken) return; // a newer file was selected meanwhile
    el.fileName.textContent = file.name;
    el.fileSize.textContent = formatBytes(file.size);
    el.fileDims.hidden = true;
    el.fileCard.hidden = false;
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
    el.canvasBox.classList.remove("has-after");
    el.compareHint.textContent = box
      ? "Teal box marks the watermark being reversed. Run “Preview cleaned” to compare."
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
      const frame = await window.__decodeVideoFrame(currentBuffer, 0.05);
      previewImage = frame.imageData;
      setDims(frame.width, frame.height);
      const box = detection && detection.logo
        ? { x: detection.logo.x, y: detection.logo.y, w: detection.logo.side, h: detection.logo.side }
        : null;
      paintBefore(previewImage, box);
      dbg(`preview: ${frame.width}x${frame.height}` + (detection ? "" : " (run Detect for a box)"));
    } catch (err) {
      showError("Preview failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      el.previewBtn.disabled = false;
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
      el.detectStatus.hidden = false;
      el.detectStatus.className = "status";
      el.detectStatus.textContent = "Scanning frames…";
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
          if (!quiet) el.detectStatus.textContent = `Scanning frames… ${Math.round(r * 100)}%`;
        },
      });
      if (token && token !== previewToken) return null; // a newer file was dropped
      detection = d;
      setDims(d.width, d.height);
      for (const note of d.notes || []) dbg("detect · " + note);
      dbg(`detect: ${d.width}x${d.height} — ${d.reason}`);

      let text = describeDetection(d) || "no template matched";
      if (d.chosen === "veo") text = "Veo wordmark found — " + text;
      else if (d.chosen === "diamond") text = "Watermark found — " + text;
      else text = "Nothing found — " + text;

      el.detectStatus.hidden = false;
      el.detectStatus.textContent = text;
      el.detectStatus.className = "status " + (d.chosen ? "ok" : "warn");

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
  function showCleanPreview(candidate) {
    const clone = new ImageData(new Uint8ClampedArray(previewImage.data), previewImage.width, previewImage.height);
    const out = window.__erasioInpaintFrame(clone, candidate);

    paintBefore(previewImage, candidateBox(candidate));
    el.cleanPreview.width = out.width;
    el.cleanPreview.height = out.height;
    el.cleanPreview.getContext("2d").putImageData(out, 0, 0);

    el.canvasBox.classList.add("has-after");
    endWorking();
    el.canvasBox.hidden = false;
    setCompare(50);
    el.compareHint.textContent = "Drag the handle to compare before and after.";
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
      const frame = await window.__decodeVideoFrame(currentBuffer, 0.05);
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
      showCleanPreview(candidate);
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
        const frame = await window.__decodeVideoFrame(currentBuffer, 0.05);
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
      showCleanPreview(candidate);
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
          ` strength=${settings.baseStrength.toFixed(2)} edge=${settings.edgeMode}`);
        blob = await window.__purifyVideo(currentBuffer, {
          onProgress: ({ stage, ratio }) => setProgress(stage, ratio),
        });
        if (info.box) dbg(`box: ${info.box.w}px at ${info.box.x},${info.box.y}`);
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

  // ---------- bulk processing ----------

  function showBatchError(message) {
    el.batchError.textContent = message || "";
    el.batchError.hidden = !message;
  }

  function outputName(item) {
    return item.name.replace(/\.[^.]+$/, "") + "-nowatermark.mp4";
  }

  function acceptFiles(files) {
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
    resetUI(); // hide the single-file editor and its stale preview
    el.batchCard.hidden = false;
    showBatchError("");
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
      status.textContent = item.statusText ||
        ({ queued: "Queued", working: "Working", done: "Done", error: "Failed" })[item.status];
      const size = document.createElement("span");
      size.textContent = formatBytes(item.size);
      sub.append(status, document.createTextNode("·"), size);
      const barBox = document.createElement("div");
      barBox.className = "batch-bar";
      barBox.hidden = item.status !== "working";
      const barFill = document.createElement("div");
      barBox.appendChild(barFill);
      info.append(name, sub, barBox);

      const link = document.createElement("a");
      link.className = "btn sm batch-dl";
      link.textContent = "Download";
      link.download = outputName(item);
      link.hidden = item.status !== "done" || !item.url;
      if (item.url) link.href = item.url;

      row.append(icon, info, link);
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
    if (item.rowEl) {
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
    item.barBox.hidden = false;
    item.barFill.style.width = Math.round(Math.max(0, Math.min(1, ratio || 0)) * 100) + "%";
  }

  function updateBatchSummary() {
    if (!batchItems.length) {
      el.batchStatus.textContent = "No files queued.";
      el.batchOverall.style.width = "0%";
      el.batchDownloadAll.disabled = true;
      el.batchClear.disabled = false;
      return;
    }
    const total = batchItems.length;
    const done = batchItems.filter((i) => i.status === "done").length;
    const failed = batchItems.filter((i) => i.status === "error").length;
    const active = batchItems.find((i) => i.status === "working");
    el.batchOverall.style.width = Math.round(((done + failed) / total) * 100) + "%";
    el.batchDownloadAll.disabled = done === 0;
    el.batchClear.disabled = batchRunning;
    el.batchStatus.textContent = active
      ? `Processing ${batchItems.indexOf(active) + 1} of ${total}: ${active.name}`
      : batchRunning
        ? `Starting next file… (${done + failed}/${total} finished)`
        : `Finished — ${done} cleaned, ${failed} failed out of ${total}.`;
  }

  async function processBatchItem(item) {
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
      if (item.linkEl) {
        item.linkEl.hidden = false;
        item.linkEl.href = item.url;
        item.linkEl.download = outputName(item);
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      item.error = msg;
      setRowStatus(item, "error", msg.length > 90 ? msg.slice(0, 90) + "…" : msg);
      dbg(`batch ${item.name} FAILED: ${msg}`);
    }
  }

  async function runBatch() {
    if (batchRunning) return;
    batchRunning = true;
    updateBatchSummary();
    try {
      while (true) {
        const item = batchItems.find((i) => i.status === "queued");
        if (!item) break;
        await processBatchItem(item);
      }
    } finally {
      batchRunning = false;
      updateBatchSummary();
    }
  }

  function clearBatch() {
    if (batchRunning) return;
    for (const item of batchItems) if (item.url) URL.revokeObjectURL(item.url);
    batchItems = [];
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
    el.pasteHint.textContent =
      "No MP4 on the clipboard. Browsers only expose images/text from a copied file — drop the MP4 or use Browse instead.";
  }

  function bindEvents() {
    document.addEventListener("paste", onPaste);
    el.pasteBtn.addEventListener("click", pasteFromClipboard);
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
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) acceptFiles(files);
    });
    el.file.addEventListener("change", (e) => {
      acceptFiles(e.target.files);
      e.target.value = ""; // allow picking the same file(s) again
    });
    el.batchDownloadAll.addEventListener("click", downloadAll);
    el.batchClear.addEventListener("click", clearBatch);
    el.resetBtn.addEventListener("click", resetUI);
    el.previewBtn.addEventListener("click", previewFrame);
    el.detectBtn.addEventListener("click", () => detectWatermark(false));
    el.cleanPreviewBtn.addEventListener("click", cleanPreview);
    el.runBtn.addEventListener("click", run);
    el.applyBtn.addEventListener("click", applySettings);
    el.compareRange.addEventListener("input", () => setCompare(el.compareRange.value));
    [el.strength, el.cleanup].forEach((input) => input.addEventListener("input", syncLabels));
    el.edgeMode.addEventListener("change", syncLabels);
    el.engineMode.addEventListener("change", () => {
      detection = null;
      el.applyStatus.textContent = "";
    });
  }

  (async function init() {
    captureConsole();
    syncLabels();
    setCompare(50);
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
