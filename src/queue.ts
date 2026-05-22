/**
 * FIFO transcription queue.
 *
 * Recording and transcription are independent: the user may start a new
 * recording while an earlier one is still transcribing. Transcription itself
 * is serialized here because there is a single in-memory model instance.
 */

import { chunkAudio } from "./audio";
import type { TranscriptionBackend, TranscribeOptions } from "./transcriber";
import type { TranscriptionJob } from "./types";

export interface QueueState {
  transcribing: boolean;
  /** Jobs waiting behind the one currently running. */
  remaining: number;
}

export class TranscriptionQueue {
  private pending: TranscriptionJob[] = [];
  private running = false;

  constructor(
    private getBackend: () => TranscriptionBackend,
    private getOptions: () => TranscribeOptions,
    private onResult: (job: TranscriptionJob, text: string) => Promise<void>,
    private onError: (job: TranscriptionJob, err: unknown) => Promise<void>,
    private onState: (state: QueueState) => void,
  ) {}

  enqueue(job: TranscriptionJob): void {
    this.pending.push(job);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;

    while (this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.onState({ transcribing: true, remaining: this.pending.length });
      try {
        const text = await this.transcribe(job);
        await this.onResult(job, text);
      } catch (err) {
        await this.onError(job, err);
      }
    }

    this.running = false;
    this.onState({ transcribing: false, remaining: 0 });
  }

  private async transcribe(job: TranscriptionJob): Promise<string> {
    const opts = this.getOptions();
    const chunks = chunkAudio(job.audio);
    const backend = this.getBackend();
    const parts: string[] = [];
    for (const chunk of chunks) {
      parts.push(await backend.transcribeChunk(chunk, opts));
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
}
