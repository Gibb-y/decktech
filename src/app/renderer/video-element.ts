import { Component, computed, inject, input } from '@angular/core';
import type { VideoEl } from '../core/model';
import { AssetUrls } from './asset-urls';
import { ElementView } from './element-view';
import type { RenderMode } from './visibility';

/**
 * A video from the local asset store. Only while presenting (and on the slide that is shown) does it
 * load and play: it has controls, and with `autoplay` it starts when the element appears, which
 * is when its slide or its step is reached, since a hidden or not yet revealed element is not
 * rendered at all. Browsers only autoplay silent video, so `autoplay` implies muted. In the editor
 * and in thumbnails the video is not loaded: a paused poster shows, so a deck of videos costs
 * no decoding or bandwidth while it is edited or browsed.
 */
@Component({
  selector: 'app-video-element',
  template: `
    @if (element(); as el) {
      @if (playing()) {
        @if (url(); as src) {
          <video
            [src]="src"
            [attr.poster]="posterUrl()"
            [attr.aria-label]="name()"
            [loop]="el.loop"
            [muted]="muted()"
            [autoplay]="el.autoplay"
            controls
            playsinline
            preload="metadata"
          ></video>
        } @else {
          <div class="missing" role="img" [attr.aria-label]="name()"></div>
        }
      } @else {
        <video [attr.poster]="posterUrl()" [attr.aria-label]="name()" [muted]="true" preload="none" playsinline></video>
      }
    }
  `,
  styles: `
    :host {
      position: absolute;
      display: block;
      box-sizing: border-box;
    }
    video,
    .missing {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: color-mix(in srgb, currentColor 12%, transparent);
    }
  `,
})
export class VideoElement extends ElementView<VideoEl> {
  protected readonly type = 'video';
  /** What the surrounding renderer is drawing for; only `present` plays. */
  readonly mode = input<RenderMode>('present');
  private readonly assets = inject(AssetUrls);

  protected readonly playing = computed(() => this.mode() === 'present');
  protected readonly url = computed(() => {
    const el = this.element();
    return el && this.playing() ? this.assets.url(el.assetId) : null;
  });
  protected readonly posterUrl = computed(() => {
    const poster = this.element()?.poster;
    return poster ? this.assets.url(poster) : null;
  });
  protected readonly muted = computed(() => {
    const el = this.element();
    return el?.muted === true || el?.autoplay === true;
  });
  protected readonly name = computed(() => this.element()?.label?.trim() || 'Video');
}
