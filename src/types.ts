/** Shared types and settings for GemmaNotes. */

export type TranscriptionModelVariant = "E2B" | "E4B" | "Whisper-Tiny";
export type RewriteModelVariant = "E2B" | "E4B";
export type ModelVariant = TranscriptionModelVariant | RewriteModelVariant;

export type Placement = "cursor" | "end" | "heading";
export type Style = "cleaned" | "verbatim";

export interface GemmaNotesSettings {
  /** Deprecated: use transcriptionModel instead. */
  modelVariant?: ModelVariant;
  /** Deprecated: use downloadedModels instead. */
  modelDownloaded?: boolean;

  /** Which model to use for transcription. */
  transcriptionModel: TranscriptionModelVariant;
  /** Which model to use for rewriting. */
  rewriteModel: RewriteModelVariant;
  /** Set true for each model that has finished downloading at least once. */
  downloadedModels: Record<string, boolean>;

  /** Where transcribed text is inserted. */
  placement: Placement;
  /** Heading used when placement === "heading" or for orphan fallback. */
  headingName: string;
  /** Transcription style for the default insert. */
  style: Style;
  /** BCP-47 language code, or "auto" for detection. */
  language: string;
  /** Keep the raw recording as a vault attachment. */
  keepAudio: boolean;
}

export const DEFAULT_SETTINGS: GemmaNotesSettings = {
  transcriptionModel: "E2B",
  rewriteModel: "E2B",
  downloadedModels: {
    E2B: false,
    E4B: false,
    "Whisper-Tiny": false,
  },
  placement: "cursor",
  headingName: "Voice Ramblings",
  style: "cleaned",
  language: "auto",
  keepAudio: false,
};

/** ONNX model repo ids on the Hugging Face hub. */
export const MODEL_REPOS: Record<ModelVariant, string> = {
  E2B: "onnx-community/gemma-4-E2B-it-ONNX",
  E4B: "onnx-community/gemma-4-E4B-it-ONNX",
  "Whisper-Tiny": "onnx-community/whisper-tiny.en",
};

/** Approximate on-disk download size, shown in settings. */
export const MODEL_SIZES: Record<ModelVariant, string> = {
  E2B: "~3.2 GB",
  E4B: "~5 GB",
  "Whisper-Tiny": "~40 MB",
};

/** A unit of transcription work flowing through the FIFO queue. */
export interface TranscriptionJob {
  /** Unique id, also embedded in the placeholder token. */
  id: string;
  /** Path of the file the placeholder was inserted into. */
  filePath: string;
  /** Decoded mono 16 kHz audio. */
  audio: Float32Array;
}
