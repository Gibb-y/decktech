import { BRIDGE_LIMITS, parseFrameMessage, type FrameMessage, type HostMessage } from './protocol';

/** The part of `MessagePort` the bridge uses; tests supply a fake. */
export interface BridgePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
}

export type BridgeCloseReason = 'flood' | 'malformed' | 'closed';

export interface BridgeOptions {
  /** Millisecond clock; injectable so tests need no real time. */
  now?: () => number;
  onMessage: (message: FrameMessage) => void;
  /** A message that did not parse or that was dropped, with the reason (for the console). */
  onRejected?: (reason: string) => void;
  /** The bridge ended the conversation; the frame should be destroyed. */
  onClosed?: (reason: BridgeCloseReason) => void;
}

/**
 * Host end of a component's `MessagePort` (arc42 §5.3). Everything the frame sends is parsed into
 * the closed set of `FrameMessage`s (`parseFrameMessage`); the rest is dropped. Accepted messages
 * are rate limited per window, and a frame that keeps flooding or keeps sending garbage is cut
 * off. Nothing here interprets a message, that is `HostApi`'s job.
 */
export class HostBridge {
  private readonly now: () => number;
  private windowStart: number;
  private accepted = 0;
  private dropped = 0;
  private rejected = 0;
  private beats = 0;
  private closed = false;

  constructor(
    private readonly port: BridgePort,
    private readonly options: BridgeOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.windowStart = this.now();
    port.onmessage = (event) => this.receive(event.data);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(message: HostMessage, transfer: Transferable[] = []): void {
    if (this.closed) return;
    try {
      this.port.postMessage(message, transfer);
    } catch {
      // A detached or closed port: the frame is gone, nothing to tell it.
    }
  }

  close(reason: BridgeCloseReason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.port.onmessage = null;
    try {
      this.port.close();
    } catch {
      // already closed
    }
    this.options.onClosed?.(reason);
  }

  private receive(data: unknown): void {
    if (this.closed) return;
    const now = this.now();
    if (now - this.windowStart >= BRIDGE_LIMITS.windowMs || now < this.windowStart) {
      this.windowStart = now;
      this.accepted = 0;
      this.dropped = 0;
      this.rejected = 0;
      this.beats = 0;
    }
    // Heartbeats have a small budget of their own, so a chatty component cannot make the
    // watchdog think it has stopped.
    const beat = typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'heartbeat' && this.beats < BRIDGE_LIMITS.heartbeatsPerWindow;
    if (beat) this.beats++;
    if (!beat && this.accepted >= BRIDGE_LIMITS.messagesPerWindow) {
      this.dropped++;
      if (this.dropped === 1) this.options.onRejected?.('rate limit exceeded; messages are dropped');
      if (this.dropped >= BRIDGE_LIMITS.floodDrops) this.close('flood');
      return;
    }
    // Rate limit first: parsing a hostile message is the cost we are limiting.
    if (!beat) this.accepted++;
    const parsed = parseFrameMessage(data);
    if (!parsed.ok) {
      this.options.onRejected?.(parsed.error);
      if (++this.rejected >= BRIDGE_LIMITS.maxRejectsPerWindow) this.close('malformed');
      return;
    }
    try {
      this.options.onMessage(parsed.value);
    } catch (error) {
      this.options.onRejected?.(`handler failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
