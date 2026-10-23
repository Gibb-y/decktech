import { Component, computed, inject, signal } from '@angular/core';
import { ErrorService } from './core/errors';
import type { Deck, Slide } from './core/model';
import { DeckRepository } from './core/persistence';
import { HostConsole } from './components/host/host-services';
import { CODE_TRUST, SlideRenderer } from './renderer';

/** What `show` was given: a deck as JSON, the bytes of its assets (base64) and the slide to draw. */
export interface PreviewRequest {
  deck: Deck;
  slideId: string;
  /** Asset id to base64 bytes. */
  assets?: Record<string, string>;
  /** CSS pixel width of the drawn stage (the renderer scales the 1920x1080 stage to it). */
  width?: number;
}

export interface PreviewReport {
  /** Errors of the app and of code components while the slide was drawn. */
  errors: { source: string; componentId?: string; message: string }[];
  /** What the components logged. */
  console: { componentId: string; level: string; text: string }[];
  /** One entry per code element on the slide, in z-order. */
  frames: { elementId: string; running: boolean; notice?: string }[];
}

export interface PreviewHook {
  /** Draws the slide and returns once every code element has a frame (or says why not). */
  show(request: PreviewRequest): Promise<void>;
  /** What happened since `show`; call it after letting the components run for a moment. */
  report(): PreviewReport;
}

declare global {
  interface Window {
    decktechPreview?: PreviewHook;
  }
}

const FRAME_WAIT_MS = 8000;
const POLL_MS = 50;

const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * The route `preview`: draws one slide of a deck handed over by a script (`window.decktechPreview.show`),
 * with the same `SlideRenderer` as the editor and the presenter. Used by the MCP server (ADR-013) to
 * screenshot slides and to run a component in its sandbox; nothing is stored in a deck, and no trust
 * record exists for the deck id, so its code runs as that of a deck made here (arc42 §6.4) — the caller
 * decides to do that, in a throwaway browser profile.
 */
@Component({
  selector: 'app-preview-page',
  imports: [SlideRenderer],
  template: `
    @if (request(); as current) {
      <div class="frame" [style.width.px]="width()">
        <app-slide-renderer
          mode="present"
          [slide]="slide()"
          [theme]="current.deck.theme"
          [layout]="layout()"
          [stage]="current.deck.stage"
          [components]="current.deck.components"
          [deckId]="current.deck.id"
        />
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .frame {
      position: relative;
    }
  `,
})
export class PreviewPage {
  private readonly repository = inject(DeckRepository);
  private readonly errors = inject(ErrorService);
  private readonly hostConsole = inject(HostConsole);
  private readonly trust = inject(CODE_TRUST, { optional: true });

  protected readonly request = signal<PreviewRequest | null>(null);
  protected readonly width = computed(() =>
    Math.min(Math.max(this.request()?.width ?? 1280, 160), 3840),
  );
  protected readonly slide = computed<Slide>(() => {
    const current = this.request()!;
    return current.deck.slides.find((s) => s.id === current.slideId) ?? current.deck.slides[0];
  });
  protected readonly layout = computed(() =>
    this.request()!.deck.layouts.find((l) => l.id === this.slide().layoutId),
  );

  constructor() {
    window.decktechPreview = { show: (request) => this.show(request), report: () => this.report() };
  }

  private async show(request: PreviewRequest): Promise<void> {
    this.errors.clear();
    this.hostConsole.clear();
    for (const [id, base64] of Object.entries(request.assets ?? {})) {
      const put = await this.repository.putAsset(
        new Blob([fromBase64(base64) as BlobPart], { type: request.deck.assets[id]?.mime ?? '' }),
      );
      if (!put.ok) this.errors.report('host', `An asset could not be stored: ${put.error.message}`);
    }
    await this.trust?.refresh(request.deck.id);
    this.request.set(request);
    await this.settled();
  }

  private report(): PreviewReport {
    return {
      errors: this.errors.entries().map(({ source, componentId, message }) => ({
        source,
        ...(componentId === undefined ? {} : { componentId }),
        message,
      })),
      console: this.hostConsole
        .entries()
        .map(({ componentId, level, text }) => ({ componentId, level, text })),
      frames: this.frames(),
    };
  }

  /** Every code element has a frame (or says why not), the web fonts are loaded and the pictures decoded. */
  private async settled(): Promise<void> {
    const wanted = this.slide().elements.filter(
      (e) => e.type === 'code' && e.hidden !== true,
    ).length;
    const deadline = Date.now() + FRAME_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const hosts = Array.from(document.querySelectorAll('app-code-element'));
      const ready =
        hosts.length >= wanted &&
        hosts.every(
          (host) => host.querySelector('iframe') || host.querySelector('.placeholder, .notice'),
        );
      if (ready) break;
    }
    await document.fonts?.ready;
    await Promise.all(
      Array.from(document.images).map((image) => image.decode?.().catch(() => undefined)),
    );
  }

  private frames(): PreviewReport['frames'] {
    const codeIds = this.slide()
      .elements.filter((e) => e.type === 'code' && e.hidden !== true)
      .map((e) => e.id);
    const hosts = Array.from(document.querySelectorAll('app-code-element'));
    return codeIds.map((elementId, i) => {
      const host = hosts[i];
      const notice = host
        ?.querySelector('.notice, .placeholder')
        ?.textContent?.trim()
        .replace(/\s+/g, ' ');
      const running = host?.querySelector('iframe') != null && !host.querySelector('.notice');
      return { elementId, running, ...(notice ? { notice } : {}) };
    });
  }
}
