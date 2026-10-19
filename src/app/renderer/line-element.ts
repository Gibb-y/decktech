import { Component, computed } from '@angular/core';
import type { LineEl } from '../core/model';
import { ElementView } from './element-view';
import { resolveColor } from './theme';

/** A straight line from the top left to the bottom right corner of its box (`h = 0`: horizontal). */
@Component({
  selector: 'app-line-element',
  template: `
    @if (element(); as el) {
      <svg aria-hidden="true" focusable="false">
        <line x1="0" y1="0" [attr.x2]="frame().w" [attr.y2]="frame().h" [style.stroke]="stroke()" [attr.stroke-width]="width()" />
      </svg>
    }
  `,
  styles: `
    :host {
      position: absolute;
      display: block;
      box-sizing: border-box;
    }
    svg {
      display: block;
      overflow: visible;
      width: 100%;
      height: 100%;
    }
  `,
})
export class LineElement extends ElementView<LineEl> {
  protected readonly type = 'line';

  protected readonly stroke = computed(() => {
    const el = this.element();
    return (el && resolveColor(el.stroke, this.theme())) ?? 'currentColor';
  });
  protected readonly width = computed(() => {
    const width = this.element()?.strokeWidth ?? 0;
    return Number.isFinite(width) ? width : 0;
  });
}
