import { Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, linkedSignal, output, signal, untracked } from '@angular/core';
import { DOCUMENT, Location } from '@angular/common';
import { Router } from '@angular/router';
import type { Deck, Layout, Slide, Transition } from '../core/model';
import { ALL_STEPS, CodeHostEvents, PRELOAD_DISTANCE, SlideRenderer } from '../renderer';
import { assignSlots, slidesToMount } from './preloader';
import { PresenterSync, type SyncConnection } from './presenter-view/presenter-sync';
import { PresenterTimer } from './presenter-view/presenter-timer';
import type { SyncMessage } from './presenter-view/sync-protocol';
import { StepEngine } from './step-engine';

/** Horizontal distance (px) a finger has to travel to count as a swipe rather than a tap. */
const SWIPE_DISTANCE = 50;
/** The controls fade out this long after the last pointer movement. */
const CONTROLS_MS = 3000;
const MAX_TRANSITION_MS = 5000;
/** Opening a window can make the browser leave fullscreen; a change this soon after is not the presenter leaving. */
const WINDOW_OPEN_GRACE_MS = 2000;

/** How long a transition runs; none for "none" and for a length that is not a positive number. */
const transitionMs = (transition: Transition | undefined): number =>
  transition && transition.type !== 'none' && transition.durationMs > 0 ? Math.min(transition.durationMs, MAX_TRANSITION_MS) : 0;

/** The shown slide, a code neighbour on each side within `PRELOAD_DISTANCE`, and one that is leaving. */
const LAYER_PLACES = 2 * PRELOAD_DISTANCE + 2;

export const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown', 'PageDown', 'Enter', ' ']);
export const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace']);

interface Layer {
  slide: Slide;
  /** Position of the slide in the deck; the layers are stacked by it (CSS `order`), not by their place in the DOM. */
  index: number;  layout: Layout | undefined;
  current: boolean;
  leaving: boolean;
  /** Steps to draw: the shown slide as stepped to, the next as it starts, an earlier one complete. */
  step: number;
  distance: number;
  /** Transition type of the slide coming in; null when it does not animate. */
  transition: Transition['type'] | null;
}

/**
 * The presentation (arc42 §5.5, §6.3): the slides fill the screen (fullscreen where the browser
 * allows it) and move on by keyboard, click, swipe or clicker. A `StepEngine` decides what "next"
 * means; the `Preloader` rule (`slidesToMount`) keeps the slides next to the shown one in the page,
 * hidden, so their code components are running when the slide comes. The view makes no requests of
 * its own: it draws the deck it is given.
 */
@Component({
  selector: 'app-presentation-view',
  imports: [SlideRenderer],
  templateUrl: './presentation-view.html',
  styleUrl: './presentation-view.css',
  host: {
    role: 'region',
    'aria-roledescription': 'presentation',
    '[attr.aria-label]': 'deck().title',
    tabindex: '-1',
    '(document:keydown)': 'onKeydown($event)',
    '(document:fullscreenchange)': 'onFullscreenChange()',
    '(pointermove)': 'showControls()',
  },
})
export class PresentationView {
  readonly deck = input.required<Deck>();
  /** Index of the slide to start on. */
  readonly start = input<number>(0);
  /** The audience-facing view is done: Escape, the Exit button or the browser leaving fullscreen. */
  readonly exited = output<void>();

  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly events = inject(CodeHostEvents);
  private readonly destroyRef = inject(DestroyRef);
  private readonly sync = inject(PresenterSync);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly timer = new PresenterTimer(() => Date.now());
  private connection: SyncConnection | null = null;

  protected readonly engine = new StepEngine({
    slides: () => this.deck().slides,
    componentSteps: (id) => this.events.stepCounts().get(id) ?? 0,
  });
  protected readonly reducedMotion = signal(false);
  protected readonly controlsVisible = signal(false);
  private readonly leavingId = signal<string | null>(null);
  private readonly animating = signal(false);
  private readonly note = signal<string | null>(null);

  /** Its own computed, so an edit of the deck does not reconnect the channel. */
  private readonly deckId = computed(() => this.deck().id);
  protected readonly ratio = computed(() => this.deck().stage.width / this.deck().stage.height);

  private readonly wantedLayers = computed<Layer[]>(() => {
    const deck = this.deck();
    const current = this.engine.slide();
    const mounted = slidesToMount(deck.slides, current);
    const leavingId = this.leavingId();
    const leaving = leavingId === null || mounted.some((m) => m.slide.id === leavingId) ? -1 : deck.slides.findIndex((s) => s.id === leavingId);
    const shown = mounted.map((m) => ({ ...m }));
    if (leaving >= 0) shown.push({ slide: deck.slides[leaving], index: leaving, distance: Math.abs(leaving - current) });
    shown.sort((a, b) => a.index - b.index);
    const view = this.engine.view();
    const animate = this.animating() && !this.reducedMotion();
    return shown.map(({ slide, index, distance }) => {
      const isCurrent = index === current;
      return {
        slide,
        index,
        layout: deck.layouts.find((layout) => layout.id === slide.layoutId),
        current: isCurrent,
        leaving: !isCurrent && slide.id === leavingId,
        step: isCurrent ? view.elementStep : index < current ? ALL_STEPS : 0,
        distance,
        transition: isCurrent && animate && slide.transition && slide.transition.type !== 'none' ? slide.transition.type : null,
      };
    });
  });

  /**
   * The layers in a fixed pool of places. A slide keeps its place while it is in the page: a layer
   * that the `@for` moves is reloaded by the browser, and a code component's frame with it (it would
   * report that it navigated away). `Layer.index` stacks the layers instead of their DOM order.
   */
  protected readonly layers = linkedSignal<Layer[], (Layer | null)[]>({
    source: this.wantedLayers,
    computation: (next, previous) => assignSlots(next, previous?.value ?? [], LAYER_PLACES, (layer) => layer.slide.id),
  });

  /** Length of the transition of the slide shown, as a CSS time. */
  protected readonly duration = computed(() => {
    return `${transitionMs(this.deck().slides[this.engine.slide()]?.transition)}ms`;
  });

  /** "Slide 2 of 5", with the step when the slide has steps; what the live region speaks and the controls show. */
  protected readonly position = computed(() => {
    const total = this.engine.plan().total;
    const slide = `Slide ${this.engine.slide() + 1} of ${this.engine.slideCount()}`;
    return total > 0 ? `${slide}, step ${this.engine.step()} of ${total}` : slide;
  });
  protected readonly announcement = computed(() => this.note() ?? this.position());
  protected readonly atStart = computed(() => this.engine.slide() === 0 && this.engine.step() === 0);
  protected readonly atEnd = computed(() => this.engine.slide() >= this.engine.slideCount() - 1 && this.engine.step() >= this.engine.plan().total);

  private fullscreenEntered = false;
  private done = false;
  private touch: { x: number; y: number } | null = null;
  private swiped = false;
  private endPresses = false;
  private openingWindow = false;
  private openingTimer: ReturnType<typeof setTimeout> | undefined;
  private leaveTimer: ReturnType<typeof setTimeout> | undefined;
  private controlsTimer: ReturnType<typeof setTimeout> | undefined;
  private handledNavigation = this.events.navigation()?.seq ?? 0;

  constructor() {
    effect(() => {
      const start = this.start();
      untracked(() => this.engine.goTo(start));
    });

    // The step each component on the shown slide has to show; the renderer sends it to the frame.
    effect(() => {
      const steps = this.engine.view().componentSteps;
      untracked(() => this.events.stepIndexes.set(steps));
    });

    // A transition plays for the slide that comes in; the one that goes stays under it until it is over.
    let previous: string | null = null;
    effect(() => {
      const id = this.deck().slides[this.engine.slide()]?.id ?? null;
      untracked(() => {
        if (previous !== null && id !== previous) this.startTransition(previous, id);
        previous = id;
      });
    });

    // A component asking for next / prev / goTo; requests from slides that are only preloaded are ignored.
    effect(() => {
      const request = this.events.navigation();
      if (!request || request.seq <= this.handledNavigation) return;
      untracked(() => {
        this.handledNavigation = request.seq;
        if (!this.deck().slides[this.engine.slide()]?.elements.some((element) => element.id === request.elementId)) return;
        const { request: action } = request;
        if ('slideId' in action) this.engine.goToSlideId(action.slideId);
        else if (action.action === 'next') this.advance();
        else this.engine.prev();
      });
    });

    this.timer.apply('start');
    // The presenter view mirrors this window: the position and the clock go out whenever they change,
    // and its commands are applied here, so the engine stays the one source of truth.
    effect((onCleanup) => {
      const connection = this.sync.connect(this.deckId(), (message) => this.onSync(message));
      untracked(() => {
        this.connection = connection;
        this.broadcast();
      });
      onCleanup(() => {
        connection.close();
        if (this.connection === connection) this.connection = null;
      });
    });
    effect(() => {
      void this.engine.slide();
      void this.engine.step();
      void this.engine.plan().total;
      void this.engine.slideCount();
      untracked(() => this.broadcast());
    });

    if (typeof matchMedia === 'function') {
      const query = matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion.set(query.matches);
      const onChange = (event: MediaQueryListEvent) => this.reducedMotion.set(event.matches);
      query.addEventListener?.('change', onChange);
      this.destroyRef.onDestroy(() => query.removeEventListener?.('change', onChange));
    }

    afterNextRender(() => {
      this.host.focus({ preventScroll: true });
      this.enterFullscreen();
    });
    this.destroyRef.onDestroy(() => {
      clearTimeout(this.leaveTimer);
      clearTimeout(this.controlsTimer);
      clearTimeout(this.openingTimer);
      this.events.stepIndexes.set(new Map());
      this.leaveFullscreen();
    });
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    // Enter and Space on a focused control press that control; they are not "next".
    if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && event.target.closest('button, a[href]')) return;
    if (event.key === 'Escape') this.handled(event, () => this.exit());
    else if (event.key === ' ' && event.shiftKey) this.handled(event, () => this.engine.prev());
    else if (NEXT_KEYS.has(event.key)) this.handled(event, () => this.advance());
    else if (PREV_KEYS.has(event.key)) this.handled(event, () => this.engine.prev());
    else if (event.key === 'Home') this.handled(event, () => this.engine.first());
    else if (event.key === 'End') this.handled(event, () => this.engine.last());
  }

  protected onClick(): void {
    if (this.swiped) return;
    this.advance();
  }

  protected onPointerDown(event: PointerEvent): void {
    this.swiped = false;
    this.touch = event.pointerType === 'touch' ? { x: event.clientX, y: event.clientY } : null;
  }

  protected onPointerUp(event: PointerEvent): void {
    const start = this.touch;
    this.touch = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    this.swiped = true;
    if (dx < 0) this.advance();
    else this.engine.prev();
  }

  protected showControls(): void {
    this.controlsVisible.set(true);
    clearTimeout(this.controlsTimer);
    this.controlsTimer = setTimeout(() => this.controlsVisible.set(false), CONTROLS_MS);
  }

  protected advance(): void {
    this.note.set(null);
    // Alternating a trailing no-break space makes a repeated message a change the live region announces again.
    if (!this.engine.next()) this.note.set(`End of the presentation. Press Escape to leave.${(this.endPresses = !this.endPresses) ? ' ' : ''}`);
  }

  /** The Next button; at the end it is `aria-disabled` and does nothing. */
  protected onNextButton(): void {
    if (!this.atEnd()) this.advance();
  }

  protected previous(): void {
    this.note.set(null);
    this.engine.prev();
  }

  /** Opens the presenter view in its own window (same origin, `noopener`: the windows talk over the channel, not through `opener`). */
  protected openPresenterView(): void {
    const url = this.location.prepareExternalUrl(this.router.serializeUrl(this.router.createUrlTree(['/deck', this.deck().id, 'presenter-view'])));
    this.openingWindow = true;
    clearTimeout(this.openingTimer);
    this.openingTimer = setTimeout(() => (this.openingWindow = false), WINDOW_OPEN_GRACE_MS);
    this.document.defaultView?.open(url, 'decktech-presenter-view', 'noopener');
  }

  protected exit(): void {
    if (this.done) return;
    this.done = true;
    this.leaveFullscreen();
    this.exited.emit();
  }

  protected onFullscreenChange(): void {
    if (this.document.fullscreenElement === this.host) this.fullscreenEntered = true;
    else if (this.fullscreenEntered && !this.document.fullscreenElement) {
      // The browser took us out (Escape, F11): that is the end of the presentation.
      this.fullscreenEntered = false;
      if (!this.openingWindow) this.exit();
    }
  }

  private onSync(message: SyncMessage): void {
    if (this.done) return;
    if (message.type === 'hello') this.broadcast();
    else if (message.type === 'timer') {
      this.timer.apply(message.action);
      this.broadcast();
    } else if (message.type === 'command') {
      this.note.set(null);
      if (message.action === 'next') this.advance();
      else if (message.action === 'prev') this.engine.prev();
      else if (message.action === 'goTo') this.engine.goTo(message.slide, message.step);
    }
  }

  private broadcast(): void {
    this.connection?.post({
      type: 'state',
      slide: this.engine.slide(),
      step: this.engine.step(),
      steps: this.engine.plan().total,
      slides: this.engine.slideCount(),
      timer: this.timer.snapshot(),
    });
  }

  private handled(event: KeyboardEvent, action: () => unknown): void {
    event.preventDefault();
    this.note.set(null);
    action();
  }

  private startTransition(from: string, to: string | null): void {
    clearTimeout(this.leaveTimer);
    this.animating.set(true);
    const slide = this.deck().slides.find((s) => s.id === to);
    const ms = this.reducedMotion() ? 0 : transitionMs(slide?.transition);
    if (ms === 0) return this.leavingId.set(null);
    this.leavingId.set(from);
    this.leaveTimer = setTimeout(() => this.leavingId.set(null), ms);
  }

  private enterFullscreen(): void {
    if (!this.document.fullscreenEnabled || typeof this.host.requestFullscreen !== 'function') return;
    // Refused (no user gesture, policy): the view still fills the window, and Escape leaves it.
    this.host.requestFullscreen().catch(() => undefined);
  }

  private leaveFullscreen(): void {
    this.fullscreenEntered = false;
    if (this.document.fullscreenElement === this.host) this.document.exitFullscreen().catch(() => undefined);
  }
}
