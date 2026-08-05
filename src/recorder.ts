/** Microphone capture via the MediaRecorder API. */

export class Recorder {
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;

  get isRecording(): boolean {
    return this.mediaRecorder?.state === "recording";
  }

  /** Seconds elapsed since recording began. */
  get elapsed(): number {
    return this.isRecording ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  /** Request the microphone and begin capturing. Throws if permission is denied. */
  async start(): Promise<void> {
    if (this.isRecording) return;
    // Use activeWindow.navigator for Obsidian popout window compatibility
    this.stream = await activeWindow.navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(this.stream);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.start();
    this.startedAt = Date.now();
  }

  /** Stop capturing and resolve with the recorded blob. Releases the mic. */
  async stop(): Promise<Blob> {
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state === "inactive") {
      throw new Error("Recorder is not active.");
    }
    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () =>
        resolve(new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" }));
      recorder.stop();
    });
    this.release();
    return blob;
  }

  /** Abort recording without producing a blob. */
  cancel(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.stop();
    }
    this.release();
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.mediaRecorder = null;
    this.chunks = [];
  }
}
