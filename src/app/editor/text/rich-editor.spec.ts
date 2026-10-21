import { TextSelection } from 'prosemirror-state';
import { createDeck, validateRichText, type RichDoc, type RichNode } from '../../core/model';
import { RichEditor, type RichEditorOptions } from './rich-editor';
import type { RichFormat } from './rich-format';
import { richSchema } from './rich-schema';

const theme = createDeck().theme;
const tokens = { colors: Object.keys(theme.colors), sizes: Object.keys(theme.typeScale) };
const problems = (doc: unknown) => validateRichText(doc, 'rich', tokens).map((p) => `${p.path}: ${p.message}`);
const text = (value: string, marks?: RichNode['marks']): RichNode => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
const para = (...content: RichNode[]): RichNode => ({ type: 'paragraph', content });
const doc = (...content: RichNode[]): RichDoc => ({ type: 'doc', content });

interface Harness {
  editor: RichEditor;
  host: HTMLElement;
  formats: RichFormat[];
  blurs: (Element | null)[];
  escapes: number;
  links: number;
  limits: number;
}

function open(initial: RichDoc = doc(para(text('Hello world')))): Harness {
  const host = document.body.appendChild(document.createElement('div'));
  const h: Harness = { host, formats: [], blurs: [], escapes: 0, links: 0, limits: 0 } as unknown as Harness;
  const options: RichEditorOptions = {
    label: 'Edit text',
    tokens,
    onFormat: (f) => h.formats.push(f),
    onBlur: (to) => h.blurs.push(to),
    onEscape: () => void h.escapes++,
    onLink: () => void h.links++,
    onLimit: () => void h.limits++,
  };
  h.editor = new RichEditor(host, initial, options);
  return h;
}

const selectionBetween = (view: RichEditor['view'], from: number, to: number) => TextSelection.create(view.state.doc, from, to);

function paste(h: Harness, html: string, plain = ''): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { types: ['text/html', 'text/plain'], files: [], items: [], getData: (type: string) => (type === 'text/html' ? html : type === 'text/plain' ? plain : '') },
  });
  h.editor.view.dom.dispatchEvent(event);
}

afterEach(() => document.body.replaceChildren());

describe('the editor schema and the stored grammar', () => {
  it('agree: every document the editor can produce validates, and every valid document loads unchanged', () => {
    const valid = doc(
      { type: 'heading', attrs: { level: 3 }, content: [text('H', [{ type: 'bold' }, { type: 'color', attrs: { token: 'accent' } }])] },
      para(text('a', [{ type: 'italic' }, { type: 'underline' }, { type: 'code' }, { type: 'link', attrs: { href: 'https://example.com' } }, { type: 'size', attrs: { token: 'body' } }]), { type: 'hard_break' }, text('b')),
      { type: 'bullet_list', content: [{ type: 'list_item', content: [para(text('x')), { type: 'ordered_list', content: [{ type: 'list_item', content: [para(text('y'))] }] }] }] },
    );
    expect(problems(valid)).toEqual([]);
    const node = richSchema.nodeFromJSON(valid);
    node.check();
    expect(node.toJSON()).toEqual(valid);
    const h = open(valid);
    expect(h.editor.json()).toEqual(valid);
    expect(h.editor.changed).toBe(false);
  });

  it('allows exactly the node and mark types of the grammar', () => {
    expect(Object.keys(richSchema.nodes).sort()).toEqual(['bullet_list', 'doc', 'hard_break', 'heading', 'list_item', 'ordered_list', 'paragraph', 'text']);
    expect(Object.keys(richSchema.marks).sort()).toEqual(['bold', 'code', 'color', 'italic', 'link', 'size', 'underline']);
  });

  it('starts from an empty paragraph when the stored document is invalid', () => {
    const h = open({ type: 'doc', content: [{ type: 'script' }] } as unknown as RichDoc);
    expect(h.editor.json()).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    const h2 = open(doc(para(text('x', [{ type: 'color', attrs: { token: 'neon' } }]))));
    expect(h2.editor.json().content[0].content).toBeUndefined();
  });

  it('exposes an accessible editing surface', () => {
    const h = open();
    const surface = h.host.querySelector('.ProseMirror')!;
    expect(surface.getAttribute('role')).toBe('textbox');
    expect(surface.getAttribute('aria-multiline')).toBe('true');
    expect(surface.getAttribute('aria-label')).toBe('Edit text');
  });
});

describe('pasting', () => {
  const HOSTILE = [
    '<p onclick="alert(1)" style="position:fixed">Hi</p>',
    '<script>alert(1)</script>',
    '<style>body{display:none}</style>',
    '<img src="x" onerror="alert(1)">',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<object data="x"></object><embed src="x">',
    '<a href="javascript:alert(1)">bad</a>',
    '<a href="data:text/html,<script>alert(1)</script>">data</a>',
    '<a href="https://example.com/ok" onclick="x" target="_top" style="color:red">good</a>',
    '<span style="color:red;font-size:99px">styled</span>',
    '<font color="red" size="7">font</font>',
    '<table><tr><td>cell</td></tr></table>',
    '<form action="/x"><input name="q" value="v"><button>go</button></form>',
    '<h5>deep</h5><h1>one</h1>',
    '<div><div><p>nested <b>bold</b> <i>it</i> <u>un</u> <code>code</code> <s>strike</s></p></div></div>',
    '<ul><li>a<ul><li>b</li></ul></li></ul><ol><li>c</li></ol>',
    '<svg><script>alert(1)</script><circle/></svg>',
    '<math><mi>x</mi></math>',
    '<p data-color="accent" class="color-accent" token="accent">data attrs</p>',
    '<b style="font-weight:normal">not bold</b>',
  ].join('');

  it('yields only nodes, marks and attributes the schema allows, which validate as stored content', () => {
    const h = open(doc(para()));
    paste(h, HOSTILE);
    const json = h.editor.json();
    expect(problems(json)).toEqual([]);
    const seen = new Set<string>();
    const walk = (n: RichNode): void => {
      seen.add(n.type);
      n.marks?.forEach((m) => seen.add(`mark:${m.type}`));
      n.content?.forEach(walk);
    };
    json.content.forEach(walk);
    expect([...seen].every((t) => ['paragraph', 'heading', 'bullet_list', 'ordered_list', 'list_item', 'text', 'hard_break', 'mark:bold', 'mark:italic', 'mark:underline', 'mark:code', 'mark:link'].includes(t))).toBe(true);
    const flat = JSON.stringify(json);
    expect(flat).not.toMatch(/alert\(1\)|javascript:|data:text/);
    expect(flat).not.toMatch(/"(onclick|onerror|style|class|token|target|src|data-color)"/);
    expect(flat).toContain('https://example.com/ok');
    expect(flat).toContain('good');
    expect(flat).toContain('bad'); // the text of a rejected link stays, only the link goes
    expect(flat).toContain('styled');
    expect(flat).toContain('cell');
  });

  it('never puts markup from the paste into the live DOM of the editor', () => {
    const h = open(doc(para()));
    paste(h, HOSTILE);
    const dom = h.editor.view.dom;
    expect(dom.querySelector('script, style, img, iframe, object, embed, svg, math, form, input, table, font, [onclick], [onerror], [style], [class]')).toBeNull();
    for (const a of Array.from(dom.querySelectorAll('a'))) expect(a.getAttribute('href')).toMatch(/^https?:\/\//);
  });

  it('maps pasted deep headings to the deepest level we have and keeps lists', () => {
    const h = open(doc(para()));
    paste(h, '<h5>deep</h5><ul><li>a<ul><li>b</li></ul></li></ul>');
    const json = h.editor.json();
    expect(json.content.find((n) => n.type === 'heading')?.attrs).toEqual({ level: 3 });
    expect(json.content.find((n) => n.type === 'bullet_list')?.content?.[0].content?.[1].type).toBe('bullet_list');
    expect(problems(json)).toEqual([]);
  });

  it('turns pasted plain text into paragraphs without interpreting it', () => {
    const h = open(doc(para()));
    paste(h, '', 'one <b>x</b>\ntwo');
    expect(h.editor.view.dom.querySelector('b')).toBeNull();
    expect(JSON.stringify(h.editor.json())).toContain('<b>x</b>');
    expect(problems(h.editor.json())).toEqual([]);
  });

  it('reads colour and size only from tokens, never from pasted styles', () => {
    const h = open(doc(para()));
    paste(h, '<p><span style="color: var(--deck-color-accent); font-size: var(--deck-type-title)" data-token="accent">x</span></p>');
    expect(JSON.stringify(h.editor.json())).not.toMatch(/color|size/);
  });
});

describe('format commands', () => {
  const selectAll = (h: Harness) => {
    const { view } = h.editor;
    view.dispatch(view.state.tr.setSelection(selectionBetween(view, 1, view.state.doc.content.size - 1)));
  };

  it.each([
    ['bold', 'bold'],
    ['italic', 'italic'],
    ['underline', 'underline'],
    ['code', 'code'],
  ] as const)('toggles %s on the selection and reports it', (command, mark) => {
    const h = open();
    selectAll(h);
    h.editor.run(command);
    expect(h.editor.json().content[0].content![0].marks).toEqual([{ type: mark }]);
    expect(h.editor.format()[command]).toBe(true);
    expect(h.editor.changed).toBe(true);
    h.editor.run(command);
    expect(h.editor.json()).toEqual(doc(para(text('Hello world'))));
    expect(h.editor.format()[command]).toBe(false);
    expect(h.editor.changed).toBe(false);
  });

  it('reports the format through the callback on every change', () => {
    const h = open();
    selectAll(h);
    const before = h.formats.length;
    h.editor.run('bold');
    expect(h.formats.length).toBeGreaterThan(before);
    expect(h.formats[h.formats.length - 1].bold).toBe(true);
  });

  it('switches between paragraph and headings', () => {
    const h = open();
    for (const [command, level] of [['h1', 1], ['h2', 2], ['h3', 3]] as const) {
      h.editor.run(command);
      expect(h.editor.json().content[0]).toMatchObject({ type: 'heading', attrs: { level } });
      expect(h.editor.format().block).toBe(command);
    }
    h.editor.run('paragraph');
    expect(h.editor.json().content[0].type).toBe('paragraph');
    expect(h.editor.format().block).toBe('paragraph');
  });

  it('makes, switches and removes lists, and indents items', () => {
    const h = open(doc(para(text('one'))));
    h.editor.run('bullet');
    expect(h.editor.json().content[0].type).toBe('bullet_list');
    expect(h.editor.format().list).toBe('bullet');
    h.editor.run('ordered');
    expect(h.editor.json().content[0].type).toBe('ordered_list');
    expect(h.editor.format().list).toBe('ordered');
    h.editor.run('ordered');
    expect(h.editor.json().content[0].type).toBe('paragraph');
    expect(h.editor.format().list).toBeNull();
    expect(problems(h.editor.json())).toEqual([]);
  });

  it('keeps every result valid when commands are applied in sequence', () => {
    const h = open(doc(para(text('one')), para(text('two'))));
    selectAll(h);
    for (const c of ['bullet', 'indent', 'bold', 'h1', 'outdent', 'ordered', 'italic', 'paragraph', 'code', 'underline'] as const) {
      h.editor.run(c);
      expect(problems(h.editor.json()), c).toEqual([]);
    }
  });

  it('undoes and redoes with its own history', () => {
    const h = open();
    selectAll(h);
    h.editor.run('bold');
    h.editor.run('undo');
    expect(h.editor.changed).toBe(false);
    h.editor.run('redo');
    expect(h.editor.format().bold).toBe(true);
  });

  it('sets colour and size tokens on a selection and clears them', () => {
    const h = open();
    selectAll(h);
    h.editor.setColor('accent');
    h.editor.setSize('title');
    expect(h.editor.json().content[0].content![0].marks).toEqual(expect.arrayContaining([{ type: 'color', attrs: { token: 'accent' } }, { type: 'size', attrs: { token: 'title' } }]));
    expect(h.editor.format()).toMatchObject({ color: 'accent', size: 'title' });
    h.editor.setColor('muted');
    expect(h.editor.format().color).toBe('muted');
    h.editor.setColor(null);
    h.editor.setSize(null);
    expect(h.editor.json()).toEqual(doc(para(text('Hello world'))));
    expect(problems(h.editor.json())).toEqual([]);
  });

  it('applies a token to what is typed next when nothing is selected', () => {
    const h = open();
    h.editor.setColor('accent');
    expect(h.editor.format().color).toBe('accent');
    h.editor.setColor(null);
    expect(h.editor.format().color).toBeNull();
  });
});

describe('links', () => {
  const selectWord = (h: Harness) => {
    const { view } = h.editor;
    view.dispatch(view.state.tr.setSelection(selectionBetween(view, 1, 6)));
  };

  it('links the selection to a web or mail address and reports it', () => {
    const h = open();
    selectWord(h);
    expect(h.editor.setLink('https://example.com/a')).toBe(true);
    expect(h.editor.json().content[0].content![0]).toEqual(text('Hello', [{ type: 'link', attrs: { href: 'https://example.com/a' } }]));
    expect(h.editor.format().link).toBe('https://example.com/a');
    expect(h.editor.setLink('mailto:me@example.com')).toBe(true);
    expect(h.editor.json().content[0].content![0].marks).toEqual([{ type: 'link', attrs: { href: 'mailto:me@example.com' } }]);
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'ftp://x', '//x', '', 'https://a b'])('refuses %j and changes nothing', (href) => {
    const h = open();
    selectWord(h);
    expect(h.editor.setLink(href)).toBe(false);
    expect(h.editor.changed).toBe(false);
  });

  it('removes a link, from a selection or from a caret inside it', () => {
    const h = open(doc(para(text('Hello', [{ type: 'link', attrs: { href: 'https://example.com' } }]), text(' world'))));
    const { view } = h.editor;
    view.dispatch(view.state.tr.setSelection(selectionBetween(view, 3, 3)));
    expect(h.editor.format().link).toBe('https://example.com');
    expect(h.editor.setLink(null)).toBe(true);
    expect(h.editor.json()).toEqual(doc(para(text('Hello world'))));
  });

  it('changes the address of the whole link from a caret inside it', () => {
    const h = open(doc(para(text('Hello', [{ type: 'link', attrs: { href: 'https://example.com' } }]), text(' world'))));
    const { view } = h.editor;
    view.dispatch(view.state.tr.setSelection(selectionBetween(view, 3, 3)));
    h.editor.setLink('https://example.org');
    expect(h.editor.json().content[0].content![0]).toEqual(text('Hello', [{ type: 'link', attrs: { href: 'https://example.org' } }]));
    expect(h.editor.json().content[0].content![1]).toEqual(text(' world'));
  });

  it('uses the address as the link text when nothing is selected and not in a link', () => {
    const h = open(doc(para()));
    h.editor.setLink('https://example.com');
    expect(h.editor.json().content[0].content![0]).toEqual(text('https://example.com', [{ type: 'link', attrs: { href: 'https://example.com' } }]));
  });
});

describe('keyboard', () => {
  const key = (h: Harness, init: KeyboardEventInit): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    h.editor.view.dom.dispatchEvent(event);
    return event;
  };

  it.each([
    ['b', 'bold'],
    ['i', 'italic'],
    ['u', 'underline'],
  ] as const)('Ctrl+%s toggles %s', (k, name) => {
    const h = open();
    h.editor.view.dispatch(h.editor.view.state.tr.setSelection(selectionBetween(h.editor.view, 1, 6)));
    expect(key(h, { key: k, ctrlKey: true }).defaultPrevented).toBe(true);
    expect(h.editor.format()[name]).toBe(true);
  });

  it('Ctrl+K asks the host for an address instead of acting itself', () => {
    const h = open();
    expect(key(h, { key: 'k', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(h.links).toBe(1);
    expect(h.editor.changed).toBe(false);
  });

  it('Escape is reported to the host and handled', () => {
    const h = open();
    expect(key(h, { key: 'Escape' }).defaultPrevented).toBe(true);
    expect(h.escapes).toBe(1);
  });

  it('Ctrl+Z undoes inside the editor', () => {
    const h = open();
    h.editor.view.dispatch(h.editor.view.state.tr.setSelection(selectionBetween(h.editor.view, 1, 6)));
    h.editor.run('bold');
    key(h, { key: 'z', ctrlKey: true });
    expect(h.editor.changed).toBe(false);
  });

  it('reports where focus went when the surface is blurred', () => {
    const h = open();
    const target = document.body.appendChild(document.createElement('button'));
    h.editor.view.dom.dispatchEvent(new FocusEvent('blur', { relatedTarget: target }));
    expect(h.blurs).toEqual([target]);
  });
});

describe('limits of the stored format', () => {
  it('refuses to nest lists deeper than the format allows, so what is shown can always be saved', () => {
    const h = open(doc(para(text('a'))));
    h.editor.run('bullet');
    for (let i = 0; i < 12; i++) {
      h.editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      h.editor.run('indent');
    }
    expect(problems(h.editor.json())).toEqual([]);
    expect(h.limits).toBeGreaterThan(0);
  });

  it('refuses a paste that would make the text too large', () => {
    const h = open(doc(para()));
    paste(h, '', 'x'.repeat(200_001));
    expect(problems(h.editor.json())).toEqual([]);
    expect(h.limits).toBe(1);
    expect(h.editor.changed).toBe(false);
  });
});
