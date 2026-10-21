/** Version of the messages the two presentation windows exchange; a message of another version is dropped. */
export const SYNC_VERSION = 1;

/** Upper bound for slide, step and count fields: far above any real deck, small enough to be a sane index. */
const MAX_INDEX = 100_000;
/** A timer that has run for about three years is not a timer. */
const MAX_ELAPSED_MS = 100_000_000_000;

export type TimerAction = 'start' | 'pause' | 'reset';

export interface TimerSnapshot {
  readonly running: boolean;
  /** Time on the clock at the moment the snapshot was taken. */
  readonly elapsedMs: number;
}

/** The presentation window's answer to everything: where it is and what the timer says. */
export interface StateMessage {
  readonly v: typeof SYNC_VERSION;
  readonly type: 'state';
  readonly slide: number;
  readonly step: number;
  /** Steps the shown slide has (`step` is within `0..steps`). */
  readonly steps: number;
  readonly slides: number;
  readonly timer: TimerSnapshot;
}

export interface HelloMessage {
  readonly v: typeof SYNC_VERSION;
  readonly type: 'hello';
}

export type CommandMessage =
  | { readonly v: typeof SYNC_VERSION; readonly type: 'command'; readonly action: 'next' | 'prev' }
  | { readonly v: typeof SYNC_VERSION; readonly type: 'command'; readonly action: 'goTo'; readonly slide: number; readonly step: number };

export interface TimerMessage {
  readonly v: typeof SYNC_VERSION;
  readonly type: 'timer';
  readonly action: TimerAction;
}

export type SyncMessage = StateMessage | HelloMessage | CommandMessage | TimerMessage;

/** A message as the sender writes it: the version is added when it is posted. */
export type OutgoingMessage = SyncMessage extends infer M ? (M extends SyncMessage ? Omit<M, 'v'> : never) : never;

export const syncChannelName = (deckId: string): string => `decktech.presenter.${deckId}`;

const isIndex = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_INDEX;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);

/**
 * Checks a message that arrived on the channel. Anything on a `BroadcastChannel` can come from any
 * same-origin context, so nothing is trusted: a wrong version, unknown type or action, a field of the
 * wrong type, a fractional or out-of-range number, or a step beyond the slide's steps yields `null`.
 * The result is rebuilt from the known fields only, so extra properties (`__proto__`, `constructor`)
 * never travel on.
 */
export function parseSyncMessage(data: unknown): SyncMessage | null {
  if (!isRecord(data) || own(data, 'v') !== SYNC_VERSION) return null;
  switch (own(data, 'type')) {
    case 'hello':
      return { v: SYNC_VERSION, type: 'hello' };
    case 'timer': {
      const action = own(data, 'action');
      return action === 'start' || action === 'pause' || action === 'reset' ? { v: SYNC_VERSION, type: 'timer', action } : null;
    }
    case 'command': {
      const action = own(data, 'action');
      if (action === 'next' || action === 'prev') return { v: SYNC_VERSION, type: 'command', action };
      if (action !== 'goTo') return null;
      const slide = own(data, 'slide');
      const step = own(data, 'step') ?? 0;
      return isIndex(slide) && isIndex(step) ? { v: SYNC_VERSION, type: 'command', action, slide, step } : null;
    }
    case 'state': {
      const { slide, step, steps, slides } = { slide: own(data, 'slide'), step: own(data, 'step'), steps: own(data, 'steps'), slides: own(data, 'slides') };
      const timer = own(data, 'timer');
      if (!isIndex(slide) || !isIndex(step) || !isIndex(steps) || !isIndex(slides) || !isRecord(timer)) return null;
      const running = own(timer, 'running');
      const elapsedMs = own(timer, 'elapsedMs');
      if (typeof running !== 'boolean' || typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > MAX_ELAPSED_MS) return null;
      if (slide >= Math.max(slides, 1) || step > steps) return null;
      return { v: SYNC_VERSION, type: 'state', slide, step, steps, slides, timer: { running, elapsedMs } };
    }
    default:
      return null;
  }
}
