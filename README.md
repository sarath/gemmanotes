# GemmaNotes

Push-to-talk voice notes for Obsidian, transcribed **entirely on-device** with
Google's Gemma 4 (E2B / E4B) running in-process via transformers.js. No server,
no API key — fully offline after a one-time model download.

## How it works

1. Toggle recording with the ribbon mic button or the **Toggle voice recording**
   command (bind a hotkey to it).
2. On stop, a placeholder is pinned into the current note.
3. Audio is decoded to 16 kHz mono, split into ≤25 s chunks, and transcribed by
   Gemma 4. Transcriptions run through a FIFO queue, so you can start the next
   recording while one is still processing.
4. The placeholder is swapped for the transcribed text.
5. A status-bar hint offers a one-click **rewrite** into tidy prose.

## Setup

```bash
npm install
npm run build      # production bundle -> main.js
npm run dev        # watch mode
```

Install into a vault for local testing:

```bash
./install.sh /path/to/your/vault <feature-branch>
```

Or with an environment variable:

```bash
FEATURE_BRANCH=<feature-branch> ./install.sh /path/to/your/vault
```

This fetches `origin`, checks out `origin/<feature-branch>` cleanly, runs
`npm run build`, and copies `main.js`, `manifest.json`, and `styles.css`
into `<vault>/.obsidian/plugins/gemmanotes/`. Then enable the plugin and use
**Settings → GemmaNotes → Download** to fetch the model (~3.2 GB for E2B,
~5 GB for E4B).

## Known v1 limitations

- **Fixed-window chunking** — long recordings are cut on a 25 s boundary, which
  can split a word. Silence-aware chunking is the planned next step.
- **transformers.js Gemma 4 audio API** — the processor/model call in
  `src/transcriber.ts` follows the documented image-text-to-text pattern; the
  exact audio surface should be confirmed against the model card sample code.
- **Undo granularity** — placeholder→text and rewrite swaps are written via the
  vault API; they are not always a single editor-undo step.
- **Model cache** — stored in the browser Cache API. Persistent and offline-safe,
  but not yet relocated to the plugin data dir.
- Desktop only — the model size and WebGPU requirement rule out mobile.

## Platform support

**Desktop only for now.** Mobile (Obsidian iOS/Android) is intentionally not
supported in this release. Revisit when designing a mobile variant; the
constraints to address are:

- **Disk** — Gemma E2B is ~2 GB (q4f16); iOS sandboxes evict large app data
  unpredictably. A mobile build would likely have to be Whisper-Tiny only
  (~40 MB) or use a remote inference endpoint.
- **Memory** — phones with 4 GB RAM will OOM loading Gemma. Even E2B is
  borderline on 6 GB devices.
- **Compute** — WebGPU on mobile renderers is limited or unavailable;
  WASM fallback is ~10× slower and impractical for interactive use.
- **UX** — push-to-talk + on-device transcription is a stronger fit for
  desktop note-taking; mobile users may prefer a thinner client that posts
  audio to a desktop instance or hosted endpoint.

The plugin detects `Platform.isMobile` at load and refuses to initialize the
backend with a clear notice, rather than failing partway through a multi-GB
download.
