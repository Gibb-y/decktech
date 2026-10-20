import { Component, DestroyRef, ElementRef, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AutosaveService } from '../core/persistence';
import { DeckStore } from '../core/store';
import { Canvas } from './canvas';
import { EditorActions } from './editor-actions';
import { InsertActions, type InsertKind } from './insert-actions';
import { NotesPane } from './notes-pane';
import { PropertiesPanel } from './properties/properties-panel';
import { ShortcutHelp } from './shortcut-help';
import { ShortcutRegistry } from './shortcut-registry';
import { SlideSorter } from './sorter/slide-sorter';
import { EditorToolbar } from './toolbar/editor-toolbar';
import { InsertMenu } from './toolbar/insert-menu';

type ShellState = { status: 'loading' } | { status: 'ready' } | { status: 'unavailable'; message: string };
type Dialog = 'insert' | 'help' | null;

/** Whether keys typed at `target` belong to a text control, so single-key shortcuts must stay out of the way. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * The editor page (arc42 §5.4): opens the deck named by the route through `AutosaveService` and
 * lays out toolbar, slide sorter, canvas, properties panel and notes. It also owns the two modal
 * dialogs (insert menu, shortcut help) and the editor-wide shortcuts that open them.
 */
@Component({
  selector: 'app-editor-shell',
  imports: [RouterLink, Canvas, SlideSorter, PropertiesPanel, NotesPane, EditorToolbar, InsertMenu, ShortcutHelp],
  host: {
    '(document:keydown)': 'onDocumentKeydown($event)',
  },
  template: `
    <header class="top">
      <a routerLink="/">← Your decks</a>
      <h1 tabindex="-1">{{ heading() }}</h1>
      @if (state().status === 'ready') {
        <app-editor-toolbar (insert)="dialog.set('insert')" (help)="dialog.set('help')" />
      }
    </header>
    @switch (state().status) {
      @case ('ready') {
        <div class="layout">
          <app-slide-sorter class="sorter" />
          <app-canvas class="canvas" />
          <app-properties-panel class="properties" />
          <app-notes-pane class="notes" />
        </div>
        @switch (dialog()) {
          @case ('insert') {
            <app-insert-menu (chosen)="onInsert($event)" (closed)="dialog.set(null)" />
          }
          @case ('help') {
            <app-shortcut-help (closed)="dialog.set(null)" />
          }
        }
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
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      min-height: 0;
      color: #111;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    }
    .top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 1rem;
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
      flex: 1 1 auto;
      min-height: 0;
      grid-template-columns: 12rem minmax(0, 1fr) 17rem;
      grid-template-rows: minmax(0, 1fr) auto;
      grid-template-areas:
        'sorter canvas properties'
        'sorter notes properties';
      gap: 0;
      border-top: 1px solid #c3c6cc;
    }
    .sorter {
      grid-area: sorter;
      min-height: 0;
      overflow: hidden;
      border-right: 1px solid #c3c6cc;
    }
    .canvas {
      grid-area: canvas;
      min-width: 0;
      min-height: 0;
    }
    .properties {
      grid-area: properties;
      min-height: 0;
      overflow-y: auto;
      padding: 0.5rem 1rem;
      border-left: 1px solid #c3c6cc;
    }
    .notes {
      grid-area: notes;
      max-height: 30vh;
      overflow-y: auto;
      border-top: 1px solid #c3c6cc;
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
  private readonly registry = inject(ShortcutRegistry);
  private readonly insert = inject(InsertActions);
  private readonly actions = inject(EditorActions);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly state = signal<ShellState>({ status: 'loading' });
  protected readonly dialog = signal<Dialog>(null);
  private opening = 0;

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.open(id));
    });
    // Leaving the editor must not leave the last edits waiting for the debounce timer.
    inject(DestroyRef).onDestroy(() => void this.autosave.flush());

    const ready = () => this.state().status === 'ready';
    const unregister = [
      this.registry.register({
        id: 'global.insert-menu',
        scope: 'global',
        key: '/',
        keys: '/',
        description: 'Insert an element (type to filter, Enter to insert)',
        run: () => (ready() ? this.dialog.set('insert') : false),
      }),
      this.registry.register({
        id: 'global.shortcut-help',
        scope: 'global',
        key: '?',
        keys: '?',
        description: 'Show the keyboard shortcuts',
        run: () => (ready() ? this.dialog.set('help') : false),
      }),
    ];
    inject(DestroyRef).onDestroy(() => unregister.forEach((u) => u()));
  }

  /** The deck title once it is open; before that the store may still hold another deck's. */
  protected heading(): string {
    return this.state().status === 'ready' ? this.store.deck().title : 'Editor';
  }

  protected unavailableMessage(): string {
    const state = this.state();
    return state.status === 'unavailable' ? state.message : '';
  }

  protected onDocumentKeydown(event: KeyboardEvent): void {
    // A key the canvas or sorter already used and a dialog's own keys are not ours.
    if (event.defaultPrevented || this.dialog() !== null) return;
    if (event.key === 'Escape') return this.leaveToCanvas(event);
    // Typing in a field is not ours either.
    if (isTextEntry(event.target) && !event.ctrlKey && !event.metaKey) return;
    this.registry.handle(event, 'global');
  }

  /**
   * Escape from anywhere outside the canvas (a panel field, the sorter, the notes) leaves it: the
   * selection is cleared and the focus returns to the canvas, which is where people expect to be.
   * Edits are already committed per keystroke, so nothing is lost. The canvas handles its own Escape.
   */
  private leaveToCanvas(event: KeyboardEvent): void {
    const viewport = this.host.querySelector<HTMLElement>('app-canvas .viewport');
    if (this.state().status !== 'ready' || !viewport || viewport.contains(event.target as Node)) return;
    event.preventDefault();
    this.actions.deselect();
    viewport.focus();
  }

  protected onInsert(kind: InsertKind): void {
    this.dialog.set(null);
    if (kind === 'image') this.insert.pickImage();
    else this.insert.insert(kind);
  }

  private async open(id: string): Promise<void> {
    const attempt = ++this.opening;
    this.state.set({ status: 'loading' });
    this.dialog.set(null);
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
