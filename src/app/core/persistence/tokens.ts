import { InjectionToken } from '@angular/core';
import type { Deck } from '../model';

/**
 * Hook for "Download .deck" in the failure banner. The archive writer (DT-16) provides it; until
 * then it is `null` and the banner offers only a retry.
 */
export type DeckExportHandler = (deck: Deck) => void | Promise<void>;

export const DECK_EXPORT_HANDLER = new InjectionToken<DeckExportHandler | null>('Deck export handler', {
  providedIn: 'root',
  factory: () => null,
});

/** The subset of `navigator.storage` used to ask for persistent storage. */
export interface PersistentStorage {
  persisted?(): Promise<boolean>;
  persist?(): Promise<boolean>;
}

export const STORAGE_MANAGER = new InjectionToken<PersistentStorage | null>('Storage manager', {
  providedIn: 'root',
  factory: () => (typeof navigator === 'undefined' ? null : (navigator.storage ?? null)),
});

export interface AutosaveOptions {
  /** Quiet time after the last change before writing. */
  debounceMs: number;
  /** Longest a continuous burst of changes may delay a write. */
  maxWaitMs: number;
}

export const AUTOSAVE_OPTIONS = new InjectionToken<AutosaveOptions>('Autosave options', {
  providedIn: 'root',
  factory: () => ({ debounceMs: 500, maxWaitMs: 5_000 }),
});
