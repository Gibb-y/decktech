import { Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AutosaveService } from '../core/persistence';
import { DeckStore } from '../core/store';
import { Canvas } from './canvas';

type ShellState = { status: 'loading' } | { status: 'ready' } | { status: 'unavailable'; message: string };

/**
 * The editor page (arc42 §5.4): opens the deck named by the route through `AutosaveService` and
 * lays out slide sorter | canvas | properties | notes. The sorter is a plain slide list and the
 * properties and notes panels are placeholders until their own issues; the canvas is complete.
 */
@Component({
  selector: 'app-editor-shell',
  imports: [RouterLink, Canvas],
  template: `
    <header class="top">
      <a routerLink="/">← Your decks</a>
      <h1 tabindex="-1">{{ heading() }}</h1>
    </header>
    @switch (state().status) {
      @case ('ready') {
        <div class="layout">
          <nav class="sorter" aria-label="Slides">
            <ol>
              @for (slide of store.slides(); track slide.id; let i = $index) {
                <li>
                  <button type="button" [attr.aria-current]="slide.id === store.currentSlideId() ? 'true' : null" (click)="store.selectSlide(slide.id)">
                    Slide {{ i + 1 }}
                  </button>
                </li>
              }
            </ol>
          </nav>
          <app-canvas class="canvas" />
          <aside class="properties" aria-label="Properties">
            <p class="muted">Properties of the selection will appear here.</p>
          </aside>
          <section class="notes" aria-label="Speaker notes">
            <p class="muted">Speaker notes will appear here.</p>
          </section>
        </div>
      }
      @case ('unavailable') {
        <p class="error" role="alert">{{ unavailableMessage() }}</p>
      }
      @default {
        <p role="status">Opening deck…</p>
      }
    }
  `,
  styles: `
    :host {
      display: block;
      color: #111;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    }
    .top {
      display: flex;
      align-items: baseline;
      gap: 1rem;
      padding: 0.5rem 1rem;
    }
    h1 {
      margin: 0;
      font-size: 1.25rem;
    }
    h1:focus {
      outline: none;
    }
    .layout {
      display: grid;
      grid-template-columns: 9rem minmax(0, 1fr) 16rem;
      grid-template-rows: minmax(0, 1fr) auto;
      grid-template-areas:
        'sorter canvas properties'
        'sorter notes properties';
      gap: 0;
      border-top: 1px solid #c3c6cc;
    }
    .sorter {
      grid-area: sorter;
      padding: 0.5rem;
      border-right: 1px solid #c3c6cc;
    }
    .sorter ol {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.35rem;
    }
    .sorter button {
      width: 100%;
      font: inherit;
      padding: 0.4rem;
      border: 1px solid #5a5a5a;
      border-radius: 0.25rem;
      background: #fff;
      color: #111;
      cursor: pointer;
    }
    .sorter button[aria-current='true'] {
      background: #1f4fc4;
      border-color: #1f4fc4;
      color: #fff;
    }
    .sorter button:focus-visible {
      outline: 3px solid #ffbf47;
      outline-offset: 2px;
    }
    .canvas {
      grid-area: canvas;
      min-width: 0;
    }
    .properties {
      grid-area: properties;
      padding: 0.5rem 1rem;
      border-left: 1px solid #c3c6cc;
    }
    .notes {
      grid-area: notes;
      padding: 0.5rem 1rem;
      border-top: 1px solid #c3c6cc;
    }
    .muted {
      margin: 0;
      color: #4b4b4b;
      font-size: 0.9rem;
    }
    .error {
      margin: 1rem;
      padding: 0.75rem 1rem;
      background: #fde8e6;
      color: #5c0f0a;
      border-left: 4px solid #8a1c14;
    }
  `,
})
export class EditorShell {
  /** Route parameter `:id`. */
  readonly id = input.required<string>();

  protected readonly store = inject(DeckStore);
  private readonly autosave = inject(AutosaveService);
  protected readonly state = signal<ShellState>({ status: 'loading' });
  private opening = 0;

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.open(id));
    });
    // Leaving the editor must not leave the last edits waiting for the debounce timer.
    inject(DestroyRef).onDestroy(() => void this.autosave.flush());
  }

  /** The deck title once it is open; before that the store may still hold another deck's. */
  protected heading(): string {
    return this.state().status === 'ready' ? this.store.deck().title : 'Editor';
  }

  protected unavailableMessage(): string {
    const state = this.state();
    return state.status === 'unavailable' ? state.message : '';
  }

  private async open(id: string): Promise<void> {
    const attempt = ++this.opening;
    this.state.set({ status: 'loading' });
    let result: Awaited<ReturnType<AutosaveService['open']>>;
    try {
      result = await this.autosave.open(id);
    } catch (e) {
      if (attempt === this.opening) this.state.set({ status: 'unavailable', message: `This deck could not be opened: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    if (attempt !== this.opening) return; // the route changed while loading
    if (!result.ok) return this.state.set({ status: 'unavailable', message: `This deck could not be opened: ${result.error.message}` });
    if (result.value.readOnly) return this.state.set({ status: 'unavailable', message: result.value.reason });
    this.state.set({ status: 'ready' });
  }
}
