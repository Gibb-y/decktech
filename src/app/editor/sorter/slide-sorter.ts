import { Component, DestroyRef, ElementRef, Injector, afterNextRender, inject, signal, viewChild } from '@angular/core';
import type { Slide } from '../../core/model';
import { DeckStore } from '../../core/store';
import { SlideActions } from '../slide-actions';
import { ShortcutRegistry, type ShortcutDef } from '../shortcut-registry';
import { SlideThumb } from './slide-thumb';

/** The text of a slide's first text element, for the accessible name of its button. */
function titleOf(slide: Slide): string {
  for (const e of slide.elements) {
    if (e.type === 'text' && e.text.trim()) {
      const line = e.text.trim().split('\n')[0].replace(/^[-*]\s+/, '');
      return line.length > 40 ? `${line.slice(0, 40)}…` : line;
    }
  }
  return '';
}

/**
 * The slide list (arc42 §5.4): lazily drawn thumbnails, add / duplicate / delete, sections, and
 * reordering by drag and drop or Alt+Up / Alt+Down. Only the current slide is in the tab order; the
 * arrow keys move between slides (selecting as they go), so a 200-slide deck is one tab stop.
 */
@Component({
  selector: 'app-slide-sorter',
  imports: [SlideThumb],
  templateUrl: './slide-sorter.html',
  styleUrl: './slide-sorter.css',
})
export class SlideSorter {
  protected readonly store = inject(DeckStore);
  protected readonly slideActions = inject(SlideActions);
  private readonly registry = inject(ShortcutRegistry);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly sectionButton = viewChild<ElementRef<HTMLButtonElement>>('sectionButton');

  protected readonly editingSection = signal(false);
  protected readonly dragId = signal<string | null>(null);
  /** Where a drop would land: before the slide at this index (`slides.length` = at the end). */
  protected readonly dropAt = signal<number | null>(null);

  constructor() {
    const slides = this.slideActions;
    const store = this.store;
    const go = (index: number) => {
      const target = store.slides()[Math.min(store.slides().length - 1, Math.max(0, index))];
      store.selectSlide(target.id);
      this.focusCurrent();
    };
    const after = (action: () => void) => () => {
      action();
      this.focusCurrent();
    };
    const def = (id: string, key: string, keys: string, description: string, run: () => void, mods: Pick<ShortcutDef, 'ctrl' | 'alt'> = {}): ShortcutDef => ({
      id: `sorter.${id}`,
      scope: 'sorter',
      key,
      shift: false,
      keys,
      description,
      run,
      ...mods,
    });
    const unregister = [
      def('previous', 'ArrowUp', 'Arrow up', 'Select the previous slide', () => go(store.currentSlideIndex() - 1)),
      def('next', 'ArrowDown', 'Arrow down', 'Select the next slide', () => go(store.currentSlideIndex() + 1)),
      def('first', 'Home', 'Home', 'Select the first slide', () => go(0)),
      def('last', 'End', 'End', 'Select the last slide', () => go(store.slides().length - 1)),
      def('move-earlier', 'ArrowUp', 'Alt+Arrow up', 'Move the slide earlier', after(() => slides.moveSlideBy(-1)), { alt: true }),
      def('move-later', 'ArrowDown', 'Alt+Arrow down', 'Move the slide later', after(() => slides.moveSlideBy(1)), { alt: true }),
      def('add', 'Enter', 'Enter', 'Add a slide after this one', after(() => slides.addSlide())),
      def('duplicate', 'd', 'Ctrl+D', 'Duplicate the slide', after(() => slides.duplicateSlide()), { ctrl: true }),
      def('delete', 'Delete', 'Delete', 'Delete the slide', after(() => slides.deleteSlide())),
    ].map((d) => this.registry.register(d));
    inject(DestroyRef).onDestroy(() => unregister.forEach((u) => u()));
  }

  // -------------------------------------------------------------- keyboard

  protected onKeydown(event: KeyboardEvent): void {
    // Only keys pressed on a slide button; the section form and the tool buttons keep their own keys.
    if (!(event.target as HTMLElement).closest('[data-slide-id]')) return;
    this.registry.handle(event, 'sorter');
  }

  /** Puts keyboard focus on the current slide's button once the list has been redrawn. */
  private focusCurrent(): void {
    afterNextRender(
      () => this.host.querySelector<HTMLElement>(`[data-slide-id="${CSS.escape(this.store.currentSlideId())}"]`)?.focus(),
      { injector: this.injector },
    );
  }

  /** The buttons' way to reorder: a single-pointer alternative to dragging. */
  protected move(delta: number): void {
    this.slideActions.moveSlideBy(delta); // the button keeps the focus: it is not part of the redrawn list
  }

  protected select(slide: Slide): void {
    this.store.selectSlide(slide.id);
  }

  protected label(slide: Slide, index: number): string {
    const title = titleOf(slide);
    const section = slide.section ? `, starts section “${slide.section}”` : '';
    return `Slide ${index + 1}${section}${title ? `: ${title}` : ''}`;
  }

  // -------------------------------------------------------------- sections

  protected openSection(): void {
    this.editingSection.set(true);
  }

  protected saveSection(event: Event, input: HTMLInputElement): void {
    event.preventDefault();
    this.slideActions.setSection(this.store.currentSlideId(), input.value);
    this.closeSection();
  }

  protected closeSection(): void {
    this.editingSection.set(false);
    afterNextRender(() => this.sectionButton()?.nativeElement.focus(), { injector: this.injector });
  }

  // ---------------------------------------------------------- drag and drop

  protected onDragStart(event: DragEvent, slide: Slide): void {
    this.dragId.set(slide.id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', slide.id);
    }
  }

  protected onDragOver(event: DragEvent, index: number): void {
    if (this.dragId() === null) return;
    event.preventDefault(); // allows the drop
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.dropAt.set(event.clientY < rect.top + rect.height / 2 ? index : index + 1);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    const id = this.dragId();
    const at = this.dropAt();
    this.endDrag();
    if (id !== null && at !== null) this.slideActions.moveSlideBefore(id, at);
  }

  protected endDrag(): void {
    this.dragId.set(null);
    this.dropAt.set(null);
  }
}
