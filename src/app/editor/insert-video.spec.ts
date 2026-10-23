import { TestBed } from '@angular/core/testing';
import { createDeck, createElement, createSlide, validateDeck, type Element, type VideoEl } from '../core/model';
import { DeckRepository, InMemoryDeckRepository } from '../core/persistence';
import { DeckStore } from '../core/store';
import { LiveAnnouncer } from '../shared';
import { InsertActions } from './insert-actions';

function setup(options: { repository?: boolean } = {}) {
  const repo = new InMemoryDeckRepository();
  TestBed.configureTestingModule({ providers: options.repository === false ? [] : [{ provide: DeckRepository, useValue: repo }] });
  const store = TestBed.inject(DeckStore);
  const deck = createDeck('Test');
  deck.slides.push(createSlide(deck.layouts[0].id));
  store.load(deck);
  const announce = vi.spyOn(TestBed.inject(LiveAnnouncer), 'announce');
  return { repo, store, announce, insert: TestBed.inject(InsertActions) };
}

const mp4 = (bytes = [0, 0, 0, 24, 1, 2]) => new Blob([new Uint8Array(bytes)], { type: 'video/mp4' });
const webm = () => new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'video/webm' });
const png = (bytes = [1, 2, 3, 4]) => new Blob([new Uint8Array(bytes)], { type: 'image/png' });
const last = (store: DeckStore): Element => store.currentSlide().elements.at(-1)!;

describe('InsertActions.insertVideo', () => {
  it.each([
    ['mp4', mp4],
    ['webm', webm],
  ])('stores a %s video, registers it and adds a centred 16:9 element in one undo step', async (_name, make) => {
    const { store, repo, insert } = setup();
    expect(await insert.insertVideo(make())).toBe(true);
    const video = last(store) as VideoEl;
    expect(video).toMatchObject({ type: 'video', w: 960, h: 540, x: 480, y: 270, autoplay: false, loop: false });
    expect(store.deck().assets[video.assetId].mime).toMatch(/^video\//);
    expect((await repo.getAsset(video.assetId)).ok).toBe(true);
    expect(store.selection()).toEqual([video.id]);
    expect(validateDeck(store.deck()).ok).toBe(true);
    store.undo();
    expect(store.currentSlide().elements).toHaveLength(0);
    expect(store.deck().assets).toEqual({});
    expect(store.canUndo()).toBe(false);
  });

  it('asks for the accessible name next', async () => {
    const { insert } = setup();
    await insert.insertVideo(mp4());
    expect(insert.focusRequest()?.field).toBe('label');
  });

  it('reuses an asset the deck already has', async () => {
    const { store, insert } = setup();
    await insert.insertVideo(mp4());
    await insert.insertVideo(mp4());
    expect(Object.keys(store.deck().assets)).toHaveLength(1);
    expect(store.currentSlide().elements).toHaveLength(2);
  });

  it.each(['audio/mpeg', 'image/png', 'application/x-evil', ''])('refuses the type "%s" without touching the deck or the store', async (type) => {
    const { store, repo, announce, insert } = setup();
    const before = store.deck();
    const put = vi.spyOn(repo, 'putAsset');
    expect(await insert.insertVideo(new Blob([new Uint8Array([1])], { type }))).toBe(false);
    expect(store.deck()).toBe(before);
    expect(put).not.toHaveBeenCalled();
    expect(announce).toHaveBeenLastCalledWith('Only MP4 and WebM videos can be added');
  });

  it('says so when the session has no storage', async () => {
    const { store, announce, insert } = setup({ repository: false });
    expect(await insert.insertVideo(mp4())).toBe(false);
    expect(announce).toHaveBeenLastCalledWith('Videos cannot be stored in this session');
    expect(store.currentSlide().elements).toHaveLength(0);
  });

  it('adds the video to the slide the author was on when they asked', async () => {
    const { store, insert } = setup();
    const second = store.slides()[1].id;
    const pending = insert.insertVideo(mp4());
    store.selectSlide(second);
    expect(await pending).toBe(true);
    expect(store.slides()[0].elements).toHaveLength(1);
    expect(store.slides()[1].elements).toHaveLength(0);
    expect(store.selection()).toEqual([]);
  });
});

describe('InsertActions.setVideoFile', () => {
  function withVideo() {
    const s = setup();
    const video = createElement('video');
    s.store.load({ ...s.store.deck(), slides: [{ ...s.store.deck().slides[0], elements: [video] }, ...s.store.deck().slides.slice(1)] });
    return { ...s, video };
  }
  const stored = (store: DeckStore, id: string) => store.deck().slides[0].elements.find((e) => e.id === id) as VideoEl;

  it('sets the poster and registers it in one undo step; undo removes both', async () => {
    const { store, announce, insert, video } = withVideo();
    expect(await insert.setVideoFile(video.id, 'poster', png())).toBe(true);
    const poster = stored(store, video.id).poster!;
    expect(store.deck().assets[poster].mime).toBe('image/png');
    expect(announce).toHaveBeenLastCalledWith('Poster set');
    expect(validateDeck({ ...store.deck(), slides: [{ ...store.deck().slides[0], elements: [{ ...stored(store, video.id), assetId: poster }] }] }).ok).toBe(true);
    store.undo();
    expect(stored(store, video.id).poster).toBeUndefined();
    expect(store.deck().assets).toEqual({});
  });

  it('replaces the video', async () => {
    const { store, insert, video } = withVideo();
    expect(await insert.setVideoFile(video.id, 'assetId', mp4())).toBe(true);
    expect(store.deck().assets[stored(store, video.id).assetId].mime).toBe('video/mp4');
  });

  it('refuses the wrong kind of file for each slot', async () => {
    const { store, announce, insert, video } = withVideo();
    const before = store.deck();
    expect(await insert.setVideoFile(video.id, 'poster', mp4())).toBe(false);
    expect(announce).toHaveBeenLastCalledWith('The poster must be a picture');
    expect(await insert.setVideoFile(video.id, 'assetId', png())).toBe(false);
    expect(announce).toHaveBeenLastCalledWith('Only MP4 and WebM videos can be added');
    expect(store.deck()).toBe(before);
  });

  it('fails cleanly when the element is deleted while the file is stored', async () => {
    const { store, announce, insert, video } = withVideo();
    const pending = insert.setVideoFile(video.id, 'poster', png());
    store.load({ ...store.deck(), slides: [{ ...store.deck().slides[0], elements: [] }, ...store.deck().slides.slice(1)] });
    const after = store.deck();
    expect(await pending).toBe(false);
    expect(store.deck()).toBe(after);
    expect(announce).toHaveBeenLastCalledWith(`Element "${video.id}" does not exist`);
  });
});
