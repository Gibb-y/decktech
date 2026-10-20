import { NUDGE, NUDGE_LARGE, ROTATE_STEP, ROTATE_STEP_LARGE, type EditorActions } from './editor-actions';

/** What a shortcut can reach: the deck actions and the parts of the canvas that are view state. */
export interface ShortcutContext {
  actions: EditorActions;
  view: {
    zoomIn(): void;
    zoomOut(): void;
    fit(): void;
    actualSize(): void;
    /** Moves the stage by a screen offset. */
    pan(dx: number, dy: number): void;
    toggleInteract(): void;
    readonly hasSelection: boolean;
  };
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface Shortcut {
  /** `e.key` compared case-insensitively. */
  key: string | readonly string[];
  /** Ctrl (or Cmd). Default `false`. */
  ctrl?: boolean;
  /** `undefined` = shift is passed on to `run` and does not matter for matching. */
  shift?: boolean;
  alt?: boolean;
  /** Human-readable combination for the help text. */
  keys: string;
  description: string;
  /** Return `false` to leave the key to the browser (e.g. Tab at the end of the canvas). */
  run(ctx: ShortcutContext, shift: boolean): boolean | void;
}

const PAN_STEP = 40;

function arrow(key: string, dx: number, dy: number): Shortcut[] {
  const name = key.replace('Arrow', '').toLowerCase();
  return [
    {
      key,
      keys: `Arrow ${name}`,
      description: `Nudge ${name} 1 unit (Shift: 10); pan the slide when nothing is selected`,
      run: ({ actions, view }, shift) => {
        if (!view.hasSelection) return view.pan(-dx * PAN_STEP, -dy * PAN_STEP);
        const step = shift ? NUDGE_LARGE : NUDGE;
        actions.nudge(dx * step, dy * step);
      },
    },
    {
      key,
      ctrl: true,
      keys: `Ctrl+Arrow ${name}`,
      description: dx !== 0 ? `${dx > 0 ? 'Widen' : 'Narrow'} by 1 unit (Shift: 10)` : `${dy > 0 ? 'Heighten' : 'Shorten'} by 1 unit (Shift: 10)`,
      run: ({ actions }, shift) => {
        const step = shift ? NUDGE_LARGE : NUDGE;
        actions.resizeBy(dx * step, dy * step);
      },
    },
  ];
}

/**
 * The canvas keyboard map as data, so it can be checked, shown as help and extended in one place.
 * Rotation uses Alt+Left / Alt+Right, which is also how a rotate handle is reached without a pointer.
 */
export const CANVAS_SHORTCUTS: readonly Shortcut[] = [
  ...arrow('ArrowLeft', -1, 0),
  ...arrow('ArrowRight', 1, 0),
  ...arrow('ArrowUp', 0, -1),
  ...arrow('ArrowDown', 0, 1),
  {
    key: 'ArrowLeft',
    alt: true,
    keys: 'Alt+Arrow left',
    description: 'Rotate counter-clockwise 1° (Shift: 15°)',
    run: ({ actions }, shift) => actions.rotateBy(-(shift ? ROTATE_STEP_LARGE : ROTATE_STEP)),
  },
  {
    key: 'ArrowRight',
    alt: true,
    keys: 'Alt+Arrow right',
    description: 'Rotate clockwise 1° (Shift: 15°)',
    run: ({ actions }, shift) => actions.rotateBy(shift ? ROTATE_STEP_LARGE : ROTATE_STEP),
  },
  { key: 'Tab', shift: false, keys: 'Tab', description: 'Select the next element (past the last, Tab leaves the canvas)', run: ({ actions }) => actions.selectNext(1) },
  { key: 'Tab', shift: true, keys: 'Shift+Tab', description: 'Select the previous element', run: ({ actions }) => actions.selectNext(-1) },
  { key: ['Delete', 'Backspace'], keys: 'Delete', description: 'Delete the selection', run: ({ actions }) => actions.deleteSelection() },
  { key: 'a', ctrl: true, keys: 'Ctrl+A', description: 'Select all elements', run: ({ actions }) => actions.selectAll() },
  { key: 'Escape', keys: 'Escape', description: 'Clear the selection', run: ({ actions }) => actions.deselect() },
  { key: 'd', ctrl: true, shift: false, keys: 'Ctrl+D', description: 'Duplicate the selection', run: ({ actions }) => actions.duplicateSelection() },
  { key: 'c', ctrl: true, shift: false, keys: 'Ctrl+C', description: 'Copy the selection', run: ({ actions }) => actions.copy() },
  { key: 'v', ctrl: true, shift: false, keys: 'Ctrl+V', description: 'Paste', run: ({ actions }) => actions.paste() },
  { key: 'z', ctrl: true, shift: false, keys: 'Ctrl+Z', description: 'Undo', run: ({ actions }) => actions.undo() },
  { key: 'z', ctrl: true, shift: true, keys: 'Ctrl+Shift+Z', description: 'Redo', run: ({ actions }) => actions.redo() },
  { key: 'y', ctrl: true, keys: 'Ctrl+Y', description: 'Redo', run: ({ actions }) => actions.redo() },
  { key: '[', ctrl: false, keys: '[', description: 'Send backward one step', run: ({ actions }) => actions.reorder('backward') },
  { key: ']', ctrl: false, keys: ']', description: 'Bring forward one step', run: ({ actions }) => actions.reorder('forward') },
  { key: '[', ctrl: true, keys: 'Ctrl+[', description: 'Send to back', run: ({ actions }) => actions.reorder('back') },
  { key: ']', ctrl: true, keys: 'Ctrl+]', description: 'Bring to front', run: ({ actions }) => actions.reorder('front') },
  { key: ['+', '='], keys: '+', description: 'Zoom in', run: ({ view }) => view.zoomIn() },
  { key: ['-', '_'], keys: '-', description: 'Zoom out', run: ({ view }) => view.zoomOut() },
  { key: '0', ctrl: true, keys: 'Ctrl+0', description: 'Fit the slide in the window', run: ({ view }) => view.fit() },
  { key: '1', ctrl: true, keys: 'Ctrl+1', description: 'Zoom to 100%', run: ({ view }) => view.actualSize() },
  { key: 'Enter', keys: 'Enter', description: 'Toggle interact mode for the selected code component', run: ({ view }) => view.toggleInteract() },
];

/** The shortcut for a key press, or `undefined`. Modifiers must match exactly unless the entry leaves them open. */
export function findShortcut(event: KeyLike): Shortcut | undefined {
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  return CANVAS_SHORTCUTS.find((s) => {
    const keys = typeof s.key === 'string' ? [s.key] : s.key;
    return (
      keys.some((k) => k.toLowerCase() === key) &&
      (s.ctrl ?? false) === ctrl &&
      (s.alt ?? false) === event.altKey &&
      (s.shift === undefined || s.shift === event.shiftKey)
    );
  });
}
