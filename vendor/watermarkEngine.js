// AUTO-GENERATED FILE — DO NOT EDIT.
//
// Generated from src/lib/toolWatermarkEngine.js by scripts/build-page-engine.mjs.
// Edit the source module and rerun `npm run build`.
//
// This is the SAME image watermark engine the website's /tool page and the
// extension side panel run, made available to the MAIN world on Gemini / Flow
// as a classic script. It publishes:
//
//   window.__erasioImageEngine = { GeminiWatermarkEngine, IMAGE_DEFAULTS }
//
// Masks reach it via initFromAlphaMaps(): the page world can neither resolve
// chrome-extension: asset URLs nor load them past the host CSP, so the content
// script decodes them and relays the alpha values over AIP_CONFIG.

(function () {
    "use strict";

    /**
     * Gemini Watermark Engine — Pure Math (Reverse Alpha Blending)
     * =============================================================
     *
     * Based on GeminiWatermarkTool by Allen Kuo (allenk).
     * Ported to JavaScript for Chrome Extension (client-side only).
     *
     * Math:
     *   Gemini adds:  watermarked = α × logo + (1 - α) × original
     *   We reverse:   original = (watermarked - α × logo) / (1 - α)
     *
     * The alpha map is derived from calibrated 48×48 and 96×96 background
     * captures of the Gemini Sparkle watermark on a pure black background.
     */

    // Detection thresholds and reverse-blend tuning. Calibrated in
    // /test-watermark.html against both legacy and post-update Gemini images.
    // These are the *defaults* — the Settings panel can override any of them per
    // call via the `options` arg on removeWatermarkAuto().
    const IMAGE_DEFAULTS = Object.freeze({
      nccGood:        0.50,  // auto-margin NCC ≥ this → trust it, skip scan
      nccAccept:      0.30,  // minimum NCC to declare a detection
      scanStride:     8,     // coarse pass step (px)
      refineRadius:   8,     // ± px stride-1 refine after coarse peak
      gainDrift:      0.62,  // α multiplier when chosen pos ≠ auto (video-cal)
      alphaThreshold: 0.002, // α below this is skipped during reverse-blend
      maxAlpha:       0.99,  // α cap before ÷(1−α) to avoid blow-ups
      logoValue:      255,   // assumed RGB value of the watermark color
      // Multiplier applied to the alpha-map dimensions before cleanup. 1.0 keeps
      // the calibrated 48/96 px shape; >1 spreads the star pattern over more
      // pixels, so the reverse-blend also eats fringe glow the stock mask misses.
      // Detection stays on the calibrated size (best shape match); only cleanup
      // uses the enlarged map, and the top-left is shifted inward so the pattern
      // still centers on the detected stamp.
      maskScale:      1.0,
      // Which calibrated sparkle map to reverse-blend against.
      //   'old' → original bg_48/bg_96 captures.
      //   'new' → 2026 Gemini sparkle (sparkle-2026-48/96).
      logoVersion:    'old',   // 'old' | 'new'
    });

    // Bilinear rescaler for a square Float32Array alpha map. Used to grow (or
    // shrink) the calibrated 48/96 px maps when the caller passes maskScale ≠ 1.
    // Results are cached on the engine instance so a hot slider doesn't recompute
    // the same map on every keystroke.
    function rescaleAlphaMap(alphaMap, oldSize, newSize) {
      if (oldSize === newSize) return alphaMap;
      const out = new Float32Array(newSize * newSize);
      const step = (oldSize - 1) / Math.max(1, newSize - 1);
      for (let y = 0; y < newSize; y++) {
        const sy = y * step;
        const y0 = Math.floor(sy);
        const y1 = Math.min(oldSize - 1, y0 + 1);
        const fy = sy - y0;
        for (let x = 0; x < newSize; x++) {
          const sx = x * step;
          const x0 = Math.floor(sx);
          const x1 = Math.min(oldSize - 1, x0 + 1);
          const fx = sx - x0;
          const a00 = alphaMap[y0 * oldSize + x0];
          const a10 = alphaMap[y0 * oldSize + x1];
          const a01 = alphaMap[y1 * oldSize + x0];
          const a11 = alphaMap[y1 * oldSize + x1];
          out[y * newSize + x] =
            a00 * (1 - fx) * (1 - fy) +
            a10 * fx * (1 - fy) +
            a01 * (1 - fx) * fy +
            a11 * fx * fy;
        }
      }
      return out;
    }

    const NCC_GOOD        = IMAGE_DEFAULTS.nccGood;
    const NCC_ACCEPT      = IMAGE_DEFAULTS.nccAccept;
    const SCAN_STRIDE     = IMAGE_DEFAULTS.scanStride;
    const REFINE_RADIUS   = IMAGE_DEFAULTS.refineRadius;
    const GAIN_DRIFT      = IMAGE_DEFAULTS.gainDrift;
    const ALPHA_THRESHOLD = IMAGE_DEFAULTS.alphaThreshold;
    const MAX_ALPHA       = IMAGE_DEFAULTS.maxAlpha;

    class GeminiWatermarkEngine {
      constructor() {
        // "old" = the original calibrated sparkle (bg_48/bg_96). "new" = the 2026
        // Gemini sparkle (sparkle-2026-48/96). Both are grayscale-on-black
        // captures, so both flow through the same max(R,G,B)/255 alpha extraction.
        this.alphaMap48 = null;    // Float32Array, 48×48 — old
        this.alphaMap96 = null;    // Float32Array, 96×96 — old
        this.alphaMap48New = null; // Float32Array, 48×48 — new (2026)
        this.alphaMap96New = null; // Float32Array, 96×96 — new (2026)
        this.ready = false;
        this.logoValue = 255.0;
        // key: `${logoVersion}_${baseSize}_${targetSize}` → { alphaMap, size }
        this._scaledMaskCache = new Map();
      }

      // Base (calibrated-size) alpha map for a size + logo version. Falls back to
      // the old set if a new map wasn't loaded, so `logoVersion:'new'` degrades to
      // the original rather than reverse-blending against a null buffer.
      _baseMap(baseSize, logoVersion) {
        const useNew = logoVersion === 'new';
        if (baseSize === 96) return (useNew ? this.alphaMap96New : this.alphaMap96) || this.alphaMap96;
        return (useNew ? this.alphaMap48New : this.alphaMap48) || this.alphaMap48;
      }

      // Returns the alpha map to actually paint into the image for cleanup.
      //   scale === 1 → the base 48 or 96 map (no allocation).
      //   scale ≠ 1  → a cached bilinear-resampled map at Math.round(base×scale).
      // Keyed by logo version so old/new scaled maps never collide in the cache.
      _getScaledMask(baseSize, scale, logoVersion) {
        const version = logoVersion === 'new' ? 'new' : 'old';
        const baseMap = this._baseMap(baseSize, version);
        const target = Math.max(4, Math.round(baseSize * (scale || 1)));
        if (target === baseSize) {
          return { alphaMap: baseMap, size: baseSize };
        }
        const key = `${version}_${baseSize}_${target}`;
        const hit = this._scaledMaskCache.get(key);
        if (hit) return hit;
        const scaled = rescaleAlphaMap(baseMap, baseSize, target);
        const result = { alphaMap: scaled, size: target };
        this._scaledMaskCache.set(key, result);
        return result;
      }

      /**
       * Initialize the engine by loading the alpha map PNGs.
       * @param {string} bg48Url - URL to bg_48.png
       * @param {string} bg96Url - URL to bg_96.png
       * @returns {Promise<void>}
       */
      async init(bg48Url, bg96Url, new48Url = null, new96Url = null) {
        const [bg48, bg96, new48, new96] = await Promise.all([
          this._loadImage(bg48Url),
          this._loadImage(bg96Url),
          // New (2026) maps are optional — a load failure must not break the whole
          // engine, so swallow it and fall back to the old map below.
          new48Url ? this._loadImage(new48Url).catch(() => null) : Promise.resolve(null),
          new96Url ? this._loadImage(new96Url).catch(() => null) : Promise.resolve(null),
        ]);

        this.alphaMap48 = this._calculateAlphaMap(bg48, 48, 48);
        this.alphaMap96 = this._calculateAlphaMap(bg96, 96, 96);
        this.alphaMap48New = new48 ? this._calculateAlphaMap(new48, 48, 48) : this.alphaMap48;
        this.alphaMap96New = new96 ? this._calculateAlphaMap(new96, 96, 96) : this.alphaMap96;
        this.ready = true;

        console.log('[WatermarkEngine] Initialized');
        console.log(`  Alpha 48×48 (old): min=${this._arrayMin(this.alphaMap48).toFixed(4)}, max=${this._arrayMax(this.alphaMap48).toFixed(4)}`);
        console.log(`  Alpha 96×96 (old): min=${this._arrayMin(this.alphaMap96).toFixed(4)}, max=${this._arrayMax(this.alphaMap96).toFixed(4)}`);
        console.log(`  Alpha 48×48 (new): min=${this._arrayMin(this.alphaMap48New).toFixed(4)}, max=${this._arrayMax(this.alphaMap48New).toFixed(4)}`);
        console.log(`  Alpha 96×96 (new): min=${this._arrayMin(this.alphaMap96New).toFixed(4)}, max=${this._arrayMax(this.alphaMap96New).toFixed(4)}`);
      }

      /**
       * Initialize from alpha maps that were decoded elsewhere.
       *
       * Same engine, same numbers — only the way the masks arrive differs. The
       * page-world copy (page/watermarkEngine.js, generated from this file) runs on
       * Gemini/Flow, where there is no chrome.runtime to resolve assets/ and the
       * site's CSP would refuse a chrome-extension: image anyway. So the content
       * script decodes the four masks in the isolated world and relays the alpha
       * values over AIP_CONFIG, and the engine is seeded with them here instead of
       * through init(). Everything downstream — detection, scaling, reverse blend —
       * is byte-for-byte the code the website's /tool page runs.
       *
       * @param {{old48:Float32Array, old96:Float32Array,
       *          new48?:Float32Array, new96?:Float32Array}} maps
       */
      initFromAlphaMaps(maps) {
        // Realm-agnostic on purpose. These arrays are built in the content script's
        // isolated world and cross into the page world, and `instanceof` compares
        // constructors per realm — a perfectly good Float32Array from the other side
        // is not `instanceof` this side's Float32Array. Duck-type instead, and
        // accept a plain array so a JSON-serialising caller also works.
        const coerce = (v, side) => {
          if (!v) return null;
          const isTypedArray = ArrayBuffer.isView(v) && v.BYTES_PER_ELEMENT !== undefined; // excludes DataView
          if (!isTypedArray && !Array.isArray(v)) return null;
          if (v.length !== side * side) return null;
          return v instanceof Float32Array ? v : Float32Array.from(v);
        };

        const old48 = coerce(maps && maps.old48, 48);
        const old96 = coerce(maps && maps.old96, 96);
        if (!old48 || !old96) {
          throw new Error('initFromAlphaMaps requires 48×48 and 96×96 alpha maps');
        }

        this.alphaMap48 = old48;
        this.alphaMap96 = old96;
        // The 2026 maps are optional; without them 'new' degrades to the original
        // set, exactly as init() does when those PNGs fail to load.
        this.alphaMap48New = coerce(maps.new48, 48) || old48;
        this.alphaMap96New = coerce(maps.new96, 96) || old96;
        this._scaledMaskCache.clear();
        this.ready = true;
      }

      /**
       * Load an image and return its pixel data.
       * @param {string} url
       * @returns {Promise<ImageData>}
       */
      _loadImage(url) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, img.width, img.height);
            resolve(imageData);
          };
          img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
          img.src = url;
        });
      }

      /**
       * Calculate alpha map from a background capture.
       * alpha = max(R, G, B) / 255.0
       *
       * This works because on a pure black background (original=0):
       *   watermarked = α × 255 + (1-α) × 0 = α × 255
       *   → α = pixel_value / 255
       */
      _calculateAlphaMap(imageData, width, height) {
        const data = imageData.data;
        const alphaMap = new Float32Array(width * height);

        for (let i = 0; i < width * height; i++) {
          const r = data[i * 4];
          const g = data[i * 4 + 1];
          const b = data[i * 4 + 2];
          const maxVal = Math.max(r, g, b);
          alphaMap[i] = maxVal / 255.0;
        }

        return alphaMap;
      }

      _arrayMin(arr) {
        let min = Infinity;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] < min) min = arr[i];
        }
        return min;
      }

      _arrayMax(arr) {
        let max = -Infinity;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] > max) max = arr[i];
        }
        return max;
      }

      /**
       * Get watermark configuration based on image dimensions.
       *
       * Gemini's rules (reverse-engineered):
       *   W > 1024 AND H > 1024 → 96×96 logo, 64px margin
       *   Otherwise             → 48×48 logo, 32px margin
       */
      getWatermarkConfig(imageWidth, imageHeight) {
        let logoSize, margin;

        if (imageWidth > 1024 && imageHeight > 1024) {
          logoSize = 96;
          margin = 64;
        } else {
          logoSize = 48;
          margin = 32;
        }

        return {
          logoSize,
          margin,
          x: imageWidth - margin - logoSize,
          y: imageHeight - margin - logoSize,
          sizeName: logoSize === 96 ? 'Large' : 'Small',
        };
      }

      /**
       * Detect watermark presence using simplified correlation check.
       *
       * Checks if the watermark region has the characteristic pattern
       * by comparing brightness distribution with the alpha map.
       *
       * @param {ImageData} imageData
       * @param {string|null} forceSize - 'small', 'large', or null (auto)
       * @returns {object} { detected, confidence, ncc, brightnessScore, config }
       */
      detectWatermark(imageData, forceSize = null) {
        const { width, height, data } = imageData;

        let config, alphaMap, logoSize;

        if (forceSize === 'small') {
          logoSize = 48;
          const margin = 32;
          config = { logoSize, margin, x: width - margin - logoSize, y: height - margin - logoSize };
          alphaMap = this.alphaMap48;
        } else if (forceSize === 'large') {
          logoSize = 96;
          const margin = 64;
          config = { logoSize, margin, x: width - margin - logoSize, y: height - margin - logoSize };
          alphaMap = this.alphaMap96;
        } else {
          config = this.getWatermarkConfig(width, height);
          alphaMap = config.logoSize === 96 ? this.alphaMap96 : this.alphaMap48;
          logoSize = config.logoSize;
        }

        const x = config.x;
        const y = config.y;

        const x1 = Math.max(0, x);
        const y1 = Math.max(0, y);
        const x2 = Math.min(width, x + logoSize);
        const y2 = Math.min(height, y + logoSize);

        if (x1 >= x2 || y1 >= y2) {
          return { detected: false, confidence: 0, config };
        }

        let sumProduct = 0;
        let sumAlpha = 0;
        let sumAlphaSq = 0;
        let sumGray = 0;
        let sumGraySq = 0;
        let count = 0;

        for (let row = y1; row < y2; row++) {
          for (let col = x1; col < x2; col++) {
            const imgIdx = (row * width + col) * 4;
            const r = data[imgIdx];
            const g = data[imgIdx + 1];
            const b = data[imgIdx + 2];
            const gray = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;

            const alphaRow = row - y;
            const alphaCol = col - x;
            if (alphaRow < 0 || alphaRow >= logoSize || alphaCol < 0 || alphaCol >= logoSize) continue;

            const alpha = alphaMap[alphaRow * logoSize + alphaCol];

            sumProduct += alpha * gray;
            sumAlpha += alpha;
            sumAlphaSq += alpha * alpha;
            sumGray += gray;
            sumGraySq += gray * gray;
            count++;
          }
        }

        if (count === 0) return { detected: false, confidence: 0, config };

        const meanAlpha = sumAlpha / count;
        const meanGray = sumGray / count;
        const numerator = (sumProduct / count) - (meanAlpha * meanGray);
        const denomAlpha = Math.sqrt((sumAlphaSq / count) - (meanAlpha * meanAlpha));
        const denomGray = Math.sqrt((sumGraySq / count) - (meanGray * meanGray));

        let ncc = 0;
        if (denomAlpha > 0.001 && denomGray > 0.001) {
          ncc = numerator / (denomAlpha * denomGray);
        }

        let brightnessScore = 0;
        if (y1 > logoSize) {
          let sumAbove = 0, sumWm = 0;
          let cntAbove = 0, cntWm = 0;
          const refH = Math.min(y1, logoSize);

          for (let row = y1 - refH; row < y1; row++) {
            for (let col = x1; col < x2; col++) {
              const idx = (row * width + col) * 4;
              sumAbove += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
              cntAbove++;
            }
          }

          for (let row = y1; row < y2; row++) {
            for (let col = x1; col < x2; col++) {
              const idx = (row * width + col) * 4;
              sumWm += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
              cntWm++;
            }
          }

          const meanAbove = cntAbove > 0 ? sumAbove / cntAbove : 0;
          const meanWm = cntWm > 0 ? sumWm / cntWm : 0;

          if (meanAbove > 10) {
            brightnessScore = Math.max(0, Math.min(1, (meanWm - meanAbove) / meanAbove));
          }
        }

        const confidence = Math.max(0, Math.min(1,
          ncc * 0.6 + brightnessScore * 0.4
        ));

        const detected = confidence >= 0.15 || ncc > 0.3;

        return { detected, confidence, ncc, brightnessScore, config };
      }

      /**
       * Normalized cross-correlation between the alpha-map pattern and the
       * grayscale of a candidate region. Returns -1 for out-of-bounds or
       * zero-variance regions.
       */
      _nccAt(data, w, h, alphaMap, size, x, y) {
        if (x < 0 || y < 0 || x + size > w || y + size > h) return -1;
        let sP = 0, sA = 0, sA2 = 0, sG = 0, sG2 = 0, n = 0;
        for (let row = 0; row < size; row++) {
          const imgRow = (y + row) * w;
          const aRow = row * size;
          for (let col = 0; col < size; col++) {
            const i = (imgRow + (x + col)) * 4;
            const gray = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
            const a = alphaMap[aRow + col];
            sP += a * gray; sA += a; sA2 += a * a;
            sG += gray;     sG2 += gray * gray;
            n++;
          }
        }
        if (!n) return -1;
        const mA = sA / n, mG = sG / n;
        const num = sP / n - mA * mG;
        const dA = Math.sqrt(Math.max(0, sA2 / n - mA * mA));
        const dG = Math.sqrt(Math.max(0, sG2 / n - mG * mG));
        if (dA < 1e-3 || dG < 1e-3) return -1;
        return num / (dA * dG);
      }

      /**
       * Coarse-then-fine NCC scan of the bottom-right quadrant. Used when the
       * standard auto-margin position no longer holds the watermark.
       */
      _scanBottomRight(data, w, h, alphaMap, size, stride, refine) {
        const xStart = Math.max(0, Math.floor(w * 0.5));
        const yStart = Math.max(0, Math.floor(h * 0.5));
        const xEnd = w - size, yEnd = h - size;
        if (xEnd < xStart || yEnd < yStart) return { x: -1, y: -1, ncc: -1 };

        let best = { x: xStart, y: yStart, ncc: -1 };
        for (let y = yStart; y <= yEnd; y += stride) {
          for (let x = xStart; x <= xEnd; x += stride) {
            const v = this._nccAt(data, w, h, alphaMap, size, x, y);
            if (v > best.ncc) best = { x, y, ncc: v };
          }
        }
        if (refine > 0) {
          let r = best;
          const rxLo = Math.max(0, best.x - refine);
          const ryLo = Math.max(0, best.y - refine);
          const rxHi = Math.min(xEnd, best.x + refine);
          const ryHi = Math.min(yEnd, best.y + refine);
          for (let y = ryLo; y <= ryHi; y++) {
            for (let x = rxLo; x <= rxHi; x++) {
              const v = this._nccAt(data, w, h, alphaMap, size, x, y);
              if (v > r.ncc) r = { x, y, ncc: v };
            }
          }
          best = r;
        }
        return best;
      }

      /**
       * Locate and reverse Gemini's sparkle stamp in place.
       *
       * Pipeline:
       *   1. For BOTH 48×48 and 96×96 alpha maps, compute NCC at the standard
       *      bottom-right auto-margin position. If NCC ≥ NCC_GOOD, trust it
       *      (legacy fast path — no scan cost). Otherwise scan the bottom-right
       *      quadrant at SCAN_STRIDE and refine ±REFINE_RADIUS at stride 1.
       *   2. Winner = (size, x, y) with the highest NCC. If best NCC < NCC_ACCEPT
       *      no watermark is found and the image is left untouched.
       *   3. If the chosen position differs from the auto-margin formula, the
       *      stamp came from Gemini's newer (video-style) variant which is
       *      blended more weakly — use GAIN_DRIFT (0.62) instead of 1.0 in
       *      the reverse-blend so the cleanup matches the lossy stamp strength.
       *
       * @param {ImageData} imageData - Modified in place.
       * @returns {object} { success, message, size, position, corner, confidence,
       *                     pixelsModified, elapsedMs, method, drifted, gainApplied }
       */
      removeWatermarkAuto(imageData, options) {
        if (!this.ready) throw new Error('Engine not ok initialized');

        // Merge user overrides over the calibrated defaults. Anything left null /
        // undefined falls back to the same constants used pre-Settings-panel, so
        // existing call sites (which pass no second arg) keep their old behavior.
        const opts = options || {};
        const nccGood        = opts.nccGood        ?? NCC_GOOD;
        const nccAccept      = opts.nccAccept      ?? NCC_ACCEPT;
        const scanStride     = opts.scanStride     ?? SCAN_STRIDE;
        const refineRadius   = opts.refineRadius   ?? REFINE_RADIUS;
        const gainDrift      = opts.gainDrift      ?? GAIN_DRIFT;
        const alphaThreshold = opts.alphaThreshold ?? ALPHA_THRESHOLD;
        const maxAlpha       = opts.maxAlpha       ?? MAX_ALPHA;
        const logoValue      = opts.logoValue      ?? this.logoValue;
        const logoVersion    = opts.logoVersion === 'new' ? 'new' : 'old';
        const rawScale       = opts.maskScale      ?? IMAGE_DEFAULTS.maskScale;
        // Clamp to the same range the UI + backend enforce; anything wilder is
        // almost certainly a bad payload and would just eat huge swaths of image.
        const maskScale      = Math.min(3, Math.max(0.5, Number(rawScale) || 1));
        // Optional user-forced position — bypasses NCC scan/refine entirely.
        // `size` picks which alpha map (48 or 96); if omitted we infer from image
        // dimensions the same way getWatermarkConfig() does.
        const forcePosition  = opts.forcePosition  || null;

        const { width, height, data } = imageData;
        const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

        // Detection runs on the calibrated base map for the selected logo version.
        const sizes = [
          { size: 96, margin: 64, alphaMap: this._baseMap(96, logoVersion) },
          { size: 48, margin: 32, alphaMap: this._baseMap(48, logoVersion) },
        ];

        let best = null;

        if (forcePosition && Number.isFinite(forcePosition.x) && Number.isFinite(forcePosition.y)) {
          // User pinned the position from the Settings panel — skip detection.
          const inferSize = forcePosition.size
            || ((width > 1024 && height > 1024) ? 96 : 48);
          const cfg = sizes.find(s => s.size === inferSize) || sizes[1];
          const cx = Math.max(0, Math.min(width  - cfg.size, Math.round(forcePosition.x)));
          const cy = Math.max(0, Math.min(height - cfg.size, Math.round(forcePosition.y)));
          const ncc = this._nccAt(data, width, height, cfg.alphaMap, cfg.size, cx, cy);
          best = {
            size: cfg.size, alphaMap: cfg.alphaMap,
            x: cx, y: cy, ncc: Math.max(ncc, nccAccept),
            autoX: width - cfg.margin - cfg.size,
            autoY: height - cfg.margin - cfg.size,
            method: 'forced',
          };
        } else {
          for (const cfg of sizes) {
            const autoX = width  - cfg.margin - cfg.size;
            const autoY = height - cfg.margin - cfg.size;
            const autoNCC = this._nccAt(data, width, height, cfg.alphaMap, cfg.size, autoX, autoY);

            let entry = {
              size: cfg.size, alphaMap: cfg.alphaMap,
              x: autoX, y: autoY, ncc: autoNCC,
              autoX, autoY, method: 'auto',
            };
            if (autoNCC < nccGood) {
              const scan = this._scanBottomRight(
                data, width, height, cfg.alphaMap, cfg.size, scanStride, refineRadius
              );
              if (scan.ncc > autoNCC) {
                entry = {
                  size: cfg.size, alphaMap: cfg.alphaMap,
                  x: scan.x, y: scan.y, ncc: scan.ncc,
                  autoX, autoY, method: 'scan',
                };
              }
            }
            if (!best || entry.ncc > best.ncc) best = entry;
          }
        }

        const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const drifted = (best.x !== best.autoX) || (best.y !== best.autoY);
        const effectiveGain = drifted ? gainDrift : 1.0;

        console.log(
          `[WatermarkEngine] detect: size=${best.size}×${best.size} pos=(${best.x},${best.y}) ` +
          `method=${best.method} ncc=${(best.ncc).toFixed(3)} logo=${logoVersion} ` +
          `gain=${effectiveGain.toFixed(2)}${drifted ? ' (drift)' : ''} ` +
          `(${(t1 - t0).toFixed(0)}ms) img=${width}×${height}`
        );

        if (best.ncc < nccAccept) {
          return {
            success: false,
            message: `No watermark detected (best NCC ${best.ncc.toFixed(3)} < ${nccAccept})`,
            confidence: Math.max(0, best.ncc),
          };
        }

        // Detection ran on the calibrated 48/96 map (best shape match). Cleanup
        // switches to the scale-enlarged map so the reverse-blend covers fringe
        // pixels the calibrated size misses. When scale > 1 we shift the top-left
        // inward by half the enlargement so the star pattern still sits over the
        // stamp we just found; when the position came from a user pin (method =
        // 'forced'), the pin IS the top-left of the enlarged mask — no shift.
        const cleanMask = this._getScaledMask(best.size, maskScale, logoVersion);
        const cleanAlphaMap = cleanMask.alphaMap;
        const cleanSize = cleanMask.size;
        const shift = best.method === 'forced'
          ? 0
          : Math.floor((cleanSize - best.size) / 2);
        const cleanX = best.x - shift;
        const cleanY = best.y - shift;

        const x1 = Math.max(0, cleanX);
        const y1 = Math.max(0, cleanY);
        const x2 = Math.min(width, cleanX + cleanSize);
        const y2 = Math.min(height, cleanY + cleanSize);
        if (x1 >= x2 || y1 >= y2) {
          return {
            success: false,
            message: 'Watermark region out of bounds',
            confidence: Math.max(0, best.ncc),
          };
        }

        let pixelsModified = 0;
        for (let row = y1; row < y2; row++) {
          for (let col = x1; col < x2; col++) {
            const ar = row - cleanY;
            const ac = col - cleanX;
            if (ar < 0 || ar >= cleanSize || ac < 0 || ac >= cleanSize) continue;

            let alpha = cleanAlphaMap[ar * cleanSize + ac] * effectiveGain;
            if (alpha < alphaThreshold) continue;
            if (alpha > maxAlpha) alpha = maxAlpha;
            const oneMinusAlpha = 1 - alpha;

            const imgIdx = (row * width + col) * 4;
            for (let c = 0; c < 3; c++) {
              const w = data[imgIdx + c];
              const original = (w - alpha * logoValue) / oneMinusAlpha;
              data[imgIdx + c] = Math.round(Math.max(0, Math.min(255, original)));
            }
            pixelsModified++;
          }
        }

        return {
          success: true,
          message: `Watermark removed (${cleanSize}×${cleanSize} at ${cleanX},${cleanY}, ${best.method}${drifted ? ', drift' : ''})`,
          // `position` reports the ACTUAL top-left of the cleanup rectangle — so
          // the Settings panel's marker and the auto-position auto-sync stay in
          // agreement with what got painted.
          position: { x: cleanX, y: cleanY },
          size: cleanSize,
          corner: 'br',
          confidence: Math.max(0, Math.min(1, best.ncc)),
          pixelsModified,
          elapsedMs: Math.round(t1 - t0),
          method: best.method,
          drifted,
          gainApplied: effectiveGain,
        };
      }
    }


    window.__erasioImageEngine = { GeminiWatermarkEngine, IMAGE_DEFAULTS };
})();
