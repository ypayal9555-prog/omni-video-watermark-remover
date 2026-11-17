# Omni Video Watermark Remover

A small, **fully local** web tool that removes the visible watermark Google stamps on
Gemini / Omni / Flow videos. It runs the exact reverse-alpha-blend engine from a locally
installed Erasio 1.3.1 extension (video only: no automation, no login, no credits, no
network calls).

> This removes the *visible* mark only. Google's invisible **SynthID** watermark is spread
> across every pixel and survives re-encoding.

## Why the old version left the watermark

The engine was fed a **fixed list of corner offsets** (`144 / 120 / 128 / 72` px at 720p,
`222 / 186` px at 1080p) and blended the mask at whichever one scored best. That silently
fails in two common cases:

1. **The mark is somewhere else.** Google has moved the mark further in from the corner
   between model versions, and portrait renders use different insets. If the real mark is
   at, say, 32 px or 144 px, the fixed candidates miss it — the clip is re-encoded anyway
   and the watermark is still there. That is exactly the "output comes but the watermark
   remains" symptom.
2. **It is a different mark.** Flow / Gemini video can carry the **"Veo" wordmark**, a
   completely different shape, which the diamond mask can never erase. The extension itself
   says a clip carries one or the other, and "the wrong engine simply leaves the mark in
   place".

## What this version does instead

`js/detect.js` measures the clip before touching it:

- **Two templates**: the 2026 Gemini/Omni **diamond** (`masks/sparkle-2026-48.png` /
  `-96.png`) and the **Veo wordmark** (`vendor/veoTextTemplates.js`).
- **Multi-scale, multi-frame NCC search** over the bottom-right corner: a 4× downsampled
  coarse pass, then 1-px position and ±3-px size refinement on full-resolution frames.
  Insets from 0 to ~400 px are covered, so the "Google moved it" problem disappears.
- **Per-clip alpha measurement**: the calibrated maps are a *shape*; the opacity Google
  actually stamped varies. The peak alpha is solved from the mark core against a ring of
  clean background, and the reverse blend subtracts exactly that amount — no ghost, no dark
  hole.
- **Explicit refusal**: if neither template correlates, nothing is re-encoded. The UI says
  so and offers a manual pin / force-run instead of producing a fake "clean" file.

The removal itself is still the extension's own math, unmodified:

```
p        = min(alpha × baseStrength × opacity, ceiling)
original = (observed − p × overlay) / (1 − p)
```

followed by the engine's edge-diffusion cleanup, re-encoded with WebCodecs and muxed with
mp4-muxer (AAC audio passthrough, bit for bit).

## Features

- Removes the **2026 diamond** and the **Veo wordmark** from MP4 videos
- Auto engine selection (or force one engine)
- 720p / 1080p, 16:9 and 9:16 — 1280×720, 720×1280, 1920×1080, 1080×1920
- Detection box + cleaned-frame preview before committing to a full re-encode
- Manual pin (inset from the right/bottom edge + mark size) when auto-detect is unsure
- Runs **100% in the browser** — no uploads, no server, no API keys

## Quick start

### GitHub Pages

Settings → Pages → Deploy from a branch → `main` / root, then open the published URL.

### Local

Browsers block `fetch()` of the mask PNGs on `file://`, so serve the folder over HTTP:

```bash
python -m http.server 8000
# open http://localhost:8000
```

## Usage

1. Open the page in Chrome or Edge (WebCodecs required).
2. Drop an MP4, or click to browse.
3. Click **Detect watermark** — the status line shows the engine, position, size and
   measured alpha; the box is drawn on the frame.
4. Click **Preview cleaned** to check the single-frame result.
5. Click **Remove watermark**, then **Download clean MP4**.

### If it is still visible

- Open **Engines & fine-tuning** and make sure the engine matches the mark (diamond vs
  Veo wordmark). Auto normally gets this right.
- Tick **Pin position manually** and enter the mark's inset from the right/bottom edge and
  its size. The preview box shows exactly what will be treated.
- Raise **Removal strength** slightly (1.05–1.15×) if a faint ghost remains; raise
  **Residual cleanup** if a soft outline remains.
- The debug log lists the NCC score, position and gain the engine used.

## How it was verified

`test/synthetic.html` builds clips *with a known watermark* (alpha map, position, opacity),
runs the same detect → candidate → engine path the app uses, and compares the output to the
clean reference at the matching frame.

Measured on headless Chrome (software H.264), 1280×720 unless noted. "Mark left" compares
the mark's local contrast after removal against the clean reference (100% = untouched,
0% = identical to clean):

| Case | Detection | Mark left |
|---|---|---|
| diamond 48 px, inset 96 | NCC 0.98 @ (1136,576), α 0.34 | **0.8 %** |
| diamond, old fixed-offset path (same clip) | — | 2.3 % |
| diamond 44 px, inset 144 | NCC 0.99 @ (1092,532), α 0.32 | **-0.3 %** |
| diamond 48 px, inset 32 | NCC 0.97 @ (1200,640), α 0.34 | **0.2 %** |
| diamond, faint (opacity 0.62) | NCC 0.93, α 0.21 | **-0.8 %** |
| Veo wordmark 68×30 | Veo NCC 1.00 @ (1168,642) | **1.6 %** |
| Veo wordmark 23×10 | Veo NCC 1.00 @ (1242,694) | **1.2 %** |
| portrait 720×1280, diamond | NCC 0.99 @ (576,1136) | **-0.4 %** |
| 1080p, diamond 96 px, inset 222 | NCC 0.94 @ (1601,761), 98 px | **2.2 %** |

The same end-to-end run through the real UI (file → detect → preview → run → download),
scored against the clean reference, leaves the mark at 0.8–2.2 % while the re-encode noise
floor is ~0.7 MAE. A clean clip with no mark reports "Nothing found" and is **not**
re-encoded.

Open `test/synthetic.html` over the local server to reproduce; `cdp-ui.cjs`-style drivers
are kept outside the repo.

## Project structure

```
.
├── index.html                     # UI
├── styles.css
├── js/
│   ├── detect.js                  # template detection, alpha measurement, candidates
│   └── app.js                     # UI flow: detect → preview → engine
├── vendor/
│   ├── videoProcessor.js          # Erasio video engine (+ __erasioInpaintFrame export)
│   ├── veoTextEngine.js           # Erasio Veo wordmark engine
│   ├── veoTextTemplates.js        # Veo alpha stamps
│   ├── mp4box.all.min.js
│   └── mp4-muxer.min.js
├── masks/                         # calibrated 2026 diamond alpha maps
└── test/synthetic.html            # ground-truth harness (builds its own clips)
```

`vendor/videoProcessor.js` differs from the extension copy by three added lines that export
`window.__decodeVideoFrames` and `window.__erasioInpaintFrame`, so the single-frame preview
and the video pass use the identical math. `vendor/watermarkEngine.js` is kept for reference
but is no longer loaded: its full-frame scan produced false positives on clean clips.

## Limitations

- Only the four calibrated resolutions above; the engine rejects anything else.
- Requires WebCodecs (`VideoEncoder`/`VideoDecoder`) and `OffscreenCanvas` — Chrome/Edge 94+.
- Long or high-bitrate clips take time: the whole clip is decoded, cleaned and re-encoded.
- The visible mark is removed; **SynthID is not**.

## Provenance & licensing

`vendor/` contains files copied verbatim from a **locally installed** Erasio 1.3.1 extension
for personal, educational use. The reverse-blend algorithm is credited in the source to
**Allen Kuo** ([geminiwatermarktool](https://github.com/allenk/geminiwatermarktool)); the
video port also references `geminiwatermarkremove.net`. Third-party libraries: MP4Box.js and
mp4-muxer (see their bundled headers). See [NOTICE](NOTICE) for details.

If you plan to redistribute this publicly, review the upstream licences first.
