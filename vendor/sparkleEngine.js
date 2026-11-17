// Shared sparkle-watermark engine — runs in page context
// Exposes window.__erasioSparkle, used by BOTH the image and video pipelines.
//
// The Gemini sparkle watermark is a semi-transparent white overlay in the
// bottom-right corner. Removal reverses the alpha blend per pixel:
//   original = (blended - alpha * 255) / (1 - alpha)
//
// This file is GENERATED from page/processor.js (see test/_gen_sparkle.cjs) so
// the alpha-map data stays byte-identical to the image pipeline. Do not edit
// the base64 constants by hand.

(function () {
    "use strict";

    const OVERLAY_VALUE = 255;
    const ALPHA_FLOOR = 0.002;
    const ALPHA_CEILING = 0.99;
    const SMALL_MARK_SIZE = 48;
    const LARGE_MARK_SIZE = 96;
    const LARGE_THRESHOLD = 1024;

    const ALPHA_MAP_SMALL_B64 = "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAGVElEQVR4nMVYvXIbNxD+FvKMWInXmd2dK7MTO7sj9QKWS7qy/Ab2o/gNmCp0JyZ9dHaldJcqTHfnSSF1R7kwlYmwKRYA93BHmkrseMcjgzgA++HbH2BBxhhmBiB/RYgo+hkGSFv/ZOY3b94w89u3b6HEL8JEYCYATCAi2JYiQ8xMDADGWsvMbfVagm6ZLxKGPXr0qN/vJ0mSpqn0RzuU//Wu9MoyPqxmtqmXJYwxxpiAQzBF4x8/fiyN4XDYoZLA5LfEhtg0+glMIGZY6wABMMbs4CaiR8brkYIDwGg00uuEMUTQ1MYqPBRRYZjZ+q42nxEsaYiV5VOapkmSSLvX62VZprUyM0DiQACIGLCAESIAEINAAAEOcQdD4a+2FJqmhDd/YEVkMpmEtrU2igCocNHW13swRBQYcl0enxbHpzEhKo0xSZJEgLIsC4Q5HJaJ2Qg7kKBjwMJyCDciBBcw7fjSO4tQapdi5vF43IZ+cnISdh9Y0At2RoZWFNtLsxr8N6CUTgCaHq3g+Pg4TVO1FACSaDLmgMhYC8sEQzCu3/mQjNEMSTvoDs4b+nXny5cvo4lBJpNJmKj9z81VrtNhikCgTsRRfAklmurxeKx9JZIsy548eeITKJgAQwzXJlhDTAwDgrXkxxCD2GfqgEPa4rnBOlApFUC/39fR1CmTyWQwGAQrR8TonMRNjjYpTmPSmUnC8ODgQHqSJDk7O9uNBkCv15tOp4eHh8SQgBICiCGu49YnSUJOiLGJcG2ydmdwnRcvXuwwlpYkSabTaZS1vyimc7R2Se16z58/f/jw4Z5LA8iy7NmzZ8J76CQ25F2UGsEAJjxo5194q0fn9unp6fHx8f5oRCQ1nJ+fbxtA3HAjAmCMCaGuAQWgh4eH0+k0y7LGvPiU3CVXV1fz+by+WQkCJYaImKzL6SEN6uMpjBVMg8FgOp3GfnNPQADqup79MLv59AlWn75E/vAlf20ibmWg0Pn06dPJZNLr9e6nfLu8//Ahv/gFAEdcWEsgZnYpR3uM9KRpOplMGmb6SlLX9Ww2q29WyjH8+SI+pD0GQJIkJycn/8J/I4mWjaQoijzPb25uJJsjmAwqprIsG4/HbVZ2L/1fpCiKoijKqgTRBlCWZcPhcDQafUVfuZfUdb1cLpfL5cePf9Lr16/3zLz/g9T1quNy+F2FiYjSNB0Oh8Ph8HtRtV6vi6JYLpdVVbmb8t3dnSAbjUbRNfmbSlmWeZ6XHytEUQafEo0xR0dHUdjvG2X3Sd/Fb0We56t6BX8l2mTq6BCVnqOjo7Ozs29hRGGlqqrOr40CIKqeiGg8Hn/xcri/rG/XeZ7/evnrjjGbC3V05YC/BSRJ8urVq36/3zX7Hjaq63o+n19fX/upUqe5VxFok7UBtQ+T6XQ6GAz2Vd6Ssizn8/nt7a3ay1ZAYbMN520XkKenpx0B2E2SLOo+FEWxWPwMgMnC3/adejZMYLLS42r7oH4LGodpsVgURdHQuIcURbFYLDYlVKg9sCk5wpWNiHym9pUAEQGG6EAqSxhilRQWi0VZVmrz23yI5cPV1dX5TwsmWGYrb2TW36OJGjdXhryKxEeHvjR2Fgzz+bu6XnVgaHEmXhytEK0W1aUADJPjAL6CtPZv5rsGSvUKtv7r8/zdj+v1uoOUpsxms7qunT6+g1/TvTQCxE6XR2kBqxjyZo6K66gsAXB1fZ3neQdJSvI8X61WpNaMWCFuKNrkGuGGmMm95fhpvPkn/f6lAgAuLy/LstyGpq7r9+8d4rAr443qaln/ehHt1siv3dvt2B/RDpJms5lGE62gEy9az0XGcQCK3DL4DTPr0pPZEjPAZVlusoCSoihWqzpCHy7ODRXhbUTJly9oDr4fKDaV9NZJUrszPOjsI0a/FzfwNt4eHH+BSyICqK7rqqo0u0VRrFYridyN87L3pBYf7qvq3wqc3DMldJmiK06pgi8uLqQjAAorRG+p+zLUxks+z7rOkOzlIUy8yrAcQFVV3a4/ywBPmJsVMcTM3l/h9xDlLga4I1PDGaD7UNBPuCKBleUfy2gd+DOrPWubGHJJyD+L+LCTjEXEgH//2uSxhu1/Xzocy+VSL+2cUhrqLVZ/jTYL0IMtQEklT3/iWCutzUljDDNXVSVHRFWW7SOtccHag6V/AF1/slVRyOkZAAAAAElFTkSuQmCC";
    const ALPHA_MAP_LARGE_B64 = "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";

    const alphaMapCache = new Map();

    async function decodeAlphaMap(side) {
        if (alphaMapCache.has(side)) return alphaMapCache.get(side);
        const b64 = side === LARGE_MARK_SIZE ? ALPHA_MAP_LARGE_B64 : ALPHA_MAP_SMALL_B64;
        const raw = atob(b64.replace(/\s+/g, ""));
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const cvs = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = cvs.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, bmp.width, bmp.height);
        bmp.close();
        const count = px.width * px.height;
        const values = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const o = i * 4;
            values[i] = Math.max(px.data[o], px.data[o + 1], px.data[o + 2]) / 255;
        }
        const result = { values, side: px.width };
        alphaMapCache.set(side, result);
        return result;
    }

    // Decode an alpha map scaled to an arbitrary square size. Used for video
    // calibration, where the watermark may render at a different pixel size
    // than the fixed 48/96 image marks. `which` is "small" | "large".
    async function decodeAlphaMapAt(which, targetSize) {
        targetSize = Math.max(8, Math.round(targetSize));
        const key = which + "@" + targetSize;
        if (alphaMapCache.has(key)) return alphaMapCache.get(key);
        const b64 = which === "large" ? ALPHA_MAP_LARGE_B64 : ALPHA_MAP_SMALL_B64;
        const raw = atob(b64.replace(/\s+/g, ""));
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const cvs = new OffscreenCanvas(targetSize, targetSize);
        const ctx = cvs.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(bmp, 0, 0, targetSize, targetSize);
        const px = ctx.getImageData(0, 0, targetSize, targetSize);
        bmp.close();
        const count = targetSize * targetSize;
        const values = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const o = i * 4;
            values[i] = Math.max(px.data[o], px.data[o + 1], px.data[o + 2]) / 255;
        }
        const result = { values, side: targetSize };
        alphaMapCache.set(key, result);
        return result;
    }

    function selectMarkParams(w, h) {
        const isLarge = w > LARGE_THRESHOLD && h > LARGE_THRESHOLD;
        return { side: isLarge ? LARGE_MARK_SIZE : SMALL_MARK_SIZE, margin: isLarge ? 64 : 32 };
    }

    function computeMarkRegion(w, h, side, margin) {
        return { x: w - margin - side, y: h - margin - side, w: side, h: side };
    }

    // Scan the bottom-right corner for the margin maximising weighted brightness
    // (high alpha coinciding with bright pixels), in 4px steps.
    function findBestRegion(imageData, alphaMap, side, nominalMargin) {
        const { width, height, data } = imageData;
        const maxMargin = Math.min(nominalMargin + 96, Math.floor(Math.min(width, height) * 0.3));
        let bestScore = -Infinity;
        let best = computeMarkRegion(width, height, side, nominalMargin);
        for (let m = 0; m <= maxMargin; m += 4) {
            const posX = width - m - side, posY = height - m - side;
            if (posX < 0 || posY < 0) continue;
            if (posX + side > width || posY + side > height) continue;
            let score = 0;
            for (let row = 0; row < side; row++) {
                for (let col = 0; col < side; col++) {
                    const a = alphaMap.values[row * side + col];
                    if (a < 0.1) continue;
                    const idx = ((posY + row) * width + (posX + col)) * 4;
                    const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3.0;
                    score += a * b;
                }
            }
            if (score > bestScore) { bestScore = score; best = { x: posX, y: posY, w: side, h: side }; }
        }
        return best;
    }

    // Reverse-blend a region in-place on a full-frame ImageData.
    //   original = (blended - alphaEff * overlay) / (1 - alphaEff)
    // where alphaEff = min(alpha * gain, ceiling).
    //
    // opts (all optional; defaults reproduce the original image-pipeline math):
    //   overlay  — overlay colour value, default 255 (pure white).
    //              Accepts a number, or [r,g,b] for a tinted watermark.
    //   gain     — multiplier on the alpha map, default 1.0. Lower if the video
    //              watermark is more transparent than the map assumes.
    //   ceiling  — cap on effective alpha, default 0.99. Lower (e.g. 0.9) to
    //              tame the divide-by-(1-α) blow-up that darkens the bright core.
    //   floor    — skip pixels below this alpha, default 0.002.
    function removeRegion(imageData, region, alphaMap, opts) {
        opts = opts || {};
        const overlay = opts.overlay != null ? opts.overlay : OVERLAY_VALUE;
        const ov = Array.isArray(overlay) ? overlay : [overlay, overlay, overlay];
        const gain = opts.gain != null ? opts.gain : 1.0;
        const ceiling = opts.ceiling != null ? opts.ceiling : ALPHA_CEILING;
        const floor = opts.floor != null ? opts.floor : ALPHA_FLOOR;

        const { data, width, height } = imageData;
        const sx = Math.max(0, region.x), sy = Math.max(0, region.y);
        const ex = Math.min(width, region.x + region.w), ey = Math.min(height, region.y + region.h);
        if (sx >= ex || sy >= ey) return;
        for (let row = sy; row < ey; row++) {
            const mapRow = (row - region.y) * region.w;
            for (let col = sx; col < ex; col++) {
                const a = alphaMap.values[mapRow + (col - region.x)];
                if (a < floor) continue;
                const cl = Math.min(a * gain, ceiling);
                const d = 1 - cl;
                if (d <= 0) continue;
                const idx = (row * width + col) * 4;
                for (let ch = 0; ch < 3; ch++) {
                    const v = (data[idx + ch] - cl * ov[ch]) / d;
                    data[idx + ch] = Math.max(0, Math.min(255, Math.round(v)));
                }
            }
        }
    }

    // Inpaint the watermark region by smoothly filling masked pixels from the
    // surrounding image (Laplace / Gauss-Seidel diffusion). Unlike reverse
    // alpha-blend, this is robust to lossy-video pixel noise — it doesn't try
    // to recover the exact original, it reconstructs a clean fill from the
    // neighbourhood, which is invisible on smooth/blurry backgrounds.
    //
    // opts: { threshold=0.10, dilate=2, iterations=120 }
    function inpaintRegion(imageData, region, alphaMap, opts) {
        opts = opts || {};
        const threshold = opts.threshold != null ? opts.threshold : 0.10;
        const dilate = opts.dilate != null ? opts.dilate : 2;
        const iterations = opts.iterations != null ? opts.iterations : 120;
        const { data, width, height } = imageData;

        const rx = Math.max(0, region.x), ry = Math.max(0, region.y);
        const ex = Math.min(width, region.x + region.w), ey = Math.min(height, region.y + region.h);
        const rw = ex - rx, rh = ey - ry;
        if (rw <= 0 || rh <= 0) return;

        // Mask = pixels covered by the watermark alpha (region-local coords).
        let mask = new Uint8Array(rw * rh);
        for (let r = 0; r < rh; r++) {
            for (let c = 0; c < rw; c++) {
                const mapIdx = (r + (ry - region.y)) * region.w + (c + (rx - region.x));
                if ((alphaMap.values[mapIdx] || 0) > threshold) mask[r * rw + c] = 1;
            }
        }
        // Dilate to also cover the anti-aliased halo around the mark.
        for (let d = 0; d < dilate; d++) {
            const copy = mask.slice();
            for (let r = 0; r < rh; r++) {
                for (let c = 0; c < rw; c++) {
                    if (copy[r * rw + c]) continue;
                    if ((r > 0 && copy[(r - 1) * rw + c]) || (r < rh - 1 && copy[(r + 1) * rw + c]) ||
                        (c > 0 && copy[r * rw + c - 1]) || (c < rw - 1 && copy[r * rw + c + 1])) {
                        mask[r * rw + c] = 1;
                    }
                }
            }
        }

        // Gauss-Seidel diffusion: each masked pixel becomes the average of its
        // 4 neighbours. Unmasked neighbours (real image pixels just outside the
        // mark) act as fixed boundary conditions, so the fill blends seamlessly.
        for (let it = 0; it < iterations; it++) {
            for (let r = 0; r < rh; r++) {
                for (let c = 0; c < rw; c++) {
                    if (!mask[r * rw + c]) continue;
                    const gx = rx + c, gy = ry + r;
                    const idx = (gy * width + gx) * 4;
                    for (let ch = 0; ch < 3; ch++) {
                        let sum = 0, n = 0;
                        if (gx > 0) { sum += data[idx - 4 + ch]; n++; }
                        if (gx < width - 1) { sum += data[idx + 4 + ch]; n++; }
                        if (gy > 0) { sum += data[idx - width * 4 + ch]; n++; }
                        if (gy < height - 1) { sum += data[idx + width * 4 + ch]; n++; }
                        if (n) data[idx + ch] = sum / n;
                    }
                }
            }
        }
    }

    // ---- NCC-based detection (multi-size, scale/brightness-invariant) ----
    //
    // The legacy findBestRegion / findBestRegionFine scans use raw
    // brightness × alpha as the score, which works on static images but
    // fails on real video frames — any bright background patch in the
    // bottom-right corner outscores the actual semi-transparent sparkle.
    //
    // NCC (Normalized Cross-Correlation) compares the *shape* of the alpha
    // map against the *shape* of the local brightness pattern, after
    // subtracting per-region means and dividing by standard deviations. It
    // doesn't care whether the surrounding pixels are bright or dim — only
    // whether the spatial pattern of brights matches the sparkle template.
    //
    //   NCC = (mean(α·gray) − mean(α)·mean(gray)) / (σ_α · σ_gray)   ∈ [-1, 1]
    //
    // ~+1 = strong shape match, ~0 = uncorrelated. We sweep candidate top-
    // left positions over the bottom-right quadrant on a coarse stride,
    // then refine the winner pixel-by-pixel.
    //
    // Detection thresholds (tuned to match the standalone test page; video
    // frames are lossy so they're a notch more permissive than the image
    // engine's static thresholds).
    const NCC_GOOD = 0.45;       // accept the "auto" anchor position outright
    const NCC_ACCEPT = 0.30;     // absolute floor: below this → low-confidence
    // The detected winner must beat the hardcoded-fallback position's
    // NCC by AT LEAST this much before we override the fallback. The
    // fallback is a known-correct Gemini position, so a marginal NCC
    // win elsewhere (e.g. a bright reflection on armor / glossy
    // surface) shouldn't be enough to displace it — only a clear,
    // unambiguous match should.
    const NCC_FALLBACK_MARGIN = 0.10;
    const SCAN_STRIDE = 8;       // coarse-scan step (px)
    const REFINE_RADIUS = 8;     // px around the coarse winner to refine 1-px

    // Candidate (size, margin) pairs to try. Each one anchors at the
    // Gemini-default offset from the bottom-right corner; if that NCC is
    // weak we scan the whole bottom-right quadrant for that size. The
    // detector picks whichever size scored highest across all candidates.
    // All sizes use the 720p alpha shape — the 1080p elongated shape will
    // be added in a future iteration.
    const TRY_SIZES = [
        { side: 144, margin: 96 },
        { side: 96,  margin: 64 },
        { side: 48,  margin: 32 },
    ];

    function nccAt(data, w, h, alphaValues, side, x, y) {
        if (x < 0 || y < 0 || x + side > w || y + side > h) return -1;
        let sP = 0, sA = 0, sA2 = 0, sG = 0, sG2 = 0, n = 0;
        for (let row = 0; row < side; row++) {
            const imgRow = (y + row) * w;
            const aRow = row * side;
            for (let col = 0; col < side; col++) {
                const i = (imgRow + (x + col)) * 4;
                const gray = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
                const a = alphaValues[aRow + col];
                sP += a * gray; sA += a; sA2 += a * a;
                sG += gray; sG2 += gray * gray;
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

    // Coarse scan of the bottom-right quadrant, then a 1-px refinement
    // window around the coarse winner. Returns { x, y, ncc }.
    function scanBottomRightNCC(data, w, h, alphaValues, side, stride, refine) {
        const xStart = Math.max(0, Math.floor(w * 0.5));
        const yStart = Math.max(0, Math.floor(h * 0.5));
        const xEnd = w - side, yEnd = h - side;
        if (xEnd < xStart || yEnd < yStart) return { x: -1, y: -1, ncc: -1 };

        let best = { x: xStart, y: yStart, ncc: -1 };
        for (let y = yStart; y <= yEnd; y += stride) {
            for (let x = xStart; x <= xEnd; x += stride) {
                const v = nccAt(data, w, h, alphaValues, side, x, y);
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
                    const v = nccAt(data, w, h, alphaValues, side, x, y);
                    if (v > r.ncc) r = { x, y, ncc: v };
                }
            }
            best = r;
        }
        return best;
    }

    // Pre-rasterise every candidate alpha map. Returns an array of
    //   { side, which, margin, alphaMap: { values, side } }
    // suitable for repeated SYNC detection passes via
    // detectWatermarkNCCFromMaps. Callers should await this once before
    // entering the streaming decode loop — the decoder's output() callback
    // is sync, so it can't await alpha-map rasterisation on the hot path.
    // Image-element + regular canvas loader. Mirrors the test page at
    // public/test-watermark-videos.html — that path has been verified to
    // work in every context we care about, while createImageBitmap +
    // OffscreenCanvas can throw a generic DOMException in some popup /
    // build configurations. Page-context scripts also have access to
    // `document`, so this works for both popup and injected paths.
    function loadAlphaImage(b64) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("alpha PNG failed to decode (Image.onerror)"));
            img.src = "data:image/png;base64," + b64;
        });
    }

    async function rasterizeAlphaCompat(b64, targetSize) {
        if (typeof document === "undefined") {
            throw new Error("rasterizeAlphaCompat requires a DOM (document.createElement)");
        }
        const img = await loadAlphaImage(b64);
        const cvs = document.createElement("canvas");
        cvs.width = targetSize;
        cvs.height = targetSize;
        const ctx = cvs.getContext("2d");
        if (!ctx) throw new Error("canvas.getContext('2d') returned null");
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(img, 0, 0, targetSize, targetSize);
        const px = ctx.getImageData(0, 0, targetSize, targetSize);
        const count = targetSize * targetSize;
        const values = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const o = i * 4;
            values[i] = Math.max(px.data[o], px.data[o + 1], px.data[o + 2]) / 255;
        }
        return { values, side: targetSize };
    }

    async function loadDetectionMaps() {
        const out = [];
        const failures = [];
        for (const cfg of TRY_SIZES) {
            const which = cfg.side <= 48 ? "small" : "large";
            const b64 = which === "large" ? ALPHA_MAP_LARGE_B64 : ALPHA_MAP_SMALL_B64;
            try {
                const alphaMap = await rasterizeAlphaCompat(b64, cfg.side);
                out.push({ side: cfg.side, which, margin: cfg.margin, alphaMap });
            } catch (e) {
                failures.push(`${which}@${cfg.side}: ${e?.name || "Error"} ${e?.message || e}`);
            }
        }
        if (out.length === 0) {
            throw new Error("All detection maps failed to load — " + failures.join("; "));
        }
        if (failures.length) {
            console.warn("[Erasio] Some detection maps failed to load:", failures.join("; "));
        }
        return out;
    }

    // Synchronous detection with HARDCODED-FIRST ordering. Callable from
    // inside a VideoDecoder output() handler.
    //
    // Order:
    //   1. Score the hardcoded fallback position with its own alpha map.
    //      If it correlates strongly (≥ NCC_GOOD) accept it outright and
    //      skip the expensive multi-size scan.
    //   2. Otherwise run the multi-size NCC scan.
    //   3. Score the fallback again using the scan winner's alpha so the
    //      two NCCs are directly comparable.
    //   4. Accept the scan winner if it clears NCC_ACCEPT AND beats the
    //      fallback by NCC_FALLBACK_MARGIN.
    //   5. Otherwise return the hardcoded fallback as a last resort.
    //
    // opts.fallback: { x, y, side, which, alphaMap }
    //
    // Result shape:
    //   {
    //     best: { side, which, x, y, ncc, method, alphaMap },
    //     candidates: [ ... per-size scan results, empty if scan skipped ... ],
    //     accepted: boolean,
    //     usingFallback: boolean,
    //     fallbackNCC: number|null,
    //     rejectReason: string|null,
    //     drifted: boolean,
    //     elapsedMs: number,
    //   }
    function detectWatermarkNCCFromMaps(imageData, maps, opts) {
        opts = opts || {};
        const fallback = opts.fallback || null;
        const { width: w, height: h, data } = imageData;
        const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
        const elapsed = () => Math.round(
            (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0,
        );

        // STEP 1 — score the hardcoded fallback first with its OWN
        // alpha map. If it correlates strongly the watermark really is
        // there and there's no point running the multi-size scan.
        let fallbackNCC = null;
        if (fallback && fallback.alphaMap) {
            const v = nccAt(
                data, w, h,
                fallback.alphaMap.values, fallback.side,
                fallback.x, fallback.y,
            );
            if (v >= 0) fallbackNCC = v;
        }
        if (fallbackNCC != null && fallbackNCC >= NCC_GOOD) {
            return {
                best: {
                    side: fallback.side,
                    which: fallback.which || "fallback",
                    x: fallback.x, y: fallback.y,
                    ncc: fallbackNCC,
                    method: "fallback-direct",
                    alphaMap: fallback.alphaMap,
                },
                candidates: [],
                accepted: true,
                usingFallback: true,
                fallbackNCC,
                rejectReason: null,
                drifted: false,
                elapsedMs: elapsed(),
            };
        }

        // STEP 2 — fallback didn't score well; run the multi-size scan.
        const candidates = [];
        for (const cfg of maps) {
            const map = cfg.alphaMap;
            const autoX = w - cfg.margin - cfg.side;
            const autoY = h - cfg.margin - cfg.side;
            const autoNCC = nccAt(data, w, h, map.values, cfg.side, autoX, autoY);
            let entry = {
                side: cfg.side, which: cfg.which,
                x: autoX, y: autoY, ncc: autoNCC,
                autoX, autoY, method: "auto",
                alphaMap: map,
            };
            if (autoNCC < NCC_GOOD) {
                const scan = scanBottomRightNCC(
                    data, w, h, map.values, cfg.side, SCAN_STRIDE, REFINE_RADIUS,
                );
                if (scan.ncc > autoNCC) {
                    entry = {
                        side: cfg.side, which: cfg.which,
                        x: scan.x, y: scan.y, ncc: scan.ncc,
                        autoX, autoY, method: "scan",
                        alphaMap: map,
                    };
                }
            }
            candidates.push(entry);
        }
        const scanBest = candidates.reduce((a, b) => (b.ncc > a.ncc ? b : a));
        const drifted = (scanBest.x !== scanBest.autoX) || (scanBest.y !== scanBest.autoY);

        // STEP 3 — compare scan winner against fallback (scoring the
        // fallback position with the scan winner's alpha for an
        // apples-to-apples NCC comparison).
        let scanFallbackNCC = null;
        let rejectReason = null;
        if (fallback) {
            const v = nccAt(
                data, w, h,
                scanBest.alphaMap.values, scanBest.side,
                fallback.x, fallback.y,
            );
            if (v >= 0) {
                scanFallbackNCC = v;
                if (scanBest.ncc < scanFallbackNCC + NCC_FALLBACK_MARGIN) {
                    rejectReason =
                        `scan winner did not beat fallback by margin ` +
                        `(scan=${scanBest.ncc.toFixed(3)} vs fallback=${scanFallbackNCC.toFixed(3)}, ` +
                        `need +${NCC_FALLBACK_MARGIN})`;
                }
            }
        }
        if (scanBest.ncc < NCC_ACCEPT && !rejectReason) {
            rejectReason = `scan best ncc=${scanBest.ncc.toFixed(3)} < ${NCC_ACCEPT}`;
        }

        // STEP 4 — accept the scan winner.
        if (!rejectReason) {
            return {
                best: scanBest,
                candidates,
                accepted: true,
                usingFallback: false,
                fallbackNCC: scanFallbackNCC != null ? scanFallbackNCC : fallbackNCC,
                rejectReason: null,
                drifted,
                elapsedMs: elapsed(),
            };
        }

        // STEP 5 — scan rejected; rescue with the hardcoded fallback.
        if (fallback && fallback.alphaMap) {
            return {
                best: {
                    side: fallback.side,
                    which: fallback.which || "fallback",
                    x: fallback.x, y: fallback.y,
                    ncc: fallbackNCC != null ? fallbackNCC : 0,
                    method: "fallback-rescue",
                    alphaMap: fallback.alphaMap,
                },
                candidates,
                accepted: true,
                usingFallback: true,
                fallbackNCC,
                rejectReason,
                drifted: false,
                elapsedMs: elapsed(),
            };
        }

        // STEP 6 — no fallback available and scan was rejected.
        return {
            best: scanBest,
            candidates,
            accepted: false,
            usingFallback: false,
            fallbackNCC: scanFallbackNCC,
            rejectReason,
            drifted,
            elapsedMs: elapsed(),
        };
    }

    // Async convenience wrapper — loads maps then runs detection in one
    // call. Useful for callers that aren't in a streaming hot-path.
    async function detectWatermarkNCC(imageData) {
        const maps = await loadDetectionMaps();
        return detectWatermarkNCCFromMaps(imageData, maps);
    }

    // Fine-grained corner scan: tries every (dx,dy) offset around the
    // bottom-right corner in `step` increments, for a given alpha map, and
    // returns the best-correlated top-left position. More precise than
    // findBestRegion (which only varies a single diagonal margin).
    function findBestRegionFine(imageData, alphaMap, side, maxOffset, step) {
        const { width, height, data } = imageData;
        step = step || 2;
        maxOffset = maxOffset || Math.round(side * 1.5);
        let bestScore = -Infinity;
        let best = { x: width - side, y: height - side, w: side, h: side };
        for (let dy = 0; dy <= maxOffset; dy += step) {
            for (let dx = 0; dx <= maxOffset; dx += step) {
                const posX = width - side - dx, posY = height - side - dy;
                if (posX < 0 || posY < 0) continue;
                let score = 0;
                for (let row = 0; row < side; row += 2) {
                    for (let col = 0; col < side; col += 2) {
                        const a = alphaMap.values[row * side + col];
                        if (a < 0.1) continue;
                        const idx = ((posY + row) * width + (posX + col)) * 4;
                        const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3.0;
                        score += a * b;
                    }
                }
                if (score > bestScore) { bestScore = score; best = { x: posX, y: posY, w: side, h: side }; }
            }
        }
        return best;
    }

    window.__erasioSparkle = {
        SMALL_MARK_SIZE, LARGE_MARK_SIZE,
        NCC_GOOD, NCC_ACCEPT,
        decodeAlphaMap, decodeAlphaMapAt, selectMarkParams,
        findBestRegion, findBestRegionFine, removeRegion, inpaintRegion,
        nccAt, scanBottomRightNCC,
        loadDetectionMaps, detectWatermarkNCCFromMaps, detectWatermarkNCC,
    };
    console.log("[Erasio] Sparkle engine ready");
})();
