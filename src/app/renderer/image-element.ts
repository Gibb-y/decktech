import { Component, computed, inject } from '@angular/core';
import type { ImageEl } from '../core/model';
import { AssetUrls } from './asset-urls';
import { ElementView } from './element-view';

const OBJECT_FIT = { cover: 'cover', contain: 'contain', stretch: 'fill' } as const;

/**
 * Images come from the local asset store as object URLs, which `NgOptimizedImage` cannot
 * optimise (no loader, no srcset), so this is a plain `img` with explicit stage-unit sizing.
 */
@Component({
  selector: 'app-image-element',
  template: `
    @if (element(); as el) {
      @if (url(); as src) {
        <img [src]="src" [alt]="el.alt" [style.object-fit]="fit()" />
      } @else {
        <div class="missing" [attr.role]="el.alt ? 'img' : null" [attr.aria-label]="el.alt || null" [attr.aria-hidden]="el.alt ? null : 'true'"></div>
      }
    }
  `,
  styles: `
    :host {
      position: absolute;
      display: block;
      box-sizing: border-box;
    }
    img,
    .missing {
      display: block;
      width: 100%;
      height: 100%;
    }
    .missing {
      background: color-mix(in srgb, currentColor 12%, transparent);
    }
  `,
})
export class ImageElement extends ElementView<ImageEl> {
  protected readonly type = 'image';
  private readonly assets = inject(AssetUrls);

  protected readonly url = computed(() => {
    const el = this.element();
    return el ? this.assets.url(el.assetId) : null;
  });
  protected readonly fit = computed(() => OBJECT_FIT[this.element()?.fit ?? 'contain'] ?? 'contain');
}
