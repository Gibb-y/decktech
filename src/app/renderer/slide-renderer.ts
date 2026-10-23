import { NgComponentOutlet } from '@angular/common';
import { Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, signal, type Type } from '@angular/core';
import { STAGE_HEIGHT, STAGE_WIDTH, type ComponentDef, type Element, type ElementType, type Fill, type Layout, type Slide, type Stage, type Theme } from '../core/model';
import { AssetUrls } from './asset-urls';
import { CODE_ELEMENT_VIEW } from './code-view';
import { FontFaces } from './font-faces';
import { ImageElement } from './image-element';
import { LineElement } from './line-element';
import { ShapeElement } from './shape-element';
import { TableElement } from './table-element';
import { TextElement } from './text-element';
import { fillStyle, themeVars } from './theme';
import { VideoElement } from './video-element';
import { ALL_STEPS, isElementShown, type RenderMode } from './visibility';

const DEFAULT_STAGE: Stage = { width: STAGE_WIDTH, height: STAGE_HEIGHT };
const DEFAULT_BACKGROUND: Fill = { kind: 'solid', color: { token: 'background' } };

interface Item {
  id: string;
  type: ElementType;
  /** Hidden element shown in the editor only; dimmed and kept out of the accessibility tree. */
  ghost: boolean;
  /** Being edited in place: kept in the layout but not painted, because the editor draws it. */
  concealed: boolean;
  /** Inputs of the code element view (code elements only). */
  inputs?: Record<string, unknown>;
}

/**
 * The one renderer behind the editor canvas, thumbnails, presenter output and export (arc42 §4.1).
 * Draws the slide on a fixed logical stage and scales that stage to the width of the host element
 * with a CSS transform (ADR-009), so the host decides the size; it keeps the stage's aspect ratio.
 */
@Component({
  selector: 'app-slide-renderer',
  template: `
    <div
      class="stage"
      [style]="stageStyle()"
      [attr.role]="mode() === 'thumbnail' ? null : 'group'"
      [attr.aria-label]="mode() === 'thumbnail' ? null : 'Slide'"
      [attr.aria-hidden]="mode() === 'thumbnail' ? 'true' : null"
      [attr.inert]="mode() === 'thumbnail' ? '' : null"
    >
      @for (item of items(); track item.id) {
        @switch (item.type) {
          @case ('text') {
            <app-text-element [elements]="elementMap()" [elementId]="item.id" [theme]="theme()" [class.ghost]="item.ghost" [style.visibility]="item.concealed ? 'hidden' : null" [attr.aria-hidden]="item.ghost ? 'true' : null" />
          }
          @case ('image') {
            <app-image-element [elements]="elementMap()" [elementId]="item.id" [theme]="theme()" [class.ghost]="item.ghost" [attr.aria-hidden]="item.ghost ? 'true' : null" />
          }
          @case ('shape') {
            <app-shape-element [elements]="elementMap()" [elementId]="item.id" [theme]="theme()" [class.ghost]="item.ghost" [attr.aria-hidden]="item.ghost ? 'true' : null" />
          }
          @case ('code') {
            @if (codeView(); as view) {
              <ng-container [ngComponentOutlet]="view" [ngComponentOutletInputs]="item.inputs ?? {}" />
            }
          }
          @case ('line') {
            <app-line-element [elements]="elementMap()" [elementId]="item.id" [theme]="theme()" [class.ghost]="item.ghost" [attr.aria-hidden]="item.ghost ? 'true' : null" />
          }
          @case ('table') {
            <app-table-element [elements]="elementMap()" [elementId]="item.id" [theme]="theme()" [class.ghost]="item.ghost" [attr.aria-hidden]="item.ghost ? 'true' : null" />
          }
          @case ('video') {
            <app-video-element [elements]="elementMap()" [elementId]="item.id" [theme]="theme()" [mode]="videoMode()" [class.ghost]="item.ghost" [attr.aria-hidden]="item.ghost ? 'true' : null" />
          }
        }
      }
    </div>
  `,
  styles: `
    :host {
      position: relative;
      display: block;
      width: 100%;
      overflow: hidden;
    }
    .stage {
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: 0 0;
      overflow: hidden;
      color: var(--deck-color-text, #111111);
    }
    .ghost {
      opacity: 0.35;
    }
  `,
  imports: [TextElement, ImageElement, ShapeElement, LineElement, TableElement, VideoElement, NgComponentOutlet],
  host: {
    '[style.aspect-ratio]': 'stage().width + " / " + stage().height',
  },
})
export class SlideRenderer {
  readonly slide = input.required<Slide>();
  readonly theme = input.required<Theme>();
  /** The slide's layout; its background shows where the slide has none of its own. */
  readonly layout = input<Layout | undefined>(undefined);
  readonly mode = input<RenderMode>('present');
  /** Highest step reached; elements with a larger `step` are omitted. Defaults to all revealed. */
  readonly step = input<number>(ALL_STEPS);
  readonly stage = input<Stage>(DEFAULT_STAGE);
  /** Id of a text element the editor is drawing in its place (edit mode only). */
  readonly concealedId = input<string | null>(null);
  /** The deck's component definitions; code elements look their source up here. */
  readonly components = input<readonly ComponentDef[]>([]);
  /** Id of the deck, which scopes the persisted state of code components. */
  readonly deckId = input<string>('');
  /** How many slides this one is from the slide shown; code frames farther than one away are destroyed. */
  readonly distance = input<number>(0);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly assets = inject(AssetUrls);
  private readonly fonts = inject(FontFaces);
  private readonly containerWidth = signal(0);
  private readonly loadCodeView = inject(CODE_ELEMENT_VIEW, { optional: true });
  private codeViewRequested = false;
  protected readonly codeView = signal<Type<unknown> | null>(null);

  /** `containerWidth / stageWidth`, the factor of the stage's `transform: scale(k)`. */
  readonly scale = computed(() => {
    const k = this.containerWidth() / this.stage().width;
    return Number.isFinite(k) && k > 0 ? k : 0;
  });

  protected readonly elementMap = computed<ReadonlyMap<string, Element>>(
    () => new Map(this.slide().elements.map((element) => [element.id, element])),
  );

  /** Videos play only on the slide that is shown; a preloaded neighbour (distance > 0) is drawn like a thumbnail. */
  protected readonly videoMode = computed<RenderMode>(() => (this.mode() === 'present' && this.distance() > 0 ? 'thumbnail' : this.mode()));

  protected readonly items = computed<Item[]>(() => {
    const mode = this.mode();
    const step = this.step();
    return this.slide().elements.flatMap((element) => {
      if (!isElementShown(element, mode, step)) return [];
      const item: Item = { id: element.id, type: element.type, ghost: element.hidden === true, concealed: element.id === this.concealedId() };
      if (element.type === 'code') {
        item.inputs = { elements: this.elementMap(), elementId: element.id, theme: this.theme(), mode, components: this.components(), deckId: this.deckId(), ghost: item.ghost, distance: this.distance() };
      }
      return [item];
    });
  });

  protected readonly stageStyle = computed(() => {
    const { width, height } = this.stage();
    const background = this.slide().background ?? this.layout()?.background ?? DEFAULT_BACKGROUND;
    return {
      ...themeVars(this.theme()),
      ...fillStyle(background, this.theme(), (id) => this.assets.url(id)),
      width: `${width}px`,
      height: `${height}px`,
      transform: `scale(${this.scale()})`,
    };
  });

  constructor() {
    effect(() => this.fonts.register(this.theme().fontFaces));
    effect(() => {
      if (this.codeViewRequested || !this.loadCodeView || !this.items().some((item) => item.type === 'code')) return;
      this.codeViewRequested = true;
      this.loadCodeView().then(
        (view) => this.codeView.set(view),
        () => (this.codeViewRequested = false),
      );
    });
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const element = this.host.nativeElement;
      this.containerWidth.set(element.clientWidth);
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) this.containerWidth.set(entry.contentRect.width);
      });
      observer.observe(element);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }
}
