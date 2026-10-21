import { TestBed } from '@angular/core/testing';
import axe from 'axe-core';
import { createDeck, createElement, createSlide, type RichDoc, type RichNode, type Slide } from '../core/model';
import { DeckRepository, InMemoryDeckRepository } from '../core/persistence';
import { SlideRenderer } from './slide-renderer';
import { richToView, type ViewNode } from './rich-view';

const theme = createDeck().theme;
const text = (value: string, marks?: RichNode['marks']): RichNode => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
const para = (...content: RichNode[]): RichNode => ({ type: 'paragraph', content });
const doc = (...content: RichNode[]): RichDoc => ({ type: 'doc', content });

function render(rich: unknown, extra: Record<string, unknown> = {}): HTMLElement {
  TestBed.configureTestingModule({ providers: [{ provide: DeckRepository, useValue: new InMemoryDeckRepository() }] });
  const slide: Slide = { ...createSlide('layout'), elements: [createElement('text', { text: 'PLAIN', rich: rich as RichDoc, ...extra })] };
  const fixture = TestBed.createComponent(SlideRenderer);
  fixture.componentRef.setInput('slide', slide);
  fixture.componentRef.setInput('theme', theme);
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).querySelector('app-text-element')!;
}

const tags = (view: ViewNode[]): string[] => view.flatMap((n) => [n.tag, ...tags(n.children ?? [])]);

describe('richToView', () => {
  it('maps blocks to semantic tags', () => {
    const view = richToView(
      doc(
        { type: 'heading', attrs: { level: 1 }, content: [text('A')] },
        { type: 'heading', attrs: { level: 3 }, content: [text('B')] },
        para(text('C')),
        { type: 'bullet_list', content: [{ type: 'list_item', content: [para(text('x')), { type: 'ordered_list', content: [{ type: 'list_item', content: [para(text('y'))] }] }] }] },
      ),
      theme,
    );
    expect(tags(view)).toEqual(['h1', 'text', 'h3', 'text', 'p', 'text', 'ul', 'li', 'p', 'text', 'ol', 'li', 'p', 'text']);
  });

  it('wraps marks with the link outermost and code innermost', () => {
    const [p] = richToView(
      doc(para(text('x', [{ type: 'code' }, { type: 'link', attrs: { href: 'https://example.com' } }, { type: 'bold' }, { type: 'color', attrs: { token: 'accent' } }, { type: 'italic' }, { type: 'underline' }]))),
      theme,
    );
    expect(tags(p.children!)).toEqual(['a', 'span', 'strong', 'em', 'u', 'code', 'text']);
    expect(p.children![0].href).toBe('https://example.com');
    expect(p.children![0].children![0].style).toEqual({ color: 'var(--deck-color-accent)' });
  });

  it('resolves colour and size tokens to theme variables, and ignores tokens the theme lacks', () => {
    const [p] = richToView(doc(para(text('a', [{ type: 'size', attrs: { token: 'title' } }]), text('b', [{ type: 'size', attrs: { token: 'gigantic' } }]))), theme);
    expect(p.children![0].style).toEqual({ 'font-size': 'var(--deck-type-title)' });
    expect(p.children![1].tag).toBe('text');
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', '//evil', 'https://a.b/"x'])('drops the link on an unsafe address %j but keeps the text', (href) => {
    const [p] = richToView(doc(para(text('x', [{ type: 'link', attrs: { href } }]))), theme);
    expect(tags(p.children!)).toEqual(['text']);
  });

  it.each([
    ['unknown blocks', { type: 'doc', content: [{ type: 'script', content: [{ type: 'text', text: 'boom' }] }] }],
    ['a non-array content', { type: 'doc', content: 'x' }],
    ['nothing', null],
    ['an array', []],
  ])('renders %s as nothing instead of failing', (_n, value) => {
    expect(richToView(value as RichDoc, theme)).toEqual([]);
  });

  it('skips unknown inline nodes and empty text', () => {
    const [p] = richToView(doc(para({ type: 'image' } as RichNode, text(''), { type: 'hard_break' }, text('ok'))), theme);
    expect(tags(p.children!)).toEqual(['br', 'text']);
  });

  it('keeps hostile markup as text', () => {
    const [p] = richToView(doc(para(text('<img src=x onerror=alert(1)>'))), theme);
    expect(p.children![0]).toEqual({ tag: 'text', text: '<img src=x onerror=alert(1)>' });
  });
});

describe('TextElement with rich content', () => {
  afterEach(() => document.body.replaceChildren());

  it('renders semantic HTML and prefers rich over the plain text', () => {
    const host = render(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
        para(text('Some '), text('bold', [{ type: 'bold' }]), text(' and '), text('linked', [{ type: 'link', attrs: { href: 'https://example.com/x' } }])),
        { type: 'ordered_list', content: [{ type: 'list_item', content: [para(text('one'))] }, { type: 'list_item', content: [para(text('two'))] }] },
      ),
    );
    expect(host.textContent).not.toContain('PLAIN');
    expect(host.querySelector('h2')?.textContent).toBe('Title');
    expect(host.querySelector('p strong')?.textContent).toBe('bold');
    const link = host.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com/x');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(Array.from(host.querySelectorAll('ol > li'), (li) => li.textContent)).toEqual(['one', 'two']);
    expect(host.querySelector('p')?.textContent).toBe('Some bold and linked');
  });

  it('adds no whitespace around text, so spacing matches what was typed', () => {
    const host = render(doc(para(text('a '), text('b', [{ type: 'bold' }]), text(' c'))));
    expect(host.querySelector('p')?.textContent).toBe('a b c');
  });

  it('applies theme-token colour and size marks as inline custom-property references only', () => {
    const host = render(doc(para(text('x', [{ type: 'color', attrs: { token: 'accent' } }, { type: 'size', attrs: { token: 'title' } }]))));
    const span = host.querySelector('span')!;
    expect(span.getAttribute('style')).toContain('var(--deck-color-accent)');
    expect(span.getAttribute('style')).toContain('var(--deck-type-title)');
  });

  it('never creates scripts, event handlers, images or javascript: links from a hostile document', () => {
    const host = render({
      type: 'doc',
      content: [
        { type: 'script', content: [{ type: 'text', text: 'alert(1)' }] },
        { type: 'paragraph', content: [text('click', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]), { type: 'image', attrs: { src: 'x', onerror: 'alert(1)' } }, text('<b onclick="x">t</b>')] },
      ],
    });
    expect(host.querySelector('script, img, iframe, [onclick], [onerror]')).toBeNull();
    expect(host.querySelector('a')).toBeNull();
    expect(host.querySelector('b')).toBeNull();
    expect(host.textContent).toContain('<b onclick="x">t</b>');
    expect(host.textContent).not.toContain('alert(1)');
  });

  it('falls back to plain rendering when the element has no rich content', () => {
    const plain = render(undefined, { text: ['- one', '- two'].join('\n') });
    expect(plain.querySelectorAll('li')).toHaveLength(2);
  });

  it('is AXE clean', async () => {
    const host = render(doc({ type: 'heading', attrs: { level: 1 }, content: [text('T')] }, para(text('B', [{ type: 'bold' }]))));
    const result = await axe.run(host.parentElement!, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});
