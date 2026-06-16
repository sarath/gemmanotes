import { App, Modal } from "obsidian";

export class RewritePreviewModal extends Modal {
  constructor(
    app: App,
    private originalText: string,
    private rewrittenText: string,
    private onSubmit: (finalText: string) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
    contentEl.createEl("h2", { text: "✨ Rewrite Selection" });

    // Original text reference
    contentEl.createEl("h4", { text: "Original Text" });
    const origContainer = contentEl.createEl("div", {
      cls: "gemmanotes-modal-original-text",
      text: this.originalText,
    });
    origContainer.style.border = "1px solid var(--border-color)";
    origContainer.style.borderRadius = "4px";
    origContainer.style.padding = "8px";
    origContainer.style.maxHeight = "120px";
    origContainer.style.overflowY = "auto";
    origContainer.style.backgroundColor = "var(--background-secondary)";
    origContainer.style.color = "var(--text-muted)";
    origContainer.style.marginBottom = "16px";
    origContainer.style.whiteSpace = "pre-wrap";
    origContainer.style.fontSize = "0.9em";

    // Rewritten editable text
    contentEl.createEl("h4", { text: "Rewritten Text" });
    const textEditor = contentEl.createEl("textarea", {
      cls: "gemmanotes-modal-rewritten-textarea",
    });
    textEditor.value = this.rewrittenText;
    textEditor.style.width = "100%";
    textEditor.style.height = "160px";
    textEditor.style.resize = "vertical";
    textEditor.style.marginBottom = "16px";
    textEditor.style.padding = "8px";
    textEditor.style.borderRadius = "4px";
    textEditor.style.border = "1px solid var(--border-color)";
    textEditor.style.backgroundColor = "var(--background-primary)";
    textEditor.style.color = "var(--text-normal)";
    textEditor.style.fontFamily = "var(--font-default)";
    textEditor.style.fontSize = "0.95em";

    // Buttons
    const btnContainer = contentEl.createEl("div", {
      cls: "gemmanotes-modal-buttons",
    });
    btnContainer.style.display = "flex";
    btnContainer.style.justifyContent = "flex-end";
    btnContainer.style.gap = "8px";

    const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => {
      this.close();
    };

    const insertBtn = btnContainer.createEl("button", {
      text: "Insert",
      cls: "mod-cta",
    });
    insertBtn.onclick = () => {
      this.onSubmit(textEditor.value);
      this.close();
    };

    // Auto-focus the editor when opened and select all or just focus
    setTimeout(() => {
      textEditor.focus();
    }, 50);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
