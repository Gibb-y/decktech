import { Component, computed } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { TextEl, Theme } from '../core/model';
import { ElementView } from './element-view';
import { RICH_TEXT_CSS, richToView } from './rich-view';
import { parseText } from './text-blocks';
import { resolveColor, resolveFont } from './theme';

const ALIGNS: readonly string[] = ['left', 'center', 'right'];

/** Font, size, alignment and colour of a text element's box; the editor in `editor/text` uses it too, so editing looks like presenting. */
export function textStyle(el: TextEl, theme: Theme): Record<string, string> {
  const style: Record<string, string> = {
    'font-family': resolveFont(el.font, theme),
    'font-size': `${Number.isFinite(el.fontSize) ? Math.max(0, el.fontSize) : 0}px`,
    'text-align': ALIGNS.includes(el.align) ? el.align : 'left',
  };
  const color = resolveColor(el.color, theme);
  if (color) style['color'] = color;
  return style;
}

/**
 * Read-only render of a text element. Formatted content (`rich`, ProseMirror JSON) is drawn from a
 * fixed set of semantic templates without loading the editor; plain `text` is split into
 * paragraphs and bullet lists. Editing is `editor/text` (arc42 §8.4).
 */
@Component({
  selector: 'app-text-element',
  imports: [NgTemplateOutlet],
  template: `
    <ng-template #nodes let-list>
      @for (n of list; track $index) {
        <ng-container [ngTemplateOutlet]="node" [ngTemplateOutletContext]="{ $implicit: n }" />
      }
    </ng-template>
    <ng-template #node let-n>
      @switch (n.tag) {
        @case ('text') {
          <ng-container>{{ n.text }}</ng-container>
        }
        @case ('br') {
          <br />
        }
        @case ('p') {
          <p><ng-container [ngTemplateOutlet]="nodes" [ngTemplateOutletContext]="{ $implicit: n.children }" /></p>
        }
        @case ('h1') {
          <h1><ng-container [ngTemplateOutlet]="nodes" [ngTemplateOutletContext]="{ $implicit: n.children }" /></h1>
        }
        @case ('h2') {
          <h2><ng-container [ngTemplateOutlet]="nodes" [ngTemplateOutletContext]="{ $implicit: n.children }" /></h2>
        }
        @case ('h3') {
          <h3><ng-container [ngTemplateOutlet]="nodes" [ngTemplateOutletContext]="{ $implicit: n.children }" /></h3>
        }
        @case ('ul') {
          <ul><ng-container [ngTemplateOutlet]="nodes" [ngTemplateOutletContext]="{ $implicit: n.children }" /></ul>
        }
        @case ('ol') {
          <ol><ng-container [ngTemplateOutlet]="nodes" [ngTemplateOutletContext]="{ $implicit: n.children }" /></ol>
        }
        @case ('li') {
          <li><ng-container [ngTemplateOutlet]="nodes" [ngTemplateOutletContext]="{ $implicit: n.children }" /></li>
        }
        @case ('strong') {
          <strong><ng-container [ngTemplateOutlet]="nodes" [ngTemplateOutletContext]="{ $implicit: n.children }" /></strong>
        }
        @case ('em') {
          <em><ng-container [ngTemplateOutlet]="nodes" [ngTemplateOutletContext]="{ $implicit: n.children }" /></em>
        }
        @case ('u') {
          <u><ng-container [ngTemplateOutlet]="nodes" [ngTemplateOutletContext]="{ $implicit: n.children }" /></u>
        }
        @case ('code') {
          <code><ng-container [ngTemplateOutlet]="nodes" [ngTemplateOutletContext]="{ $implicit: n.children }" /></code>
        }
        @case ('span') {
          <span [style]="n.style"><ng-container [ngTemplateOutlet]="nodes" [ngTemplateOutletContext]="{ $implicit: n.children }" /></span>
        }
        @case ('a') {
          <a [href]="n.href" rel="noopener noreferrer" target="_blank"><ng-container [ngTemplateOutlet]="nodes" [ngTemplateOutletContext]="{ $implicit: n.children }" /></a>
        }
      }
    </ng-template>
    @if (element(); as el) {
      @if (rich(); as view) {
        <div class="text rich" [style]="style()">
          <ng-container [ngTemplateOutlet]="nodes" [ngTemplateOutletContext]="{ $implicit: view }" />
        </div>
      } @else {
        <div class="text" [style]="style()">
          @if (isHeading()) {
            <h2>{{ headingText() }}</h2>
          } @else {
            @for (block of blocks(); track $index) {
              @if (block.kind === 'list') {
                <ul>
                  @for (item of block.items; track $index) {
                    <li>{{ item }}</li>
                  }
                </ul>
              } @else {
                <p>{{ block.text }}</p>
              }
            }
          }
        </div>
      }
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
    h2 {
      white-space: pre-line;
    }
    ul {
      padding-inline-start: 1.2em;
    }
    ${RICH_TEXT_CSS}
  `,
})
export class TextElement extends ElementView<TextEl> {
  protected readonly type = 'text';

  protected readonly blocks = computed(() => parseText(this.element()?.text ?? ''));
  /** The formatted content, or `null` for plain text. */
  protected readonly rich = computed(() => {
    const doc = this.element()?.rich;
    return doc ? richToView(doc, this.theme()) : null;
  });
  /** The theme's `heading` font marks title text, which is output as one heading, however many lines. */
  protected readonly isHeading = computed(() => this.element()?.font === 'heading');
  protected readonly headingText = computed(() =>
    this.blocks()
      .flatMap((block) => (block.kind === 'list' ? block.items : [block.text]))
      .join('\n'),
  );
  protected readonly style = computed(() => {
    const el = this.element();
    return el ? textStyle(el, this.theme()) : {};
  });
}
