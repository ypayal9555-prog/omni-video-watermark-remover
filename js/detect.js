// Watermark detection for the two marks Google puts on generated videos:
//
//   1. The Gemini 3.5 / 2026 "diamond" (the four-point star already calibrated
//      in masks/sparkle-2026-48.png / -96.png). It is NOT always at the same
//      corner inset: Google moved it around between model versions and between
//      landscape/portrait renders, which is exactly why a fixed-offset pass can
//      produce an "output but the watermark is still there" clip.
//   2. The "Veo" wordmark that Flow (and Gemini's video tab) stamps in the
//      bottom-right corner. It has a completely different shape, so the
//      diamond mask can never remove it â€” it needs the templates in
//      vendor/veoTextTemplates.js.
//
// Everything here is template matching over a coarse-to-fine image pyramid.
// The result is a candidate in the shape videoProcessor's inpaintFrame() wants:
//   { x, y, alphaMap, baseStrength, opacity, overlayValue, ceiling, edgeCleanup }
//
// Detection never guesses silently: if neither mark correlates, the caller gets
// the scores and can refuse to re-encode a clip it would not actually clean.
(function () {
  "use strict";

  const ACTIVE = 0.06;          // mask pixels below this are ignored
  const MIN_DIAMOND_NCC = 0.32; // ~0 = uncorrelated, 1 = perfect shape match
  const MIN_VEO_NCC = 0.60;     // matches the upstream Veo detector's 0.62 gate
  const CLEANUP_PAD = 10;       // zero-alpha ring so edge diffusion has clean neighbours

  // ---------- small helpers ----------

  function lumaAt(data, o) {
    return 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
  }

  function median(values) {
    if (!values.length) return NaN;
    const s = values.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  function toGray(imageData) {
    const { data, width, height } = imageData;
    const out = new Float32Array(width * height);
    for (let i = 0, o = 0; i < out.length; i++, o += 4) {
      out[i] = (0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]) / 255;
    }
    return out;
  }

  // Box-filtered downsample. Non-integer factors are fine.
  function downsample(gray, w, h, f) {
    const gw = Math.floor(w / f), gh = Math.floor(h / f);
    const out = new Float32Array(gw * gh);
    const inv = 1 / (f * f);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let sum = 0;
        for (let dy = 0; dy < f; dy++) {
          const row = (y * f + dy) * w + x * f;
          for (let dx = 0; dx < f; dx++) sum += gray[row + dx];
        }
        out[y * gw + x] = sum * inv;
      }
    }
    return { gray: out, w: gw, h: gh };
  }

  // Bilinear resize of a square alpha map.
  function resizeMask(values, from, to) {
    if (from === to) return values;
    const out = new Float32Array(to * to);
    const step = (from - 1) / Math.max(1, to - 1);
    for (let y = 0; y < to; y++) {
      const sy = y * step, y0 = Math.floor(sy), y1 = Math.min(from - 1, y0 + 1), fy = sy - y0;
      for (let x = 0; x < to; x++) {
        const sx = x * step, x0 = Math.floor(sx), x1 = Math.min(from - 1, x0 + 1), fx = sx - x0;
        const a00 = values[y0 * from + x0], a10 = values[y0 * from + x1];
        const a01 = values[y1 * from + x0], a11 = values[y1 * from + x1];
        out[y * to + x] =
          a00 * (1 - fx) * (1 - fy) + a10 * fx * (1 - fy) +
          a01 * (1 - fx) * fy + a11 * fx * fy;
      }
    }
    return out;
  }

  // Pre-computed statistics for the mask's active pixels.
  function maskStats(values, side) {
    const idx = [], wts = [];
    let sum = 0, sumSq = 0;
    for (let i = 0; i < values.length; i++) {
      const a = values[i];
      if (a <= ACTIVE) continue;
      idx.push(i); wts.push(a);
      sum += a; sumSq += a * a;
    }
    return {
      side,
      values,
      idx: Int32Array.from(idx),
      wts: Float32Array.from(wts),
      sum, sumSq,
      n: idx.length,
    };
  }

  // Zero-mean NCC between the mask and the frame region, over the mask's
  // active pixels only. Range -1..1; ~+1 means "the shape is here".
  function nccAt(gray, gw, gh, st, x, y) {
    const s = st.side, n = st.n;
    if (n < 8) return -1;
    if (x < 0 || y < 0 || x + s > gw || y + s > gh) return -1;
    const idx = st.idx, wts = st.wts;
    let sP = 0, sG = 0, sG2 = 0;
    for (let k = 0; k < n; k++) {
      const o = idx[k];
      const r = (o / s) | 0;
      const g = gray[(y + r) * gw + x + (o - r * s)];
      const a = wts[k];
      sP += a * g; sG += g; sG2 += g * g;
    }
    const mA = st.sum / n, mG = sG / n;
    const dA = st.sumSq / n - mA * mA;
    const dG = sG2 / n - mG * mG;
    if (dA <= 1e-9 || dG <= 1e-9) return -1;
    return (sP / n - mA * mG) / Math.sqrt(dA * dG);
  }

  function meanNccAt(grays, w, h, st, x, y) {
    let sum = 0;
    for (const g of grays) sum += nccAt(g, w, h, st, x, y);
    return sum / grays.length;
  }

  // ---------- diamond (Gemini 3.5 / Omni) ----------

  function resolveBaseMaps(maps, w, h) {
    const is1080 = Math.min(w, h) >= 1080 || w >= 1920;
    return is1080 ? { base: maps.s96.values, side: maps.s96.side } : { base: maps.s48.values, side: maps.s48.side };
  }

  function diamondSizes(baseSide) {
    const k = [0.88, 0.94, 1.0, 1.06, 1.15, 1.3, 1.5];
    const out = [];
    for (const f of k) {
      const s = Math.round(baseSide * f);
      if (s >= 24 && !out.includes(s)) out.push(s);
    }
    return out;
  }

  function detectDiamond(frameList, maps) {
    const w = frameList[0].width, h = frameList[0].height;
    const minDim = Math.min(w, h);
    const { base, side: baseSide } = resolveBaseMaps(maps, w, h);
    const sizes = diamondSizes(baseSide);
    const maxInset = Math.round(Math.min(400, minDim * 0.55));

    const F = 4;
    const grays = frameList.map(toGray);
    const small = grays.map((g) => downsample(g, w, h, F));
    const gw = small[0].w, gh = small[0].h;

    // ---- coarse pass: every size, whole bottom-right quadrant ----
    const perSize = [];
    for (const side of sizes) {
      const side4 = Math.max(5, Math.round(side / F));
      const st = maskStats(resizeMask(base, baseSide, side4), side4);
      if (st.n < 10) continue;

      const xEnd = gw - side4, yEnd = gh - side4;
      const xStart = Math.max(0, gw - Math.ceil(maxInset / F) - side4);
      const yStart = Math.max(0, gh - Math.ceil(maxInset / F) - side4);
      if (xEnd < xStart || yEnd < yStart) continue;

      let best = { ncc: -2, x: xStart * F, y: yStart * F };
      for (let y = yStart; y <= yEnd; y++) {
        for (let x = xStart; x <= xEnd; x++) {
          let sum = 0;
          for (const s of small) sum += nccAt(s.gray, gw, gh, st, x, y);
          const v = sum / small.length;
          if (v > best.ncc) best = { ncc: v, x: x * F, y: y * F };
        }
      }
      perSize.push({ side, ncc: best.ncc, x: best.x, y: best.y });
    }

    if (!perSize.length) return null;
    perSize.sort((a, b) => b.ncc - a.ncc);

    // ---- refine pass: 1-px position + Â±3 px size around the coarse winner ----
    let best = { ncc: -2, side: sizes[0], x: 0, y: 0 };
    for (const cand of perSize.slice(0, 2)) {
      for (let side = Math.max(20, cand.side - 3); side <= cand.side + 3; side++) {
        const st = maskStats(resizeMask(base, baseSide, side), side);
        if (st.n < 10) continue;
        for (let dy = -5; dy <= 5; dy++) {
          for (let dx = -5; dx <= 5; dx++) {
            const x = cand.x + dx, y = cand.y + dy;
            let sum = 0;
            for (const g of grays) sum += nccAt(g, w, h, st, x, y);
            const v = sum / grays.length;
            if (v > best.ncc) best = { ncc: v, side, x, y };
          }
        }
      }
    }

    return {
      ...best,
      perSize: perSize.map((p) => ({ side: p.side, ncc: +p.ncc.toFixed(3) })),
    };
  }

  // How opaque is the mark in THIS clip? The calibrated map is a shape; the
  // alpha Google actually stamped varies per model/version. Solving
  //   L = alpha*255 + (1-alpha)*B
  // over the mark's core against a ring of clean background gives the real
  // peak alpha, so the reverse blend subtracts the right amount instead of
  // leaving a ghost (too low) or a dark hole (too high).
  function estimatePeakAlpha(frameList, det, base, baseSide) {
    const s = det.side;
    const map = resizeMask(base, baseSide, s);
    let peak = 0;
    for (const v of map) if (v > peak) peak = v;
    if (peak <= 0.02) return null;

    const core = [];
    for (let i = 0; i < map.length; i++) if (map[i] >= peak * 0.85) core.push(i);
    if (core.length < 6) return null;

    const W = frameList[0].width, H = frameList[0].height;
    const samples = [];
    for (const frame of frameList) {
      const d = frame.data;
      const ring = [];
      for (let dy = -9; dy < s + 9; dy++) {
        for (let dx = -9; dx < s + 9; dx++) {
          if (dx >= 0 && dx < s && dy >= 0 && dy < s) continue;
          const px = det.x + dx, py = det.y + dy;
          if (px < 0 || py < 0 || px >= W || py >= H) continue;
          ring.push(lumaAt(d, (py * W + px) * 4));
        }
      }
      const B = median(ring);
      if (!Number.isFinite(B) || B >= 250 || B <= 2) continue;
      for (const i of core) {
        const r = (i / s) | 0, c = i - r * s;
        const L = lumaAt(d, ((det.y + r) * W + det.x + c) * 4);
        const rel = map[i] / peak;
        if (rel < 0.85) continue;
        const a = (L - B) / ((255 - B) * rel);
        if (a > -0.15 && a < 1.05) samples.push(a);
      }
    }
    if (samples.length < 12) return null;
    return median(samples);
  }

  // ---------- Veo wordmark ----------

  function correlate(imageData, template, x, y, w, h) {
    if (x < 0 || y < 0 || x + w > imageData.width || y + h > imageData.height) return 0;
    const d = imageData.data;
    let imageSum = 0, templateSum = 0, count = 0;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const t = template[row * w + col] || 0;
        if (Math.abs(t) <= 0.02) continue;
        imageSum += lumaAt(d, ((y + row) * imageData.width + x + col) * 4);
        templateSum += t;
        count++;
      }
    }
    if (count <= 1) return 0;
    const imageMean = imageSum / count, templateMean = templateSum / count;
    let num = 0, ie = 0, te = 0;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const t = template[row * w + col] || 0;
        if (Math.abs(t) <= 0.02) continue;
        const di = lumaAt(d, ((y + row) * imageData.width + x + col) * 4) - imageMean;
        const dt = t - templateMean;
        num += di * dt; ie += di * di; te += dt * dt;
      }
    }
    const den = Math.sqrt(ie * te);
    return den > 0 ? num / den : 0;
  }

  function detectVeo(frameList) {
    const tpl = window.__erasioVeoTextTemplates;
    if (!tpl) return null;
    const w = frameList[0].width, h = frameList[0].height;
    let best = null;
    for (const t of tpl.getTemplates()) {
      if (t.width > w || t.height > h) continue;
      const radius = Math.max(4, Math.round(Math.min(t.width, t.height) * 0.35));
      for (let mr = t.marginRight - radius; mr <= t.marginRight + radius; mr++) {
        for (let mb = t.marginBottom - radius; mb <= t.marginBottom + radius; mb++) {
          const x = w - mr - t.width, y = h - mb - t.height;
          if (x < 0 || y < 0) continue;
          let sum = 0;
          for (const f of frameList) sum += correlate(f, t.detectorMap, x, y, t.width, t.height);
          const mean = sum / frameList.length;
          if (!best || mean > best.ncc) {
            best = { ncc: mean, templateId: t.id, x, y, width: t.width, height: t.height, side: t.width };
          }
        }
      }
    }
    return best;
  }

  // ---------- candidate construction ----------

  // Pad with a zero ring so the engine's edge diffusion has clean neighbours on
  // every side (the diamond's points touch its bounding box, the wordmark fills
  // its box almost edge to edge).
  function paddedCandidate({ x, y, map, side, frameW, frameH, gain, cleanup, overlay }) {
    const padL = Math.min(CLEANUP_PAD, x);
    const padT = Math.min(CLEANUP_PAD, y);
    const padR = Math.min(CLEANUP_PAD, Math.max(0, frameW - (x + side)));
    const padB = Math.min(CLEANUP_PAD, Math.max(0, frameH - (y + side)));
    const pw = padL + side + padR, ph = padT + side + padB;
    const padded = new Float32Array(pw * ph);
    for (let r = 0; r < side; r++) {
      for (let c = 0; c < side; c++) padded[(r + padT) * pw + (c + padL)] = map[r * side + c];
    }
    const cand = {
      x: x - padL,
      y: y - padT,
      alphaMap: { values: padded, colorValues: undefined, width: pw, height: ph },
      baseStrength: gain,
      opacity: 1,
      overlayValue: overlay != null ? overlay : 255,
      ceiling: 0.99,
      score: 0,
    };
    if (cleanup > 0) cand.edgeCleanup = { strength: cleanup, radius: 2 };
    return cand;
  }

  function buildDiamondCandidate(det, frameW, frameH, opts) {
    opts = opts || {};
    const { base, side: baseSide } = resolveBaseMaps(opts.maps, frameW, frameH);
    const side = det.side;
    const map = resizeMask(base, baseSide, side);
    return paddedCandidate({
      x: det.x, y: det.y, map, side, frameW, frameH,
      gain: det.gain != null ? det.gain : 1,
      cleanup: opts.cleanup != null ? opts.cleanup : 0.6,
      overlay: opts.overlay,
    });
  }

  // ---------- public entry ----------

  // Resolve assets relative to THIS script, not the page: the app lives at the
  // repo root and the test harnesses live in /test, so a page-relative "masks/"
  // would 404 in one of the two places.
  const ASSET_BASE = (() => {
    const s = document.currentScript;
    if (s && s.src) return new URL("../masks/", s.src).href;
    return new URL("masks/", location.href).href;
  })();

  let mapsPromise = null;
  async function loadMaps() {
    if (!mapsPromise) {
      mapsPromise = (async () => {
        const load = async (name, size) => {
          const url = ASSET_BASE + name;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Cannot load ${url} (HTTP ${res.status})`);
          const bmp = await createImageBitmap(await res.blob());
          const cvs = new OffscreenCanvas(size, size);
          const ctx = cvs.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(bmp, 0, 0, size, size);
          bmp.close();
          const px = ctx.getImageData(0, 0, size, size).data;
          const values = new Float32Array(size * size);
          for (let i = 0; i < values.length; i++) {
            values[i] = Math.max(px[4 * i], px[4 * i + 1], px[4 * i + 2]) / 255;
          }
          return { values, side: size };
        };
        const [s48, s96] = await Promise.all([
          load("sparkle-2026-48.png", 48),
          load("sparkle-2026-96.png", 96),
        ]);
        return { s48, s96 };
      })();
    }
    return mapsPromise;
  }

  /**
   * Decode a few frames and score both marks.
   *
   * @returns {{
   *   width:number, height:number,
   *   diamond: {ncc:number,x:number,y:number,side:number,gain:number|null,alpha:number|null,perSize:Array},
   *   veo: {ncc:number,x:number,y:number,templateId:string,width:number,height:number}|null,
   *   chosen: "diamond"|"veo"|null,
   *   reason: string,
   * }}
   */
  async function detect(buffer, opts) {
    opts = opts || {};
    const maps = opts.maps || await loadMaps();
    const fractions = opts.fractions || [0.15, 0.35, 0.55, 0.75];
    const decoded = await window.__decodeVideoFrames(buffer, fractions, opts.onProgress);
    const frameList = decoded.map((f) => f.imageData);
    if (!frameList.length) throw new Error("Could not decode any frame for detection");
    const width = decoded[0].width, height = decoded[0].height;

    const det = detectDiamond(frameList, maps);
    if (det) {
      const { base, side } = resolveBaseMaps(maps, width, height);
      const alpha = estimatePeakAlpha(frameList, det, base, side);
      det.alpha = alpha;
      det.gain = alpha != null ? alpha / Math.max(1e-6, peakOf(base, side, det.side)) : null;
    }

    const veo = detectVeo(frameList);

    const diamondOk = det && det.ncc >= MIN_DIAMOND_NCC;
    const veoOk = veo && veo.ncc >= MIN_VEO_NCC;

    let chosen = null, reason = "";
    if (veoOk && (!diamondOk || veo.ncc >= det.ncc - 0.03)) {
      chosen = "veo";
      reason = `Veo wordmark matched (NCC ${veo.ncc.toFixed(2)})` +
        (diamondOk ? `, stronger than the diamond (${det.ncc.toFixed(2)})` : "");
    } else if (diamondOk) {
      chosen = "diamond";
      reason = `Diamond matched (NCC ${det.ncc.toFixed(2)} at ${det.x},${det.y}, ${det.side}px)`;
    } else {
      reason = "Neither the diamond nor the Veo wordmark correlated with this clip.";
    }

    return { width, height, diamond: det, veo, chosen, reason };
  }

  function peakOf(base, baseSide, side) {
    const map = resizeMask(base, baseSide, side);
    let peak = 0;
    for (const v of map) if (v > peak) peak = v;
    return peak;
  }

  window.__erasioDetect = {
    detect,
    loadMaps,
    detectDiamond,
    detectVeo,
    estimatePeakAlpha,
    buildDiamondCandidate,
    resizeMask,
    maskStats,
    nccAt,
    MIN_DIAMOND_NCC,
    MIN_VEO_NCC,
  };
})();
