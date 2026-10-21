// Rich text content of a text element: a restricted ProseMirror JSON document (ADR-004,
// arc42 §8.4). This file is the single description of what is allowed. It has no dependency on
// ProseMirror, so the renderer and the validator never load the editor; the editor builds its
// schema from the same constants (and a test checks they agree).

/** A mark on a text node. `link` has an `href`; `color` and `size` name a theme token. */
export interface RichMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface RichNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichNode[];
  marks?: RichMark[];
  text?: string;
}

export interface RichDoc {
  type: 'doc';
  content: RichNode[];
}

export const RICH_BLOCKS = ['paragraph', 'heading', 'bullet_list', 'ordered_list'] as const;
export const RICH_LISTS = ['bullet_list', 'ordered_list'] as const;
export const RICH_MARKS = ['bold', 'italic', 'underline', 'code', 'link', 'color', 'size'] as const;
export type RichMarkType = (typeof RICH_MARKS)[number];
export const HEADING_LEVELS = [1, 2, 3] as const;

/** Limits that keep a hostile document from costing more than a normal one. */
export const RICH_LIMITS = { maxDepth: 8, maxNodes: 20_000, maxText: 200_000, maxHref: 2_048 } as const;

/** Token keys are used in CSS custom property names. */
export const TOKEN_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** Links are limited to web and mail addresses; nothing that can run script or reach local files. */
const SAFE_HREF = /^(https?:\/\/|mailto:)[^\s<>"'`\\\u0000-\u001f\u007f]+$/i;

export function isSafeHref(href: unknown): href is string {
  return typeof href === 'string' && href.length <= RICH_LIMITS.maxHref && SAFE_HREF.test(href);
}

export interface RichTokens {
  colors: ReadonlySet<string> | ReadonlyArray<string>;
  sizes: ReadonlySet<string> | ReadonlyArray<string>;
}

export interface RichProblem {
  path: string;
  message: string;
}

const has = (set: RichTokens['colors'], key: string): boolean => (set instanceof Set ? set.has(key) : (set as readonly string[]).includes(key));
const NODE_KEYS = ['type', 'attrs', 'content', 'marks', 'text'];
const MARK_KEYS = ['type', 'attrs'];

/** An empty document: one empty paragraph, which is also what ProseMirror starts from. */
export const emptyRichDoc = (): RichDoc => ({ type: 'doc', content: [{ type: 'paragraph' }] });

/**
 * Checks a value against the rich text grammar and returns every problem found (empty when valid).
 * Unknown nodes, marks, attributes and fields are rejected, so nothing unmodelled can ride along;
 * colour and size marks must name tokens of the theme (`tokens`).
 */
export function validateRichText(value: unknown, path: string, tokens: RichTokens): RichProblem[] {
  const problems: RichProblem[] = [];
  let nodes = 0;
  let textLength = 0;
  const fail = (p: string, message: string): void => void problems.push({ path: p, message });
  const record = (p: string, v: unknown, keys: readonly string[]): Record<string, unknown> | undefined => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return void fail(p, 'must be an object');
    for (const key of Object.keys(v)) if (!keys.includes(key)) fail(`${p}.${key}`, 'unknown field');
    return v as Record<string, unknown>;
  };
  const attrs = (p: string, r: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
    if (r['attrs'] === undefined) return {};
    return record(`${p}.attrs`, r['attrs'], keys) ?? {};
  };

  const mark = (p: string, value: unknown): string | undefined => {
    const m = record(p, value, MARK_KEYS);
    if (!m) return undefined;
    const type = m['type'];
    if (typeof type !== 'string' || !(RICH_MARKS as readonly string[]).includes(type)) return void fail(`${p}.type`, `must be one of: ${RICH_MARKS.join(', ')}`);
    switch (type as RichMarkType) {
      case 'link': {
        const a = attrs(p, m, ['href']);
        if (!isSafeHref(a['href'])) fail(`${p}.attrs.href`, 'must be an http(s) or mailto address');
        break;
      }
      case 'color':
      case 'size': {
        const a = attrs(p, m, ['token']);
        const token = a['token'];
        const known = type === 'color' ? tokens.colors : tokens.sizes;
        if (typeof token !== 'string' || !TOKEN_KEY.test(token)) fail(`${p}.attrs.token`, 'must be a token name');
        else if (!has(known, token)) fail(`${p}.attrs.token`, `references unknown theme ${type === 'color' ? 'colour' : 'size'} "${token}"`);
        break;
      }
      default:
        if (m['attrs'] !== undefined) fail(`${p}.attrs`, 'is not allowed on this mark');
    }
    return type;
  };

  const inline = (p: string, v: unknown): void => {
    const n = record(p, v, NODE_KEYS);
    if (!n) return;
    if (++nodes > RICH_LIMITS.maxNodes) return void fail(p, `document has more than ${RICH_LIMITS.maxNodes} nodes`);
    if (n['type'] === 'hard_break') {
      for (const key of ['attrs', 'content', 'marks', 'text']) if (n[key] !== undefined) fail(`${p}.${key}`, 'is not allowed on a line break');
      return;
    }
    if (n['type'] !== 'text') return void fail(`${p}.type`, 'must be text or hard_break here');
    if (typeof n['text'] !== 'string' || n['text'] === '') fail(`${p}.text`, 'must be a non-empty string');
    else if ((textLength += n['text'].length) > RICH_LIMITS.maxText) fail(`${p}.text`, `document has more than ${RICH_LIMITS.maxText} characters`);
    for (const key of ['attrs', 'content']) if (n[key] !== undefined) fail(`${p}.${key}`, 'is not allowed on text');
    if (n['marks'] !== undefined) {
      if (!Array.isArray(n['marks'])) return void fail(`${p}.marks`, 'must be an array');
      const seen = new Set<string>();
      n['marks'].forEach((m, i) => {
        const type = mark(`${p}.marks[${i}]`, m);
        if (type === undefined) return;
        if (seen.has(type)) fail(`${p}.marks[${i}]`, `mark "${type}" appears twice`);
        seen.add(type);
      });
    }
  };

  const children = (p: string, n: Record<string, unknown>, min: number): unknown[] | undefined => {
    if (n['content'] === undefined) return min === 0 ? [] : void fail(`${p}.content`, `needs at least ${min} child node(s)`);
    if (!Array.isArray(n['content'])) return void fail(`${p}.content`, 'must be an array');
    if (n['content'].length < min) fail(`${p}.content`, `needs at least ${min} child node(s)`);
    if (n['content'].length > RICH_LIMITS.maxNodes) return void fail(`${p}.content`, 'has too many child nodes');
    return n['content'];
  };

  const typeOf = (v: unknown): string | undefined =>
    typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string' ? (v as { type: string }).type : undefined;

  const block = (p: string, v: unknown, depth: number, allowed: readonly string[]): void => {
    const n = record(p, v, NODE_KEYS);
    if (!n) return;
    if (++nodes > RICH_LIMITS.maxNodes) return void fail(p, `document has more than ${RICH_LIMITS.maxNodes} nodes`);
    const type = n['type'];
    if (typeof type !== 'string' || !allowed.includes(type)) return void fail(`${p}.type`, `must be one of: ${allowed.join(', ')}`);
    for (const key of ['marks', 'text']) if (n[key] !== undefined) fail(`${p}.${key}`, `is not allowed on a ${type}`);
    switch (type) {
      case 'paragraph':
      case 'heading': {
        const a = attrs(p, n, type === 'heading' ? ['level'] : []);
        if (type === 'heading' && !(HEADING_LEVELS as readonly unknown[]).includes(a['level'])) fail(`${p}.attrs.level`, `must be one of: ${HEADING_LEVELS.join(', ')}`);
        children(p, n, 0)?.forEach((c, i) => inline(`${p}.content[${i}]`, c));
        return;
      }
      case 'bullet_list':
      case 'ordered_list': {
        if (n['attrs'] !== undefined) fail(`${p}.attrs`, 'is not allowed on a list');
        if (depth >= RICH_LIMITS.maxDepth) return void fail(p, `lists are nested deeper than ${RICH_LIMITS.maxDepth}`);
        children(p, n, 1)?.forEach((c, i) => block(`${p}.content[${i}]`, c, depth + 1, ['list_item']));
        return;
      }
      case 'list_item': {
        if (n['attrs'] !== undefined) fail(`${p}.attrs`, 'is not allowed on a list item');
        const items = children(p, n, 1);
        items?.forEach((c, i) => {
          // A list item starts with its paragraph; nested lists may follow.
          if (i === 0 && typeOf(c) !== 'paragraph') fail(`${p}.content[0].type`, 'must be paragraph');
          block(`${p}.content[${i}]`, c, depth, i === 0 ? ['paragraph'] : RICH_LISTS);
        });
      }
    }
  };

  const doc = record(path, value, ['type', 'content']);
  if (!doc) return problems;
  if (doc['type'] !== 'doc') fail(`${path}.type`, 'must be "doc"');
  children(path, doc, 1)?.forEach((c, i) => block(`${path}.content[${i}]`, c, 0, RICH_BLOCKS));
  return problems;
}

// ------------------------------------------------------------------ plain text

/** Plain text as written in the Text field: paragraphs, and `- ` / `* ` / `• ` lines as a bullet list. */
export type TextBlock = { kind: 'paragraph'; text: string } | { kind: 'list'; items: string[] };

const BULLET = /^\s*[-*•]\s+(.*)$/;

/**
 * Splits plain element text into paragraphs and bullet lists. Each non-empty line is a paragraph;
 * consecutive lines starting with `-`, `*` or `•` form a list. This is how text elements without
 * `rich` content are read, and what rich editing starts from.
 */
export function parsePlainText(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim() === '') continue;
    const bullet = BULLET.exec(line);
    const last = blocks[blocks.length - 1];
    if (bullet) {
      if (bullet[1].trim() === '') continue;
      if (last?.kind === 'list') last.items.push(bullet[1]);
      else blocks.push({ kind: 'list', items: [bullet[1]] });
    } else {
      blocks.push({ kind: 'paragraph', text: line.trim() });
    }
  }
  return blocks;
}

const paragraph = (text: string): RichNode => (text === '' ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text }] });

/**
 * The rich document equivalent to plain text (what editing an element without `rich` starts from).
 * With `heading` the lines become heading paragraphs, matching how the renderer outputs title text.
 */
export function plainToRich(text: string, heading = false): RichDoc {
  const content = parsePlainText(text).flatMap<RichNode>((block) => {
    if (block.kind === 'list') {
      return [{ type: 'bullet_list', content: block.items.map((item) => ({ type: 'list_item', content: [paragraph(item.trim())] })) }];
    }
    return [heading ? { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: block.text }] } : paragraph(block.text)];
  });
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}

/**
 * The plain-text mirror of a rich document, stored in `TextEl.text` so slide titles, descriptions
 * and search keep working without parsing the document. Blocks are lines; list items get `- ` or
 * `1. ` and two spaces per nesting level.
 */
export function richPlainText(doc: RichDoc): string {
  const lines: string[] = [];
  const inline = (node: RichNode): string =>
    node.type === 'hard_break' ? ' ' : (node.text ?? '');
  const paragraphText = (node: RichNode): string => (node.content ?? []).map(inline).join('');
  const walk = (node: RichNode, indent: string, marker: string | null): void => {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        lines.push(`${indent}${marker ?? ''}${paragraphText(node)}`);
        return;
      case 'bullet_list':
      case 'ordered_list':
        (node.content ?? []).forEach((item, i) => walk(item, indent, node.type === 'bullet_list' ? '- ' : `${i + 1}. `));
        return;
      case 'list_item': {
        const [first, ...rest] = node.content ?? [];
        if (first) walk(first, indent, marker);
        rest.forEach((child) => walk(child, `${indent}  `, null));
      }
    }
  };
  doc.content.forEach((node) => walk(node, '', null));
  return lines.join('\n');
}

/** The colour and size tokens a document names, for the "still in use" checks of `SetTheme`. */
export function richTokenRefs(doc: RichDoc): { colors: Set<string>; sizes: Set<string> } {
  const refs = { colors: new Set<string>(), sizes: new Set<string>() };
  const visit = (node: RichNode): void => {
    for (const m of node.marks ?? []) {
      const token = m.attrs?.['token'];
      if (typeof token !== 'string') continue;
      if (m.type === 'color') refs.colors.add(token);
      else if (m.type === 'size') refs.sizes.add(token);
    }
    node.content?.forEach(visit);
  };
  doc.content.forEach(visit);
  return refs;
}
