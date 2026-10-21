import { HostBridge, type BridgeCloseReason, type BridgePort } from './bridge';
import { BRIDGE_LIMITS, type FrameMessage } from './protocol';

class FakePort implements BridgePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  sent: { message: unknown; transfer?: Transferable[] }[] = [];
  closed = false;
  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.sent.push({ message, transfer });
  }
  close(): void {
    this.closed = true;
  }
  /** What the frame side would deliver. */
  receive(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

function setup() {
  const port = new FakePort();
  const received: FrameMessage[] = [];
  const rejected: string[] = [];
  const closed: BridgeCloseReason[] = [];
  let now = 0;
  const bridge = new HostBridge(port, {
    now: () => now,
    onMessage: (m) => received.push(m),
    onRejected: (r) => rejected.push(r),
    onClosed: (r) => closed.push(r),
  });
  return { port, bridge, received, rejected, closed, advance: (ms: number) => (now += ms) };
}

describe('HostBridge', () => {
  it('delivers whitelisted messages', () => {
    const { port, received } = setup();
    port.receive({ type: 'steps', count: 3 });
    port.receive({ type: 'log', level: 'log', args: ['hi'] });
    expect(received).toEqual([
      { type: 'steps', count: 3 },
      { type: 'log', level: 'log', args: ['hi'] },
    ]);
  });

  it.each([
    ['an unknown type', { type: 'eval', code: 'x' }, /unknown message type/],
    ['an inherited name', { type: 'hasOwnProperty' }, /unknown message type/],
    ['a malformed payload', { type: 'steps', count: 'many' }, /steps\.count/],
    ['a non-object', 'steps', /object/],
    ['an oversize payload', { type: 'state-set', key: 'k', value: 'x'.repeat(BRIDGE_LIMITS.maxMessageBytes) }, /64 KiB/],
  ])('drops %s without calling the handler', (_name, data, reason) => {
    const { port, received, rejected } = setup();
    port.receive(data);
    expect(received).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatch(reason);
  });

  it('keeps working after a rejected message', () => {
    const { port, received } = setup();
    port.receive({ type: 'nope' });
    port.receive({ type: 'heartbeat' });
    expect(received).toEqual([{ type: 'heartbeat' }]);
  });

  it('drops messages over the rate limit and reports it once', () => {
    const { port, received, rejected, closed } = setup();
    for (let i = 0; i < BRIDGE_LIMITS.messagesPerWindow + 50; i++) port.receive({ type: 'heartbeat' });
    expect(received).toHaveLength(BRIDGE_LIMITS.messagesPerWindow);
    expect(rejected.filter((r) => /rate limit/.test(r))).toHaveLength(1);
    expect(closed).toEqual([]);
  });

  it('accepts messages again in the next window', () => {
    const { port, received, advance } = setup();
    for (let i = 0; i < BRIDGE_LIMITS.messagesPerWindow + 10; i++) port.receive({ type: 'heartbeat' });
    advance(BRIDGE_LIMITS.windowMs);
    port.receive({ type: 'heartbeat' });
    expect(received).toHaveLength(BRIDGE_LIMITS.messagesPerWindow + 1);
  });

  it('cuts off a flooding frame', () => {
    const { port, bridge, received, closed } = setup();
    for (let i = 0; i < BRIDGE_LIMITS.messagesPerWindow + BRIDGE_LIMITS.floodDrops + 5; i++) port.receive({ type: 'heartbeat' });
    expect(closed).toEqual(['flood']);
    expect(bridge.isClosed).toBe(true);
    expect(port.closed).toBe(true);
    expect(port.onmessage).toBeNull();
    expect(received).toHaveLength(BRIDGE_LIMITS.messagesPerWindow);
  });

  it('cuts off a frame that keeps sending garbage', () => {
    const { port, closed, received } = setup();
    for (let i = 0; i < BRIDGE_LIMITS.maxRejectsPerWindow + 5; i++) port.receive({ type: 'garbage' });
    expect(closed).toEqual(['malformed']);
    port.receive({ type: 'heartbeat' });
    expect(received).toEqual([]);
  });

  it('does not count garbage in earlier windows against the frame', () => {
    const { port, closed, advance } = setup();
    for (let i = 0; i < BRIDGE_LIMITS.maxRejectsPerWindow - 1; i++) port.receive({ type: 'garbage' });
    advance(BRIDGE_LIMITS.windowMs);
    for (let i = 0; i < BRIDGE_LIMITS.maxRejectsPerWindow - 1; i++) port.receive({ type: 'garbage' });
    expect(closed).toEqual([]);
  });

  it('survives a handler that throws', () => {
    const port = new FakePort();
    const rejected: string[] = [];
    new HostBridge(port, {
      onMessage: () => {
        throw new Error('handler bug');
      },
      onRejected: (r) => rejected.push(r),
    });
    port.receive({ type: 'heartbeat' });
    expect(rejected).toEqual(['handler failed: handler bug']);
  });

  it('sends host messages with their transfer list until closed', () => {
    const { port, bridge } = setup();
    const buffer = new ArrayBuffer(4);
    bridge.send({ type: 'asset', id: 1, mime: 'x', data: buffer }, [buffer]);
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0].transfer).toEqual([buffer]);
    bridge.close();
    bridge.send({ type: 'step', index: 1 });
    expect(port.sent).toHaveLength(1);
  });

  it('does not throw when the port refuses a message', () => {
    const { port, bridge } = setup();
    port.postMessage = () => {
      throw new Error('detached');
    };
    expect(() => bridge.send({ type: 'step', index: 1 })).not.toThrow();
  });

  it('close is idempotent and reports once', () => {
    const { bridge, closed } = setup();
    bridge.close();
    bridge.close();
    expect(closed).toEqual(['closed']);
  });
});
