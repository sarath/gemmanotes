/** GemmaNotes — push-to-talk voice notes transcribed on-device with Gemma 4. */

import { FileSystemAdapter, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import * as path from "path";
import { DEFAULT_SETTINGS } from "./types";
import type { GemmaNotesSettings, TranscriptionJob } from "./types";
import { GemmaNotesSettingTab } from "./settings";
import { Recorder } from "./recorder";
import { decodeToMono16k } from "./audio";
import { DualBackend, detectWebGPU } from "./transcriber";
import type { ProgressUpdate, TranscriptionBackend } from "./transcriber";
import { TranscriptionQueue } from "./queue";
import type { QueueState } from "./queue";
import {
  clearToken,
  insertPlaceholder,
  replaceToken,
  startTranscribing,
} from "./insertion";
import { getPlaceholderPlugin, refreshEffect } from "./editor-extension";
import { getSelectionRewritePlugin } from "./selection-rewrite";
import { RewritePreviewModal } from "./rewrite-modal";

/** A completed insert that can still be swapped for a rewrite. */
interface RewriteCandidate {
  filePath: string;
  text: string;
}

export default class GemmaNotesPlugin extends Plugin {
  settings!: GemmaNotesSettings;
  webGPUAvailable = false;

  private recorder = new Recorder();
  private backend!: TranscriptionBackend;
  private queue!: TranscriptionQueue;

  private stateBar!: HTMLElement;
  private hintBar!: HTMLElement;
  private ribbonEl!: HTMLElement;
  private timer: number | null = null;

  private rewriteCandidate: RewriteCandidate | null = null;
  private gpuWarned = false;
  private activeJobId: string | null = null;
  private activeJobFilePath: string | null = null;
  private loadPromise: Promise<void> | null = null;
  private rewriting = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.webGPUAvailable = await detectWebGPU();
    await this.resetBackend();

    this.queue = new TranscriptionQueue(
      () => this.backend,
      () => ({ style: this.settings.style, language: this.settings.language }),
      (job, text) => this.handleResult(job, text),
      (job, err) => this.handleError(job, err),
      (state) => this.renderState(state),
    );

    this.stateBar = this.addStatusBarItem();
    this.stateBar.addClass("gemmanotes-statusbar");
    this.hintBar = this.addStatusBarItem();
    this.hintBar.addClass("gemmanotes-hint");
    this.hintBar.hide();

    this.ribbonEl = this.addRibbonIcon("mic", "GemmaNotes: toggle recording", () =>
      this.toggleRecording(),
    );
    this.ribbonEl.addClass("gemmanotes-ribbon");

    this.addCommand({
      id: "toggle-recording",
      name: "Toggle voice recording",
      callback: () => this.toggleRecording(),
    });

    this.addSettingTab(new GemmaNotesSettingTab(this.app, this));

    this.registerEditorExtension(
      getPlaceholderPlugin({
        getRewriteCandidate: () => this.rewriteCandidate,
        applyRewrite: () => this.applyRewrite(),
        stopRecording: () => this.stopRecording(),
        isRewriting: () => this.rewriting,
      }),
    );

    this.registerEditorExtension(
      getSelectionRewritePlugin({
        isEnabled: () => this.settings.enableSelectionRewrite,
        getMinWords: () => this.settings.selectionRewriteMinWords,
        isModelReady: () => {
          const rxDownloaded = this.settings.downloadedModels[this.settings.rewriteModel];
          if (!rxDownloaded) {
            new Notice("GemmaNotes: download the selected rewrite model in settings first.");
            return false;
          }
          return true;
        },
        rewriteText: async (text: string) => {
          if (this.loadPromise) {
            await this.loadPromise;
          }
          return await this.backend.rewrite(text);
        },
        openPreviewModal: (originalText: string, rewrittenText: string, onSubmit: (finalText: string) => void) => {
          new RewritePreviewModal(this.app, originalText, rewrittenText, onSubmit).open();
        },
      }),
    );

    // Retract the rewrite hint once the inserted text is edited away.
    this.registerEvent(
      this.app.workspace.on("editor-change", () => this.validateHint()),
    );

    this.renderState({ transcribing: false, remaining: 0 });

    this.app.workspace.onLayoutReady(() => {
      void this.loadModelsIfDownloaded();
    });
  }

  onunload(): void {
    this.recorder.cancel();
    void this.backend?.unload();
    if (this.timer != null) window.clearInterval(this.timer);
    if (this.activeJobId && this.activeJobFilePath) {
      void clearToken(this.app, this.activeJobFilePath, this.activeJobId);
    }
  }

  // --- Backend lifecycle ---------------------------------------------------

  /** Recreate or update the backend, e.g. after the model variant changed. */
  async resetBackend(): Promise<void> {
    if (this.backend) {
      if (this.backend instanceof DualBackend) {
        await this.backend.updateVariants(
          this.settings.transcriptionModel,
          this.settings.rewriteModel,
          this.webGPUAvailable,
          this.getCacheDir(),
        );
        this.loadPromise = null;
        void this.loadModelsIfDownloaded();
        return;
      }
      await this.backend.unload();
    }

    this.backend = new DualBackend(
      this.settings.transcriptionModel,
      this.settings.rewriteModel,
      this.webGPUAvailable,
      this.getCacheDir(),
    );
    this.loadPromise = null;

    void this.loadModelsIfDownloaded();
  }

  getCacheDir(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      const vaultPath = adapter.getBasePath();
      return path.join(
        vaultPath,
        this.manifest.dir || `.obsidian/plugins/${this.manifest.id}`,
        ".cache"
      );
    }
    return path.join(
      this.manifest.dir || `.obsidian/plugins/${this.manifest.id}`,
      ".cache"
    );
    this.loadPromise = null;
  }

  /** Download + load the selected model, reporting progress to the caller. */
  async downloadModel(onProgress: (u: ProgressUpdate) => void): Promise<void> {
    this.loadPromise = this.backend.load(onProgress);
    await this.loadPromise;

    this.settings.downloadedModels[this.settings.transcriptionModel] = true;
    this.settings.downloadedModels[this.settings.rewriteModel] = true;
    await this.saveSettings();
  }

  // --- Recording -----------------------------------------------------------

  private async toggleRecording(): Promise<void> {
    if (this.recorder.isRecording) {
      await this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  private async startRecording(): Promise<void> {
    const txDownloaded = this.settings.downloadedModels[this.settings.transcriptionModel];
    const rxDownloaded = this.settings.downloadedModels[this.settings.rewriteModel];
    if (!txDownloaded || !rxDownloaded) {
      new Notice("GemmaNotes: download the selected models in settings first.");
      return;
    }
    const file = this.activeMarkdownFile();
    if (!file) {
      new Notice("GemmaNotes: open a note to record into.");
      return;
    }
    if (!this.webGPUAvailable && !this.gpuWarned) {
      new Notice(
        "GemmaNotes: WebGPU unavailable — transcription will run on CPU and " +
          "be slow.",
        8000,
      );
      this.gpuWarned = true;
    }
    try {
      await this.recorder.start();
    } catch (e) {
      new Notice(`GemmaNotes: microphone unavailable (${String(e)}).`);
      return;
    }
    this.clearHint();
    this.ribbonEl.addClass("is-active");

    const jobId = Math.random().toString(36).slice(2, 8);
    this.activeJobId = jobId;
    this.activeJobFilePath = file.path;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    await insertPlaceholder(
      this.app,
      file,
      jobId,
      this.settings.placement,
      this.settings.headingName,
      view?.editor ?? null,
      true, // isRecording = true
    );

    this.startTimer();
  }

  private async stopRecording(): Promise<void> {
    this.ribbonEl.removeClass("is-active");
    this.stopTimer();

    const jobId = this.activeJobId;
    const filePath = this.activeJobFilePath;
    this.activeJobId = null;
    this.activeJobFilePath = null;

    if (!jobId || !filePath) {
      return;
    }

    let blob: Blob;
    try {
      blob = await this.recorder.stop();
    } catch (e) {
      new Notice(`GemmaNotes: recording failed (${String(e)}).`);
      await clearToken(this.app, filePath, jobId);
      return;
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file ?? this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      new Notice("GemmaNotes: no note to insert into; recording discarded.");
      await clearToken(this.app, filePath, jobId);
      return;
    }

    if (this.settings.keepAudio) {
      await this.saveAudio(blob, file);
    }

    let audio: Float32Array;
    try {
      audio = await decodeToMono16k(blob);
    } catch (e) {
      new Notice(`GemmaNotes: could not decode audio (${String(e)}).`);
      await clearToken(this.app, filePath, jobId);
      return;
    }

    const job: TranscriptionJob = {
      id: jobId,
      filePath: file.path,
      audio,
    };

    if (this.loadPromise) {
      try {
        await this.loadPromise;
      } catch (e) {
        // Ignored here (already logged)
      }
    }

    await startTranscribing(this.app, filePath, jobId);

    this.queue.enqueue(job);
  }

  private async loadModelsIfDownloaded(): Promise<void> {
    const txDownloaded = this.settings.downloadedModels[this.settings.transcriptionModel];
    const rxDownloaded = this.settings.downloadedModels[this.settings.rewriteModel];
    if (txDownloaded && rxDownloaded) {
      if (this.loadPromise) return;

      this.stateBar.addClass("is-transcribing");
      this.stateBar.setText("⏳ GemmaNotes initializing… (0%)");

      this.loadPromise = this.backend.load((u) => {
        const pct = typeof u.fraction === "number" ? Math.round(u.fraction * 100) : 0;
        this.stateBar.setText(`⏳ GemmaNotes initializing… (${pct}%)`);
      });

      try {
        await this.loadPromise;
        console.log("GemmaNotes: model load successful");
        new Notice("GemmaNotes: Models loaded and ready.");
      } catch (e) {
        console.error("GemmaNotes: background model load failed", e);
        this.loadPromise = null;
        new Notice(`GemmaNotes: Failed to load models (${String(e)})`);
        this.stateBar.setText("⚠️ GemmaNotes failed to load");
      } finally {
        this.stateBar.removeClass("is-transcribing");
        if (this.loadPromise && !this.recorder.isRecording) {
          this.stateBar.setText("");
        }
      }
    }
  }

  // --- Queue callbacks -----------------------------------------------------

  private async handleResult(
    job: TranscriptionJob,
    text: string,
  ): Promise<void> {
    if (!text) {
      await clearToken(this.app, job.filePath, job.id);
      new Notice("GemmaNotes: nothing was transcribed.");
      return;
    }
    const result = await replaceToken(
      this.app,
      job.filePath,
      job.id,
      text,
      this.settings.headingName,
    );
    if (result.kind === "orphan-no-file") {
      new Notice(`GemmaNotes (file gone) — transcription:\n\n${text}`, 0);
      return;
    }
    // Offer a rewrite of this insert.
    this.rewriteCandidate = { filePath: job.filePath, text };
    this.showHint();
  }

  private async handleError(
    job: TranscriptionJob,
    err: unknown,
  ): Promise<void> {
    console.error("GemmaNotes transcription error", err);
    await clearToken(this.app, job.filePath, job.id);
    new Notice(`GemmaNotes: transcription failed (${String(err)}).`);
  }

  // --- Rewrite hint --------------------------------------------------------

  private showHint(): void {
    this.hintBar.empty();
    this.hintBar.setText("✨ Rewrite last note");
    this.hintBar.onclick = () => void this.applyRewrite();
    this.hintBar.show();
    this.refreshEditor();
  }

  private clearHint(): void {
    this.rewriteCandidate = null;
    this.hintBar.onclick = null;
    this.hintBar.hide();
    this.refreshEditor();
  }

  private refreshEditor(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view && (view.editor as any).cm) {
      try {
        (view.editor as any).cm.dispatch({
          effects: refreshEffect.of(),
        });
      } catch (e) {
        console.error("GemmaNotes: failed to refresh editor view", e);
      }
    }
  }

  /** Retract the hint if the inserted text has been edited away. */
  private async validateHint(): Promise<void> {
    const c = this.rewriteCandidate;
    if (!c) return;
    const file = this.app.vault.getAbstractFileByPath(c.filePath);
    if (!(file instanceof TFile)) return this.clearHint();
    const content = await this.app.vault.cachedRead(file);
    if (!content.includes(c.text)) this.clearHint();
  }

  private async applyRewrite(): Promise<void> {
    const c = this.rewriteCandidate;
    if (!c || this.rewriting) return;
    const file = this.app.vault.getAbstractFileByPath(c.filePath);
    if (!(file instanceof TFile)) return this.clearHint();

    this.rewriting = true;
    this.refreshEditor();

    this.hintBar.setText("✨ Rewriting…");
    this.hintBar.onclick = null;
    try {
      const rewritten = await this.backend.rewrite(c.text);
      let swapped = false;
      await this.app.vault.process(file, (content: string) => {
        if (content.includes(c.text)) {
          swapped = true;
          return content.replace(c.text, rewritten);
        }
        return content;
      });
      if (!swapped) {
        new Notice("GemmaNotes: original text was edited; rewrite skipped.");
      } else {
        if (this.settings.copyRewriteToClipboard) {
          try {
            await navigator.clipboard.writeText(rewritten);
            new Notice("GemmaNotes: rewritten text copied to clipboard.");
          } catch (clipErr) {
            console.error("GemmaNotes: failed to copy rewrite to clipboard", clipErr);
          }
        }
      }
    } catch (e) {
      new Notice(`GemmaNotes: rewrite failed (${String(e)}).`);
    } finally {
      this.rewriting = false;
      this.clearHint();
    }
  }

  // --- Status bar ----------------------------------------------------------

  private renderState(state: QueueState): void {
    this.stateBar.removeClass("is-recording", "is-transcribing");
    if (this.recorder.isRecording) {
      this.stateBar.addClass("is-recording");
      this.stateBar.setText(`🔴 Recording ${fmt(this.recorder.elapsed)}`);
    } else if (state.transcribing) {
      this.stateBar.addClass("is-transcribing");
      const queued = state.remaining > 0 ? ` (+${state.remaining})` : "";
      this.stateBar.setText(`⏳ Transcribing…${queued}`);
    } else {
      this.stateBar.setText("");
    }
  }

  private startTimer(): void {
    this.renderState({ transcribing: false, remaining: 0 });
    this.timer = window.setInterval(
      () => this.renderState({ transcribing: false, remaining: 0 }),
      500,
    );
  }

  private stopTimer(): void {
    if (this.timer != null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  // --- Helpers -------------------------------------------------------------

  private activeMarkdownFile(): TFile | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
  }

  private async saveAudio(blob: Blob, note: TFile): Promise<void> {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = await this.app.fileManager.getAvailablePathForAttachment(
        `voice-${stamp}.webm`,
        note.path,
      );
      await this.app.vault.createBinary(path, await blob.arrayBuffer());
    } catch (e) {
      console.error("GemmaNotes: could not save audio attachment", e);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    let migrated = false;
    // Migration logic for old settings format
    if (this.settings.modelVariant) {
      if (!this.settings.transcriptionModel) {
        this.settings.transcriptionModel = this.settings.modelVariant;
      }
      if (!this.settings.rewriteModel) {
        this.settings.rewriteModel = this.settings.modelVariant as any;
      }
      delete this.settings.modelVariant;
      migrated = true;
    }
    if (this.settings.modelDownloaded !== undefined) {
      if (this.settings.modelDownloaded) {
        const variant = this.settings.transcriptionModel || "E2B";
        this.settings.downloadedModels[variant] = true;
      }
      delete this.settings.modelDownloaded;
      migrated = true;
    }

    if (migrated) {
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

/** Format seconds as M:SS. */
function fmt(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
