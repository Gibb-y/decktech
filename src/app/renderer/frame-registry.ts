import { Service, computed, signal } from '@angular/core';

/** Frames at or beyond this many slides from the one shown are destroyed (arc42 §6.5, R3). */
export const PRELOAD_DISTANCE = 1;

/**
 * Which component frames exist right now, by element id. The renderer registers a frame when it
 * creates one and releases it when the frame is destroyed, so `count` is the number of live
 * iframes (R3; the stress measurements and tests read it).
 */
@Service()
export class FrameRegistry {
  private readonly live = signal<ReadonlySet<string>>(new Set());
  readonly count = computed(() => this.live().size);

  register(key: string): void {
    this.live.update((set) => (set.has(key) ? set : new Set(set).add(key)));
  }

  release(key: string): void {
    this.live.update((set) => {
      if (!set.has(key)) return set;
      const next = new Set(set);
      next.delete(key);
      return next;
    });
  }

  has(key: string): boolean {
    return this.live().has(key);
  }
}
