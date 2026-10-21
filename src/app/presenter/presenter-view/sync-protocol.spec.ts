import { SYNC_VERSION, parseSyncMessage, syncChannelName } from './sync-protocol';

const v = SYNC_VERSION;
const timer = { running: true, elapsedMs: 1500 };
const state = { v, type: 'state', slide: 1, step: 2, steps: 3, slides: 4, timer };

describe('parseSyncMessage', () => {
  it.each([
    [{ v, type: 'hello' }],
    [{ v, type: 'timer', action: 'start' }],
    [{ v, type: 'timer', action: 'pause' }],
    [{ v, type: 'timer', action: 'reset' }],
    [{ v, type: 'command', action: 'next' }],
    [{ v, type: 'command', action: 'prev' }],
    [{ v, type: 'command', action: 'goTo', slide: 3, step: 1 }],
    [state],
    [{ ...state, slide: 0, step: 0, steps: 0, slides: 0 }],
  ])('accepts %j unchanged', (message) => {
    expect(parseSyncMessage(message)).toEqual(message);
  });

  it('gives goTo step 0 when it has none', () => {
    expect(parseSyncMessage({ v, type: 'command', action: 'goTo', slide: 2 })).toEqual({ v, type: 'command', action: 'goTo', slide: 2, step: 0 });
  });

  it.each([
    ['null', null],
    ['a string', 'state'],
    ['a number', 7],
    ['an array', [state]],
    ['an empty object', {}],
    ['no version', { type: 'hello' }],
    ['another version', { v: 2, type: 'hello' }],
    ['a string version', { v: '1', type: 'hello' }],
    ['no type', { v }],
    ['an unknown type', { v, type: 'reboot' }],
    ['a non-string type', { v, type: ['hello'] }],
    ['an unknown timer action', { v, type: 'timer', action: 'stop' }],
    ['a timer without action', { v, type: 'timer' }],
    ['an unknown command', { v, type: 'command', action: 'last' }],
    ['goTo without slide', { v, type: 'command', action: 'goTo' }],
    ['goTo with a fractional slide', { v, type: 'command', action: 'goTo', slide: 1.5 }],
    ['goTo with a negative slide', { v, type: 'command', action: 'goTo', slide: -1 }],
    ['goTo with NaN', { v, type: 'command', action: 'goTo', slide: Number.NaN }],
    ['goTo with Infinity as step', { v, type: 'command', action: 'goTo', slide: 0, step: Number.POSITIVE_INFINITY }],
    ['goTo with a string slide', { v, type: 'command', action: 'goTo', slide: '2' }],
    ['goTo far out of range', { v, type: 'command', action: 'goTo', slide: 1e9 }],
    ['state without timer', { ...state, timer: undefined }],
    ['state with a null timer', { ...state, timer: null }],
    ['state with a running flag that is not a boolean', { ...state, timer: { running: 1, elapsedMs: 0 } }],
    ['state with negative elapsed time', { ...state, timer: { running: false, elapsedMs: -1 } }],
    ['state with NaN elapsed time', { ...state, timer: { running: false, elapsedMs: Number.NaN } }],
    ['state with Infinity elapsed time', { ...state, timer: { running: false, elapsedMs: Number.POSITIVE_INFINITY } }],
    ['state with absurd elapsed time', { ...state, timer: { running: false, elapsedMs: 1e15 } }],
    ['state with a fractional slide', { ...state, slide: 0.5 }],
    ['state with a negative step', { ...state, step: -1 }],
    ['state with a missing field', { v, type: 'state', slide: 0, step: 0, steps: 0, timer }],
    ['state with a slide beyond the deck', { ...state, slide: 4 }],
    ['state with a step beyond the slide', { ...state, step: 4 }],
    ['state with a slide in an empty deck', { ...state, slide: 1, slides: 0 }],
  ])('rejects %s', (_name, message) => {
    expect(parseSyncMessage(message)).toBeNull();
  });

  it('keeps only the known fields, so nothing smuggled in travels on', () => {
    const hostile = JSON.parse('{"v":1,"type":"command","action":"next","__proto__":{"polluted":true},"extra":"x"}');
    const parsed = parseSyncMessage(hostile);
    expect(parsed).toEqual({ v, type: 'command', action: 'next' });
    expect(Object.keys(parsed as object)).toEqual(['v', 'type', 'action']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('does not read inherited properties', () => {
    const inherited = Object.create({ v, type: 'hello' });
    expect(parseSyncMessage(inherited)).toBeNull();
  });

  it('copies the timer instead of aliasing the received object', () => {
    const parsed = parseSyncMessage(state);
    expect(parsed).not.toBeNull();
    if (parsed?.type === 'state') expect(parsed.timer).not.toBe(timer);
  });
});

describe('syncChannelName', () => {
  it('is per deck', () => {
    expect(syncChannelName('a')).not.toBe(syncChannelName('b'));
  });
});
