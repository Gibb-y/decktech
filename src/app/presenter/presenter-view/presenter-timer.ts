import type { TimerAction, TimerSnapshot } from './sync-protocol';

/**
 * The talk's clock. It lives in the presentation window, which is the one that stays open, so
 * closing or reloading the presenter view loses nothing: the view asks for the state and gets the
 * time back. It stores the time already counted plus the moment it last started, so nothing ticks.
 */
export class PresenterTimer {
  private counted = 0;
  private startedAt: number | null = null;

  /** `now` is the clock in milliseconds (injected so tests need no real time). */
  constructor(private readonly now: () => number) {}

  snapshot(): TimerSnapshot {
    return { running: this.startedAt !== null, elapsedMs: this.counted + (this.startedAt === null ? 0 : Math.max(0, this.now() - this.startedAt)) };
  }

  apply(action: TimerAction): void {
    const { running, elapsedMs } = this.snapshot();
    if (action === 'start') {
      if (!running) this.startedAt = this.now();
    } else if (action === 'pause') {
      this.counted = elapsedMs;
      this.startedAt = null;
    } else {
      this.counted = 0;
      this.startedAt = null;
    }
  }
}
