import { Service, signal } from '@angular/core';
import { SYNC_VERSION, parseSyncMessage, syncChannelName, type OutgoingMessage, type SyncMessage } from './sync-protocol';

/** One window's end of the channel of a deck. */
export interface SyncConnection {
  /** False when the browser has no `BroadcastChannel`; `post` then does nothing. */
  readonly available: boolean;
  post(message: OutgoingMessage): void;
  close(): void;
}

/**
 * The presentation window and the presenter view talk over a `BroadcastChannel` named after the
 * deck (arc42 §3.2): same origin only, no server, and no `window.opener`, so the windows work with
 * `Cross-Origin-Opener-Policy: same-origin` and when opened with `noopener`. Every incoming message
 * is validated; what does not validate is counted in `rejected` and dropped.
 */
@Service()
export class PresenterSync {
  /** Messages dropped because they did not validate (for tests and diagnostics). */
  readonly rejected = signal(0);

  connect(deckId: string, onMessage: (message: SyncMessage) => void): SyncConnection {
    if (typeof BroadcastChannel !== 'function') return { available: false, post: () => undefined, close: () => undefined };
    const channel = new BroadcastChannel(syncChannelName(deckId));
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = parseSyncMessage(event.data);
      if (message) onMessage(message);
      else this.rejected.update((count) => count + 1);
    };
    let open = true;
    return {
      available: true,
      post: (message) => {
        if (!open) return;
        try {
          channel.postMessage({ ...message, v: SYNC_VERSION });
        } catch {
          // A channel that was closed underneath us: the other window is simply not reachable.
        }
      },
      close: () => {
        open = false;
        channel.close();
      },
    };
  }
}
