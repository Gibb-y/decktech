import { Service, signal } from '@angular/core';

export type ErrorSource = 'host' | 'component';

export interface ErrorEntry {
  seq: number;
  source: ErrorSource;
  /** The code component the error belongs to; absent for errors of the app itself. */
  componentId?: string;
  message: string;
}

export const ERROR_CAPACITY = 200;
const MESSAGE_LIMIT = 2000;

/**
 * Collects the errors of the app and of its code components, tagged by component id (arc42 §8.9).
 * Everything stays in memory: nothing is sent anywhere. Keeps the newest `ERROR_CAPACITY` entries.
 */
@Service()
export class ErrorService {
  private seq = 0;
  readonly entries = signal<readonly ErrorEntry[]>([]);

  report(source: ErrorSource, message: string, componentId?: string): void {
    const entry: ErrorEntry = { seq: ++this.seq, source, message: message.slice(0, MESSAGE_LIMIT), ...(componentId === undefined ? {} : { componentId }) };
    this.entries.update((entries) => [...entries.slice(-(ERROR_CAPACITY - 1)), entry]);
  }

  /** The errors of one component, oldest first. */
  forComponent(componentId: string): readonly ErrorEntry[] {
    return this.entries().filter((entry) => entry.componentId === componentId);
  }

  clear(): void {
    this.entries.set([]);
  }
}
