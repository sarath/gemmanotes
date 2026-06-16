/** Settings tab for GemmaNotes. */

import { App, PluginSettingTab, Setting } from "obsidian";
import type GemmaNotesPlugin from "./main";
import { MODEL_SIZES } from "./types";
import type { TranscriptionModelVariant, RewriteModelVariant, Placement, Style } from "./types";

export class GemmaNotesSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GemmaNotesPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    // --- Model -------------------------------------------------------------
    new Setting(containerEl).setName("Model").setHeading();

    new Setting(containerEl)
      .setName("Transcription model")
      .setDesc("Whisper-Tiny is extremely fast; E2B is balanced; E4B is more accurate.")
      .addDropdown((d) =>
        d
          .addOption("Whisper-Tiny", `Whisper-Tiny (${MODEL_SIZES["Whisper-Tiny"]})`)
          .addOption("E2B", `Gemma 4 E2B (${MODEL_SIZES.E2B})`)
          .addOption("E4B", `Gemma 4 E4B (${MODEL_SIZES.E4B})`)
          .setValue(s.transcriptionModel)
          .onChange(async (v) => {
            s.transcriptionModel = v as TranscriptionModelVariant;
            await this.plugin.saveSettings();
            await this.plugin.resetBackend();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Rewriting model")
      .setDesc("Gemma model used to tidy up transcribed text. Whisper is not supported here.")
      .addDropdown((d) =>
        d
          .addOption("E2B", `Gemma 4 E2B (${MODEL_SIZES.E2B})`)
          .addOption("E4B", `Gemma 4 E4B (${MODEL_SIZES.E4B})`)
          .setValue(s.rewriteModel)
          .onChange(async (v) => {
            s.rewriteModel = v as RewriteModelVariant;
            await this.plugin.saveSettings();
            await this.plugin.resetBackend();
            this.display();
          }),
      );

    let desc = "";
    const txStatus = s.downloadedModels[s.transcriptionModel] ? "Downloaded" : `Not downloaded (${MODEL_SIZES[s.transcriptionModel]})`;
    const rxStatus = s.downloadedModels[s.rewriteModel] ? "Downloaded" : `Not downloaded (${MODEL_SIZES[s.rewriteModel]})`;

    if (s.transcriptionModel === s.rewriteModel) {
      desc = `${s.transcriptionModel}: ${txStatus}.`;
    } else {
      desc = `Transcription (${s.transcriptionModel}): ${txStatus}. Rewriting (${s.rewriteModel}): ${rxStatus}.`;
    }

    const downloadSetting = new Setting(containerEl)
      .setName("Model files")
      .setDesc(desc);

    const bar = containerEl.createDiv({ cls: "gemmanotes-download-bar" });
    const fill = bar.createDiv();
    bar.hide();

    const isAllDownloaded = s.downloadedModels[s.transcriptionModel] && s.downloadedModels[s.rewriteModel];

    downloadSetting.addButton((b) =>
      b
        .setButtonText(isAllDownloaded ? "Re-download" : "Download missing models")
        .setCta()
        .onClick(async () => {
          b.setDisabled(true);
          bar.show();
          try {
            await this.plugin.downloadModel((u) => {
              fill.style.width = `${Math.round((u.fraction ?? 0) * 100)}%`;
              downloadSetting.setDesc(u.label);
            });
            this.display();
          } catch (e) {
            console.error("GemmaNotes: model load failed", e);
            downloadSetting.setDesc(`Download failed: ${String(e)}`);
            b.setDisabled(false);
            bar.hide();
          }
        }),
    );

    new Setting(containerEl)
      .setName("Hardware acceleration")
      .setDesc(
        this.plugin.webGPUAvailable
          ? "WebGPU is available — transcription runs at full speed."
          : "WebGPU is unavailable — transcription falls back to CPU and will " +
              "be slow.",
      );

    // --- Transcription -----------------------------------------------------
    new Setting(containerEl).setName("Transcription").setHeading();

    new Setting(containerEl)
      .setName("Style")
      .setDesc(
        "Cleaned removes filler words and adds punctuation. Verbatim keeps " +
          "every word as spoken.",
      )
      .addDropdown((d) =>
        d
          .addOption("cleaned", "Lightly cleaned")
          .addOption("verbatim", "Verbatim")
          .setValue(s.style)
          .onChange(async (v) => {
            s.style = v as Style;
            await this.plugin.saveSettings();
          }),
      );

    if (s.transcriptionModel !== "Whisper-Tiny") {
      new Setting(containerEl)
        .setName("Language")
        .setDesc(
          'BCP-47 code (e.g. "en", "hi", "es"), or "auto" to detect per recording.',
        )
        .addText((t) =>
          t
            .setValue(s.language)
            .setPlaceholder("auto")
            .onChange(async (v) => {
              s.language = v.trim() || "auto";
              await this.plugin.saveSettings();
            }),
        );
    }

    // --- Insertion ---------------------------------------------------------
    new Setting(containerEl).setName("Insertion").setHeading();

    new Setting(containerEl)
      .setName("Placement")
      .setDesc("Where transcribed text is inserted in the current file.")
      .addDropdown((d) =>
        d
          .addOption("cursor", "At cursor position")
          .addOption("end", "End of file")
          .addOption("heading", "Under a heading")
          .setValue(s.placement)
          .onChange(async (v) => {
            s.placement = v as Placement;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Heading name")
      .setDesc(
        "Heading used for the 'Under a heading' placement, and as the " +
          "fallback when a placeholder is deleted before transcription finishes.",
      )
      .addText((t) =>
        t.setValue(s.headingName).onChange(async (v) => {
          s.headingName = v.trim() || "Voice Ramblings";
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Copy rewrites to clipboard")
      .setDesc("Automatically copy rewritten text to the clipboard when completed.")
      .addToggle((t) =>
        t.setValue(s.copyRewriteToClipboard).onChange(async (v) => {
          s.copyRewriteToClipboard = v;
          await this.plugin.saveSettings();
        }),
      );

    // --- Selection Rewriting ------------------------------------------------
    new Setting(containerEl).setName("Selection Rewriting").setHeading();

    new Setting(containerEl)
      .setName("Enable selection rewrite")
      .setDesc("Show a rewrite helper tooltip when selecting text in the editor.")
      .addToggle((t) =>
        t.setValue(s.enableSelectionRewrite).onChange(async (v) => {
          s.enableSelectionRewrite = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Minimum word threshold")
      .setDesc("Minimum number of selected words to trigger the rewrite helper.")
      .addText((t) =>
        t
          .setValue(String(s.selectionRewriteMinWords))
          .onChange(async (v) => {
            const num = parseInt(v, 10);
            s.selectionRewriteMinWords = isNaN(num) || num < 1 ? 10 : num;
            await this.plugin.saveSettings();
          }),
      );

    // --- Audio -------------------------------------------------------------
    new Setting(containerEl).setName("Audio").setHeading();

    new Setting(containerEl)
      .setName("Keep recordings")
      .setDesc("Save each recording as a vault attachment instead of discarding it.")
      .addToggle((t) =>
        t.setValue(s.keepAudio).onChange(async (v) => {
          s.keepAudio = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
