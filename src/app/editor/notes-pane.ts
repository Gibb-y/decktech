import { Component, inject } from '@angular/core';
import { CommandError, DeckStore, SetNotes } from '../core/store';
import { LiveAnnouncer } from '../shared';

/**
 * Speaker notes of the current slide. Typing dispatches `SetNotes`, which coalesces per slide, so a
 * burst of typing is one undo step; the text shown always comes from the deck, so undo updates it.
 */
@Component({
  selector: 'app-notes-pane',
  template: `
    <section aria-label="Speaker notes">
      <label for="speaker-notes">Speaker notes for slide {{ store.currentSlideIndex() + 1 }}</label>
      <textarea class="input" id="speaker-notes" rows="4" [value]="store.currentSlide().notes" (input)="onInput($event)"></textarea>
    </section>
  `,
  styles: `
    section {
      display: grid;
      gap: 0.25rem;
      padding: 0.5rem 1rem;
      color: var(--text);
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    }
    label {
      font-size: 0.875rem;
      font-weight: 600;
    }
  `,
})
export class NotesPane {
  protected readonly store = inject(DeckStore);
  private readonly announcer = inject(LiveAnnouncer);

  protected onInput(event: Event): void {
    const field = event.target as HTMLTextAreaElement;
    try {
      this.store.execute(new SetNotes(this.store.currentSlideId(), field.value));
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      this.announcer.announce(e.message);
    }
  }
}
