# Omni Video Watermark Remover

A small, **fully local** web tool that removes the visible watermark Google stamps on
Gemini / Omni / Flow videos. It runs the exact reverse-alpha-blend engine from a locally
installed Erasio 1.3.1 extension (video only: no automation, no login, no credits, no
network calls).

> This removes the *visible* mark only. Google's invisible **SynthID** watermark is spread
> across every pixel and survives re-encoding.

## Why the previous build left a faint watermark

The engine was being fed the **2026** alpha maps (`masks/sparkle-2026-48.png`, peak alpha
**0.341**) while Erasio's shipped default is the **old logo** family (`logoVersion:"old"` →
`bg_48.png`, peak alpha **0.506**). The star *shape* matches, so detection looked fine, but
the reverse blend only subtracted two thirds of the real alpha:

```
p        = min(alpha × baseStrength × opacity, ceiling)      # 0.341 instead of 0.506
original = (observed − p × 255) / (1 − p)                    # ~33 % of the mark survives
```

That is exactly the "the file comes out but I can still see the mark" symptom — a ghost at
one third contrast, not a hard failure. It is reproducible on purpose in the test harness:
case **k** removes an old-logo clip with the 2026 map and leaves **48 %** of the mark, while
the same clip with the right family leaves **0.6 %**.

The second half of the bug: the app built its own candidate from a measured gain and passed
it to the engine as a detector override, so Erasio's own calibration (position table,
two-level opacity, edge rule) never ran.

## What this version does

It stops second-guessing the extension and runs Erasio's video pipeline as shipped.

**Mask families** — from the side panel's `P2()`/`Vb()` table:

| logoVersion | 720p | 1080p |
|---|---|---|
| `old` (**default**) | `masks/bg_48.png` — 48 px, grayscale, peak α 0.506 | `masks/gemini-star_paired_star_mask.png` — 84 px, RGBA, peak α 0.494 |
| `new` | `masks/sparkle-2026-48.png` — 48 px, peak α 0.341 | `masks/sparkle-2026-96.png` — 96 px, peak α 0.369 |

**Position** — Erasio's fixed inset table, measured to the mask's top-left, applied to both
axes: `[144, 120, 128, 72]` at 720p, `[222, 186]` at 1080p, with the scaled-mask re-centring
shift. Each candidate is scored with the extension's own Pearson `sp()` over mask pixels
above 0.08; the winner is kept.

**Opacity** — one of exactly two levels, `[1, 0.62]`, chosen by `Ib()`: the level whose
reverse-blended luma best matches a ring of untouched pixels around the mark. This is why a
softer 2026 stamp still comes out clean with the stronger old-logo map (0.506 × 0.62 ≈ 0.314
vs the true 0.341).

**Edge cleanup** — Erasio's `W2()` rule: diffusion at strength 0.6 / radius 2 / 120 passes,
enabled only when opacity came out at 1 and the mask is grayscale (never for the RGBA 84 px
map).

**Removal** — the extension's math, unmodified:

```
p        = min(alpha × baseStrength × opacity, ceiling)
original = (observed − p × overlay) / (1 − p)
```

then WebCodecs re-encode, AAC passthrough, mp4-muxer.

### Detection, and when it refuses

`js/detect.js` scores both logo families on four frames of your clip and reports what it
found (family, inset, Pearson r, opacity, measured alpha). The family defaults to `old` —
Erasio's own default — and only switches to `new` when the 2026 map beats it by a clear
margin. Three safeguards:

- **Moved marks.** If the best inset scores below the gate, Erasio's own bottom-right NCC
  scan (`vendor/sparkleEngine.js`, verbatim) looks for the mark elsewhere; a hit is pinned
  for the run.
- **Explicit refusal.** On clean footage every candidate scores ≈ 0.00 (measured), so the
  app says "Nothing found" and re-encodes nothing. Manual pin and force-run remain.
- **Veo wordmark.** A completely different mark (`vendor/veoTextEngine.js` +
  `vendor/veoTextTemplates.js`); the logo mask can never erase it. Scored separately at
  NCC ≥ 0.60.

The re-encode itself is the vendored engine's own Erasio code path — the detector only
reports, previews and refuses. That is why the output matches the extension rather than an
approximation of it.

## Features

- Removes the **logo sparkle** (old and 2026 maps) and the **Veo wordmark** from MP4 videos
- Auto family/engine selection, or force one
- 720p / 1080p, 16:9 and 9:16 — 1280×720, 720×1280, 1920×1080, 1080×1920
- Detection box + cleaned-frame preview before committing to a full re-encode
- **Bulk processing:** drop several MP4s at once → queue with per-file status and progress,
  individual download links, or **Download all** (saves each MP4 separately). More files can be
  dropped while it runs. A **Paste (Ctrl+V)** option is also available.
- Manual pin (inset from the right/bottom edge + mark size) when auto-detect is unsure
- **Works on phones:** touch-sized controls, tap-to-pick dropzone, swipeable before/after slider,
  H.264 capability detection before you pick a file, and system **Save / share** on mobile
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

1. Open the page in a WebCodecs browser — Chrome / Edge on desktop and Android, Safari on
   iOS 16.4+ (the page checks H.264 encoding and shows a browser-specific banner if it is
   unavailable).
2. Drop one MP4, or click to browse. The before/after slider appears automatically: first the
   original frame, then the cleaned half once detection finishes.
3. Optionally click **Detect watermark** — the status line shows the family, Pearson r, position,
   size and opacity; the box is drawn on the frame.
4. Click **Preview cleaned** to re-check the single-frame result.
5. Click **Remove watermark**, then **Download clean MP4**.

**Bulk:** drop two or more MP4s (or multi-select in the file picker) instead. A batch queue shows
each file with its own progress and download link. Files are processed sequentially with the same
Erasio calibration; **Download all** saves each successful output as its own MP4 (no ZIP). Failed
files stay in the list with the reason, and do not stop the rest of the queue.

**Paste:** press **Ctrl+V** on the page (or click **Paste from clipboard**) to load a video the
browser exposes as a clipboard file. Note that browsers normally expose only images and text from
the system clipboard — an MP4 copied in File Explorer usually cannot be pasted into a web page, so
drag-and-drop or Browse remains the reliable route for local files.

### On a phone or tablet

The layout is touch-first: tap the dropzone to pick one or more MP4s, swipe the before/after
handle (vertical swipes still scroll the page), and use **Save / share…** after a run to send the
clean MP4 to Photos / Files through the system share sheet.

| Device | Browser | Re-encode |
|---|---|---|
| Android 10+ | Chrome, Edge, Samsung Internet 17+ | Yes — hardware H.264 |
| iPhone / iPad, iOS 16.4+ | Safari (Chrome/Firefox on iOS use WebKit too) | Detected at runtime; most builds encode video |
| iPhone / iPad, iOS 15 or older | any | No WebCodecs — the page explains it |
| Android | Firefox | No `VideoEncoder` yet — use Chrome |
| Desktop | Chrome / Edge 94+, Safari 17.4+ | Yes |

The page probes `VideoEncoder.isConfigSupported()` for the actual H.264 config before enabling
the dropzone, so an unsupported phone gets a clear banner instead of failing after a file is
picked. On a phone:

- Keep the tab in the foreground and the screen on. Locking the phone or switching apps can pause
  the encode; it resumes when you come back.
- Start with 720p clips under a minute. Long 1080p clips can exceed mobile memory — the page warns
  above roughly 180 MB. If a run fails, close other tabs and try a shorter clip.
- **Download** saves the MP4 to Files / Downloads. **Save / share…** opens the system share sheet
  when the browser supports sharing files.
- Bulk mode keeps every finished output in memory. Download each result and tap **Clear queue**
  before starting another large batch.

### If it is still visible

- Check the family in the status line. A 2026 clip detected as `logo` is fine (opacity
  0.62 compensates); the reverse is not, so try **2026 sparkle only** if the mark looks
  soft/white rather than solid.
- Open **Engines & fine-tuning** and make sure the engine matches the mark (sparkle vs Veo
  wordmark). Auto normally gets this right.
- Tick **Pin position manually** and enter the mark's inset from the right/bottom edge and
  its size. The preview box shows exactly what will be treated.
- Raise **Removal strength** slightly (1.05–1.15×) only if a faint ghost remains.
- The debug log lists both family scores, the chosen inset, opacity and the engine's own
  `pre-calibrated:` line.

## How it was verified

`test/synthetic.html` builds clips *with a known watermark* (mask family, position, alpha),
runs the same detect → engine path the app uses, and compares the output to the clean
reference at the matching frame.

Measured on headless Chrome (software H.264), 1280×720 unless noted. "Mark left" compares
the mark's local contrast after removal against the clean reference (100 % = untouched,
0 % = identical to clean):

| Case | Detection | Mark left |
|---|---|---|
| a) logo 48 px, inset 144 (Erasio default) | old r 0.99 @ (1136,576), α 0.505 | **0.6 %** |
| b) logo, mark moved to inset 96 | NCC scan 0.99 @ (1184,624) | **0.9 %** |
| c) logo 48 px, inset 72 | old r 0.99, opacity 1 | **1.5 %** |
| d) logo, faint α×0.62 | old r 0.99, opacity 0.62 | **1.6 %** |
| e) 2026 sparkle 48 px, inset 128 | old r 0.99 → opacity 0.62 | **2.2 %** |
| f) Veo wordmark 68×30 | Veo NCC 1.00 @ (1168,642) | **2.1 %** |
| g) Veo wordmark 23×10 | Veo NCC 1.00 @ (1242,694) | **2.0 %** |
| h) portrait 720×1280, logo | old r 0.99 | **1.2 %** |
| i) 1080p, logo 84 px, inset 222 | old r 0.94, α 0.517 | **2.1 %** |
| j) 1080p, 2026 sparkle 96 px, inset 186 | new r 0.91 (old 0.04) | **-0.4 %** |
| k) **old mark + 2026 map (the old bug)** | — | **48 %** |

The full UI path (file → detect → preview → run → download) was scored the same way on case
a: MAE **1.29** inside the mark box against a re-encode noise floor of **0.79**, mark
contrast 2.19 vs clean 1.66. A clean 720p clip with no mark reports "Nothing found" at
r ≈ 0.000 and is **not** re-encoded.

Open `test/synthetic.html` over the local server to reproduce; `cdp-*.cjs` drivers are kept
outside the repo.

## Project structure

```
.
├── index.html                     # UI
├── styles.css
├── js/
│   ├── detect.js                  # Erasio calibration (sp/Ib/W2/offsets) + report
│   └── app.js                     # UI flow: detect → preview → engine
├── vendor/
│   ├── videoProcessor.js          # Erasio video engine (+ __erasioInpaintFrame export)
│   ├── sparkleEngine.js           # Erasio's NCC scan / alpha maps (fallback only)
│   ├── veoTextEngine.js           # Erasio Veo wordmark engine
│   ├── veoTextTemplates.js        # Veo alpha stamps
│   ├── mp4box.all.min.js
│   └── mp4-muxer.min.js
├── masks/                         # bg_48, paired star 84, 2026 48/96 alpha maps
└── test/synthetic.html            # ground-truth harness (builds its own clips)
```

`vendor/videoProcessor.js` differs from the extension copy by three added lines that export
`window.__decodeVideoFrames` and `window.__erasioInpaintFrame`, so the single-frame preview
and the video pass use the identical math. `vendor/sparkleEngine.js` is byte-identical to the
extension's copy (SHA-256 checked) and is used only for its NCC scan.

## Limitations

- Only the four calibrated resolutions above; the engine rejects anything else.
- Detection is a gate, not a guarantee: a mark the scorer cannot see needs a manual pin or
  "Run even if nothing is detected".
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
