import { Schema, type MarkSpec, type NodeSpec } from 'prosemirror-model';
import { HEADING_LEVELS, TOKEN_KEY, isSafeHref } from '../../core/model';

/** Level for a pasted `<h4>`..`<h6>`: the lowest we have. */
const deepest = HEADING_LEVELS[HEADING_LEVELS.length - 1];

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },
  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },
  heading: {
    attrs: { level: { default: 2, validate: (v: unknown) => (HEADING_LEVELS as readonly unknown[]).includes(v) } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [
      ...HEADING_LEVELS.map((level) => ({ tag: `h${level}`, attrs: { level } })),
      ...[4, 5, 6].map((n) => ({ tag: `h${n}`, attrs: { level: deepest } })),
    ],
    toDOM: (node) => [`h${node.attrs['level'] as number}`, 0],
  },
  bullet_list: { content: 'list_item+', group: 'block', parseDOM: [{ tag: 'ul' }], toDOM: () => ['ul', 0] },
  ordered_list: { content: 'list_item+', group: 'block', parseDOM: [{ tag: 'ol' }], toDOM: () => ['ol', 0] },
  list_item: { content: 'paragraph (bullet_list | ordered_list)*', defining: true, parseDOM: [{ tag: 'li' }], toDOM: () => ['li', 0] },
  text: { group: 'inline' },
  hard_break: { inline: true, group: 'inline', selectable: false, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
};

const token = (value: unknown): string => (typeof value === 'string' && TOKEN_KEY.test(value) ? value : '');

const marks: Record<string, MarkSpec> = {
  bold: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b', getAttrs: (dom) => (dom.style.fontWeight !== 'normal' ? null : false) }],
    toDOM: () => ['strong', 0],
  },
  italic: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: () => ['em', 0] },
  underline: { parseDOM: [{ tag: 'u' }], toDOM: () => ['u', 0] },
  code: { parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
  link: {
    attrs: { href: {} },
    inclusive: false,
    // A link whose address is not a web or mail address is dropped; its text stays.
    parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => (isSafeHref(dom.getAttribute('href')) ? { href: dom.getAttribute('href') } : false) }],
    toDOM: (mark) => ['a', { href: isSafeHref(mark.attrs['href']) ? (mark.attrs['href'] as string) : '', rel: 'noopener noreferrer' }, 0],
  },
  // Colours and sizes are theme tokens, so they are never read from pasted HTML.
  color: {
    attrs: { token: {} },
    toDOM: (mark) => ['span', { style: `color: var(--deck-color-${token(mark.attrs['token'])})` }, 0],
  },
  size: {
    attrs: { token: {} },
    toDOM: (mark) => ['span', { style: `font-size: var(--deck-type-${token(mark.attrs['token'])})` }, 0],
  },
};

/** The editor's schema, the ProseMirror counterpart of the grammar in `core/model/rich-text.ts`. */
export const richSchema = new Schema({ nodes, marks });
