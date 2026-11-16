# Omni Video Watermark Remover

A small, fully local web tool that removes the **visible Gemini / Omni (2026) sparkle watermark** from generated videos.

It reuses the exact reverse-blend engine and calibrated 2026 alpha maps found in a locally installed Erasio 1.3.1 Chrome extension — but **only the video watermark remover**, with no automation, no login, no credits, and no network calls.

> ⚠️ This removes the *visible* sparkle only. Google's invisible **SynthID** watermark is spread across all pixels and survives re-encoding.

## Features

- Removes the 2026 Gemini / Omni sparkle from MP4 videos
- Downloads the result as a re-muxed MP4; original AAC audio is passed through bit-for-bit
- Runs **100% in your browser** — no uploads, no server, no API keys
- Optional first-frame preview
- Live progress: demux → analyze → process → mux

## Limitations

- **Supported resolutions only:** `1280×720`, `720×1280`, `1920×1080`, `1080×1920` (the masks are calibrated for these four).
- Requires a browser with **WebCodecs** (Chrome 94+, Edge 94+) and `OffscreenCanvas`.
- Video processing is CPU/GPU heavy; long clips take time.

## Quick start

### Option A — GitHub Pages
Fork/clone this repo, then in the repository settings enable **Pages → Deploy from a branch → main / root**. Open the published URL.

### Option B — local server
Browsers block `fetch()` of the mask PNGs on `file://`, so serve the folder over HTTP:

```bash
# Python
python -m http.server 8000
# then open http://localhost:8000

# or Node
npx serve .
```

## Usage

1. Open the page in Chrome or Edge.
2. Drop an MP4 (or click to browse).
3. Optionally click **Preview first frame**.
4. Click **Remove watermark**.
5. Click **Download clean MP4** when done.

## How it works

The pipeline (verbatim from the reconstructed engine in `vendor/videoProcessor.js`):

1. **Demux** the input MP4 with MP4Box.js into video + audio samples.
2. **Decode** H.264 frames with WebCodecs `VideoDecoder`.
3. **Calibrate** position and opacity from the first frames (Pearson correlation over corner offsets; opacity chosen from `{1.0, 0.62}`).
4. **Reverse the alpha blend** per watermark pixel:

   ```
   original = (observed - opacity × logo) / (1 - opacity)
   ```

   using the exact `sparkle-2026-48.png` / `sparkle-2026-96.png` alpha maps, followed by edge diffusion for the grayscale 720p path.
5. **Re-encode** with WebCodecs `VideoEncoder` (H.264) and mux with mp4-muxer; AAC audio is copied unchanged.

No config endpoints, auth, credit checks, or telemetry are present.

## Project structure

```
.
├── index.html                     # UI
├── styles.css
├── js/app.js                      # mask loading, config injection, UI logic
├── vendor/
│   ├── videoProcessor.js          # reconstructed video engine (Erasio 1.3.1)
│   ├── mp4box.all.min.js          # MP4 demuxing
│   └── mp4-muxer.min.js           # MP4 muxing
└── masks/
    ├── sparkle-2026-48.png        # calibrated 2026 Omni alpha map (720p)
    └── sparkle-2026-96.png        # calibrated 2026 Omni alpha map (1080p)
```

## Troubleshooting

| Problem | Fix |
|---|---|
| "Missing required browser APIs" | Use Chrome/Edge 94+, and open over `http://` (not `file://`). |
| "Unsupported dimensions" | Re-export the clip at 720p or 1080p (16:9 or 9:16). |
| Watermark still faintly visible | The 2026 map may not match your clip's watermark variant; try the original (older) sparkle instead. |
| Processing is very slow | Close other tabs; long/high-bitrate clips need more time. |

## Provenance & licensing

The files under `vendor/` were copied verbatim from a **locally installed** Erasio 1.3.1 extension for personal, educational use. The reverse-blend algorithm is credited in the source to **Allen Kuo** ([geminiwatermarktool](https://github.com/allenk/geminiwatermarktool)); the video port also references `geminiwatermarkremove.net`. Third-party libraries: MP4Box.js and mp4-muxer (see their bundled headers). See [NOTICE](NOTICE) for full details.

If you plan to redistribute this publicly, review the upstream licenses of those components first.
