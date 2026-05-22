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
