import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { createDeck, createElement, createSlide, err, type CodeEl, type ComponentDef, type Deck } from '../../core/model';
import { DeckRepository, InMemoryDeckRepository, pendingRecord } from '../../core/persistence';
import { CODE_ELEMENT_VIEW, FrameRegistry, SlideRenderer, type RenderMode } from '../../renderer';
import { CodeElementRenderer } from '../host/code-element-renderer';
import { COUNTER_COMPONENT } from '../host/examples';
import { ComponentStateStore, RuntimeSource } from '../host/host-services';
import { TrustStore } from './trust-store';

/** The gate: a component the user has not let run never gets a frame, in any mode (arc42 §6.4, Q4). */

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const second: ComponentDef = { ...structuredClone(COUNTER_COMPONENT), id: 'cmp_second', name: 'Second' };

interface Harness {
  fixture: ComponentFixture<SlideRenderer>;
  repo: InMemoryDeckRepository;
  trust: TrustStore;
  deck: Deck;
  frames(): HTMLIFrameElement[];
  text(): string;
  settle(): Promise<void>;
  setComponents(components: ComponentDef[]): Promise<void>;
}

async function harness(options: { mode?: RenderMode; pending?: boolean; repo?: InMemoryDeckRepository } = {}): Promise<Harness> {
  const repo = options.repo ?? new InMemoryDeckRepository();
  const deck = createDeck('Foreign');
  const components = [structuredClone(COUNTER_COMPONENT), structuredClone(second)];
  deck.components.push(...components);
  const elements = components.map((def) => createElement('code', { x: 0, y: 0, w: 400, h: 300, componentId: def.id }) as CodeEl);
  deck.slides[0] = { ...createSlide('layout'), elements };
  if (options.pending) await repo.putTrust(pendingRecord(deck.id, deck.id, 'h', null));
  TestBed.configureTestingModule({
    providers: [
      { provide: DeckRepository, useValue: repo },
      { provide: CODE_ELEMENT_VIEW, useValue: () => Promise.resolve(CodeElementRenderer) },
      { provide: RuntimeSource, useValue: { load: () => Promise.resolve('/*runtime*/') } },
      { provide: ComponentStateStore, useValue: { load: () => ({}), save: () => undefined } },
    ],
  });
  const trust = TestBed.inject(TrustStore);
  await trust.refresh(deck.id);
  const fixture = TestBed.createComponent(SlideRenderer);
  fixture.componentRef.setInput('slide', deck.slides[0]);
  fixture.componentRef.setInput('theme', deck.theme);
  fixture.componentRef.setInput('mode', options.mode ?? 'edit');
  fixture.componentRef.setInput('deckId', deck.id);
  fixture.componentRef.setInput('components', deck.components);
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await tick();
    }
  };
  await settle();
  const root = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    repo,
    trust,
    deck,
    frames: () => Array.from(root.querySelectorAll('iframe')),
    text: () => root.textContent ?? '',
    settle,
    async setComponents(next) {
      fixture.componentRef.setInput('components', next);
      await settle();
    },
  };
}

describe('the trust gate on code elements', () => {
  it.each<RenderMode>(['edit', 'present'])('makes no frame for any component of a pending deck, in %s mode', async (mode) => {
    const h = await harness({ mode, pending: true });
    expect(h.frames()).toHaveLength(0);
    expect(TestBed.inject(FrameRegistry).count()).toBe(0);
    const placeholders = Array.from((h.fixture.nativeElement as HTMLElement).querySelectorAll('[role="img"]')).map((el) => el.getAttribute('aria-label'));
    expect(placeholders).toEqual(['Code component switched off: Counter', 'Code component switched off: Second']);
    expect(h.text()).toContain('Code switched off');
  });

  it('makes no frame in a thumbnail either', async () => {
    const h = await harness({ mode: 'thumbnail', pending: true });
    expect(h.frames()).toHaveLength(0);
  });

  it('runs a deck that has no record: it was made here', async () => {
    const h = await harness();
    expect(h.frames()).toHaveLength(2);
    expect(h.text()).not.toContain('switched off');
  });

  it('starts only the components the user chose, and keeps the others as placeholders', async () => {
    const h = await harness({ pending: true });
    const result = await h.trust.decide(h.deck, { run: new Set([COUNTER_COMPONENT.id]) });
    expect(result.ok).toBe(true);
    await h.settle();
    expect(h.frames()).toHaveLength(1);
    expect(h.frames()[0].title).toBe('Code component: Counter');
    expect(h.text()).toContain('Code switched off');
  });

  it('runs everything for "trust whole deck" and nothing for "open with code disabled"', async () => {
    const h = await harness({ pending: true });
    await h.trust.decide(h.deck, { run: new Set(h.deck.components.map((c) => c.id)) });
    await h.settle();
    expect(h.frames()).toHaveLength(2);
    await h.trust.decide(h.deck, { run: new Set() });
    await h.settle();
    expect(h.frames()).toHaveLength(0);
  });

  it('stops a component again when its code changes after the decision', async () => {
    const h = await harness({ pending: true });
    await h.trust.decide(h.deck, { run: new Set(h.deck.components.map((c) => c.id)) });
    await h.settle();
    expect(h.frames()).toHaveLength(2);
    const changed = h.deck.components.map((def) => (def.id === 'cmp_second' ? { ...def, js: 'fetch("https://evil.example")' } : def));
    await h.setComponents(changed);
    expect(h.frames()).toHaveLength(1);
    expect(h.frames()[0].title).toBe('Code component: Counter');
    expect(h.trust.needsReview(h.deck.id, changed)).toBe(true);
  });

  it('keeps a component that was added after the decision off', async () => {
    const h = await harness({ pending: true });
    await h.trust.decide({ ...h.deck, components: [h.deck.components[0]] }, { run: new Set([COUNTER_COMPONENT.id]) });
    await h.settle();
    expect(h.frames()).toHaveLength(1);
  });

  it('keeps everything off until the record has been read', async () => {
    const repo = new InMemoryDeckRepository();
    let release: () => void = () => undefined;
    vi.spyOn(repo, 'getTrust').mockImplementation(() => new Promise((resolve) => (release = () => resolve({ ok: true, value: null }))));
    const deck = createDeck();
    const h = await harnessWithoutRefresh(repo, deck);
    expect(h.frames()).toHaveLength(0);
    release();
    await h.settle();
    expect(h.frames()).toHaveLength(1);
  });

  it('treats a record that cannot be read as pending, not as absent', async () => {
    const repo = new InMemoryDeckRepository();
    vi.spyOn(repo, 'getTrust').mockResolvedValue(err({ kind: 'storage', message: 'blocked' }));
    const h = await harnessWithoutRefresh(repo, createDeck());
    await h.settle();
    expect(h.frames()).toHaveLength(0);
    expect(h.trust.record(h.deck.id)).toMatchObject({ status: 'pending' });
  });

  it('keeps a failed decision from switching anything on', async () => {
    const h = await harness({ pending: true });
    vi.spyOn(h.repo, 'putTrust').mockResolvedValueOnce({ ok: false, error: { kind: 'quota', message: 'full' } });
    const result = await h.trust.decide(h.deck, { run: new Set(h.deck.components.map((c) => c.id)) });
    expect(result).toEqual({ ok: false, error: 'Could not save your decision: full' });
    await h.settle();
    expect(h.frames()).toHaveLength(0);
    expect(h.trust.record(h.deck.id)?.status).toBe('pending');
  });
});

/** One counter element, and the store is not told to read the record: the renderer has to ask for it itself. */
async function harnessWithoutRefresh(repo: InMemoryDeckRepository, deck: Deck) {
  deck.components.push(structuredClone(COUNTER_COMPONENT));
  const element = createElement('code', { x: 0, y: 0, w: 400, h: 300, componentId: COUNTER_COMPONENT.id }) as CodeEl;
  deck.slides[0] = { ...createSlide('layout'), elements: [element] };
  TestBed.configureTestingModule({
    providers: [
      { provide: DeckRepository, useValue: repo },
      { provide: CODE_ELEMENT_VIEW, useValue: () => Promise.resolve(CodeElementRenderer) },
      { provide: RuntimeSource, useValue: { load: () => Promise.resolve('/*runtime*/') } },
      { provide: ComponentStateStore, useValue: { load: () => ({}), save: () => undefined } },
    ],
  });
  const fixture = TestBed.createComponent(SlideRenderer);
  fixture.componentRef.setInput('slide', deck.slides[0]);
  fixture.componentRef.setInput('theme', deck.theme);
  fixture.componentRef.setInput('mode', 'edit');
  fixture.componentRef.setInput('deckId', deck.id);
  fixture.componentRef.setInput('components', deck.components);
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await tick();
    }
  };
  fixture.detectChanges();
  await tick();
  fixture.detectChanges();
  return { deck, trust: TestBed.inject(TrustStore), settle, frames: () => Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('iframe')) };
}
