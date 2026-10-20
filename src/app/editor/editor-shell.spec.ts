import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import axe from 'axe-core';
import { createDeck, createSlide } from '../core/model';
import { DeckRepository, InMemoryDeckRepository, STORAGE_MANAGER } from '../core/persistence';
import { DeckStore } from '../core/store';
import { EditorShell } from './editor-shell';

async function setup(open: 'saved' | 'missing' = 'saved') {
  const repo = new InMemoryDeckRepository();
  const deck = createDeck('Quarterly review');
  deck.slides.push(createSlide(deck.layouts[0].id));
  await repo.save(deck, null);
  TestBed.configureTestingModule({
    providers: [
      { provide: DeckRepository, useValue: repo },
      { provide: STORAGE_MANAGER, useValue: null },
      provideRouter([]),
    ],
  });
  const fixture = TestBed.createComponent(EditorShell);
  fixture.componentRef.setInput('id', open === 'saved' ? deck.id : 'dk_missing');
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  return { fixture, deck, repo, store: TestBed.inject(DeckStore) };
}

const settle = async (fixture: ComponentFixture<EditorShell>) => {
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r));
  await fixture.whenStable();
  fixture.detectChanges();
};
const root = (f: ComponentFixture<EditorShell>) => f.nativeElement as HTMLElement;

afterEach(() => document.body.replaceChildren());

describe('EditorShell', () => {
  it('says it is opening while the deck loads, with a neutral heading', async () => {
    const { fixture } = await setup();
    expect(root(fixture).querySelector('h1')?.textContent).toBe('Editor');
    expect(root(fixture).textContent).toContain('Opening deck');
    await settle(fixture);
  });

  it('opens the deck named by the route and lays out sorter, canvas, properties and notes', async () => {
    const { fixture, deck, store } = await setup();
    await settle(fixture);
    expect(store.deck().id).toBe(deck.id);
    expect(root(fixture).querySelector('h1')?.textContent).toBe('Quarterly review');
    expect(root(fixture).querySelector('nav[aria-label="Slides"]')).toBeTruthy();
    expect(root(fixture).querySelector('app-canvas')).toBeTruthy();
    expect(root(fixture).querySelector('aside[aria-label="Properties"]')).toBeTruthy();
    expect(root(fixture).querySelector('section[aria-label="Speaker notes"]')).toBeTruthy();
  });

  it('switches slides from the sorter and marks the current one', async () => {
    const { fixture, deck, store } = await setup();
    await settle(fixture);
    const buttons = Array.from(root(fixture).querySelectorAll<HTMLButtonElement>('.sorter button'));
    expect(buttons.map((b) => b.getAttribute('aria-current'))).toEqual(['true', null]);
    buttons[1].click();
    fixture.detectChanges();
    expect(store.currentSlideId()).toBe(deck.slides[1].id);
    expect(buttons.map((b) => b.getAttribute('aria-current'))).toEqual([null, 'true']);
  });

  it('reports a deck that cannot be opened and offers the way back', async () => {
    const { fixture } = await setup('missing');
    await settle(fixture);
    const alert = root(fixture).querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('This deck could not be opened');
    expect(root(fixture).querySelector('app-canvas')).toBeNull();
    expect(root(fixture).querySelector('h1')?.textContent).toBe('Editor');
    expect(root(fixture).querySelector('a')?.getAttribute('href')).toBe('/');
  });

  it('ignores a slow load that a newer route has overtaken', async () => {
    const { fixture, repo } = await setup();
    const other = createDeck('Second');
    await repo.save(other, null);
    fixture.componentRef.setInput('id', other.id);
    fixture.detectChanges();
    await settle(fixture);
    expect(root(fixture).querySelector('h1')?.textContent).toBe('Second');
  });

  it('shows an error instead of loading forever when opening throws', async () => {
    const { fixture, repo } = await setup();
    vi.spyOn(repo, 'load').mockRejectedValue(new Error('disk on fire'));
    fixture.componentRef.setInput('id', 'dk_other');
    fixture.detectChanges();
    await settle(fixture);
    expect(root(fixture).querySelector('[role="alert"]')?.textContent).toContain('disk on fire');
  });

  it('has no AXE violations', async () => {
    const { fixture } = await setup();
    await settle(fixture);
    const results = await axe.run(root(fixture), { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
