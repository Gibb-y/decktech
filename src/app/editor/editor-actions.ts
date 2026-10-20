import { Service, computed, inject, signal } from '@angular/core';
import { alignItems, distributeItems, normalizeAngle, type AlignKind, type DistributeAxis, type Placed, type Rect } from './canvas/geometry';
import { generateId, type Element } from '../core/model';
import {
  AddElement,
  Batch,
  DeleteElements,
  DeckStore,
  MoveElements,
  ReorderElements,
  ResizeElements,
  SetProps,
  type ElementGeometry,
  type ZOrderMove,
} from '../core/store';
import { LiveAnnouncer } from '../shared';
import { describeElement } from './describe';

/** Stage units a pasted or duplicated copy is shifted by, so it does not hide the original. */
export const PASTE_OFFSET = 20;
export const NUDGE = 1;
export const NUDGE_LARGE = 10;
export const ROTATE_STEP = 1;
export const ROTATE_STEP_LARGE = 15;

interface Clipboard {
  deckId: string;
  elements: readonly Element[];
  /** Number of pastes since the last copy; each lands one offset further. */
  pastes: number;
}

/**
 * Everything the canvas does to the deck or the selection, apart from pointer gestures. Each
 * method is one command (one undo step) and announces its outcome; the keyboard shortcuts and
 * the toolbar both call these, so every action is reachable without a pointer.
 *
 * Locked elements can be selected, copied, duplicated and reordered, but never moved, resized,
 * rotated, aligned or deleted from here: locking is the editor's concern, not the commands' (8.4).
 */
@Service()
export class EditorActions {
  private readonly store = inject(DeckStore);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly clipboard = signal<Clipboard | null>(null);

  readonly canPaste = computed(() => {
    const clip = this.clipboard();
    return clip !== null && clip.deckId === this.store.deck().id;
  });

  private get selected(): readonly Element[] {
    return this.store.selectedElements();
  }

  private get editable(): Element[] {
    return this.selected.filter((e) => !e.locked);
  }

  // ------------------------------------------------------------ selection

  selectAll(): void {
    this.store.select(this.store.currentSlide().elements.map((e) => e.id));
    this.announceSelection();
  }

  deselect(): void {
    if (this.store.selection().length === 0) return;
    this.store.clearSelection();
    this.announcer.announce('Selection cleared');
  }

  /**
   * Selects the element after (or, with `-1`, before) the selection in z-order. Returns `false`
   * at either end, where the caller lets Tab leave the canvas instead of trapping the keyboard.
   */
  selectNext(direction: 1 | -1): boolean {
    const elements = this.store.currentSlide().elements;
    if (elements.length === 0) return false;
    const selected = new Set(this.store.selection());
    let target: number;
    if (selected.size === 0) target = direction === 1 ? 0 : elements.length - 1;
    else {
      const indices = elements.flatMap((e, i) => (selected.has(e.id) ? [i] : []));
      target = (direction === 1 ? Math.max(...indices) : Math.min(...indices)) + direction;
    }
    if (target < 0 || target >= elements.length) return false;
    this.store.select([elements[target].id]);
    this.announceSelection();
    return true;
  }

  /** Says what is selected: the element and its place for one, the count for several. */
  announceSelection(): void {
    const selected = this.selected;
    if (selected.length === 0) return this.announcer.announce('Nothing selected');
    if (selected.length > 1) return this.announcer.announce(`${selected.length} elements selected`);
    const elements = this.store.currentSlide().elements;
    const [only] = selected;
    const place = `${elements.indexOf(only) + 1} of ${elements.length}`;
    const flags = [only.locked ? 'locked' : '', only.hidden ? 'hidden' : ''].filter(Boolean).join(', ');
    this.announcer.announce(`${describeElement(only)}, ${place}${flags ? `, ${flags}` : ''}, selected`);
  }

  // ------------------------------------------------------------- geometry

  nudge(dx: number, dy: number): void {
    const targets = this.editable;
    if (targets.length === 0) return this.announceLocked();
    this.store.execute(new MoveElements(targets.map((e) => e.id), dx, dy, { coalesceKey: burstKey('nudge', targets) }));
  }

  /** Changes width / height of every unlocked selected element, keeping its top-left corner. */
  resizeBy(dw: number, dh: number): void {
    const targets = this.editable;
    if (targets.length === 0) return this.announceLocked();
    const changes = targets.map((e) => ({ id: e.id, x: e.x, y: e.y, w: Math.max(1, e.w + dw), h: Math.max(1, e.h + dh) }));
    this.store.execute(new ResizeElements(changes, { coalesceKey: burstKey('resize', targets) }));
  }

  rotateBy(degrees: number): void {
    const targets = this.editable;
    if (targets.length === 0) return this.announceLocked();
    // Each element turns about its own centre; elements with different angles keep their difference.
    this.store.execute(
      new Batch(
        'RotateElements',
        targets.map((e) => new SetProps([e.id], { rotation: normalizeAngle(e.rotation + degrees) })),
        { coalesceKey: burstKey('rotate', targets) },
      ),
    );
  }

  align(kind: AlignKind): void {
    const items = this.placed(this.editable);
    if (items.length === 0) return this.announceLocked();
    const changes = alignItems(items, kind, this.slideRect());
    this.applyGeometry(changes, `Aligned ${kind}`);
  }

  distribute(axis: DistributeAxis): void {
    const items = this.placed(this.editable);
    if (items.length < 3) return void this.announcer.announce('Select at least three elements to distribute');
    this.applyGeometry(distributeItems(items, axis), `Distributed ${axis}ly`);
  }

  // ------------------------------------------------------------ structure

  deleteSelection(): void {
    const targets = this.editable;
    if (targets.length === 0) return this.announceLocked();
    this.store.execute(new DeleteElements(targets.map((e) => e.id)));
    this.announcer.announce(targets.length === 1 ? `${describeElement(targets[0])} deleted` : `${targets.length} elements deleted`);
  }

  duplicateSelection(): void {
    const selected = this.selected;
    if (selected.length === 0) return;
    this.insertCopies(selected, 1, 'duplicated');
  }

  copy(): void {
    const selected = this.selected;
    if (selected.length === 0) return;
    this.clipboard.set({ deckId: this.store.deck().id, elements: structuredClone(selected), pastes: 0 });
    this.announcer.announce(selected.length === 1 ? 'Copied' : `${selected.length} elements copied`);
  }

  paste(): void {
    const clip = this.clipboard();
    if (!clip || clip.deckId !== this.store.deck().id) return void this.announcer.announce('Nothing to paste');
    clip.pastes += 1;
    this.insertCopies(clip.elements, clip.pastes, 'pasted');
  }

  /** Moves the selection in z-order; a move that changes nothing is silent. */
  reorder(move: ZOrderMove): void {
    const ids = this.selected.map((e) => e.id);
    if (ids.length === 0) return;
    const before = this.store.currentSlide();
    this.store.execute(new ReorderElements(before.id, ids, move));
    if (this.store.currentSlide() !== before) this.announceSelection();
  }

  undo(): void {
    if (!this.store.canUndo()) return void this.announcer.announce('Nothing to undo');
    this.store.undo();
    this.announcer.announce('Undone');
  }

  redo(): void {
    if (!this.store.canRedo()) return void this.announcer.announce('Nothing to redo');
    this.store.redo();
    this.announcer.announce('Redone');
  }

  // -------------------------------------------------------------- helpers

  private insertCopies(source: readonly Element[], steps: number, verb: string): void {
    const slide = this.store.currentSlide();
    const offset = PASTE_OFFSET * steps;
    const copies = source.map((e) => ({ ...structuredClone(e), id: generateId('element'), x: e.x + offset, y: e.y + offset }));
    this.store.execute(new Batch(`${verb} elements`, copies.map((e) => new AddElement(slide.id, e))));
    this.store.select(copies.map((e) => e.id));
    this.announcer.announce(copies.length === 1 ? `${describeElement(copies[0])} ${verb}` : `${copies.length} elements ${verb}`);
  }

  private applyGeometry(changes: ElementGeometry[], message: string): void {
    if (changes.length === 0) return void this.announcer.announce('Already aligned');
    this.store.execute(new ResizeElements(changes));
    this.announcer.announce(message);
  }

  private placed(elements: readonly Element[]): Placed[] {
    return elements.map((e) => ({ id: e.id, box: { x: e.x, y: e.y, w: e.w, h: e.h, rotation: e.rotation } }));
  }

  private slideRect(): Rect {
    const { width, height } = this.store.deck().stage;
    return { x: 0, y: 0, w: width, h: height };
  }

  private announceLocked(): void {
    this.announcer.announce(this.selected.length === 0 ? 'Nothing selected' : 'Locked elements cannot be changed');
  }
}

/**
 * One key per kind of change and set of elements: the history merges repeats within its window,
 * so a held arrow key is one undo step and a pause starts a new one.
 */
const burstKey = (name: string, elements: readonly Element[]): string => `${name}:${elements.map((e) => e.id).join(',')}`;
