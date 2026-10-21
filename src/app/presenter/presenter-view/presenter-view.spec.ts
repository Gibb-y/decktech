import { TestBed, type ComponentFixture } from '@angular/core/testing';
import axe from 'axe-core';
import { createDeck, createElement, createSlide, type Deck, type Slide } from '../../core/model';
import { PresentationView } from '../presentation-view';
import { PresenterSync } from './presenter-sync';
import { PresenterView, formatElapsed } from './presenter-view';
import { SYNC_VERSION, syncChannelName } from './sync-protocol';

const slideOf = (content: string, notes = '', step?: number): Slide => ({
  ...createSlide('layout'),
  notes,
  elements: [createElement('text', { text: content }), ...(step === undefined ? [] : [createElement('text', { text: `${content} extra`, step })])],
});

async function settle(...fixtures: ComponentFixture<unknown>[]): Promise<void> {
  for (let i = 0; i < 3; i++) {
    for (const fixture of fixtures) fixture.detectChanges();
    await Promise.all(fixtures.map((fixture) => fixture.whenStable()));
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  for (const fixture of fixtures) fixture.detectChanges();
}

/** Messages cross a real `BroadcastChannel`, which delivers on a later task: wait until `done` holds. */
async function until(done: () => boolean, ...fixtures: ComponentFixture<unknown>[]): Promise<void> {
  for (let i = 0; i < 40 && !done(); i++) await settle(...fixtures);
  expect(done()).toBe(true);
}

function makeDeck(slides: Slide[] = [slideOf('one', 'Say hello', 2), slideOf('two', 'Second notes'), slideOf('three')]): Deck {
  return { ...createDeck('Talk'), slides };
}

function openView(deck: Deck) {
  const fixture = TestBed.createComponent(PresenterView);
  fixture.componentRef.setInput('deck', deck);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  return viewOf(fixture);
}

function viewOf(fixture: ComponentFixture<PresenterView>) {
  const root = fixture.nativeElement as HTMLElement;
  const click = (label: string) => {
    const button = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
    if (!button) throw new Error(`no button ${label}`);
    button.click();
  };
  return {
    fixture,
    root,
    click,
    text: (selector: string) => root.querySelector(selector)?.textContent?.trim() ?? null,
    position: () => root.querySelector('.position')?.textContent?.trim() ?? null,
    notes: () => root.querySelector('.notes')?.textContent?.replace('Notes', '').trim() ?? null,
    timer: () => root.querySelector('.timer-face')!.textContent!.trim(),
    destroy: () => {
      fixture.destroy();
      root.remove();
    },
  };
}

function openPresentation(deck: Deck, start = 0) {
  const fixture = TestBed.createComponent(PresentationView);
  fixture.componentRef.setInput('deck', deck);
  fixture.componentRef.setInput('start', start);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    root,
    shown: () => root.querySelector('.layer.current')?.textContent?.replace(/\s+/g, ' ').trim(),
    key: (key: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('formatElapsed', () => {
  it.each([
    [0, '0:00'],
    [999, '0:00'],
    [61_000, '1:01'],
    [3_599_000, '59:59'],
    [3_600_000, '1:00:00'],
    [3_723_000, '1:02:03'],
    [-5, '0:00'],
  ])('%d ms is %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });
});

describe('PresenterView with the presentation window', () => {
  it('says it is waiting while no presentation answers', async () => {
    const view = openView(makeDeck());
    await settle(view.fixture);
    expect(view.root.textContent).toContain('Waiting for the presentation');
    expect(view.root.querySelector('.current')).toBeNull();
  });

  it('shows the slide, next slide, notes, step and timer of the presentation', async () => {
    const deck = makeDeck();
    const presentation = openPresentation(deck);
    const view = openView(deck);
    await until(() => view.position() !== null, presentation.fixture, view.fixture);
    expect(view.position()).toBe('Slide 1 of 3, step 0 of 1');
    expect(view.notes()).toBe('Say hello');
    expect(view.text('.current .preview')).toBe('one');
    expect(view.text('.next .preview')).toBe('two');
    expect(view.timer()).toBe('0:00');
  });

  it('follows the presentation when it moves, and keeps both previews static', async () => {
    const deck = makeDeck();
    const presentation = openPresentation(deck);
    const view = openView(deck);
    await until(() => view.position() !== null, presentation.fixture, view.fixture);
    presentation.key('ArrowRight');
    await until(() => view.position() === 'Slide 1 of 3, step 1 of 1', presentation.fixture, view.fixture);
    expect(view.text('.current .preview')).toBe('oneone extra');
    presentation.key('ArrowRight');
    await until(() => view.position() === 'Slide 2 of 3', presentation.fixture, view.fixture);
    expect(view.notes()).toBe('Second notes');
    expect(view.text('.next .preview')).toBe('three');
    expect(view.root.querySelectorAll('app-slide-renderer[mode="thumbnail"]').length).toBe(2);
  });

  it('navigates the presentation from the presenter view, and the presentation from its own keys', async () => {
    const deck = makeDeck();
    const presentation = openPresentation(deck);
    const view = openView(deck);
    await until(() => view.position() !== null, presentation.fixture, view.fixture);
    view.click('Next');
    view.click('Next');
    await until(() => view.position() === 'Slide 2 of 3', presentation.fixture, view.fixture);
    expect(presentation.shown()).toContain('two');
    view.click('Previous');
    await until(() => view.position() === 'Slide 1 of 3, step 1 of 1', presentation.fixture, view.fixture);
    expect(presentation.shown()).toBe('oneone extra');
    presentation.key('End');
    await until(() => view.position() === 'Slide 3 of 3', presentation.fixture, view.fixture);
    expect(view.text('.next')).toContain('End of the presentation');
    expect(view.root.querySelector('button[aria-disabled="true"]')?.textContent?.trim()).toBe('Next');
  });

  it('sends commands for the keys, but not for Enter or Space on a focused button', async () => {
    const deck = makeDeck();
    const view = openView(deck);
    const spy = vi.spyOn(TestBed.inject(PresenterSync), 'connect');
    const posted: unknown[] = [];
    const channel = new BroadcastChannel(syncChannelName(deck.id));
    channel.onmessage = (event) => posted.push(event.data);
    await settle(view.fixture);
    const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };
    expect(press('ArrowRight').defaultPrevented).toBe(true);
    expect(press(' ', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(press('PageUp').defaultPrevented).toBe(true);
    expect(press(' ', {}, view.root.querySelector('button')!).defaultPrevented).toBe(false);
    expect(press('ArrowRight', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press('x').defaultPrevented).toBe(false);
    await until(() => posted.filter((m) => (m as { type: string }).type === 'command').length === 3, view.fixture);
    expect(posted.filter((m) => (m as { type: string }).type === 'command').map((m) => (m as { action: string }).action)).toEqual(['next', 'prev', 'prev']);
    channel.close();
    expect(spy).not.toHaveBeenCalled();
  });

  it('resyncs a reopened presenter view to the current slide and step', async () => {
    const deck = makeDeck();
    const presentation = openPresentation(deck);
    const first = openView(deck);
    await until(() => first.position() !== null, presentation.fixture, first.fixture);
    presentation.key('ArrowRight');
    presentation.key('ArrowRight');
    await until(() => first.position() === 'Slide 2 of 3', presentation.fixture, first.fixture);
    first.destroy();

    const second = openView(deck);
    expect(second.position()).toBeNull();
    await until(() => second.position() === 'Slide 2 of 3', presentation.fixture, second.fixture);
    expect(second.notes()).toBe('Second notes');
  });

  it('starts the presentation at the slide asked for and tells the view', async () => {
    const deck = makeDeck();
    const presentation = openPresentation(deck, 2);
    const view = openView(deck);
    await until(() => view.position() !== null, presentation.fixture, view.fixture);
    expect(view.position()).toBe('Slide 3 of 3');
  });

  describe('timer', () => {
    it('runs from the start of the presentation, pauses, resets and starts from the view', async () => {
      let now = 10_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const deck = makeDeck();
      const presentation = openPresentation(deck);
      const view = openView(deck);
      await until(() => view.position() !== null, presentation.fixture, view.fixture);
      expect(view.text('.controls')).toContain('Pause timer');

      now += 65_000;
      view.click('Pause timer');
      await until(() => view.text('.controls')!.includes('Start timer'), presentation.fixture, view.fixture);
      expect(view.timer()).toBe('1:05');
      now += 30_000;
      await settle(presentation.fixture, view.fixture);
      expect(view.timer()).toBe('1:05');

      view.click('Start timer');
      await until(() => view.text('.controls')!.includes('Pause timer'), presentation.fixture, view.fixture);
      view.click('Reset timer');
      await until(() => view.text('.controls')!.includes('Start timer') && view.timer() === '0:00', presentation.fixture, view.fixture);
    });

    it('survives reloading the presenter view', async () => {
      let now = 10_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const deck = makeDeck();
      const presentation = openPresentation(deck);
      const first = openView(deck);
      await until(() => first.position() !== null, presentation.fixture, first.fixture);
      now += 125_000;
      first.destroy();
      const second = openView(deck);
      await until(() => second.position() !== null, presentation.fixture, second.fixture);
      expect(second.timer()).toBe('2:05');
      expect(second.text('.controls')).toContain('Pause timer');
    });
  });

  it('ignores malformed messages and counts them', async () => {
    const deck = makeDeck();
    const presentation = openPresentation(deck);
    const view = openView(deck);
    await until(() => view.position() !== null, presentation.fixture, view.fixture);
    const sync = TestBed.inject(PresenterSync);
    const before = sync.rejected();
    const rogue = new BroadcastChannel(syncChannelName(deck.id));
    rogue.postMessage({ v: SYNC_VERSION, type: 'command', action: 'goTo', slide: 99999999 });
    rogue.postMessage({ v: SYNC_VERSION, type: 'state', slide: 2, step: 0, steps: 0, slides: 1, timer: { running: false, elapsedMs: 0 } });
    rogue.postMessage('next');
    rogue.postMessage({ v: 99, type: 'command', action: 'next' });
    await until(() => sync.rejected() >= before + 4, presentation.fixture, view.fixture);
    expect(view.position()).toBe('Slide 1 of 3, step 0 of 1');
    expect(presentation.shown()).toContain('one');
    rogue.close();
  });

  it('uses a channel per deck, so another deck is not followed', async () => {
    const presentation = openPresentation(makeDeck());
    const view = openView(makeDeck());
    await settle(presentation.fixture, view.fixture);
    await settle(presentation.fixture, view.fixture);
    expect(view.position()).toBeNull();
  });

  it('closes its channel when destroyed', async () => {
    const deck = makeDeck();
    const view = openView(deck);
    await settle(view.fixture);
    const spy = vi.spyOn(BroadcastChannel.prototype, 'close');
    view.destroy();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('says so when the browser has no BroadcastChannel', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const view = openView(makeDeck());
    await settle(view.fixture);
    expect(view.root.querySelector('[role="alert"]')?.textContent).toContain('cannot connect');
    view.click('Next');
    vi.unstubAllGlobals();
  });

  it('copes with a deck that shrank under the position', async () => {
    const deck = makeDeck();
    const presentation = openPresentation(deck, 2);
    const view = openView(deck);
    await until(() => view.position() === 'Slide 3 of 3', presentation.fixture, view.fixture);
    view.fixture.componentRef.setInput('deck', { ...deck, slides: deck.slides.slice(0, 1) });
    await settle(view.fixture);
    expect(view.position()).toBe('Slide 1 of 1');
    expect(view.text('.next')).toContain('End of the presentation');
  });

  it('passes the AXE checks', async () => {
    const deck = makeDeck();
    const presentation = openPresentation(deck);
    const view = openView(deck);
    await until(() => view.position() !== null, presentation.fixture, view.fixture);
    const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
    view.destroy();
    const waiting = openView(makeDeck());
    await settle(waiting.fixture);
    const result2 = await axe.run(waiting.root, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(result2.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('PresentationView opening the presenter view', () => {
  it('opens the route of the deck in a same-origin noopener window', async () => {
    const deck = makeDeck();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const presentation = openPresentation(deck);
    await settle(presentation.fixture);
    Array.from(presentation.root.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Presenter view')!.click();
    expect(open).toHaveBeenCalledTimes(1);
    const [url, , features] = open.mock.calls[0];
    expect(String(url)).toContain(`/deck/${deck.id}/presenter-view`);
    expect(String(url)).not.toMatch(/^https?:/);
    expect(features).toContain('noopener');
  });

  it('does not end the presentation when opening the window takes the browser out of fullscreen', async () => {
    const deck = makeDeck();
    vi.spyOn(window, 'open').mockReturnValue(null);
    const presentation = openPresentation(deck);
    await settle(presentation.fixture);
    const exited = vi.fn();
    presentation.fixture.componentInstance.exited.subscribe(exited);
    const host = presentation.root;
    let element: Element | null = host;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => element });
    try {
      document.dispatchEvent(new Event('fullscreenchange'));
      Array.from(presentation.root.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Presenter view')!.click();
      element = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      expect(exited).not.toHaveBeenCalled();
    } finally {
      delete (document as unknown as Record<string, unknown>)['fullscreenElement'];
    }
  });
});
