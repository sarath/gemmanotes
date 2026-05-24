import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

export interface RewriteProvider {
  getRewriteCandidate(): { filePath: string; text: string } | null;
  applyRewrite(): Promise<void>;
}

class PlaceholderWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly jobId: string,
    readonly isRecording: boolean,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.isRecording
      ? "gemmanotes-badge-emoji gemmanotes-recording-emoji"
      : "gemmanotes-badge-emoji gemmanotes-transcribing-emoji";
    span.textContent = this.isRecording ? "🎤" : "⏳";
    span.title = this.isRecording
      ? `Recording (gn-${this.jobId})`
      : `Transcribing (gn-${this.jobId})`;
    span.style.cursor = "default";
    span.style.margin = "0 4px";
    span.style.display = "inline-block";
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class RewriteWidget extends WidgetType {
  constructor(readonly onClick: () => void) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "gemmanotes-rewrite-magic-emoji";
    span.textContent = "✨";
    span.title = "Rewrite last note";
    span.style.cursor = "pointer";
    span.style.marginLeft = "4px";
    span.style.display = "inline-block";

    span.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onClick();
    });

    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function buildDecorations(view: EditorView, provider: RewriteProvider): DecorationSet {
  const builder: any[] = [];

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
        widget: new PlaceholderWidget(match[0], jobId, isRecording),
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
        widget: new RewriteWidget(() => {
          void provider.applyRewrite();
        }),
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

  constructor(view: EditorView, readonly provider: RewriteProvider) {
    this.decorations = buildDecorations(view, provider);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildDecorations(update.view, this.provider);
    }
  }
}

export function getPlaceholderPlugin(provider: RewriteProvider) {
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
