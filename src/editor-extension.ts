import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { Range, StateEffect } from "@codemirror/state";

export const refreshEffect = StateEffect.define<void>();

export interface EditorWidgetProvider {
  getRewriteCandidate(): { filePath: string; text: string } | null;
  applyRewrite(): Promise<void>;
  stopRecording(): Promise<void>;
  isRewriting(): boolean;
}

class PlaceholderWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly jobId: string,
    readonly isRecording: boolean,
    readonly provider: EditorWidgetProvider,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const span = activeDocument.createElement("span");
    span.className = this.isRecording
      ? "gemmanotes-badge-emoji gemmanotes-recording-emoji"
      : "gemmanotes-badge-emoji gemmanotes-transcribing-emoji";
    span.textContent = this.isRecording ? "🎤" : "⏳";

    if (this.isRecording) {
      span.title = `Click to stop recording (gn-${this.jobId})`;
      span.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.provider.stopRecording();
      });
    } else {
      span.title = `Transcribing (gn-${this.jobId})`;
    }

    return span;
  }

  ignoreEvent(): boolean {
    return !this.isRecording;
  }
}

class RewriteWidget extends WidgetType {
  constructor(
    readonly provider: EditorWidgetProvider,
    readonly rewritingState: boolean,
  ) {
    super();
  }

  eq(other: RewriteWidget): boolean {
    return other.rewritingState === this.rewritingState;
  }

  toDOM(): HTMLElement {
    const span = activeDocument.createElement("span");

    if (this.rewritingState) {
      span.className = "gemmanotes-badge-emoji gemmanotes-transcribing-emoji";
      span.textContent = "⏳";
      span.title = "Rewriting…";
    } else {
      span.className = "gemmanotes-rewrite-magic-emoji";
      span.textContent = "✨";
      span.title = "Rewrite last note";
      span.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.provider.applyRewrite();
      });
    }

    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function buildDecorations(view: EditorView, provider: EditorWidgetProvider): DecorationSet {
  const builder: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const regex = /(🎤 Recording…|⏳ Transcribing…)\s+⟨gn-([a-z0-9]+)⟩/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const matchStart = from + match.index;
      const matchEnd = matchStart + match[0].length;

      const type = match[1];
      const jobId = match[2];
      const isRecording = type.includes("Recording");

      const deco = Decoration.replace({
        widget: new PlaceholderWidget(match[0], jobId, isRecording, provider),
        side: 0,
      });
      builder.push(deco.range(matchStart, matchEnd));
    }
  }

  const candidate = provider.getRewriteCandidate();
  if (candidate) {
    const docText = view.state.doc.toString();
    const idx = docText.indexOf(candidate.text);
    if (idx !== -1) {
      const endPos = idx + candidate.text.length;
      const deco = Decoration.widget({
        widget: new RewriteWidget(provider, provider.isRewriting()),
        side: 1,
      });
      builder.push(deco.range(endPos));
    }
  }

  // Sort decorations by range start position to satisfy CodeMirror constraints
  builder.sort((a, b) => a.from - b.from);

  return Decoration.set(builder);
}

class PlaceholderPluginValue {
  decorations: DecorationSet;
  lastRewriting: boolean;
  lastCandidateText: string | null;

  constructor(view: EditorView, readonly provider: EditorWidgetProvider) {
    this.lastRewriting = provider.isRewriting();
    this.lastCandidateText = provider.getRewriteCandidate()?.text || null;
    this.decorations = buildDecorations(view, provider);
  }

  update(update: ViewUpdate) {
    const hasRefreshEffect = update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(refreshEffect)),
    );
    const currentRewriting = this.provider.isRewriting();
    const currentCandidateText = this.provider.getRewriteCandidate()?.text || null;

    if (
      update.docChanged ||
      update.viewportChanged ||
      hasRefreshEffect ||
      this.lastRewriting !== currentRewriting ||
      this.lastCandidateText !== currentCandidateText
    ) {
      this.lastRewriting = currentRewriting;
      this.lastCandidateText = currentCandidateText;
      this.decorations = buildDecorations(update.view, this.provider);
    }
  }
}

export function getPlaceholderPlugin(provider: EditorWidgetProvider) {
  return ViewPlugin.fromClass(
    class extends PlaceholderPluginValue {
      constructor(view: EditorView) {
        super(view, provider);
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}
