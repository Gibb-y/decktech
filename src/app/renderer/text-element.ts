import { Component, computed } from '@angular/core';
import type { TextEl } from '../core/model';
import { ElementView } from './element-view';
import { parseText } from './text-blocks';
import { resolveColor, resolveFont } from './theme';

/** Read-only render of a text element; editing is a separate concern (DT-10). */
@Component({
  selector: 'app-text-element',
  template: `
    @if (element(); as el) {
      <div class="text" [style]="style()">
        @for (block of blocks(); track $index) {
          @if (block.kind === 'list') {
            <ul>
              @for (item of block.items; track $index) {
                <li>{{ item }}</li>
              }
            </ul>
          } @else if (isHeading()) {
            <h2>{{ block.text }}</h2>
          } @else {
            <p>{{ block.text }}</p>
          }
        }
      </div>
    }
  `,
  styles: `
    :host {
      position: absolute;
      display: block;
      box-sizing: border-box;
    }
    .text {
      line-height: 1.2;
    }
    p,
    h2,
    ul {
      margin: 0;
      font: inherit;
    }
    ul {
      padding-inline-start: 1.2em;
    }
  `,
})
export class TextElement extends ElementView<TextEl> {
  protected readonly type = 'text';

  protected readonly blocks = computed(() => parseText(this.element()?.text ?? ''));
  /** The theme's `heading` font marks title text, which is output as a heading. */
  protected readonly isHeading = computed(() => this.element()?.font === 'heading');
  protected readonly style = computed(() => {
    const el = this.element();
    if (!el) return {};
    const theme = this.theme();
    const style: Record<string, string> = {
      'font-family': resolveFont(el.font, theme),
      'font-size': `${Number.isFinite(el.fontSize) ? el.fontSize : 0}px`,
      'text-align': el.align,
    };
    const color = resolveColor(el.color, theme);
    if (color) style['color'] = color;
    return style;
  });
}
