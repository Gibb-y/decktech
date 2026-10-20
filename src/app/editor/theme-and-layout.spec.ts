import { instantiateLayout, createSlide, type Deck } from '../core/model';
import { builtInThemeId, ThemeActions } from './theme-actions';
import { SlideActions } from './slide-actions';
import { TestBed } from '@angular/core/testing';
import { openEditor, runAxe, settle, type Editor } from './editor-test-setup';

afterEach(() => document.body.replaceChildren());

const toolbar = (e: Editor) => e.root.querySelector<HTMLElement>('app-editor-toolbar')!;
const selectByLabel = (e: Editor, label: string) =>
  Array.from(toolbar(e).querySelectorAll('label')).find((l) => l.textContent?.trim().startsWith(label))!.querySelector('select')!;

async function choose(e: Editor, control: HTMLSelectElement, value: string): Promise<void> {
  control.value = value;
  control.dispatchEvent(new Event('change', { bubbles: true }));
  await settle(e.fixture);
}

const onTwoColumns = (deck: Deck): void => {
  const layout = deck.layouts.find((l) => l.id === 'ly_two-column')!;
  deck.slides[0] = instantiateLayout(createSlide(layout.id), layout, deck.theme);
};

describe('layout picker for new slides', () => {
  it('lists every layout and defaults to the current slide’s', async () => {
    const e = await openEditor();
    const picker = selectByLabel(e, 'New slide layout');
    expect(Array.from(picker.options, (o) => o.textContent?.trim())).toEqual([
      'Same as current slide',
      'Blank',
      'Title slide',
      'Title and content',
      'Two columns',
      'Title only',
    ]);
    expect(picker.value).toBe('');
  });

  it('adds a slide with the chosen layout and an element in each placeholder, as one undo step', async () => {
    const e = await openEditor();
    await choose(e, selectByLabel(e, 'New slide layout'), 'ly_two-column');
    toolbar(e).querySelector<HTMLButtonElement>('button:nth-of-type(2)')!.click();
    await settle(e.fixture);
    const added = e.store.currentSlide();
    expect(e.store.slides()).toHaveLength(4);
    expect(added.layoutId).toBe('ly_two-column');
    expect(added.elements.map((x) => x.placeholder)).toEqual(['title', 'body', 'body']);
    expect(e.store.canUndo()).toBe(true);
    e.store.undo();
    expect(e.store.slides()).toHaveLength(3);
    expect(e.store.canUndo()).toBe(false);
  });

  it('with "same as current" copies the placeholders of the current slide’s layout', async () => {
    const e = await openEditor({ prepare: onTwoColumns });
    TestBed.inject(SlideActions).addSlide();
    expect(e.store.currentSlide().elements.map((x) => x.placeholder)).toEqual(['title', 'body', 'body']);
  });

  it('says so instead of throwing when the chosen layout is gone', async () => {
    const e = await openEditor();
    const announce = vi.spyOn(e.announcer, 'announce');
    const actions = TestBed.inject(SlideActions);
    actions.newSlideLayout.set('ly_missing');
    actions.addSlide();
    expect(e.store.slides()).toHaveLength(3);
    expect(announce).toHaveBeenCalledWith('That layout no longer exists');
  });
});

describe('layout change in the properties panel', () => {
  it('moves placeholder content to the new layout, keeps the text and announces it', async () => {
    const e = await openEditor({ prepare: onTwoColumns });
    const announce = vi.spyOn(e.announcer, 'announce');
    const before = e.store.currentSlide().elements;
    const picker = e.root.querySelector<HTMLSelectElement>('#slide-layout')!;
    await choose(e, picker, 'ly_title-content');
    const after = e.store.currentSlide().elements;
    expect(after.map((x) => x.id)).toEqual(before.map((x) => x.id));
    expect(after.map((x) => (x as { text: string }).text)).toEqual(before.map((x) => (x as { text: string }).text));
    expect(after[1].w).toBe(1680);
    expect(announce).toHaveBeenCalledWith('Layout “Title and content” applied to slide 1');
    e.store.undo();
    expect(e.store.currentSlide().elements).toEqual(before);
  });
});

describe('theme picker', () => {
  it('offers the built-in themes and shows the current one', async () => {
    const e = await openEditor();
    const picker = selectByLabel(e, 'Theme');
    expect(Array.from(picker.options, (o) => o.textContent?.trim())).toEqual(['Light', 'Dark']);
    expect(picker.value).toBe('light');
  });

  it('restyles the deck in one undoable step and keeps the deck fonts', async () => {
    const e = await openEditor({ prepare: (d) => (d.theme.fonts['heading'] = 'Georgia, serif') });
    const announce = vi.spyOn(e.announcer, 'announce');
    const stage = () => e.root.querySelector<HTMLElement>('app-canvas .stage')!;
    expect(stage().style.getPropertyValue('--deck-color-background')).toBe('#ffffff');
    await choose(e, selectByLabel(e, 'Theme'), 'dark');
    expect(stage().style.getPropertyValue('--deck-color-background')).toBe('#14161a');
    expect(e.store.deck().theme.fonts['heading']).toBe('Georgia, serif');
    expect(builtInThemeId(e.store.deck().theme)).toBe('dark');
    expect(announce).toHaveBeenCalledWith('Dark theme applied');
    e.store.undo();
    await settle(e.fixture);
    expect(builtInThemeId(e.store.deck().theme)).toBe('light');
    expect(selectByLabel(e, 'Theme').value).toBe('light');
  });

  it('keeps colours the built-in theme lacks', async () => {
    const e = await openEditor({ prepare: (d) => (d.theme.colors['brand'] = '#aa0000') });
    await choose(e, selectByLabel(e, 'Theme'), 'dark');
    expect(e.store.deck().theme.colors['brand']).toBe('#aa0000');
  });

  it('shows "Custom" for a theme that matches no built-in one', async () => {
    const e = await openEditor({ prepare: (d) => (d.theme.colors['text'] = '#222222') });
    expect(selectByLabel(e, 'Theme').value).toBe('');
    expect(selectByLabel(e, 'Theme').options[0].textContent?.trim()).toBe('Custom');
  });

  it('has no AXE violations', async () => {
    const e = await openEditor();
    expect((await runAxe(toolbar(e))).violations).toEqual([]);
  });
});

describe('embedded fonts', () => {
  const file = (name: string) => new File([new Uint8Array([1, 2, 3, 4])], name);

  it('stores the file, registers the family and offers it as a font, in one undo step', async () => {
    const e = await openEditor();
    expect(await TestBed.inject(ThemeActions).addFont(file('My Font.woff2'))).toBe(true);
    const { theme, assets } = e.store.deck();
    expect(theme.fontFaces).toHaveLength(1);
    expect(theme.fontFaces![0]).toMatchObject({ family: 'My Font' });
    expect(theme.fonts['My-Font']).toBe('"My Font", sans-serif');
    expect(assets[theme.fontFaces![0].assetId].mime).toBe('font/woff2');
    e.store.undo();
    expect(e.store.deck().theme.fontFaces).toBeUndefined();
    expect(Object.keys(e.store.deck().assets)).toEqual([]);
    expect(e.store.canUndo()).toBe(false);
  });

  it('adding the same file again keeps one face', async () => {
    const e = await openEditor();
    const actions = TestBed.inject(ThemeActions);
    await actions.addFont(file('Same.otf'));
    await actions.addFont(file('Same.otf'));
    expect(e.store.deck().theme.fontFaces).toHaveLength(1);
  });

  it.each(['notes.txt', 'font', '.woff2'])('refuses %s without changing the deck', async (name) => {
    const e = await openEditor();
    const before = e.store.deck();
    expect(await TestBed.inject(ThemeActions).addFont(file(name))).toBe(false);
    expect(e.store.deck()).toBe(before);
  });

  it('turns a file name into a safe family name', async () => {
    const e = await openEditor();
    await TestBed.inject(ThemeActions).addFont(file('a"b;{x}.woff'));
    expect(e.store.deck().theme.fontFaces![0].family).toBe('a b x');
  });

  it('survives a theme switch', async () => {
    const e = await openEditor();
    await TestBed.inject(ThemeActions).addFont(file('Face.ttf'));
    await choose(e, selectByLabel(e, 'Theme'), 'dark');
    expect(e.store.deck().theme.fontFaces).toHaveLength(1);
    expect(e.store.deck().theme.fonts['Face']).toBeDefined();
  });
});
