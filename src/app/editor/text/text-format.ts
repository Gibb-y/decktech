import { Component, ElementRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { TextEl } from '../../core/model';
import { DeckStore } from '../../core/store';
import type { RichCommand } from './rich-format';
import { TextEditing } from './text-editing';

const BLOCKS: readonly { value: string; label: string; command: RichCommand }[] = [
  { value: 'paragraph', label: 'Paragraph', command: 'paragraph' },
  { value: 'h1', label: 'Heading 1', command: 'h1' },
  { value: 'h2', label: 'Heading 2', command: 'h2' },
  { value: 'h3', label: 'Heading 3', command: 'h3' },
];

/** Address as typed → a web address: a bare "example.com" gets https://. */
function normalizeHref(value: string): string {
  const href = value.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}`;
}

/**
 * Format controls for a text element, shown in the properties panel (arc42 §5.4). They act on the
 * in-place editor through `TextEditing`; while it is not running they offer to start it. The
 * buttons keep the editor focused for pointer users, and the group is marked so that tabbing into
 * it does not end the edit.
 */
@Component({
  selector: 'app-text-format',
  template: `
    <fieldset [disabled]="element().locked === true">
      <legend>Rich text</legend>
      @if (active()) {
        <div class="controls" role="group" aria-label="Text format" data-keeps-text-editing (mousedown)="keepFocus($event)">
          <div class="row" role="group" aria-label="Character style">
            <button type="button" [attr.aria-pressed]="format()?.bold" (click)="run('bold')"><b>Bold</b></button>
            <button type="button" [attr.aria-pressed]="format()?.italic" (click)="run('italic')"><i>Italic</i></button>
            <button type="button" [attr.aria-pressed]="format()?.underline" (click)="run('underline')"><u>Underline</u></button>
            <button type="button" [attr.aria-pressed]="format()?.code" (click)="run('code')"><code>Code</code></button>
          </div>
          <div class="field">
            <label for="rt-block">Block style</label>
            <select id="rt-block" [value]="format()?.block ?? 'paragraph'" (change)="setBlock($event)">
              @for (b of blocks; track b.value) {
                <option [value]="b.value" [selected]="b.value === (format()?.block ?? 'paragraph')">{{ b.label }}</option>
              }
            </select>
          </div>
          <div class="row" role="group" aria-label="Lists">
            <button type="button" [attr.aria-pressed]="format()?.list === 'bullet'" (click)="run('bullet')">Bulleted</button>
            <button type="button" [attr.aria-pressed]="format()?.list === 'ordered'" (click)="run('ordered')">Numbered</button>
            <button type="button" (click)="run('indent')">Indent</button>
            <button type="button" (click)="run('outdent')">Outdent</button>
          </div>
          <div class="field">
            <label for="rt-color">Text colour</label>
            <select id="rt-color" (change)="setColor($event)">
              <option value="" [selected]="!format()?.color">Element colour</option>
              @for (name of colors(); track name) {
                <option [value]="name" [selected]="name === format()?.color">{{ name }}</option>
              }
            </select>
          </div>
          <div class="field">
            <label for="rt-size">Text size</label>
            <select id="rt-size" (change)="setSize($event)">
              <option value="" [selected]="!format()?.size">Element size</option>
              @for (name of sizes(); track name) {
                <option [value]="name" [selected]="name === format()?.size">{{ name }}</option>
              }
            </select>
          </div>
          <div class="field">
            <label for="rt-link">Link address</label>
            <input id="rt-link" type="text" inputmode="url" autocomplete="off" [value]="format()?.link ?? ''" [attr.aria-invalid]="linkError() ? 'true' : null" [attr.aria-describedby]="linkError() ? 'rt-link-error' : null" (keydown.enter)="applyLink($event, link.value)" #link />
            @if (linkError(); as message) {
              <span class="error" id="rt-link-error" role="alert">{{ message }}</span>
            }
            <div class="row">
              <button type="button" (click)="applyLink($event, link.value)">Set link</button>
              <button type="button" (click)="removeLink(link)">Remove link</button>
            </div>
          </div>
          <button type="button" (click)="editing.focusEditor()">Back to text</button>
        </div>
        <p class="note">Ctrl+B, Ctrl+I, Ctrl+U and Ctrl+K work in the text. Escape finishes editing.</p>
      } @else {
        <p class="note">The text is formatted while you edit it on the slide.</p>
        <button type="button" (click)="edit()">Edit text</button>
      }
    </fieldset>
  `,
  styles: `
    :host {
      display: block;
    }
    fieldset {
      display: grid;
      gap: 0.5rem;
      margin: 0.75rem 0;
      padding: 0.5rem 0.75rem 0.75rem;
      border: 1px solid #c3c6cc;
      border-radius: 0.25rem;
    }
    legend {
      font-weight: 600;
      padding: 0 0.25rem;
    }
    .controls,
    .field {
      display: grid;
      gap: 0.5rem;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
    }
    label {
      font-size: 0.875rem;
    }
    .note {
      margin: 0;
      color: #4b4b4b;
      font-size: 0.9rem;
    }
    .error {
      color: #8a1c14;
      font-size: 0.85rem;
    }
    button {
      font: inherit;
      font-size: 0.85rem;
      padding: 0.25rem 0.6rem;
      border: 1px solid #5a5a5a;
      border-radius: 0.25rem;
      background: #fff;
      color: #111;
      cursor: pointer;
    }
    button[aria-pressed='true'] {
      background: #1f4fc4;
      border-color: #1f4fc4;
      color: #fff;
    }
    button:focus-visible,
    select:focus-visible,
    input:focus-visible {
      outline: 3px solid #ffbf47;
      outline-offset: 2px;
    }
    fieldset:disabled {
      opacity: 0.7;
    }
  `,
})
export class TextFormat {
  readonly element = input.required<TextEl>();

  protected readonly editing = inject(TextEditing);
  private readonly store = inject(DeckStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly blocks = BLOCKS;
  protected readonly active = computed(() => this.editing.editingId() === this.element().id);
  protected readonly format = this.editing.format;
  protected readonly colors = computed(() => Object.keys(this.store.deck().theme.colors));
  protected readonly sizes = computed(() => Object.keys(this.store.deck().theme.typeScale));
  protected readonly linkError = signal('');

  constructor() {
    let handled = this.editing.linkRequest();
    effect(() => {
      const request = this.editing.linkRequest();
      if (request === handled) return;
      handled = request;
      untracked(() => queueMicrotask(() => this.host.querySelector<HTMLElement>('#rt-link')?.focus()));
    });
  }

  protected edit(): void {
    this.editing.start(this.element().id);
  }

  protected run(command: RichCommand): void {
    this.editing.run(command);
  }

  /** Pointer presses on a button must not move focus out of the text, or the edit would end. */
  protected keepFocus(event: MouseEvent): void {
    if ((event.target as HTMLElement).closest('button')) event.preventDefault();
  }

  protected setBlock(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const block = BLOCKS.find((b) => b.value === value);
    if (block) this.editing.run(block.command);
    this.editing.focusEditor();
  }

  protected setColor(event: Event): void {
    this.editing.setColor((event.target as HTMLSelectElement).value || null);
    this.editing.focusEditor();
  }

  protected setSize(event: Event): void {
    this.editing.setSize((event.target as HTMLSelectElement).value || null);
    this.editing.focusEditor();
  }

  protected applyLink(event: Event, value: string): void {
    event.preventDefault();
    if (value.trim() === '') return this.removeLinkNow();
    if (this.editing.setLink(normalizeHref(value))) {
      this.linkError.set('');
      this.editing.focusEditor();
    } else {
      this.linkError.set('Enter a web address (http or https) or a mailto address');
    }
  }

  protected removeLink(input: HTMLInputElement): void {
    input.value = '';
    this.removeLinkNow();
  }

  private removeLinkNow(): void {
    this.editing.setLink(null);
    this.linkError.set('');
    this.editing.focusEditor();
  }
}
