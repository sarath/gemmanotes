import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

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
      ? "gemmanotes-badge gemmanotes-badge-recording"
      : "gemmanotes-badge gemmanotes-badge-transcribing";

    const icon = document.createElement("span");
    icon.className = "gemmanotes-badge-icon";
    icon.textContent = this.isRecording ? "🎤" : "⏳";

    const textSpan = document.createElement("span");
    textSpan.className = "gemmanotes-badge-text";
    textSpan.textContent = this.isRecording
      ? `Recording (gn-${this.jobId})`
      : `Transcribing (gn-${this.jobId})`;

    span.appendChild(icon);
    span.appendChild(textSpan);
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
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

  return Decoration.set(builder);
}

class PlaceholderPluginValue {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildDecorations(update.view);
    }
  }
}

export const placeholderPlugin = ViewPlugin.fromClass(
  PlaceholderPluginValue,
  {
    decorations: (v: PlaceholderPluginValue) => v.decorations,
  },
);
