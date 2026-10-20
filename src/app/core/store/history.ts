import { computed, signal } from '@angular/core';
import { diff, type Patch } from './patch';

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

/** The document before and after the recorded command; used to merge a burst into a single diff. */
export interface Snapshots {
  readonly before: unknown;
  readonly after: unknown;
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
  /** The document before the first command of the open entry. */
  private openBefore: unknown;
  /** Key of a gesture in progress; its commands merge however long the pauses between them. */
  private held: string | undefined;

  readonly canUndo = computed(() => this.undoStack().length > 0);
  readonly canRedo = computed(() => this.redoStack().length > 0);

  constructor(options: HistoryOptions = {}) {
    this.limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
    this.windowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    if (!Number.isInteger(this.limit) || this.limit < 1) throw new RangeError('History limit must be a positive integer');
  }

  /**
   * Records a new edit. Clears the redo stack; merges into the previous entry when it coalesces.
   * A merged entry gets one fresh diff from the start of the burst, so its size follows what
   * changed overall, not how many commands the gesture issued.
   */
  record(entry: HistoryEntry, snapshots: Snapshots): void {
    this.redoStack.set([]);
    const stack = this.undoStack();
    const top = stack[stack.length - 1];
    if (
      top &&
      top === this.open &&
      entry.coalesceKey !== undefined &&
      top.coalesceKey === entry.coalesceKey &&
      (entry.time - top.time <= this.windowMs || entry.coalesceKey === this.held)
    ) {
      this.open = {
        ...top,
        forward: diff(this.openBefore, snapshots.after),
        inverse: diff(snapshots.after, this.openBefore),
        time: entry.time,
      };
      this.undoStack.set([...stack.slice(0, -1), this.open]);
      return;
    }
    this.open = entry;
    this.openBefore = snapshots.before;
    this.undoStack.set([...stack, entry].slice(-this.limit));
  }

  /**
   * Keeps merging commands with `key` for as long as the hold lasts, regardless of the window, so
   * a drag that pauses mid-way is still one undo step. Returns the release function.
   */
  hold(key: string): () => void {
    this.held = key;
    return () => {
      if (this.held === key) this.held = undefined;
    };
  }

  /** The entry `undo()` would move, without moving it. */
  peekUndo(): HistoryEntry | undefined {
    return this.undoStack().at(-1);
  }

  /** The entry `redo()` would move, without moving it. */
  peekRedo(): HistoryEntry | undefined {
    return this.redoStack().at(-1);
  }

  /** Moves the newest entry to the redo stack and returns it, or `undefined` if there is none. */
  undo(): HistoryEntry | undefined {
    const stack = this.undoStack();
    const entry = stack[stack.length - 1];
    if (!entry) return undefined;
    this.open = undefined;
    this.openBefore = undefined;
    this.undoStack.set(stack.slice(0, -1));
    this.redoStack.update((r) => [...r, entry]);
    return entry;
  }

  redo(): HistoryEntry | undefined {
    const stack = this.redoStack();
    const entry = stack[stack.length - 1];
    if (!entry) return undefined;
    this.open = undefined;
    this.openBefore = undefined;
    this.redoStack.set(stack.slice(0, -1));
    this.undoStack.update((u) => [...u, entry]);
    return entry;
  }

  clear(): void {
    this.open = undefined;
    this.openBefore = undefined;
    this.undoStack.set([]);
    this.redoStack.set([]);
  }
}
