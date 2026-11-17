// Veo wordmark ("Veo" text) video watermark removal.
//
// This is a SEPARATE watermark from the Gemini/Omni sparkle that
// page/videoProcessor.js removes on its own. Nothing here changes that engine:
// we reuse its demux → decode → inverse-alpha → encode pipeline through the
// optional `detector` hook on __purifyVideo, supplying our own rectangular
// mask + position instead of the sparkle's square mask + offset scoring.
//
// Detection is a port of the NCC template matcher from the MIT-licensed
// gemini-watermark-remover runtime (video/veoTextWatermarkDetector.js), the
// same one behind erasio.io/veo-and-omni-watermark-remover. Cleanup uses this
// extension's existing edge-diffusion inpaint rather than the site's FDnCNN
// model, to keep the package small.
//
// Requires: page/veoTextTemplates.js, page/videoProcessor.js
// Exposes:  window.__purifyVeoVideo(arrayBuffer, options) -> Blob
(function () {
    "use strict";
    if (window.__purifyVeoVideo) return;

    const TAG = "[Erasio Veo]";

    // Upstream detector constants (veoTextWatermarkDetector.js).
    const ACTIVE_THRESHOLD = 0.02;      // ignore near-transparent stamp pixels
    const MARGIN_RADIUS_MIN = 4;        // upstream DEFAULT_MARGIN_RADIUS_MIN
    const MARGIN_RADIUS_SCALE = 0.35;   // upstream DEFAULT_MARGIN_RADIUS_SCALE
    // Detection needs only a few frames; the per-pixel alpha measurement wants
    // more. __decodeVideoFrames grabs them all in ONE decode pass, so this list
    // costs less than the four separate decodeFrameAt calls it replaces.
    const CALIBRATION_FRACTIONS = [0.10, 0.18, 0.26, 0.34, 0.42, 0.50,
                                   0.58, 0.66, 0.74, 0.82];

    function lumaAt(data, idx) {
        return 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
    }

    // Zero-mean normalised cross-correlation between the stamp and the frame
    // region, over the stamp's active pixels only. Mean-centring is what makes
    // this robust to the arbitrary background the wordmark sits on.
    function correlate(imageData, alphaMap, x, y, w, h) {
        if (x < 0 || y < 0 || x + w > imageData.width || y + h > imageData.height) return 0;

        let imageSum = 0, templateSum = 0, count = 0;
        for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
                const t = alphaMap[row * w + col] || 0;
                if (Math.abs(t) <= ACTIVE_THRESHOLD) continue;
                imageSum += lumaAt(imageData.data, ((y + row) * imageData.width + x + col) * 4);
                templateSum += t;
                count++;
            }
        }
        if (count <= 1) return 0;

        const imageMean = imageSum / count;
        const templateMean = templateSum / count;
        let numerator = 0, imageEnergy = 0, templateEnergy = 0;
        for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
                const t = alphaMap[row * w + col] || 0;
                if (Math.abs(t) <= ACTIVE_THRESHOLD) continue;
                const di = lumaAt(imageData.data, ((y + row) * imageData.width + x + col) * 4) - imageMean;
                const dt = t - templateMean;
                numerator += di * dt;
                imageEnergy += di * di;
                templateEnergy += dt * dt;
            }
        }
        const denominator = Math.sqrt(imageEnergy * templateEnergy);
        return denominator > 0 ? numerator / denominator : 0;
    }

    function integerRange(center, radius, min, max) {
        const out = [];
        for (let v = center - radius; v <= center + radius; v++) {
            if (v >= min && v <= max) out.push(v);
        }
        return out.length ? out : [Math.min(Math.max(center, min), max)];
    }

    // Faithful port of resolveVeoTextSearchCandidates() from the upstream
    // runtime: each template at its NATIVE size, anchored at its nominal
    // bottom-right margin, plus a small search box around that.
    //
    // An earlier version of this file replaced the below with a multi-scale
    // search over every size and inset. That was a mistake on two counts: it is
    // not what the site does, and on a real 1280x720 clip it ran ~800M
    // correlations (hanging the page) while still missing a wordmark upstream
    // finds at the nominal margin with ncc 0.82. Match upstream; do not invent.
    function buildCandidates(width, height) {
        const templates = window.__erasioVeoTextTemplates.getTemplates();
        const candidates = [];
        for (const t of templates) {
            if (t.width > width || t.height > height) continue;
            const radius = Math.max(
                MARGIN_RADIUS_MIN,
                Math.round(Math.min(t.width, t.height) * MARGIN_RADIUS_SCALE)
            );
            const rights = integerRange(t.marginRight, radius, 0, width - t.width);
            const bottoms = integerRange(t.marginBottom, radius, 0, height - t.height);
            for (const mr of rights) {
                for (const mb of bottoms) {
                    const x = width - mr - t.width;
                    const y = height - mb - t.height;
                    if (x < 0 || y < 0 || x + t.width > width || y + t.height > height) continue;
                    candidates.push({ template: t, x, y });
                }
            }
        }
        return candidates;
    }

    /**
     * On a failed detection, print enough to tell the three failure modes apart
     * without another round trip:
     *   - frames are blank/black      -> decode problem, not matching
     *   - nominal NCC is high         -> threshold or averaging problem
     *   - nominal NCC is low but the
     *     mark is visible on screen   -> wrong size/position for these templates
     */
    function logDeclineDiagnostics(frames, width, height) {
        try {
            const img = frames[0];
            // Sanity: is the bottom-right corner actually image data?
            const bw = Math.min(200, width), bh = Math.min(120, height);
            const bx = width - bw, by = height - bh;
            let min = 255, max = 0, sum = 0, n = 0;
            for (let y = by; y < height; y++) {
                for (let x = bx; x < width; x++) {
                    const l = lumaAt(img.data, (y * width + x) * 4);
                    if (l < min) min = l;
                    if (l > max) max = l;
                    sum += l; n++;
                }
            }
            console.warn(TAG, `diagnostics — frames=${frames.length} ${width}x${height}; ` +
                `bottom-right ${bw}x${bh} luma min=${min.toFixed(0)} max=${max.toFixed(0)} mean=${(sum / n).toFixed(1)}` +
                (max - min < 4 ? "  <-- REGION IS FLAT: decoded frames look blank" : ""));

            for (const t of window.__erasioVeoTextTemplates.getTemplates()) {
                if (t.width > width || t.height > height) continue;
                const x = width - t.marginRight - t.width;
                const y = height - t.marginBottom - t.height;
                const perFrame = frames.map((f) => correlate(f, t.detectorMap, x, y, t.width, t.height).toFixed(3));
                console.warn(TAG, `  ${t.id} at nominal (${x},${y}) per-frame ncc=[${perFrame.join(", ")}] (need >= ${t.minNcc})`);
            }
        } catch (e) {
            console.warn(TAG, "diagnostics failed", e);
        }
    }

    function median(values) {
        if (!values.length) return NaN;
        const s = values.slice().sort((a, b) => a - b);
        return s[s.length >> 1];
    }

    /**
     * Measure the wordmark's ACTUAL composite alpha from the frames.
     *
     * The mark is white text alpha-blended over the picture, so for a pixel
     * whose template weight is t:   W = (t*A)*255 + (1 - t*A)*B
     * giving                        A = (W - B) / ((255 - B) * t)
     * with B taken from a ring just outside the stamp.
     *
     * This matters because upstream's BASE_ALPHA_GAIN (0.18) is tuned for a
     * pipeline that follows the un-blend with an FDnCNN denoise pass to mop up
     * whatever is left. We deliberately don't ship that model, so the un-blend
     * has to do the whole job — and at 0.18 against a real ~0.52 mark it removes
     * only about a third, leaving the wordmark plainly visible.
     *
     * Measured on real Flow 720p frames: residue falls from 3.7x the local noise
     * floor at 0.18 to 1.2x at the measured alpha, and rises again past it.
     */
    function estimatePeakAlpha(frames, template, x, y) {
        const TW = template.width, TH = template.height;
        const core = [];
        for (let dy = 0; dy < TH; dy++) {
            for (let dx = 0; dx < TW; dx++) {
                if (template.detectorMap[dy * TW + dx] >= 0.85) core.push([dx, dy]);
            }
        }
        if (core.length < 4) return NaN;

        const perFrame = [];
        for (const img of frames) {
            const W = img.width, H = img.height;

            // Local background: ring outside the stamp, ignoring the stamp itself.
            const ring = [];
            for (let dy = -8; dy < TH + 8; dy++) {
                for (let dx = -8; dx < TW + 8; dx++) {
                    if (dx >= 0 && dx < TW && dy >= 0 && dy < TH) continue;
                    const px = x + dx, py = y + dy;
                    if (px < 0 || py < 0 || px >= W || py >= H) continue;
                    ring.push(lumaAt(img.data, (py * W + px) * 4));
                }
            }
            const B = median(ring);
            if (!Number.isFinite(B) || B >= 250) continue;   // blown-out background: unusable

            const est = [];
            for (const [dx, dy] of core) {
                const px = x + dx, py = y + dy;
                if (px < 0 || py < 0 || px >= W || py >= H) continue;
                const t = template.detectorMap[dy * TW + dx];
                const denom = (255 - B) * t;
                if (denom > 1) est.push((lumaAt(img.data, (py * W + px) * 4) - B) / denom);
            }
            const a = median(est);
            if (Number.isFinite(a)) perFrame.push(a);
        }
        return median(perFrame);
    }

    /**
     * Measure the wordmark's alpha stamp PER PIXEL from this clip's own frames.
     *
     * Same solve as estimatePeakAlpha, but per pixel and with a smooth
     * background model: the clean luma just outside each side of the stamp box
     * is blended by inverse-square distance to estimate B under the glyph.
     * Median across frames, so a frame whose background is busy right at the
     * mark doesn't drag the result.
     *
     * This beats the upstream template because that template is a render of the
     * wordmark at a different size/hinting than Flow actually emits. Measured
     * held-out (calibrate on one frame set, score on a disjoint one):
     *   upstream template          0.90x the local noise floor
     *   measured from 24 frames    0.80x
     *
     * Returns null when the measurement looks untrustworthy — the caller then
     * keeps the upstream template.
     */
    function refineAlphaStamp(frames, template, x, y) {
        const TW = template.width, TH = template.height;
        const DEPTH = 3;
        const samples = new Array(TW * TH);
        for (let i = 0; i < samples.length; i++) samples[i] = [];

        for (const img of frames) {
            const W = img.width, H = img.height;
            if (x < 1 || y < 1 || x + TW + 1 > W || y + TH + 1 > H) continue;
            const at = (px, py) => lumaAt(img.data, (py * W + px) * 4);

            // Clean luma just outside each edge of the stamp.
            const left = [], right = [], top = [], bottom = [];
            for (let dy = 0; dy < TH; dy++) {
                const l = [], r = [];
                for (let k = 0; k < DEPTH; k++) {
                    if (x - 1 - k >= 0) l.push(at(x - 1 - k, y + dy));
                    if (x + TW + k < W) r.push(at(x + TW + k, y + dy));
                }
                left.push(median(l)); right.push(median(r));
            }
            for (let dx = 0; dx < TW; dx++) {
                const t = [], b = [];
                for (let k = 0; k < DEPTH; k++) {
                    if (y - 1 - k >= 0) t.push(at(x + dx, y - 1 - k));
                    if (y + TH + k < H) b.push(at(x + dx, y + TH + k));
                }
                top.push(median(t)); bottom.push(median(b));
            }

            for (let dy = 0; dy < TH; dy++) {
                for (let dx = 0; dx < TW; dx++) {
                    let num = 0, den = 0;
                    const sides = [
                        [left[dy], dx + 1], [right[dy], TW - dx],
                        [top[dx], dy + 1], [bottom[dx], TH - dy],
                    ];
                    for (const [val, dist] of sides) {
                        if (!Number.isFinite(val)) continue;
                        const w = 1 / (dist * dist);
                        num += val * w; den += w;
                    }
                    if (den <= 0) continue;
                    const B = num / den;
                    if (B >= 250) continue;                      // blown out: unusable
                    const a = (at(x + dx, y + dy) - B) / (255 - B);
                    if (a >= -0.2 && a <= 1.2) samples[dy * TW + dx].push(a);
                }
            }
        }

        const out = new Float32Array(TW * TH);
        let peak = 0, measured = 0;
        for (let i = 0; i < out.length; i++) {
            if (!samples[i].length) continue;
            measured++;
            const v = Math.max(0, Math.min(0.99, median(samples[i])));
            out[i] = v;
            if (v > peak) peak = v;
        }

        // Guards: enough coverage, a sane peak, and a shape that still looks
        // like the wordmark we matched. Without the last check a busy background
        // could hand back noise that removes the wrong pixels.
        if (measured < out.length * 0.8) return null;
        if (!(peak >= 0.05 && peak <= 0.95)) return null;
        const shapeNcc = correlateMaps(out, template.detectorMap);
        if (!(shapeNcc >= 0.5)) return null;
        return { values: out, peak, shapeNcc };
    }

    // Plain zero-mean NCC between two equal-length maps.
    function correlateMaps(a, b) {
        const n = a.length;
        if (!n || b.length !== n) return 0;
        let ma = 0, mb = 0;
        for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
        ma /= n; mb /= n;
        let num = 0, ea = 0, eb = 0;
        for (let i = 0; i < n; i++) {
            const da = a[i] - ma, db = b[i] - mb;
            num += da * db; ea += da * da; eb += db * db;
        }
        const den = Math.sqrt(ea * eb);
        return den > 0 ? num / den : 0;
    }

    // Zero-alpha margin added around the stamp before removal.
    //
    // inpaintFrame's edge diffusion averages each treated pixel from its
    // UNtreated neighbours, and it only looks inside the alpha map's own box:
    //     if (nc < 0 || nc >= mw || nr < 0 || nr >= mh || active[...]) continue;
    // The sparkle's 48x48 mask has plenty of clean margin around the sparkle so
    // there is always background to pull from. The Veo glyph fills its 23x10
    // box edge to edge, so after dilation nothing clean remains inside and the
    // cleanup silently does nothing — measured: identical residue at every
    // strength/radius setting. Padding the map restores the sparkle's geometry.
    const CLEANUP_PAD = 8;

    // Turn a winning placement into the candidate shape inpaintFrame() wants.
    function toRemovalCandidate(winner, frameWidth, frameHeight) {
        const t = winner.template;

        // Pad per side, never past the frame edge, so the glyph stays aligned.
        const padL = Math.min(CLEANUP_PAD, winner.x);
        const padT = Math.min(CLEANUP_PAD, winner.y);
        const padR = Math.min(CLEANUP_PAD, Math.max(0, frameWidth - (winner.x + t.width)));
        const padB = Math.min(CLEANUP_PAD, Math.max(0, frameHeight - (winner.y + t.height)));
        const pw = padL + t.width + padR;
        const ph = padT + t.height + padB;
        const source = winner.measuredValues || t.alphaValues;
        const padded = new Float32Array(pw * ph);          // zero = untouched margin
        for (let r = 0; r < t.height; r++) {
            for (let c = 0; c < t.width; c++) {
                padded[(r + padT) * pw + (c + padL)] = source[r * t.width + c];
            }
        }

        return {
            x: winner.x - padL,
            y: winner.y - padT,
            alphaMap: { values: padded, colorValues: undefined, width: pw, height: ph },
            // alphaValues peak at BASE_ALPHA_GAIN, so this scales the solve to
            // the alpha actually measured on this clip.
            baseStrength: winner.baseStrength || 1,
            // The wordmark is white text composited over the frame, so the
            // un-blend solves against pure white.
            opacity: 1,
            overlayValue: 255,
            ceiling: 0.99,
            // Existing 8-neighbour edge diffusion, sized to this stamp — softens
            // the ringing the un-blend leaves around the glyph edges.
            edgeCleanup: { strength: 0.6, radius: 2 },
            templateId: t.id,
            ncc: winner.ncc,
            // Where the glyph itself sits inside the padded box (diagnostics).
            glyphX: winner.x,
            glyphY: winner.y,
            pad: { left: padL, top: padT, right: padR, bottom: padB },
        };
    }

    /**
     * Detector for __purifyVideo. Votes across several frames so a single
     * frame that happens to correlate with background texture can't win.
     *
     * `decodeFrameAt` is injected by videoProcessor so we can sample extra
     * frames; when it is unavailable we fall back to the single calibration
     * frame we were handed.
     */
    function makeDetector(arrayBuffer) {
        return async function detectVeoText(calImageData, width, height, onProgress) {
            const step = typeof onProgress === "function" ? onProgress : () => {};
            const frames = [calImageData];
            try {
                if (typeof window.__decodeVideoFrames === "function") {
                    // Decoding the calibration frames is the long pole here, so
                    // hand its progress straight through to the overlay.
                    const got = await window.__decodeVideoFrames(
                        arrayBuffer, CALIBRATION_FRACTIONS, (r) => step(r * 0.85));
                    for (const f of got) if (f && f.imageData) frames.push(f.imageData);
                } else if (typeof window.__decodeVideoFrame === "function") {
                    // Older build without the multi-frame decoder: fall back to
                    // a few individual seeks.
                    for (const fraction of [0.35, 0.55, 0.75]) {
                        const f = await window.__decodeVideoFrame(arrayBuffer, fraction);
                        if (f && f.imageData) frames.push(f.imageData);
                    }
                }
            } catch (e) {
                // A clip too short to reach these points is fine — work with
                // whatever frames we did get.
                console.warn(TAG, "extra calibration frames unavailable", e && e.message);
            }

            step(0.88);
            const candidates = buildCandidates(width, height);
            if (!candidates.length) {
                console.warn(TAG, `no Veo template fits ${width}x${height}`);
                return null;
            }

            // Accumulate each placement's score ACROSS frames and take the best
            // mean. Scoring per frame and voting on exact coordinates splits the
            // vote when background texture nudges the argmax; a mean over
            // several frames is stable, and a chance correlation on one frame
            // cannot hold it up.
            const scores = new Map();
            let sampled = 0;
            for (const frame of frames) {
                sampled++;
                for (const c of candidates) {
                    const key = `${c.template.id}:${c.x}:${c.y}`;
                    let rec = scores.get(key);
                    if (!rec) { rec = { sum: 0, count: 0, cand: c }; scores.set(key, rec); }
                    rec.sum += correlate(frame, c.template.detectorMap, c.x, c.y, c.template.width, c.template.height);
                    rec.count++;
                }
            }

            let top = null;
            for (const rec of scores.values()) {
                const mean = rec.sum / rec.count;
                if (!top || mean > top.mean) top = { mean, rec };
            }
            if (!top) {
                console.warn(TAG, `no Veo wordmark matched across ${sampled} frame(s)`);
                return null;
            }

            const t = top.rec.cand.template;
            if (top.mean < t.minNcc) {
                console.warn(TAG, `best Veo match ${t.id} at (${top.rec.cand.x},${top.rec.cand.y}) ` +
                    `meanNcc=${top.mean.toFixed(3)} below ${t.minNcc} across ${sampled} frame(s) — declining`);
                logDeclineDiagnostics(frames, width, height);
                return null;
            }

            // Scale the un-blend to the alpha this clip actually uses. Clamped:
            // below 1x we'd be weaker than upstream for no reason, and an
            // over-estimate subtracts too much and punches a dark hole.
            const baseGain = window.__erasioVeoTextTemplates.BASE_ALPHA_GAIN;
            const measured = estimatePeakAlpha(frames, t, top.rec.cand.x, top.rec.cand.y);
            let baseStrength = 1;
            if (Number.isFinite(measured) && measured > 0) {
                baseStrength = Math.min(4, Math.max(1, measured / baseGain));
            }

            // Prefer the stamp measured from THIS clip over the upstream
            // template — same solve, but per pixel, so it matches the exact
            // glyph Flow rendered rather than a differently-hinted render of it.
            // Falls back to the template whenever the guards in refineAlphaStamp
            // aren't met.
            step(0.96);
            const refined = refineAlphaStamp(frames, t, top.rec.cand.x, top.rec.cand.y);
            if (refined) {
                console.log(TAG, `using measured stamp: peak=${refined.peak.toFixed(3)} ` +
                    `shapeNcc=${refined.shapeNcc.toFixed(3)} from ${frames.length} frame(s)`);
            } else {
                console.log(TAG, `measured stamp rejected — keeping upstream template`);
            }

            console.log(TAG, `matched ${t.id} at (${top.rec.cand.x},${top.rec.cand.y}) ` +
                `margins(r=${width - top.rec.cand.x - t.width},b=${height - top.rec.cand.y - t.height}) ` +
                `meanNcc=${top.mean.toFixed(3)} over ${sampled} frame(s); ` +
                `alpha measured=${Number.isFinite(measured) ? measured.toFixed(3) : "n/a"} ` +
                `vs base=${baseGain} -> strength=${baseStrength.toFixed(2)}x`);
            return toRemovalCandidate({
                template: t,
                x: top.rec.cand.x,
                y: top.rec.cand.y,
                ncc: top.mean,
                // A measured stamp already carries the real alpha per pixel, so
                // it needs no strength scaling; the template still does.
                baseStrength: refined ? 1 : baseStrength,
                measuredValues: refined ? refined.values : null,
            }, width, height);
        };
    }

    /**
     * Remove the Veo wordmark from an MP4.
     *
     * Same signature and progress contract as window.__purifyVideo, so the
     * injectors can call either interchangeably.
     *
     * @param {ArrayBuffer} arrayBuffer  source MP4 bytes
     * @param {{onProgress?: (p:{stage:string, ratio:number}) => void}} [options]
     * @returns {Promise<Blob>} the cleaned MP4
     */
    async function purifyVeoVideo(arrayBuffer, options) {
        options = options || {};
        if (typeof window.__purifyVideo !== "function") {
            throw new Error("Video engine not loaded");
        }
        if (!window.__erasioVeoTextTemplates) {
            throw new Error("Veo templates not loaded");
        }
        return window.__purifyVideo(arrayBuffer, {
            onProgress: options.onProgress,
            detector: makeDetector(arrayBuffer),
            detectorLabel: "Veo",
        });
    }

    window.__purifyVeoVideo = purifyVeoVideo;
})();
