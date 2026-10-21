import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { createDeck, createElement, createSlide, type Deck } from '../core/model';
import { DeckRepository, InMemoryDeckRepository, STORAGE_MANAGER } from '../core/persistence';
import { DeckStore } from '../core/store';
import { PresenterPage } from './presenter-page';

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
  }
  fixture.detectChanges();
}

async function open(options: { id?: string; slide?: string; repo?: InMemoryDeckRepository; deck?: Deck } = {}) {
  const repo = options.repo ?? new InMemoryDeckRepository();
  const deck = options.deck ?? createDeck('Quarterly review');
  if (!options.deck) {
    deck.slides[0].elements.push(createElement('text', { text: 'First' }));
    deck.slides.push({ ...createSlide(deck.layouts[0].id), elements: [createElement('text', { text: 'Second' })] });
    deck.slides.push({ ...createSlide(deck.layouts[0].id), elements: [createElement('text', { text: 'Third' })] });
  }
  await repo.save(deck, null);
  TestBed.configureTestingModule({ providers: [{ provide: DeckRepository, useValue: repo }, { provide: STORAGE_MANAGER, useValue: null }, provideRouter([])] });
  const fixture = TestBed.createComponent(PresenterPage);
  fixture.componentRef.setInput('id', options.id ?? deck.id);
  if (options.slide !== undefined) fixture.componentRef.setInput('slide', options.slide);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return { fixture, deck, root, settle: () => settle(fixture), shown: () => root.querySelector('.layer.current')?.textContent?.trim() };
}

afterEach(() => document.body.replaceChildren());

describe('PresenterPage', () => {
  it('says it is opening the deck, then presents it from the first slide', async () => {
    const p = await open();
    expect(p.root.textContent).toContain('Opening deck');
    await p.settle();
    expect(p.root.querySelector('app-presentation-view')).not.toBeNull();
    expect(p.shown()).toContain('First');
    expect(TestBed.inject(DeckStore).deck().id).toBe(p.deck.id);
  });

  it.each([
    ['3', 'Third'],
    ['2', 'Second'],
    ['1', 'First'],
    ['0', 'First'],
    ['-4', 'First'],
    ['abc', 'First'],
    ['99', 'Third'],
  ])('starts on the slide asked for with ?slide=%s: %s', async (slide, expected) => {
    const p = await open({ slide });
    await p.settle();
    expect(p.shown()).toContain(expected);
  });

  it('shows a message and a way back for a deck that is not there', async () => {
    const p = await open({ id: 'dk_missing' });
    await p.settle();
    expect(p.root.querySelector('[role="alert"]')?.textContent).toContain('could not be opened');
    expect(p.root.querySelector('a')?.getAttribute('href')).toBe('/');
    expect(p.root.querySelector('app-presentation-view')).toBeNull();
  });

  it('returns to the editor of the deck when the presentation ends', async () => {
    const p = await open();
    await p.settle();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(navigate).toHaveBeenCalledWith(['/deck', p.deck.id]);
  });
});
