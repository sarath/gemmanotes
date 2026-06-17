import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

export interface SelectionRewriteProvider {
  isEnabled(): boolean;
  getMinWords(): number;
  isModelReady(): boolean;
  rewriteText(text: string): Promise<string>;
  shouldCopyRewriteToClipboard(): boolean;
  showNotice(message: string): void;
}

class SelectionRewritePluginValue {
  tooltipEl: HTMLElement | null = null;
  rewritingInProgress = false;
  scrollListener: (() => void) | null = null;
  currentSelectedText = "";
  currentSelectionRange: { from: number; to: number } | null = null;

  constructor(
    readonly view: EditorView,
    readonly provider: SelectionRewriteProvider,
  ) {
    this.handleSelectionChange();
    this.setupScrollListener();
  }

  update(update: ViewUpdate) {
    if (update.selectionSet || update.docChanged) {
      this.handleSelectionChange();
    }
  }

  destroy() {
    this.removeTooltip();
    this.cleanupScrollListener();
  }

  private setupScrollListener() {
    this.scrollListener = () => {
      if (!this.rewritingInProgress) {
        this.handleSelectionChange();
      }
    };
    this.view.scrollDOM.addEventListener("scroll", this.scrollListener);
  }

  private cleanupScrollListener() {
    if (this.scrollListener) {
      this.view.scrollDOM.removeEventListener("scroll", this.scrollListener);
      this.scrollListener = null;
    }
  }

  removeTooltip() {
    if (this.tooltipEl) {
      this.tooltipEl.remove();
      this.tooltipEl = null;
    }
  }

  handleSelectionChange() {
    if (this.rewritingInProgress) {
      return;
    }

    if (!this.provider.isEnabled()) {
      this.removeTooltip();
      return;
    }

    if (!this.view.hasFocus) {
      // Delay slightly to check if focus went to the tooltip itself
      window.setTimeout(() => {
        if (!this.view.hasFocus && !this.rewritingInProgress) {
          this.removeTooltip();
        }
      }, 150);
      return;
    }

    const state = this.view.state;
    const selRange = state.selection.main;
    if (selRange.empty) {
      this.removeTooltip();
      return;
    }

    const selectedText = state.doc.sliceString(selRange.from, selRange.to);
    if (!selectedText.trim()) {
      this.removeTooltip();
      return;
    }

    // Clean placeholders out of the text before word count
    const cleanText = selectedText
      .replace(/⏳ Transcribing… ⟨gn-[a-z0-9]+⟩/g, "")
      .replace(/🎤 Recording… ⟨gn-[a-z0-9]+⟩/g, "")
      .trim();

    const wordCount = cleanText.split(/\s+/).filter(Boolean).length;
    if (wordCount < this.provider.getMinWords()) {
      this.removeTooltip();
      return;
    }

    this.currentSelectedText = selectedText;
    this.currentSelectionRange = { from: selRange.from, to: selRange.to };

    this.showTooltip();
  }

  showTooltip() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      this.removeTooltip();
      return;
    }

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    if (!this.tooltipEl) {
      this.tooltipEl = activeDocument.createElement("div");
      this.tooltipEl.className = "gemmanotes-selection-tooltip";
      this.tooltipEl.textContent = "✨ Rewrite";

      this.tooltipEl.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });

      this.tooltipEl.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.currentSelectionRange) {
          await this.startRewrite(this.currentSelectedText, this.currentSelectionRange);
        }
      });

      activeDocument.body.appendChild(this.tooltipEl);
    }

    const tooltipWidth = this.tooltipEl.offsetWidth || 80;
    const tooltipHeight = this.tooltipEl.offsetHeight || 30;

    let left = rect.left + rect.width / 2 - tooltipWidth / 2;
    let top = rect.top - tooltipHeight - 8;

    // Viewport containment
    if (left < 10) left = 10;
    if (left + tooltipWidth > window.innerWidth - 10) {
      left = window.innerWidth - tooltipWidth - 10;
    }

    if (top < 10) {
      top = rect.bottom + 8;
    }

    this.tooltipEl.style.left = `${left + window.scrollX}px`;
    this.tooltipEl.style.top = `${top + window.scrollY}px`;
  }

  async startRewrite(selectedText: string, range: { from: number; to: number }) {
    if (this.rewritingInProgress) return;

    if (!this.provider.isModelReady()) {
      this.removeTooltip();
      return;
    }

    this.rewritingInProgress = true;
    if (this.tooltipEl) {
      this.tooltipEl.textContent = "⏳ Rewriting…";
      this.tooltipEl.classList.add("is-loading");
    }

    try {
      const rewritten = await this.provider.rewriteText(selectedText);

      // Copy to clipboard if enabled in settings
      if (this.provider.shouldCopyRewriteToClipboard()) {
        try {
          await navigator.clipboard.writeText(rewritten);
          this.provider.showNotice("GemmaNotes: rewritten text copied to clipboard.");
        } catch (clipErr) {
          console.error("GemmaNotes: failed to copy rewrite to clipboard", clipErr);
        }
      }

      // Replace selection in editor at the exact saved range and place cursor at the end (unselected)
      const tr = this.view.state.update({
        changes: {
          from: range.from,
          to: range.to,
          insert: rewritten,
        },
        userEvent: "input",
      });
      this.view.dispatch(tr);
    } catch (err) {
      console.error("GemmaNotes: selection rewrite failed", err);
    } finally {
      this.rewritingInProgress = false;
      this.removeTooltip();
      // Trigger update check
      this.handleSelectionChange();
    }
  }
}

export function getSelectionRewritePlugin(provider: SelectionRewriteProvider) {
  return ViewPlugin.fromClass(
    class extends SelectionRewritePluginValue {
      constructor(view: EditorView) {
        super(view, provider);
      }
    },
  );
}
