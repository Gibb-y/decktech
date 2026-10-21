import { InjectionToken } from '@angular/core';
import { HostBridge, type BridgeCloseReason, type BridgePort } from './bridge';
import type { HostApi } from './host-api';
import { API_VERSION, isSupportedApiVersion, supportedApiVersions, type HostMessage } from './protocol';

export type SupervisorStatus = 'starting' | 'running' | 'unresponsive' | 'failed';

export interface SupervisorState {
  status: SupervisorStatus;
  /** Why the frame is `failed` or `unresponsive`. */
  reason?: string;
}

export interface ChannelPair {
  port1: BridgePort;
  port2: unknown;
}

/** Creates the channel for a frame; tests provide a fake, the app uses `MessageChannel`. */
export const SANDBOX_CHANNEL = new InjectionToken<() => ChannelPair>('Sandbox channel factory');

export interface SupervisorOptions {
  frame: HTMLIFrameElement;
  /** Builds the capabilities once the handshake succeeded; `send` talks to the frame. */
  createApi(send: (message: HostMessage, transfer?: Transferable[]) => void): HostApi;
  /** The `init` message for the frame, and the buffers it hands over. */
  createInit(): Promise<{ message: HostMessage; transfer: Transferable[] }>;
  onState(state: SupervisorState): void;
  onRejected?(reason: string): void;
  createChannel?: () => ChannelPair;
  /** The frame must say `ready` within this time (ms). */
  startTimeoutMs?: number;
  /** A running frame must send a heartbeat within this time (ms). */
  heartbeatTimeoutMs?: number;
}

/**
 * Lifecycle of one component frame (arc42 §5.3, §6.5): waits for the `ready` handshake, hands
 * over a dedicated `MessagePort`, sends `init`, and from then on watches the heartbeat. A frame
 * that does not start, speaks an API version the host does not support, navigates away, floods
 * the bridge or stops answering is reported through `onState`; the owner decides whether to
 * reload or replace it. Destroying the supervisor removes every listener and timer.
 */
export class SandboxSupervisor {
  private readonly view: Window;
  private bridge: HostBridge | null = null;
  private api: HostApi | null = null;
  private handshaken = false;
  private loads = 0;
  private done = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private status: SupervisorStatus = 'starting';

  constructor(private readonly options: SupervisorOptions) {
    const view = options.frame.ownerDocument.defaultView;
    if (!view) throw new Error('A frame needs a window to listen on');
    this.view = view;
    this.view.addEventListener('message', this.onWindowMessage);
    options.frame.addEventListener('load', this.onLoad);
    this.startTimer = setTimeout(() => this.fail('The component did not start'), options.startTimeoutMs ?? 5000);
  }

  get current(): SupervisorState {
    return { status: this.status };
  }

  /** Sends a message to the running frame; ignored before the handshake and after the end. */
  send(message: HostMessage, transfer: Transferable[] = []): void {
    this.bridge?.send(message, transfer);
  }

  destroy(): void {
    if (this.done) return;
    this.done = true;
    this.clearTimers();
    this.view.removeEventListener('message', this.onWindowMessage);
    this.options.frame.removeEventListener('load', this.onLoad);
    this.bridge?.close('closed');
    this.api?.destroy();
    this.bridge = null;
    this.api = null;
  }

  private readonly onLoad = (): void => {
    // The first load is our srcdoc. Another one means the document navigated itself away.
    if (++this.loads > 1) this.fail('The component navigated away');
  };

  private readonly onWindowMessage = (event: MessageEvent): void => {
    const { frame } = this.options;
    if (this.done || this.handshaken || event.source === null || event.source !== frame.contentWindow) return;
    // A sandboxed srcdoc frame has the opaque origin "null"; anything else is not our document.
    if (event.origin !== 'null') return;
    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null || (data as Record<string, unknown>)['type'] !== 'ready') return;
    const version = (data as Record<string, unknown>)['apiVersion'];
    this.handshaken = true;
    if (!isSupportedApiVersion(version)) {
      return this.fail(`The component needs API version ${String(version)}; this app supports ${supportedApiVersions().join(' and ')}`);
    }
    const channel = (this.options.createChannel ?? defaultChannel)();
    this.bridge = new HostBridge(channel.port1, {
      onMessage: (message) => {
        if (message.type === 'heartbeat') this.heartbeat();
        this.api?.handle(message);
      },
      onRejected: (reason) => this.options.onRejected?.(reason),
      onClosed: (reason) => this.onBridgeClosed(reason),
    });
    this.api = this.options.createApi((message, transfer) => this.bridge?.send(message, transfer));
    try {
      frame.contentWindow!.postMessage({ type: 'port', apiVersion: API_VERSION }, '*', [channel.port2 as Transferable]);
    } catch {
      return this.fail('The component could not be reached');
    }
    this.options.createInit().then(
      (init) => this.bridge?.send(init.message, init.transfer),
      () => this.fail('The component could not be prepared'),
    );
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.startTimer = null;
    this.setStatus('running');
    this.armHeartbeat();
  };

  private onBridgeClosed(reason: BridgeCloseReason): void {
    if (reason === 'closed') return;
    this.fail(reason === 'flood' ? 'The component sent too many messages' : 'The component sent invalid messages');
  }

  private heartbeat(): void {
    this.armHeartbeat();
    if (this.status === 'unresponsive') this.setStatus('running');
  }

  private armHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (!this.done) this.setStatus('unresponsive', 'The component stopped responding');
    }, this.options.heartbeatTimeoutMs ?? 5000);
  }

  /** Ends the conversation for good (the owner replaces the frame). */
  private fail(reason: string): void {
    if (this.done) return;
    this.setStatus('failed', reason);
    this.destroy();
  }

  private setStatus(status: SupervisorStatus, reason?: string): void {
    this.status = status;
    this.options.onState(reason ? { status, reason } : { status });
  }

  private clearTimers(): void {
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer);
    this.startTimer = null;
    this.heartbeatTimer = null;
  }
}

function defaultChannel(): ChannelPair {
  const channel = new MessageChannel();
  return { port1: channel.port1 as unknown as BridgePort, port2: channel.port2 };
}
