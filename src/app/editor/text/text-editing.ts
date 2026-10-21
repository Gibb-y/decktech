import { Service, signal } from '@angular/core';
import type { RichCommand, RichFormat } from './rich-format';

/** What the format controls can ask the running editor to do. Implemented by the lazy ProseMirror chunk. */
export interface TextEditorHandle {
  run(command: RichCommand): void;
  /** `null` removes the link; returns `false` for an address that is not a web or mail address. */
  setLink(href: string | null): boolean;
  setColor(token: string | null): void;
  setSize(token: string | null): void;
  focus(): void;
}

/** Attribute that marks controls (the properties panel's format group) that may take focus without ending the edit. */
export const KEEPS_TEXT_EDITING = 'data-keeps-text-editing';

/** How an edit begins: where the caret goes (client coordinates of the click) and text typed to start it. */
export interface StartOptions {
  at?: { x: number; y: number };
  text?: string;
}

/**
 * State of the in-place text edit (arc42 §8.4): which element is being edited, the format of the
 * selection and a handle on the editor for the properties panel. It holds no ProseMirror, so the
 * editor chunk loads only when an edit starts.
 */
@Service()
export class TextEditing {
  /** Id of the text element being edited, or `null`. */
  readonly editingId = signal<string | null>(null);
  /** Format at the selection of the running editor. */
  readonly format = signal<RichFormat | null>(null);
  /** Counts Ctrl+K presses so the panel can move focus to its link field. */
  readonly linkRequest = signal(0);

  private handle: TextEditorHandle | null = null;

  private pending: StartOptions | null = null;

  start(elementId: string, options: StartOptions | null = null): void {
    this.pending = options;
    this.editingId.set(elementId);
  }

  /** Keys typed while the editor chunk is still loading join the text the edit starts with. */
  appendStart(text: string): void {
    this.pending = { ...this.pending, text: (this.pending?.text ?? '') + text };
  }

  /** The options the running edit began with; handed out once. */
  takeStart(): StartOptions | null {
    const options = this.pending;
    this.pending = null;
    return options;
  }

  stop(): void {
    this.editingId.set(null);
    this.format.set(null);
    this.handle = null;
  }

  attach(handle: TextEditorHandle): void {
    this.handle = handle;
  }

  detach(handle: TextEditorHandle): void {
    if (this.handle === handle) this.handle = null;
  }

  requestLink(): void {
    this.linkRequest.update((n) => n + 1);
  }

  run(command: RichCommand): void {
    this.handle?.run(command);
  }

  setLink(href: string | null): boolean {
    return this.handle?.setLink(href) ?? false;
  }

  setColor(token: string | null): void {
    this.handle?.setColor(token);
  }

  setSize(token: string | null): void {
    this.handle?.setSize(token);
  }

  focusEditor(): void {
    this.handle?.focus();
  }
}
