import { TOKEN_KEY, isSafeHref, type RichDoc, type RichMark, type RichNode, type Theme } from '../core/model';

/**
 * A node of the HTML a rich text document turns into. The renderer draws these with a fixed set of
 * element templates, so nothing in a document can introduce a tag, an attribute or a style the
 * list below does not name. It needs no ProseMirror: the editor chunk stays out of the renderer.
 */
export interface ViewNode {
  tag: 'text' | 'p' | 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'li' | 'strong' | 'em' | 'u' | 'code' | 'a' | 'span' | 'br';
  /** Text of a `text` node. */
  text?: string;
  /** Target of an `a`, already checked to be a web or mail address. */
  href?: string;
  /** Declarations of a `span` (theme colour and size), made of `var()` references only. */
  style?: Record<string, string>;
  children?: ViewNode[];
}

const HEADINGS = { 1: 'h1', 2: 'h2', 3: 'h3' } as const;
const hasOwn = (map: object, key: string): boolean => Object.prototype.hasOwnProperty.call(map, key);

/** CSS shared by the rendered text and the in-place editor (a `.rich` root), so both look the same. */
export const RICH_TEXT_CSS = `
  .rich {
    line-height: 1.2;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .rich p, .rich h1, .rich h2, .rich h3, .rich ul, .rich ol { margin: 0; font: inherit; }
  .rich h1 { font-size: 1.25em; }
  .rich h2 { font-size: 1em; }
  .rich h3 { font-size: 0.9em; }
  .rich ul, .rich ol { padding-inline-start: 1.2em; }
  .rich li { margin: 0; }
  .rich code { font-family: var(--deck-font-mono, monospace); font-size: 0.9em; }
  .rich a { color: var(--deck-color-accent, currentColor); text-decoration: underline; }
`;

/** The view of a document's blocks, with colours and sizes resolved against the theme. */
export function richToView(doc: RichDoc, theme: Theme): ViewNode[] {
  const blocks = Array.isArray(doc?.content) ? doc.content : [];
  return blocks.flatMap((node) => block(node, theme));
}

function block(node: RichNode, theme: Theme): ViewNode[] {
  const children = Array.isArray(node?.content) ? node.content : [];
  switch (node?.type) {
    case 'paragraph':
      return [{ tag: 'p', children: children.flatMap((c) => inline(c, theme)) }];
    case 'heading': {
      const tag = HEADINGS[node.attrs?.['level'] as 1 | 2 | 3] ?? 'h2';
      return [{ tag, children: children.flatMap((c) => inline(c, theme)) }];
    }
    case 'bullet_list':
    case 'ordered_list':
      return [{ tag: node.type === 'bullet_list' ? 'ul' : 'ol', children: children.flatMap((c) => block(c, theme)) }];
    case 'list_item':
      return [{ tag: 'li', children: children.flatMap((c) => block(c, theme)) }];
    default:
      return [];
  }
}

function inline(node: RichNode, theme: Theme): ViewNode[] {
  if (node?.type === 'hard_break') return [{ tag: 'br' }];
  if (node?.type !== 'text' || typeof node.text !== 'string' || node.text === '') return [];
  let view: ViewNode = { tag: 'text', text: node.text };
  const marks = Array.isArray(node.marks) ? node.marks : [];
  const find = (type: string): RichMark | undefined => marks.find((m) => m?.type === type);
  // Innermost first, so a link ends up outermost and `code` closest to the text.
  const wrap = (tag: ViewNode['tag'], extra: Partial<ViewNode> = {}): void => void (view = { tag, ...extra, children: [view] });
  if (find('code')) wrap('code');
  if (find('underline')) wrap('u');
  if (find('italic')) wrap('em');
  if (find('bold')) wrap('strong');
  const style = markStyle(find('color'), find('size'), theme);
  if (style) wrap('span', { style });
  const href = find('link')?.attrs?.['href'];
  if (isSafeHref(href)) wrap('a', { href });
  return [view];
}

function markStyle(color: RichMark | undefined, size: RichMark | undefined, theme: Theme): Record<string, string> | null {
  const style: Record<string, string> = {};
  const colorKey = color?.attrs?.['token'];
  if (typeof colorKey === 'string' && TOKEN_KEY.test(colorKey) && hasOwn(theme.colors, colorKey)) style['color'] = `var(--deck-color-${colorKey})`;
  const sizeKey = size?.attrs?.['token'];
  if (typeof sizeKey === 'string' && TOKEN_KEY.test(sizeKey) && hasOwn(theme.typeScale, sizeKey)) style['font-size'] = `var(--deck-type-${sizeKey})`;
  return Object.keys(style).length > 0 ? style : null;
}
