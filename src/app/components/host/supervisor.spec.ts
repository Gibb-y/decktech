import type { BridgePort } from './bridge';
import { HostApi } from './host-api';
import { BRIDGE_LIMITS, type HostMessage } from './protocol';
import { SandboxSupervisor, type SupervisorState } from './supervisor';

class FakePort implements BridgePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  close(): void {
    this.closed = true;
  }
  receive(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

function setup(options: { createInit?: () => Promise<{ message: HostMessage; transfer: Transferable[] }> } = {}) {
  vi.useFakeTimers();
  const frame = document.createElement('iframe');
  const posted: { message: unknown; targetOrigin: unknown; transfer: unknown }[] = [];
  const contentWindow = { postMessage: (message: unknown, targetOrigin: unknown, transfer: unknown) => posted.push({ message, targetOrigin, transfer }) };
  Object.defineProperty(frame, 'contentWindow', { value: contentWindow });
  const port = new FakePort();
  const port2 = { port: 2 };
  const states: SupervisorState[] = [];
  const rejected: string[] = [];
  const handled: unknown[] = [];
  const init: HostMessage = { type: 'init', apiVersion: 1, props: {}, theme: {}, mode: 'present', size: { w: 1, h: 1 }, state: {}, libs: [], permissions: { network: false } };
  const supervisor = new SandboxSupervisor({
    frame,
    createChannel: () => ({ port1: port, port2 }),
    createApi: (send) => {
      const api = new HostApi({
        send,
        mode: 'present',
        state: {},
        saveState: () => undefined,
        allowedAssets: new Set(),
        readAsset: async () => null,
        networkOrigins: [],
        onHeartbeat: () => undefined,
        onSteps: (count) => handled.push(count),
        onNavigate: () => undefined,
        onLog: () => undefined,
        onError: () => undefined,
        onSnapshot: () => undefined,
        onLink: () => undefined,
      });
      return api;
    },
    createInit: options.createInit ?? (async () => ({ message: init, transfer: [] })),
    onState: (state) => states.push(state),
    onRejected: (reason) => rejected.push(reason),
    startTimeoutMs: 1000,
    heartbeatTimeoutMs: 500,
  });
  const ready = (data: unknown = { type: 'ready', apiVersion: 1 }, source: unknown = contentWindow, origin = 'null') => {
    const event = new MessageEvent('message', { data, origin });
    Object.defineProperty(event, 'source', { value: source });
    window.dispatchEvent(event);
  };
  return { frame, supervisor, port, port2, posted, states, rejected, handled, init, ready, contentWindow };
}

afterEach(() => vi.useRealTimers());

describe('SandboxSupervisor', () => {
  it('answers ready with a dedicated port and then init', async () => {
    const { ready, posted, port2, port, states, init, supervisor } = setup();
    ready();
    expect(posted).toHaveLength(1);
    expect(posted[0].message).toEqual({ type: 'port', apiVersion: 1 });
    expect(posted[0].targetOrigin).toBe('*');
    expect(posted[0].transfer).toEqual([port2]);
    await vi.advanceTimersByTimeAsync(0);
    expect(port.sent).toEqual([init]);
    expect(states).toEqual([{ status: 'running' }]);
    supervisor.destroy();
  });

  it('routes messages from the port to the capabilities', () => {
    const { ready, port, handled, supervisor } = setup();
    ready();
    port.receive({ type: 'steps', count: 3 });
    expect(handled).toEqual([3]);
    supervisor.destroy();
  });

  it('sends host messages to the frame after the handshake only', async () => {
    const { ready, port, supervisor, init } = setup();
    supervisor.send({ type: 'step', index: 9 });
    ready();
    await vi.advanceTimersByTimeAsync(0);
    supervisor.send({ type: 'step', index: 1 });
    expect(port.sent).toEqual([init, { type: 'step', index: 1 }]);
    supervisor.destroy();
  });

  it.each([[0], [2], [99], ['1'], [null], [undefined]])('refuses API version %s and gives no port', (version) => {
    const { ready, posted, states, port } = setup();
    ready({ type: 'ready', apiVersion: version });
    expect(posted).toEqual([]);
    expect(port.sent).toEqual([]);
    expect(states).toHaveLength(1);
    expect(states[0].status).toBe('failed');
    expect(states[0].reason).toMatch(/API version/);
  });

  it('ignores a ready from another window, another origin or with another shape', () => {
    const { ready, posted, states, supervisor } = setup();
    ready({ type: 'ready', apiVersion: 1 }, { other: true });
    ready({ type: 'ready', apiVersion: 1 }, null);
    ready({ type: 'ready', apiVersion: 1 }, window, 'https://evil.example');
    ready({ type: 'hello' });
    ready('ready');
    ready(null);
    expect(posted).toEqual([]);
    expect(states).toEqual([]);
    supervisor.destroy();
  });

  it('hands out a port only once', () => {
    const { ready, posted, supervisor } = setup();
    ready();
    ready();
    ready();
    expect(posted).toHaveLength(1);
    supervisor.destroy();
  });

  it('fails a frame that never says ready', () => {
    const { states, posted } = setup();
    vi.advanceTimersByTime(1000);
    expect(states).toEqual([{ status: 'failed', reason: 'The component did not start' }]);
    expect(posted).toEqual([]);
  });

  it('marks a silent frame unresponsive and running again once it beats', async () => {
    const { ready, port, states, supervisor } = setup();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    port.receive({ type: 'heartbeat' });
    await vi.advanceTimersByTimeAsync(499);
    expect(states.at(-1)?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(2);
    expect(states.at(-1)).toEqual({ status: 'unresponsive', reason: 'The component stopped responding' });
    port.receive({ type: 'heartbeat' });
    expect(states.at(-1)).toEqual({ status: 'running' });
    supervisor.destroy();
  });

  it('keeps a beating frame running', async () => {
    const { ready, port, states, supervisor } = setup();
    ready();
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(400);
      port.receive({ type: 'heartbeat' });
    }
    expect(states.every((s) => s.status === 'running')).toBe(true);
    supervisor.destroy();
  });

  it('fails a frame that navigates away', () => {
    const { frame, ready, states, port } = setup();
    ready();
    frame.dispatchEvent(new Event('load')); // the srcdoc
    expect(states.at(-1)?.status).toBe('running');
    frame.dispatchEvent(new Event('load')); // a navigation
    expect(states.at(-1)).toEqual({ status: 'failed', reason: 'The component navigated away' });
    expect(port.closed).toBe(true);
  });

  it('fails a frame that floods the bridge and one that sends garbage', () => {
    const flooding = setup();
    flooding.ready();
    for (let i = 0; i < BRIDGE_LIMITS.messagesPerWindow + BRIDGE_LIMITS.floodDrops; i++) flooding.port.receive({ type: 'steps', count: 1 });
    expect(flooding.states.at(-1)).toEqual({ status: 'failed', reason: 'The component sent too many messages' });
    expect(flooding.port.closed).toBe(true);
    vi.useRealTimers();

    const garbage = setup();
    garbage.ready();
    for (let i = 0; i < BRIDGE_LIMITS.maxRejectsPerWindow; i++) garbage.port.receive({ type: 'bogus' });
    expect(garbage.states.at(-1)).toEqual({ status: 'failed', reason: 'The component sent invalid messages' });
    expect(garbage.rejected).toHaveLength(BRIDGE_LIMITS.maxRejectsPerWindow);
  });

  it('fails when init cannot be prepared', async () => {
    const { ready, states } = setup({ createInit: () => Promise.reject(new Error('db')) });
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toEqual({ status: 'failed', reason: 'The component could not be prepared' });
  });

  it('fails when the frame cannot be reached', () => {
    const { ready, contentWindow, states } = setup();
    contentWindow.postMessage = () => {
      throw new Error('gone');
    };
    ready();
    expect(states.at(-1)).toEqual({ status: 'failed', reason: 'The component could not be reached' });
  });

  it('removes its listeners and timers when destroyed', () => {
    const { ready, supervisor, posted, states, port } = setup();
    supervisor.destroy();
    ready();
    vi.advanceTimersByTime(60_000);
    expect(posted).toEqual([]);
    expect(states).toEqual([]);
    expect(port.sent).toEqual([]);
    supervisor.destroy(); // idempotent
  });
});
