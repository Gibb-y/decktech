import { Component, DestroyRef, ElementRef, ViewEncapsulation, computed, inject, input, output, type OnInit } from '@angular/core';
import { plainToRich, type RichDoc, type TextEl, type Theme } from '../../core/model';
import { CommandError, DeckStore, SetText } from '../../core/store';
import { RICH_TEXT_CSS, textStyle, themeVars } from '../../renderer';
import { LiveAnnouncer } from '../../shared';
import type { RichCommand, RichFormat } from './rich-format';
import { KEEPS_TEXT_EDITING, TextEditing, type TextEditorHandle } from './text-editing';

/** The document an edit starts from: the stored rich content, or the plain text converted. */
export function startingDoc(element: TextEl): RichDoc {
  return element.rich ?? plainToRich(element.text, element.font === 'heading');
}

/**
 * In-place editor for one text element, drawn in the canvas overlay (so it is scaled with the
 * stage, whatever the zoom) on top of the element it edits. ProseMirror loads on first use as a
 * separate chunk. While focused it keeps its own history; leaving it (blur, Escape) commits the
 * result as one `SetText` command, which is one undo step.
 */
@Component({
  selector: 'app-text-editor',
  template: '<div class="rich"></div>',
  encapsulation: ViewEncapsulation.None,
  styles: `
    app-text-editor {
      position: absolute;
      display: block;
      box-sizing: border-box;
      cursor: text;
      user-select: text;
      outline: calc(2px * var(--inv, 1)) solid #1f4fc4;
    }
    app-text-editor .ProseMirror {
      outline: none;
      min-height: 1.2em;
    }
    ${RICH_TEXT_CSS}
  `,
  host: {
    '[style]': 'boxStyle()',
    '(keydown)': '$event.stopPropagation()',
    '(keyup)': '$event.stopPropagation()',
    '(pointerdown)': '$event.stopPropagation()',
    '(dblclick)': '$event.stopPropagation()',
  },
})
export class TextEditor implements OnInit {
  readonly element = input.required<TextEl>();
  readonly theme = input.required<Theme>();
  /** The edit ended; `true` when the keyboard ended it (Escape), so focus should return to the canvas. */
  readonly closed = output<boolean>();

  private readonly store = inject(DeckStore);
  private readonly editing = inject(TextEditing);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly boxStyle = computed(() => {
    const el = this.element();
    return {
      ...themeVars(this.theme()),
      ...textStyle(el, this.theme()),
      left: `${el.x}px`,
      top: `${el.y}px`,
      width: `${el.w}px`,
      height: `${el.h}px`,
      transform: el.rotation ? `rotate(${el.rotation}deg)` : null,
    };
  });

  private done = false;
  private editor: import('./rich-editor').RichEditor | null = null;
  private handle: TextEditorHandle | null = null;
  /** Captured when the edit begins: the element may change or vanish while it runs. */
  private elementId = '';

  constructor() {
    inject(DestroyRef).onDestroy(() => this.finish(false, false));
  }

  ngOnInit(): void {
    this.elementId = this.element().id;
    void this.load();
  }

  private async load(): Promise<void> {
    const start = this.element();
    const { RichEditor } = await import('./rich-editor');
    if (this.done) return;
    const theme = this.theme();
    const surface = this.host.querySelector<HTMLElement>('.rich')!;
    const editor = new RichEditor(surface, startingDoc(start), {
      label: 'Edit text',
      tokens: { colors: Object.keys(theme.colors), sizes: Object.keys(theme.typeScale) },
      onFormat: (format: RichFormat) => this.editing.format.set(format),
      onBlur: (to) => {
        if (!to?.closest(`[${KEEPS_TEXT_EDITING}]`)) this.finish(false, true);
      },
      onEscape: () => this.finish(true, true),
      onLink: () => this.editing.requestLink(),
    });
    this.editor = editor;
    this.handle = {
      run: (command: RichCommand) => void editor.run(command),
      setLink: (href) => editor.setLink(href),
      setColor: (token) => editor.setColor(token),
      setSize: (token) => editor.setSize(token),
      focus: () => editor.focus(),
    };
    this.editing.attach(this.handle);
    editor.focus(true);
    this.announcer.announce('Editing text. Press Escape to finish.');
  }

  /** Commits once and closes. `emit` is false when the component is already being torn down. */
  private finish(byKeyboard: boolean, emit: boolean): void {
    if (this.done) return;
    this.done = true;
    const editor = this.editor;
    if (this.handle) this.editing.detach(this.handle);
    if (editor) {
      const changed = editor.changed;
      const doc = editor.json();
      editor.destroy();
      if (changed) this.commit(doc);
    }
    if (emit) this.closed.emit(byKeyboard);
  }

  private commit(doc: RichDoc): void {
    try {
      this.store.execute(new SetText(this.elementId, doc));
      this.announcer.announce('Text updated');
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      this.announcer.announce(`The text could not be saved: ${e.message}`);
    }
  }
}
