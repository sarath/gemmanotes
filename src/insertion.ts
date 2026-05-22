/**
 * Placeholder-pinned insertion.
 *
 * When recording stops, a unique token is written into the target file. That
 * token survives the user moving their cursor, switching files, or closing the
 * note. When transcription finishes, the token is swapped for the real text.
 */

import { App, Editor, TFile, normalizePath } from "obsidian";
import type { Placement } from "./types";

export type ReplaceResult =
  | { kind: "replaced" }
  | { kind: "orphan-appended" }
  | { kind: "orphan-no-file" };

/** The visible placeholder text written while a job is in flight. */
export function placeholderToken(jobId: string): string {
  return `⏳ Transcribing… ⟨gn-${jobId}⟩`;
}

/**
 * Insert a placeholder for `jobId` into `file`.
 *
 * `editor` is the live editor for the active view, used only for cursor
 * placement when it is actually editing `file`.
 */
export async function insertPlaceholder(
  app: App,
  file: TFile,
  jobId: string,
  placement: Placement,
  headingName: string,
  editor: Editor | null,
): Promise<void> {
  const token = placeholderToken(jobId);

  if (placement === "cursor" && editor) {
    editor.replaceSelection(token);
    return;
  }
  if (placement === "heading") {
    await appendUnderHeading(app, file, headingName, token);
    return;
  }
  // "end", or "cursor" with no live editor.
  await appendToEnd(app, file, token);
}

/**
 * Replace a job's placeholder with the final text. Falls back to the
 * "Voice Ramblings" heading if the token was deleted, or to no file at all.
 */
export async function replaceToken(
  app: App,
  filePath: string,
  jobId: string,
  text: string,
  headingName: string,
): Promise<ReplaceResult> {
  const file = app.vault.getAbstractFileByPath(normalizePath(filePath));
  if (!(file instanceof TFile)) return { kind: "orphan-no-file" };

  const token = placeholderToken(jobId);
  let found = false;
  await app.vault.process(file, (content) => {
    if (content.includes(token)) {
      found = true;
      return content.replace(token, text);
    }
    return content;
  });

  if (found) return { kind: "replaced" };

  await appendUnderHeading(app, file, headingName, text);
  return { kind: "orphan-appended" };
}

/** Remove a job's placeholder without inserting anything (used on error). */
export async function clearToken(
  app: App,
  filePath: string,
  jobId: string,
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(normalizePath(filePath));
  if (!(file instanceof TFile)) return;
  const token = placeholderToken(jobId);
  await app.vault.process(file, (content) =>
    content.replace(`\n${token}`, "").replace(token, ""),
  );
}

async function appendToEnd(app: App, file: TFile, text: string): Promise<void> {
  await app.vault.process(file, (content) => {
    const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
    return `${content}${sep}${text}`;
  });
}

async function appendUnderHeading(
  app: App,
  file: TFile,
  headingName: string,
  text: string,
): Promise<void> {
  await app.vault.process(file, (content) => {
    const heading = `## ${headingName}`;
    if (content.includes(heading)) {
      const idx = content.indexOf(heading) + heading.length;
      return `${content.slice(0, idx)}\n\n${text}${content.slice(idx)}`;
    }
    const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
    return `${content}${sep}\n${heading}\n\n${text}`;
  });
}
