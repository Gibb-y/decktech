// Shared by the specs that drive the whole editor page; never imported by the application.
import type { Provider } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import axe from 'axe-core';
import { createDeck, createElement, createSlide, type Deck } from '../core/model';
import { DeckRepository, InMemoryDeckRepository, STORAGE_MANAGER } from '../core/persistence';
import { DeckStore } from '../core/store';
import { LiveAnnouncer } from '../shared';
import { EditorShell } from './editor-shell';

export interface OpenOptions {
  /** Number of slides in the stored deck (default 3, with a text element on the first). */
  slides?: number;
  /** Change the deck before it is stored. */
  prepare?: (deck: Deck) => void;
  /** Extra providers for the page (for instance a fake `COMPONENT_TOOLS`). */
  providers?: Provider[];
}

/** Opens the editor page on a stored deck and waits until it is ready. */
export async function openEditor(options: OpenOptions = {}) {
  const repo = new InMemoryDeckRepository();
  const deck = createDeck('Quarterly review');
  const layoutId = deck.layouts[0].id;
  deck.slides[0].elements.push(createElement('text', { text: 'Welcome', x: 100, y: 100 }));
  for (let i = 1; i < (options.slides ?? 3); i++) deck.slides.push(createSlide(layoutId));
  options.prepare?.(deck);
  await repo.save(deck, null);
  TestBed.configureTestingModule({
    providers: [{ provide: DeckRepository, useValue: repo }, { provide: STORAGE_MANAGER, useValue: null }, provideRouter([]), ...(options.providers ?? [])],
  });
  const fixture = TestBed.createComponent(EditorShell);
  fixture.componentRef.setInput('id', deck.id);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  await settle(fixture);
  return { fixture, deck, repo, store: TestBed.inject(DeckStore), announcer: TestBed.inject(LiveAnnouncer), root: fixture.nativeElement as HTMLElement };
}

export type Editor = Awaited<ReturnType<typeof openEditor>>;

/** Lets pending promises, timers and renders (including `afterNextRender` callbacks) finish. */
export async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r));
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

export interface KeyOptions {
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** Dispatches a keydown on `target` (bubbling, cancelable) and returns the event. */
export function press(target: Element, key: string, options: KeyOptions = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

/** Types into a text control the way a user does: set the value, fire `input`. */
export function type(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
}

export async function runAxe(root: HTMLElement) {
  return axe.run(root, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
}

export const slideButtons = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLButtonElement>('.sorter button.slide'));
export const currentSlideButton = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('.sorter button.slide[aria-current="true"]');
