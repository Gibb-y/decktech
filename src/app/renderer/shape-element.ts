import { Component, computed, inject } from '@angular/core';
import type { ShapeEl } from '../core/model';
import { AssetUrls } from './asset-urls';
import { ElementView } from './element-view';
import { fillStyle, resolveColor } from './theme';

const TRIANGLE = 'polygon(50% 0, 100% 100%, 0 100%)';

/**
 * Rectangle, ellipse and triangle drawn as a styled box. The triangle is clipped, so it has no
 * stroke; ellipse and rectangle draw the stroke as an inside border.
 */
@Component({
  selector: 'app-shape-element',
  template: `
    @if (element()) {
      <div class="shape" [style]="style()"></div>
    }
  `,
  styles: `
    :host {
      position: absolute;
      display: block;
      box-sizing: border-box;
    }
    .shape {
      width: 100%;
      height: 100%;
      box-sizing: border-box;
    }
  `,
})
export class ShapeElement extends ElementView<ShapeEl> {
  protected readonly type = 'shape';
  private readonly assets = inject(AssetUrls);

  protected readonly style = computed(() => {
    const el = this.element();
    if (!el) return {};
    const theme = this.theme();
    const style = fillStyle(el.fill, theme, (id) => this.assets.url(id));
    const stroke = resolveColor(el.stroke, theme);
    if (stroke && el.shape !== 'triangle' && Number.isFinite(el.strokeWidth) && el.strokeWidth > 0) {
      style['border'] = `${el.strokeWidth}px solid ${stroke}`;
    }
    if (el.shape === 'ellipse') style['border-radius'] = '50%';
    if (el.shape === 'triangle') style['clip-path'] = TRIANGLE;
    return style;
  });
}
