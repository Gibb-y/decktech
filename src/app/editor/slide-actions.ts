import { Service, inject } from '@angular/core';
import { createSlide, generateId } from '../core/model';
import { AddSlide, CommandError, DeckStore, DeleteSlide, DuplicateSlide, ReorderSlides, SetSlideSection } from '../core/store';
import { LiveAnnouncer } from '../shared';

/**
 * Everything the slide sorter does to the deck. Like `EditorActions`, each method is one command
 * (one undo step) and announces its outcome; the sorter's buttons, keys and drag and drop all call these.
 */
@Service()
export class SlideActions {
  private readonly store = inject(DeckStore);
  private readonly announcer = inject(LiveAnnouncer);

  /** Adds an empty slide with the current slide's layout right after it and makes it current. */
  addSlide(): void {
    const current = this.store.currentSlide();
    const index = this.store.currentSlideIndex() + 1;
    const slide = createSlide(current.layoutId);
    this.store.execute(new AddSlide(slide, index));
    this.store.selectSlide(slide.id);
    this.announcer.announce(`Slide ${index + 1} added`);
  }

  duplicateSlide(slideId: string = this.store.currentSlideId()): void {
    const copyId = generateId('slide');
    if (!this.run(() => this.store.execute(new DuplicateSlide(slideId, copyId)))) return;
    this.store.selectSlide(copyId);
    this.announcer.announce(`Slide duplicated, now slide ${this.position(copyId)} of ${this.store.slides().length}`);
  }

  deleteSlide(slideId: string = this.store.currentSlideId()): void {
    if (this.store.slides().length === 1) return void this.announcer.announce('A deck needs at least one slide');
    const index = this.store.slides().findIndex((s) => s.id === slideId);
    if (!this.run(() => this.store.execute(new DeleteSlide(slideId)))) return;
    this.announcer.announce(`Slide ${index + 1} deleted`);
  }

  /**
   * Moves a slide so that it sits before the slide that is at `insertBefore` in the current order
   * (`slides.length` = to the end). That is the position a drop indicator shows, so a drag does not
   * have to know that the moved slide first leaves the list.
   */
  moveSlideBefore(slideId: string, insertBefore: number): void {
    const from = this.store.slides().findIndex((s) => s.id === slideId);
    if (from < 0) return;
    const to = insertBefore > from ? insertBefore - 1 : insertBefore;
    this.moveTo(slideId, to);
  }

  /** Moves a slide one place (or more) earlier (`-1`) or later (`1`), stopping at either end. */
  moveSlideBy(delta: number, slideId: string = this.store.currentSlideId()): void {
    const slides = this.store.slides();
    const from = slides.findIndex((s) => s.id === slideId);
    if (from < 0) return;
    const to = Math.min(slides.length - 1, Math.max(0, from + delta));
    if (to === from) return void this.announcer.announce(delta < 0 ? 'Already the first slide' : 'Already the last slide');
    this.moveTo(slideId, to);
  }

  /** Starts (or, with a blank name, ends) a section at a slide. */
  setSection(slideId: string, name: string | undefined): void {
    if (!this.run(() => this.store.execute(new SetSlideSection(slideId, name)))) return;
    const label = name?.trim();
    this.announcer.announce(label ? `Section “${label}” starts at slide ${this.position(slideId)}` : `Section removed from slide ${this.position(slideId)}`);
  }

  private moveTo(slideId: string, to: number): void {
    const before = this.store.slides();
    if (!this.run(() => this.store.execute(new ReorderSlides([slideId], to)))) return;
    if (this.store.slides() === before) return; // dropped where it already was
    this.announcer.announce(`Slide moved to position ${to + 1} of ${before.length}`);
  }

  private position(slideId: string): number {
    return this.store.slides().findIndex((s) => s.id === slideId) + 1;
  }

  /** Runs a store change; a rejected command is announced instead of escaping into an event handler. */
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
