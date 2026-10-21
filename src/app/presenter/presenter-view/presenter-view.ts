import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { Deck, Layout } from '../../core/model';
import { SlideRenderer } from '../../renderer';
import { NEXT_KEYS, PREV_KEYS } from '../presentation-view';
import { planSlide, viewAt } from '../step-engine';
import { PresenterSync, type SyncConnection } from './presenter-sync';
import type { OutgoingMessage, StateMessage } from './sync-protocol';

/** How often the displayed time is refreshed while the timer runs. */
const TICK_MS = 250;

/** `m:ss`, or `h:mm:ss` from one hour on. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * The presenter's second screen (arc42 §5.5, §6.3): the slide being shown, the next one, its notes,
 * the step and the talk's clock. The presentation window owns the position and the timer; this view
 * only mirrors the `state` it receives and sends `command` / `timer` messages, so either window can
 * navigate and the two cannot disagree. The previews are the renderer in `thumbnail` mode: static,
 * so no second copy of the code components runs in this window.
 */
@Component({
  selector: 'app-presenter-view',
  imports: [SlideRenderer],
  templateUrl: './presenter-view.html',
  styleUrl: './presenter-view.css',
  host: {
    '(document:keydown)': 'onKeydown($event)',
  },
})
export class PresenterView {
  readonly deck = input.required<Deck>();

  private readonly sync = inject(PresenterSync);
  private connection: SyncConnection | null = null;
  protected readonly state = signal<StateMessage | null>(null);
  private readonly deckId = computed(() => this.deck().id);
  private readonly receivedAt = signal(0);
  private readonly now = signal(0);

  protected readonly slideIndex = computed(() => {
    const state = this.state();
    const count = this.deck().slides.length;
    return state === null || count === 0 ? -1 : Math.min(state.slide, count - 1);
  });
  protected readonly slide = computed(() => this.deck().slides[this.slideIndex()]);
  protected readonly nextSlide = computed(() => this.deck().slides[this.slideIndex() + 1]);
  protected readonly layout = computed(() => this.layoutOf(this.slide()?.layoutId));
  protected readonly nextLayout = computed(() => this.layoutOf(this.nextSlide()?.layoutId));
  /** Elements revealed on the current slide; code steps are not known here and do not change what is drawn statically. */
  protected readonly elementStep = computed(() => {
    const slide = this.slide();
    const state = this.state();
    return slide && state ? viewAt(planSlide(slide, () => 0), state.step).elementStep : 0;
  });
  protected readonly ratio = computed(() => this.deck().stage.width / this.deck().stage.height);

  protected readonly position = computed(() => {
    const state = this.state();
    if (state === null) return '';
    const slide = `Slide ${this.slideIndex() + 1} of ${this.deck().slides.length}`;
    return state.steps > 0 ? `${slide}, step ${state.step} of ${state.steps}` : slide;
  });
  protected readonly running = computed(() => this.state()?.timer.running ?? false);
  protected readonly elapsed = computed(() => {
    const timer = this.state()?.timer;
    if (!timer) return formatElapsed(0);
    return formatElapsed(timer.elapsedMs + (timer.running ? Math.max(0, this.now() - this.receivedAt()) : 0));
  });
  protected readonly atStart = computed(() => this.slideIndex() <= 0 && (this.state()?.step ?? 0) === 0);
  protected readonly atEnd = computed(() => {
    const state = this.state();
    return state !== null && this.slideIndex() >= this.deck().slides.length - 1 && state.step >= state.steps;
  });

  constructor() {
    // One channel per deck id. A window opened (or reloaded) later asks where the presentation is; the answer is a `state`.
    effect((onCleanup) => {
      const id = this.deckId();
      const connection = this.sync.connect(id, (message) => {
        if (message.type !== 'state') return;
        this.receivedAt.set(Date.now());
        this.now.set(Date.now());
        this.state.set(message);
      });
      untracked(() => {
        this.connection = connection;
        this.state.set(null);
      });
      connection.post({ type: 'hello' });
      onCleanup(() => {
        connection.close();
        if (this.connection === connection) this.connection = null;
      });
    });

    // The clock face only needs refreshing while the timer runs.
    effect((onCleanup) => {
      if (!this.running()) return;
      const timer = setInterval(() => untracked(() => this.now.set(Date.now())), TICK_MS);
      onCleanup(() => clearInterval(timer));
    });
  }

  protected readonly available = (): boolean => this.connection?.available ?? false;

  protected send(message: OutgoingMessage): void {
    this.connection?.post(message);
  }

  protected toggleTimer(): void {
    this.send({ type: 'timer', action: this.running() ? 'pause' : 'start' });
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && event.target.closest('button, a[href]')) return;
    const prev = (event.key === ' ' && event.shiftKey) || PREV_KEYS.has(event.key);
    if (!prev && !NEXT_KEYS.has(event.key)) return;
    event.preventDefault();
    this.send({ type: 'command', action: prev ? 'prev' : 'next' });
  }

  private layoutOf(id: string | undefined): Layout | undefined {
    return id === undefined ? undefined : this.deck().layouts.find((layout) => layout.id === id);
  }
}
