import { Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, signal } from '@angular/core';
import type { Slide, Stage, Theme } from '../../core/model';
import { SlideRenderer } from '../../renderer';

/** How far outside the scroll area a thumbnail is already drawn, so scrolling rarely shows an empty box. */
const MARGIN = '240px 0px';

/**
 * A slide thumbnail that is drawn only while it is (nearly) on screen. The box keeps the stage's
 * aspect ratio either way, so the list does not jump when thumbnails appear, and a 200-slide deck
 * only ever holds a screenful of rendered slides (quality scenario Q11). Without
 * `IntersectionObserver` every thumbnail is drawn.
 */
@Component({
  selector: 'app-slide-thumb',
  imports: [SlideRenderer],
  template: `
    @if (visible()) {
      <app-slide-renderer [slide]="slide()" [theme]="theme()" [stage]="stage()" mode="thumbnail" />
    }
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
      overflow: hidden;
      background: #e8eaee;
    }
  `,
  host: {
    '[style.aspect-ratio]': 'ratio()',
  },
})
export class SlideThumb {
  readonly slide = input.required<Slide>();
  readonly theme = input.required<Theme>();
  readonly stage = input.required<Stage>();
  /** The scrolling container the thumbnail sits in; the margin is measured from it, not from the window. */
  readonly scroller = input<Element | null>(null);

  protected readonly visible = signal(typeof IntersectionObserver === 'undefined');
  protected readonly ratio = computed(() => `${this.stage().width} / ${this.stage().height}`);

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (typeof IntersectionObserver === 'undefined') return;
      const observer = new IntersectionObserver(
        (entries) => {
          const last = entries[entries.length - 1];
          if (last) this.visible.set(last.isIntersecting);
        },
        { root: this.scroller(), rootMargin: MARGIN },
      );
      observer.observe(host);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }
}
