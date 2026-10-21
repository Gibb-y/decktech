import { TestBed } from '@angular/core/testing';
import { createDeck, createElement, createTheme, validateDeck, type Deck, type RichDoc, type TextEl } from '../model';
import { CommandError } from './command';
import { SetProps, SetText, SetTheme } from './commands';
import { DeckStore } from './deck-store';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

const para = (text: string, marks?: RichDoc['content'][number]['marks']) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] });
const rich = (...content: RichDoc['content']): RichDoc => ({ type: 'doc', content });

function setup() {
  const deck = createDeck();
  const el = createElement('text', { text: 'Plain', x: 10, y: 20, w: 300, h: 100 });
  const shape = createElement('shape');
  deck.slides[0].elements.push(el, shape);
  return { deck: deepFreeze(deck), el, shape };
}

const textOf = (deck: Deck, id: string): TextEl => deck.slides[0].elements.find((e) => e.id === id) as TextEl;

describe('SetText with a rich document', () => {
  it('stores the document and mirrors it as plain text', () => {
    const { deck, el } = setup();
    const doc = rich(para('Hello', [{ type: 'bold' }]), { type: 'bullet_list', content: [{ type: 'list_item', content: [para('one')] }] });
    const next = textOf(new SetText(el.id, doc).do(deck).deck, el.id);
    expect(next.rich).toEqual(doc);
    expect(next.text).toBe('Hello\n- one');
    expect(next.x).toBe(10);
  });

  it('stores a copy, so later changes to the argument do not reach the deck', () => {
    const { deck, el } = setup();
    const doc = rich(para('Hello'));
    const next = new SetText(el.id, doc).do(deck).deck;
    doc.content[0].content![0].text = 'changed';
    expect(textOf(next, el.id).rich!.content[0].content![0].text).toBe('Hello');
  });

  it('keeps the result a valid deck', () => {
    const { deck, el } = setup();
    const next = new SetText(el.id, rich(para('x', [{ type: 'color', attrs: { token: 'accent' } }, { type: 'size', attrs: { token: 'title' } }]))).do(deck).deck;
    expect(validateDeck(next).ok).toBe(true);
  });

  it('changes nothing for identical content, and replaces content that differs', () => {
    const { deck, el } = setup();
    const once = new SetText(el.id, rich(para('Hello'))).do(deck).deck;
    expect(new SetText(el.id, rich(para('Hello'))).do(once).deck).toBe(once);
    expect(new SetText(el.id, rich(para('Hello', [{ type: 'italic' }]))).do(once).deck).not.toBe(once);
  });

  it('leaves other elements and slides untouched', () => {
    const { deck, el, shape } = setup();
    const next = new SetText(el.id, rich(para('x'))).do(deck).deck;
    expect(next.slides[0].elements.find((e) => e.id === shape.id)).toBe(shape);
    expect(next.layouts).toBe(deck.layouts);
  });

  it.each([
    ['an unknown node', { type: 'doc', content: [{ type: 'script' }] }, /Invalid rich text: .*content\[0\]\.type/],
    ['an unsafe link', rich(para('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])), /href/],
    ['an unknown colour token', rich(para('x', [{ type: 'color', attrs: { token: 'neon' } }])), /unknown theme colour "neon"/],
    ['an unknown size token', rich(para('x', [{ type: 'size', attrs: { token: 'neon' } }])), /unknown theme size "neon"/],
    ['an empty document', { type: 'doc', content: [] }, /needs at least 1/],
  ])('rejects %s and leaves the deck as it was', (_name, doc, message) => {
    const { deck, el } = setup();
    TestBed.configureTestingModule({});
    const store = TestBed.inject(DeckStore);
    store.load(deck);
    expect(() => store.execute(new SetText(el.id, doc as RichDoc))).toThrow(message);
    expect(store.deck()).toBe(deck);
    expect(store.canUndo()).toBe(false);
  });

  it('rejects a non-text element and an unknown id with specific messages', () => {
    const { deck, shape } = setup();
    expect(() => new SetText(shape.id, rich(para('x'))).do(deck)).toThrow(/is a shape element, not text/);
    expect(() => new SetText('nope', rich(para('x'))).do(deck)).toThrow(/does not exist/);
    expect(() => new SetText('nope', rich(para('x'))).do(deck)).toThrow(CommandError);
  });

  it('is one undo step that restores the previous content, plain or rich', () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(DeckStore);
    const { deck, el } = setup();
    store.load(deck);
    store.execute(new SetText(el.id, rich(para('First', [{ type: 'bold' }]))));
    store.execute(new SetText(el.id, rich(para('Second'))));
    expect(textOf(store.deck(), el.id).text).toBe('Second');
    store.undo();
    expect(textOf(store.deck(), el.id).rich!.content[0].content![0].text).toBe('First');
    store.undo();
    expect(textOf(store.deck(), el.id)).toEqual(el);
    expect(textOf(store.deck(), el.id).rich).toBeUndefined();
    store.redo();
    expect(textOf(store.deck(), el.id).text).toBe('First');
  });
});

describe('SetText with plain text', () => {
  it('drops the rich document, so the renderer cannot show stale formatting', () => {
    const { deck, el } = setup();
    const formatted = new SetText(el.id, rich(para('Rich', [{ type: 'bold' }]))).do(deck).deck;
    const plain = textOf(new SetText(el.id, 'Now plain').do(formatted).deck, el.id);
    expect(plain.text).toBe('Now plain');
    expect('rich' in plain).toBe(false);
  });

  it('drops the rich document even when the text is the same', () => {
    const { deck, el } = setup();
    const formatted = new SetText(el.id, rich(para('Same'))).do(deck).deck;
    expect('rich' in textOf(new SetText(el.id, 'Same').do(formatted).deck, el.id)).toBe(false);
  });
});

describe('SetProps and rich text', () => {
  it('refuses to set rich directly: only SetText validates and mirrors it', () => {
    const { deck, el } = setup();
    expect(() => new SetProps([el.id], { rich: rich(para('x')) }).do(deck)).toThrow(/"rich" is not a settable property/);
  });

  it('drops a stale rich document when the plain text field is edited', () => {
    const { deck, el } = setup();
    const formatted = new SetText(el.id, rich(para('Rich'))).do(deck).deck;
    const next = textOf(new SetProps([el.id], { text: 'Typed' }).do(formatted).deck, el.id);
    expect(next.text).toBe('Typed');
    expect('rich' in next).toBe(false);
  });

  it('keeps the rich document for changes that are not the text', () => {
    const { deck, el } = setup();
    const formatted = new SetText(el.id, rich(para('Rich'))).do(deck).deck;
    const next = textOf(new SetProps([el.id], { fontSize: 72, x: 5 }).do(formatted).deck, el.id);
    expect(next.rich).toBe(textOf(formatted, el.id).rich);
    expect(next.fontSize).toBe(72);
  });
});

describe('SetTheme and text sizes', () => {
  it('refuses a theme that drops a size token a text mark uses, and a colour token too', () => {
    const { deck, el } = setup();
    const withSize = new SetText(el.id, rich(para('x', [{ type: 'size', attrs: { token: 'title' } }]))).do(deck).deck;
    const noTitle = createTheme();
    delete noTitle.typeScale['title'];
    expect(() => new SetTheme(noTitle).do(withSize)).toThrow(/still uses the text size "title"/);
    const withColor = new SetText(el.id, rich(para('x', [{ type: 'color', attrs: { token: 'accent' } }]))).do(deck).deck;
    const noAccent = createTheme();
    delete noAccent.colors['accent'];
    expect(() => new SetTheme(noAccent).do(withColor)).toThrow(/still uses the colour "accent"/);
  });

  it('accepts switching between built-in themes while rich text uses their tokens', () => {
    const { deck, el } = setup();
    const withMarks = new SetText(el.id, rich(para('x', [{ type: 'size', attrs: { token: 'body' } }, { type: 'color', attrs: { token: 'muted' } }]))).do(deck).deck;
    expect(validateDeck(new SetTheme(createTheme('dark')).do(withMarks).deck).ok).toBe(true);
  });
});
