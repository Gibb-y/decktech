import { ColorScheme } from '../../shared';
import { TestBed } from '@angular/core/testing';
import { openEditor, press, runAxe, settle } from '../editor-test-setup';

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

const toolbar = (root: HTMLElement) => root.querySelector<HTMLElement>('app-editor-toolbar')!;
const trigger = (root: HTMLElement) => toolbar(root).querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
const menu = (root: HTMLElement) => toolbar(root).querySelector<HTMLElement>('[role="menu"]')!;
const items = (root: HTMLElement) => Array.from(menu(root).querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'));
const label = (el: Element) => (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('the editor toolbar', () => {
  it('gives every control an accessible name, so icon-only buttons are never unnamed', async () => {
    const { fixture, root } = await openEditor();
    await settle(fixture);
    const controls = Array.from(toolbar(root).querySelectorAll('button, select'));
    expect(controls.length).toBeGreaterThanOrEqual(8);
    for (const c of controls) {
      const name = c.tagName === 'SELECT' ? (c.closest('label')?.querySelector('.sr-only')?.textContent ?? '') : label(c);
      expect(name.trim(), c.outerHTML.slice(0, 80)).not.toBe('');
    }
  });

  it('groups insert and slide actions first, then design, then present and the overflow menu', async () => {
    const { root } = await openEditor();
    const names = Array.from(toolbar(root).querySelectorAll('.toolbar > :is(div, label, button, app-menu, span)'), (n) => n.className.toString().split(' ')[0]);
    expect(names[0]).toBe('btn-group');
    const buttons = Array.from(toolbar(root).querySelectorAll<HTMLButtonElement>('.btn-group:first-child button'), label);
    expect(buttons).toEqual(['Insert', 'Add slide']);
    const present = Array.from(toolbar(root).querySelectorAll('button')).find((b) => b.textContent?.includes('Present'))!;
    expect(present.classList.contains('btn-primary')).toBe(true);
  });

  it('keeps the rare actions in a menu that is closed to begin with', async () => {
    const { fixture, root } = await openEditor();
    expect(trigger(root).getAttribute('aria-expanded')).toBe('false');
    expect(menu(root).hidden).toBe(true);
    expect(items(root).map(label).filter((l) => !['System', 'Light', 'Dark'].includes(l)).map((l) => l.replace(/\s*\?$/, ''))).toEqual(['Components…', 'Add font…', 'Keyboard shortcuts']);
    trigger(root).click();
    await settle(fixture);
    expect(menu(root).hidden).toBe(false);
    expect(trigger(root).getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(items(root)[0]);
  });

  it('moves with the arrow keys, wraps, and closes with Escape giving the focus back to the trigger', async () => {
    const { fixture, root } = await openEditor();
    trigger(root).click();
    await settle(fixture);
    const all = items(root);
    press(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(all[1]);
    press(document.activeElement!, 'End');
    expect(document.activeElement).toBe(all[all.length - 1]);
    press(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(all[0]);
    press(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(all[all.length - 1]);
    press(document.activeElement!, 'Escape');
    await settle(fixture);
    expect(menu(root).hidden).toBe(true);
    expect(document.activeElement).toBe(trigger(root));
  });

  it('closes when something else is pressed', async () => {
    const { fixture, root } = await openEditor();
    trigger(root).click();
    await settle(fixture);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle(fixture);
    expect(menu(root).hidden).toBe(true);
  });

  it('runs an item and closes', async () => {
    const { fixture, root } = await openEditor();
    trigger(root).click();
    await settle(fixture);
    items(root).find((i) => label(i).startsWith('Keyboard shortcuts'))!.click();
    await settle(fixture);
    expect(menu(root).hidden).toBe(true);
    expect(root.querySelector('app-shortcut-help')).not.toBeNull();
  });

  it('switches the colour scheme from the menu, shows the current one and remembers it', async () => {
    const { fixture, root } = await openEditor();
    const radios = () => items(root).filter((i) => i.getAttribute('role') === 'menuitemradio');
    expect(radios().map((r) => [label(r), r.getAttribute('aria-checked')])).toEqual([
      ['System', 'true'],
      ['Light', 'false'],
      ['Dark', 'false'],
    ]);
    radios()[2].click();
    await settle(fixture);
    expect(TestBed.inject(ColorScheme).mode()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('decktech.colorScheme')).toBe('dark');
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
  });

  it('passes AXE with the menu open', async () => {
    const { fixture, root } = await openEditor();
    trigger(root).click();
    await settle(fixture);
    expect((await runAxe(root)).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
  });
});
