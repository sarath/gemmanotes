# GemmaNotes — Spec

Push-to-talk voice notes for Obsidian, transcribed on-device with Gemma 4.

## Architecture
- Single-stage pipeline: audio → Gemma 4 (E2B/E4B) → text. No Whisper, no external server.
- Runs in-process via transformers.js (ONNX `onnx-community/gemma-4-E{2,4}B-it-ONNX`, q4f16).
- Fully offline after first model download. Distributable, zero-setup.
- Desktop-only (`isDesktopOnly: true`).
- Transcription backend behind a small interface so a remote endpoint can slot in later.

## Model
- E2B/E4B user-selectable in settings, switchable later.
- Explicit download from settings with a progress bar; cached under the plugin data dir.
- Hotkey before download → notice pointing to settings.
- WebGPU detected at load; if absent, run on WASM/CPU with a one-time slow warning.

## Input & capture
- Toggle hotkey + ribbon mic button (start/stop).
- 30s audio cap → fixed-window chunking for v1 (silence-aware is a fast-follow).
- Audio discarded after transcription; settings toggle to keep as vault attachments.

## Insertion
- Placement configurable, default = cursor position; falls back to end-of-file.
- On stop: insert a unique placeholder token `⏳ Transcribing… ‹job-id›` pinning the location.
- Each job remembers its target `TFile` — works even if that file is closed.
- Orphaned job (token deleted): append under `## Voice Ramblings` at end of the target file.
  If the file itself is gone: Notice with copyable text.

## Concurrency
- One recording at a time; recording #2 can start while #1 transcribes.
- Transcription is a FIFO queue, one job at a time (single model instance).

## Output styles
- Default insert = lightly-cleaned text (filler removed, punctuation added, wording unchanged).
- Verbatim available as a setting. Language auto-detect with optional fixed override.
- Persistent status-bar hint offers a rewritten version; lazy — runs only on click.
  Hint retracts if the inserted text is edited or the next note is recorded.
  Swap is a single undo step.

## Settings
Model variant · Download/manage model · Insertion placement · Transcription style ·
Language · Keep audio attachments · WebGPU status.
