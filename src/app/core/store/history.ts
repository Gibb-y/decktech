import { computed, signal } from '@angular/core';
import type { Patch } from './patch';

export const DEFAULT_HISTORY_LIMIT = 200;
export const DEFAULT_COALESCE_WINDOW_MS = 500;

export interface HistoryEntry {
  readonly name: string;
  readonly forward: Patch;
  readonly inverse: Patch;
  readonly coalesceKey?: string;
  /** Time of the last command merged into this entry. */
  readonly time: number;
}

export interface HistoryOptions {
  /** Maximum number of undo steps kept; the oldest is dropped first. */
  limit?: number;
  /** Commands with the same key closer together than this are merged into one entry. */
  coalesceWindowMs?: number;
}

/**
 * Bounded undo/redo stacks of patches. It does not touch the deck: the store applies the
 * `inverse` of an undone entry and the `forward` of a redone one.
 */
export class History {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly undoStack = signal<readonly HistoryEntry[]>([]);
  private readonly redoStack = signal<readonly HistoryEntry[]>([]);
  /** The entry that may still absorb further commands; cleared by undo, redo and clear. */
  private open: HistoryEntry | undefined;

  readonly canUndo = computed(() => this.undoStack().length > 0);
  readonly canRedo = computed(() => this.redoStack().length > 0);

  constructor(options: HistoryOptions = {}) {
    this.limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
    this.windowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    if (!Number.isInteger(this.limit) || this.limit < 1) throw new RangeError('History limit must be a positive integer');
  }

  /** Records a new edit. Clears the redo stack; merges into the previous entry when it coalesces. */
  record(entry: HistoryEntry): void {
    this.redoStack.set([]);
    const stack = this.undoStack();
    const top = stack[stack.length - 1];
    if (
      top &&
      top === this.open &&
      entry.coalesceKey !== undefined &&
      top.coalesceKey === entry.coalesceKey &&
      entry.time - top.time <= this.windowMs
    ) {
      // Undoing the merged step must run the newest inverse first.
      this.open = {
        ...top,
        forward: [...top.forward, ...entry.forward],
        inverse: [...entry.inverse, ...top.inverse],
        time: entry.time,
      };
      this.undoStack.set([...stack.slice(0, -1), this.open]);
      return;
    }
    this.open = entry;
    this.undoStack.set([...stack, entry].slice(-this.limit));
  }

  /** Moves the newest entry to the redo stack and returns it, or `undefined` if there is none. */
  undo(): HistoryEntry | undefined {
    const stack = this.undoStack();
    const entry = stack[stack.length - 1];
    if (!entry) return undefined;
    this.open = undefined;
    this.undoStack.set(stack.slice(0, -1));
    this.redoStack.update((r) => [...r, entry]);
    return entry;
  }

  redo(): HistoryEntry | undefined {
    const stack = this.redoStack();
    const entry = stack[stack.length - 1];
    if (!entry) return undefined;
    this.open = undefined;
    this.redoStack.set(stack.slice(0, -1));
    this.undoStack.update((u) => [...u, entry]);
    return entry;
  }

  clear(): void {
    this.open = undefined;
    this.undoStack.set([]);
    this.redoStack.set([]);
  }
}
