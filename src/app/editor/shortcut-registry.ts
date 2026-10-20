import { Service, computed, signal } from '@angular/core';

/** Where a shortcut is live. `global` shortcuts work anywhere in the editor and so may not share a key with any other scope. */
export type ShortcutScope = 'global' | 'canvas' | 'sorter';

export const SCOPE_LABELS: Record<ShortcutScope, string> = {
  global: 'Anywhere in the editor',
  canvas: 'Slide canvas',
  sorter: 'Slide sorter',
};

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** A key combination. Modifiers default to `false`; `shift: undefined` means "either" (the handler may read it). */
export interface KeyBinding {
  /** `e.key` compared case-insensitively. */
  key: string | readonly string[];
  /** Ctrl (or Cmd). */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ShortcutDef extends KeyBinding {
  /** Action id, unique in the registry, e.g. `global.insert-menu`. */
  id: string;
  scope: ShortcutScope;
  /** Human-readable combination for the help text. */
  keys: string;
  description: string;
  /** Return `false` to leave the key to the browser (e.g. Tab at the end of the canvas). */
  run(event: KeyLike): boolean | void;
}

export class ShortcutConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShortcutConflictError';
  }
}

const keysOf = (b: KeyBinding): string[] => (typeof b.key === 'string' ? [b.key] : [...b.key]).map((k) => k.toLowerCase());

/** Whether a key press triggers the binding. Modifiers must match exactly unless the binding leaves shift open. */
export function matchesBinding(binding: KeyBinding, event: KeyLike): boolean {
  const key = event.key.toLowerCase();
  return (
    keysOf(binding).includes(key) &&
    (binding.ctrl ?? false) === (event.ctrlKey || event.metaKey) &&
    (binding.alt ?? false) === event.altKey &&
    (binding.shift === undefined || binding.shift === event.shiftKey)
  );
}

/** Whether some key press could trigger both bindings. */
export function bindingsOverlap(a: KeyBinding, b: KeyBinding): boolean {
  const bKeys = new Set(keysOf(b));
  return (
    keysOf(a).some((k) => bKeys.has(k)) &&
    (a.ctrl ?? false) === (b.ctrl ?? false) &&
    (a.alt ?? false) === (b.alt ?? false) &&
    (a.shift === undefined || b.shift === undefined || a.shift === b.shift)
  );
}

const scopesShareKeys = (a: ShortcutScope, b: ShortcutScope): boolean => a === b || a === 'global' || b === 'global';

/**
 * The one place keyboard shortcuts are declared (action id → key combination → handler). Registering
 * a combination that another shortcut in an overlapping scope already uses throws, so a conflict is
 * found when the editor starts, not when a user presses the key. The help overlay lists `shortcuts()`.
 */
@Service()
export class ShortcutRegistry {
  private readonly entries = signal<readonly ShortcutDef[]>([]);

  readonly shortcuts = this.entries.asReadonly();
  /** Scopes that have at least one shortcut, in a stable order, for grouping the help. */
  readonly scopes = computed(() => (Object.keys(SCOPE_LABELS) as ShortcutScope[]).filter((s) => this.entries().some((e) => e.scope === s)));

  /** Adds a shortcut and returns the function that removes it again. */
  register(def: ShortcutDef): () => void {
    const entries = this.entries();
    if (entries.some((e) => e.id === def.id)) throw new ShortcutConflictError(`Shortcut id "${def.id}" is already registered`);
    const clash = entries.find((e) => scopesShareKeys(e.scope, def.scope) && bindingsOverlap(e, def));
    if (clash) throw new ShortcutConflictError(`"${def.keys}" (${def.id}) conflicts with "${clash.keys}" (${clash.id})`);
    this.entries.set([...entries, def]);
    return () => this.entries.update((all) => all.filter((e) => e !== def));
  }

  /** The shortcut a key press triggers in `scope` (its own scope first, then `global`). */
  find(event: KeyLike, scope: ShortcutScope): ShortcutDef | undefined {
    const live = this.entries().filter((e) => matchesBinding(e, event));
    return live.find((e) => e.scope === scope) ?? live.find((e) => e.scope === 'global');
  }

  /**
   * Runs the shortcut for a keyboard event. Returns `true` if one handled it, in which case the
   * browser default is prevented; a handler that returns `false` leaves the key alone.
   */
  handle(event: KeyboardEvent, scope: ShortcutScope): boolean {
    const shortcut = this.find(event, scope);
    if (!shortcut) return false;
    if (shortcut.run(event) === false) return false;
    event.preventDefault();
    return true;
  }
}
