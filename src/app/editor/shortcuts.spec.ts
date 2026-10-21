import { CANVAS_SHORTCUTS, findShortcut, type KeyLike, type ShortcutContext } from './shortcuts';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

function context(hasSelection = true) {
  const actions = {
    nudge: vi.fn(),
    resizeBy: vi.fn(),
    rotateBy: vi.fn(),
    selectNext: vi.fn().mockReturnValue(true),
    deleteSelection: vi.fn(),
    selectAll: vi.fn(),
    deselect: vi.fn(),
    duplicateSelection: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    reorder: vi.fn(),
  };
  const view = { zoomIn: vi.fn(), zoomOut: vi.fn(), fit: vi.fn(), actualSize: vi.fn(), pan: vi.fn(), toggleInteract: vi.fn(), editText: vi.fn().mockReturnValue(false), hasSelection };
  return { actions, view, ctx: { actions, view } as unknown as ShortcutContext };
}

function press(event: KeyLike, ctx: ShortcutContext) {
  const shortcut = findShortcut(event);
  return { shortcut, result: shortcut?.run(ctx, event.shiftKey) };
}

describe('canvas shortcuts', () => {
  it.each([
    ['ArrowLeft', false, -1, 0],
    ['ArrowRight', false, 1, 0],
    ['ArrowUp', false, 0, -1],
    ['ArrowDown', false, 0, 1],
    ['ArrowRight', true, 10, 0],
    ['ArrowDown', true, 0, 10],
  ])('%s (shift %s) nudges the selection', (k, shiftKey, dx, dy) => {
    const { actions, ctx } = context();
    press(key(k, { shiftKey }), ctx);
    expect(actions.nudge).toHaveBeenCalledWith(dx, dy);
  });

  it('pans instead of nudging when nothing is selected', () => {
    const { actions, view, ctx } = context(false);
    press(key('ArrowLeft'), ctx);
    expect(actions.nudge).not.toHaveBeenCalled();
    expect(view.pan).toHaveBeenCalledWith(40, -0);
  });

  it('resizes with Ctrl+arrows and rotates with Alt+arrows', () => {
    const { actions, ctx } = context();
    press(key('ArrowRight', { ctrlKey: true }), ctx);
    expect(actions.resizeBy).toHaveBeenLastCalledWith(1, 0);
    press(key('ArrowUp', { ctrlKey: true, shiftKey: true }), ctx);
    expect(actions.resizeBy).toHaveBeenLastCalledWith(0, -10);
    press(key('ArrowRight', { altKey: true }), ctx);
    expect(actions.rotateBy).toHaveBeenLastCalledWith(1);
    press(key('ArrowLeft', { altKey: true, shiftKey: true }), ctx);
    expect(actions.rotateBy).toHaveBeenLastCalledWith(-15);
    expect(actions.nudge).not.toHaveBeenCalled();
  });

  it('Tab and Shift+Tab cycle, and report false at the ends so the browser may move focus out', () => {
    const { actions, ctx } = context();
    press(key('Tab'), ctx);
    expect(actions.selectNext).toHaveBeenLastCalledWith(1);
    press(key('Tab', { shiftKey: true }), ctx);
    expect(actions.selectNext).toHaveBeenLastCalledWith(-1);
    actions.selectNext.mockReturnValue(false);
    expect(press(key('Tab'), ctx).result).toBe(false);
  });

  it.each([
    [key('Delete'), 'deleteSelection'],
    [key('Backspace'), 'deleteSelection'],
    [key('a', { ctrlKey: true }), 'selectAll'],
    [key('A', { metaKey: true }), 'selectAll'],
    [key('Escape'), 'deselect'],
    [key('d', { ctrlKey: true }), 'duplicateSelection'],
    [key('c', { ctrlKey: true }), 'copy'],
    [key('v', { ctrlKey: true }), 'paste'],
    [key('z', { ctrlKey: true }), 'undo'],
    [key('Z', { ctrlKey: true, shiftKey: true }), 'redo'],
    [key('y', { ctrlKey: true }), 'redo'],
  ])('%j calls %s', (event, method) => {
    const { actions, ctx } = context();
    press(event, ctx);
    expect(actions[method as keyof typeof actions]).toHaveBeenCalledTimes(1);
  });

  it.each([
    [key('['), 'backward'],
    [key(']'), 'forward'],
    [key('[', { ctrlKey: true }), 'back'],
    [key(']', { ctrlKey: true }), 'front'],
  ])('%j reorders by %s', (event, move) => {
    const { actions, ctx } = context();
    press(event, ctx);
    expect(actions.reorder).toHaveBeenCalledWith(move);
  });

  it('zooms and fits', () => {
    const { view, ctx } = context();
    press(key('+', { shiftKey: true }), ctx);
    press(key('='), ctx);
    expect(view.zoomIn).toHaveBeenCalledTimes(2);
    press(key('-'), ctx);
    expect(view.zoomOut).toHaveBeenCalledTimes(1);
    press(key('0', { ctrlKey: true }), ctx);
    expect(view.fit).toHaveBeenCalled();
    press(key('1', { ctrlKey: true }), ctx);
    expect(view.actualSize).toHaveBeenCalled();
    press(key('Enter'), ctx);
    expect(view.toggleInteract).toHaveBeenCalled();
  });

  it('does not match unrelated keys or the wrong modifiers', () => {
    expect(findShortcut(key('q'))).toBeUndefined();
    expect(findShortcut(key('d'))).toBeUndefined(); // plain "d" is just typing
    expect(findShortcut(key('c', { ctrlKey: true, shiftKey: true }))).toBeUndefined();
    expect(findShortcut(key('ArrowLeft', { ctrlKey: true, altKey: true }))).toBeUndefined();
  });

  it('has a key label and description for every entry, and no two entries with the same combination', () => {
    for (const s of CANVAS_SHORTCUTS) {
      expect(s.keys).not.toBe('');
      expect(s.description).not.toBe('');
    }
    const combos = CANVAS_SHORTCUTS.map((s) => `${[s.key].flat().join('|')}/${s.ctrl ?? false}/${s.alt ?? false}/${s.shift}`);
    expect(new Set(combos).size).toBe(combos.length);
  });
});
