import { TestBed } from '@angular/core/testing';
import { CANVAS_SHORTCUTS, canvasShortcutId } from './shortcuts';
import { ShortcutConflictError, ShortcutRegistry, bindingsOverlap, matchesBinding, type KeyBinding, type KeyLike, type ShortcutDef } from './shortcut-registry';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

const def = (id: string, overrides: Partial<ShortcutDef> = {}): ShortcutDef => ({
  id,
  scope: 'canvas',
  key: 'q',
  keys: 'Q',
  description: id,
  run: () => undefined,
  ...overrides,
});

describe('key bindings', () => {
  it('match case-insensitively with exact modifiers', () => {
    expect(matchesBinding({ key: 'd', ctrl: true }, key('D', { ctrlKey: true }))).toBe(true);
    expect(matchesBinding({ key: 'd', ctrl: true }, key('d', { metaKey: true }))).toBe(true); // Cmd counts as Ctrl
    expect(matchesBinding({ key: 'd', ctrl: true }, key('d'))).toBe(false);
    expect(matchesBinding({ key: 'd' }, key('d', { ctrlKey: true }))).toBe(false);
    expect(matchesBinding({ key: 'a', alt: true }, key('a'))).toBe(false);
  });

  it('leave shift open only when the binding does', () => {
    expect(matchesBinding({ key: 'x' }, key('x', { shiftKey: true }))).toBe(true);
    expect(matchesBinding({ key: 'x', shift: false }, key('x', { shiftKey: true }))).toBe(false);
    expect(matchesBinding({ key: 'x', shift: true }, key('x'))).toBe(false);
  });

  it('accept any of several keys', () => {
    expect(matchesBinding({ key: ['Delete', 'Backspace'] }, key('Backspace'))).toBe(true);
  });

  it.each<[KeyBinding, KeyBinding, boolean]>([
    [{ key: 'a' }, { key: 'a' }, true],
    [{ key: 'a' }, { key: 'A' }, true],
    [{ key: 'a' }, { key: 'b' }, false],
    [{ key: ['a', 'b'] }, { key: 'b' }, true],
    [{ key: 'a', ctrl: true }, { key: 'a' }, false],
    [{ key: 'a', alt: true }, { key: 'a' }, false],
    [{ key: 'a' }, { key: 'a', shift: true }, true], // shift left open overlaps either
    [{ key: 'a', shift: false }, { key: 'a', shift: true }, false],
    [{ key: 'a', shift: false }, { key: 'a', shift: false }, true],
  ])('%j and %j overlap: %s', (a, b, expected) => {
    expect(bindingsOverlap(a, b)).toBe(expected);
    expect(bindingsOverlap(b, a)).toBe(expected);
  });
});

describe('ShortcutRegistry', () => {
  let registry: ShortcutRegistry;
  beforeEach(() => {
    TestBed.configureTestingModule({});
    registry = TestBed.inject(ShortcutRegistry);
  });

  it('rejects a repeated id', () => {
    registry.register(def('a'));
    expect(() => registry.register(def('a', { key: 'w' }))).toThrow(ShortcutConflictError);
    expect(() => registry.register(def('a', { key: 'w' }))).toThrow(/already registered/);
  });

  it('rejects the same combination in the same scope and names both shortcuts', () => {
    registry.register(def('first', { keys: 'Q' }));
    expect(() => registry.register(def('second', { keys: 'Q' }))).toThrow(/"Q" \(second\) conflicts with "Q" \(first\)/);
    expect(registry.shortcuts()).toHaveLength(1);
  });

  it('rejects a combination whose shift is open against one that uses shift', () => {
    registry.register(def('open', { key: 'x' }));
    expect(() => registry.register(def('shifted', { key: 'x', shift: true }))).toThrow(ShortcutConflictError);
  });

  it('allows the same combination in two different scopes, but not against a global one', () => {
    registry.register(def('canvas-q', { scope: 'canvas' }));
    registry.register(def('sorter-q', { scope: 'sorter' }));
    expect(() => registry.register(def('global-q', { scope: 'global' }))).toThrow(ShortcutConflictError);
    registry.register(def('global-w', { scope: 'global', key: 'w' }));
    expect(() => registry.register(def('canvas-w', { scope: 'canvas', key: 'w' }))).toThrow(ShortcutConflictError);
  });

  it('allows different modifiers on the same key', () => {
    registry.register(def('plain'));
    registry.register(def('ctrl', { ctrl: true }));
    registry.register(def('alt', { alt: true }));
    expect(registry.shortcuts()).toHaveLength(3);
  });

  it('frees the combination again when a shortcut is unregistered', () => {
    const remove = registry.register(def('a'));
    remove();
    expect(registry.shortcuts()).toEqual([]);
    expect(() => registry.register(def('b'))).not.toThrow();
  });

  it('finds a shortcut in its own scope first, then in global', () => {
    const canvas = def('c', { key: 'c', scope: 'canvas' });
    const global = def('g', { key: 'g', scope: 'global' });
    registry.register(canvas);
    registry.register(global);
    expect(registry.find(key('c'), 'canvas')).toBe(canvas);
    expect(registry.find(key('c'), 'sorter')).toBeUndefined();
    expect(registry.find(key('g'), 'sorter')).toBe(global);
  });

  it('handle runs the shortcut and prevents the default, unless the handler declines', () => {
    const run = vi.fn();
    const decline = vi.fn().mockReturnValue(false);
    registry.register(def('run', { key: 'r', run }));
    registry.register(def('decline', { key: 'd', run: decline }));
    const press = (k: string) => {
      const event = new KeyboardEvent('keydown', { key: k, cancelable: true });
      return { handled: registry.handle(event, 'canvas'), prevented: event.defaultPrevented };
    };
    expect(press('r')).toEqual({ handled: true, prevented: true });
    expect(press('d')).toEqual({ handled: false, prevented: false });
    expect(press('z')).toEqual({ handled: false, prevented: false });
    expect(run).toHaveBeenCalledOnce();
    expect(decline).toHaveBeenCalledOnce();
  });

  it('lists only the scopes that have shortcuts, in a fixed order', () => {
    registry.register(def('s', { scope: 'sorter' }));
    registry.register(def('g', { scope: 'global', key: 'g' }));
    expect(registry.scopes()).toEqual(['global', 'sorter']);
  });
});

describe('the built-in shortcut tables', () => {
  it('canvas shortcuts have unique ids and do not conflict with each other', () => {
    TestBed.configureTestingModule({});
    const registry = TestBed.inject(ShortcutRegistry);
    const ids = CANVAS_SHORTCUTS.map(canvasShortcutId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of CANVAS_SHORTCUTS) {
      expect(() => registry.register({ ...s, id: canvasShortcutId(s), scope: 'canvas', run: () => undefined })).not.toThrow();
    }
  });
});
