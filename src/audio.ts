/** Audio decoding, downmixing, resampling and fixed-window chunking. */

export const TARGET_SAMPLE_RATE = 16000;
/** Window length for v1 fixed-window chunking. Kept under Gemma's 30 s cap. */
export const CHUNK_SECONDS = 25;

/**
 * Decode a recorded audio blob into a mono Float32Array at 16 kHz.
 *
 * An AudioContext created with an explicit sampleRate resamples during
 * decodeAudioData on Chromium/Electron, which is what Obsidian runs on.
 */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  try {
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    return downmix(buffer);
  } finally {
    await ctx.close();
  }
}

/** Average all channels into a single mono track. */
function downmix(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer;
  if (numberOfChannels === 1) return buffer.getChannelData(0).slice();

  const mono = new Float32Array(length);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) mono[i] += data[i];
  }
  for (let i = 0; i < length; i++) mono[i] /= numberOfChannels;
  return mono;
}

/**
 * Split audio into fixed-length windows no longer than Gemma's 30 s cap.
 * v1 is a blind cut; silence-aware splitting is a planned fast-follow.
 */
export function chunkAudio(audio: Float32Array): Float32Array[] {
  const windowSamples = CHUNK_SECONDS * TARGET_SAMPLE_RATE;
  if (audio.length <= windowSamples) return [audio];

  const chunks: Float32Array[] = [];
  for (let start = 0; start < audio.length; start += windowSamples) {
    chunks.push(audio.subarray(start, start + windowSamples));
  }
  return chunks;
}

/** Total duration of a 16 kHz buffer, in seconds. */
export function durationSeconds(audio: Float32Array): number {
  return audio.length / TARGET_SAMPLE_RATE;
}

/**
 * Encode a mono Float32Array into a 16-bit PCM WAV file and return it as a
 * base64-encoded string. Used to send audio chunks to Ollama's API, which
 * inspects RIFF/WAVE magic bytes in its `images` payload array.
 */
export function encodeWavBase64(
  audio: Float32Array,
  sampleRate = TARGET_SAMPLE_RATE,
): string {
  const numSamples = audio.length;
  const dataBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, 1, true); // NumChannels = 1 (mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // ByteRate = sampleRate * 1 * 2
  view.setUint16(32, 2, true); // BlockAlign = 1 * 2
  view.setUint16(34, 16, true); // BitsPerSample = 16
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, audio[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode(...slice));
  }
  return btoa(chunks.join(""));
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
