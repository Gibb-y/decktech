import { TestBed } from '@angular/core/testing';
import { createDeck, createSlide, validateDeck, type Element } from '../core/model';
import { DeckRepository, InMemoryDeckRepository } from '../core/persistence';
import { DeleteSlide, DeckStore, SetPlaceholderBox } from '../core/store';
import { LiveAnnouncer } from '../shared';
import { INSERT_ITEMS, InsertActions, type InsertKind } from './insert-actions';

function setup(options: { repository?: boolean } = {}) {
  const repo = new InMemoryDeckRepository();
  TestBed.configureTestingModule({ providers: options.repository === false ? [] : [{ provide: DeckRepository, useValue: repo }] });
  const store = TestBed.inject(DeckStore);
  const deck = createDeck('Test');
  deck.slides.push(createSlide(deck.layouts[0].id));
  store.load(deck);
  const announce = vi.spyOn(TestBed.inject(LiveAnnouncer), 'announce');
  return { repo, store, announce, insert: TestBed.inject(InsertActions), deck };
}

const png = (bytes = [1, 2, 3, 4], type = 'image/png') => new Blob([new Uint8Array(bytes)], { type });
const last = (store: DeckStore): Element => store.currentSlide().elements.at(-1)!;

afterEach(() => vi.unstubAllGlobals());

describe('InsertActions.insert', () => {
  const kinds = INSERT_ITEMS.map((i) => i.kind).filter((k): k is Exclude<InsertKind, 'image'> => k !== 'image');

  it.each(kinds)('%s adds one element to the current slide, selects it and is one undo step', (kind) => {
    const { store, announce, insert } = setup();
    store.selectSlide(store.slides()[1].id);
    insert.insert(kind);
    const added = last(store);
    expect(store.slides()[0].elements).toHaveLength(0);
    expect(store.selection()).toEqual([added.id]);
    expect(validateDeck(store.deck()).ok).toBe(true);
    expect(announce).toHaveBeenLastCalledWith(`${INSERT_ITEMS.find((i) => i.kind === kind)!.label} inserted`);
    store.undo();
    expect(store.currentSlide().elements).toHaveLength(0);
    expect(store.canUndo()).toBe(false);
  });

  it.each([
    ['title', 'text'],
    ['bullets', 'text'],
    ['text', 'text'],
    ['rectangle', 'shape'],
    ['ellipse', 'shape'],
    ['triangle', 'shape'],
    ['line', 'line'],
    ['code', 'code'],
  ] as const)('%s is a %s element that lies on the stage', (kind, type) => {
    const { store, insert } = setup();
    insert.insert(kind);
    const e = last(store);
    expect(e.type).toBe(type);
    const { width, height } = store.deck().stage;
    expect(e.x).toBeGreaterThanOrEqual(0);
    expect(e.y).toBeGreaterThanOrEqual(0);
    expect(e.x + e.w).toBeLessThanOrEqual(width);
    expect(e.y + e.h).toBeLessThanOrEqual(height);
  });

  it('a title uses the theme heading font and size; a bullet list starts with bullets', () => {
    const { store, insert } = setup();
    insert.insert('title');
    expect(last(store)).toMatchObject({ font: 'heading', fontSize: store.deck().theme.typeScale['heading'] });
    insert.insert('bullets');
    expect((last(store) as { text: string }).text).toMatch(/^- .+\n- /);
  });

  it('falls back to default sizes when the theme has no type scale', () => {
    const { store, insert, deck } = setup();
    store.load({ ...deck, theme: { ...deck.theme, typeScale: {} } });
    insert.insert('title');
    expect((last(store) as { fontSize: number }).fontSize).toBe(64);
    insert.insert('text');
    expect((last(store) as { fontSize: number }).fontSize).toBe(40);
  });

  it('shapes carry the shape they are named after', () => {
    const { store, insert } = setup();
    insert.insert('rectangle');
    expect(last(store)).toMatchObject({ shape: 'rect' });
    insert.insert('triangle');
    expect(last(store)).toMatchObject({ shape: 'triangle' });
  });

  it('every code component gets its own definition with a fresh id', () => {
    const { store, insert } = setup();
    insert.insert('code');
    insert.insert('code');
    const ids = store.deck().components.map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(store.currentSlide().elements.map((e) => (e as { componentId: string }).componentId)).toEqual(ids);
    store.undo();
    expect(store.deck().components).toHaveLength(1); // the definition goes with the element
  });

  it('asks for focus on the text field after text, on the alt field after a picture, and not otherwise', async () => {
    const { insert } = setup();
    expect(insert.focusRequest()).toBeNull();
    insert.insert('rectangle');
    expect(insert.focusRequest()).toBeNull();
    insert.insert('title');
    const first = insert.focusRequest()!;
    expect(first.field).toBe('text');
    insert.insert('text');
    expect(insert.focusRequest()!.seq).toBeGreaterThan(first.seq); // asking again still counts
    await insert.insertImage(png());
    expect(insert.focusRequest()!.field).toBe('alt');
  });
});

describe('InsertActions.insertImage', () => {
  it('stores the picture, registers it and adds the element in one undo step', async () => {
    const { store, repo, insert } = setup();
    expect(await insert.insertImage(png())).toBe(true);
    const image = last(store);
    expect(image).toMatchObject({ type: 'image', alt: '' });
    const hash = (image as { assetId: string }).assetId;
    expect(store.deck().assets[hash]).toMatchObject({ mime: 'image/png', hash, blobKey: hash, size: 4 });
    expect((await repo.getAsset(hash)).ok).toBe(true);
    expect(store.selection()).toEqual([image.id]);
    expect(validateDeck(store.deck()).ok).toBe(true);
    store.undo();
    expect(store.currentSlide().elements).toHaveLength(0);
    expect(store.deck().assets).toEqual({});
    expect(store.canUndo()).toBe(false);
  });

  it('inserting the same picture twice registers the asset once', async () => {
    const { store, insert } = setup();
    await insert.insertImage(png());
    await insert.insertImage(png());
    expect(Object.keys(store.deck().assets)).toHaveLength(1);
    expect(store.currentSlide().elements).toHaveLength(2);
  });

  it('refuses a type that is not allowed and leaves the deck alone', async () => {
    const { store, announce, insert } = setup();
    const before = store.deck();
    expect(await insert.insertImage(png([1], 'application/x-evil'))).toBe(false);
    expect(store.deck()).toBe(before);
    expect(announce).toHaveBeenLastCalledWith(expect.stringContaining('The picture could not be stored'));
    expect(store.canUndo()).toBe(false);
  });

  it('says so when the session has no storage', async () => {
    const { store, announce, insert } = setup({ repository: false });
    expect(await insert.insertImage(png())).toBe(false);
    expect(announce).toHaveBeenLastCalledWith('Pictures cannot be stored in this session');
    expect(store.currentSlide().elements).toHaveLength(0);
  });

  it('adds the picture to the slide the author was on when they asked, even if they moved on while it was stored', async () => {
    const { store, insert } = setup();
    const [first, second] = store.slides().map((s) => s.id);
    const pending = insert.insertImage(png());
    store.selectSlide(second);
    expect(await pending).toBe(true);
    expect(store.slides()[0].elements).toHaveLength(1);
    expect(store.slides()[1].elements).toHaveLength(0);
    expect(store.currentSlideId()).toBe(second);
    expect(store.selection()).toEqual([]); // the new element is not on this slide
    expect(first).toBe(store.slides()[0].id);
  });

  it('fails cleanly, with nothing half added, if the slide is deleted while the picture is stored', async () => {
    const { store, announce, insert } = setup();
    const [first] = store.slides().map((s) => s.id);
    const pending = insert.insertImage(png());
    store.execute(new DeleteSlide(first));
    const after = store.deck();
    expect(await pending).toBe(false);
    expect(store.deck()).toBe(after);
    expect(Object.keys(store.deck().assets)).toHaveLength(0);
    expect(announce).toHaveBeenLastCalledWith(`Slide "${first}" does not exist`);
  });

  describe('size', () => {
    const withBitmap = (width: number, height: number) =>
      vi.stubGlobal('createImageBitmap', () => Promise.resolve({ width, height, close: () => undefined }));

    it.each([
      [4000, 1000, 1200, 300],
      [600, 1350, 300, 675],
      [200, 100, 200, 100], // small pictures are not enlarged
    ])('fits a %sx%s picture into %sx%s, centred', async (width, height, w, h) => {
      const { store, insert } = setup();
      withBitmap(width, height);
      await insert.insertImage(png());
      const image = last(store);
      expect(image).toMatchObject({ w, h });
      expect(image.x).toBe(Math.round((1920 - w) / 2));
      expect(image.y).toBe(Math.round((1080 - h) / 2));
    });

    it('uses a default size when the browser cannot read the picture or reports none', async () => {
      const { store, insert } = setup();
      vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('broken')));
      await insert.insertImage(png([9]));
      expect(last(store)).toMatchObject({ w: 960, h: 540 });
      withBitmap(0, 0);
      await insert.insertImage(png([8]));
      expect(last(store)).toMatchObject({ w: 960, h: 540 });
    });
  });
});

describe('InsertActions.pickImage', () => {
  it('opens a file chooser that accepts images and inserts the chosen file', async () => {
    const { insert } = setup();
    const input = document.createElement('input');
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);
    vi.spyOn(document, 'createElement').mockReturnValueOnce(input);
    const spy = vi.spyOn(insert, 'insertImage').mockResolvedValue(true);
    insert.pickImage();
    expect(input.type).toBe('file');
    expect(input.accept).toBe('image/*');
    expect(click).toHaveBeenCalledOnce();
    const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    expect(spy).toHaveBeenCalledWith(file);
  });

  it('does nothing when the chooser returns no file', () => {
    const { insert } = setup();
    const input = document.createElement('input');
    vi.spyOn(input, 'click').mockImplementation(() => undefined);
    vi.spyOn(document, 'createElement').mockReturnValueOnce(input);
    const spy = vi.spyOn(insert, 'insertImage');
    insert.pickImage();
    input.dispatchEvent(new Event('change'));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('InsertActions.insertImage into an image placeholder', () => {
  const withImagePlaceholders = () => {
    const ctx = setup();
    const deck = structuredClone(ctx.store.deck());
    deck.layouts.push({
      id: 'ly_pics',
      name: 'Pictures',
      placeholders: [
        { id: 'p1', kind: 'image', x: 100, y: 200, w: 500, h: 400 },
        { id: 'p2', kind: 'image', x: 700, y: 200, w: 500, h: 400 },
      ],
    });
    deck.slides[0].layoutId = 'ly_pics';
    ctx.store.load(deck);
    return ctx;
  };

  it('fills the first free image placeholder and stays bound to it', async () => {
    const { store, insert } = withImagePlaceholders();
    await insert.insertImage(png([1]));
    expect(last(store)).toMatchObject({ type: 'image', placeholder: 'image', x: 100, y: 200, w: 500, h: 400, fit: 'contain' });
  });

  it('the next picture takes the next one, and a third is placed freely', async () => {
    const { store, insert } = withImagePlaceholders();
    await insert.insertImage(png([1]));
    await insert.insertImage(png([2]));
    expect(last(store)).toMatchObject({ placeholder: 'image', x: 700, y: 200 });
    await insert.insertImage(png([3]));
    expect('placeholder' in last(store)).toBe(false);
  });

  it('follows the layout when its placeholder moves', async () => {
    const { store, insert } = withImagePlaceholders();
    await insert.insertImage(png([1]));
    store.execute(new SetPlaceholderBox('ly_pics', 'p1', { x: 10, y: 20, w: 30, h: 40 }));
    expect(last(store)).toMatchObject({ x: 10, y: 20, w: 30, h: 40 });
  });

  it('a layout without an image placeholder centres the picture as before', async () => {
    const { store, insert } = setup();
    await insert.insertImage(png([1]));
    expect('placeholder' in last(store)).toBe(false);
  });
});

describe('InsertActions sizes from the theme', () => {
  it('a title in a theme without a heading size gets its own size and no body token', () => {
    const { store, insert } = setup();
    const deck = structuredClone(store.deck());
    delete (deck.theme.typeScale as Record<string, number>)['heading'];
    store.load(deck);
    insert.insert('title');
    expect(last(store)).toMatchObject({ fontSize: 64 });
    expect('sizeToken' in last(store)).toBe(false);
  });

  it('a title and a text box carry the heading and body tokens', () => {
    const { store, insert } = setup();
    insert.insert('title');
    expect(last(store)).toMatchObject({ sizeToken: 'heading' });
    insert.insert('text');
    expect(last(store)).toMatchObject({ sizeToken: 'body' });
  });
});
