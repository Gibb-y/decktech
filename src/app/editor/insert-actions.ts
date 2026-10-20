import { Service, inject, signal } from '@angular/core';
import { createElement, generateId, type ComponentDef, type Element, type TextEl } from '../core/model';
import { DeckRepository } from '../core/persistence';
import { AddAsset, AddCodeElement, AddElement, Batch, CommandError, DeckStore, type Command } from '../core/store';
import { LiveAnnouncer } from '../shared';

export type InsertKind = 'title' | 'bullets' | 'text' | 'image' | 'rectangle' | 'ellipse' | 'triangle' | 'line' | 'code';

export interface InsertItem {
  kind: InsertKind;
  label: string;
  description: string;
}

/** What the insert menu offers, in order. The menu, the toolbar and the quick-insert filter all read this table. */
export const INSERT_ITEMS: readonly InsertItem[] = [
  { kind: 'title', label: 'Title', description: 'A large heading at the top of the slide' },
  { kind: 'bullets', label: 'Bullet list', description: 'A text box with a bulleted list' },
  { kind: 'text', label: 'Text', description: 'A plain text box' },
  { kind: 'image', label: 'Image', description: 'Pick a picture from your computer' },
  { kind: 'rectangle', label: 'Rectangle', description: 'A filled rectangle' },
  { kind: 'ellipse', label: 'Ellipse', description: 'A filled ellipse' },
  { kind: 'triangle', label: 'Triangle', description: 'A filled triangle' },
  { kind: 'line', label: 'Line', description: 'A horizontal line' },
  { kind: 'code', label: 'Code component', description: 'HTML, CSS and JavaScript running in a sandbox' },
];

/** The field the properties panel should focus after an insertion, so the author can type straight away. */
export interface FocusRequest {
  field: string;
  /** Increases with every request, so asking twice for the same field still counts. */
  seq: number;
}

/** Largest box a freshly inserted picture is fitted into, in stage units. */
const IMAGE_BOX = { w: 1200, h: 675 };
const DEFAULT_IMAGE_SIZE = { w: 960, h: 540 };

const starterComponent = (): ComponentDef => ({
  id: generateId('component'),
  name: 'Code component',
  html: '<p id="message">Hello from a code component</p>',
  css: '#message { font: 64px var(--deck-font-body); color: var(--deck-color-text); }',
  js: '',
  propSchema: [],
  permissions: [],
  files: [],
  libs: [],
});

/**
 * Inserts new elements into the current slide. Every insertion is one command (one undo step),
 * selects the new element and announces it; pictures are stored first and registered in the deck
 * in the same step as the element, so a failure never leaves a half-added image in the deck (the
 * stored blob of a failed insertion stays until asset garbage collection exists, see 11.2).
 */
@Service()
export class InsertActions {
  private readonly store = inject(DeckStore);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly repository = inject(DeckRepository, { optional: true });

  private requests = 0;
  readonly focusRequest = signal<FocusRequest | null>(null);

  /** Inserts the element for `kind` (anything but `image`, which needs a file: see `pickImage`). */
  insert(kind: Exclude<InsertKind, 'image'>): void {
    const { command, element } = this.build(kind, this.store.currentSlideId());
    if (!this.run(() => this.store.execute(command))) return;
    this.afterInsert(element, kind);
  }

  private build(kind: Exclude<InsertKind, 'image'>, slideId: string): { command: Command; element: Element } {
    const typeScale = this.store.deck().theme.typeScale;
    const text = (box: Partial<TextEl>): TextEl => createElement('text', { fontSize: typeScale['body'] ?? 40, ...box });
    const add = (element: Element) => ({ command: new AddElement(slideId, element), element });
    switch (kind) {
      case 'title':
        return add(text({ x: 120, y: 80, w: 1680, h: 140, text: 'Title', font: 'heading', fontSize: typeScale['heading'] ?? 64 }));
      case 'bullets':
        return add(text({ x: 120, y: 260, w: 1680, h: 640, text: '- First point\n- Second point' }));
      case 'text':
        return add(text({ x: 160, y: 400, w: 960, h: 160, text: 'Text' }));
      case 'rectangle':
      case 'ellipse':
      case 'triangle':
        return add(createElement('shape', { shape: kind === 'rectangle' ? 'rect' : kind, x: 720, y: 390, w: 480, h: 300 }));
      case 'line':
        return add(createElement('line', { x: 560, y: 540, w: 800, h: 0 }));
      case 'code': {
        const command = new AddCodeElement(slideId, starterComponent(), { x: 360, y: 190, w: 1200, h: 700 });
        return { command, element: command.element };
      }
    }
  }

  /** Opens the browser's file picker; the chosen picture is inserted with `insertImage`. */
  pickImage(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const [file] = Array.from(input.files ?? []);
      if (file) void this.insertImage(file);
    });
    input.click();
  }

  /** Stores the picture, then adds it to the deck and the slide in one undo step. Resolves to whether it worked. */
  async insertImage(file: Blob): Promise<boolean> {
    if (!this.repository) {
      this.announcer.announce('Pictures cannot be stored in this session');
      return false;
    }
    const slideId = this.store.currentSlideId(); // the slide the author was on when they asked
    const stored = await this.repository.putAsset(file);
    if (!stored.ok) {
      this.announcer.announce(`The picture could not be stored: ${stored.error.message}`);
      return false;
    }
    const { ref } = stored.value;
    const size = await fitted(file);
    const element = createElement('image', {
      assetId: ref.hash,
      alt: '',
      w: size.w,
      h: size.h,
      x: Math.round((this.store.deck().stage.width - size.w) / 2),
      y: Math.round((this.store.deck().stage.height - size.h) / 2),
    });
    // The hash identifies the content: an asset already in the deck is reused as it is, even if the browser reported another mime type this time.
    const commands: Command[] = Object.hasOwn(this.store.deck().assets, ref.hash) ? [] : [new AddAsset(ref.hash, ref)];
    if (!this.run(() => this.store.execute(new Batch('Insert image', [...commands, new AddElement(slideId, element)])))) return false;
    if (this.store.currentSlideId() === slideId) this.afterInsert(element, 'image');
    else this.announcer.announce('Image added to the slide you were on');
    return true;
  }

  private afterInsert(element: Element, kind: InsertKind): void {
    this.store.select([element.id]);
    const label = INSERT_ITEMS.find((i) => i.kind === kind)?.label ?? kind;
    this.announcer.announce(`${label} inserted`);
    // Text and pictures need a word from the author straight away; the rest is arranged by moving it.
    if (element.type === 'text') this.requestFocus('text');
    else if (element.type === 'image') this.requestFocus('alt');
  }

  private requestFocus(field: string): void {
    this.focusRequest.set({ field, seq: ++this.requests });
  }

  private run(change: () => void): boolean {
    try {
      change();
      return true;
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      this.announcer.announce(e.message);
      return false;
    }
  }
}

/** The picture's size scaled down to fit `IMAGE_BOX`; a default when the browser cannot read it. */
async function fitted(blob: Blob): Promise<{ w: number; h: number }> {
  try {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    bitmap.close();
    if (width <= 0 || height <= 0) return DEFAULT_IMAGE_SIZE;
    const scale = Math.min(1, IMAGE_BOX.w / width, IMAGE_BOX.h / height);
    return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
  } catch {
    return DEFAULT_IMAGE_SIZE;
  }
}
