import { Service, signal } from '@angular/core';

const SNAPSHOT_CAPACITY = 25;

export type NavigateRequest = { action: 'next' | 'prev' } | { action: 'goTo'; slideId: string };

/**
 * What code components tell the rest of the app, and what the presenter tells them, keyed by
 * element id. The presenter's step engine reads `stepCounts` and writes
 * `stepIndexes`; it does so through this service because renderer views are created by the
 * renderer and cannot be wired with outputs.
 */
@Service()
export class CodeHostEvents {
  /** Internal steps each component declared with `deck.steps(n)`. */
  readonly stepCounts = signal<ReadonlyMap<string, number>>(new Map());
  /** The internal step each component should show (sent to it as `deck.onStep`). */
  readonly stepIndexes = signal<ReadonlyMap<string, number>>(new Map());
  /** The latest navigation request from a component, in presentation mode only. */
  readonly navigation = signal<{ seq: number; elementId: string; request: NavigateRequest } | null>(null);
  /** The latest snapshot each component supplied for its thumbnail. */
  readonly snapshots = signal<ReadonlyMap<string, Blob>>(new Map());
  private seq = 0;

  setStepCount(elementId: string, count: number): void {
    this.stepCounts.update((map) => new Map(map).set(elementId, count));
  }

  requestNavigation(elementId: string, request: NavigateRequest): void {
    this.navigation.set({ seq: ++this.seq, elementId, request });
  }

  setSnapshot(elementId: string, blob: Blob): void {
    this.snapshots.update((map) => {
      const next = new Map(map);
      next.delete(elementId);
      next.set(elementId, blob);
      // Oldest first: a long session with many components keeps memory bounded.
      while (next.size > SNAPSHOT_CAPACITY) next.delete(next.keys().next().value as string);
      return next;
    });
  }

  /**
   * Forgets what a frame that is gone declared. The snapshot stays: it is what the thumbnail
   * shows while the frame does not exist.
   */
  release(elementId: string): void {
    this.stepCounts.update((map) => without(map, elementId));
  }
}

function without<T>(map: ReadonlyMap<string, T>, key: string): ReadonlyMap<string, T> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}
