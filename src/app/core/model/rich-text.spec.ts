import { createDeck, createElement } from './factory';
import {
  emptyRichDoc,
  isSafeHref,
  parsePlainText,
  plainToRich,
  richPlainText,
  richTokenRefs,
  validateRichText,
  type RichDoc,
  type RichNode,
  type RichTokens,
} from './rich-text';
import { validateDeck } from './validate';

const tokens: RichTokens = { colors: ['text', 'accent'], sizes: ['title', 'body'] };
const problems = (value: unknown): string[] => validateRichText(value, 'rich', tokens).map((p) => `${p.path}: ${p.message}`);
const doc = (...content: unknown[]): unknown => ({ type: 'doc', content });
const para = (...content: unknown[]) => ({ type: 'paragraph', content }) as RichNode;
const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) }) as RichNode;

const RICH: RichDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Plan' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Bold ', marks: [{ type: 'bold' }, { type: 'color', attrs: { token: 'accent' } }] },
        { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.com/a?b=1' } }, { type: 'size', attrs: { token: 'title' } }] },
        { type: 'hard_break' },
        { type: 'text', text: 'code', marks: [{ type: 'code' }, { type: 'italic' }, { type: 'underline' }] },
      ],
    },
    {
      type: 'bullet_list',
      content: [
        { type: 'list_item', content: [para(text('one')), { type: 'ordered_list', content: [{ type: 'list_item', content: [para(text('nested'))] }] }] },
        { type: 'list_item', content: [para(text('two'))] },
      ],
    },
  ],
};

describe('validateRichText', () => {
  it('accepts every node and mark of the grammar', () => {
    expect(problems(RICH)).toEqual([]);
    expect(problems(emptyRichDoc())).toEqual([]);
  });

  it.each([
    ['a non-object', 'text', /must be an object/],
    ['null', null, /must be an object/],
    ['an array', [], /must be an object/],
    ['a wrong root type', { type: 'paragraph', content: [{ type: 'paragraph' }] }, /rich\.type: must be "doc"/],
    ['an empty document', { type: 'doc', content: [] }, /rich\.content: needs at least 1/],
    ['a missing content', { type: 'doc' }, /rich\.content: needs at least 1/],
    ['an unknown field on the root', { type: 'doc', content: [para()], html: '<b>x</b>' }, /rich\.html: unknown field/],
    ['an unknown node', doc({ type: 'script', content: [text('alert(1)')] }), /content\[0\]\.type: must be one of: paragraph, heading, bullet_list, ordered_list/],
    ['an image node', doc(para({ type: 'image', attrs: { src: 'x' } })), /must be text or hard_break here/],
    ['an unknown field on a node', doc({ type: 'paragraph', onclick: 'x' }), /content\[0\]\.onclick: unknown field/],
    ['an inherited-looking field', JSON.parse('{"type":"doc","content":[{"type":"paragraph"}],"__proto__":{"x":1}}'), /__proto__: unknown field/],
    ['an unknown mark', doc(para(text('x', [{ type: 'strike' }]))), /marks\[0\]\.type: must be one of/],
    ['attrs on a plain mark', doc(para(text('x', [{ type: 'bold', attrs: { style: 'x' } }]))), /attrs: is not allowed on this mark/],
    ['an unknown mark attribute', doc(para(text('x', [{ type: 'link', attrs: { href: 'https://a.b', target: '_top' } }]))), /attrs\.target: unknown field/],
    ['a repeated mark', doc(para(text('x', [{ type: 'bold' }, { type: 'bold' }]))), /mark "bold" appears twice/],
    ['marks that are not an array', doc(para({ type: 'text', text: 'x', marks: {} })), /marks: must be an array/],
    ['marks on a paragraph', doc({ type: 'paragraph', marks: [{ type: 'bold' }] }), /marks: is not allowed on a paragraph/],
    ['empty text', doc(para(text(''))), /text: must be a non-empty string/],
    ['text that is not a string', doc(para({ type: 'text', text: 5 })), /text: must be a non-empty string/],
    ['content on a text node', doc(para({ type: 'text', text: 'x', content: [] })), /content: is not allowed on text/],
    ['attrs on a line break', doc(para({ type: 'hard_break', text: 'x' })), /text: is not allowed on a line break/],
    ['a heading level out of range', doc({ type: 'heading', attrs: { level: 7 }, content: [text('x')] }), /level: must be one of: 1, 2, 3/],
    ['a heading without a level', doc({ type: 'heading', content: [text('x')] }), /level: must be one of/],
    ['a list without items', doc({ type: 'bullet_list', content: [] }), /needs at least 1/],
    ['a list item outside a list', doc({ type: 'list_item', content: [para()] }), /content\[0\]\.type: must be one of: paragraph, heading, bullet_list, ordered_list/],
    ['a paragraph directly in a list', doc({ type: 'bullet_list', content: [para()] }), /type: must be one of: list_item/],
    ['a list item that does not start with a paragraph', doc({ type: 'bullet_list', content: [{ type: 'list_item', content: [{ type: 'heading', attrs: { level: 1 } }] }] }), /content\[0\]\.type: must be paragraph/],
    ['a heading inside a list item after the paragraph', doc({ type: 'bullet_list', content: [{ type: 'list_item', content: [para(), { type: 'heading', attrs: { level: 1 } }] }] }), /must be one of: bullet_list, ordered_list/],
    ['attrs on a list', doc({ type: 'bullet_list', attrs: { order: 5 }, content: [{ type: 'list_item', content: [para()] }] }), /attrs: is not allowed on a list/],
  ])('rejects %s', (_name, value, message) => {
    expect(problems(value).join('\n')).toMatch(message);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
    'file:///etc/passwd',
    '//evil.example/x',
    '/relative',
    'https://a.b/ x',
    'https://a.b/"onmouseover="x',
    'https://a.b/\u0000',
    'https://a.b/\n',
    'http://',
    '',
  ])('rejects the link address %j', (href) => {
    expect(isSafeHref(href)).toBe(false);
    expect(problems(doc(para(text('x', [{ type: 'link', attrs: { href } }]))))).toHaveLength(1);
  });

  it.each(['https://example.com', 'http://example.com/a?b=c#d', 'mailto:someone@example.com', 'HTTPS://EXAMPLE.COM'])('accepts the link address %j', (href) => {
    expect(isSafeHref(href)).toBe(true);
  });

  it('rejects a link address that is not a string or is too long', () => {
    expect(isSafeHref(5)).toBe(false);
    expect(isSafeHref(undefined)).toBe(false);
    expect(isSafeHref(`https://a.b/${'x'.repeat(3000)}`)).toBe(false);
  });

  it('requires colour and size marks to name existing theme tokens', () => {
    const color = (token: unknown) => problems(doc(para(text('x', [{ type: 'color', attrs: { token } }]))));
    const size = (token: unknown) => problems(doc(para(text('x', [{ type: 'size', attrs: { token } }]))));
    expect(color('text')).toEqual([]);
    expect(color('nope').join()).toMatch(/unknown theme colour "nope"/);
    expect(size('body')).toEqual([]);
    expect(size('text').join()).toMatch(/unknown theme size "text"/);
    for (const bad of ['__proto__', 'a b', 'x;color:red', '', 5, null]) {
      expect(color(bad).length, String(bad)).toBeGreaterThan(0);
      expect(size(bad).length, String(bad)).toBeGreaterThan(0);
    }
    expect(problems(doc(para(text('x', [{ type: 'color' }]))))[0]).toMatch(/must be a token name/);
  });

  it('does not treat inherited names as tokens', () => {
    const result = validateRichText(doc(para(text('x', [{ type: 'color', attrs: { token: 'toString' } }]))), 'rich', { colors: new Set(['text']), sizes: new Set() });
    expect(result).toHaveLength(1);
  });

  it('caps nesting, node count and text length', () => {
    let item: unknown = para(text('deep'));
    let nested: unknown = { type: 'bullet_list', content: [{ type: 'list_item', content: [item] }] };
    for (let i = 0; i < 12; i++) nested = { type: 'bullet_list', content: [{ type: 'list_item', content: [para(), nested] }] };
    expect(problems(doc(nested)).join()).toMatch(/nested deeper than 8/);
    const many = doc(...Array.from({ length: 11 }, () => para(...Array.from({ length: 2_000 }, () => text('x')))));
    expect(problems(many).join()).toMatch(/more than 20000 nodes/);
    expect(problems(doc(...Array.from({ length: 20_001 }, () => para()))).join()).toMatch(/too many child nodes/);
    expect(problems(doc(para(text('x'.repeat(200_001))))).join()).toMatch(/more than 200000 characters/);
  });

  it('survives absurd nesting without recursing without bound', () => {
    let node: unknown = para();
    for (let i = 0; i < 200_000; i++) node = { type: 'paragraph', content: [node] };
    expect(problems(doc(node)).length).toBeGreaterThan(0);
  });

  it('reports every problem with its path instead of stopping at the first', () => {
    const result = problems(doc(para(text('', [{ type: 'strike' }])), { type: 'blink' }));
    expect(result).toHaveLength(3);
    expect(result[0]).toMatch(/^rich\.content\[0\]\.content\[0\]/);
  });

  it('does not mutate frozen input', () => {
    const frozen = structuredClone(RICH);
    const freeze = (v: unknown): void => {
      if (typeof v === 'object' && v !== null) {
        Object.freeze(v);
        Object.values(v).forEach(freeze);
      }
    };
    freeze(frozen);
    expect(problems(frozen)).toEqual([]);
    expect(richPlainText(frozen)).toContain('Plan');
    expect(richTokenRefs(frozen).colors.has('accent')).toBe(true);
  });
});

describe('plain text conversion', () => {
  it('turns lines into paragraphs and bullet lines into a list', () => {
    const rich = plainToRich('Intro\n- one\n- two\nOutro');
    expect(problems(rich)).toEqual([]);
    expect(rich.content.map((n) => n.type)).toEqual(['paragraph', 'bullet_list', 'paragraph']);
    expect(richPlainText(rich)).toBe('Intro\n- one\n- two\nOutro');
  });

  it('makes heading text one heading, with line breaks, as the renderer outputs it', () => {
    const rich = plainToRich('Big\nidea', true);
    expect(rich.content).toEqual([{ type: 'heading', attrs: { level: 2 }, content: [text('Big'), { type: 'hard_break' }, text('idea')] }]);
    expect(richPlainText(rich)).toBe('Big\nidea');
    expect(problems(rich)).toEqual([]);
    expect(plainToRich('', true).content).toEqual([{ type: 'heading', attrs: { level: 2 } }]);
    expect(plainToRich('Title\n- one\n- two', true).content).toHaveLength(1);
  });

  it('gives an empty paragraph for empty text, so the result is always valid', () => {
    expect(plainToRich('')).toEqual(emptyRichDoc());
    expect(plainToRich('  \n ')).toEqual(emptyRichDoc());
    expect(problems(plainToRich(''))).toEqual([]);
  });

  it('keeps hostile text as text', () => {
    const rich = plainToRich('<script>alert(1)</script>\n- <img src=x onerror=alert(1)>');
    expect(problems(rich)).toEqual([]);
    expect(JSON.stringify(rich)).toContain('<script>');
  });

  it('mirrors a rich document as plain text with markers and indentation', () => {
    expect(richPlainText(RICH)).toBe('Plan\nBold link\ncode\n- one\n  1. nested\n- two');
  });

  it('numbers ordered lists and writes line breaks as new lines', () => {
    const rich = doc(
      { type: 'ordered_list', content: [{ type: 'list_item', content: [para(text('a'))] }, { type: 'list_item', content: [para(text('b'), { type: 'hard_break' }, text('c'))] }] },
    ) as RichDoc;
    expect(richPlainText(rich)).toBe('1. a\n2. b\nc');
  });

  it('parses plain text the way the renderer always has', () => {
    expect(parsePlainText('Title\n\n- one\n* two\nafter\r\n• three')).toEqual([
      { kind: 'paragraph', text: 'Title' },
      { kind: 'list', items: ['one', 'two'] },
      { kind: 'paragraph', text: 'after' },
      { kind: 'list', items: ['three'] },
    ]);
  });
});

describe('richTokenRefs', () => {
  it('collects colour and size tokens at any depth', () => {
    const refs = richTokenRefs(RICH);
    expect([...refs.colors]).toEqual(['accent']);
    expect([...refs.sizes]).toEqual(['title']);
  });

  it('ignores marks without a token and empty documents', () => {
    expect(richTokenRefs(emptyRichDoc())).toEqual({ colors: new Set(), sizes: new Set() });
  });
});

describe('rich text in a deck', () => {
  const deckWith = (rich: unknown) => {
    const deck = createDeck();
    deck.slides[0].elements.push({ ...createElement('text', { text: 'x' }), rich } as never);
    return deck;
  };

  it('validates with the deck theme', () => {
    expect(validateDeck(deckWith(RICH)).ok).toBe(true);
  });

  it('reports problems with the path of the element', () => {
    const result = validateDeck(deckWith(doc({ type: 'script' })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0].path).toBe('slides[0].elements[0].rich.content[0].type');
  });

  it('rejects a token the deck theme lacks', () => {
    const result = validateDeck(deckWith(doc(para(text('x', [{ type: 'size', attrs: { token: 'gigantic' } }])))));
    expect(result.ok).toBe(false);
  });

  it('keeps a deck without rich content valid (the field is optional)', () => {
    expect(validateDeck(createDeck()).ok).toBe(true);
  });
});
