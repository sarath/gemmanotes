/** Settings tab for GemmaNotes. */

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type GemmaNotesPlugin from "./main";
import { MODEL_REPOS, MODEL_SIZES } from "./types";
import type { ModelVariant, TranscriptionModelVariant, RewriteModelVariant, Placement, Style } from "./types";

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
            this.plugin.resetBackend();
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
            this.plugin.resetBackend();
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

    // --- Manage models ----------------------------------------------------
    new Setting(containerEl).setName("Manage models").setHeading();

    const manageList = containerEl.createDiv({ cls: "gemmanotes-manage-list" });
    manageList.createEl("p", { text: "Loading on-disk model list…" });

    const cleanAllSetting = new Setting(containerEl)
      .setName("Clean all model files")
      .setDesc(
        "Delete every downloaded model file from the plugin directory " +
          "(including legacy cache from earlier versions). Frees disk; you " +
          "will need to re-download before next use.",
      )
      .addButton((b) =>
        b
          .setButtonText("Clean all")
          .setWarning()
          .onClick(async () => {
            b.setDisabled(true);
            try {
              await this.plugin.cleanAllModels();
              new Notice("GemmaNotes: all model files deleted.");
              this.display();
            } catch (e) {
              new Notice(`GemmaNotes: clean failed (${String(e)}).`);
              b.setDisabled(false);
            }
          }),
      );

    void this.renderManageList(manageList, cleanAllSetting);

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

  private async renderManageList(
    container: HTMLElement,
    cleanAllSetting: Setting,
  ): Promise<void> {
    container.empty();
    const baseCleanDesc =
      "Delete every downloaded model file from the plugin directory " +
      "(including legacy cache from earlier versions). Frees disk; you " +
      "will need to re-download before next use.";
    const entries = await this.plugin.downloader.list();
    if (entries.length === 0) {
      container.createEl("p", {
        text: "No models downloaded yet.",
        cls: "setting-item-description",
      });
      cleanAllSetting.setDesc(baseCleanDesc);
      return;
    }
    // Map repo -> variant for the delete button.
    const repoToVariant = new Map<string, ModelVariant>();
    for (const [variant, repo] of Object.entries(MODEL_REPOS)) {
      repoToVariant.set(repo, variant as ModelVariant);
    }
    let total = 0;
    for (const e of entries) {
      total += e.bytes;
      const variant = repoToVariant.get(e.repo);
      const setting = new Setting(container)
        .setName(variant ?? e.repo)
        .setDesc(`${e.repo} — ${formatBytes(e.bytes)}`);
      if (variant) {
        setting.addButton((b) =>
          b.setButtonText("Delete").setWarning().onClick(async () => {
            b.setDisabled(true);
            try {
              await this.plugin.deleteVariant(variant);
              new Notice(`GemmaNotes: deleted ${variant}.`);
              this.display();
            } catch (err) {
              new Notice(`GemmaNotes: delete failed (${String(err)}).`);
              b.setDisabled(false);
            }
          }),
        );
      }
    }
    cleanAllSetting.setDesc(`${baseCleanDesc} Total on disk: ${formatBytes(total)}.`);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
