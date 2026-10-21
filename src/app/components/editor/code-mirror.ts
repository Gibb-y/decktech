import { Component, ElementRef, afterNextRender, effect, inject, input, output, untracked, viewChild, DestroyRef } from '@angular/core';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';

export type CodeLanguage = 'html' | 'css' | 'js';

const LANGUAGES: Record<CodeLanguage, () => Extension> = { html: () => html(), css: () => css(), js: () => javascript() };

/**
 * The one place that imports CodeMirror 6 (ADR-005): `npm run lint:boundaries` fails on any other
 * import, and on a static import of this file, so the editor stays in a lazy chunk that the code
 * editor dialog and the read-only code inspector (a later issue) share. A labelled multi-line text
 * box; Tab is not captured, so the keyboard can always leave it (indent is Ctrl+]).
 */
@Component({
  selector: 'app-code-mirror',
  template: `<div #surface class="surface"></div>`,
  styles: `
    :host {
      display: block;
      min-height: 0;
    }
    .surface,
    .surface ::ng-deep .cm-editor {
      height: 100%;
    }
    .surface ::ng-deep .cm-editor {
      border: 1px solid #5a5a5a;
      border-radius: 0.25rem;
      background: #fff;
      color: #111;
      font-size: 0.9rem;
    }
    .surface ::ng-deep .cm-editor.cm-focused {
      outline: 3px solid #ffbf47;
      outline-offset: 1px;
    }
    .surface ::ng-deep .cm-scroller {
      font-family: ui-monospace, Consolas, monospace;
      overflow: auto;
    }
    .surface ::ng-deep .cm-gutters {
      background: #f1f2f4;
      color: #4a4a4a;
      border-right: 1px solid #c3c6cc;
    }
  `,
})
export class CodeMirror {
  readonly value = input.required<string>();
  readonly language = input.required<CodeLanguage>();
  /** The accessible name of the text box. */
  readonly label = input.required<string>();
  readonly changed = output<string>();

  private readonly surface = viewChild.required<ElementRef<HTMLElement>>('surface');
  private view: EditorView | null = null;

  constructor() {
    afterNextRender(() => {
      const view = new EditorView({
        parent: this.surface().nativeElement,
        state: EditorState.create({
          doc: untracked(this.value),
          extensions: [
            lineNumbers(),
            history(),
            drawSelection(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            autocompletion(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap]),
            LANGUAGES[untracked(this.language)](),
            EditorView.contentAttributes.of({ 'aria-label': untracked(this.label), 'aria-multiline': 'true' }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) this.changed.emit(update.state.doc.toString());
            }),
          ],
        }),
      });
      this.view = view;
    });
    // Text set from outside (not typed) replaces the document; what the author typed comes back equal and is left alone.
    effect(() => {
      const value = this.value();
      const view = this.view;
      if (view && view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    });
    inject(DestroyRef).onDestroy(() => {
      this.view?.destroy();
      this.view = null;
    });
  }

  focus(): void {
    this.view?.focus();
  }
}
