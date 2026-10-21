import { Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import type { Deck, Layout, Slide, Transition } from '../core/model';
import { ALL_STEPS, CodeHostEvents, SlideRenderer } from '../renderer';
import { slidesToMount } from './preloader';
import { StepEngine } from './step-engine';

/** Horizontal distance (px) a finger has to travel to count as a swipe rather than a tap. */
const SWIPE_DISTANCE = 50;
/** The controls fade out this long after the last pointer movement. */
const CONTROLS_MS = 3000;
const MAX_TRANSITION_MS = 5000;

/** How long a transition runs; none for "none" and for a length that is not a positive number. */
const transitionMs = (transition: Transition | undefined): number =>
  transition && transition.type !== 'none' && transition.durationMs > 0 ? Math.min(transition.durationMs, MAX_TRANSITION_MS) : 0;

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown', 'PageDown', 'Enter', ' ']);
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace']);

interface Layer {
  slide: Slide;
  layout: Layout | undefined;
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

  protected readonly engine = new StepEngine({
    slides: () => this.deck().slides,
    componentSteps: (id) => this.events.stepCounts().get(id) ?? 0,
  });
  protected readonly reducedMotion = signal(false);
  protected readonly controlsVisible = signal(false);
  private readonly leavingId = signal<string | null>(null);
  private readonly animating = signal(false);
  private readonly note = signal<string | null>(null);

  protected readonly ratio = computed(() => this.deck().stage.width / this.deck().stage.height);

  protected readonly layers = computed<Layer[]>(() => {
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
        layout: deck.layouts.find((layout) => layout.id === slide.layoutId),
        current: isCurrent,
        leaving: !isCurrent && slide.id === leavingId,
        step: isCurrent ? view.elementStep : index < current ? ALL_STEPS : 0,
        distance,
        transition: isCurrent && animate && slide.transition && slide.transition.type !== 'none' ? slide.transition.type : null,
      };
    });
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
    if (!this.engine.next()) this.note.set('End of the presentation. Press Escape to leave.');
  }

  protected previous(): void {
    this.note.set(null);
    this.engine.prev();
  }

  protected exit(): void {
    if (this.done) return;
    this.done = true;
    this.leaveFullscreen();
    this.exited.emit();
  }

  protected onFullscreenChange(): void {
    if (this.document.fullscreenElement === this.host) this.fullscreenEntered = true;
    else if (this.fullscreenEntered) {
      // The browser took us out (Escape, F11): that is the end of the presentation.
      this.fullscreenEntered = false;
      this.exit();
    }
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
