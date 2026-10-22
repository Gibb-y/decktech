import { Component, DestroyRef, computed, inject, output, signal } from '@angular/core';
import { PLACEHOLDER_KINDS, generateId, type Fill, type Layout, type Placeholder, type PlaceholderKind } from '../core/model';
import {
  AddLayout,
  AddPlaceholder,
  CommandError,
  DeckStore,
  DeleteLayout,
  DuplicateLayout,
  RemovePlaceholder,
  RenameLayout,
  SetLayoutBackground,
  SetPlaceholderBox,
  SetPlaceholderKind,
  type Command,
  type PlaceholderBox,
} from '../core/store';
import { fillStyle, themeVars } from '../renderer';
import { FocusTrap, LiveAnnouncer } from '../shared';
import { FillControl } from './properties/fill-control';

/** Width of the preview in CSS pixels; the stage is scaled to it. */
const PREVIEW_WIDTH = 640;
const MIN_SIZE = 20;

type Drag = { kind: 'move' | 'resize'; id: string; startX: number; startY: number; box: PlaceholderBox; key: string; release: () => void };

let gestureCounter = 0;

/**
 * The layout editor (arc42 §8.7): add, rename, duplicate and delete layouts, set a layout's
 * background, and add, move, resize, retype and remove its placeholders on a preview of the stage
 * (stage units). Every change is one command, so one undo step, and slides on the layout re-flow
 * their placeholder content at once. A placeholder can be moved with the pointer, with the arrow
 * keys (Shift for 10 units; Ctrl resizes) or with the number fields. Deleting a layout that slides
 * use asks which layout they move to.
 */
@Component({
  selector: 'app-layout-editor',
  imports: [FocusTrap, FillControl],
  template: `
    <div class="backdrop" aria-hidden="true" (click)="closed.emit()"></div>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="layout-editor-title" appFocusTrap (keydown.escape)="onEscape($event)">
      <h2 id="layout-editor-title">Layouts</h2>

      <div class="bar">
        <label>
          Layout
          <select class="input" data-autofocus (change)="select($event)">
            @for (l of layouts(); track l.id) {
              <option [value]="l.id" [selected]="l.id === layout()?.id">{{ l.name }}</option>
            }
          </select>
        </label>
        <button class="btn" type="button" (click)="addLayout()">Add layout</button>
        <button class="btn" type="button" (click)="duplicate()">Duplicate</button>
        <button class="btn" type="button" (click)="startDelete()">Delete…</button>
      </div>

      @if (layout(); as current) {
        <div class="field">
          <label for="layout-name">Name</label>
          <input class="input" id="layout-name" type="text" [value]="current.name" (change)="rename($event)" />
        </div>
        <p class="note">{{ usage() }}</p>

        @if (deleting()) {
          <div class="question" role="alertdialog" aria-labelledby="layout-delete-title" aria-modal="true">
            <p id="layout-delete-title">
              @if (users() > 0) {
                {{ users() }} {{ users() === 1 ? 'slide uses' : 'slides use' }} “{{ current.name }}”. Move {{ users() === 1 ? 'it' : 'them' }} to:
              } @else {
                Delete the layout “{{ current.name }}”?
              }
            </p>
            @if (users() > 0) {
              <select class="input" aria-label="Replacement layout" data-keep [value]="replacement()" (change)="replacement.set(valueOf($event))">
                @for (l of others(); track l.id) {
                  <option [value]="l.id" [selected]="l.id === replacement()">{{ l.name }}</option>
                }
              </select>
            }
            <button class="btn" type="button" (click)="confirmDelete()">{{ users() > 0 ? 'Move slides and delete' : 'Delete' }}</button>
            <button class="btn" type="button" (click)="deleting.set(false)">Cancel</button>
          </div>
        }

        <app-fill-control label="Background" noneLabel="None (theme background)" [optional]="true" [value]="current.background" [theme]="theme()" (changed)="setBackground($event)" />

        <h3>Placeholders</h3>
        <p id="layout-keys" class="note">
          Drag a placeholder to move it, or drag its corner to resize. With a placeholder focused: arrow keys move it by 1 unit (Shift: 10), Ctrl with arrow keys resizes it, Delete removes it.
        </p>
        <div class="preview" [style.width.px]="previewWidth" [style.height.px]="previewHeight()">
          <div class="stage" [style]="stageStyle()" [style.width.px]="stage().width" [style.height.px]="stage().height" [style.transform]="'scale(' + scale() + ')'">
            @for (p of current.placeholders; track p.id) {
              <button
                type="button"
                class="ph"
                [class.selected]="p.id === selectedId()"
                [attr.aria-pressed]="p.id === selectedId()"
                aria-describedby="layout-keys"
                [attr.aria-label]="label(p)"
                [style.left.px]="p.x"
                [style.top.px]="p.y"
                [style.width.px]="p.w"
                [style.height.px]="p.h"
                (click)="selectedId.set(p.id)"
                (keydown)="onKey($event, p)"
                (pointerdown)="down($event, p, 'move')"
                (pointermove)="moved($event)"
                (pointerup)="up($event)"
                (pointercancel)="up($event)"
              >
                <span aria-hidden="true">{{ p.kind }}</span>
              </button>
              @if (p.id === selectedId()) {
                <div
                  class="handle"
                  aria-hidden="true"
                  [style.left.px]="p.x + p.w"
                  [style.top.px]="p.y + p.h"
                  (pointerdown)="down($event, p, 'resize')"
                  (pointermove)="moved($event)"
                  (pointerup)="up($event)"
                  (pointercancel)="up($event)"
                ></div>
              }
            }
          </div>
        </div>

        <div class="bar">
          <label>
            Placeholder
            <select class="input" (change)="selectedId.set(valueOf($event))">
              <option value="" [selected]="selected() === undefined">None selected</option>
              @for (p of current.placeholders; track p.id) {
                <option [value]="p.id" [selected]="p.id === selectedId()">{{ label(p) }}</option>
              }
            </select>
          </label>
          <label>
            New placeholder
            <select class="input" #newKind>
              @for (k of kinds; track k) {
                <option [value]="k">{{ k }}</option>
              }
            </select>
          </label>
          <button class="btn" type="button" (click)="addPlaceholder(newKind.value)">Add placeholder</button>
        </div>

        @if (selected(); as p) {
          <fieldset>
            <legend>Selected placeholder</legend>
            <div class="grid">
              <label>
                Kind
                <select class="input" (change)="setKind(p, $event)">
                  @for (k of kinds; track k) {
                    <option [value]="k" [selected]="k === p.kind">{{ k }}</option>
                  }
                </select>
              </label>
              @for (f of fields; track f.key) {
                <label>
                  {{ f.label }}
                  <input class="input" type="number" [value]="p[f.key]" [min]="f.key === 'w' || f.key === 'h' ? 1 : 0" (change)="setField(p, f.key, $event)" />
                </label>
              }
              <button class="btn" type="button" (click)="remove(p)">Remove placeholder</button>
            </div>
          </fieldset>
        }
      }

      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      <div class="actions">
        <button class="btn" type="button" (click)="closed.emit()">Close</button>
      </div>
    </div>
  `,
  styleUrl: './dialog.css',
  styles: `
    .dialog {
      width: min(46rem, calc(100vw - 2rem));
    }
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 0.5rem;
      margin: 0.5rem 0;
    }
    label {
      display: grid;
      gap: 0.2rem;
      font-size: 0.875rem;
    }
    .field {
      display: grid;
      gap: 0.2rem;
      margin: 0.5rem 0;
    }
    select,
    h3 {
      margin: 1rem 0 0.25rem;
      font-size: 1rem;
    }
    .note {
      margin: 0.25rem 0;
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    .question {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin: 0.5rem 0;
      padding: 0.5rem 0.75rem;
      background: var(--warning-subtle);
      border-left: 4px solid var(--warning-ink);
    }
    .question p {
      flex: 1 1 100%;
      margin: 0;
    }
    .preview {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--border-control);
      margin: 0.5rem 0;
    }
    .stage {
      position: absolute;
      left: 0;
      top: 0;
      transform-origin: 0 0;
      background-color: var(--deck-color-background, var(--surface-raised));
    }
    .ph {
      position: absolute;
      box-sizing: border-box;
      padding: 0;
      border: 6px dashed var(--accent);
      border-radius: 0;
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      color: var(--accent-ink);
      font-size: 48px;
      font-weight: 700;
      touch-action: none;
      cursor: move;
    }
    .ph.selected {
      border-style: solid;
      background: color-mix(in srgb, var(--accent) 25%, transparent);
    }
    .ph:focus-visible {
      outline: 8px solid var(--focus);
      outline-offset: 4px;
    }
    .handle {
      position: absolute;
      width: 48px;
      height: 48px;
      margin: -24px 0 0 -24px;
      background: var(--accent);
      border: 6px solid var(--surface-raised);
      touch-action: none;
      cursor: nwse-resize;
    }
    fieldset {
      margin: 0.5rem 0;
      border: 1px solid var(--border);
    }
    .grid {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 0.5rem;
    }
    .grid input {
      width: 6rem;
    }
    .error {
      margin: 0.5rem 0 0;
      color: var(--danger-ink);
    }
  `,
})
export class LayoutEditor {
  private readonly store = inject(DeckStore);
  private readonly announcer = inject(LiveAnnouncer);

  protected readonly kinds: readonly PlaceholderKind[] = PLACEHOLDER_KINDS;
  protected readonly fields = [
    { key: 'x', label: 'X' },
    { key: 'y', label: 'Y' },
    { key: 'w', label: 'Width' },
    { key: 'h', label: 'Height' },
  ] as const;
  protected readonly previewWidth = PREVIEW_WIDTH;

  protected readonly layouts = computed(() => this.store.deck().layouts);
  protected readonly stage = computed(() => this.store.deck().stage);
  protected readonly theme = computed(() => this.store.deck().theme);
  protected readonly scale = computed(() => PREVIEW_WIDTH / this.stage().width);
  protected readonly previewHeight = computed(() => this.stage().height * this.scale());

  /** The layout being edited; the first one if the chosen one has gone (undone, deleted). */
  private readonly layoutId = signal<string>(this.store.currentSlide().layoutId);
  protected readonly layout = computed<Layout | undefined>(() => this.layouts().find((l) => l.id === this.layoutId()) ?? this.layouts()[0]);
  protected readonly selectedId = signal<string>('');
  protected readonly selected = computed<Placeholder | undefined>(() => this.layout()?.placeholders.find((p) => p.id === this.selectedId()));
  protected readonly users = computed(() => this.store.slides().filter((s) => s.layoutId === this.layout()?.id).length);
  protected readonly others = computed(() => this.layouts().filter((l) => l.id !== this.layout()?.id));
  protected readonly usage = computed(() => {
    const n = this.users();
    return n === 0 ? 'No slide uses this layout.' : `${n} ${n === 1 ? 'slide uses' : 'slides use'} this layout; ${n === 1 ? 'its' : 'their'} placeholder content follows your changes.`;
  });
  protected readonly stageStyle = computed(() => ({
    ...themeVars(this.theme()),
    ...fillStyle(this.layout()?.background, this.theme(), () => null),
  }));

  protected readonly deleting = signal(false);
  protected readonly replacement = signal('');
  protected readonly error = signal<string | null>(null);

  private drag: Drag | null = null;

  constructor() {
    // Closing mid-drag (Escape) must not leave the store's gesture open.
    inject(DestroyRef).onDestroy(() => this.drag?.release());
  }

  readonly closed = output<void>();

  protected valueOf(event: Event): string {
    return (event.target as HTMLSelectElement | HTMLInputElement).value;
  }

  protected label(p: Placeholder): string {
    const same = this.layout()?.placeholders.filter((q) => q.kind === p.kind) ?? [];
    return `${p.kind} ${same.indexOf(p) + 1}: ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.w)} × ${Math.round(p.h)}`;
  }

  protected onEscape(event: Event): void {
    event.preventDefault();
    if (this.deleting()) this.deleting.set(false);
    else this.closed.emit();
  }

  // ------------------------------------------------------------------ layouts

  protected select(event: Event): void {
    this.layoutId.set(this.valueOf(event));
    this.selectedId.set('');
    this.deleting.set(false);
  }

  protected addLayout(): void {
    const id = generateId('layout');
    if (!this.run(new AddLayout({ id, name: 'New layout', placeholders: [] }), 'Layout added')) return;
    this.layoutId.set(id);
    this.selectedId.set('');
  }

  protected duplicate(): void {
    const current = this.layout();
    if (!current) return;
    const id = generateId('layout');
    if (!this.run(new DuplicateLayout(current.id, id), 'Layout duplicated')) return;
    this.layoutId.set(id);
    this.selectedId.set('');
  }

  protected rename(event: Event): void {
    const current = this.layout();
    const input = event.target as HTMLInputElement;
    if (!current) return;
    if (!this.run(new RenameLayout(current.id, input.value), 'Layout renamed')) input.value = current.name;
  }

  protected startDelete(): void {
    if (this.layouts().length <= 1) return void this.fail('A deck needs at least one layout');
    this.error.set(null);
    this.replacement.set(this.others()[0]?.id ?? '');
    this.deleting.set(true);
    queueMicrotask(() => document.querySelector<HTMLElement>('app-layout-editor [role="alertdialog"] [data-keep], app-layout-editor [role="alertdialog"] button')?.focus());
  }

  protected confirmDelete(): void {
    const current = this.layout();
    if (!current) return;
    const replacement = this.users() > 0 ? this.replacement() : undefined;
    if (!this.run(new DeleteLayout(current.id, replacement), `Layout “${current.name}” deleted`)) return;
    this.deleting.set(false);
    this.layoutId.set(this.layouts()[0].id);
    this.selectedId.set('');
  }

  protected setBackground(fill: Fill | undefined): void {
    const current = this.layout();
    if (current) this.run(new SetLayoutBackground(current.id, fill), fill ? 'Layout background set' : 'Layout background removed');
  }

  // ------------------------------------------------------------- placeholders

  protected addPlaceholder(kind: string): void {
    const current = this.layout();
    if (!current) return;
    const { width, height } = this.stage();
    const w = Math.min(600, width);
    const h = Math.min(kind === 'title' || kind === 'footer' ? 140 : 300, height);
    const placeholder: Placeholder = {
      id: generateId('placeholder'),
      kind: kind as PlaceholderKind,
      x: Math.round((width - w) / 2),
      y: Math.round((height - h) / 2),
      w,
      h,
    };
    if (this.run(new AddPlaceholder(current.id, placeholder), `${kind} placeholder added`)) this.selectedId.set(placeholder.id);
  }

  protected setKind(p: Placeholder, event: Event): void {
    const current = this.layout();
    if (current) this.run(new SetPlaceholderKind(current.id, p.id, this.valueOf(event) as PlaceholderKind), 'Placeholder changed');
  }

  protected setField(p: Placeholder, key: keyof PlaceholderBox, event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = Number(input.value);
    if (input.value.trim() === '' || !this.box(p, { [key]: value })) input.value = String(p[key]);
  }

  protected remove(p: Placeholder): void {
    const current = this.layout();
    if (current && this.run(new RemovePlaceholder(current.id, p.id), 'Placeholder removed')) this.selectedId.set('');
  }

  /** Sets part of a placeholder's box; rejected (and announced) if it would leave the stage. Returns whether it worked. */
  private box(p: Placeholder, change: Partial<PlaceholderBox>, key?: string): boolean {
    const current = this.layout();
    if (!current) return false;
    const box = { x: p.x, y: p.y, w: p.w, h: p.h, ...change };
    return this.run(new SetPlaceholderBox(current.id, p.id, box, key ? { coalesceKey: key } : {}));
  }

  /** The placeholder as the deck has it now: a key can repeat faster than the view redraws. */
  private fresh(p: Placeholder): Placeholder {
    return this.layout()?.placeholders.find((q) => q.id === p.id) ?? p;
  }

  protected onKey(event: KeyboardEvent, shown: Placeholder): void {
    const p = this.fresh(shown);
    const step = event.shiftKey ? 10 : 1;
    const { width, height } = this.stage();
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      return this.remove(p);
    }
    const d = delta[event.key];
    if (!d || event.altKey || event.metaKey) return;
    event.preventDefault();
    const key = `ph-key:${p.id}`;
    if (event.ctrlKey) {
      this.box(p, { w: Math.max(MIN_SIZE, Math.min(width - p.x, p.w + d[0])), h: Math.max(MIN_SIZE, Math.min(height - p.y, p.h + d[1])) }, key);
    } else {
      this.box(p, { x: clamp(p.x + d[0], 0, width - p.w), y: clamp(p.y + d[1], 0, height - p.h) }, key);
    }
  }

  // ------------------------------------------------------------------ pointer

  protected down(event: PointerEvent, p: Placeholder, kind: 'move' | 'resize'): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.selectedId.set(p.id);
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    const key = `ph-drag:${++gestureCounter}`;
    this.drag = { kind, id: p.id, startX: event.clientX, startY: event.clientY, box: { x: p.x, y: p.y, w: p.w, h: p.h }, key, release: this.store.beginGesture(key) };
  }

  protected moved(event: PointerEvent): void {
    const drag = this.drag;
    const current = this.layout();
    const p = current?.placeholders.find((q) => q.id === drag?.id);
    if (!drag || !p) return;
    const dx = (event.clientX - drag.startX) / this.scale();
    const dy = (event.clientY - drag.startY) / this.scale();
    const { width, height } = this.stage();
    const b = drag.box;
    const next: PlaceholderBox =
      drag.kind === 'move'
        ? { ...b, x: Math.round(clamp(b.x + dx, 0, width - b.w)), y: Math.round(clamp(b.y + dy, 0, height - b.h)) }
        : { ...b, w: Math.round(clamp(b.w + dx, MIN_SIZE, width - b.x)), h: Math.round(clamp(b.h + dy, MIN_SIZE, height - b.y)) };
    this.box(p, next, drag.key);
  }

  protected up(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    drag?.release();
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
  }

  // ------------------------------------------------------------------ helpers

  private fail(message: string): void {
    this.error.set(message);
    this.announcer.announce(message);
  }

  /** Runs a command; a refusal is shown in the dialog and announced. */
  private run(command: Command, done?: string): boolean {
    try {
      this.store.execute(command);
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      this.fail(e.message);
      return false;
    }
    this.error.set(null);
    if (done) this.announcer.announce(done);
    return true;
  }
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
