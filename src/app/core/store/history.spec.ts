import { History } from './history';
import { diff } from './patch';

const entry = (before: unknown, after: unknown, time: number, coalesceKey = 'k') => ({
  entry: { name: 'T', forward: diff(before, after), inverse: diff(after, before), coalesceKey, time },
  snapshots: { before, after },
});

describe('History', () => {
  it('keeps a coalesced entry as small as the net change, however long the gesture', () => {
    const history = new History();
    const start = { list: Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, x: 0 })) };
    let current = start;
    for (let i = 1; i <= 1000; i++) {
      const next = { list: current.list.map((e, j) => (j === 3 ? { ...e, x: i } : e)) };
      const { entry: e, snapshots } = entry(current, next, i);
      history.record(e, snapshots);
      current = next;
    }
    const top = history.peekUndo()!;
    expect(top.forward).toEqual([{ op: 'replace', path: '/list/3/x', value: 1000 }]);
    expect(top.inverse).toEqual([{ op: 'replace', path: '/list/3/x', value: 0 }]);
    expect(history.undo()).toBe(top);
    expect(history.canUndo()).toBe(false);
  });

  it('peek does not move entries', () => {
    const history = new History();
    const { entry: e, snapshots } = entry({ a: 1 }, { a: 2 }, 0);
    history.record(e, snapshots);
    expect(history.peekUndo()).toBe(e);
    expect(history.canUndo()).toBe(true);
    expect(history.peekRedo()).toBeUndefined();
    history.undo();
    expect(history.peekRedo()).toBe(e);
    expect(history.canRedo()).toBe(true);
  });
});
