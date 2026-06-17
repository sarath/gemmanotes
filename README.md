# GemmaNotes

Push-to-talk voice notes for Obsidian, transcribed **entirely on-device** with
Google's Gemma 4 (E2B / E4B) running in-process via transformers.js. No server,
no API key — fully offline after a one-time model download. 

🚀 Install here: 
https://community.obsidian.md/plugins/gemmanotes

✨ New: Magic rewrite is available for any selected text. Use local Gemma 4 model to  rephrase any text!

## How it works

1. Toggle recording with the ribbon mic button or the **Toggle voice recording**
   command (bind a hotkey to it).
2. On stop, a placeholder is pinned into the current note.
3. Audio is decoded to 16 kHz mono, split into ≤25 s chunks, and transcribed by
   Gemma 4. Transcriptions run through a FIFO queue, so you can start the next
   recording while one is still processing.
4. The placeholder is swapped for the transcribed text.
5. A status-bar hint offers a one-click **Magic Rewrite** into tidy prose.

## Network Requests & WASM Disclosures

### Network Requests
This plugin makes network requests solely for the purpose of a one-time download of the required transcription and rewriting models, as well as the ONNX Runtime WebAssembly execution engines. Once downloaded, all models run locally and in-process. No data or recording is ever sent to any remote server.

The network request destinations are:
1. **Hugging Face Model Registry (`https://huggingface.co`)**: Used to download the model weights, tokenizers, and configuration files for the selected model variants:
   - Whisper-Tiny (`onnx-community/whisper-tiny.en`)
   - Gemma 4 E2B (`onnx-community/gemma-4-E2B-it-ONNX`)
   - Gemma 4 E4B (`onnx-community/gemma-4-E4B-it-ONNX`)
2. **jsDelivr CDN (`https://cdn.jsdelivr.net`)**: Used by Hugging Face `transformers.js` to dynamically download the required ONNX Runtime WebAssembly library files.

### WebAssembly (WASM) Modules
To perform in-process inference on-device, this plugin uses the following WebAssembly binary file:
- **`ort-wasm-simd-threaded.asyncify.wasm`** (and related `ort-wasm*.wasm` files): These are official, compiled WebAssembly modules of the Microsoft ONNX Runtime library. They are fetched from the jsDelivr CDN and are used to execute the deep learning models locally within Obsidian. They are compiled from the open-source source code hosted at the official [ONNX Runtime repository](https://github.com/microsoft/onnxruntime).

### Clipboard Access
This plugin writes to the system clipboard:
- **Write-Only Access**: If the user enables the optional **"Copy rewrites to clipboard"** setting in settings, the plugin will copy the successfully rewritten note text directly to the system clipboard using the standard Web API `navigator.clipboard.writeText`. The plugin never reads from the clipboard.

### Dynamic Code Execution
- The plugin utilizes WebAssembly (`ort-wasm-simd-threaded.asyncify.wasm` from ONNX Runtime) to execute model inference in-process. WebAssembly engines may internally use dynamic code compilation (such as `new Function()`) to optimize runtime kernel performance. No dynamically generated JavaScript from external sources is ever executed.


## Known v1 limitations

- **Fixed-window chunking** — long recordings are cut on a 25 s boundary, which
  can split a word. Silence-aware chunking is the planned next step.
- **Undo granularity** — placeholder→text and rewrite swaps are written via the
  vault API; they are not always a single editor-undo step.
- **Model cache** — stored in the browser Cache API. Persistent and offline-safe,
  but not yet relocated to the plugin data dir.
- Desktop only — the model size and WebGPU requirement rule out mobile.
