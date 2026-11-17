// Watermark detection, reproducing Erasio 1.3.1's video pipeline exactly.
//
// Erasio does NOT search the whole frame. Its side panel
// (assets/sidepanel-*.js, `ew()`) works like this, and every constant below was
// read out of that bundle:
//
//   * The mask is picked from a table by logo family and resolution:
//         logoVersion "old" (THE DEFAULT): 720p -> bg_48.png (48px, grayscale,
//                                         peak alpha 0.506)
//                                         1080p -> gemini-star_paired_star_mask.png
//                                         (84px, RGBA + per-pixel colour)
//         logoVersion "new":              720p -> sparkle-2026-48.png (peak 0.341)
//                                         1080p -> sparkle-2026-96.png (peak 0.369)
//   * Candidate positions are a fixed inset table, used for BOTH axes:
//         720p  -> [144, 120, 128, 72]
//         1080p -> [222, 186]
//     x = clamp(width - inset - shift, 0, width - mask), y likewise, where
//     `shift` re-centres a mask scaled by `maskScale`.
//   * The inset is chosen by Pearson correlation (`sp`) between the mask's
//     alpha and the pixel value (r+g+b)/765, over mask pixels with alpha > .08.
//   * Opacity is one of exactly two levels, [1, 0.62], picked by comparing the
//     reverse-blended result against a ring of untouched pixels (`Ib`).
//   * Edge diffusion is on only when opacity came out at 1 and the mask is
//     grayscale (`W2`) — strength .6, radius 2, 120 passes.
//
// The consequence, and the reason this file exists: the same star drawn at a
// different alpha needs a different map. Removing a bg_48 mark (peak 0.506)
// with the 2026 map (peak 0.341) under-subtracts by a third and leaves a faint
// ghost; that is exactly the "output but the watermark is still there" bug.
// So: old family by default, and the 2026 family only when it is clearly the
// better fit — which is Erasio's own logoVersion switch, automated.
//
// Detection is also used to refuse, and to report. The actual re-encode is done
// by the vendored engine's own Erasio code path (vendor/videoProcessor.js),
// which repeats this same calibration on your clip.
(function () {
  "use strict";

  // ---------- Erasio constants (verbatim from the 1.3.1 bundle) ----------

  const OFFSETS_720 = [144, 120, 128, 72];
  const OFFSETS_1080 = [222, 186];
  const OPACITY_LEVELS = [1, 0.62];
  const LARGE_THRESHOLD = 1024;

  // Object.freeze({...}) named `Ru` in the side panel; the shipped defaults.
  const ERASIO_DEFAULTS = Object.freeze({
    baseStrength: 1,
    opacityMode: "auto",
    opacityCustom: 0.8,
    ceiling: 0.99,
    overlayValue: 255,
    edgeMode: "auto",
    edgeStrength: 0.6,
    edgeRadius: 2,
    edgePasses: 120,
    corrThreshold: 0.35,
    maskScale: 1,
    logoVersion: "old",
  });

  // ---------- our own gates (Erasio never refuses; we do) ----------

  const GATE_PEARSON = 0.24;   // below this, no offset candidate looks like a mark
  const SWITCH_MARGIN = 0.08;  // 2026 map must clearly beat "old" to be used
  const REFINE_MARGIN = 0.10;  // a drifted position must clearly beat the table
  const MIN_VEO_NCC = 0.60;    // upstream Veo detector's 0.62 gate, minus noise

  // ---------- small helpers ----------

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  function median(values) {
    if (!values.length) return NaN;
    const s = values.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  function lumaAt(data, o) {
    return 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
  }

  // ---------- mask table (mirrors P2() in the side panel) ----------

  // Which PNG, at which base size, and how its pixels become alpha.
  //   withColor: values come from the ALPHA channel and the RGB becomes the
  //   per-pixel overlay colour (the 84px paired-star PNG is RGBA).
  //   Otherwise values = max(r,g,b)/255, which is how the grayscale masks are
  //   meant to be read.
  function maskSpec(family, is1080, maskScale) {
    const use2026 = family === "new";
    const scale = clamp(Number(maskScale) || 1, 0.5, 3);
    const base = use2026 ? (is1080 ? 96 : 48) : (is1080 ? 84 : 48);
    return {
      family: use2026 ? "new" : "old",
      is1080: !!is1080,
      file: use2026
        ? (is1080 ? "sparkle-2026-96.png" : "sparkle-2026-48.png")
        : (is1080 ? "gemini-star_paired_star_mask.png" : "bg_48.png"),
      base,
      size: Math.max(8, Math.round(base * scale)),
      withColor: !use2026 && !!is1080,
      maskScale: scale,
    };
  }

  function offsetsFor(is1080) {
    return is1080 ? OFFSETS_1080 : OFFSETS_720;
  }

  // Assets resolve relative to THIS script, so the app at the repo root and the
  // harnesses under /test both find masks/.
  const ASSET_BASE = (() => {
    const s = document.currentScript;
    if (s && s.src) return new URL("../masks/", s.src).href;
    return new URL("masks/", location.href).href;
  })();

  const maskCache = new Map();

  // Same decode as Erasio's Z2(): draw the PNG at the target size and read it
  // back, so gamma/filtering match the extension's own rasterisation.
  function loadMask(spec) {
    const key = `${spec.file}@${spec.size}@${spec.withColor ? "rgba" : "gray"}`;
    if (maskCache.has(key)) return maskCache.get(key);
    const p = (async () => {
      const url = ASSET_BASE + spec.file;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Cannot load ${url} (HTTP ${res.status})`);
      const bmp = await createImageBitmap(await res.blob());
      const cvs = new OffscreenCanvas(spec.size, spec.size);
      const ctx = cvs.getContext("2d", { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(bmp, 0, 0, spec.size, spec.size);
      const px = ctx.getImageData(0, 0, spec.size, spec.size).data;
      bmp.close();
      const n = spec.size * spec.size;
      const values = new Float32Array(n);
      const colorValues = spec.withColor ? new Float32Array(n * 3) : undefined;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        if (spec.withColor) {
          values[i] = px[o + 3] / 255;
          colorValues[3 * i] = px[o];
          colorValues[3 * i + 1] = px[o + 1];
          colorValues[3 * i + 2] = px[o + 2];
        } else {
          values[i] = Math.max(px[o], px[o + 1], px[o + 2]) / 255;
        }
      }
      return { values, colorValues, width: spec.size, height: spec.size, spec };
    })();
    maskCache.set(key, p);
    return p;
  }

  function peakOf(map) {
    let peak = 0;
    for (let i = 0; i < map.values.length; i++) if (map.values[i] > peak) peak = map.values[i];
    return peak;
  }

  // ---------- Erasio calibration: sp(), Ib(), W2(), Fb() ----------

  // Pearson r between the mask's alpha and pixel value, over mask pixels above
  // 0.08. This is Erasio's position score, unchanged.
  function sp(frame, cand) {
    const { data, width } = frame;
    const map = cand.alphaMap;
    const mw = map.width, mh = map.height;
    let sumG = 0, sumG2 = 0, sumA = 0, sumA2 = 0, sumGA = 0, n = 0;
    for (let row = 0; row < mh; row++) {
      for (let col = 0; col < mw; col++) {
        const a = map.values[row * mw + col];
        if (a <= 0.08) continue;
        const px = cand.x + col, py = cand.y + row;
        if (px < 0 || py < 0 || px >= width || py >= frame.height) continue;
        const o = (py * width + px) * 4;
        const g = (data[o] + data[o + 1] + data[o + 2]) / 765;
        sumG += g; sumG2 += g * g;
        sumA += a; sumA2 += a * a;
        sumGA += g * a;
        n++;
      }
    }
    if (n === 0) return -Infinity;
    const mG = sumG / n, mA = sumA / n;
    const den = Math.sqrt((sumG2 - n * mG * mG) * (sumA2 - n * mA * mA));
    if (den <= 0) return -Infinity;
    return (sumGA - n * mG * mA) / den;
  }

  // Which of [1, 0.62] makes the reverse blend look like the ring around the
  // mark? Erasio's Ib(), including its hardcoded 250 overlay in the estimate.
  function ib(frame, cand) {
    const map = cand.alphaMap;
    if (map.colorValues !== undefined) return 1;

    const pad = Math.max(8, Math.round(0.25 * map.width));
    const x0 = Math.max(0, cand.x - pad);
    const y0 = Math.max(0, cand.y - pad);
    const x1 = Math.min(frame.width, cand.x + map.width + pad);
    const y1 = Math.min(frame.height, cand.y + map.height + pad);
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (x >= cand.x && x < cand.x + map.width && y >= cand.y && y < cand.y + map.height) continue;
        sum += lumaAt(frame.data, (y * frame.width + x) * 4);
        n++;
      }
    }
    if (n === 0) return OPACITY_LEVELS[0];
    const surrounding = sum / n;

    let bestOpacity = OPACITY_LEVELS[0], bestError = Infinity;
    for (const op of OPACITY_LEVELS) {
      let errSum = 0, weightSum = 0;
      for (let row = 0; row < map.height; row++) {
        for (let col = 0; col < map.width; col++) {
          const mi = row * map.width + col;
          const a = map.values[mi];
          if (a <= 0.04) continue;
          const p = Math.min(a * (cand.baseStrength || 1) * op, op);
          const oneMinus = 1 - p;
          if (oneMinus <= 1e-4) continue;
          const o = ((cand.y + row) * frame.width + cand.x + col) * 4;
          const v = 0.2126 * ((frame.data[o] - p * 250) / oneMinus) +
                    0.7152 * ((frame.data[o + 1] - p * 250) / oneMinus) +
                    0.0722 * ((frame.data[o + 2] - p * 250) / oneMinus);
          const w = Math.min(1, 8 * a);
          errSum += Math.abs(v - surrounding) * w;
          weightSum += w;
        }
      }
      const err = weightSum > 0 ? errSum / weightSum : Infinity;
      if (err < bestError) { bestError = err; bestOpacity = op; }
    }
    return bestOpacity;
  }

  // Erasio's W2(): fill in the run-time knobs, and enable the edge diffusion
  // only for a full-strength grayscale mask (that is the shipped rule).
  function applyRunSettings(cand, settings) {
    const s = settings || ERASIO_DEFAULTS;
    cand.baseStrength = s.baseStrength != null ? s.baseStrength : 1;
    const isGray = cand.alphaMap.colorValues === undefined;
    const opacityHigh = (cand.opacity != null ? cand.opacity : 1) >= 1;
    let cleanup;
    if (s.edgeMode === "auto") cleanup = opacityHigh && isGray;
    else cleanup = s.edgeMode === "on";
    cand.ceiling = s.ceiling != null ? s.ceiling : 0.99;
    if (isGray && s.overlayValue != null) cand.overlayValue = s.overlayValue;
    if (cleanup) {
      cand.edgeCleanup = {
        strength: s.edgeStrength != null ? s.edgeStrength : 0.6,
        radius: s.edgeRadius != null ? s.edgeRadius : 2,
        maxPasses: s.edgePasses != null ? s.edgePasses : 120,
      };
    } else {
      delete cand.edgeCleanup;
    }
    return cand;
  }

  // Candidate positions for a mask: Erasio's fixed inset table, used for x and
  // y, with the scaled-mask re-centring shift.
  function candidatesFor(width, height, spec, map) {
    const shift = Math.floor((map.width - spec.base) / 2);
    return offsetsFor(spec.is1080).map((off) => ({
      x: clamp(width - off - shift, 0, Math.max(0, width - map.width)),
      y: clamp(height - off - shift, 0, Math.max(0, height - map.height)),
      alphaMap: map,
      baseStrength: 1,
      score: 0,
    }));
  }

  // Erasio's Fb(): score the table, keep the winner, then calibrate opacity.
  function calibrate(frame, spec, map, settings) {
    const cands = candidatesFor(frame.width, frame.height, spec, map);
    for (const c of cands) c.score = sp(frame, c);
    const best = cands.reduce((a, b) => (b.score > a.score ? b : a));
    const chosen = {
      x: best.x,
      y: best.y,
      alphaMap: map,
      baseStrength: 1,
      score: best.score,
    };
    chosen.opacity = ib(frame, chosen);
    applyRunSettings(chosen, settings);
    return { chosen, cands };
  }

  // Local re-centre, used only when the table's best spot is clearly beaten.
  // Erasio never does this; it is the escape hatch for a clip whose mark moved
  // (Google does move it between model versions).
  function refinePosition(frame, cand, radius, step) {
    const base = cand.score;
    let best = { x: cand.x, y: cand.y, score: base };
    for (let dy = -radius; dy <= radius; dy += step) {
      for (let dx = -radius; dx <= radius; dx += step) {
        const x = cand.x + dx, y = cand.y + dy;
        if (x < 0 || y < 0 || x + cand.alphaMap.width > frame.width ||
            y + cand.alphaMap.height > frame.height) continue;
        const score = sp(frame, { x, y, alphaMap: cand.alphaMap });
        if (score > best.score) best = { x, y, score };
      }
    }
    return best;
  }

  // Mean Pearson across several frames — a mark is there in all of them, a
  // lucky texture match usually is not.
  function scoreAcrossFrames(frames, cand) {
    let sum = 0, n = 0;
    for (const f of frames) {
      const v = sp(f, cand);
      if (Number.isFinite(v)) { sum += v; n++; }
    }
    return n ? sum / n : -Infinity;
  }

  // How opaque is the mark in this clip? Diagnostic only: the removal uses
  // Erasio's two-level Ib() estimate, exactly like the extension. Solving
  // L = a*255 + (1-a)*B over the mask core against a ring of clean background.
  function estimatePeakAlpha(frames, cand) {
    const map = cand.alphaMap;
    const peak = peakOf(map);
    if (peak <= 0.02) return null;
    const core = [];
    for (let i = 0; i < map.values.length; i++) {
      if (map.values[i] >= peak * 0.85) core.push(i);
    }
    if (core.length < 6) return null;

    const samples = [];
    for (const frame of frames) {
      const ring = [];
      for (let dy = -9; dy < map.height + 9; dy++) {
        for (let dx = -9; dx < map.width + 9; dx++) {
          if (dx >= 0 && dx < map.width && dy >= 0 && dy < map.height) continue;
          const px = cand.x + dx, py = cand.y + dy;
          if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) continue;
          ring.push(lumaAt(frame.data, (py * frame.width + px) * 4));
        }
      }
      const B = median(ring);
      if (!Number.isFinite(B) || B >= 250 || B <= 2) continue;
      for (const i of core) {
        const r = (i / map.width) | 0, c = i - r * map.width;
        const L = lumaAt(frame.data, ((cand.y + r) * frame.width + cand.x + c) * 4);
        const rel = map.values[i] / peak;
        const a = (L - B) / ((255 - B) * rel);
        if (a > -0.15 && a < 1.05) samples.push(a);
      }
    }
    if (samples.length < 12) return null;
    return median(samples);
  }

  // ---------- Veo wordmark (a completely different mark) ----------

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
            best = { ncc: mean, templateId: t.id, x, y, width: t.width, height: t.height };
          }
        }
      }
    }
    return best;
  }

  // ---------- public entry ----------

  /**
   * Score the clip and pick the mark that is actually in it.
   *
   * @returns {{
   *   width:number, height:number, is1080:boolean,
   *   family:"old"|"new"|null,
   *   scores:{old:number|null,new:number|null},
   *   logo:{family,x,y,side,score,opacity,method,drifted,peakAlpha,mapPeak}|null,
   *   diamond:{x,y,side,ncc,score,alpha,gain,family,method}|null,
   *   candidate:object|null,
   *   veo:object|null,
   *   chosen:"diamond"|"veo"|null,
   *   reason:string, notes:string[],
   * }}
   */
  async function detect(buffer, opts) {
    opts = opts || {};
    const fractions = opts.fractions || [0.15, 0.35, 0.55, 0.75];
    const decoded = await window.__decodeVideoFrames(buffer, fractions, opts.onProgress);
    const frames = decoded.map((f) => f.imageData);
    if (!frames.length) throw new Error("Could not decode any frame for detection");

    const width = decoded[0].width, height = decoded[0].height;
    const is1080 = (width === 1920 && height === 1080) || (width === 1080 && height === 1920);
    const settings = Object.assign({}, ERASIO_DEFAULTS, opts.settings || {});
    const maskScale = settings.maskScale != null ? settings.maskScale : 1;
    const wantFamilies = opts.family && opts.family !== "auto"
      ? [opts.family]
      : ["old", "new"];

    const notes = [];
    const scores = { old: null, new: null };
    const calib = {};

    for (const family of wantFamilies) {
      const spec = maskSpec(family, is1080, maskScale);
      const map = await loadMask(spec);
      const { chosen } = calibrate(frames[0], spec, map, settings);
      const mean = scoreAcrossFrames(frames, chosen);
      scores[family] = mean;
      calib[family] = { spec, map, chosen: Object.assign({}, chosen, { score: mean }) };
      notes.push(`${family}: r=${mean.toFixed(3)} at ${chosen.x},${chosen.y} ` +
        `(${map.width}px, opacity ${chosen.opacity.toFixed(2)})`);
    }

    // Family choice: Erasio's default is "old"; only switch when the 2026 map
    // is clearly the better fit (it is the same star at a softer alpha, so the
    // two scores are usually close and "old" is the safer subtraction).
    const available = Object.keys(calib);
    let family = available[0];
    if (available.length > 1 && scores.old != null && scores.new != null) {
      family = scores.new > scores.old + SWITCH_MARGIN ? "new" : "old";
    }
    let active = calib[family];
    let method = "offsets";
    let drifted = false;

    const veo = detectVeo(frames);

    // Below the gate, try Erasio's own bottom-right NCC scan (the page
    // engine's detector) for a mark that is not on one of the fixed insets.
    let logo = null;
    let candidate = null;
    if (active && active.chosen.score >= GATE_PEARSON) {
      logo = describe(family, active, method, drifted);
      candidate = active.chosen;
      // Drill down only when a moved mark scores clearly better.
      const refined = refinePosition(frames[0], active.chosen, 24, 2);
      if (refined.score > active.chosen.score + REFINE_MARGIN) {
        const fine = refinePosition(frames[0], Object.assign({}, active.chosen, refined), 3, 1);
        const verified = scoreAcrossFrames(frames, Object.assign({}, active.chosen, fine));
        if (verified > active.chosen.score + REFINE_MARGIN * 0.5) {
          const moved = Object.assign({}, active.chosen, fine, { score: verified });
          // Opacity is estimated at the position the mark actually occupies.
          moved.opacity = ib(frames[0], moved);
          applyRunSettings(moved, settings);
          active = Object.assign({}, active, { chosen: moved });
          candidate = active.chosen;
          method = "moved";
          drifted = true;
          logo = describe(family, active, method, drifted);
          notes.push(`mark moved off the inset table: ${fine.x},${fine.y} (r ${verified.toFixed(3)})`);
        }
      }
    } else if (window.__erasioSparkle) {
      try {
        const scan = await erasioScan(frames, family, is1080, maskScale, active);
        if (scan) {
          family = scan.family;
          active = scan;
          logo = describe(family, active, scan.method, true);
          candidate = active.chosen;
          method = scan.method;
          drifted = true;
          notes.push(`NCC scan: ${scan.method}, ncc ${scan.chosen.score.toFixed(3)}`);
        }
      } catch (e) {
        notes.push(`NCC scan failed: ${e && e.message ? e.message : e}`);
      }
    }

    if (logo) {
      const framesAlpha = estimatePeakAlpha(frames, active.chosen);
      logo.peakAlpha = framesAlpha;
      logo.mapPeak = peakOf(active.map);
    }

    const diamond = logo
      ? {
          x: logo.x, y: logo.y, side: logo.side,
          ncc: logo.score, score: logo.score,
          alpha: logo.peakAlpha,
          gain: logo.peakAlpha != null && logo.mapPeak
            ? logo.peakAlpha / logo.mapPeak
            : null,
          opacity: logo.opacity,
          family: logo.family,
          method: logo.method,
        }
      : null;

    const diamondOk = !!logo && logo.score >= GATE_PEARSON;
    const veoOk = !!veo && veo.ncc >= MIN_VEO_NCC;

    let chosen = null, reason = "";
    if (veoOk && (!diamondOk || veo.ncc >= (logo ? logo.score : 0) + 0.05)) {
      chosen = "veo";
      reason = `Veo wordmark matched (NCC ${veo.ncc.toFixed(2)})` +
        (diamondOk ? `, stronger than the ${family} diamond (r ${logo.score.toFixed(2)})` : "");
    } else if (diamondOk) {
      chosen = "diamond";
      reason = `${family === "new" ? "2026 sparkle" : "Logo"} matched ` +
        `(r ${logo.score.toFixed(2)} at ${logo.x},${logo.y}, ${logo.side}px, ` +
        `opacity ${logo.opacity.toFixed(2)}${drifted ? ", moved" : ""})`;
    } else {
      reason = "No offset candidate correlated with this clip.";
      if (veo) reason += ` Best Veo NCC was ${veo.ncc.toFixed(2)}.`;
    }

    // The candidate the app previews/pins. Position is settled; strength and
    // edge cleanup come from the UI so the preview matches the run.
    if (candidate) {
      candidate = Object.assign({}, candidate, {
        baseStrength: settings.baseStrength != null ? settings.baseStrength : 1,
      });
      applyRunSettings(candidate, settings);
    }

    return {
      width, height, is1080, family,
      scores,
      logo,
      diamond,
      candidate,
      veo,
      chosen,
      reason,
      notes,
      settings: {
        logoVersion: family,
        maskScale,
      },
    };
  }

  function describe(family, active, method, drifted) {
    return {
      family,
      x: active.chosen.x,
      y: active.chosen.y,
      side: active.map.width,
      score: active.chosen.score,
      opacity: active.chosen.opacity,
      method,
      drifted: !!drifted,
      maskFile: active.spec.file,
      maskScale: active.spec.maskScale,
    };
  }

  // Erasio's page detector, used as a rescue: multi-size NCC scan over the
  // bottom-right quadrant, with our calibrated candidate as the fallback it
  // must beat. Returns a calibrated candidate for the same family's mask.
  async function erasioScan(frames, family, is1080, maskScale, active) {
    const sparkle = window.__erasioSparkle;
    if (!sparkle || !active) return null;
    const frame = frames[0];
    const spec = maskSpec(family, is1080, maskScale);
    const map = active.map;
    const maps = await sparkle.loadDetectionMaps();
    const fallback = {
      side: map.width,
      which: family,
      x: active.chosen.x,
      y: active.chosen.y,
      alphaMap: { values: map.values, width: map.width, height: map.height },
    };
    const res = sparkle.detectWatermarkNCCFromMaps(frame, maps, { fallback });
    if (!res || !res.accepted || !res.best) return null;
    if (res.usingFallback) return null; // no better than what we already had

    // The scan locks one of its own sizes onto the mark; re-centre OUR map on
    // that spot, then verify over several frames before trusting it.
    const best = res.best;
    const centred = {
      x: clamp(best.x + Math.round((best.side - map.width) / 2), 0, frame.width - map.width),
      y: clamp(best.y + Math.round((best.side - map.height) / 2), 0, frame.height - map.height),
      alphaMap: map,
      baseStrength: 1,
      score: res.best.ncc,
    };
    const refined = refinePosition(frame, centred, 12, 2);
    const verified = scoreAcrossFrames(frames, Object.assign({}, centred, refined));
    if (verified < GATE_PEARSON) return null;
    const chosen = Object.assign({}, centred, refined, { score: verified });
    chosen.opacity = ib(frame, chosen);
    applyRunSettings(chosen, {});
    return {
      spec, map,
      chosen,
      method: res.best.method === "auto" ? "scan-auto" : "scan",
    };
  }

  // Build a candidate for a position the caller owns (manual pin, or a
  // position detected outside detect()). Mirrors Erasio's Fb(forcePosition).
  async function buildCandidate(width, height, opts) {
    opts = opts || {};
    const family = opts.family === "new" ? "new" : "old";
    const is1080 = (width === 1920 && height === 1080) || (width === 1080 && height === 1920);
    const spec = maskSpec(family, is1080, opts.maskScale);
    const map = await loadMask(spec);
    const size = map.width;
    const x = clamp(Math.round(opts.x != null ? opts.x : width - size), 0, Math.max(0, width - size));
    const y = clamp(Math.round(opts.y != null ? opts.y : height - size), 0, Math.max(0, height - size));
    const cand = { x, y, alphaMap: map, baseStrength: 1, score: 0 };
    const frame = opts.frame;
    cand.opacity = frame ? ib(frame, cand) : 1;
    applyRunSettings(cand, Object.assign({}, ERASIO_DEFAULTS, opts.settings || {}));
    return cand;
  }

  // The 2026 masks as the vendored engine's tuning relay expects them
  // ({s48,s96} of {values,side}). The "old" family ships inside the engine.
  async function loadNewMaps() {
    const [a, b] = await Promise.all([
      loadMask(maskSpec("new", false, 1)),
      loadMask(maskSpec("new", true, 1)),
    ]);
    return {
      s48: { values: a.values, side: a.width },
      s96: { values: b.values, side: b.width },
    };
  }

  window.__erasioDetect = {
    detect,
    buildCandidate,
    loadMask,
    loadNewMaps,
    maskSpec,
    candidatesFor,
    refinePosition,
    // exported for the test harness
    sp,
    ib,
    applyRunSettings,
    estimatePeakAlpha,
    detectVeo,
    GATE_PEARSON,
    MIN_VEO_NCC,
    ERASIO_DEFAULTS,
    OFFSETS_720,
    OFFSETS_1080,
    OPACITY_LEVELS,
    LARGE_THRESHOLD,
  };
})();
