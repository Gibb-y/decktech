import type { KeyBinding } from '../shortcut-registry';
import type { TextEditing } from './text-editing';

export interface TextShortcut extends KeyBinding {
  /** Human-readable combination for the help text. */
  keys: string;
  description: string;
  run(editing: TextEditing): void;
}

/**
 * The keys that work while a text element is edited in place. ProseMirror's keymap handles them
 * (the keys must be pressed in the text, where the canvas shortcuts are switched off); the table
 * exists so the shortcut help lists them, the registry can refuse a clash and a test can keep
 * the two in step.
 */
export const TEXT_SHORTCUTS: readonly TextShortcut[] = [
  { key: 'b', ctrl: true, keys: 'Ctrl+B', description: 'Bold', run: (t) => t.run('bold') },
  { key: 'i', ctrl: true, keys: 'Ctrl+I', description: 'Italic', run: (t) => t.run('italic') },
  { key: 'u', ctrl: true, keys: 'Ctrl+U', description: 'Underline', run: (t) => t.run('underline') },
  { key: '`', ctrl: true, keys: 'Ctrl+`', description: 'Code', run: (t) => t.run('code') },
  { key: 'k', ctrl: true, keys: 'Ctrl+K', description: 'Set or change the link: moves to the link address field in the properties panel', run: (t) => t.requestLink() },
  { key: ']', ctrl: true, keys: 'Ctrl+]', description: 'Indent the list item', run: (t) => t.run('indent') },
  { key: '[', ctrl: true, keys: 'Ctrl+[', description: 'Outdent the list item', run: (t) => t.run('outdent') },
  { key: 'Enter', shift: true, keys: 'Shift+Enter', description: 'Line break inside a paragraph', run: () => undefined },
  { key: 'z', ctrl: true, shift: false, keys: 'Ctrl+Z', description: 'Undo typing (the text keeps its own history until you finish)', run: (t) => t.run('undo') },
  { key: 'z', ctrl: true, shift: true, keys: 'Ctrl+Shift+Z', description: 'Redo typing', run: (t) => t.run('redo') },
  { key: 'y', ctrl: true, keys: 'Ctrl+Y', description: 'Redo typing', run: (t) => t.run('redo') },
  { key: 'Escape', keys: 'Escape', description: 'Finish editing the text (it is saved as one undo step)', run: () => undefined },
];

const SYMBOL_NAMES: Record<string, string> = { '`': 'backtick', '[': 'bracket-left', ']': 'bracket-right' };

/** Registry id of a text shortcut, derived from its key combination (unique within the table). */
export const textShortcutId = (s: TextShortcut): string =>
  `text.${s.keys.split('+').map((part) => SYMBOL_NAMES[part] ?? part.toLowerCase()).join('-')}`;
