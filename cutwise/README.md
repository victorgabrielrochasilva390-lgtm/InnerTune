# Cutwise Studio: AI-assisted professional video editor (MVP)

Cutwise is a desktop-class video editor that runs in the browser, with a local Node + FFmpeg
backend. It combines a multitrack non-destructive timeline with an **AI Editing Director**. The
director analyses your footage (silences, scenes, loudness, exposure, word-level transcript) and
proposes an editing plan. Every suggestion says **what** to change, **where**, **why**, the
**expected effect**, and whether it is **safe to auto-apply**. You preview, approve, adjust or
reject each one.

> This lives in `cutwise/` inside the repository and is independent of the Android app in the
> rest of the repo.

## Quick start

Requirements: Node ≥ 22.5 (uses the built-in `node:sqlite`) and FFmpeg ≥ 6 with libass on `PATH`.

```bash
cd cutwise
npm install
npm run dev          # server on :8787 + editor on http://localhost:5173
```

Production build: `npm run build && npm start` (the server then serves the built UI on :8787).

Optional services (all optional; the editor works fully without them):

| Variable | Enables |
|---|---|
| `ANTHROPIC_API_KEY` | Claude-powered AI Director (`claude-opus-5-5` by default, override with `CUTWISE_CLAUDE_MODEL`). Reads transcript, measurements and scene keyframes (vision) |
| `pip install faster-whisper` | **Free, offline** word-level transcription (`WHISPER_MODEL`, default `small`; downloads once from Hugging Face) |
| `DEEPGRAM_API_KEY` | Transcription with word timings, punctuation and **speaker diarization** (paid, with trial credit) |
| `GROQ_API_KEY` | Whisper large-v3-turbo transcription (free tier) |
| `OPENAI_API_KEY` (+ `OPENAI_BASE_URL`) | Whisper transcription (paid / any OpenAI-compatible server) |
| `PEXELS_API_KEY`, `PIXABAY_API_KEY` | Stock video + photo search (free keys). **Openverse** (CC images & audio) works with no key |
| `CUTWISE_DATA`, `PORT`, `HOST`, `FFMPEG_PATH` | Storage folder (default `cutwise/data`), port, bind address (default `127.0.0.1`), FFmpeg binary |

## Architecture

```
src/      React + TypeScript editor (zustand + immer store, undo/redo, autosave)
  engine/   real-time preview: Canvas2D compositor, WebGL2 colour grading, Web Audio mixer, caption renderer
shared/   pure TypeScript used by BOTH preview and renderer
  timeline.ts   non-destructive edit operations (split, ripple, overwrite, source↔timeline mapping)
  motion.ts     camera motion / keyframes / transitions as numbers (preview) AND FFmpeg expressions (export)
  captions.ts   word-level caption layout, ASS (libass) generation, SRT/VTT import & export
  heuristics.ts free offline AI engine (measurement + transcript based recommendations)
  apply.ts      turns an approved recommendation into concrete timeline edits
server/   Express + FFmpeg
  media.ts      import, probe, H.264 proxies, filmstrips, waveforms, relinking
  analysis.ts   silencedetect, EBU R128 loudness, clipping, noise floor, energy, scene cuts, exposure/saturation
  transcribe.ts Deepgram / Whisper API / local faster-whisper
  ai.ts         Claude director (structured JSON output, refusal fallback, vision keyframes)
  renderGraph.ts the whole timeline → one FFmpeg filter graph (overlays, grading, transitions, libass, audio mix)
  render.ts / jobs.ts  background render queue with progress, cancellation and error logs
  reframe.ts    saliency-based subject tracking for vertical reframing
  assets.ts     bundled OFL fonts, generated LUTs, synthesised royalty-free SFX & music beds
  db.ts         SQLite: projects, version history, media
```

Non-destructive by design: uploaded originals are stored once and never written to. Clips
reference source in/out points. Proxies, thumbnails, waveforms and renders are derived files.
Export always renders from the originals.

## Feature status

✅ implemented and working · 🔌 implemented, needs an external key or package · ⚠️ partial or approximate (see notes)

### Editing interface
- ✅ Multitrack timeline (video / audio / text tracks): drag-and-drop from library or OS, move across tracks, trim, blade, split, ripple delete, duplicate, overwrite edits, snapping, markers, in/out range
- ✅ Real-time preview (Canvas2D + WebGL2) with frame stepping, J/K/L, timecode, safe-area guides, full/half preview resolution, frame export (PNG)
- ✅ Timeline zoom (Ctrl+wheel) and scroll, filmstrip thumbnails, waveforms, caption lane, AI suggestion lane
- ✅ Undo / redo (200 steps, slider drags coalesced), editing-history panel, keyboard shortcuts (`?`)
- ✅ Media library, effects / transitions / text / captions / B-roll / SFX panels, inspector, audio mixer
- ✅ Projects: create, open, duplicate, delete, autosave (1.5s debounce), manual versions (Ctrl+S), version restore, crash recovery from a local backup
- ✅ Workspaces (Edit, AI Director, Color, Audio), resizable panels (sizes remembered), beginner mode that hides advanced controls, interactive tour, tooltips
- ✅ Media relinking (duration-checked), offline media detection, proxies for heavy codecs or > 1080p

### AI analysis and Editing Director
- ✅ Measured analysis: pauses and silence, loudness (LUFS / true peak), clipping, noise floor, energy envelope (emphasis), scene changes, exposure and saturation per scene, scene keyframes
- ✅ Free built-in director: dead-air trimming, pause removal (never cuts through a word), filler words, stutters, retakes / false starts / repeated sentences (keeps the later take), generic-greeting detection, hook (cold-open) suggestion, emphasis zooms with spacing limits, engagement-drop detection, scene-by-scene B-roll suggestions with search queries, transitions only at real breaks, loudness, denoise, voice chain, colour correction, captions, music mood, SFX placement, optional target-length trimming (never auto-applied)
- 🔌 Claude director (`ANTHROPIC_API_KEY`): content-aware plan with semantic retake and redundancy detection, B-roll ideas, tone, and the publishing kit; uses scene keyframes for **visual understanding (objects / activities)**. Measured cuts from the built-in engine are kept
- ✅ Every recommendation: what / where (source + timeline time) / why / expected effect / auto-or-approval / confidence. Preview (cuts are previewed by skipping the range), apply, reject, restore, adjust boundaries, "apply all safe"
- ✅ Automatic mode (applies safe changes as one undo step) and manual mode
- ✅ Publishing kit: titles, hooks, opening variations, description, chapters (click to seek, copy), thumbnail concepts, tags, short-form clip candidates → **one click creates a 9:16 short project**
- ⚠️ Speaker tone and emotion: the built-in engine uses the loudness and energy envelope. Semantic tone needs Claude

### Captions
- ✅ Word-level timestamps, editable words (spelling, timing, removal), find, low-confidence highlighting, **text-based editing** (select words → delete from video)
- ✅ 6 presets plus full customisation (font, size, colour, highlight colour/mode, outline, shadow, box, uppercase, animation: pop / karaoke / word-by-word reveal / bounce / fade, words per line, lines, reading speed, min word time, vertical position, platform safe area, timing offset)
- ✅ Identical look in preview and export (same OFL fonts in browser and libass), SRT / VTT export, SRT / VTT import (word timing approximated per cue)
- 🔌 Automatic speech recognition: free local Whisper, or Deepgram / Groq / OpenAI
- 🔌 Speaker identification: Deepgram diarization. Speaker names are editable. Without Deepgram, labels are manual

### B-roll and supporting visuals
- ✅ Scene-by-scene suggestions (narration, visual description, asset type, query, duration, animation, transition, reasoning)
- ✅ Upload your own media or search licensed stock. **Openverse works without a key**; Pexels and Pixabay need free keys. Licence, author and source URL are stored per asset and shown in the UI
- ✅ Applying a suggestion places the asset on an overlay track with slow zoom, crossfade in/out and fill framing (adjustable afterwards)

### Effects, motion, transitions and colour
- ✅ Camera motion presets (slow zoom in/out, punch in/out, pans, Ken Burns, shake) with intensity, plus custom keyframes (scale / position / rotation / opacity, linear or ease)
- ✅ Blur, sharpen, vignette, film grain, glow, blurred-background fill, adjustment layers
- ✅ Speed changes (pitch-preserving audio in export)
- ✅ 11 transitions (cut, crossfade, fade to black/white, swipe ×3, zoom, blur, whip pan, glitch) with duration and intensity. Overlapping transitions use real source handles
- ✅ Titles, lower thirds, callouts, arrows, highlight boxes, progress bars with in/out animations
- ✅ Colour workspace: exposure, contrast, highlights, shadows, saturation, temperature, tint, lift / gamma / gain wheels, master curve, LUTs (5 built-in, import `.cube`), looks, before/after and split view, copy/paste grade, apply to all clips of a source
- ⚠️ The preview grading is a GPU approximation of the FFmpeg chain, so final colours can differ slightly. The whip-pan motion blur is approximated

### Audio
- ✅ Mixer: per-track volume, pan, mute, solo, live meters, high-pass, voice enhance, 3-band EQ, compressor, limiter. Master volume, limiter, target loudness
- ✅ Music ducking under speech (sidechain compressor in export, transcript-driven ducking in preview), clip volume and fades, crossfade audio on transitions
- ✅ Loudness normalisation (EBU R128) and FFT noise reduction, applied in the export
- ✅ Royalty-free SFX (whoosh, impact, riser, pop, click, ding) and simple music beds generated locally, plus clipping detection
- ⚠️ Noise reduction and loudness normalisation are **export-only** (the preview plays everything else live). There is no licensed music library: import your own music or use Openverse CC audio

### Export and social media
- ✅ Presets: YouTube 1080p/4K/720p, Shorts, TikTok, Reels, Instagram 1:1 and 4:5. Custom resolution, fps, H.264 / H.265, bitrate, audio bitrate and sample rate, captions burned in or not, range export (I/O)
- ✅ Aspect-ratio conversion: smart reframe, fit with blurred background, or centre crop
- ✅ Render queue with progress, cancellation, error log (`data/exports/last-error.log`) and download
- ⚠️ Smart reframing tracks the **visual subject by saliency** (edge and motion energy per scene). It is not a face detector, so check the result and adjust the X position if needed

### Not included in this MVP
- Real background segmentation ("background blur" behind a person); blurred-background fill is provided instead
- Built-in face detection (would need MediaPipe or similar, which is a model download)
- WebCodecs-based preview (HTML media elements are used) and collaborative or multi-user editing

## Keyboard shortcuts

Space/K play · J/L ±1s · ←/→ frame · ↑/↓ edit points · S or Ctrl+B split · Del / Shift+Del delete / ripple delete ·
Ctrl+Z / Ctrl+Shift+Z undo/redo · Ctrl+D duplicate · Ctrl+S save version · V/B select/blade · N snapping · M marker ·
I/O in/out · +/- zoom · T title · 1–4 workspaces · Ctrl+E export · ? help

## Tests

```bash
npm test                         # unit tests: timeline ops, captions/ASS, AI heuristics, apply, preview↔export motion parity, render graph
npx tsx tests/render-smoke.ts    # end-to-end render through a running server (needs talk.mp4/broll.mp4/photo.png imported)
```
