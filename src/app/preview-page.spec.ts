import { TestBed } from '@angular/core/testing';
import { createDeck, createElement, type Deck } from './core/model';
import { DeckRepository, InMemoryDeckRepository, STORAGE_MANAGER } from './core/persistence';
import { provideCodeComponents } from './components/host/providers';
import { PreviewPage } from './preview-page';

function deckWithText(text: string): Deck {
  const base = createDeck('Preview');
  const element = createElement('text', { text, x: 0, y: 0, w: 800, h: 200 });
  return { ...base, slides: [{ ...base.slides[0], elements: [element] }] };
}

function mount() {
  TestBed.configureTestingModule({
    providers: [
      { provide: DeckRepository, useValue: new InMemoryDeckRepository() },
      { provide: STORAGE_MANAGER, useValue: null },
      provideCodeComponents(),
    ],
  });
  const fixture = TestBed.createComponent(PreviewPage);
  fixture.detectChanges();
  return fixture;
}

describe('PreviewPage', () => {
  afterEach(() => delete window.decktechPreview);

  it('exposes the hook the MCP server drives and draws nothing until it is called', () => {
    const fixture = mount();
    expect(typeof window.decktechPreview?.show).toBe('function');
    expect(typeof window.decktechPreview?.report).toBe('function');
    expect(fixture.nativeElement.querySelector('app-slide-renderer')).toBeNull();
  });

  it('draws the requested slide of the handed deck and reports no errors for a deck without code', async () => {
    const fixture = mount();
    const deck = deckWithText('Hello preview');
    await window.decktechPreview!.show({ deck, slideId: deck.slides[0].id, width: 640 });
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('app-slide-renderer')).not.toBeNull();
    expect(host.textContent).toContain('Hello preview');
    expect((host.querySelector('.frame') as HTMLElement).style.width).toBe('640px');
    expect(window.decktechPreview!.report()).toEqual({ errors: [], console: [], frames: [] });
  });

  it('keeps the width within sane bounds and falls back to the first slide for an unknown id', async () => {
    const fixture = mount();
    const deck = deckWithText('First');
    await window.decktechPreview!.show({ deck, slideId: 'unknown', width: 10 });
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect((host.querySelector('.frame') as HTMLElement).style.width).toBe('160px');
    expect(host.textContent).toContain('First');
  });

  it('reports a code element whose frame cannot be made as not running', async () => {
    const fixture = mount();
    const base = deckWithText('x');
    const code = createElement('code', { componentId: 'missing', x: 0, y: 0, w: 400, h: 300 });
    const deck: Deck = { ...base, slides: [{ ...base.slides[0], elements: [code] }] };
    await window.decktechPreview!.show({ deck, slideId: deck.slides[0].id });
    fixture.detectChanges();
    const { frames } = window.decktechPreview!.report();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ elementId: code.id, running: false });
  });
});
