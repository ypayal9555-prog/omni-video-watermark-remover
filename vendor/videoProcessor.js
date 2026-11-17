// Video watermark removal — runs in page context (Gemini / Flow main world)
// Exposes window.__purifyVideo(arrayBuffer, options) -> Promise<Blob>
//        window.__decodeVideoFrame(arrayBuffer, fraction) -> Promise<{imageData,width,height}>
//
// Port of geminiwatermarkremove.net's algorithm (mirrors
// watermark-remover-app/app.js):
//   1. MP4Box demuxes input MP4 into video + audio samples.
//   2. WebCodecs VideoDecoder decodes each H.264 frame to RGBA.
//   3. Per frame: cleaned = (observed - opacity * expectedLogoColor) / (1 - opacity)
//      followed by 8-neighbor edge diffusion for the 720p (grayscale) case.
//   4. WebCodecs VideoEncoder re-encodes to H.264 (avc1.640028, falls back
//      to avc1.42001f).
//   5. mp4-muxer writes the new MP4. Original AAC audio is bit-for-bit
//      passthrough.
//   6. First 5 frames calibrate position (Pearson over corner offsets)
//      and opacity (histogram of {1.0, 0.62} via a luma-error estimator).
//
// Supported dimensions ONLY: 1280x720, 720x1280, 1920x1080, 1080x1920.
// Other resolutions throw — the per-resolution mask + offset table is
// tuned only for these four.
//
// Masks are embedded as base64 PNG strings so the page world doesn't need
// to fetch extension-asset URLs (the page can't call chrome.runtime.getURL).
//
// Depends on globals loaded BEFORE this script:
//   MP4Box     (page/vendor/mp4box.all.min.js)
//   Mp4Muxer   (page/vendor/mp4-muxer.min.js)
//
// NOTE: This removes the *visible* sparkle only. Google's invisible SynthID
// watermark is baked across all pixels and survives re-encoding.

/* global MP4Box, DataStream, Mp4Muxer */

(function () {
    "use strict";

    const TAG = "[Erasio Video]";

    const SUPPORTED = new Set(["1280x720", "720x1280", "1920x1080", "1080x1920"]);
    const OPACITY_LEVELS = [1, 0.62];
    const OFFSETS_720 = [144, 120, 128, 72];
    const OFFSETS_1080 = [222, 186];
    const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000,
        22050, 16000, 12000, 11025, 8000, 7350];

    // ── Live tuning relayed from the side panel (content/bootstrap.js) ──
    // Null until the first CONFIG message; when the user hasn't saved any video
    // settings, applyVideoTuning() below is a no-op and the auto path is intact.
    const CH_CONFIG = "AIP_CONFIG";
    const CH_CONFIG_REQUEST = "AIP_CONFIG_REQUEST";
    let userCfg = null; // { image, video, newMaps }
    const num = (v, fb) => (typeof v === "number" && isFinite(v)) ? v : fb;

    // Same guarantee the image engine makes: a run started before the relay has
    // delivered the saved tuning waits for it rather than silently falling back
    // to the calibrated defaults. Bounded so a dead relay can't hang a download.
    const CONFIG_WAIT_MS = 3000;
    let settleConfig = null;
    const configReady = new Promise((resolve) => { settleConfig = resolve; });
    let configSettled = false;
    function markConfigSettled() {
        if (configSettled) return;
        configSettled = true;
        settleConfig();
    }
    setTimeout(() => {
        if (!configSettled) console.warn(TAG, `No tuning relayed within ${CONFIG_WAIT_MS}ms — using defaults`);
        markConfigSettled();
    }, CONFIG_WAIT_MS);

    // Resolve the side panel's saved mask pin ({ mode, dx, dy } measured from the
    // bottom-right corner) into this clip's pixel space, clamped so the mask
    // always fits. Returns null when the user left it on auto-detect.
    // Mirrors maskPositionToAbsolute() in src/lib/toolSettingsFields.js.
    function resolvePinnedPosition(vs, width, height, alphaMap) {
        const mp = vs && vs.maskPosition;
        if (!mp || mp.mode !== "pinned") return null;
        const dx = Number(mp.dx);
        const dy = Number(mp.dy);
        if (!isFinite(dx) || !isFinite(dy)) return null;
        return {
            x: clamp(Math.round(width - dx), 0, Math.max(0, width - alphaMap.width)),
            y: clamp(Math.round(height - dy), 0, Math.max(0, height - alphaMap.height)),
        };
    }

    function pickOpacityForRun(vs, autoOpacity) {
        if (!vs || vs.opacityMode == null || vs.opacityMode === "auto") return autoOpacity;
        if (vs.opacityMode === "custom") return num(vs.opacityCustom, autoOpacity);
        const v = parseFloat(vs.opacityMode);
        return isFinite(v) ? v : autoOpacity;
    }

    // Overlay the user's saved video settings onto the auto-calibrated candidate.
    function applyVideoTuning(chosen, vs) {
        if (!vs) return;
        if (typeof vs.baseStrength === "number") chosen.baseStrength = vs.baseStrength;
        chosen.opacity = pickOpacityForRun(vs, chosen.opacity != null ? chosen.opacity : 1);
        if (typeof vs.ceiling === "number") chosen.ceiling = vs.ceiling;
        const isGray = !chosen.alphaMap.colorValues;
        if (isGray && typeof vs.overlayValue === "number") chosen.overlayValue = vs.overlayValue;
        const opacityHigh = (chosen.opacity != null ? chosen.opacity : 1) >= 1;
        let useEdge;
        if (vs.edgeMode === "on") useEdge = true;
        else if (vs.edgeMode === "off") useEdge = false;
        else useEdge = opacityHigh && isGray; // auto
        if (useEdge) {
            chosen.edgeCleanup = {
                strength: num(vs.edgeStrength, 0.6),
                radius: Math.max(0, Math.round(num(vs.edgeRadius, 2))),
                maxPasses: Math.max(1, Math.round(num(vs.edgePasses, 120))),
            };
        } else {
            delete chosen.edgeCleanup;
        }
    }

    // Bilinear rescalers for the alpha map (grayscale values) and, for the
    // 1080p paired-star mask, its RGBA colour values — used to grow the treated
    // area when maskScale ≠ 1 (mirrors the side panel).
    function rescaleAlpha(values, oldSize, newSize) {
        if (oldSize === newSize) return values;
        const out = new Float32Array(newSize * newSize);
        const step = (oldSize - 1) / Math.max(1, newSize - 1);
        for (let y = 0; y < newSize; y++) {
            const sy = y * step, y0 = Math.floor(sy), y1 = Math.min(oldSize - 1, y0 + 1), fy = sy - y0;
            for (let x = 0; x < newSize; x++) {
                const sx = x * step, x0 = Math.floor(sx), x1 = Math.min(oldSize - 1, x0 + 1), fx = sx - x0;
                const a00 = values[y0 * oldSize + x0], a10 = values[y0 * oldSize + x1];
                const a01 = values[y1 * oldSize + x0], a11 = values[y1 * oldSize + x1];
                out[y * newSize + x] =
                    a00 * (1 - fx) * (1 - fy) + a10 * fx * (1 - fy) +
                    a01 * (1 - fx) * fy + a11 * fx * fy;
            }
        }
        return out;
    }
    function rescaleColor(colorValues, oldSize, newSize) {
        if (oldSize === newSize) return colorValues;
        const out = new Float32Array(newSize * newSize * 3);
        const step = (oldSize - 1) / Math.max(1, newSize - 1);
        for (let y = 0; y < newSize; y++) {
            const sy = y * step, y0 = Math.floor(sy), y1 = Math.min(oldSize - 1, y0 + 1), fy = sy - y0;
            for (let x = 0; x < newSize; x++) {
                const sx = x * step, x0 = Math.floor(sx), x1 = Math.min(oldSize - 1, x0 + 1), fx = sx - x0;
                for (let ch = 0; ch < 3; ch++) {
                    const a00 = colorValues[(y0 * oldSize + x0) * 3 + ch], a10 = colorValues[(y0 * oldSize + x1) * 3 + ch];
                    const a01 = colorValues[(y1 * oldSize + x0) * 3 + ch], a11 = colorValues[(y1 * oldSize + x1) * 3 + ch];
                    out[(y * newSize + x) * 3 + ch] =
                        a00 * (1 - fx) * (1 - fy) + a10 * fx * (1 - fy) +
                        a01 * (1 - fx) * fy + a11 * fx * fy;
                }
            }
        }
        return out;
    }

    // ---- Embedded masks ----
    // 48x48 grayscale alpha (alpha-only path; same byte-stream as bg_48.png
    // used by the image pipeline + the Frontend tool's /bg_48.png).
    const MASK_720_B64 = "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";

    // 84x84 RGBA paired-star overlay for 1080p (Gemini's larger watermark).
    const MASK_1080_B64 = "iVBORw0KGgoAAAANSUhEUgAAAFQAAABUCAYAAAAcaxDBAAANKklEQVR4Ae3BXY+eiWEW4Ot+3vnw2B5/xM7uZpuvEkFCEkWkEkmpKKRUpEIc0KoHSAiQOOHn8Ac4ggPOIAT1AImoNFC1KCWpmpCoFW0Vmk3Drtffs/aMZ97n5rEeo9eTWXt3s7bnPdjrig88U/GBZyo+8EzFGmobBDUbMKKIWZNYN7Fm2nooiZ8Sj3TikSTWSayvYAvbGDBgiQM8wNhWEusk1kzbmCQpXmr7AP8U+/haki28gWXbTGqNxJppu0CTmLza9q/gK3iA7yf5fdzFYdvRJIl1EWum7YAmOYMPt/0sPop9ZPIfMOCtTpLUGok103ZAk5zHdtuvmt3By/h3SS7gjbbBmMS6iDXR1iQYMCZ5qe0R/jn+HAd4GX+Q5C5eayuJtpLUGog10TYeSbKBV9t+Ap/HX5idQZP8N9xse2Q2JBmtgVgjbSVZYMek7T/BPVzHNoKX8VtJbmGvbcyaxGmLNdE2yMTkUtuP4FfxQxwhKF7C3SS/i5ttl0lGBKNTFmui7UaSJc5ip+2vmV3HgA0cYhMv498kOdf2NjJZWgOxJtpKYvJS2118FX+BYjAbsYFX8IdJXsO1TrA0SeI0xekKarbABQxt/wEWeAMDYlazKxiTfA0L3DEL6hTFKWoriUcGvNL2HP4eXseh2YBixBEu4Cp+J8ktvGHSdjRJ4rTEKWo7IFgmuYhl21/DWdzGEkFQFCMGXMG9JF/HZbzRNpNOJHEa4hS0lUTbDSyTbOKlti/js9jDIYogqNlotoVL+EGSH+MW9jF2YpLEixYvWFuToMhkA1fa3sc/whFuWwmKmI1mAy6i+E9JLuP1tocoMqkXLF6wtjELmmQX222/jKt400lFEBQ128Bl/CTJ97DX9i6KTOoFi1PQNsjkPK60vYIv4BYOrARBHVezYguX8QdJ7uIN3G87JBkR1AsSL1DbmG0kMflE21v4h9jHfbMRRTxZzQbs4Cy+luQCXmtr0iTaSuJFiBeo7YAByyQvY6/tV7GLm1giCOrJYlYEwQXcTPLb2MadTrDAEYYko+csXpC2wQaWSS5hq+3n8XFcx5FZENTTxSwYsYXL+F6S13Ab99uaNBMU9RzFC9J2I0lxFpfbfgyfxnU8wICYxdurlSJmQbGLTXwvyeu42/YtFE3ieYvnpK0k2gYDxiQfwkbbT+LzuI19jBjM4slqpYiVYoEz2MYfJrmOvbZvIWYjMhk9B/GMtTUJimCRxOQyNttewd/CTRxgiQVGxNPVLKiVIhjMtnARv5vkHm5hD50MGNAkS89YPAdtJdF2kWTAOWy1/Xl8DrexbxYr8XT19oogZgPOYAffSnINe7jf1mQwSTJ6xuLZGTCatM3EZAcXcL/tL+IV3MDSLIiVWKlZUCcFtVKzAUVxBmfwgyQ/xgH2sGw7JBkR1DMS71/amgQLHGKRZAsX297G38dV3MABYhazII6rk2oWJ9VKELMN7OLPknwfm22vIwiCESOaxPsR70NbjwTBmGQT57HbdhO/hAF3cIgRsRLHBUXNYlazeLqaBTEbcBWv4xtJXsYb2G8bBGOSTjyUxM8i3qO2HkqibVBksoFtnEEnfw1/HW9hDyMWGDCiiJNiNprFO6uTYqVY4BIO8N0k1zBiD4eoSVuTmDWJ9yJ+Rm0HBGOSHezgXNt9/Aq28RYemI2IlVgJRivB6Lh4siKolZgVwYABm9jGTfyXJB/F7bY3MKAIinokSb0L8Q7amuShtiOCTIpNXMTZtm/il/EqjnAbS9QsqFkQBLVSs6BWaiVWglqp4+K4YEBwGXv4kyQ/wkVca3sPMQuCmo1J6iniKdpKoq0k2koyYIEPIbjZ9m/gs2b3cB/FiGKB0XGDk2oWKzWrlZgFdVzN4qQ47gx2cAffSbKP4Db228bKYFYUTeKnxdtL22DMxCzYxjls42bbz+NzGLGPA4wIjhCzOmlAULNaCWqliFlQxxWxUsTTFcUZnMNZvIn/keQBljjAAY7aLhAUY5J6G/FkA4JtnEMxtF3iS/gEjnATD6zUSq3EcXFSEQT1dPV0cVytFEGtbOA8dlF8F99J8iE8wB6OsGwribaSeFw8pm0mJgucxwYO2m7go/g0ruIBruPILN5ercRJQR1XBPHe1Ekxq5NqJRgRDNjCh3GEH+L7SR5gA4c4wCEO20pSj8Rj2mZS7LYd8Cl8FFexhT3s4YFZsYERcVwdFycFNQvqpHh36t0L6qQjBCMW2MUFDLiD13ENryXZx2HbMcnokXhM2zyE7bb/GGfxExT3sY0jxGxArNRKUStxUsyKoFaCIp6ufjZ1XBCzQywRswELXMQFDEn+tUnboyT1SDymbR5qu4F/gW3cN9vDXRQxW6AYcOS9i+NqFrNaiePqvamVOKkYEBxhA0cYzc5gF1ewkeRfYavtQZJ6JB7Tdkgy4kzbDbyKT+IVXEBxHfewRMwG1Eo9H3FSzeK4Oq5W4smCEcF5nMcOlriN1/HnSd7AftsxyeiReEzbIJMFLmBAcL9t8Av4eZzB61hixBEGBEG9f0EdF7N6sqBOquPipCUGbOEqBvxf/HGSv8Su2SHu4V5bSeqReEzbmCQpNs02sI0dbOJG2y/gF3CIG9jH0ixmMatZPF1QK0EdFyfVSszq7RWxEisjzuA8zuBP8O0k22ZHeIAjHGE0GzB6JB7T1kNJtJUJggHFGZzHJu63vYRfxFns4QHuY4HRcUGtxCxmtRKzmsV7U9QsVoKiCEZsYBebOMC3k1zDJvax3/YBMikG1Kx+SvyUtpl0IolHYrbAAgtsYxNj2yv4As7hCHcxYsRgNjpuMIvZ6LigVmJWxJPVrGYxq1kQs4s4gxv4QZI3cQ57uIsjdGLSTMyCmtVj4h209VAS/19bmWADl7CJe20/g09hA/dwiCOzOm6wEozem3i6mhVBzQYscB7BHyV5Dbu4i308aLvEgGJMYhKzeoJ4l9oGRRBsJHmAAdvYxMW21/EVvIT7uIclBtQsiJWgqFnMaiVmdVxQxHG1EtTsHHZwDd9M8hLu4JbZ2HYTS4xJimD0LsR71DaoSRJtMykW2MBlbLS9gC8iuGUWjBisBPX2iliplZgVA+q4EQOKYolX8QDfSXINC9zBfdRj2mZiUu9BvE9tTWKSidkOPtT2EH8H53AdD7AwCwbUkxVBEdRKULNYqVmwRHEGV/AjfDvJJdzAXRx1ksSzEM9AW49kUgTncAlvtf2b+Bhu4cBKENTbK2JWx8WsiJVaKXZwFX+W5PdxCW/iAca2MrFS70M8e8HQVpJtnMN227+Kj+MODhHESj1drcQsVooiKIotXMAPk/wxij3ca+uhJCZBPQPxnLSNSZJN7OBC21fxOexh36wYMWBEzOKkentBsMQCR9jBZXwryXUc4AZGk7ZBkwwYPSPxnLT1UCbYxEWcbbuLL+EuDrDEgNEsVuK4IlaKmNVsxBY+jP+e5B72caPtEQYEYxKTeobiOWkbjyTpZEiyiyttd/BF7GMftRIr8faKOK4INnAVv5fkJg5wy2xpNmD0HMRz0tYjQbDAYZJLuNr2I/g0rmMfC7OgiCcr4rgRF3AWf5rkT7GPm22HJEcI6jmKF6BtMGBIMuIyLrb9NF7GDRxicFK8s6L4BP53kv+FfezhCJ3IBPUcxYsRk7YDmmQDF7Bs+8vYxS0rcVxQK7EyYoGzuIXfTvIR/KTtYZJ6geLFSSeISSb4ZNtr+A3cwwHqncWsZtvYxTeSDHgdh23HJF6keHGGtmMmJm2HJJt4te0OvowbOEScFLMiZsWAS/hukjdxA/cRjAjqBYlT0tZDSS7gQtsv4hW8hk2MnqwYsMRl3E3ye1jiFoLRKYhT0laSAcVLOGr7m7iLm9hEzYJaqdkFLPDvk+ziOpZIJ0m8aHE6YtJJkgHFx9ru4Mu4gyMENQuKmm3hKv5nkut4s+09ZGJSpyBOV8yKHVxo+yWcw10ENQuKoPgwmuTr2MD1tpLUKYr1ELNPtt3CV/AaahazAUXxcXwzyVv4cdtlEo/UKYk10VaSizjb9lewjdfNggWWGHAWW0l+C0vsYUTM6pTE6Qs6ycTkpbZb+HX8CEcIjsy28DK+meQGbuEQQTA6RbEeBnSSyYCfa/tL2MAts2KJ89hN8h8x4k5bSUYEdYpiPQwmbcckC1xtewV/F69jiQNs4RX8UZIf4hrGtjJBnbJYDxtYtpUJdrDV9jdxF7ewgU28jH+bZBfXUKSTJE5brI+hE2Qy4KW2n8Jn8X+wwIewn+S/4qDtXpIiqDUQ62NAJzLBbtt7+Jf4Me7j5/CtJNdxve2hWZNYB7FG2nokky3stP1VbOE+LuPrSTbwZicmSWpNxHpKW0k+0vYz+ATuYpHkP2OJe52gSayLWC8xS9tMLrT9DP429vCTJL+DvU4wokmsi1g/QRCcbXuAf4YDfCPJPdxpGzSJdRLrJwiCTSwQLLDEEZY4Mqs1EutnYaVWBoyOK2qNxBpraxLH1SSJdRQfeKbiA89UfOCZ+n8JRUivT8D+agAAAABJRU5ErkJggg==";

    // ---- Alpha map loading (from embedded base64) ----

    const _mapCache = new Map();

    async function loadAlphaMap(b64, size, withColor) {
        const key = `${size}|${withColor ? "rgba" : "alpha"}`;
        if (_mapCache.has(key)) return _mapCache.get(key);

        const raw = atob(b64.replace(/\s+/g, ""));
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const cvs = new OffscreenCanvas(size, size);
        const ctx = cvs.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0, size, size);
        const px = ctx.getImageData(0, 0, size, size).data;
        bmp.close();

        const values = new Float32Array(size * size);
        const colorValues = withColor ? new Float32Array(size * size * 3) : undefined;
        for (let i = 0; i < values.length; i++) {
            const t = 4 * i;
            if (withColor) {
                values[i] = px[t + 3] / 255;
                colorValues[3 * i] = px[t];
                colorValues[3 * i + 1] = px[t + 1];
                colorValues[3 * i + 2] = px[t + 2];
            } else {
                values[i] = Math.max(px[t], px[t + 1], px[t + 2]) / 255;
            }
        }
        const result = { values, colorValues, width: size, height: size };
        _mapCache.set(key, result);
        return result;
    }

    // ---- Pixel ops: inverse alpha blend + iterative edge diffusion + scoring ----

    function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

    function inpaintFrame(image, cand) {
        const out = new Uint8ClampedArray(image.data);
        const opacity = cand.opacity !== undefined ? cand.opacity : estimateOpacity(image, cand);
        const ceiling = cand.ceiling != null ? cand.ceiling : 1;
        const hasColor = cand.alphaMap.colorValues !== undefined;
        const colorMap = cand.alphaMap.colorValues;
        const overlayValue = cand.overlayValue != null ? cand.overlayValue : 250;
        const mw = cand.alphaMap.width;
        const mh = cand.alphaMap.height;
        const cleanupMask = cand.edgeCleanup ? new Uint8Array(mw * mh) : null;

        for (let row = 0; row < mh; row++) {
            for (let col = 0; col < mw; col++) {
                const mi = row * mw + col;
                const p = Math.min(cand.alphaMap.values[mi] * cand.baseStrength * opacity, ceiling);
                if (p < 0.002) continue;
                const idx = ((cand.y + row) * image.width + cand.x + col) * 4;
                const oneMinusP = 1 - p;
                if (oneMinusP <= 1e-4) continue;
                if (cleanupMask) cleanupMask[mi] = 1;
                for (let ch = 0; ch < 3; ch++) {
                    const expected = hasColor && colorMap ? colorMap[3 * mi + ch] : overlayValue;
                    out[idx + ch] = Math.round(clamp((image.data[idx + ch] - p * expected) / oneMinusP, 0, 255));
                }
            }
        }

        if (cand.edgeCleanup && cleanupMask) {
            const strength = cand.edgeCleanup.strength;
            const radius = cand.edgeCleanup.radius;
            const dilated = new Uint8Array(mw * mh);
            for (let r = 0; r < mh; r++) {
                for (let c = 0; c < mw; c++) {
                    if (!cleanupMask[r * mw + c]) continue;
                    for (let dr = -radius; dr <= radius; dr++) {
                        for (let dc = -radius; dc <= radius; dc++) {
                            const nc = c + dc;
                            const nr = r + dr;
                            if (nc >= 0 && nc < mw && nr >= 0 && nr < mh) dilated[nr * mw + nc] = 1;
                        }
                    }
                }
            }
            const active = new Uint8Array(dilated);
            const passes = cand.edgeCleanup.maxPasses != null
                ? cand.edgeCleanup.maxPasses
                : Math.min(120, Math.max(8, mw + mh));
            for (let iter = 0; iter < passes; iter++) {
                let changed = 0;
                const next = new Uint8Array(active);
                for (let r = 0; r < mh; r++) {
                    for (let c = 0; c < mw; c++) {
                        if (!active[r * mw + c]) continue;
                        let cnt = 0;
                        const sum = [0, 0, 0];
                        for (let dr = -1; dr <= 1; dr++) {
                            for (let dc = -1; dc <= 1; dc++) {
                                if (dr === 0 && dc === 0) continue;
                                const nc = c + dc;
                                const nr = r + dr;
                                if (nc < 0 || nc >= mw || nr < 0 || nr >= mh || active[nr * mw + nc]) continue;
                                const ni = ((cand.y + nr) * image.width + cand.x + nc) * 4;
                                sum[0] += out[ni];
                                sum[1] += out[ni + 1];
                                sum[2] += out[ni + 2];
                                cnt++;
                            }
                        }
                        if (cnt === 0) continue;
                        const idx = ((cand.y + r) * image.width + cand.x + c) * 4;
                        for (let ch = 0; ch < 3; ch++) {
                            const avg = sum[ch] / cnt;
                            out[idx + ch] = Math.round(out[idx + ch] * (1 - strength) + avg * strength);
                        }
                        next[r * mw + c] = 0;
                        changed++;
                    }
                }
                active.set(next);
                if (changed === 0) break;
            }
        }

        return new ImageData(out, image.width, image.height);
    }

    function scorePosition(image, cand) {
        let sumGray = 0, sumGraySq = 0, sumA = 0, sumASq = 0, sumGA = 0, n = 0;
        for (let row = 0; row < cand.alphaMap.height; row++) {
            for (let col = 0; col < cand.alphaMap.width; col++) {
                const a = cand.alphaMap.values[row * cand.alphaMap.width + col];
                if (a <= 0.08) continue;
                const idx = ((cand.y + row) * image.width + cand.x + col) * 4;
                const gray = (image.data[idx] + image.data[idx + 1] + image.data[idx + 2]) / 765;
                sumGray += gray; sumGraySq += gray * gray;
                sumA += a; sumASq += a * a;
                sumGA += gray * a; n++;
            }
        }
        if (n === 0) return -Infinity;
        const meanG = sumGray / n, meanA = sumA / n;
        const denom = Math.sqrt((sumGraySq - n * meanG * meanG) * (sumASq - n * meanA * meanA));
        if (denom <= 0) return -Infinity;
        return (sumGA - n * meanG * meanA) / denom;
    }

    function estimateOpacity(image, cand) {
        if (cand.alphaMap.colorValues !== undefined) return 1;

        const pad = Math.max(8, Math.round(0.25 * cand.alphaMap.width));
        const x0 = Math.max(0, cand.x - pad);
        const y0 = Math.max(0, cand.y - pad);
        const x1 = Math.min(image.width, cand.x + cand.alphaMap.width + pad);
        const y1 = Math.min(image.height, cand.y + cand.alphaMap.height + pad);
        let sum = 0, n = 0;
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                if (x >= cand.x && x < cand.x + cand.alphaMap.width && y >= cand.y && y < cand.y + cand.alphaMap.height) continue;
                const idx = (y * image.width + x) * 4;
                sum += 0.2126 * image.data[idx] + 0.7152 * image.data[idx + 1] + 0.0722 * image.data[idx + 2];
                n++;
            }
        }
        if (n === 0) return OPACITY_LEVELS[0];
        const surroundingLuma = sum / n;

        let bestOpacity = OPACITY_LEVELS[0], bestError = Infinity;
        const hasColor = cand.alphaMap.colorValues !== undefined;
        const colorMap = cand.alphaMap.colorValues;

        for (const op of OPACITY_LEVELS) {
            let errSum = 0, weightSum = 0;
            for (let row = 0; row < cand.alphaMap.height; row++) {
                for (let col = 0; col < cand.alphaMap.width; col++) {
                    const mi = row * cand.alphaMap.width + col;
                    const a = cand.alphaMap.values[mi];
                    if (a <= 0.04) continue;
                    const p = Math.min(a * cand.baseStrength * op, op);
                    const oneMinusP = 1 - p;
                    if (oneMinusP <= 1e-4) continue;
                    const idx = ((cand.y + row) * image.width + cand.x + col) * 4;
                    const er = hasColor && colorMap ? colorMap[3 * mi] : 250;
                    const eg = hasColor && colorMap ? colorMap[3 * mi + 1] : 250;
                    const eb = hasColor && colorMap ? colorMap[3 * mi + 2] : 250;
                    const luma =
                        0.2126 * ((image.data[idx] - p * er) / oneMinusP) +
                        0.7152 * ((image.data[idx + 1] - p * eg) / oneMinusP) +
                        0.0722 * ((image.data[idx + 2] - p * eb) / oneMinusP);
                    const w = Math.min(1, 8 * a);
                    errSum += Math.abs(luma - surroundingLuma) * w;
                    weightSum += w;
                }
            }
            const err = weightSum > 0 ? errSum / weightSum : Infinity;
            if (err < bestError) { bestError = err; bestOpacity = op; }
        }
        return bestOpacity;
    }

    // ---- MP4 demux via mp4box.js ----

    function extractVideoDescription(file, track) {
        const trak = file.getTrackById(track.id);
        const entries = (trak && trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl && trak.mdia.minf.stbl.stsd && trak.mdia.minf.stbl.stsd.entries) || [];
        for (const e of entries) {
            const cfg = e.avcC || e.hvcC || e.vpcC || e.av1C;
            if (!cfg) continue;
            // mp4box exposes DataStream as its own global (not MP4Box.DataStream).
            const DS = (typeof DataStream !== "undefined")
                ? DataStream
                : (window.DataStream || MP4Box.DataStream);
            if (!DS) return null;
            const ds = new DS(undefined, 0, DS.BIG_ENDIAN);
            cfg.write(ds);
            return new Uint8Array(ds.buffer, 8); // strip 8-byte box header
        }
        return null;
    }

    function demuxMp4(arrayBuffer) {
        return new Promise((resolve, reject) => {
            const file = MP4Box.createFile();
            const videoSamples = [];
            const audioSamples = [];
            let videoTrack = null;
            let audioTrack = null;

            file.onError = (e) => reject(new Error("mp4box demux error: " + e));

            file.onReady = (info) => {
                videoTrack = info.videoTracks && info.videoTracks[0];
                audioTrack = info.audioTracks && info.audioTracks[0];
                if (!videoTrack) {
                    reject(new Error("No video track found in file"));
                    return;
                }
                file.setExtractionOptions(videoTrack.id, "video", { nbSamples: 1000000 });
                if (audioTrack) {
                    file.setExtractionOptions(audioTrack.id, "audio", { nbSamples: 1000000 });
                }
                file.start();
            };

            file.onSamples = (id, user, samples) => {
                const bucket = user === "video" ? videoSamples : audioSamples;
                for (const s of samples) {
                    bucket.push({
                        data: s.data.slice(0), // copy out; mp4box may release its buffer
                        cts: s.cts,
                        dts: s.dts,
                        duration: s.duration,
                        timescale: s.timescale,
                        is_sync: s.is_sync,
                    });
                }
            };

            const buf = arrayBuffer.slice(0); // mp4box wants a fresh ArrayBuffer
            buf.fileStart = 0;
            file.appendBuffer(buf);
            file.flush();

            if (!videoTrack) {
                reject(new Error("No video track found in file"));
                return;
            }
            const videoDescription = extractVideoDescription(file, videoTrack);
            resolve({ videoTrack, audioTrack, videoSamples, audioSamples, videoDescription });
        });
    }

    // ---- Main entry ----

    async function purifyVideo(arrayBuffer, options) {
        options = options || {};
        const onProgress = typeof options.onProgress === "function" ? options.onProgress : function () {};
        const report = (stage, ratio) =>
            onProgress({ stage, ratio: Math.max(0, Math.min(1, ratio || 0)) });

        // OPTIONAL alternate-watermark hook. When supplied, this callback owns
        // mask + position instead of the built-in Gemini/Omni sparkle scoring:
        //   detector(calibrationImageData, width, height) -> candidate | null
        // where candidate is { x, y, alphaMap:{values,width,height}, baseStrength,
        // opacity, ... } — i.e. exactly what inpaintFrame() consumes.
        // page/veoTextEngine.js passes one to remove the Veo wordmark.
        //
        // Null for every existing caller, and every sparkle branch below is
        // guarded on it, so the Gemini path runs exactly as it always has.
        const detector = typeof options.detector === "function" ? options.detector : null;
        const detectorLabel = options.detectorLabel || "custom";

        // Never run with defaults just because the relay hasn't landed yet.
        await configReady;

        if (typeof MP4Box === "undefined") throw new Error("MP4Box library not loaded");
        if (typeof Mp4Muxer === "undefined") throw new Error("Mp4Muxer library not loaded");
        if (typeof VideoDecoder === "undefined" || typeof VideoEncoder === "undefined") {
            throw new Error("WebCodecs not available in this browser");
        }

        report("demux", 0);
        const { videoTrack, audioTrack, videoSamples, audioSamples, videoDescription } =
            await demuxMp4(arrayBuffer);
        report("demux", 1);

        const width = videoTrack.video.width;
        const height = videoTrack.video.height;
        const dimKey = `${width}x${height}`;
        // The sparkle masks are calibrated for these four sizes only. A custom
        // detector brings its own resolution handling, so it opts out.
        if (!detector && !SUPPORTED.has(dimKey)) {
            throw new Error(
                `Unsupported dimensions: ${width} × ${height}. ` +
                `Supported sizes are 1280 × 720, 720 × 1280, 1920 × 1080, or 1080 × 1920.`
            );
        }

        const totalFrames = videoSamples.length || 1;
        const timescale = (videoSamples[0] && videoSamples[0].timescale) || videoTrack.timescale || 30000;
        let avgDur = 0;
        for (const s of videoSamples) avgDur += s.duration;
        avgDur = (avgDur / totalFrames) || (timescale / 30);
        const fps = Math.max(1, Math.round(timescale / avgDur));

        console.log(TAG, `Source: ${width}x${height}, ${totalFrames} frames, ~${fps}fps, codec ${videoTrack.codec}`);

        const is1080 = (width === 1920 && height === 1080) || (width === 1080 && height === 1920);

        // Effective side-panel video settings (null → auto defaults intact).
        const vs = (userCfg && userCfg.video) || null;

        // logoVersion "new" swaps in the 2026 sparkle maps the content script
        // decoded (48 for 720p, 96 for 1080p — both grayscale). Otherwise use
        // the embedded calibrated masks.
        const useNewMaps = !detector && !!(vs && vs.logoVersion === "new"
            && userCfg.newMaps && userCfg.newMaps.s48 && userCfg.newMaps.s96);
        let alphaMap = null, maskSize = 0, offsets = null, candidates = [];
        if (detector) {
            // Mask + position come from the detector at calibration time below.
            // None of the sparkle mask plumbing runs.
        } else if (useNewMaps) {
            const s = is1080 ? userCfg.newMaps.s96 : userCfg.newMaps.s48;
            maskSize = s.side;
            alphaMap = { values: s.values, colorValues: undefined, width: s.side, height: s.side };
        } else {
            const maskB64 = is1080 ? MASK_1080_B64 : MASK_720_B64;
            maskSize = is1080 ? 84 : 48;
            alphaMap = await loadAlphaMap(maskB64, maskSize, is1080);
        }
        // maskScale — grow the treated area (mirrors the side panel). The
        // enlarged map is used for scoring + inpaint; the candidate offsets
        // shift inward by half the growth so the pattern stays over the stamp.
        let shift = 0;
        if (!detector) {
        const baseMaskSize = maskSize;
        const scale = Math.min(3, Math.max(0.5, num(vs && vs.maskScale, 1)));
        if (scale !== 1) {
            const scaledSize = Math.max(8, Math.round(baseMaskSize * scale));
            alphaMap = {
                values: rescaleAlpha(alphaMap.values, baseMaskSize, scaledSize),
                colorValues: alphaMap.colorValues ? rescaleColor(alphaMap.colorValues, baseMaskSize, scaledSize) : undefined,
                width: scaledSize,
                height: scaledSize,
            };
            maskSize = scaledSize;
        }
        shift = Math.floor((maskSize - baseMaskSize) / 2);
        offsets = is1080 ? OFFSETS_1080 : OFFSETS_720;

        // A mask the user pinned in the side panel, stored as an offset from the
        // bottom-right corner so it resolves against this clip's resolution.
        // When present it REPLACES the candidate offsets rather than joining
        // them: the user pinned it precisely because scoring was choosing the
        // wrong spot, so letting the scorer pick again would defeat it. No
        // `shift` here — the pin is already the mask's top-left, exactly as
        // calibrateChosen() treats forcePosition in the side panel.
        const pinned = resolvePinnedPosition(vs, width, height, alphaMap);
        candidates = pinned
            ? [{ x: pinned.x, y: pinned.y, alphaMap, score: 0, baseStrength: 1 }]
            : offsets.map((off) => ({
                x: clamp(width - off - shift, 0, width - alphaMap.width),
                y: clamp(height - off - shift, 0, height - alphaMap.height),
                alphaMap,
                score: 0,
                baseStrength: 1,
            }));
        if (pinned) console.log(TAG, `mask pinned by user: (${pinned.x},${pinned.y})`);
        } // end sparkle-only mask setup

        // ---- Muxer ----
        const muxer = new Mp4Muxer.Muxer({
            target: new Mp4Muxer.ArrayBufferTarget(),
            fastStart: "in-memory",
            firstTimestampBehavior: "offset",
            video: { codec: "avc", width, height },
            audio: audioTrack
                ? {
                    codec: "aac",
                    sampleRate: audioTrack.audio.sample_rate,
                    numberOfChannels: audioTrack.audio.channel_count,
                }
                : undefined,
        });

        // ---- Video encoder ----
        // Target the SOURCE's own average bitrate (×1.15 headroom) so a crisp,
        // high-bitrate clip isn't re-encoded down to a dimension-only formula guess
        // — the #1 cause of "output looks compressed / softer" reports. The old
        // formula stays as a FLOOR so low-bitrate sources aren't needlessly inflated,
        // and the ceiling is 40 Mbps so 1080p60 / high-motion isn't capped. Source
        // bitrate = sum of encoded video-sample sizes over the clip duration.
        // Kept in sync with src/lib/toolVideoProcessor.js + Frontend videoProcessor.js.
        const durationSeconds = (avgDur * totalFrames) / timescale || (totalFrames / fps);
        let sourceBytes = 0;
        for (const s of videoSamples) sourceBytes += (s.data && s.data.byteLength) || 0;
        const sourceBitrate = durationSeconds > 0 ? (sourceBytes * 8) / durationSeconds : 0;
        const formulaBitrate = width * height * fps * 0.12 * num(vs && vs.bitrateMult, 1);
        const encodeBitrate = Math.round(Math.max(
            2000000,
            Math.min(40000000, Math.max(formulaBitrate, sourceBitrate * 1.15))
        ));
        console.log(TAG, `Bitrate: source~${Math.round(sourceBitrate / 1000)}kbps, formula ${Math.round(formulaBitrate / 1000)}kbps -> encode ${Math.round(encodeBitrate / 1000)}kbps (VBR)`);

        let encoderConfig = {
            codec: "avc1.640028", // High profile, level 4.0
            width,
            height,
            bitrate: encodeBitrate,
            bitrateMode: "variable", // VBR — better bit allocation for the ~99% of
                                     // each frame unchanged by the watermark patch
            framerate: fps,
            avc: { format: "avc" },
        };
        let support = await VideoEncoder.isConfigSupported(encoderConfig);
        if (!support.supported) {
            encoderConfig = Object.assign({}, encoderConfig, { codec: "avc1.42001f" });
            support = await VideoEncoder.isConfigSupported(encoderConfig);
            if (!support.supported) throw new Error("No supported H.264 encoder configuration");
        }

        let encodeError = null;
        const encoder = new VideoEncoder({
            output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
            error: (e) => { encodeError = e; console.error(TAG, "encoder error", e); },
        });
        encoder.configure(encoderConfig);

        // ---- Decode + per-frame patch + re-encode ----
        const patchCanvas = new OffscreenCanvas(width, height);
        const patchCtx = patchCanvas.getContext("2d", { willReadFrequently: true });

        let decodeError = null;
        let chosen = null;
        let processed = 0;
        let scored = 0;
        const pending = [];
        const calibrationCount = Math.min(5, totalFrames);
        const keyInterval = Math.max(1, fps * 2);

        // ---- Pre-calibrate on a representative frame (matches the side panel) ----
        // The streaming fallback below calibrates on the FIRST few decoded
        // frames; on clips that open with a black/fade intro those carry no
        // watermark, so the scorer locks onto the wrong offset (the tie-margin
        // defaults it to offset 144) and NOTHING gets removed — even though the
        // exact same clip removes fine in the side panel, which calibrates on a
        // frame ~15% in. So we do the same here: decode one frame past the
        // intro, lock position + opacity from it, and reuse that for every
        // frame. If it fails, `chosen` stays null and the streaming path runs.
        // Everything from here to the encode loop used to report nothing, so the
        // overlay sat at "Reading video... 100%" through the whole calibration
        // decode — long enough that users assumed it had died. Report it.
        report("analyze", 0);

        // Custom-detector path (page/veoTextEngine.js). Detection is strict: if
        // the alternate mark isn't found we fail rather than silently falling
        // back to the sparkle offsets, which would remove the wrong thing.
        if (detector) {
            const cal = await decodeFrameAt(arrayBuffer, 0.15, (r) => report("analyze", r * 0.15));
            const calImg = cal && cal.imageData;
            if (!calImg) throw new Error("Could not decode a frame to detect the watermark");
            chosen = await detector(calImg, width, height, (r) => report("analyze", 0.15 + r * 0.8));
            if (!chosen) {
                const err = new Error(`No ${detectorLabel} watermark found in this video`);
                err.code = "ERASIO_NO_WATERMARK";
                throw err;
            }
            console.log(TAG, `${detectorLabel} detected: pos=(${chosen.x},${chosen.y}) ` +
                `mask=${chosen.alphaMap.width}x${chosen.alphaMap.height}`);
        }

        if (!detector) try {
            const cal = await decodeFrameAt(arrayBuffer, 0.15, (r) => report("analyze", r));
            const calImg = cal && cal.imageData;
            if (calImg) {
                for (const c of candidates) c.score = scorePosition(calImg, c);
                const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
                chosen = { x: best.x, y: best.y, alphaMap: best.alphaMap, baseStrength: 1, score: best.score };
                chosen.opacity = estimateOpacity(calImg, chosen);
                if (chosen.opacity >= 1 && !chosen.alphaMap.colorValues) {
                    chosen.overlayValue = 255;
                    chosen.ceiling = 0.99;
                    chosen.edgeCleanup = { strength: 0.6, radius: 2 };
                }
                applyVideoTuning(chosen, vs);
                console.log(TAG, `pre-calibrated: pos=(${chosen.x},${chosen.y}) mask=${chosen.alphaMap.width}px ` +
                    `score=${chosen.score.toFixed(3)} opacity=${chosen.opacity}${useNewMaps ? " logo=new" : ""}`);
            }
        } catch (e) {
            console.warn(TAG, "pre-calibration failed; using streaming fallback", e);
        }

        report("analyze", 1);

        const processFrame = (sample) => {
            const cand = chosen || candidates[0];
            const cleaned = inpaintFrame(sample.imageData, cand);

            const init = {
                format: "RGBA",
                codedWidth: width,
                codedHeight: height,
                timestamp: sample.timestamp,
            };
            if (sample.duration != null) init.duration = sample.duration;
            const vf = new VideoFrame(cleaned.data.buffer, init);
            encoder.encode(vf, { keyFrame: processed % keyInterval === 0 });
            vf.close();
            processed += 1;
            report("process", processed / totalFrames);
        };

        const decoder = new VideoDecoder({
            output: (frame) => {
                try {
                    const tsMicro = frame.timestamp;
                    const durMicro = frame.duration;
                    patchCtx.drawImage(frame, 0, 0, width, height);
                    frame.close();
                    const imageData = patchCtx.getImageData(0, 0, width, height);
                    const sample = { imageData, timestamp: tsMicro, duration: durMicro };

                    if (!chosen) {
                        for (const c of candidates) c.score += scorePosition(imageData, c);
                        pending.push(sample);
                        scored += 1;
                        if (scored >= calibrationCount) {
                            const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
                            const tieMargin = 0.04 * Math.max(1, scored);
                            chosen = best.score >= candidates[0].score + tieMargin ? best : candidates[0];

                            const histogram = {};
                            for (const fr of pending) {
                                const op = estimateOpacity(fr.imageData, chosen);
                                histogram[op] = (histogram[op] || 0) + 1;
                            }
                            let modal = OPACITY_LEVELS[0], modalCount = 0;
                            for (const k of Object.keys(histogram)) {
                                if (histogram[k] > modalCount) { modalCount = histogram[k]; modal = parseFloat(k); }
                            }
                            chosen.opacity = modal;
                            if (modal >= 1 && !chosen.alphaMap.colorValues) {
                                chosen.overlayValue = 255;
                                chosen.ceiling = 0.99;
                                chosen.edgeCleanup = { strength: 0.6, radius: 2 };
                            }
                            // Overlay the user's saved side-panel video settings
                            // (no-op when they haven't customised anything).
                            applyVideoTuning(chosen, vs);
                            // Diagnostic: where the mask landed + how well it
                            // matched. A low score means the mark isn't where /
                            // shaped like the calibrated mask expects (e.g. a
                            // Veo/Flow watermark vs the Gemini sparkle).
                            console.log(TAG, `calibrated: pos=(${chosen.x},${chosen.y}) mask=${chosen.alphaMap.width}px ` +
                                `score=${(chosen.score || 0).toFixed(3)} opacity=${chosen.opacity} ` +
                                `edge=${chosen.edgeCleanup ? "on" : "off"}${useNewMaps ? " logo=new" : ""}`);
                            for (const fr of pending) processFrame(fr);
                            pending.length = 0;
                        }
                        return;
                    }
                    processFrame(sample);
                } catch (e) {
                    decodeError = e;
                    console.error(TAG, "frame patch error", e);
                    try { frame.close(); } catch (_) { /* already closed */ }
                }
            },
            error: (e) => { decodeError = e; console.error(TAG, "decoder error", e); },
        });

        decoder.configure({
            codec: videoTrack.codec,
            codedWidth: width,
            codedHeight: height,
            description: videoDescription || undefined,
        });

        report("process", 0);
        let framesDecoded = 0;
        for (const s of videoSamples) {
            if (decodeError) throw decodeError;
            decoder.decode(new EncodedVideoChunk({
                type: s.is_sync ? "key" : "delta",
                timestamp: (s.cts * 1e6) / s.timescale,
                duration: (s.duration * 1e6) / s.timescale,
                data: s.data,
            }));
            framesDecoded++;
            if (framesDecoded % 24 === 0) await new Promise((r) => setTimeout(r, 0));
        }

        await decoder.flush();
        await encoder.flush();
        if (decodeError) throw decodeError;
        if (encodeError) throw encodeError;
        decoder.close();
        encoder.close();

        // ---- Copy audio track verbatim ----
        if (audioTrack && audioSamples.length) {
            try {
                const sr = audioTrack.audio.sample_rate;
                const ch = audioTrack.audio.channel_count;
                let srIdx = AAC_SAMPLE_RATES.indexOf(sr);
                if (srIdx < 0) srIdx = 4;
                const audioMeta = {
                    decoderConfig: {
                        codec: "mp4a.40.2",
                        sampleRate: sr,
                        numberOfChannels: ch,
                        description: new Uint8Array([
                            (16 | (srIdx >> 1)) & 0xff,
                            (((srIdx & 1) << 7) | (ch << 3)) & 0xff,
                        ]),
                    },
                };
                for (const s of audioSamples) {
                    muxer.addAudioChunk(
                        new EncodedAudioChunk({
                            type: "key",
                            timestamp: (s.cts * 1e6) / s.timescale,
                            duration: (s.duration * 1e6) / s.timescale,
                            data: s.data,
                        }),
                        audioMeta
                    );
                }
                console.log(TAG, `Copied ${audioSamples.length} audio samples`);
            } catch (e) {
                console.warn(TAG, "Audio copy failed — output will be silent:", e);
            }
        }

        report("mux", 0.95);
        muxer.finalize();
        const blob = new Blob([muxer.target.buffer], { type: "video/mp4" });
        report("done", 1);
        console.log(TAG, `Done — output ${blob.size} bytes`);
        return blob;
    }

    // Decode a single frame (calibration preview). Returns {imageData,width,height}.
    /**
     * Decode SEVERAL frames in one pass.
     *
     * decodeFrameAt() below re-demuxes and re-decodes from the start of the clip
     * for every call, so asking it for N frames costs sum(fractions) x a full
     * decode. This walks the samples once and captures every requested index on
     * the way through: cost is max(fractions), regardless of how many you ask
     * for. Four frames via decodeFrameAt is ~1.8x a full decode; twelve frames
     * through here is ~0.85x.
     *
     * @param {ArrayBuffer} arrayBuffer
     * @param {number[]} fractions  positions through the clip, 0..1
     * @returns {Promise<Array<{imageData: ImageData, width: number, height: number, fraction: number}>>}
     */
    async function decodeFramesAt(arrayBuffer, fractions, onProgress) {
        if (typeof MP4Box === "undefined") throw new Error("MP4Box library not loaded");
        if (typeof VideoDecoder === "undefined") throw new Error("WebCodecs not available in this browser");
        const wanted = (fractions || []).filter((f) => Number.isFinite(f) && f >= 0 && f <= 1);
        if (!wanted.length) return [];

        const { videoTrack, videoSamples, videoDescription } = await demuxMp4(arrayBuffer);
        const width = videoTrack.video.width;
        const height = videoTrack.video.height;
        const total = videoSamples.length || 1;

        // index -> fraction, so duplicates collapse and output stays ordered.
        const targets = new Map();
        for (const f of wanted) {
            const idx = Math.max(0, Math.min(total - 1, Math.floor(f * total)));
            if (!targets.has(idx)) targets.set(idx, f);
        }
        const lastIdx = Math.max(...targets.keys());

        const cvs = new OffscreenCanvas(width, height);
        const ctx = cvs.getContext("2d", { willReadFrequently: true });
        const captured = new Map();
        let count = 0;

        const report = typeof onProgress === "function" ? onProgress : null;
        const decoder = new VideoDecoder({
            output: (frame) => {
                if (targets.has(count) && !captured.has(count)) {
                    ctx.drawImage(frame, 0, 0, width, height);
                    captured.set(count, ctx.getImageData(0, 0, width, height));
                }
                count++;
                // Real progress: the output callback fires as frames land, so
                // this actually moves rather than jumping 0 -> 100.
                if (report && lastIdx > 0) report(Math.min(1, count / (lastIdx + 1)));
                frame.close();
            },
            error: (e) => console.error(TAG, "multi-frame decode error", e),
        });
        decoder.configure({
            codec: videoTrack.codec,
            codedWidth: width,
            codedHeight: height,
            description: videoDescription || undefined,
        });

        let fed = 0;
        for (const s of videoSamples) {
            // Stop feeding once past the last target; the decoder still drains
            // whatever it has buffered during flush().
            if (fed > lastIdx + 24) break;
            decoder.decode(new EncodedVideoChunk({
                type: s.is_sync ? "key" : "delta",
                timestamp: (s.cts * 1e6) / s.timescale,
                duration: (s.duration * 1e6) / s.timescale,
                data: s.data,
            }));
            fed++;
            // Yield periodically. Feeding is synchronous, so without this the
            // page cannot repaint and the overlay looks frozen for the whole
            // calibration pass — the "extension has stopped working" report.
            if ((fed & 31) === 0) await new Promise((r) => setTimeout(r, 0));
        }
        await decoder.flush();
        decoder.close();

        return [...targets.entries()]
            .sort((a, b) => a[0] - b[0])
            .filter(([idx]) => captured.has(idx))
            .map(([idx, fraction]) => ({ imageData: captured.get(idx), width, height, fraction }));
    }

    async function decodeFrameAt(arrayBuffer, fraction, onProgress) {
        if (typeof MP4Box === "undefined") throw new Error("MP4Box library not loaded");
        if (typeof VideoDecoder === "undefined") throw new Error("WebCodecs not available in this browser");

        const { videoTrack, videoSamples, videoDescription } = await demuxMp4(arrayBuffer);
        const width = videoTrack.video.width;
        const height = videoTrack.video.height;
        const total = videoSamples.length || 1;
        const targetIdx = Math.max(0, Math.min(total - 1, Math.floor((fraction || 0) * total)));

        const cvs = new OffscreenCanvas(width, height);
        const ctx = cvs.getContext("2d", { willReadFrequently: true });
        let captured = null;
        let count = 0;

        const decoder = new VideoDecoder({
            output: (frame) => {
                if (count === targetIdx && !captured) {
                    ctx.drawImage(frame, 0, 0, width, height);
                    captured = ctx.getImageData(0, 0, width, height);
                }
                count++;
                frame.close();
            },
            error: (e) => console.error(TAG, "sample decode error", e),
        });
        decoder.configure({
            codec: videoTrack.codec,
            codedWidth: width,
            codedHeight: height,
            description: videoDescription || undefined,
        });
        // Feed samples until the requested frame is captured. The decoder
        // may still buffer ~10-20 samples past the break — that's fine, we
        // just stop pushing new ones to avoid decoding the entire clip.
        let fedOne = 0;
        for (const s of videoSamples) {
            if (captured) break;
            decoder.decode(new EncodedVideoChunk({
                type: s.is_sync ? "key" : "delta",
                timestamp: (s.cts * 1e6) / s.timescale,
                duration: (s.duration * 1e6) / s.timescale,
                data: s.data,
            }));
            fedOne++;
            if ((fedOne & 31) === 0) {
                if (typeof onProgress === "function" && targetIdx > 0) {
                    onProgress(Math.min(1, fedOne / (targetIdx + 1)));
                }
                await new Promise((r) => setTimeout(r, 0));   // let the UI paint
            }
        }
        await decoder.flush();
        decoder.close();

        if (!captured) throw new Error("Could not decode preview frame");
        return { imageData: captured, width, height };
    }

    window.__purifyVideo = purifyVideo;
    window.__decodeVideoFrame = decodeFrameAt;
    // Multi-frame single-pass decode (page/veoTextEngine.js uses it to calibrate
    // the wordmark's alpha stamp without paying for N separate decodes).
    window.__decodeVideoFrames = decodeFramesAt;
    // Added for the standalone tool: expose the exact per-frame math so the
    // single-frame preview is identical to what the video pass writes.
    window.__erasioInpaintFrame = inpaintFrame;

    // Receive live tuning from the content script (side-panel video settings).
    window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        const m = event.data;
        if (!m || typeof m !== "object" || m.channel !== CH_CONFIG) return;
        userCfg = m.config || null;
        markConfigSettled();
        console.log(TAG, "tuning received:", (userCfg && userCfg.video) || "(defaults)",
            (userCfg && userCfg.newMaps) ? "+new-maps" : "");
    });
    // Ask for the current tuning in case it was pushed before we injected.
    try { window.postMessage({ channel: CH_CONFIG_REQUEST }, "*"); } catch (_) { /* ignore */ }
    console.log(`${TAG} Video processor ready (new engine)`);
})();
